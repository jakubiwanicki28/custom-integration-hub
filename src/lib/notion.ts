import type { Logger } from 'pino';
import { fetchWithTimeout, safeJson, safeText } from './fetch.js';
import type { NotionClient } from './org-context.js';

const API_BASE = 'https://api.notion.com/v1';
const API_VERSION = '2022-06-28';

// --- Notion API response types (minimal) ---

interface NotionPageResponse {
  id: string;
  url: string;
}

interface NotionDatabaseResponse {
  id: string;
}

interface NotionSearchResponse {
  results: Array<{
    id: string;
    url: string;
    object: string;
    properties?: Record<string, unknown>;
  }>;
}

// --- Rich text / block helpers ---

interface NotionRichText {
  type: 'text';
  text: { content: string; link?: { url: string } | null };
  annotations?: { bold?: boolean; italic?: boolean; code?: boolean };
}

interface NotionBlock {
  object: 'block';
  type: string;
  [key: string]: unknown;
}

function richText(text: string, annotations?: NotionRichText['annotations']): NotionRichText {
  return { type: 'text', text: { content: text }, ...(annotations ? { annotations } : {}) };
}

function richTextLink(text: string, url: string): NotionRichText {
  return { type: 'text', text: { content: text, link: { url } } };
}

/**
 * Convert a line of inline markdown to an array of NotionRichText segments.
 * Handles **bold**, *italic*, and [links](url). Not a full parser — covers meeting notes needs.
 */
function parseInlineMarkdown(line: string): NotionRichText[] {
  const segments: NotionRichText[] = [];
  // Pattern matches: **bold**, *italic*, [text](url), or plain text
  const regex = /\*\*(.+?)\*\*|\*(.+?)\*|\[([^\]]+)\]\(([^)]+)\)|([^*[\]]+)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(line)) !== null) {
    if (match[1]) {
      segments.push(richText(match[1], { bold: true }));
    } else if (match[2]) {
      segments.push(richText(match[2], { italic: true }));
    } else if (match[3] && match[4]) {
      segments.push(richTextLink(match[3], match[4]));
    } else if (match[5]) {
      segments.push(richText(match[5]));
    }
  }

  return segments.length > 0 ? segments : [richText(line)];
}

/**
 * Convert simple markdown to Notion block objects.
 * Handles: ## headings, ### headings, - bullets, • bullets, ---, plain paragraphs.
 */
function markdownToBlocks(markdown: string): NotionBlock[] {
  const lines = markdown.split('\n');
  const blocks: NotionBlock[] = [];

  for (const line of lines) {
    const trimmed = line.trimEnd();

    // Skip empty lines
    if (!trimmed) continue;

    // --- divider
    if (/^-{3,}$/.test(trimmed)) {
      blocks.push({ object: 'block', type: 'divider', divider: {} });
      continue;
    }

    // ## Heading 2
    if (trimmed.startsWith('## ')) {
      blocks.push({
        object: 'block', type: 'heading_2',
        heading_2: { rich_text: parseInlineMarkdown(trimmed.slice(3)) },
      });
      continue;
    }

    // ### Heading 3
    if (trimmed.startsWith('### ')) {
      blocks.push({
        object: 'block', type: 'heading_3',
        heading_3: { rich_text: parseInlineMarkdown(trimmed.slice(4)) },
      });
      continue;
    }

    // - bullet or • bullet
    if (/^[-•]\s/.test(trimmed)) {
      blocks.push({
        object: 'block', type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: parseInlineMarkdown(trimmed.slice(2)) },
      });
      continue;
    }

    // Plain paragraph
    blocks.push({
      object: 'block', type: 'paragraph',
      paragraph: { rich_text: parseInlineMarkdown(trimmed) },
    });
  }

  // Notion API limits: max 100 blocks per request — truncate with warning marker
  if (blocks.length > 100) {
    const truncated = blocks.slice(0, 99);
    truncated.push({
      object: 'block', type: 'paragraph',
      paragraph: { rich_text: [richText(`[... obcięto ${blocks.length - 99} bloków — limit Notion API]`, { italic: true })] },
    });
    return truncated;
  }
  return blocks;
}

// --- Client factory ---

export function createNotionClient(apiKey: string, log: Logger): NotionClient {
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Notion-Version': API_VERSION,
    'Content-Type': 'application/json',
  };

  async function createPage(
    databaseId: string,
    properties: Record<string, unknown>,
    markdown: string,
  ): Promise<{ id: string; url: string } | null> {
    const body = {
      parent: { database_id: databaseId },
      properties,
      children: markdownToBlocks(markdown),
    };

    const res = await fetchWithTimeout(`${API_BASE}/pages`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorBody = (await safeText(res)).slice(0, 500);
      log.error({ status: res.status, errorBody }, 'Notion createPage failed');
      return null;
    }

    const data = await safeJson<NotionPageResponse>(res);
    log.info({ pageId: data.id }, 'Notion page created');
    return { id: data.id, url: data.url };
  }

  async function createDatabase(
    parentPageId: string,
    title: string,
    properties: Record<string, unknown>,
  ): Promise<{ id: string } | null> {
    const body = {
      parent: { page_id: parentPageId },
      title: [{ type: 'text', text: { content: title } }],
      properties,
    };

    const res = await fetchWithTimeout(`${API_BASE}/databases`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorBody = (await safeText(res)).slice(0, 500);
      log.error({ status: res.status, errorBody }, 'Notion createDatabase failed');
      return null;
    }

    const data = await safeJson<NotionDatabaseResponse>(res);
    log.info({ databaseId: data.id, title }, 'Notion database created');
    return { id: data.id };
  }

  async function search(
    query: string,
    filter?: { property: string; value: string },
  ): Promise<Array<{ id: string; title: string; url: string }>> {
    const body: Record<string, unknown> = { query };
    if (filter) body.filter = filter;

    const res = await fetchWithTimeout(`${API_BASE}/search`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorBody = (await safeText(res)).slice(0, 500);
      log.error({ status: res.status, errorBody }, 'Notion search failed');
      return [];
    }

    const data = await safeJson<NotionSearchResponse>(res);

    return data.results.map(r => {
      // Extract title from properties (Notion stores title in a title-type property)
      let title = '';
      if (r.properties) {
        for (const prop of Object.values(r.properties)) {
          const p = prop as { type?: string; title?: Array<{ plain_text?: string }> };
          if (p.type === 'title' && Array.isArray(p.title)) {
            title = p.title.map(t => t.plain_text || '').join('');
            break;
          }
        }
      }
      return { id: r.id, title, url: r.url };
    });
  }

  return { createPage, createDatabase, search };
}

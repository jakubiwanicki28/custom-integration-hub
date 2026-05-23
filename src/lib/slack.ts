import type { Logger } from 'pino';
import { fetchWithTimeout, safeJson } from './fetch.js';
import type { SlackClient } from './org-context.js';

// --- Types ---

interface SlackTextObject {
  type: 'plain_text' | 'mrkdwn';
  text: string;
  emoji?: boolean;
}

interface SlackButtonElement {
  type: 'button';
  text: SlackTextObject;
  url?: string;
  style?: 'primary' | 'danger';
  action_id: string;
}

export interface SlackBlock {
  type: 'header' | 'section' | 'context' | 'divider' | 'actions';
  text?: SlackTextObject;
  fields?: SlackTextObject[];
  elements?: (SlackTextObject | SlackButtonElement)[];
}

interface SlackPostMessageResponse {
  ok: boolean;
  error?: string;
  ts?: string;
  channel?: string;
}

interface SlackAuthTestResponse {
  ok: boolean;
  team?: string;
  user?: string;
  bot_id?: string;
  error?: string;
}

// --- Factory: creates a Slack API client bound to a specific bot token ---

export function createSlackClient(botToken: string, log: Logger): SlackClient {
  const headers = {
    Authorization: `Bearer ${botToken}`,
    'Content-Type': 'application/json',
  };

  async function postMessage(
    channelId: string,
    blocks: SlackBlock[],
    fallbackText: string,
  ): Promise<boolean> {
    const body = { channel: channelId, blocks, text: fallbackText };

    const res = await fetchWithTimeout('https://slack.com/api/chat.postMessage', {
      method: 'POST', headers, body: JSON.stringify(body),
    });

    if (!res.ok) {
      log.error({ status: res.status, channelId }, 'Slack API HTTP error');
      return false;
    }

    const data = await safeJson<SlackPostMessageResponse>(res);

    if (!data.ok) {
      log.error({ channelId, error: data.error }, 'Slack postMessage failed');
      return false;
    }

    log.info({ channelId, ts: data.ts }, 'Slack message sent');
    return true;
  }

  async function testConnection(): Promise<{ ok: boolean; team?: string; error?: string }> {
    const res = await fetchWithTimeout('https://slack.com/api/auth.test', {
      method: 'POST', headers,
    });

    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }

    const data = await safeJson<SlackAuthTestResponse>(res);

    if (!data.ok) {
      return { ok: false, error: data.error };
    }

    log.info({ team: data.team, user: data.user }, 'Slack connection verified');
    return { ok: true, team: data.team };
  }

  return { postMessage, testConnection };
}

import { createHmac, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import type { OrgContext } from '../../lib/org-context.js';
import type { SlackBlock } from '../../lib/slack.js';
import { chatCompletion } from '../../lib/openrouter.js';
import { fetchWithTimeout, safeJson, safeText } from '../../lib/fetch.js';
import { config } from '../../config.js';
import { metrics } from '../../lib/metrics.js';
import type {
  FathomWebhookPayload, FathomMeetingConfig,
  ProcessMeetingResult, MeetingChannel,
} from './types.js';

const INTEGRATION = 'fathom-meeting-notes';
const IDEMPOTENCY_TTL = 24 * 60 * 60 * 1000; // 24 hours
const MIN_MEETING_DURATION_S = 60; // 1 minute

// --- AI prompt ---

const SUMMARY_SYSTEM_PROMPT = `Jesteś asystentem podsumowującym spotkania zespołu WW Partners.

Dostaniesz surowe dane ze spotkania: podsumowanie, action items i listę uczestników.

Wygeneruj output w DOKŁADNIE tym formacie (i niczym więcej):

PODSUMOWANIE:
[2-3 zdania po polsku o czym było spotkanie]

USTALENIA:
[Imię osoby]
- [co zostało ustalone / action item]
- [kolejny punkt]

[Imię kolejnej osoby]
- [co zostało ustalone]

Zasady:
- Pisz po polsku, nawet jeśli input jest po angielsku
- Pomiń osoby bez action items — nie wymieniaj ich w ogóle
- Używaj krótkich imion (np. Anna, Gosia, Michał) — nigdy pełnych nazwisk
- Bądź zwięzły — max 1-2 zdania na action item
- Jeśli nie ma żadnych action items, napisz tylko sekcję PODSUMOWANIE i pod USTALENIA napisz "Brak ustaleń"`;

export function createHandler(ctx: OrgContext) {
  const log = ctx.log.child({ integration: INTEGRATION });
  const slack = ctx.clients.slack!;
  const notion = ctx.clients.notion!;
  const cfg = ctx.integrationConfig as unknown as FathomMeetingConfig;

  // Idempotency
  const processedMeetings = new Map<string, number>();
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, ts] of processedMeetings) {
      if (now - ts > IDEMPOTENCY_TTL) processedMeetings.delete(key);
    }
  }, 10 * 60 * 1000);
  cleanupInterval.unref();

  // --- Fathom webhook signature verification (Svix standard) ---

  function verifyFathomSignature(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
    const webhookSecret = ctx.credentials.fathom?.webhookSecret;
    if (!webhookSecret) {
      log.warn('Fathom webhook signature verification SKIPPED — no secret configured');
      return true;
    }

    const msgId = headers['webhook-id'] as string | undefined;
    const timestamp = headers['webhook-timestamp'] as string | undefined;
    const signatures = headers['webhook-signature'] as string | undefined;

    if (!msgId || !timestamp || !signatures) {
      log.warn({ hasMsgId: !!msgId, hasTimestamp: !!timestamp, hasSignatures: !!signatures },
        'Missing Svix webhook headers');
      return false;
    }

    // Anti-replay: reject if timestamp > 5 min old
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - Number(timestamp)) > 300) {
      log.warn({ timestamp, now }, 'Fathom webhook timestamp too old');
      return false;
    }

    // Decode secret: strip "whsec_" prefix, base64-decode
    const secretBytes = Buffer.from(webhookSecret.replace(/^whsec_/, ''), 'base64');

    // Sign: "{id}.{timestamp}.{body}"
    const signedContent = `${msgId}.${timestamp}.${rawBody.toString('utf-8')}`;
    const expected = createHmac('sha256', secretBytes).update(signedContent).digest('base64');

    // Fathom sends space-delimited signatures with version prefix (e.g. "v1,base64sig")
    const sigList = signatures.split(' ');
    for (const sig of sigList) {
      const sigValue = sig.includes(',') ? sig.split(',')[1]! : sig;
      try {
        if (sigValue.length === expected.length
          && timingSafeEqual(Buffer.from(sigValue), Buffer.from(expected))) {
          return true;
        }
      } catch {
        // Length mismatch in timingSafeEqual — continue checking other signatures
      }
    }

    log.warn('Fathom webhook signature mismatch');
    return false;
  }

  // --- Meeting routing ---

  function routeMeeting(title: string): { channel: MeetingChannel; cleanTitle: string } | null {
    const trimmed = title.trim();
    if (!trimmed.startsWith(cfg.meetingPrefix)) return null;

    const cleanTitle = trimmed.slice(cfg.meetingPrefix.length).trim();

    for (const route of cfg.routes) {
      if (cleanTitle.toLowerCase().includes(route.match.toLowerCase())) {
        return { channel: route, cleanTitle };
      }
    }

    return { channel: cfg.defaultChannel, cleanTitle };
  }

  // --- Participant name resolution ---

  function resolveParticipantName(email: string | null, fathomName: string | null): string {
    if (email && cfg.teamMembers[email]) return cfg.teamMembers[email];
    if (fathomName) return fathomName.split(' ')[0]; // First name fallback
    if (email) return email.split('@')[0];
    return 'Nieznany';
  }

  // --- Notion page creation ---

  async function createNotionPage(
    payload: FathomWebhookPayload,
    meetingType: string,
    participantNames: string[],
    dateFormatted: string,
  ): Promise<string | null> {
    if (!cfg.notionDatabaseId) {
      log.warn('Notion database ID not configured — skipping page creation');
      return null;
    }

    const typeLabel = meetingType.charAt(0).toUpperCase() + meetingType.slice(1);
    const pageTitle = `${typeLabel} — ${dateFormatted}`;

    // Build markdown content
    const sections: string[] = [];

    // Summary
    if (payload.default_summary?.markdown_formatted) {
      sections.push(`## Podsumowanie\n${payload.default_summary.markdown_formatted}`);
    }

    // Action items
    if (payload.action_items && payload.action_items.length > 0) {
      const items = payload.action_items.map(ai => {
        const assignee = ai.assignee
          ? resolveParticipantName(ai.assignee.email, ai.assignee.name)
          : '';
        return `- ${assignee ? `**${assignee}**: ` : ''}${ai.description}`;
      }).join('\n');
      sections.push(`## Action items\n${items}`);
    }

    // Transcript
    if (payload.transcript && payload.transcript.length > 0) {
      const lines = payload.transcript.map(t => {
        const speaker = resolveParticipantName(
          t.speaker.matched_calendar_invitee_email,
          t.speaker.display_name,
        );
        return `[${t.timestamp}] ${speaker}: ${t.text}`;
      }).join('\n');
      sections.push(`## Transkrypcja\n${lines}`);
    }

    // Recording link
    if (payload.share_url) {
      sections.push(`---\n[Link do nagrania](${payload.share_url})`);
    }

    const markdown = sections.join('\n\n');

    // Notion properties
    const properties: Record<string, unknown> = {
      Name: { title: [{ text: { content: pageTitle } }] },
      Typ: { select: { name: typeLabel } },
      Data: { date: { start: dateFormatted } },
    };

    if (participantNames.length > 0) {
      properties['Uczestnicy'] = {
        multi_select: participantNames.map(name => ({ name })),
      };
    }

    const page = await notion.createPage(cfg.notionDatabaseId, properties, markdown);
    return page?.url ?? null;
  }

  // --- AI re-processing ---

  async function aiReprocess(
    payload: FathomWebhookPayload,
    participantNames: string[],
  ): Promise<{ summary: string; perPerson: string } | null> {
    const parts: string[] = [];

    if (payload.default_summary?.markdown_formatted) {
      parts.push(`PODSUMOWANIE OD FATHOM:\n${payload.default_summary.markdown_formatted}`);
    }

    if (payload.action_items && payload.action_items.length > 0) {
      const items = payload.action_items.map(ai => {
        const assignee = ai.assignee
          ? resolveParticipantName(ai.assignee.email, ai.assignee.name)
          : 'Nieprzypisane';
        return `- ${assignee}: ${ai.description}`;
      }).join('\n');
      parts.push(`ACTION ITEMS:\n${items}`);
    }

    parts.push(`UCZESTNICY: ${participantNames.join(', ')}`);

    const result = await chatCompletion(config.openrouter.model, [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      { role: 'user', content: parts.join('\n\n') },
    ]);

    if (!result) return null;

    // Parse output: split by PODSUMOWANIE: and USTALENIA:
    const summaryMatch = result.match(/PODSUMOWANIE:\s*([\s\S]*?)(?=USTALENIA:|$)/i);
    const perPersonMatch = result.match(/USTALENIA:\s*([\s\S]*?)$/i);

    return {
      summary: summaryMatch?.[1]?.trim() || result.trim(),
      perPerson: perPersonMatch?.[1]?.trim() || '',
    };
  }

  // --- Slack message formatting ---

  function formatSlackMessage(
    meetingTitle: string,
    dateFormatted: string,
    summary: string,
    perPerson: string,
    fathomUrl: string,
    notionUrl: string | null,
  ): { blocks: SlackBlock[]; fallbackText: string } {
    const blocks: SlackBlock[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${meetingTitle} — ${dateFormatted}`, emoji: true },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: summary },
      },
    ];

    if (perPerson) {
      blocks.push({ type: 'divider' });

      // Split per-person sections and add as separate blocks
      const personSections = perPerson.split(/\n(?=[A-ZĄĆĘŁŃÓŚŹŻ][a-ząćęłńóśźż]*\n)/);
      for (const section of personSections) {
        const trimmed = section.trim();
        if (!trimmed) continue;

        // Convert "- item" to "• item" for Slack markdown
        const slackFormatted = trimmed.replace(/^- /gm, '• ');
        // Bold the person name (first line)
        const lines = slackFormatted.split('\n');
        if (lines.length > 0) {
          lines[0] = `*${lines[0]}*`;
        }

        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: lines.join('\n') },
        });
      }
    }

    blocks.push({ type: 'divider' });

    // Action buttons
    const buttons: Array<{ type: 'button'; text: { type: 'plain_text'; text: string; emoji?: boolean }; url: string; style?: 'primary' | 'danger'; action_id: string }> = [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Nagranie', emoji: true },
        url: fathomUrl,
        action_id: 'open_fathom_recording',
      },
    ];

    if (notionUrl) {
      buttons.push({
        type: 'button',
        text: { type: 'plain_text', text: 'Notatki (Notion)', emoji: true },
        url: notionUrl,
        style: 'primary',
        action_id: 'open_notion_notes',
      });
    }

    blocks.push({ type: 'actions', elements: buttons });

    return {
      blocks,
      fallbackText: `${meetingTitle} — ${dateFormatted}: ${summary.slice(0, 200)}`,
    };
  }

  // --- Core processing pipeline ---

  async function processCore(payload: FathomWebhookPayload): Promise<ProcessMeetingResult> {
    const trackStart = Date.now();
    const recordingKey = String(payload.recording_id);

    // 1. Idempotency
    if (processedMeetings.has(recordingKey)) {
      log.info({ recordingId: recordingKey }, 'Meeting already processed, skipping');
      metrics.track({ integration: INTEGRATION, org: ctx.org.id, event: 'dedup' });
      return { success: true, meetingTitle: payload.meeting_title ?? payload.title };
    }
    processedMeetings.set(recordingKey, Date.now());

    // 2. Match meeting title
    const title = payload.meeting_title ?? payload.title ?? '';
    const route = routeMeeting(title);
    if (!route) {
      log.info({ title }, 'Meeting title does not match prefix — skipping');
      metrics.track({ integration: INTEGRATION, org: ctx.org.id, event: 'skip', meta: { reason: 'no_prefix' } });
      return { success: true, meetingTitle: title };
    }

    // 3. Duration check
    if (payload.recording_start_time && payload.recording_end_time) {
      const startMs = new Date(payload.recording_start_time).getTime();
      const endMs = new Date(payload.recording_end_time).getTime();
      const durationS = (endMs - startMs) / 1000;
      if (durationS < MIN_MEETING_DURATION_S) {
        log.info({ title, durationS }, 'Meeting too short — skipping');
        metrics.track({ integration: INTEGRATION, org: ctx.org.id, event: 'skip', meta: { reason: 'too_short' } });
        return { success: true, meetingTitle: title };
      }
    }

    log.info({ title, type: route.channel.type, channel: route.channel.channelName }, 'Processing meeting');

    // 4. Resolve participant names
    const participantNames = payload.calendar_invitees
      .map(inv => resolveParticipantName(inv.email, inv.name))
      .filter((name, i, arr) => arr.indexOf(name) === i); // unique

    // 5. Format date
    const meetingDate = payload.recording_start_time || payload.scheduled_start_time || payload.created_at;
    const dateObj = new Date(meetingDate);
    const dateFormatted = dateObj.toISOString().split('T')[0]; // YYYY-MM-DD
    const dateDisplay = dateObj.toLocaleDateString('pl-PL', {
      day: 'numeric', month: 'long', year: 'numeric',
    });

    // 6. Create Notion page (graceful failure)
    let notionUrl: string | null = null;
    try {
      notionUrl = await createNotionPage(payload, route.channel.type, participantNames, dateFormatted);
    } catch (err) {
      log.error({ err }, 'Failed to create Notion page — continuing without');
    }

    // 7. AI re-processing (graceful failure → raw summary)
    let summary = payload.default_summary?.markdown_formatted ?? 'Brak podsumowania.';
    let perPerson = '';

    try {
      const aiResult = await aiReprocess(payload, participantNames);
      if (aiResult) {
        summary = aiResult.summary;
        perPerson = aiResult.perPerson;
      } else {
        log.warn('OpenRouter returned null — using raw Fathom summary');
      }
    } catch (err) {
      log.error({ err }, 'AI re-processing failed — using raw Fathom summary');
    }

    // 8. Build and post Slack message
    const { blocks, fallbackText } = formatSlackMessage(
      title.trim(), dateDisplay, summary, perPerson,
      payload.share_url || payload.url,
      notionUrl,
    );

    const sent = await slack.postMessage(route.channel.channelId, blocks, fallbackText);
    if (!sent) {
      log.error({ channel: route.channel.channelName }, 'Failed to post Slack message');
    }

    // 9. Track metrics
    metrics.track({
      integration: INTEGRATION,
      org: ctx.org.id,
      event: sent ? 'success' : 'error',
      durationMs: Date.now() - trackStart,
      meta: {
        meetingType: route.channel.type,
        channel: route.channel.channelName,
        hasNotion: String(!!notionUrl),
        participantCount: String(participantNames.length),
      },
    });

    return {
      success: sent,
      meetingTitle: title.trim(),
      meetingType: route.channel.type,
      slackChannel: route.channel.channelName,
      notionUrl: notionUrl ?? undefined,
      error: sent ? undefined : 'Slack message failed',
    };
  }

  // --- Webhook handler ---

  async function webhookHandler(req: Request, res: Response): Promise<void> {
    // Verify signature
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!verifyFathomSignature(rawBody ?? Buffer.from(JSON.stringify(req.body)), req.headers as Record<string, string>)) {
      log.warn('Invalid Fathom webhook signature');
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    const payload = req.body as FathomWebhookPayload;
    log.info({ recordingId: payload.recording_id, title: payload.meeting_title ?? payload.title }, 'Fathom webhook received');

    // Respond immediately, process async
    res.status(200).json({ status: 'accepted' });
    processCore(payload).catch(err => log.error({ err }, 'Meeting processing failed'));
  }

  // --- Manual processing (dashboard) ---

  async function processMeetingManual(recordingId: string): Promise<ProcessMeetingResult> {
    const fathomApiKey = ctx.credentials.fathom?.apiKey;
    if (!fathomApiKey) {
      return { success: false, error: 'Brak Fathom API key w konfiguracji' };
    }

    try {
      // Fetch meetings list from Fathom API
      const res = await fetchWithTimeout(
        `https://api.fathom.ai/external/v1/meetings?include_summary=true&include_transcript=true&include_action_items=true`,
        { method: 'GET', headers: { 'X-Api-Key': fathomApiKey } },
      );

      if (!res.ok) {
        const errorBody = (await safeText(res)).slice(0, 200);
        return { success: false, error: `Fathom API error: ${res.status} — ${errorBody}` };
      }

      const data = await safeJson<{ items: FathomWebhookPayload[] }>(res);
      const meeting = data.items?.find(m => String(m.recording_id) === recordingId);

      if (!meeting) {
        return { success: false, error: `Nie znaleziono nagrania o ID: ${recordingId}` };
      }

      // Remove from idempotency map to allow re-processing
      processedMeetings.delete(recordingId);

      return await processCore(meeting);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Nieznany błąd';
      log.error({ recordingId, err }, 'Manual meeting processing failed');
      return { success: false, error: message };
    }
  }

  // --- Fathom webhook registration (one-time setup) ---

  async function registerFathomWebhook(): Promise<{ success: boolean; webhookId?: string; error?: string }> {
    const fathomApiKey = ctx.credentials.fathom?.apiKey;
    if (!fathomApiKey) {
      return { success: false, error: 'Brak Fathom API key' };
    }

    const destinationUrl = `${config.webhookBaseUrl}/${ctx.org.id}/${INTEGRATION}/webhook`;

    try {
      const res = await fetchWithTimeout('https://api.fathom.ai/external/v1/webhooks', {
        method: 'POST',
        headers: {
          'X-Api-Key': fathomApiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          destination_url: destinationUrl,
          triggered_for: ['my_recordings'],
          include_summary: true,
          include_transcript: true,
          include_action_items: true,
        }),
      });

      if (!res.ok) {
        const errorBody = (await safeText(res)).slice(0, 300);
        return { success: false, error: `Fathom API ${res.status}: ${errorBody}` };
      }

      const data = await safeJson<{ id: string }>(res);
      log.info({ webhookId: data.id, destinationUrl }, 'Fathom webhook registered');
      return { success: true, webhookId: data.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Nieznany błąd';
      log.error({ err }, 'Failed to register Fathom webhook');
      return { success: false, error: message };
    }
  }

  // --- Notion database creation (one-time setup) ---

  async function createNotionDatabase(): Promise<{ success: boolean; databaseId?: string; error?: string }> {
    // Search for teamspace page to use as parent
    const results = await notion.search('WW Partners', { property: 'object', value: 'page' });

    if (results.length === 0) {
      return { success: false, error: 'Nie znaleziono strony "WW Partners" w Notion. Upewnij się, że integracja jest podpięta do teamspace.' };
    }

    const parentPageId = results[0].id;

    const properties: Record<string, unknown> = {
      Name: { title: {} },
      Typ: {
        select: {
          options: [
            { name: 'Weekly', color: 'blue' },
            { name: 'Meeting', color: 'green' },
          ],
        },
      },
      Data: { date: {} },
      Uczestnicy: { multi_select: {} },
    };

    const db = await notion.createDatabase(parentPageId, 'Spotkania', properties);
    if (!db) {
      return { success: false, error: 'Nie udało się stworzyć database w Notion' };
    }

    log.info({ databaseId: db.id }, 'Notion "Spotkania" database created');
    return { success: true, databaseId: db.id };
  }

  return {
    webhookHandler,
    processCore,
    processMeetingManual,
    registerFathomWebhook,
    createNotionDatabase,
  };
}

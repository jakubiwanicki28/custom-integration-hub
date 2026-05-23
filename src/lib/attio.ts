import { config } from '../config.js';
import { logger } from './logger.js';
import { fetchWithTimeout, safeJson, safeText } from './fetch.js';

const log = logger.child({ lib: 'attio' });

const headers = {
  Authorization: `Bearer ${config.attio.apiKey}`,
  'Content-Type': 'application/json',
};

// --- Types ---

export interface AttioPerson {
  id: { record_id: string };
  values: {
    name?: Array<{ first_name: string; last_name: string; full_name: string }>;
    email_addresses?: Array<{ email_address: string }>;
    phone_numbers?: Array<{ original_phone_number: string }>;
    associated_deals?: Array<{ target_record_id: string }>;
    [key: string]: unknown;
  };
}

export interface AttioDeal {
  id: { record_id: string };
  values: {
    name?: Array<{ value: string }>;
    stage?: Array<{ status: { title: string } }>;
    created_at?: Array<{ value: string }>;
    [key: string]: unknown;
  };
}

interface AttioQueryResponse<T> {
  data: T[];
}

interface AttioNoteResponse {
  data: {
    id: { note_id: string };
  };
}

export interface AttioListEntry {
  id: { workspace_id: string; list_id: string; entry_id: string };
  parent_record_id: string;
  created_at: string;
  entry_values: Record<string, unknown[]>;
}

export interface AttioWebhook {
  id: { workspace_id: string; webhook_id: string };
  target_url: string;
  subscriptions: Array<{ event_type: string; filter?: unknown }>;
  status: 'active' | 'degraded' | 'inactive';
  created_at: string;
}

// --- Phone number normalization ---

function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-\(\)]/g, '');
}

function phoneVariants(phone: string): string[] {
  const clean = normalizePhone(phone);
  const variants = [clean];

  // Without leading +
  if (clean.startsWith('+')) {
    variants.push(clean.slice(1));
  }

  // Last 9 digits (national format, works for Polish numbers)
  const digits = clean.replace(/\D/g, '');
  if (digits.length >= 9) {
    variants.push(digits.slice(-9));
  }

  return variants;
}

// --- API Functions ---

export async function findPersonByPhone(phone: string): Promise<AttioPerson | null> {
  const variants = phoneVariants(phone);

  for (const variant of variants) {
    const body = {
      filter: {
        phone_numbers: variant,
      },
      limit: 1,
    };

    const res = await fetchWithTimeout(`${config.attio.baseUrl}/objects/people/records/query`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      log.error({ status: res.status, variant }, 'Attio person query failed');
      continue;
    }

    const data = await safeJson<AttioQueryResponse<AttioPerson>>(res);
    if (data.data.length > 0) {
      log.info({ phone, variant, recordId: data.data[0].id.record_id }, 'Person found');
      return data.data[0];
    }
  }

  log.warn({ phone }, 'Person not found in Attio for any phone variant');
  return null;
}

export async function findPersonByEmail(email: string): Promise<AttioPerson | null> {
  const body = {
    filter: {
      email_addresses: email,
    },
    limit: 1,
  };

  const res = await fetchWithTimeout(`${config.attio.baseUrl}/objects/people/records/query`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    log.error({ status: res.status, email }, 'Attio person query by email failed');
    return null;
  }

  const data = await safeJson<AttioQueryResponse<AttioPerson>>(res);
  return data.data[0] ?? null;
}

export async function getDealDetails(dealRecordId: string): Promise<AttioDeal | null> {
  const res = await fetchWithTimeout(`${config.attio.baseUrl}/objects/deals/records/${dealRecordId}`, {
    headers,
  });

  if (!res.ok) {
    log.error({ status: res.status, dealRecordId }, 'Failed to fetch deal');
    return null;
  }

  const data = await safeJson<{ data: AttioDeal }>(res);
  return data.data;
}

export function getPersonName(person: AttioPerson): string {
  const name = person.values.name?.[0];
  if (!name) return 'Nieznana osoba';
  return name.full_name || `${name.first_name} ${name.last_name}`.trim() || 'Nieznana osoba';
}

export function getDealName(deal: AttioDeal): string {
  return deal.values.name?.[0]?.value ?? 'Bez nazwy';
}

export function getDealStage(deal: AttioDeal): string {
  return deal.values.stage?.[0]?.status?.title ?? 'Unknown';
}

export function getAssociatedDealIds(person: AttioPerson): string[] {
  return (person.values.associated_deals ?? []).map(d => d.target_record_id);
}

export async function pickBestDeal(person: AttioPerson): Promise<AttioDeal | null> {
  const dealIds = getAssociatedDealIds(person);
  if (dealIds.length === 0) return null;

  const deals: AttioDeal[] = [];
  for (const id of dealIds) {
    const deal = await getDealDetails(id);
    if (deal) deals.push(deal);
  }

  if (deals.length === 0) return null;

  // Prefer active (non-Won, non-Lost) deals, pick most recent
  const activeDealStages = new Set(['Lead', 'In Progress']);
  const active = deals.filter(d => activeDealStages.has(getDealStage(d)));

  if (active.length > 0) {
    // Return most recently created active deal
    return active.sort((a, b) => {
      const aDate = a.values.created_at?.[0]?.value ?? '';
      const bDate = b.values.created_at?.[0]?.value ?? '';
      return bDate.localeCompare(aDate);
    })[0];
  }

  // All closed — return most recently created
  return deals.sort((a, b) => {
    const aDate = a.values.created_at?.[0]?.value ?? '';
    const bDate = b.values.created_at?.[0]?.value ?? '';
    return bDate.localeCompare(aDate);
  })[0];
}

export async function createNote(params: {
  parentObject: 'people' | 'deals' | 'companies';
  parentRecordId: string;
  title: string;
  content: string;
}): Promise<string | null> {
  const body = {
    data: {
      parent_object: params.parentObject,
      parent_record_id: params.parentRecordId,
      title: params.title,
      format: 'markdown',
      content: params.content,
    },
  };

  const res = await fetchWithTimeout(`${config.attio.baseUrl}/notes`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorBody = await safeText(res);
    log.error(
      { status: res.status, parentObject: params.parentObject, parentRecordId: params.parentRecordId, errorBody },
      'Failed to create note'
    );
    return null;
  }

  const data = await safeJson<AttioNoteResponse>(res);
  const noteId = data.data.id.note_id;
  log.info(
    { noteId, parentObject: params.parentObject, parentRecordId: params.parentRecordId },
    'Note created'
  );
  return noteId;
}

// --- Person helpers ---

export async function getPersonDetails(recordId: string): Promise<AttioPerson | null> {
  const res = await fetchWithTimeout(`${config.attio.baseUrl}/objects/people/records/${recordId}`, {
    headers,
  });

  if (!res.ok) {
    log.error({ status: res.status, recordId }, 'Failed to fetch person');
    return null;
  }

  const data = await safeJson<{ data: AttioPerson }>(res);
  return data.data;
}

export function getPersonEmail(person: AttioPerson): string | null {
  return person.values.email_addresses?.[0]?.email_address ?? null;
}

export function getPersonPhone(person: AttioPerson): string | null {
  return person.values.phone_numbers?.[0]?.original_phone_number ?? null;
}

// --- List entries ---

export async function queryListEntries(listId: string, limit = 5): Promise<AttioListEntry[]> {
  const body = {
    sorts: [{ direction: 'desc', attribute: 'created_at' }],
    limit,
    offset: 0,
  };

  const res = await fetchWithTimeout(`${config.attio.baseUrl}/lists/${listId}/entries/query`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    log.error({ status: res.status, listId }, 'Failed to query list entries');
    return [];
  }

  const data = await safeJson<AttioQueryResponse<AttioListEntry>>(res);
  return data.data;
}

// --- Webhooks ---

export async function registerWebhook(
  targetUrl: string,
  subscriptions: Array<{ event_type: string; filter?: unknown }>,
): Promise<{ webhookId: string; secret: string } | null> {
  const body = {
    data: {
      target_url: targetUrl,
      subscriptions,
    },
  };

  const res = await fetchWithTimeout(`${config.attio.baseUrl}/webhooks`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorBody = await safeText(res);
    log.error({ status: res.status, errorBody }, 'Failed to register webhook');
    return null;
  }

  const data = await safeJson<{ data: AttioWebhook & { secret: string } }>(res);
  const webhookId = data.data.id.webhook_id;
  log.info({ webhookId, targetUrl }, 'Attio webhook registered');
  return { webhookId, secret: data.data.secret };
}

export async function listWebhooks(): Promise<AttioWebhook[]> {
  const res = await fetchWithTimeout(`${config.attio.baseUrl}/webhooks`, {
    headers,
  });

  if (!res.ok) {
    log.error({ status: res.status }, 'Failed to list webhooks');
    return [];
  }

  const data = await safeJson<AttioQueryResponse<AttioWebhook>>(res);
  return data.data;
}

export async function deleteWebhook(webhookId: string): Promise<boolean> {
  const res = await fetchWithTimeout(`${config.attio.baseUrl}/webhooks/${webhookId}`, {
    method: 'DELETE',
    headers,
  });

  if (!res.ok) {
    log.error({ status: res.status, webhookId }, 'Failed to delete webhook');
    return false;
  }

  log.info({ webhookId }, 'Attio webhook deleted');
  return true;
}

import type { Logger } from 'pino';
import { fetchWithTimeout, safeJson, safeText } from './fetch.js';
import type { AttioClient } from './org-context.js';

const BASE_URL = 'https://api.attio.com/v2';

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

// --- Phone number normalization (pure, no auth needed) ---

function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-\(\)]/g, '');
}

function phoneVariants(phone: string): string[] {
  const clean = normalizePhone(phone);
  const variants = [clean];

  if (clean.startsWith('+')) {
    variants.push(clean.slice(1));
  }

  const digits = clean.replace(/\D/g, '');
  if (digits.length >= 9) {
    variants.push(digits.slice(-9));
  }

  return variants;
}

// --- Pure utility functions (no auth needed, exported directly) ---

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

export function getPersonEmail(person: AttioPerson): string | null {
  return person.values.email_addresses?.[0]?.email_address ?? null;
}

export function getPersonPhone(person: AttioPerson): string | null {
  return person.values.phone_numbers?.[0]?.original_phone_number ?? null;
}

export function getAssociatedDealIds(person: AttioPerson): string[] {
  return (person.values.associated_deals ?? []).map(d => d.target_record_id);
}

// --- Factory: creates an Attio API client bound to a specific API key ---

export function createAttioClient(apiKey: string, log: Logger): AttioClient {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  async function findPersonByPhone(phone: string): Promise<AttioPerson | null> {
    const variants = phoneVariants(phone);

    for (const variant of variants) {
      const body = { filter: { phone_numbers: variant }, limit: 1 };
      const res = await fetchWithTimeout(`${BASE_URL}/objects/people/records/query`, {
        method: 'POST', headers, body: JSON.stringify(body),
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

  async function findPersonByEmail(email: string): Promise<AttioPerson | null> {
    const body = { filter: { email_addresses: email }, limit: 1 };
    const res = await fetchWithTimeout(`${BASE_URL}/objects/people/records/query`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });

    if (!res.ok) {
      log.error({ status: res.status, email }, 'Attio person query by email failed');
      return null;
    }

    const data = await safeJson<AttioQueryResponse<AttioPerson>>(res);
    return data.data[0] ?? null;
  }

  async function getDealDetails(dealRecordId: string): Promise<AttioDeal | null> {
    const res = await fetchWithTimeout(`${BASE_URL}/objects/deals/records/${dealRecordId}`, { headers });

    if (!res.ok) {
      log.error({ status: res.status, dealRecordId }, 'Failed to fetch deal');
      return null;
    }

    const data = await safeJson<{ data: AttioDeal }>(res);
    return data.data;
  }

  async function getPersonDetails(recordId: string): Promise<AttioPerson | null> {
    const res = await fetchWithTimeout(`${BASE_URL}/objects/people/records/${recordId}`, { headers });

    if (!res.ok) {
      log.error({ status: res.status, recordId }, 'Failed to fetch person');
      return null;
    }

    const data = await safeJson<{ data: AttioPerson }>(res);
    return data.data;
  }

  async function pickBestDeal(person: AttioPerson): Promise<AttioDeal | null> {
    const dealIds = getAssociatedDealIds(person);
    if (dealIds.length === 0) return null;

    const deals: AttioDeal[] = [];
    for (const id of dealIds) {
      const deal = await getDealDetails(id);
      if (deal) deals.push(deal);
    }

    if (deals.length === 0) return null;

    const activeDealStages = new Set(['Lead', 'In Progress']);
    const active = deals.filter(d => activeDealStages.has(getDealStage(d)));

    if (active.length > 0) {
      return active.sort((a, b) => {
        const aDate = a.values.created_at?.[0]?.value ?? '';
        const bDate = b.values.created_at?.[0]?.value ?? '';
        return bDate.localeCompare(aDate);
      })[0];
    }

    return deals.sort((a, b) => {
      const aDate = a.values.created_at?.[0]?.value ?? '';
      const bDate = b.values.created_at?.[0]?.value ?? '';
      return bDate.localeCompare(aDate);
    })[0];
  }

  async function createNote(params: {
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

    const res = await fetchWithTimeout(`${BASE_URL}/notes`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorBody = (await safeText(res)).slice(0, 200);
      log.error(
        { status: res.status, parentObject: params.parentObject, parentRecordId: params.parentRecordId, errorBody },
        'Failed to create note',
      );
      return null;
    }

    const data = await safeJson<AttioNoteResponse>(res);
    const noteId = data.data.id.note_id;
    log.info({ noteId, parentObject: params.parentObject, parentRecordId: params.parentRecordId }, 'Note created');
    return noteId;
  }

  async function queryListEntries(listId: string, limit = 5): Promise<AttioListEntry[]> {
    const body = { sorts: [{ direction: 'desc', attribute: 'created_at' }], limit, offset: 0 };
    const res = await fetchWithTimeout(`${BASE_URL}/lists/${listId}/entries/query`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });

    if (!res.ok) {
      log.error({ status: res.status, listId }, 'Failed to query list entries');
      return [];
    }

    const data = await safeJson<AttioQueryResponse<AttioListEntry>>(res);
    return data.data;
  }

  async function registerWebhook(
    targetUrl: string,
    subscriptions: Array<{ event_type: string; filter?: unknown }>,
  ): Promise<{ webhookId: string; secret: string } | null> {
    const body = { data: { target_url: targetUrl, subscriptions } };
    const res = await fetchWithTimeout(`${BASE_URL}/webhooks`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorBody = (await safeText(res)).slice(0, 200);
      log.error({ status: res.status, errorBody }, 'Failed to register webhook');
      return null;
    }

    const data = await safeJson<{ data: AttioWebhook & { secret: string } }>(res);
    const webhookId = data.data.id.webhook_id;
    log.info({ webhookId, targetUrl }, 'Attio webhook registered');
    return { webhookId, secret: data.data.secret };
  }

  async function listWebhooks(): Promise<AttioWebhook[]> {
    const res = await fetchWithTimeout(`${BASE_URL}/webhooks`, { headers });

    if (!res.ok) {
      log.error({ status: res.status }, 'Failed to list webhooks');
      return [];
    }

    const data = await safeJson<AttioQueryResponse<AttioWebhook>>(res);
    return data.data;
  }

  async function deleteWebhook(webhookId: string): Promise<boolean> {
    const res = await fetchWithTimeout(`${BASE_URL}/webhooks/${webhookId}`, {
      method: 'DELETE', headers,
    });

    if (!res.ok) {
      log.error({ status: res.status, webhookId }, 'Failed to delete webhook');
      return false;
    }

    log.info({ webhookId }, 'Attio webhook deleted');
    return true;
  }

  // --- Lead intake methods ---

  async function upsertPerson(data: { email: string; firstName: string; lastName: string; phone: string }): Promise<string | null> {
    const values: Record<string, unknown> = {
      email_addresses: [{ email_address: data.email }],
      name: [{ first_name: data.firstName, last_name: data.lastName, full_name: `${data.firstName} ${data.lastName}`.trim() }],
    };
    if (data.phone) {
      values.phone_numbers = [{ original_phone_number: data.phone }];
    }

    const res = await fetchWithTimeout(`${BASE_URL}/objects/people/records?matching_attribute=email_addresses`, {
      method: 'PUT', headers, body: JSON.stringify({ data: { values } }),
    });

    if (!res.ok) {
      const errorBody = (await safeText(res)).slice(0, 200);
      // Retry without phone if Attio rejects it
      if (res.status === 400 && errorBody.includes('phone_number') && data.phone) {
        log.warn({ email: data.email, phone: data.phone }, 'Phone rejected by Attio, retrying without phone');
        delete values.phone_numbers;
        const retry = await fetchWithTimeout(`${BASE_URL}/objects/people/records?matching_attribute=email_addresses`, {
          method: 'PUT', headers, body: JSON.stringify({ data: { values } }),
        });
        if (retry.ok) {
          const result = await safeJson<{ data: AttioPerson }>(retry);
          log.info({ recordId: result.data.id.record_id, email: data.email }, 'Person upserted (without phone)');
          return result.data.id.record_id;
        }
      }
      log.error({ status: res.status, email: data.email, errorBody }, 'Failed to upsert person');
      return null;
    }

    const result = await safeJson<{ data: AttioPerson }>(res);
    log.info({ recordId: result.data.id.record_id, email: data.email }, 'Person upserted');
    return result.data.id.record_id;
  }

  async function createDealRecord(data: { name: string; stageId: string; ownerId: string; personRecordId: string }): Promise<string | null> {
    const body = {
      data: {
        values: {
          name: [{ value: data.name }],
          stage: [{ status: data.stageId }],
          owner: [{ referenced_actor_type: 'workspace-member', referenced_actor_id: data.ownerId }],
          associated_people: [{ target_object: 'people', target_record_id: data.personRecordId }],
        },
      },
    };

    const res = await fetchWithTimeout(`${BASE_URL}/objects/deals/records`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorBody = (await safeText(res)).slice(0, 200);
      log.error({ status: res.status, dealName: data.name, errorBody }, 'Failed to create deal');
      return null;
    }

    const result = await safeJson<{ data: AttioDeal }>(res);
    log.info({ recordId: result.data.id.record_id, dealName: data.name }, 'Deal created');
    return result.data.id.record_id;
  }

  async function addListEntry(listId: string, dealRecordId: string, entryValues: Record<string, unknown>): Promise<string | null> {
    const body = {
      data: {
        parent_record_id: dealRecordId,
        parent_object: 'deals',
        entry_values: entryValues,
      },
    };

    const res = await fetchWithTimeout(`${BASE_URL}/lists/${listId}/entries`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorBody = (await safeText(res)).slice(0, 200);
      log.error({ status: res.status, listId, dealRecordId, errorBody }, 'Failed to add list entry');
      return null;
    }

    const result = await safeJson<{ data: AttioListEntry }>(res);
    log.info({ entryId: result.data.id.entry_id, listId, dealRecordId }, 'List entry added');
    return result.data.id.entry_id;
  }

  // --- Booking sync methods ---

  async function updateDealValues(dealRecordId: string, values: Record<string, unknown>): Promise<boolean> {
    const res = await fetchWithTimeout(`${BASE_URL}/objects/deals/records/${dealRecordId}`, {
      method: 'PATCH', headers, body: JSON.stringify({ data: { values } }),
    });

    if (!res.ok) {
      const errorBody = (await safeText(res)).slice(0, 200);
      log.error({ status: res.status, dealRecordId, errorBody }, 'Failed to update deal values');
      return false;
    }

    log.info({ dealRecordId }, 'Deal values updated');
    return true;
  }

  async function updateListEntry(listId: string, entryId: string, entryValues: Record<string, unknown>): Promise<boolean> {
    const res = await fetchWithTimeout(`${BASE_URL}/lists/${listId}/entries/${entryId}`, {
      method: 'PATCH', headers, body: JSON.stringify({ data: { entry_values: entryValues } }),
    });

    if (!res.ok) {
      const errorBody = (await safeText(res)).slice(0, 200);
      log.error({ status: res.status, listId, entryId, errorBody }, 'Failed to update list entry');
      return false;
    }

    log.info({ listId, entryId }, 'List entry updated');
    return true;
  }

  async function findListEntriesByDeal(listId: string, dealRecordId: string): Promise<AttioListEntry[]> {
    const body = {
      filter: { parent_record: { target_record_id: { $eq: dealRecordId } } },
    };

    const res = await fetchWithTimeout(`${BASE_URL}/lists/${listId}/entries/query`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });

    if (!res.ok) {
      log.error({ status: res.status, listId, dealRecordId }, 'Failed to find list entries by deal');
      return [];
    }

    const data = await safeJson<AttioQueryResponse<AttioListEntry>>(res);
    return data.data;
  }

  return {
    findPersonByPhone, findPersonByEmail, getDealDetails, getPersonDetails,
    pickBestDeal, createNote, queryListEntries, registerWebhook, listWebhooks, deleteWebhook,
    upsertPerson, createDeal: createDealRecord, addListEntry,
    updateDealValues, updateListEntry, findListEntriesByDeal,
  };
}

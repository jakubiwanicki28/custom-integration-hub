import type { Logger } from 'pino';
import { fetchWithTimeout, safeJson } from './fetch.js';
import type { CloudTalkClient } from './org-context.js';

// --- Types ---

export interface CloudTalkCall {
  id: string;
  duration: number;
  talkingTime: number;
  type: 'incoming' | 'outgoing' | 'internal';
  externalNumber: string;
  internalNumber: string;
  recorded: boolean;
  recordingLink: string | null;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string;
  agentName: string;
  contactId: string | null;
  contactName: string | null;
  contactEmails: string[];
  contactNumbers: string[];
}

interface CdrResponse {
  responseData: {
    itemsCount: number;
    pageCount: number;
    pageNumber: number;
    limit: number;
    data: Array<{
      Cdr: {
        id: string;
        billsec: string;
        talking_time: string;
        type: string;
        public_external: string;
        public_internal: string;
        recorded: boolean;
        recording_link: string | null;
        started_at: string;
        answered_at: string | null;
        ended_at: string;
      };
      Agent: { id: string | null; fullname: string };
      Contact: {
        id: string | null;
        name: string | null;
        contact_emails: string[];
        contact_numbers: string[];
      };
    }>;
  };
}

export interface CallsPage {
  calls: CloudTalkCall[];
  totalPages: number;
  currentPage: number;
  totalItems: number;
}

function parseCall(entry: CdrResponse['responseData']['data'][0]): CloudTalkCall {
  const { Cdr, Agent, Contact } = entry;
  return {
    id: Cdr.id,
    duration: parseInt(Cdr.billsec, 10),
    talkingTime: parseInt(Cdr.talking_time, 10),
    type: Cdr.type as CloudTalkCall['type'],
    externalNumber: Cdr.public_external,
    internalNumber: Cdr.public_internal,
    recorded: Cdr.recorded,
    recordingLink: Cdr.recording_link,
    startedAt: Cdr.started_at,
    answeredAt: Cdr.answered_at,
    endedAt: Cdr.ended_at,
    agentName: Agent.fullname,
    contactId: Contact.id,
    contactName: Contact.name,
    contactEmails: Contact.contact_emails ?? [],
    contactNumbers: Contact.contact_numbers ?? [],
  };
}

const BASE_URL = 'https://my.cloudtalk.io/api';

// --- Factory: creates a CloudTalk API client bound to specific credentials ---

export function createCloudTalkClient(apiId: string, apiKey: string, log: Logger): CloudTalkClient {
  const basicAuth = Buffer.from(`${apiId}:${apiKey}`).toString('base64');
  const headers = { Authorization: `Basic ${basicAuth}` };

  async function getCallDetails(callId: string): Promise<CloudTalkCall | null> {
    const lookback = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const url = `${BASE_URL}/calls/index.json?limit=200&date_from=${lookback}`;
    const res = await fetchWithTimeout(url, { headers });

    if (!res.ok) {
      log.error({ callId, status: res.status }, 'Failed to fetch call details');
      return null;
    }

    const data = await safeJson<CdrResponse>(res);
    const entries = data.responseData?.data ?? [];

    log.info({ callId, totalEntries: entries.length, firstId: entries[0]?.Cdr.id, lastId: entries[entries.length - 1]?.Cdr.id }, 'Searching for call in batch');

    const match = entries.find(e => e.Cdr.id === callId);

    if (!match) {
      log.warn({ callId, sampleIds: entries.slice(0, 5).map(e => e.Cdr.id) }, 'Call not found in recent calls');
      return null;
    }

    log.info({ callId, duration: match.Cdr.billsec }, 'Call matched');
    return parseCall(match);
  }

  async function getRecentCalls(limit = 10, page = 1): Promise<CallsPage> {
    const url = `${BASE_URL}/calls/index.json?limit=${limit}&page=${page}`;
    const res = await fetchWithTimeout(url, { headers });

    if (!res.ok) {
      log.error({ status: res.status }, 'Failed to fetch recent calls');
      return { calls: [], totalPages: 0, currentPage: page, totalItems: 0 };
    }

    const data = await safeJson<CdrResponse>(res);
    return {
      calls: (data.responseData?.data ?? []).map(parseCall),
      totalPages: data.responseData?.pageCount ?? 0,
      currentPage: data.responseData?.pageNumber ?? page,
      totalItems: data.responseData?.itemsCount ?? 0,
    };
  }

  async function getCallsSince(since: Date, limit = 20): Promise<CloudTalkCall[]> {
    const dateFrom = since.toISOString();
    const url = `${BASE_URL}/calls/index.json?limit=${limit}&date_from=${dateFrom}`;
    const res = await fetchWithTimeout(url, { headers });

    if (!res.ok) {
      log.error({ status: res.status, dateFrom }, 'Failed to fetch calls since date');
      return [];
    }

    const data = await safeJson<CdrResponse>(res);
    return (data.responseData?.data ?? []).map(parseCall);
  }

  async function downloadRecording(callId: string): Promise<Buffer | null> {
    const url = `${BASE_URL}/calls/recording/${callId}.json`;
    const res = await fetchWithTimeout(url, { headers });

    if (!res.ok) {
      log.warn({ callId, status: res.status }, 'Recording not available');
      return null;
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('json')) {
      log.warn({ callId }, 'Recording endpoint returned JSON instead of audio');
      return null;
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.length < 1000) {
      log.warn({ callId, size: buffer.length }, 'Recording too small, likely empty');
      return null;
    }

    log.info({ callId, sizeKB: Math.round(buffer.length / 1024) }, 'Recording downloaded');
    return buffer;
  }

  return { getCallDetails, getRecentCalls, getCallsSince, downloadRecording };
}

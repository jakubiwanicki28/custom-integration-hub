import { config } from '../config.js';
import { logger } from './logger.js';

const log = logger.child({ lib: 'cloudtalk' });

const basicAuth = Buffer.from(
  `${config.cloudtalk.apiId}:${config.cloudtalk.apiKey}`
).toString('base64');

const headers = {
  Authorization: `Basic ${basicAuth}`,
};

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

export async function getCallDetails(callId: string): Promise<CloudTalkCall | null> {
  const url = `${config.cloudtalk.baseUrl}/calls/index.json?limit=1&id=${callId}`;
  const res = await fetch(url, { headers });

  if (!res.ok) {
    log.error({ callId, status: res.status }, 'Failed to fetch call details');
    return null;
  }

  const data: CdrResponse = await res.json();
  const entries = data.responseData?.data;
  if (!entries || entries.length === 0) return null;

  return parseCall(entries[0]);
}

export interface CallsPage {
  calls: CloudTalkCall[];
  totalPages: number;
  currentPage: number;
  totalItems: number;
}

export async function getRecentCalls(limit = 10, page = 1): Promise<CallsPage> {
  const url = `${config.cloudtalk.baseUrl}/calls/index.json?limit=${limit}&page=${page}`;
  const res = await fetch(url, { headers });

  if (!res.ok) {
    log.error({ status: res.status }, 'Failed to fetch recent calls');
    return { calls: [], totalPages: 0, currentPage: page, totalItems: 0 };
  }

  const data: CdrResponse = await res.json();
  return {
    calls: (data.responseData?.data ?? []).map(parseCall),
    totalPages: data.responseData?.pageCount ?? 0,
    currentPage: data.responseData?.pageNumber ?? page,
    totalItems: data.responseData?.itemsCount ?? 0,
  };
}

export async function downloadRecording(callId: string): Promise<Buffer | null> {
  const url = `${config.cloudtalk.baseUrl}/calls/recording/${callId}.json`;
  const res = await fetch(url, { headers });

  if (!res.ok) {
    log.warn({ callId, status: res.status }, 'Recording not available');
    return null;
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('json')) {
    // Some responses return JSON with error info
    const body = await res.json();
    log.warn({ callId, body }, 'Recording endpoint returned JSON instead of audio');
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

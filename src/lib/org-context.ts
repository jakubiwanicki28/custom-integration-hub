import type { Router } from 'express';
import type { Logger } from 'pino';

// --- API Client interfaces ---

export interface AttioClient {
  findPersonByPhone(phone: string): Promise<import('./attio.js').AttioPerson | null>;
  findPersonByEmail(email: string): Promise<import('./attio.js').AttioPerson | null>;
  getDealDetails(dealRecordId: string): Promise<import('./attio.js').AttioDeal | null>;
  getPersonDetails(recordId: string): Promise<import('./attio.js').AttioPerson | null>;
  pickBestDeal(person: import('./attio.js').AttioPerson): Promise<import('./attio.js').AttioDeal | null>;
  createNote(params: { parentObject: 'people' | 'deals' | 'companies'; parentRecordId: string; title: string; content: string }): Promise<string | null>;
  queryListEntries(listId: string, limit?: number): Promise<import('./attio.js').AttioListEntry[]>;
  registerWebhook(targetUrl: string, subscriptions: Array<{ event_type: string; filter?: unknown }>): Promise<{ webhookId: string; secret: string } | null>;
  listWebhooks(): Promise<import('./attio.js').AttioWebhook[]>;
  deleteWebhook(webhookId: string): Promise<boolean>;
  // Lead intake methods
  upsertPerson(data: { email: string; firstName: string; lastName: string; phone: string }): Promise<string | null>;
  createDeal(data: { name: string; stageId: string; ownerId: string; personRecordId: string }): Promise<string | null>;
  addListEntry(listId: string, dealRecordId: string, entryValues: Record<string, unknown>): Promise<string | null>;
  // Booking sync methods
  updateDealValues(dealRecordId: string, values: Record<string, unknown>): Promise<boolean>;
  updateListEntry(listId: string, entryId: string, entryValues: Record<string, unknown>): Promise<boolean>;
  findListEntriesByDeal(listId: string, dealRecordId: string): Promise<import('./attio.js').AttioListEntry[]>;
}

export interface SlackClient {
  postMessage(channelId: string, blocks: import('./slack.js').SlackBlock[], fallbackText: string): Promise<boolean>;
  postMessageFull(channelId: string, blocks: import('./slack.js').SlackBlock[], fallbackText: string, options?: { threadTs?: string }): Promise<{ ok: boolean; ts?: string }>;
  deleteMessage(channelId: string, ts: string): Promise<boolean>;
  testConnection(): Promise<{ ok: boolean; team?: string; error?: string }>;
}

export interface CloudTalkClient {
  getCallDetails(callId: string): Promise<import('./cloudtalk.js').CloudTalkCall | null>;
  getRecentCalls(limit?: number, page?: number): Promise<import('./cloudtalk.js').CallsPage>;
  getCallsSince(since: Date, limit?: number): Promise<import('./cloudtalk.js').CloudTalkCall[]>;
  downloadRecording(callId: string): Promise<Buffer | null>;
}

export interface GitHubClient {
  compareCommits(base: string, head: string): Promise<import('./github.js').CompareResult | null>;
  getRecentCommits(branch: string, count?: number): Promise<import('./github.js').GitHubCommit[]>;
  createPullRequest(title: string, body: string, head: string, base: string): Promise<import('./github.js').GitHubPullRequest | null>;
  listOpenPullRequests(head: string, base: string): Promise<import('./github.js').GitHubPullRequest[]>;
}

export interface NotionClient {
  createPage(databaseId: string, properties: Record<string, unknown>, markdown: string): Promise<{ id: string; url: string } | null>;
  createDatabase(parentPageId: string, title: string, properties: Record<string, unknown>): Promise<{ id: string } | null>;
  search(query: string, filter?: { property: string; value: string }): Promise<Array<{ id: string; title: string; url: string }>>;
}

// --- Organization context ---

export interface OrgContext {
  org: {
    id: string;
    name: string;
    envPrefix: string;
    attioWorkspaceSlug: string;
    webhookSecret: string;
  };
  clients: {
    attio: AttioClient;
    slack?: SlackClient;
    cloudtalk?: CloudTalkClient;
    github?: GitHubClient;
    notion?: NotionClient;
  };
  credentials: OrgCredentials;
  integrationConfig: Record<string, unknown>;
  log: Logger;
}

// --- Integration instance (returned by createIntegration) ---

export interface IntegrationInstance {
  router: Router;
  handlers: {
    processManual?: (...args: string[]) => Promise<unknown>;
    [key: string]: unknown;
  };
  startPoller?: () => void;
  config?: Record<string, unknown>;
}

// --- Organization credentials ---

export interface OrgCredentials {
  attio: { apiKey: string; webhookSecret: string };
  slack: { botToken: string; signingSecret: string };
  cloudtalk?: { apiId: string; apiKey: string };
  github?: { token: string };
  vercel?: { webhookSecret: string };
  fathom?: { apiKey: string; webhookSecret: string };
  notion?: { apiKey: string };
}

// --- Registry types ---

export interface IntegrationCatalogEntry {
  id: string;
  name: string;
  description: string;
  type: 'webhook' | 'cron' | 'hybrid';
  module: string;
  requiredServices: string[];
  triggers: string[];
  targets: string[];
}

export interface OrganizationEntry {
  id: string;
  name: string;
  envPrefix: string;
  attioWorkspaceSlug: string;
  integrations: OrgIntegrationEntry[];
}

export interface OrgIntegrationEntry {
  integrationId: string;
  status: 'active' | 'inactive' | 'development';
  config?: Record<string, unknown>;
}

// --- Channel mapping (shared by slack-lead-notifications) ---

export interface ChannelMapping {
  listName: string;
  channelId: string;
  channelName: string;
}

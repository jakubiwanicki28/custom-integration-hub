import { Router, type Request, type Response } from 'express';
import { createHmac, timingSafeEqual, randomBytes } from 'crypto';
import { config } from './config.js';
import {
  getAllOrganizations, getMountedIntegration, getMountedIntegrationsForOrg,
  type MountedIntegration,
} from './lib/registry.js';
import { getPersonName, getDealName, getDealStage, getPersonEmail, getPersonPhone } from './lib/attio.js';
import type { AttioWebhook, AttioListEntry } from './lib/attio.js';
import type { CloudTalkCall } from './lib/cloudtalk.js';
import type { ChannelMapping } from './lib/org-context.js';
import { createLogger } from './lib/logger.js';
import { metrics } from './lib/metrics.js';
import { loadAnalyses } from './lib/monitoring/analyst.js';
import type { PersistedAnalysis, VercelProjectHealth } from './lib/monitoring/types.js';

const log = createLogger('dashboard');

export const dashboardRouter = Router();

// --- Rate Limiter ---

const loginAttempts = new Map<string, { count: number; firstAttempt: number; lockedUntil: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now > entry.lockedUntil && now - entry.firstAttempt > WINDOW_MS) {
      loginAttempts.delete(ip);
    }
  }
}, 30 * 60 * 1000);
cleanup.unref();

function isRateLimited(ip: string): boolean {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  return Date.now() < entry.lockedUntil;
}

function recordAttempt(ip: string): void {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.firstAttempt > WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, firstAttempt: now, lockedUntil: 0 });
    return;
  }
  entry.count++;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = now + LOCKOUT_MS;
  }
}

function clearAttempts(ip: string): void {
  loginAttempts.delete(ip);
}

// --- CSRF Protection (double-submit cookie) ---

function generateCsrfToken(): string {
  return randomBytes(24).toString('hex');
}

function getCsrfCookie(req: Request): string | undefined {
  const header = req.headers.cookie || '';
  const match = header.match(/csrf_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function verifyCsrf(req: Request): boolean {
  const cookieToken = getCsrfCookie(req);
  const bodyToken = req.body?._csrf;
  if (!cookieToken || !bodyToken) return false;
  if (cookieToken.length !== bodyToken.length) return false;
  return timingSafeEqual(Buffer.from(cookieToken), Buffer.from(bodyToken));
}

function setCsrfCookie(res: Response): string {
  const token = generateCsrfToken();
  res.cookie('csrf_token', token, {
    httpOnly: true,
    secure: !config.isDev, sameSite: 'strict',
    path: '/dashboard', maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  return token;
}

// --- Session Blacklist (server-side invalidation) ---

const sessionBlacklist = new Map<string, number>();
const blacklistCleanup = setInterval(() => {
  const now = Date.now();
  const maxAge = 7 * 24 * 60 * 60 * 1000;
  for (const [token, ts] of sessionBlacklist) {
    if (now - ts > maxAge) sessionBlacklist.delete(token);
  }
}, 60 * 60 * 1000);
blacklistCleanup.unref();

// --- Cookie Auth ---

function signToken(timestamp: number): string {
  return `${timestamp}.${createHmac('sha256', config.dashboard.cookieSecret).update(String(timestamp)).digest('hex')}`;
}

function verifyToken(token: string): boolean {
  if (sessionBlacklist.has(token)) return false;
  const dot = token.indexOf('.');
  if (dot === -1) return false;
  const timestamp = parseInt(token.slice(0, dot), 10);
  const signature = token.slice(dot + 1);
  if (isNaN(timestamp)) return false;
  const age = Date.now() - timestamp;
  if (age > 7 * 24 * 60 * 60 * 1000 || age < 0) return false;
  const expected = createHmac('sha256', config.dashboard.cookieSecret).update(String(timestamp)).digest('hex');
  if (signature.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function getSessionCookie(req: Request): string | undefined {
  const header = req.headers.cookie || '';
  const match = header.match(/dashboard_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function isAuthenticated(req: Request): boolean {
  const token = getSessionCookie(req);
  return !!token && verifyToken(token);
}

function checkPassword(input: string): boolean {
  const a = Buffer.from(createHmac('sha256', 'pw-check').update(input).digest('hex'));
  const b = Buffer.from(createHmac('sha256', 'pw-check').update(config.dashboard.password).digest('hex'));
  return timingSafeEqual(a, b);
}

// --- Routes ---

dashboardRouter.get('/', (req: Request, res: Response) => {
  if (!config.dashboard.password) {
    res.status(503).send('Dashboard not configured. Set DASHBOARD_PASSWORD in .env');
    return;
  }
  if (!isAuthenticated(req)) {
    res.send(renderLoginPage());
    return;
  }

  const csrfToken = setCsrfCookie(res);
  const orgs = getAllOrganizations();
  const selectedOrgId = (req.query.org as string) || orgs[0]?.id || '';
  const mounted = getMountedIntegrationsForOrg(selectedOrgId);

  res.send(renderDashboardPage({ uptime: process.uptime(), orgs, selectedOrgId, mounted, csrfToken }));
});

dashboardRouter.post('/login', (req: Request, res: Response) => {
  if (!config.dashboard.password) { res.status(503).send('Dashboard not configured'); return; }
  const ip = req.ip || 'unknown';
  if (isRateLimited(ip)) {
    res.status(429).send(renderLoginPage('Zbyt wiele prób. Spróbuj ponownie za 15 minut.'));
    return;
  }
  const password = req.body?.password;
  if (!password || !checkPassword(password)) {
    recordAttempt(ip);
    res.send(renderLoginPage('Nieprawidłowe hasło.'));
    return;
  }
  clearAttempts(ip);
  res.cookie('dashboard_session', signToken(Date.now()), {
    httpOnly: true, secure: !config.isDev, sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000, path: '/dashboard',
  });
  res.redirect(303, '/dashboard');
});

dashboardRouter.post('/logout', (req: Request, res: Response) => {
  if (!requireCsrf(req, res)) return;
  const token = getSessionCookie(req);
  if (token) sessionBlacklist.set(token, Date.now());
  res.clearCookie('dashboard_session', { path: '/dashboard' });
  res.clearCookie('csrf_token', { path: '/dashboard' });
  res.redirect(303, '/dashboard');
});

// --- CSRF enforcement for authenticated POST actions ---

function requireCsrf(req: Request, res: Response): boolean {
  if (!verifyCsrf(req)) {
    res.status(403).send('CSRF token invalid. Please reload the page and try again.');
    return false;
  }
  return true;
}

// --- Monitoring Page ---

dashboardRouter.get('/monitoring', (req: Request, res: Response) => {
  if (!isAuthenticated(req)) { res.redirect('/dashboard'); return; }
  const csrfToken = setCsrfCookie(res);
  const highlightAnalysis = ((req.query.analysis as string) || '').replace(/[^a-zA-Z0-9T:\-]/g, '') || undefined;

  const snapshot1h = metrics.getSnapshot(3_600_000);
  const snapshot24h = metrics.getSnapshot(24 * 60 * 60 * 1000);
  const analyses = loadAnalyses();

  // Get hourly sparkline data (last 12 hours)
  const hourlyData: number[] = [];
  for (let i = 11; i >= 0; i--) {
    const windowStart = Date.now() - (i + 1) * 3_600_000;
    const windowEnd = Date.now() - i * 3_600_000;
    const count = metrics.getEvents(12 * 3_600_000).filter(e =>
      e.integration !== '_http' && e.timestamp >= windowStart && e.timestamp < windowEnd
    ).length;
    hourlyData.push(count);
  }

  res.send(renderMonitoringPage(snapshot1h, snapshot24h, analyses, hourlyData, highlightAnalysis, csrfToken));
});

// --- Dynamic Test Panel Routes ---

function param(req: Request, name: string): string {
  const val = req.params[name];
  return Array.isArray(val) ? val[0] : val;
}

// GET /test/:orgId/cloudtalk-call-notes
dashboardRouter.get('/test/:orgId/cloudtalk-call-notes', async (req: Request, res: Response) => {
  if (!isAuthenticated(req)) { res.redirect('/dashboard'); return; }
  const csrfToken = setCsrfCookie(res);
  const orgId = param(req, 'orgId');
  const mounted = getMountedIntegration(orgId, 'cloudtalk-call-notes');
  if (!mounted?.ctx.clients.cloudtalk) {
    res.redirect('/dashboard?org=' + orgId);
    return;
  }

  try {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const result = req.query.result as string | undefined;
    const callsPage = await mounted.ctx.clients.cloudtalk.getRecentCalls(5, page);
    res.send(renderTestPanel(orgId, callsPage.calls, callsPage.currentPage, callsPage.totalPages, result, csrfToken));
  } catch (err) {
    log.error({ err, path: req.path }, 'Dashboard route error');
    res.send(renderTestPanel(orgId, [], 1, 0, 'error:' + (err instanceof Error ? err.message : 'Błąd połączenia z CloudTalk'), csrfToken));
  }
});

// POST /test/:orgId/cloudtalk-call-notes/process
dashboardRouter.post('/test/:orgId/cloudtalk-call-notes/process', async (req: Request, res: Response) => {
  if (!isAuthenticated(req)) { res.redirect('/dashboard'); return; }
  if (!requireCsrf(req, res)) return;
  const orgId = param(req, 'orgId');
  const mounted = getMountedIntegration(orgId, 'cloudtalk-call-notes');
  const redirectBase = `/dashboard/test/${orgId}/cloudtalk-call-notes`;

  try {
    const callId = req.body?.call_id;
    if (!callId) { res.redirect(redirectBase + '?result=' + encodeURIComponent('error:Brak call_id')); return; }
    if (!mounted?.instance.handlers.processManual) { res.redirect(redirectBase + '?result=' + encodeURIComponent('error:Integracja nie zamontowana')); return; }

    const result = await mounted.instance.handlers.processManual(callId) as { success: boolean; personName?: string; dealName?: string; notesCreated?: number; error?: string };
    const msg = result.success
      ? `ok:${result.personName ?? '?'} | ${result.dealName ?? 'brak deala'} | ${result.notesCreated ?? 0} notatek`
      : `error:${result.error ?? 'Nieznany błąd'}`;
    res.redirect(redirectBase + '?result=' + encodeURIComponent(msg));
  } catch (err) {
    log.error({ err, path: req.path }, 'Dashboard route error');
    res.redirect(redirectBase + '?result=' + encodeURIComponent('error:' + (err instanceof Error ? err.message : 'Nieznany błąd')));
  }
});

// GET /test/:orgId/slack-lead-notifications
dashboardRouter.get('/test/:orgId/slack-lead-notifications', async (req: Request, res: Response) => {
  if (!isAuthenticated(req)) { res.redirect('/dashboard'); return; }
  const csrfToken = setCsrfCookie(res);
  const orgId = param(req, 'orgId');
  const mounted = getMountedIntegration(orgId, 'slack-lead-notifications');
  if (!mounted) { res.redirect('/dashboard?org=' + orgId); return; }

  const result = req.query.result as string | undefined;
  const attio = mounted.ctx.clients.attio;
  const slack = mounted.ctx.clients.slack;
  const listChannelMap = (mounted.instance.handlers.listChannelMap ?? new Map()) as Map<string, ChannelMapping>;

  let entryGroups: Array<{ listId: string; listName: string; channelName: string; entries: LeadEntry[] }> = [];
  let loadError = '';
  let slackStatus: { ok: boolean; team?: string; error?: string } = { ok: false, error: 'nie skonfigurowano' };
  let webhook: AttioWebhook | null = null;

  try {
    // Enrich entries for each list in the channel map
    const enrichPromises = Array.from(listChannelMap.entries()).map(async ([listId, mapping]) => {
      const entries = await enrichListEntries(attio, listId, mapping.listName);
      return { listId, listName: mapping.listName, channelName: mapping.channelName, entries };
    });

    const [groups, slackResult, webhooks] = await Promise.all([
      Promise.all(enrichPromises),
      slack?.testConnection().catch(() => ({ ok: false, error: 'timeout' } as const)) ?? { ok: false, error: 'nie skonfigurowano' },
      attio.listWebhooks().catch(() => [] as AttioWebhook[]),
    ]);

    entryGroups = groups;
    slackStatus = slackResult;
    webhook = webhooks.find(w => w.target_url.includes(`/${orgId}/slack-lead-notifications`)) ?? null;
  } catch (err) {
    loadError = err instanceof Error ? err.message : 'Błąd ładowania danych';
  }

  res.send(renderSlackLeadPanel(orgId, entryGroups, slackStatus, webhook, listChannelMap, result, loadError, csrfToken));
});

// POST /test/:orgId/slack-lead-notifications/send
dashboardRouter.post('/test/:orgId/slack-lead-notifications/send', async (req: Request, res: Response) => {
  if (!isAuthenticated(req)) { res.redirect('/dashboard'); return; }
  if (!requireCsrf(req, res)) return;
  const orgId = param(req, 'orgId');
  const mounted = getMountedIntegration(orgId, 'slack-lead-notifications');
  const redirectBase = `/dashboard/test/${orgId}/slack-lead-notifications`;

  try {
    const dealRecordId = req.body?.deal_record_id;
    const listId = req.body?.list_id;
    if (!dealRecordId || !listId) { res.redirect(redirectBase + '?result=' + encodeURIComponent('error:Brak deal_record_id lub list_id')); return; }
    if (!mounted?.instance.handlers.processManual) { res.redirect(redirectBase + '?result=' + encodeURIComponent('error:Integracja nie zamontowana')); return; }

    const result = await mounted.instance.handlers.processManual(dealRecordId, listId) as { success: boolean; personName?: string; dealName?: string; slackChannel?: string; error?: string };
    const msg = result.success
      ? `ok:${result.personName ?? '?'} | ${result.dealName ?? '?'} | ${result.slackChannel ?? '?'}`
      : `error:${result.error ?? 'Nieznany błąd'}`;
    res.redirect(redirectBase + '?result=' + encodeURIComponent(msg));
  } catch (err) {
    log.error({ err, path: req.path }, 'Dashboard route error');
    res.redirect(redirectBase + '?result=' + encodeURIComponent('error:' + (err instanceof Error ? err.message : 'Nieznany błąd')));
  }
});

// POST /test/:orgId/slack-lead-notifications/reset-webhook
dashboardRouter.post('/test/:orgId/slack-lead-notifications/reset-webhook', async (req: Request, res: Response) => {
  if (!isAuthenticated(req)) { res.redirect('/dashboard'); return; }
  if (!requireCsrf(req, res)) return;
  const orgId = param(req, 'orgId');
  const mounted = getMountedIntegration(orgId, 'slack-lead-notifications');
  const redirectBase = `/dashboard/test/${orgId}/slack-lead-notifications`;
  if (!mounted) { res.redirect(redirectBase + '?result=' + encodeURIComponent('error:Integracja nie zamontowana')); return; }

  const attio = mounted.ctx.clients.attio;
  const listChannelMap = (mounted.instance.handlers.listChannelMap ?? new Map()) as Map<string, ChannelMapping>;

  try {
    try {
      const webhooks = await attio.listWebhooks();
      const existing = webhooks.find(w => w.target_url.includes(`/${orgId}/slack-lead-notifications`));
      if (existing) await attio.deleteWebhook(existing.id.webhook_id);
    } catch { /* continue */ }

    const targetUrl = `${config.webhookBaseUrl}/${orgId}/slack-lead-notifications/webhook`;
    const listIds = Array.from(listChannelMap.keys());

    if (listIds.length === 0) {
      res.redirect(redirectBase + '?result=' + encodeURIComponent('error:Brak skonfigurowanych list w organizations.json'));
      return;
    }

    const result = await attio.registerWebhook(targetUrl, [{
      event_type: 'list-entry.created',
      filter: null,
    }]);

    if (!result) {
      res.redirect(redirectBase + '?result=' + encodeURIComponent('error:Nie udało się zarejestrować webhooka'));
      return;
    }

    // Store secret in runtime context — no manual .env editing needed
    mounted.ctx.org.webhookSecret = result.secret;

    res.redirect(redirectBase + '?result=' + encodeURIComponent('ok:Webhook zarejestrowany!'));
  } catch (err) {
    log.error({ err, path: req.path }, 'Dashboard route error');
    res.redirect(redirectBase + '?result=' + encodeURIComponent('error:' + (err instanceof Error ? err.message : 'Nieznany błąd')));
  }
});

// GET /test/:orgId/lead-intake — no test panel, redirect back
dashboardRouter.get('/test/:orgId/lead-intake', (req: Request, res: Response) => {
  res.redirect('/dashboard?org=' + encodeURIComponent(param(req, 'orgId')));
});

// GET /test/:orgId/calendly-booking-sync
dashboardRouter.get('/test/:orgId/calendly-booking-sync', async (req: Request, res: Response) => {
  if (!isAuthenticated(req)) { res.redirect('/dashboard'); return; }
  const csrfToken = setCsrfCookie(res);
  const orgId = param(req, 'orgId');
  const mounted = getMountedIntegration(orgId, 'calendly-booking-sync');
  if (!mounted) { res.redirect('/dashboard?org=' + orgId); return; }

  const result = req.query.result as string | undefined;
  const attio = mounted.ctx.clients.attio;
  const campaignLists = (mounted.instance.handlers.campaignLists ?? {}) as Record<string, { listName: string; statusSlug: string }>;

  let entryGroups: Array<{ listId: string; listName: string; entries: LeadEntry[] }> = [];
  let loadError = '';

  try {
    const enrichPromises = Object.entries(campaignLists).map(async ([listId, config]) => {
      const entries = await enrichListEntries(attio, listId, config.listName);
      return { listId, listName: config.listName, entries };
    });
    entryGroups = await Promise.all(enrichPromises);
  } catch (err) {
    loadError = err instanceof Error ? err.message : 'Błąd ładowania danych';
  }

  res.send(renderCalendlySyncPanel(orgId, entryGroups, result, loadError, csrfToken));
});

// POST /test/:orgId/calendly-booking-sync/sync
dashboardRouter.post('/test/:orgId/calendly-booking-sync/sync', async (req: Request, res: Response) => {
  if (!isAuthenticated(req)) { res.redirect('/dashboard'); return; }
  if (!requireCsrf(req, res)) return;
  const orgId = param(req, 'orgId');
  const mounted = getMountedIntegration(orgId, 'calendly-booking-sync');
  const redirectBase = `/dashboard/test/${orgId}/calendly-booking-sync`;

  try {
    const email = req.body?.email;
    if (!email) { res.redirect(redirectBase + '?result=' + encodeURIComponent('error:Brak email')); return; }
    if (!mounted?.instance.handlers.processManual) { res.redirect(redirectBase + '?result=' + encodeURIComponent('error:Integracja nie zamontowana')); return; }

    const syncResult = await mounted.instance.handlers.processManual(email) as { success: boolean; email?: string; error?: string };
    const msg = syncResult.success
      ? `ok:Sync OK dla ${syncResult.email ?? email}`
      : `error:${syncResult.error ?? 'Nieznany błąd'}`;
    res.redirect(redirectBase + '?result=' + encodeURIComponent(msg));
  } catch (err) {
    log.error({ err, path: req.path }, 'Dashboard route error');
    res.redirect(redirectBase + '?result=' + encodeURIComponent('error:' + (err instanceof Error ? err.message : 'Nieznany błąd')));
  }
});

// --- Metrics API ---

dashboardRouter.get('/api/metrics', (req: Request, res: Response) => {
  if (!isAuthenticated(req)) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const windowMs = Math.min(parseInt(req.query.window as string, 10) || 3_600_000, 24 * 60 * 60 * 1000);
  res.json(metrics.getSnapshot(windowMs));
});

dashboardRouter.get('/api/metrics/events', (req: Request, res: Response) => {
  if (!isAuthenticated(req)) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const windowMs = Math.min(parseInt(req.query.window as string, 10) || 3_600_000, 24 * 60 * 60 * 1000);
  res.json(metrics.getEvents(windowMs));
});

// --- Helpers ---

interface LeadEntry {
  dealRecordId: string;
  listId: string;
  listName: string;
  dealName: string;
  personName: string;
  email: string | null;
  stage: string;
  createdAt: string;
}

async function enrichListEntries(attio: import('./lib/org-context.js').AttioClient, listId: string, listName: string): Promise<LeadEntry[]> {
  const entries = await attio.queryListEntries(listId, 5);
  const enriched: LeadEntry[] = [];

  await Promise.all(entries.map(async (entry: AttioListEntry) => {
    const deal = await attio.getDealDetails(entry.parent_record_id);
    if (!deal) return;

    const dealName = getDealName(deal);
    const stage = getDealStage(deal);
    const associatedPeople = deal.values.associated_people as Array<{ target_record_id: string }> | undefined;
    const firstPersonId = associatedPeople?.[0]?.target_record_id;
    let personName = 'Brak osoby';
    let email: string | null = null;
    if (firstPersonId) {
      const person = await attio.getPersonDetails(firstPersonId);
      if (person) {
        personName = getPersonName(person);
        email = getPersonEmail(person);
      }
    }

    enriched.push({ dealRecordId: entry.parent_record_id, listId, listName, dealName, personName, email, stage, createdAt: entry.created_at });
  }));

  enriched.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return enriched;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// --- HTML Rendering ---

const STYLES = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; min-height: 100vh; padding: 24px; }
  .container { max-width: 1000px; margin: 0 auto; }
  header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; }
  h1 { font-size: 22px; font-weight: 600; color: #f0f6fc; }
  .header-left { display: flex; align-items: center; gap: 16px; }
  .org-switcher { background: #161b22; border: 1px solid #30363d; color: #c9d1d9; padding: 6px 12px; border-radius: 6px; font-size: 13px; cursor: pointer; }
  .org-switcher:focus { border-color: #388bfd; outline: none; }
  .logout-btn { background: none; border: 1px solid #30363d; color: #8b949e; padding: 6px 14px; border-radius: 6px; font-size: 13px; cursor: pointer; text-decoration: none; }
  .logout-btn:hover { border-color: #8b949e; color: #c9d1d9; }
  .stats { display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap; }
  .stat { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 16px 20px; flex: 1; min-width: 120px; }
  .stat-value { font-size: 24px; font-weight: 700; color: #f0f6fc; }
  .stat-label { font-size: 12px; color: #8b949e; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
  .integration-card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 20px; margin-bottom: 12px; }
  .card-header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
  .status-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .status-active { background: #3fb950; box-shadow: 0 0 6px #3fb95066; }
  .status-development { background: #d29922; box-shadow: 0 0 6px #d2992266; }
  .status-inactive { background: #484f58; }
  .integration-name { font-size: 16px; font-weight: 600; color: #f0f6fc; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 12px; font-weight: 500; text-transform: uppercase; }
  .badge-webhook { background: #1f6feb33; color: #58a6ff; }
  .badge-cron { background: #8957e533; color: #bc8cff; }
  .badge-hybrid { background: #d2992233; color: #d29922; }
  .description { font-size: 14px; color: #8b949e; margin-bottom: 12px; }
  .meta { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
  .meta-row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
  .meta-label { color: #484f58; min-width: 60px; }
  code { font-family: 'SF Mono', Consolas, monospace; font-size: 12px; background: #0d1117; padding: 2px 6px; border-radius: 4px; color: #79c0ff; }
  .status-text-active { color: #3fb950; font-weight: 500; }
  .status-text-development { color: #d29922; font-weight: 500; }
  .status-text-inactive { color: #484f58; font-weight: 500; }
  .tags { display: flex; gap: 6px; flex-wrap: wrap; }
  .tag-trigger { font-size: 11px; padding: 3px 10px; border-radius: 12px; background: #3fb95020; color: #3fb950; border: 1px solid #3fb95040; }
  .tag-target { font-size: 11px; padding: 3px 10px; border-radius: 12px; background: #58a6ff20; color: #58a6ff; border: 1px solid #58a6ff40; }
  .back-link { color: #58a6ff; text-decoration: none; font-size: 14px; }
  .back-link:hover { text-decoration: underline; }
  .flash { padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 14px; word-break: break-all; }
  .flash-ok { background: #23863633; border: 1px solid #238636; color: #3fb950; }
  .flash-error { background: #da363433; border: 1px solid #da3634; color: #f85149; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 10px 12px; font-size: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; border-bottom: 1px solid #21262d; }
  td { padding: 10px 12px; border-top: 1px solid #21262d; font-size: 13px; }
  tr:hover td { background: #1c2129; }
  .btn-process { background: #1f6feb; color: #fff; border: none; padding: 5px 14px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; }
  .btn-process:hover { background: #388bfd; }
  .section-card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
  .section-title { font-size: 14px; font-weight: 600; color: #f0f6fc; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
  .channel-tag { font-size: 11px; padding: 2px 8px; border-radius: 12px; background: #58a6ff20; color: #58a6ff; border: 1px solid #58a6ff40; }
  .conn-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; font-size: 13px; border-bottom: 1px solid #21262d; }
  .conn-row:last-child { border-bottom: none; }
  .conn-label { min-width: 70px; color: #8b949e; font-weight: 500; }
  .conn-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .status-dot-ok { background: #3fb950; box-shadow: 0 0 4px #3fb95066; }
  .status-dot-warn { background: #d29922; box-shadow: 0 0 4px #d2992266; }
  .status-dot-error { background: #f85149; box-shadow: 0 0 4px #f8514966; }
  .status-dot-none { background: #484f58; }
  .conn-status { flex: 1; }
  .btn-action { background: #238636; color: #fff; border: none; padding: 4px 12px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; }
  .btn-action:hover { background: #2ea043; }
  .btn-action-subtle { background: none; color: #8b949e; border: 1px solid #30363d; padding: 4px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; }
  .btn-action-subtle:hover { border-color: #8b949e; color: #c9d1d9; }
  .pagination { display: flex; align-items: center; justify-content: center; gap: 16px; margin-top: 16px; }
  .page-link { color: #58a6ff; text-decoration: none; font-size: 14px; padding: 6px 12px; border: 1px solid #30363d; border-radius: 6px; }
  .page-link:hover { border-color: #58a6ff; }
  .page-info { font-size: 13px; color: #8b949e; }
  .tab-nav { display: flex; gap: 4px; }
  .tab { padding: 6px 14px; border-radius: 6px; font-size: 13px; color: #8b949e; text-decoration: none; font-weight: 500; }
  .tab:hover { color: #c9d1d9; background: #21262d; }
  .tab-active { color: #f0f6fc; background: #1f6feb33; border: 1px solid #1f6feb66; }
  .sparkline { font-family: monospace; letter-spacing: 1px; color: #3fb950; font-size: 14px; }
  .analysis-card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 16px; margin-bottom: 12px; }
  .analysis-header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
  .badge-normal { background: #3fb95020; color: #3fb950; }
  .badge-anomaly { background: #d2992233; color: #d29922; }
  .badge-critical { background: #da363433; color: #f85149; }
  .badge-hourly { background: #58a6ff20; color: #58a6ff; }
  .badge-daily { background: #8957e533; color: #bc8cff; }
  .badge-micro { background: #d2992233; color: #d29922; }
  .detail-toggle { cursor: pointer; color: #58a6ff; font-size: 12px; text-decoration: none; }
  .detail-content { display: none; margin-top: 12px; padding: 12px; background: #0d1117; border-radius: 6px; font-size: 12px; white-space: pre-wrap; word-break: break-all; max-height: 400px; overflow-y: auto; }
  .vercel-table td code { font-size: 11px; }
  footer { text-align: center; padding: 24px 0 8px; font-size: 12px; color: #30363d; }
  @media (max-width: 700px) { body { padding: 16px; } table { font-size: 12px; } th, td { padding: 8px 6px; } .stat { min-width: 100%; } .stats { flex-direction: column; } }
`;

function pageShell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — Integration Hub</title>
  <link rel="icon" href="data:,">
  <style>${STYLES}</style>
</head>
<body>${body}</body>
</html>`;
}

function renderLoginPage(error?: string): string {
  return `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Login — Integration Hub</title><link rel="icon" href="data:,">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 40px; width: 100%; max-width: 380px; }
    h1 { font-size: 20px; font-weight: 600; margin-bottom: 24px; text-align: center; color: #f0f6fc; }
    .error { background: #da363433; border: 1px solid #da3634; color: #f85149; padding: 10px 14px; border-radius: 8px; margin-bottom: 16px; font-size: 14px; }
    input[type="password"] { width: 100%; padding: 10px 14px; background: #0d1117; border: 1px solid #30363d; border-radius: 8px; color: #c9d1d9; font-size: 15px; outline: none; }
    input[type="password"]:focus { border-color: #388bfd; }
    button { width: 100%; padding: 10px; margin-top: 16px; background: #238636; color: #fff; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; }
    button:hover { background: #2ea043; }
    .sub { text-align: center; margin-top: 16px; font-size: 12px; color: #484f58; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Integration Hub</h1>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <form method="POST" action="/dashboard/login">
      <input type="password" name="password" placeholder="Hasło" autofocus required>
      <button type="submit">Zaloguj</button>
    </form>
    <div class="sub">custom-integration-hub.velocy.co</div>
  </div>
</body>
</html>`;
}

function renderDashboardPage(data: {
  uptime: number;
  orgs: import('./lib/org-context.js').OrganizationEntry[];
  selectedOrgId: string;
  mounted: MountedIntegration[];
  csrfToken: string;
}): string {
  const uptime = formatUptime(data.uptime);
  const active = data.mounted.filter(m => m.status === 'active').length;
  const dev = data.mounted.filter(m => m.status === 'development').length;
  const inactive = data.mounted.filter(m => m.status === 'inactive').length;

  const orgOptions = data.orgs.map(o =>
    `<option value="${escapeHtml(o.id)}" ${o.id === data.selectedOrgId ? 'selected' : ''}>${escapeHtml(o.name)}</option>`
  ).join('');

  const integrationCards = data.mounted.map(m => {
    const path = `/${m.orgId}/${m.catalogEntry.id}`;
    return `
    <div class="integration-card">
      <div class="card-header">
        <span class="status-dot status-${m.status}"></span>
        <span class="integration-name">${escapeHtml(m.catalogEntry.name)}</span>
        <span class="badge badge-${m.catalogEntry.type}">${m.catalogEntry.type}</span>
      </div>
      <div class="description">${escapeHtml(m.catalogEntry.description)}</div>
      <div class="meta">
        <div class="meta-row"><span class="meta-label">Path</span><code>${escapeHtml(path)}</code></div>
        <div class="meta-row"><span class="meta-label">Status</span><span class="status-text-${m.status}">${m.status}</span></div>
      </div>
      <div class="tags">
        ${m.catalogEntry.triggers.map(t => `<span class="tag-trigger">${escapeHtml(t)}</span>`).join('')}
        ${m.catalogEntry.targets.map(t => `<span class="tag-target">${escapeHtml(t)}</span>`).join('')}
      </div>
      <div style="margin-top:12px">
        <a href="/dashboard/test/${escapeHtml(m.orgId)}/${escapeHtml(m.catalogEntry.id)}" style="color:#58a6ff;font-size:13px;text-decoration:none">Zarządzaj &rarr;</a>
      </div>
    </div>`;
  }).join('');

  const body = `
  <div class="container">
    <header>
      <div class="header-left">
        <h1>Integration Hub</h1>
        <nav class="tab-nav"><a href="/dashboard" class="tab tab-active">Integracje</a><a href="/dashboard/monitoring" class="tab">Monitoring</a></nav>
        <form method="GET" action="/dashboard" style="display:inline"><select name="org" class="org-switcher" onchange="this.form.submit()">
          ${orgOptions}
        </select><noscript><button type="submit" class="btn-process">Go</button></noscript></form>
      </div>
      <form method="POST" action="/dashboard/logout" style="display:inline">
        <input type="hidden" name="_csrf" value="${data.csrfToken}">
        <button type="submit" class="logout-btn">Wyloguj</button>
      </form>
    </header>
    <div class="stats">
      <div class="stat"><div class="stat-value">${uptime}</div><div class="stat-label">Uptime</div></div>
      <div class="stat"><div class="stat-value" style="color:#3fb950">${active}</div><div class="stat-label">Aktywne</div></div>
      <div class="stat"><div class="stat-value" style="color:#d29922">${dev}</div><div class="stat-label">Development</div></div>
      <div class="stat"><div class="stat-value" style="color:#484f58">${inactive}</div><div class="stat-label">Nieaktywne</div></div>
    </div>
    ${integrationCards || '<div style="text-align:center;color:#484f58;padding:40px">Brak integracji dla tej organizacji</div>'}
    <footer>custom-integration-hub.velocy.co</footer>
  </div>`;

  return pageShell('Dashboard', body);
}

function renderFlash(resultParam?: string): string {
  if (!resultParam) return '';
  const isError = resultParam.startsWith('error:');
  const message = resultParam.replace(/^(ok|error):/, '');
  return `<div class="flash ${isError ? 'flash-error' : 'flash-ok'}">${isError ? 'Błąd: ' : 'Sukces: '}${escapeHtml(message)}</div>`;
}

function renderTestPanel(orgId: string, calls: CloudTalkCall[], currentPage: number, totalPages: number, resultParam?: string, csrfToken?: string): string {
  const safeOrgId = encodeURIComponent(orgId);
  const basePath = `/dashboard/test/${safeOrgId}/cloudtalk-call-notes`;

  const rows = calls.map(c => {
    const date = new Date(c.startedAt);
    const dateStr = date.toLocaleDateString('pl-PL') + ' ' + date.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
    const dir = c.type === 'outgoing' ? 'Wych.' : c.type === 'incoming' ? 'Przych.' : 'Wewn.';
    const dur = c.duration >= 60 ? `${Math.floor(c.duration / 60)}m ${c.duration % 60}s` : `${c.duration}s`;
    return `<tr>
      <td>${dateStr}</td><td><code>${escapeHtml(c.externalNumber)}</code></td><td>${dir}</td><td>${dur}</td><td>${escapeHtml(c.agentName)}</td>
      <td>${c.recorded ? '<span style="color:#3fb950">Tak</span>' : '<span style="color:#484f58">Nie</span>'}</td>
      <td><form method="POST" action="${basePath}/process" style="display:inline"><input type="hidden" name="_csrf" value="${csrfToken ?? ''}"><input type="hidden" name="call_id" value="${c.id}"><button type="submit" class="btn-process">Przetwórz</button></form></td>
    </tr>`;
  }).join('');

  const pagination = [
    currentPage > 1 ? `<a href="${basePath}?page=${currentPage - 1}" class="page-link">&larr; Poprzednia</a>` : '',
    `<span class="page-info">Strona ${currentPage} z ${totalPages}</span>`,
    currentPage < totalPages ? `<a href="${basePath}?page=${currentPage + 1}" class="page-link">Następna &rarr;</a>` : '',
  ].filter(Boolean).join('');

  const body = `
  <div class="container">
    <header><div><a href="/dashboard?org=${safeOrgId}" class="back-link">&larr; Dashboard</a><h1 style="margin-top:8px">CloudTalk Call Notes</h1></div></header>
    ${renderFlash(resultParam)}
    <div class="section-card">
    <table><thead><tr><th>Data</th><th>Numer</th><th>Kierunek</th><th>Czas</th><th>Agent</th><th>Nagranie</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7" style="text-align:center;color:#484f58;padding:20px">Brak rozmów</td></tr>'}</tbody></table>
    </div>
    <div class="pagination">${pagination}</div>
    <footer>custom-integration-hub.velocy.co</footer>
  </div>`;

  return pageShell('CloudTalk Call Notes', body);
}

function renderSlackLeadPanel(
  orgId: string,
  entryGroups: Array<{ listId: string; listName: string; channelName: string; entries: LeadEntry[] }>,
  slackStatus: { ok: boolean; team?: string; error?: string },
  webhook: AttioWebhook | null,
  listChannelMap: Map<string, ChannelMapping>,
  resultParam?: string,
  loadError?: string,
  csrfToken?: string,
): string {
  const safeOrgId = encodeURIComponent(orgId);
  const basePath = `/dashboard/test/${safeOrgId}/slack-lead-notifications`;

  let flashHtml = renderFlash(resultParam);
  if (loadError) flashHtml += `<div class="flash flash-error">Błąd ładowania: ${escapeHtml(loadError)}</div>`;

  const slackDot = slackStatus.ok ? 'status-dot-ok' : 'status-dot-error';
  const slackLabel = slackStatus.ok ? `Połączono (${escapeHtml(slackStatus.team ?? '?')})` : `Brak połączenia (${escapeHtml(slackStatus.error ?? '?')})`;

  const csrfField = `<input type="hidden" name="_csrf" value="${csrfToken ?? ''}">`;

  let webhookDot: string, webhookLabel: string, webhookAction: string;
  if (!webhook) {
    webhookDot = 'status-dot-none'; webhookLabel = 'Niezarejestrowany';
    webhookAction = `<form method="POST" action="${basePath}/reset-webhook" style="display:inline">${csrfField}<button type="submit" class="btn-action">Zarejestruj</button></form>`;
  } else if (webhook.status === 'active') {
    webhookDot = 'status-dot-ok'; webhookLabel = `Aktywny <code>${escapeHtml(webhook.id.webhook_id.slice(0, 8))}...</code>`;
    webhookAction = `<form method="POST" action="${basePath}/reset-webhook" style="display:inline">${csrfField}<button type="submit" class="btn-action-subtle">Zarejestruj ponownie</button></form>`;
  } else {
    webhookDot = webhook.status === 'degraded' ? 'status-dot-warn' : 'status-dot-error';
    webhookLabel = `${escapeHtml(webhook.status)} <code>${escapeHtml(webhook.id.webhook_id.slice(0, 8))}...</code>`;
    webhookAction = `<form method="POST" action="${basePath}/reset-webhook" style="display:inline">${csrfField}<button type="submit" class="btn-action">Usuń i zarejestruj ponownie</button></form>`;
  }

  const groupHtml = entryGroups.map(g => {
    const entryRows = g.entries.length === 0
      ? '<tr><td colspan="5" style="text-align:center;color:#484f58;padding:20px">Brak wpisów</td></tr>'
      : g.entries.map(e => {
        const date = new Date(e.createdAt);
        const dateStr = date.toLocaleDateString('pl-PL') + ' ' + date.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
        return `<tr><td>${dateStr}</td><td>${escapeHtml(e.dealName)}</td><td>${escapeHtml(e.personName)}</td><td>${escapeHtml(e.stage)}</td>
        <td><form method="POST" action="${basePath}/send" style="display:inline">${csrfField}<input type="hidden" name="deal_record_id" value="${escapeHtml(e.dealRecordId)}"><input type="hidden" name="list_id" value="${escapeHtml(e.listId)}"><button type="submit" class="btn-process">Wyślij na Slacka</button></form></td></tr>`;
      }).join('');

    return `<div class="section-card">
      <div class="section-title">Kampania: ${escapeHtml(g.listName)} <span class="channel-tag">${escapeHtml(g.channelName)}</span></div>
      <table><thead><tr><th>Data</th><th>Deal</th><th>Osoba</th><th>Etap</th><th></th></tr></thead><tbody>${entryRows}</tbody></table>
    </div>`;
  }).join('');

  const body = `
  <div class="container">
    <header><div><a href="/dashboard?org=${safeOrgId}" class="back-link">&larr; Dashboard</a><h1 style="margin-top:8px">Slack Lead Notifications</h1></div></header>
    ${flashHtml}
    <div class="section-card">
      <div class="section-title">Połączenia</div>
      <div class="conn-row"><span class="conn-label">Slack</span><span class="conn-dot ${slackDot}"></span><span class="conn-status">${slackLabel}</span></div>
      <div class="conn-row"><span class="conn-label">Webhook</span><span class="conn-dot ${webhookDot}"></span><span class="conn-status">${webhookLabel}</span>${webhookAction}</div>
    </div>
    ${groupHtml}
    <footer>custom-integration-hub.velocy.co</footer>
  </div>`;

  return pageShell('Slack Lead Notifications', body);
}

function renderCalendlySyncPanel(
  orgId: string,
  entryGroups: Array<{ listId: string; listName: string; entries: LeadEntry[] }>,
  resultParam?: string,
  loadError?: string,
  csrfToken?: string,
): string {
  const safeOrgId = encodeURIComponent(orgId);
  const basePath = `/dashboard/test/${safeOrgId}/calendly-booking-sync`;

  let flashHtml = renderFlash(resultParam);
  if (loadError) flashHtml += `<div class="flash flash-error">Błąd ładowania: ${escapeHtml(loadError)}</div>`;

  const groupHtml = entryGroups.map(g => {
    const entryRows = g.entries.length === 0
      ? '<tr><td colspan="6" style="text-align:center;color:#484f58;padding:20px">Brak wpisów</td></tr>'
      : g.entries.map(e => {
        const date = new Date(e.createdAt);
        const dateStr = date.toLocaleDateString('pl-PL') + ' ' + date.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
        const emailVal = e.email ?? '';
        return `<tr><td>${dateStr}</td><td>${escapeHtml(e.dealName)}</td><td>${escapeHtml(e.personName)}</td><td>${emailVal ? escapeHtml(emailVal) : '<span style="color:#484f58">brak</span>'}</td><td>${escapeHtml(e.stage)}</td>
        <td>${emailVal
          ? `<form method="POST" action="${basePath}/sync" style="display:inline"><input type="hidden" name="_csrf" value="${csrfToken ?? ''}"><input type="hidden" name="email" value="${escapeHtml(emailVal)}"><button type="submit" class="btn-process">Sync</button></form>`
          : ''}</td></tr>`;
      }).join('');

    return `<div class="section-card">
      <div class="section-title">Kampania: ${escapeHtml(g.listName)}</div>
      <table><thead><tr><th>Data</th><th>Deal</th><th>Osoba</th><th>Email</th><th>Etap</th><th></th></tr></thead><tbody>${entryRows}</tbody></table>
    </div>`;
  }).join('');

  const body = `
  <div class="container">
    <header><div><a href="/dashboard?org=${safeOrgId}" class="back-link">&larr; Dashboard</a><h1 style="margin-top:8px">Calendly Booking Sync</h1></div></header>
    ${flashHtml}
    <div class="section-card">
      <div class="section-title">Ręczny sync po emailu</div>
      <form method="POST" action="${basePath}/sync" style="display:flex;gap:8px;align-items:center">
        <input type="hidden" name="_csrf" value="${csrfToken ?? ''}">
        <input type="email" name="email" placeholder="Email leada" required style="flex:1;padding:8px 12px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:14px">
        <button type="submit" class="btn-action">Synchronizuj</button>
      </form>
    </div>
    ${groupHtml}
    <footer>custom-integration-hub.velocy.co</footer>
  </div>`;

  return pageShell('Calendly Booking Sync', body);
}

// --- Monitoring Page ---

function buildSparkline(data: number[]): string {
  const bars = '▁▂▃▄▅▆▇█';
  const max = Math.max(...data, 1);
  return data.map(v => bars[Math.min(Math.round((v / max) * (bars.length - 1)), bars.length - 1)]).join('');
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'teraz';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}min temu`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h temu`;
  return `${Math.floor(diff / 86_400_000)}d temu`;
}

function renderMonitoringPage(
  snapshot1h: import('./lib/metrics.js').MetricsSnapshot,
  snapshot24h: import('./lib/metrics.js').MetricsSnapshot,
  analyses: PersistedAnalysis[],
  hourlyData: number[],
  highlightAnalysis?: string,
  csrfToken?: string,
): string {
  const successRate = snapshot1h.totals.total > 0
    ? Math.round((snapshot1h.totals.success / snapshot1h.totals.total) * 100)
    : 100;

  const activeIntegrations = Object.keys(snapshot1h.byIntegration).length;

  // Stats row
  const statsHtml = `
    <div class="stats">
      <div class="stat"><div class="stat-value">${snapshot1h.http.total}</div><div class="stat-label">Requests 1h</div></div>
      <div class="stat"><div class="stat-value" style="color:${successRate >= 90 ? '#3fb950' : successRate >= 70 ? '#d29922' : '#f85149'}">${successRate}%</div><div class="stat-label">Success Rate</div></div>
      <div class="stat"><div class="stat-value">${snapshot1h.http.avgDurationMs}ms</div><div class="stat-label">Avg Latency</div></div>
      <div class="stat"><div class="stat-value">${activeIntegrations}</div><div class="stat-label">Active 1h</div></div>
      <div class="stat"><div class="stat-value">${snapshot24h.totals.total}</div><div class="stat-label">Events 24h</div></div>
    </div>`;

  // Sparkline
  const sparklineHtml = hourlyData.some(v => v > 0) ? `
    <div class="section-card">
      <div class="section-title">Aktywność (ostatnie 12h)</div>
      <div class="sparkline" title="${hourlyData.join(', ')}">${buildSparkline(hourlyData)}</div>
      <div style="font-size:11px;color:#484f58;margin-top:4px">Lewo = 12h temu, prawo = teraz. Skala: max ${Math.max(...hourlyData)} eventów/h</div>
    </div>` : '';

  // Per-integration breakdown
  const integrationCards = Object.entries(snapshot1h.byIntegration).map(([name, stats]) => {
    const orgParts = Object.entries(stats.byOrg).map(([o, c]) =>
      `<span class="badge badge-webhook" style="font-size:10px">${escapeHtml(o)}: ${c}</span>`
    ).join(' ');
    const errColor = stats.error > 0 ? '#f85149' : '#3fb950';
    return `<div class="integration-card" style="padding:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <span style="font-weight:600;color:#f0f6fc">${escapeHtml(name)}</span>
        <span style="font-size:12px;color:#8b949e">${stats.avgDurationMs}ms avg</span>
      </div>
      <div style="display:flex;gap:16px;margin-top:8px;font-size:13px">
        <span style="color:#3fb950">${stats.success} ok</span>
        <span style="color:${errColor}">${stats.error} err</span>
        <span style="color:#8b949e">${stats.skip} skip</span>
        <span style="color:#484f58">${stats.dedup} dedup</span>
      </div>
      <div style="margin-top:6px">${orgParts}</div>
    </div>`;
  }).join('');

  // AI Analyses timeline
  const sortedAnalyses = [...analyses].reverse(); // newest first
  const analysesHtml = sortedAnalyses.length === 0
    ? '<div style="text-align:center;color:#484f58;padding:30px">Brak analiz AI — pierwsza pojawi się po godzinie od startu</div>'
    : sortedAnalyses.map((a, i) => {
      const time = new Date(a.timestamp);
      const timeStr = time.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Warsaw' });
      const isHighlighted = highlightAnalysis === a.id;
      const highlightStyle = isHighlighted ? 'border-color:#1f6feb;box-shadow:0 0 8px #1f6feb44;' : '';

      let anomalyHtml = '';
      if (a.anomalies.length > 0) {
        anomalyHtml = a.anomalies.map(an =>
          `<div style="font-size:12px;margin-top:4px;color:#c9d1d9">
            <span style="color:${an.severity === 'high' ? '#f85149' : an.severity === 'medium' ? '#d29922' : '#58a6ff'}">●</span>
            <strong>${escapeHtml(an.metric)}</strong>: ${escapeHtml(an.actual)} (oczekiwano: ${escapeHtml(an.expected)})
          </div>`
        ).join('');
      }

      const detailId = `detail-${i}`;
      return `<div class="analysis-card" id="analysis-${escapeHtml(a.id)}" style="${highlightStyle}">
        <div class="analysis-header">
          <span class="status-dot status-${a.status === 'normal' ? 'active' : a.status === 'anomaly' ? 'development' : 'inactive'}" style="${a.status === 'critical' ? 'background:#f85149;box-shadow:0 0 6px #f8514966' : ''}"></span>
          <span style="font-weight:600;color:#f0f6fc">${timeStr}</span>
          <span class="badge badge-${a.type}">${a.type}</span>
          <span class="badge badge-${a.status}">${a.status}</span>
        </div>
        ${a.summary ? `<div style="font-size:14px;color:#c9d1d9;margin-bottom:4px">${escapeHtml(a.summary)}</div>` : ''}
        ${anomalyHtml}
        ${a.recommendations && a.recommendations.length > 0 ? `<div style="margin-top:6px;font-size:12px;color:#8b949e">${a.recommendations.map(r => `💡 ${escapeHtml(r)}`).join('<br>')}</div>` : ''}
        <a class="detail-toggle" onclick="var el=document.getElementById('${detailId}');el.style.display=el.style.display==='block'?'none':'block'">Pokaż prompt/odpowiedź AI ▾</a>
        <div class="detail-content" id="${detailId}"><strong>PROMPT:</strong>\n${escapeHtml(a.prompt || '(brak)')}\n\n<strong>ODPOWIEDŹ AI:</strong>\n${escapeHtml(a.rawResponse || '(brak)')}</div>
      </div>`;
    }).join('');

  const body = `
  <div class="container">
    <header>
      <div class="header-left">
        <h1>Integration Hub</h1>
        <nav class="tab-nav"><a href="/dashboard" class="tab">Integracje</a><a href="/dashboard/monitoring" class="tab tab-active">Monitoring</a></nav>
      </div>
      <form method="POST" action="/dashboard/logout" style="display:inline">
        <input type="hidden" name="_csrf" value="${csrfToken ?? ''}">
        <button type="submit" class="logout-btn">Wyloguj</button>
      </form>
    </header>
    ${statsHtml}
    ${sparklineHtml}
    ${integrationCards ? `<div class="section-card"><div class="section-title">Integracje (ostatnia godzina)</div>${integrationCards}</div>` : ''}
    <div class="section-card">
      <div class="section-title">Analizy AI</div>
      ${analysesHtml}
    </div>
    <footer>custom-integration-hub.velocy.co</footer>
  </div>
  ${highlightAnalysis ? `<script>document.getElementById('analysis-${escapeHtml(highlightAnalysis)}')?.scrollIntoView({behavior:'smooth',block:'center'})</script>` : ''}`;

  return pageShell('Monitoring', body);
}

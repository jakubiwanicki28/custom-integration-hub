import { Router, type Request, type Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { config } from './config.js';
import { getAllIntegrations, type IntegrationEntry } from './lib/registry.js';
import * as cloudtalk from './lib/cloudtalk.js';
import { processCallManual, type ProcessResult } from './integrations/cloudtalk-call-notes/handler.js';
import * as attio from './lib/attio.js';
import * as slack from './lib/slack.js';
import { processLeadManual, LIST_CHANNEL_MAP } from './integrations/slack-lead-notifications/handler.js';

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
  if (Date.now() < entry.lockedUntil) return true;
  return false;
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

// --- Cookie Auth ---

function signToken(timestamp: number): string {
  const hmac = createHmac('sha256', config.dashboard.cookieSecret)
    .update(String(timestamp))
    .digest('hex');
  return `${timestamp}.${hmac}`;
}

function verifyToken(token: string): boolean {
  const dot = token.indexOf('.');
  if (dot === -1) return false;

  const timestamp = parseInt(token.slice(0, dot), 10);
  const signature = token.slice(dot + 1);

  if (isNaN(timestamp)) return false;

  // Check expiry (7 days)
  const age = Date.now() - timestamp;
  if (age > 7 * 24 * 60 * 60 * 1000 || age < 0) return false;

  const expected = createHmac('sha256', config.dashboard.cookieSecret)
    .update(String(timestamp))
    .digest('hex');

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
  if (!token) return false;
  return verifyToken(token);
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

  if (isAuthenticated(req)) {
    const data = {
      uptime: process.uptime(),
      integrations: getAllIntegrations(),
    };
    res.send(renderDashboardPage(data));
  } else {
    res.send(renderLoginPage());
  }
});

dashboardRouter.post('/login', (req: Request, res: Response) => {
  if (!config.dashboard.password) {
    res.status(503).send('Dashboard not configured');
    return;
  }

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

  const token = signToken(Date.now());
  res.cookie('dashboard_session', token, {
    httpOnly: true,
    secure: !config.isDev,
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/dashboard',
  });

  res.redirect(303, '/dashboard');
});

dashboardRouter.post('/logout', (_req: Request, res: Response) => {
  res.clearCookie('dashboard_session', { path: '/dashboard' });
  res.redirect(303, '/dashboard');
});

// --- Test Panel: CloudTalk Call Notes ---

dashboardRouter.get('/test/cloudtalk-call-notes', async (req: Request, res: Response) => {
  if (!isAuthenticated(req)) { res.redirect('/dashboard'); return; }

  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
  const result = req.query.result as string | undefined;
  const callsPage = await cloudtalk.getRecentCalls(5, page);

  res.send(renderTestPanel(callsPage.calls, callsPage.currentPage, callsPage.totalPages, result));
});

dashboardRouter.post('/test/cloudtalk-call-notes/process', async (req: Request, res: Response) => {
  if (!isAuthenticated(req)) { res.redirect('/dashboard'); return; }

  const callId = req.body?.call_id;
  if (!callId) {
    res.redirect('/dashboard/test/cloudtalk-call-notes?result=' + encodeURIComponent('error:Brak call_id'));
    return;
  }

  const result = await processCallManual(callId);

  let msg: string;
  if (result.success) {
    msg = `ok:${result.personName ?? '?'} | ${result.dealName ?? 'brak deala'} | ${result.notesCreated ?? 0} notatek`;
  } else {
    msg = `error:${result.error ?? 'Nieznany błąd'}`;
  }

  res.redirect('/dashboard/test/cloudtalk-call-notes?result=' + encodeURIComponent(msg));
});

// --- Test Panel: Slack Lead Notifications ---

interface LeadEntry {
  dealRecordId: string;
  listId: string;
  listName: string;
  dealName: string;
  personName: string;
  stage: string;
  createdAt: string;
}

async function enrichListEntries(listId: string, listName: string): Promise<LeadEntry[]> {
  const entries = await attio.queryListEntries(listId, 5);
  const enriched: LeadEntry[] = [];

  await Promise.all(entries.map(async (entry) => {
    const deal = await attio.getDealDetails(entry.parent_record_id);
    if (!deal) return;

    const dealName = attio.getDealName(deal);
    const stage = attio.getDealStage(deal);

    const associatedPeople = deal.values.associated_people as Array<{ target_record_id: string }> | undefined;
    const firstPersonId = associatedPeople?.[0]?.target_record_id;
    let personName = 'Brak osoby';
    if (firstPersonId) {
      const person = await attio.getPersonDetails(firstPersonId);
      if (person) personName = attio.getPersonName(person);
    }

    enriched.push({
      dealRecordId: entry.parent_record_id,
      listId,
      listName,
      dealName,
      personName,
      stage,
      createdAt: entry.created_at,
    });
  }));

  // Sort by createdAt desc (Promise.all doesn't preserve order)
  enriched.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return enriched;
}

dashboardRouter.get('/test/slack-lead-notifications', async (req: Request, res: Response) => {
  if (!isAuthenticated(req)) { res.redirect('/dashboard'); return; }

  const result = req.query.result as string | undefined;

  let akademiaEntries: LeadEntry[] = [];
  let raportEntries: LeadEntry[] = [];
  let loadError = '';

  try {
    [akademiaEntries, raportEntries] = await Promise.all([
      enrichListEntries('a87fbbdf-8cab-4630-a3cc-9f5756dc944a', 'Akademia Biznesu'),
      enrichListEntries('2e7cb019-4c0e-45c9-8998-c58590a733ef', 'Raport Strategiczny'),
    ]);
  } catch (err) {
    loadError = err instanceof Error ? err.message : 'Błąd ładowania danych z Attio';
  }

  // Fetch webhooks to show status
  let webhooks: attio.AttioWebhook[] = [];
  try {
    webhooks = await attio.listWebhooks();
  } catch { /* ignore */ }

  const ourWebhooks = webhooks.filter(w =>
    w.target_url.includes('slack-lead-notifications')
  );

  res.send(renderSlackLeadPanel(akademiaEntries, raportEntries, ourWebhooks, result, loadError));
});

dashboardRouter.post('/test/slack-lead-notifications/send', async (req: Request, res: Response) => {
  if (!isAuthenticated(req)) { res.redirect('/dashboard'); return; }

  const dealRecordId = req.body?.deal_record_id;
  const listId = req.body?.list_id;

  if (!dealRecordId || !listId) {
    res.redirect('/dashboard/test/slack-lead-notifications?result=' + encodeURIComponent('error:Brak deal_record_id lub list_id'));
    return;
  }

  const result = await processLeadManual(dealRecordId, listId);

  let msg: string;
  if (result.success) {
    msg = `ok:${result.personName ?? '?'} | ${result.dealName ?? '?'} | ${result.slackChannel ?? '?'}`;
  } else {
    msg = `error:${result.error ?? 'Nieznany błąd'}`;
  }

  res.redirect('/dashboard/test/slack-lead-notifications?result=' + encodeURIComponent(msg));
});

dashboardRouter.post('/test/slack-lead-notifications/test-slack', async (req: Request, res: Response) => {
  if (!isAuthenticated(req)) { res.redirect('/dashboard'); return; }

  const result = await slack.testConnection();

  const msg = result.ok
    ? `ok:Połączono ze Slackiem (workspace: ${result.team ?? '?'})`
    : `error:Błąd połączenia: ${result.error ?? 'Nieznany'}`;

  res.redirect('/dashboard/test/slack-lead-notifications?result=' + encodeURIComponent(msg));
});

dashboardRouter.post('/test/slack-lead-notifications/register-webhooks', async (req: Request, res: Response) => {
  if (!isAuthenticated(req)) { res.redirect('/dashboard'); return; }

  const targetUrl = 'https://custom-integration-hub.velocy.co/slack-lead-notifications/webhook';
  const listIds = Array.from(LIST_CHANNEL_MAP.keys());

  const result = await attio.registerWebhook(targetUrl, [
    {
      event_type: 'list-entry.created',
      filter: {
        $or: listIds.map(id => ({
          field: 'id.list_id',
          operator: 'equals',
          value: id,
        })),
      },
    },
  ]);

  if (!result) {
    res.redirect('/dashboard/test/slack-lead-notifications?result=' + encodeURIComponent('error:Nie udało się zarejestrować webhooka w Attio'));
    return;
  }

  const msg = `ok:Webhook zarejestrowany! ID: ${result.webhookId}. Secret: ${result.secret} — dodaj jako ATTIO_WEBHOOK_SECRET do .env`;
  res.redirect('/dashboard/test/slack-lead-notifications?result=' + encodeURIComponent(msg));
});

dashboardRouter.post('/test/slack-lead-notifications/delete-webhook', async (req: Request, res: Response) => {
  if (!isAuthenticated(req)) { res.redirect('/dashboard'); return; }

  const webhookId = req.body?.webhook_id;
  if (!webhookId) {
    res.redirect('/dashboard/test/slack-lead-notifications?result=' + encodeURIComponent('error:Brak webhook_id'));
    return;
  }

  const deleted = await attio.deleteWebhook(webhookId);
  const msg = deleted
    ? `ok:Webhook ${webhookId} usunięty`
    : `error:Nie udało się usunąć webhooka ${webhookId}`;

  res.redirect('/dashboard/test/slack-lead-notifications?result=' + encodeURIComponent(msg));
});

// --- HTML Rendering ---

function renderLoginPage(error?: string): string {
  return `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Login — Integration Hub</title>
  <link rel="icon" href="data:,">
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

function renderDashboardPage(data: { uptime: number; integrations: IntegrationEntry[] }): string {
  const uptime = formatUptime(data.uptime);
  const active = data.integrations.filter(i => i.status === 'active').length;
  const dev = data.integrations.filter(i => i.status === 'development').length;
  const inactive = data.integrations.filter(i => i.status === 'inactive').length;

  const integrationCards = data.integrations.map(i => `
    <div class="integration-card">
      <div class="card-header">
        <span class="status-dot status-${i.status}"></span>
        <span class="integration-name">${escapeHtml(i.name)}</span>
        <span class="badge badge-${i.type}">${i.type}</span>
      </div>
      <div class="description">${escapeHtml(i.description)}</div>
      <div class="meta">
        <div class="meta-row">
          <span class="meta-label">Path</span>
          <code>${escapeHtml(i.path)}</code>
        </div>
        <div class="meta-row">
          <span class="meta-label">Status</span>
          <span class="status-text status-text-${i.status}">${i.status}</span>
        </div>
        <div class="meta-row">
          <span class="meta-label">Dodano</span>
          <span>${escapeHtml(i.addedAt)}</span>
        </div>
      </div>
      <div class="tags">
        ${i.triggers.map(t => `<span class="tag tag-trigger">${escapeHtml(t)}</span>`).join('')}
        ${i.targets.map(t => `<span class="tag tag-target">${escapeHtml(t)}</span>`).join('')}
      </div>
      <div style="margin-top:12px">
        <a href="/dashboard/test/${escapeHtml(i.id)}" style="color:#58a6ff;font-size:13px;text-decoration:none">Testuj &rarr;</a>
      </div>
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dashboard — Integration Hub</title>
  <link rel="icon" href="data:,">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; min-height: 100vh; padding: 24px; }
    .container { max-width: 900px; margin: 0 auto; }
    header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; }
    h1 { font-size: 22px; font-weight: 600; color: #f0f6fc; }
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
    .badge { font-size: 11px; padding: 2px 8px; border-radius: 12px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.3px; }
    .badge-webhook { background: #1f6feb33; color: #58a6ff; }
    .badge-cron { background: #8957e533; color: #bc8cff; }
    .badge-hybrid { background: #d2992233; color: #d29922; }
    .description { font-size: 14px; color: #8b949e; margin-bottom: 12px; }
    .meta { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
    .meta-row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
    .meta-label { color: #484f58; min-width: 60px; }
    code { font-family: 'SF Mono', 'Fira Code', Consolas, monospace; font-size: 12px; background: #0d1117; padding: 2px 6px; border-radius: 4px; color: #79c0ff; }
    .status-text { font-weight: 500; }
    .status-text-active { color: #3fb950; }
    .status-text-development { color: #d29922; }
    .status-text-inactive { color: #484f58; }
    .tags { display: flex; gap: 6px; flex-wrap: wrap; }
    .tag { font-size: 11px; padding: 3px 10px; border-radius: 12px; }
    .tag-trigger { background: #3fb95020; color: #3fb950; border: 1px solid #3fb95040; }
    .tag-target { background: #58a6ff20; color: #58a6ff; border: 1px solid #58a6ff40; }
    footer { text-align: center; padding: 24px 0 8px; font-size: 12px; color: #30363d; }
    @media (max-width: 600px) {
      body { padding: 16px; }
      .stat { min-width: 100%; }
      .stats { flex-direction: column; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Integration Hub</h1>
      <form method="POST" action="/dashboard/logout" style="display:inline">
        <button type="submit" class="logout-btn">Wyloguj</button>
      </form>
    </header>

    <div class="stats">
      <div class="stat">
        <div class="stat-value">${uptime}</div>
        <div class="stat-label">Uptime</div>
      </div>
      <div class="stat">
        <div class="stat-value" style="color:#3fb950">${active}</div>
        <div class="stat-label">Aktywne</div>
      </div>
      <div class="stat">
        <div class="stat-value" style="color:#d29922">${dev}</div>
        <div class="stat-label">Development</div>
      </div>
      <div class="stat">
        <div class="stat-value" style="color:#484f58">${inactive}</div>
        <div class="stat-label">Nieaktywne</div>
      </div>
    </div>

    ${integrationCards}

    <footer>custom-integration-hub.velocy.co</footer>
  </div>
</body>
</html>`;
}

function renderTestPanel(calls: cloudtalk.CloudTalkCall[], currentPage: number, totalPages: number, resultParam?: string): string {
  let flashHtml = '';
  if (resultParam) {
    const isError = resultParam.startsWith('error:');
    const message = resultParam.replace(/^(ok|error):/, '');
    flashHtml = `<div class="flash ${isError ? 'flash-error' : 'flash-ok'}">${isError ? 'Błąd: ' : 'Sukces: '}${escapeHtml(message)}</div>`;
  }

  const rows = calls.map(c => {
    const date = new Date(c.startedAt);
    const dateStr = date.toLocaleDateString('pl-PL') + ' ' + date.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
    const dir = c.type === 'outgoing' ? 'Wych.' : c.type === 'incoming' ? 'Przych.' : 'Wewn.';
    const dur = c.duration >= 60 ? `${Math.floor(c.duration / 60)}m ${c.duration % 60}s` : `${c.duration}s`;
    return `
      <tr>
        <td>${dateStr}</td>
        <td><code>${escapeHtml(c.externalNumber)}</code></td>
        <td>${dir}</td>
        <td>${dur}</td>
        <td>${escapeHtml(c.agentName)}</td>
        <td>${c.recorded ? '<span style="color:#3fb950">Tak</span>' : '<span style="color:#484f58">Nie</span>'}</td>
        <td>
          <form method="POST" action="/dashboard/test/cloudtalk-call-notes/process" style="display:inline">
            <input type="hidden" name="call_id" value="${c.id}">
            <button type="submit" class="btn-process">Przetwórz</button>
          </form>
        </td>
      </tr>`;
  }).join('');

  const paginationItems: string[] = [];
  if (currentPage > 1) {
    paginationItems.push(`<a href="/dashboard/test/cloudtalk-call-notes?page=${currentPage - 1}" class="page-link">&larr; Poprzednia</a>`);
  }
  paginationItems.push(`<span class="page-info">Strona ${currentPage} z ${totalPages}</span>`);
  if (currentPage < totalPages) {
    paginationItems.push(`<a href="/dashboard/test/cloudtalk-call-notes?page=${currentPage + 1}" class="page-link">Następna &rarr;</a>`);
  }

  return `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Test: CloudTalk Call Notes — Integration Hub</title>
  <link rel="icon" href="data:,">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; min-height: 100vh; padding: 24px; }
    .container { max-width: 1000px; margin: 0 auto; }
    header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; }
    h1 { font-size: 22px; font-weight: 600; color: #f0f6fc; }
    .back-link { color: #58a6ff; text-decoration: none; font-size: 14px; }
    .back-link:hover { text-decoration: underline; }
    .flash { padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 14px; }
    .flash-ok { background: #23863633; border: 1px solid #238636; color: #3fb950; }
    .flash-error { background: #da363433; border: 1px solid #da3634; color: #f85149; }
    table { width: 100%; border-collapse: collapse; background: #161b22; border: 1px solid #30363d; border-radius: 10px; overflow: hidden; }
    th { background: #1c2129; text-align: left; padding: 10px 12px; font-size: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
    td { padding: 10px 12px; border-top: 1px solid #21262d; font-size: 13px; }
    tr:hover td { background: #1c2129; }
    code { font-family: 'SF Mono', Consolas, monospace; font-size: 12px; color: #79c0ff; }
    .btn-process { background: #1f6feb; color: #fff; border: none; padding: 5px 14px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; }
    .btn-process:hover { background: #388bfd; }
    .pagination { display: flex; align-items: center; justify-content: center; gap: 16px; margin-top: 16px; }
    .page-link { color: #58a6ff; text-decoration: none; font-size: 14px; padding: 6px 12px; border: 1px solid #30363d; border-radius: 6px; }
    .page-link:hover { border-color: #58a6ff; }
    .page-info { font-size: 13px; color: #8b949e; }
    footer { text-align: center; padding: 24px 0 8px; font-size: 12px; color: #30363d; }
    @media (max-width: 700px) {
      table { font-size: 12px; }
      th, td { padding: 8px 6px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <a href="/dashboard" class="back-link">&larr; Dashboard</a>
        <h1 style="margin-top:8px">Test: CloudTalk Call Notes</h1>
      </div>
    </header>

    ${flashHtml}

    <table>
      <thead>
        <tr>
          <th>Data</th>
          <th>Numer</th>
          <th>Kierunek</th>
          <th>Czas</th>
          <th>Agent</th>
          <th>Nagranie</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${rows || '<tr><td colspan="7" style="text-align:center;color:#484f58;padding:20px">Brak rozmów</td></tr>'}
      </tbody>
    </table>

    <div class="pagination">
      ${paginationItems.join('')}
    </div>

    <footer>custom-integration-hub.velocy.co</footer>
  </div>
</body>
</html>`;
}

function renderSlackLeadPanel(
  akademiaEntries: LeadEntry[],
  raportEntries: LeadEntry[],
  webhooks: attio.AttioWebhook[],
  resultParam?: string,
  loadError?: string,
): string {
  let flashHtml = '';
  if (resultParam) {
    const isError = resultParam.startsWith('error:');
    const message = resultParam.replace(/^(ok|error):/, '');
    flashHtml = `<div class="flash ${isError ? 'flash-error' : 'flash-ok'}">${isError ? 'Błąd: ' : 'Sukces: '}${escapeHtml(message)}</div>`;
  }
  if (loadError) {
    flashHtml += `<div class="flash flash-error">Błąd ładowania: ${escapeHtml(loadError)}</div>`;
  }

  function renderEntryRows(entries: LeadEntry[]): string {
    if (entries.length === 0) {
      return '<tr><td colspan="5" style="text-align:center;color:#484f58;padding:20px">Brak wpisów</td></tr>';
    }
    return entries.map(e => {
      const date = new Date(e.createdAt);
      const dateStr = date.toLocaleDateString('pl-PL') + ' ' + date.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
      return `
        <tr>
          <td>${dateStr}</td>
          <td>${escapeHtml(e.dealName)}</td>
          <td>${escapeHtml(e.personName)}</td>
          <td>${escapeHtml(e.stage)}</td>
          <td>
            <form method="POST" action="/dashboard/test/slack-lead-notifications/send" style="display:inline">
              <input type="hidden" name="deal_record_id" value="${escapeHtml(e.dealRecordId)}">
              <input type="hidden" name="list_id" value="${escapeHtml(e.listId)}">
              <button type="submit" class="btn-process">Wyślij na Slacka</button>
            </form>
          </td>
        </tr>`;
    }).join('');
  }

  const webhookRows = webhooks.length > 0
    ? webhooks.map(w => `
        <div class="webhook-row">
          <span class="webhook-status webhook-status-${w.status}">${w.status}</span>
          <code>${escapeHtml(w.id.webhook_id.slice(0, 8))}...</code>
          <span style="color:#8b949e;font-size:12px">${w.subscriptions.map(s => s.event_type).join(', ')}</span>
          <form method="POST" action="/dashboard/test/slack-lead-notifications/delete-webhook" style="display:inline;margin-left:8px">
            <input type="hidden" name="webhook_id" value="${escapeHtml(w.id.webhook_id)}">
            <button type="submit" class="btn-delete">Usuń</button>
          </form>
        </div>`).join('')
    : '<div style="color:#484f58;font-size:13px;padding:8px 0">Brak zarejestrowanych webhooków</div>';

  return `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Test: Slack Lead Notifications — Integration Hub</title>
  <link rel="icon" href="data:,">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; min-height: 100vh; padding: 24px; }
    .container { max-width: 1000px; margin: 0 auto; }
    header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; }
    h1 { font-size: 22px; font-weight: 600; color: #f0f6fc; }
    h2 { font-size: 16px; font-weight: 600; color: #f0f6fc; margin: 24px 0 12px; }
    .back-link { color: #58a6ff; text-decoration: none; font-size: 14px; }
    .back-link:hover { text-decoration: underline; }
    .flash { padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 14px; word-break: break-all; }
    .flash-ok { background: #23863633; border: 1px solid #238636; color: #3fb950; }
    .flash-error { background: #da363433; border: 1px solid #da3634; color: #f85149; }
    .tools { display: flex; gap: 10px; margin-bottom: 24px; flex-wrap: wrap; }
    .btn-tool { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; padding: 8px 16px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; }
    .btn-tool:hover { border-color: #58a6ff; color: #58a6ff; }
    .section-card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
    .section-title { font-size: 14px; font-weight: 600; color: #f0f6fc; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
    .channel-tag { font-size: 11px; padding: 2px 8px; border-radius: 12px; background: #58a6ff20; color: #58a6ff; border: 1px solid #58a6ff40; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; padding: 8px 10px; font-size: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; border-bottom: 1px solid #21262d; }
    td { padding: 8px 10px; border-top: 1px solid #21262d; font-size: 13px; }
    tr:hover td { background: #1c2129; }
    code { font-family: 'SF Mono', Consolas, monospace; font-size: 12px; color: #79c0ff; background: #0d1117; padding: 2px 6px; border-radius: 4px; }
    .btn-process { background: #1f6feb; color: #fff; border: none; padding: 5px 14px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; }
    .btn-process:hover { background: #388bfd; }
    .btn-delete { background: none; color: #f85149; border: 1px solid #da363466; padding: 3px 10px; border-radius: 6px; font-size: 11px; cursor: pointer; }
    .btn-delete:hover { border-color: #f85149; background: #da363420; }
    .webhook-row { display: flex; align-items: center; gap: 10px; padding: 6px 0; font-size: 13px; }
    .webhook-status { font-size: 11px; padding: 2px 8px; border-radius: 12px; font-weight: 500; }
    .webhook-status-active { background: #3fb95020; color: #3fb950; }
    .webhook-status-degraded { background: #d2992220; color: #d29922; }
    .webhook-status-inactive { background: #484f5820; color: #484f58; }
    footer { text-align: center; padding: 24px 0 8px; font-size: 12px; color: #30363d; }
    @media (max-width: 700px) {
      table { font-size: 12px; }
      th, td { padding: 6px 4px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <a href="/dashboard" class="back-link">&larr; Dashboard</a>
        <h1 style="margin-top:8px">Test: Slack Lead Notifications</h1>
      </div>
    </header>

    ${flashHtml}

    <div class="tools">
      <form method="POST" action="/dashboard/test/slack-lead-notifications/test-slack" style="display:inline">
        <button type="submit" class="btn-tool">Testuj Slack</button>
      </form>
      <form method="POST" action="/dashboard/test/slack-lead-notifications/register-webhooks" style="display:inline">
        <button type="submit" class="btn-tool">Zarejestruj webhooks w Attio</button>
      </form>
    </div>

    <div class="section-card">
      <div class="section-title">Webhooks Attio</div>
      ${webhookRows}
    </div>

    <div class="section-card">
      <div class="section-title">
        Kampania: Akademia Biznesu
        <span class="channel-tag">#nowe-leady-akademia</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Data</th>
            <th>Deal</th>
            <th>Osoba</th>
            <th>Etap</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${renderEntryRows(akademiaEntries)}
        </tbody>
      </table>
    </div>

    <div class="section-card">
      <div class="section-title">
        Kampania: Raport Strategiczny
        <span class="channel-tag">#nowe-leady-raport</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Data</th>
            <th>Deal</th>
            <th>Osoba</th>
            <th>Etap</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${renderEntryRows(raportEntries)}
        </tbody>
      </table>
    </div>

    <footer>custom-integration-hub.velocy.co</footer>
  </div>
</body>
</html>`;
}

// --- Helpers ---

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

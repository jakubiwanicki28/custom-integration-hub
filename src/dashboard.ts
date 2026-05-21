import { Router, type Request, type Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { config } from './config.js';
import { getAllIntegrations, type IntegrationEntry } from './lib/registry.js';

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

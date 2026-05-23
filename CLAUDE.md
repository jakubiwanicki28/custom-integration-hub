# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Custom Integration Hub — coded automations deployed on a VPS, replacing n8n. Each integration is a module under `src/integrations/`. All integrations are registered in `integrations.json`.

## Commands

```bash
npm run dev          # Start dev server with hot-reload (tsx watch)
npm run build        # Compile TypeScript to dist/ (uses npx tsc)
npm run start        # Run compiled server (production)
npm run typecheck    # Type-check without emitting
```

## Branches

- **main**: production-ready code, auto-deployed to VPS via `deploy/autodeploy.sh`
- **dev**: active development branch; PRs target `main`

## Architecture

```
src/
  server.ts                          # Express app, loads registry, mounts routes, starts pollers
  config.ts                          # Env validation — fails fast if required vars missing
  dashboard.ts                       # Admin dashboard (SSR HTML, auth, rate limiting, test panels)
  lib/
    logger.ts                        # Pino logger (pretty in dev, JSON in prod)
    registry.ts                      # Reads integrations.json, dynamic imports
    fetch.ts                         # fetchWithTimeout wrapper (30s default, AbortController)
    attio.ts                         # Attio CRM API client
    cloudtalk.ts                     # CloudTalk API client
    openrouter.ts                    # OpenRouter AI API client
    slack.ts                         # Slack API client (Block Kit)
  integrations/
    cloudtalk-call-notes/            # AI call notes: CloudTalk → OpenRouter → Attio
      index.ts                       # Exports { router, startPoller }
      routes.ts                      # POST /webhook
      handler.ts                     # Pipeline + processCallManual for testing
      transcribe.ts                  # Download recording → OpenRouter transcription
      summarize.ts                   # Format note content with recording link
      poller.ts                      # Polls CloudTalk API every 2 min for new calls
      types.ts                       # CloudTalkWebhookPayload, ProcessedNote
    slack-lead-notifications/        # New lead alerts: Attio webhook → Slack
      index.ts                       # Exports { router }
      routes.ts                      # POST /webhook
      handler.ts                     # Pipeline + processLeadManual for testing
      types.ts                       # AttioWebhookPayload, LeadNotificationData
```

### How the Server Boots

```
server.ts bootstrap():
  1. loadRegistry()           → reads integrations.json into memory
  2. mount /dashboard         → admin panel (password-protected)
  3. mount /health            → public JSON status endpoint
  4. for each integration where status === "active":
       dynamic import(entry.module)
       app.use(entry.path, mod.router)
  5. start pollers (cloudtalk-call-notes poller if active)
  6. mount global error handler
  7. app.listen(3100)
  8. register SIGTERM handler (graceful shutdown, 30s timeout)
```

### Integration Registry (`integrations.json`)

Central source of truth. Server reads it at startup, mounts only `status: "active"` integrations. Health endpoint (`GET /health`) and dashboard both read from this registry.

Statuses: `active` | `inactive` | `development`

Types: `webhook` | `cron` | `hybrid`

### Adding a New Integration

1. Create folder `src/integrations/[name]/` with `index.ts`, `routes.ts`, `handler.ts`, `types.ts`
2. `index.ts` must export `{ router }` (Express Router)
3. Add entry to `integrations.json` with `status: "development"`
4. Implement `handler.ts` — follow respond-immediately-process-async pattern
5. Export a `process[X]Manual()` function for test panel
6. Add test panel routes in `src/dashboard.ts` under `/dashboard/test/[id]`
7. Test locally via dashboard test panel
8. Set to `"active"` when ready
9. If new external service needed, add client to `src/lib/`
10. If new env vars needed, add to both `config.ts` and `.env.example`

### URL Pattern

`https://custom-integration-hub.velocy.co/[integration-name]/[endpoint]`

### Admin Dashboard

`GET /dashboard` — password-protected status page. Set `DASHBOARD_PASSWORD` in `.env`.

Features:
- Integration status overview (active/development/inactive counts, uptime)
- Per-integration card with triggers, targets, status, path
- "Testuj →" link per integration to test panel
- Test panels: list source data, manually trigger pipeline, see results
- Rate-limited login (5 attempts/min, 15 min lockout)
- Session via signed HttpOnly cookie (7 days)
- Dark theme, responsive

### Notes in Attio CRM

When creating notes, always create TWO: one on the **Person** and one on the **Deal**. Person note title includes deal name for context. If no deal found, create only the Person note. Include recording link if available. See `docs/attio-crm-map.md` for API details.

---

## Existing Integrations

### 1. CloudTalk Call Notes (`cloudtalk-call-notes`)

**Type:** hybrid (webhook + polling)
**Trigger:** CloudTalk call ends → poller picks it up every 2 min (also accepts direct webhook POST)
**Path:** `/cloudtalk-call-notes`

**Pipeline:**
1. New call detected (via poller or webhook)
2. Skip if duration < 30s
3. Find Person in Attio by phone number (3 format variants, email fallback)
4. Find best Deal (active > closed, newest first)
5. Download WAV recording from CloudTalk
6. Send audio to OpenRouter (Gemini) → Polish transcription + summary in one pass
7. Format markdown note with: AI summary, call details, clickable recording link
8. Create note on Person (title: `"Rozmowa — {Deal} — {date}"`)
9. Create note on Deal (title: `"Rozmowa — {date}"`)

**Poller:** Runs every 2 min, checks CloudTalk API with `date_from` filter. 5-min lookback on startup. Idempotency via in-memory Map (1h TTL).

**Test panel:** `/dashboard/test/cloudtalk-call-notes` — paginated call list (5/page), "Przetwórz" button per call.

**Key files:**
- `handler.ts` — `webhookHandler()` (async) + `processCallManual()` (returns result)
- `transcribe.ts` — 5s wait + 15s retry for recording availability
- `summarize.ts` — formatNote() with recording link
- `poller.ts` — `startPoller()`, called from server.ts

### 2. Slack Lead Notifications (`slack-lead-notifications`)

**Type:** webhook
**Trigger:** Attio webhook fires when new entry added to campaign list
**Path:** `/slack-lead-notifications`

**Pipeline:**
1. Receive Attio webhook (`list-entry.created` event)
2. Verify HMAC signature (if `ATTIO_WEBHOOK_SECRET` configured)
3. Fetch deal details → fetch associated person
4. Format Slack Block Kit message (person name, email, phone, "Open in Attio" button)
5. Post to mapped Slack channel based on list ID

**List → Channel mapping (hardcoded in handler.ts):**
- Kampania: Akademia Biznesu → `#nowe-leady-akademia`
- Kampania: Raport Strategiczny → `#nowe-leady-raport`

**Test panel:** `/dashboard/test/slack-lead-notifications` — lists recent entries from both campaigns, manual send button, Slack connection test, webhook registration/deletion UI.

---

## External Services

- **Attio CRM** — primary CRM. Schema in `docs/attio-crm-map.md`. Objects: People, Deals, Companies. Notes API (markdown). Webhook API for list-entry events. Auth: Bearer token.
- **CloudTalk** — call center. Recordings, call history. Auth: HTTP Basic (API_ID:API_KEY). API base: `https://my.cloudtalk.io/api`. No direct call ID lookup — batch fetch + filter.
- **OpenRouter** — AI gateway, OpenAI-compatible. Multimodal models for audio transcription. Model configurable via `OPENROUTER_MODEL` env var (default: `google/gemini-2.5-flash-lite`). 120s timeout for audio processing.
- **Slack** — notifications via Bot token. Block Kit formatting. Auth: Bearer token (`xoxb-...`).

## Shared Library (`src/lib/`)

All API clients use `fetchWithTimeout()` from `src/lib/fetch.ts` (30s default, 120s for OpenRouter).

**Attio** (`attio.ts`): `findPersonByPhone`, `findPersonByEmail`, `getPersonDetails`, `getDealDetails`, `pickBestDeal`, `createNote`, `queryListEntries`, `registerWebhook`, `listWebhooks`, `deleteWebhook`, plus helper extractors (`getPersonName`, `getPersonEmail`, `getPersonPhone`, `getDealName`, `getDealStage`).

**CloudTalk** (`cloudtalk.ts`): `getCallDetails` (batch fetch + find by ID), `getRecentCalls` (paginated), `getCallsSince` (date filter for poller), `downloadRecording` (WAV buffer).

**OpenRouter** (`openrouter.ts`): `transcribeAudio`, `summarizeTranscript`, `transcribeAndSummarize` (single-pass audio → transcript + summary). Polish-language system prompts.

**Slack** (`slack.ts`): `postMessage` (Block Kit blocks), `testConnection`.

**Logger** (`logger.ts`): `createLogger(name)` — child Pino logger per integration.

## Secrets

`.env` file (git-ignored). On VPS, created manually. Keep `.env.example` updated.

Required: `ATTIO_API_KEY`, `CLOUDTALK_API_ID`, `CLOUDTALK_API_KEY`, `OPENROUTER_API_KEY`
Optional: `SLACK_BOT_TOKEN`, `DASHBOARD_PASSWORD`, `DASHBOARD_SECRET`, `ATTIO_WEBHOOK_SECRET`, `WEBHOOK_SECRET`, `OPENROUTER_MODEL`, `PORT`, `NODE_ENV`

New env vars that are needed by active integrations should use `requireEnv()`. Optional vars (features that degrade gracefully) should use `process.env.X || ''`.

## Deployment

VPS: `187.127.88.41` / `custom-integration-hub.velocy.co`

**Auto-deploy:** `deploy/autodeploy.sh` polls GitHub `main` branch every 30s. On new commits: `git pull → npm install → npm run build → pm2 restart`. Managed by PM2 as `autodeploy` process.

**Manual deploy:**
```bash
# On VPS:
cd /home/srv/custom-integration-hub
git pull origin main
npm install && npm run build
pm2 restart custom-integration-hub
```

**Restart without rebuild** (e.g., after .env change):
```bash
pm2 restart custom-integration-hub
```

**PM2 processes:**
- `custom-integration-hub` — the Express server (cluster mode)
- `autodeploy` — GitHub polling script (fork mode)

PM2 config: `ecosystem.config.cjs`
Nginx config: `deploy/nginx.conf` (reverse proxy port 80 → 3100, SSL via certbot)

---

## Patterns to Follow

**Webhook handlers respond immediately, process async:**
```typescript
res.status(200).json({ status: 'accepted' });
process(payload).catch(err => log.error({ err }, 'fail'));
```

**Idempotency for webhooks:**
In-memory Map with TTL. Check before processing, mark immediately, cleanup on interval with `.unref()`.

**Attio notes always on Person AND Deal:**
Person note title: `"Action — {Deal Name} — {YYYY-MM-DD}"`. Deal note title: `"Action — {YYYY-MM-DD}"`. If no deal, Person only.

**Every integration must have a test panel:**
Export `process[X]Manual()` returning `{ success, error?, ...details }`. Dashboard test page at `/dashboard/test/[id]` lists source data and allows manual triggering.

**Use fetchWithTimeout for all external API calls:**
Import from `src/lib/fetch.ts`. Default 30s, use 120s for slow operations (AI audio processing).

**Error handling — log and continue:**
Wrap async pipelines in try/catch. Never let one integration crash the server. All intervals must use `.unref()`.

**Use existing API clients:**
Check `src/lib/` before making raw fetch calls. Add new functions to existing client files.

**New external service = new client in `src/lib/`:**
Follow the pattern: config from `config.ts`, typed interfaces, exported async functions, child logger.

**New env vars in both `.env.example` and `config.ts`.**

## CRM Reference

See `docs/attio-crm-map.md` for the complete Attio CRM schema including all objects, attributes, API slugs, list structures with stage statuses and IDs, Notes API format, relationship graph, and key IDs.

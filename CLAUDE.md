# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## CRITICAL: Git Workflow

**DO NOT create feature branches.** Multiple agents work on this codebase simultaneously — feature branches cause conflicts and confusion. All work happens on `dev`. When ready, merge `dev` → `main` and push both. The VPS auto-deploys from `main` via `deploy/autodeploy.sh` (polls every 30s). Never push directly to `main` without merging from `dev` first.

## Project Philosophy

Custom Integration Hub — a centralized Express server that handles all business automation logic. Replaces n8n with code-based integrations deployed on a VPS.

**Core idea: landing pages are dumb, the hub is smart.** Landing pages (Next.js on Vercel) contain zero business logic — they only collect user input and POST it to the hub. All CRM operations, email list syncs, booking syncs, notifications, and data transformations happen here. This means:

- Adding a new LP or A/B variant requires no hub changes (just reuse existing endpoints)
- Business logic changes are deployed once (hub) and apply to all LPs
- LPs are interchangeable frontends — the hub is the single source of truth

The hub is **multi-tenant**: multiple organizations (clients) share the same server, each with isolated API keys, CRM workspaces, and integration configs.

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
  server.ts                          # Express app bootstrap: load orgs, mount routes, start pollers
  config.ts                          # Env validation, per-org credential loading (prefix-based)
  dashboard.ts                       # Admin dashboard (SSR HTML, auth, rate limiting, test panels)
  lib/
    logger.ts                        # Pino logger (pretty in dev, JSON in prod)
    registry.ts                      # Loads integrations.json + organizations.json, dynamic imports
    org-context.ts                   # OrgContext type: per-org clients, config, logger
    fetch.ts                         # fetchWithTimeout wrapper (30s default, AbortController)
    attio.ts                         # Attio CRM API client (factory: createAttioClient per org)
    cloudtalk.ts                     # CloudTalk API client
    openrouter.ts                    # OpenRouter AI API client
    slack.ts                         # Slack API client (Block Kit)
  integrations/
    cloudtalk-call-notes/            # AI call notes: CloudTalk → OpenRouter → Attio
    slack-lead-notifications/        # New lead alerts: Attio webhook → Slack
    lead-intake/                     # LP form → Attio CRM + Brevo email list
    calendly-booking-sync/           # Calendly booking → Attio deal status + date

organizations.json                   # Per-org config: which integrations, with what settings
integrations.json                    # Global integration catalog: metadata, module paths
```

### Multi-Organization Architecture

The hub serves multiple organizations (clients) from a single server. Each org is isolated:

**Two-layer registration:**

1. **`integrations.json`** (global catalog) — defines all available integrations: id, name, type, module path, required services. Shared across all orgs.
2. **`organizations.json`** (per-org config) — each org picks which integrations it uses, sets status (`active`/`development`/`inactive`), and provides org-specific config (campaign IDs, CORS origins, Calendly URIs, etc.).

**Env var namespacing:** Each org has an `envPrefix` (e.g., `WW`, `VELOCY`). Credentials are loaded as `{PREFIX}_ATTIO_API_KEY`, `{PREFIX}_SLACK_BOT_TOKEN`, etc. This keeps secrets isolated.

**Per-org client instances:** At startup, the server creates separate Attio/Slack/CloudTalk clients for each org, bound to their API keys. An integration for WW Partners can never accidentally access Velocy's CRM.

**URL pattern:** `https://custom-integration-hub.velocy.co/{orgId}/{integrationId}/{endpoint}`

Examples:
- `POST /ww-partners/lead-intake/` — lead form submission
- `POST /ww-partners/calendly-booking-sync/notify` — Calendly booking notification
- `POST /ww-partners/slack-lead-notifications/webhook` — Attio webhook for Slack alerts

### How the Server Boots

```
server.ts bootstrap():
  1. loadIntegrationCatalog()    → reads integrations.json (global catalog)
  2. loadOrganizations()         → reads organizations.json (per-org config)
  3. mount /dashboard            → admin panel (password-protected)
  4. mount /health               → public JSON status endpoint
  5. for each org:
       load credentials (env prefix)
       create API clients (attio, slack, cloudtalk)
       for each org integration where status !== "inactive":
         dynamic import(module)
         build OrgContext (clients + config + logger)
         app.use(/{orgId}/{integrationId}, router)
  6. start pollers (cloudtalk-call-notes if active)
  7. mount global error handler
  8. app.listen(3100)
  9. register SIGTERM handler (graceful shutdown, 30s timeout)
```

### Adding a New Integration

1. Create folder `src/integrations/[name]/` with `index.ts`, `routes.ts`, `handler.ts`, `types.ts`
2. `index.ts` must export `createIntegration(ctx: OrgContext)` returning `{ router }`
3. Add entry to `integrations.json` with module path and metadata
4. Add to relevant orgs in `organizations.json` with `status: "development"` and config
5. Implement `handler.ts` — follow respond-immediately-process-async pattern
6. Export a `process[X]Manual()` function for test panel
7. Add test panel routes in `src/dashboard.ts` under `/dashboard/test/[id]`
8. If new external service needed, add client to `src/lib/`
9. If new env vars needed, add to both `config.ts` and `.env.example` (with org prefix)
10. Set to `"active"` when production-ready

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

## Current Organizations

### WW Partners (`ww-partners`, env prefix: `WW`)
- **Attio workspace:** ww-partners
- **Integrations:** cloudtalk-call-notes (active), slack-lead-notifications (active), lead-intake (development), calendly-booking-sync (development)
- **Landing pages:** LP2-Akademia-Biznesu, wwp-lp-1, RAPORTLP (see Landing Pages section)

### Velocy (`velocy`, env prefix: `VELOCY`)
- **Attio workspace:** velocy-co
- **Integrations:** slack-lead-notifications (development)

---

## Landing Pages

Landing pages are separate projects deployed on Vercel. They live outside this repo, organized at `/Users/v/landing-pages/` by organization. LPs contain **no business logic** — they are forms + Calendly embeds that POST data to the hub.

```
/Users/v/landing-pages/
  ww-partners/
    lp-akademia-a/              # A/B variant A (akademiabiznesu.vercel.app)
    lp-akademia-b/              # A/B variant B (lp-2-akademia-biznesu.vercel.app)
    lp-raport/                  # Raport Strategiczny (raport-akademia.vercel.app)
  velocy/
    lp-service-a/               # A/B variant A (Velocy service LP)
    lp-service-b/               # A/B variant B (architekci)
    meta-ad-creatives/          # Static HTML/PNG ad creatives for Meta
```

### WW Partners Landing Pages

| Local folder | GitHub repo | Vercel URL | Campaign | Calendly? |
|---|---|---|---|---|
| `lp-akademia-a` | `Velocy-co/wwp-lp-1` | `akademiabiznesu.vercel.app` | `akademia` | Yes |
| `lp-akademia-b` | `Velocy-co/LP2-Akademia-Biznesu` | `lp-2-akademia-biznesu.vercel.app` | `akademia` | Yes |
| `lp-raport` | `Velocy-co/RAPORTLP` | `raport-akademia.vercel.app` | `raport` | No |

### Velocy Landing Pages

| Local folder | GitHub repo | Description |
|---|---|---|
| `lp-service-a` | `Velocy-co/LP-VELOCY.CO-A` | Service LP variant A |
| `lp-service-b` | `Velocy-co/LP-VELOCY.CO-B` | Service LP variant B (architekci) |

lp-akademia-a and lp-akademia-b are **A/B test variants** of the same Akademia Biznesu campaign — different layouts, identical data flow. lp-raport is a separate campaign (Raport Strategiczny) with no Calendly booking.

### LP → Hub Data Flow

```
User visits LP
    ↓
LeadCaptureModal (form: name, email, phone)
    ↓
POST /{orgId}/lead-intake { firstName, lastName, email, phone, campaign }
    ↓ (hub creates Person + Deal + List Entry in Attio, contact in Brevo)
    ↓ (hub fires Slack notification via Attio webhook)
    ↓
CalendlyBookingModal (embedded iframe: calendly.com/a-wykurz/30min)
    ↓ (user books consultation)
    ↓ (LP detects calendly.event_scheduled, extracts event URI)
    ↓ (4s delay)
POST /{orgId}/calendly-booking-sync/notify { email, eventUri }
    ↓ (hub fetches start_time from Calendly API via event URI)
    ↓ (hub updates deal: data_konsultacji + status → "Konsultacja umówiona")
```

### LP Integration Contract

When building a new LP that integrates with the hub:
- **Form submission:** POST to `/{orgId}/lead-intake/` with `{ firstName, lastName, email, phone, campaign }`
- **Calendly booking:** Listen for `calendly.event_scheduled` postMessage, extract `payload.event.uri`, POST to `/{orgId}/calendly-booking-sync/notify` with `{ email, eventUri }`
- **CORS:** LP's Vercel URL must be in `allowedOrigins` in both `lead-intake` and `calendly-booking-sync` configs in `organizations.json`
- **No business logic in the LP.** Don't query Attio, don't update CRM, don't decide deal stages. The hub does all of that.

---

## Existing Integrations

### 1. CloudTalk Call Notes (`cloudtalk-call-notes`)

**Type:** hybrid (webhook + polling)
**Trigger:** CloudTalk call ends → poller picks it up every 2 min (also accepts direct webhook POST)
**Path:** `/{orgId}/cloudtalk-call-notes`

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

### 2. Slack Lead Notifications (`slack-lead-notifications`)

**Type:** webhook
**Trigger:** Attio webhook fires when new entry added to campaign list
**Path:** `/{orgId}/slack-lead-notifications`

**Pipeline:**
1. Receive Attio webhook (`list-entry.created` event)
2. Verify HMAC signature (if `ATTIO_WEBHOOK_SECRET` configured)
3. Fetch deal details → fetch associated person
4. Format Slack Block Kit message (person name, email, phone, "Open in Attio" button)
5. Post to mapped Slack channel based on list ID

**List → Channel mapping (in organizations.json config per org):**
- WW Partners: Akademia Biznesu → `#nowe-leady-akademia`, Raport Strategiczny → `#nowe-leady-raport`

### 3. Lead Intake (`lead-intake`)

**Type:** webhook
**Trigger:** LP form submission (cross-origin POST)
**Path:** `/{orgId}/lead-intake`

**Pipeline:**
1. Validate input (email, phone, campaign, name)
2. Normalize phone to E.164 format (+48...)
3. Upsert Person in Attio (find by email, create if missing)
4. Create Deal (name: `"{dealPrefix} — {firstName} {lastName}"`, linked to person)
5. Add entry to campaign list (with initial stage status)
6. Send contact to Brevo email list (fire-and-forget, degrades gracefully if no API key)

**Campaign config** (per org in `organizations.json`): maps campaign slug (e.g., `"akademia"`) to list ID, status slug, initial stage ID, deal prefix, and Brevo list ID.

**Rate limiting:** 10 requests/IP/minute.

### 4. Calendly Booking Sync (`calendly-booking-sync`)

**Type:** webhook
**Trigger:** LP frontend notifies after user books Calendly consultation
**Path:** `/{orgId}/calendly-booking-sync`

**Endpoints:**
- `POST /webhook` — Calendly native webhook (signature-verified, for paid plans)
- `POST /notify` — LP frontend notification (CORS-protected, for free plan)

**Pipeline:**
1. Receive notification with `{ email, eventUri }`
2. Fetch booking `start_time` from Calendly API:
   - **Primary:** Direct event URI lookup (`GET /scheduled_events/{uuid}`) — instant, reliable
   - **Fallback:** Search by `invitee_email` with retry (10s initial wait, 3 retries with 10s/15s delays)
   - **Last resort:** Fetch recent events without email filter, match by `created_at` recency
3. If no `start_time` found → skip update, clear idempotency key (allow retry later)
4. Find Person in Attio by email → get associated deals
5. For each deal with campaign list entry:
   - Set `data_konsultacji` on deal
   - Update list entry status to "Konsultacja umówiona" + set `data_konsultacji`

**Calendly account:** The Calendly scheduling URL is `calendly.com/a-wykurz/30min` (user: Anna Wykurz, `a.wykurz@gmail.com`). The API token and `calendlyUserUri` in config MUST match this account. There is a separate `kontakt-wwpartners` Calendly account that is NOT used for LP bookings — do not confuse them.

**Idempotency:** Key = `notify:{email}` with 1h TTL. Cleared if booking time not found (allows retry).

---

## External Services

- **Attio CRM** — primary CRM. Schema in `docs/attio-crm-map.md`. Objects: People, Deals, Companies. Notes API (markdown). Webhook API for list-entry events. Auth: Bearer token. **Per-org instances.**
- **CloudTalk** — call center. Recordings, call history. Auth: HTTP Basic (API_ID:API_KEY). API base: `https://my.cloudtalk.io/api`. No direct call ID lookup — batch fetch + filter.
- **OpenRouter** — AI gateway, OpenAI-compatible. Multimodal models for audio transcription. Model configurable via `OPENROUTER_MODEL` env var (default: `google/gemini-2.5-flash-lite`). 120s timeout for audio processing. **Shared across orgs.**
- **Slack** — notifications via Bot token. Block Kit formatting. Auth: Bearer token (`xoxb-...`). **Per-org instances.**
- **Calendly** — consultation booking. Free plan (no native webhooks). LP embeds Calendly inline, detects booking via postMessage, notifies hub. API: Personal Access Token, `GET /scheduled_events`. **Per-org config in organizations.json.**
- **Brevo** — email marketing lists. Contacts API. Auth: API key in `api-key` header. **Per-org env var.**

## Shared Library (`src/lib/`)

All API clients use `fetchWithTimeout()` from `src/lib/fetch.ts` (30s default, 120s for OpenRouter).

**Attio** (`attio.ts`): Factory `createAttioClient(apiKey, log)`. Methods: `findPersonByPhone`, `findPersonByEmail`, `upsertPerson`, `getPersonDetails`, `getDealDetails`, `pickBestDeal`, `createDeal`, `createNote`, `queryListEntries`, `addListEntry`, `updateDealValues`, `updateListEntry`, `findListEntriesByDeal`, `registerWebhook`, `listWebhooks`, `deleteWebhook`, `getAssociatedDealIds`, plus helper extractors.

**CloudTalk** (`cloudtalk.ts`): `getCallDetails`, `getRecentCalls`, `getCallsSince`, `downloadRecording`.

**OpenRouter** (`openrouter.ts`): `transcribeAudio`, `summarizeTranscript`, `transcribeAndSummarize`. Polish-language system prompts.

**Slack** (`slack.ts`): `postMessage` (Block Kit blocks), `testConnection`.

**Logger** (`logger.ts`): `createLogger(name)` — child Pino logger per integration.

## Secrets

`.env` file (git-ignored). On VPS, created manually. Keep `.env.example` updated.

**Per-org (prefixed):**
- `{PREFIX}_ATTIO_API_KEY` (required for any org)
- `{PREFIX}_ATTIO_WEBHOOK_SECRET`, `{PREFIX}_SLACK_BOT_TOKEN`, `{PREFIX}_CLOUDTALK_API_ID`, `{PREFIX}_CLOUDTALK_API_KEY`, `{PREFIX}_BREVO_API_KEY`, `{PREFIX}_CALENDLY_API_TOKEN`, `{PREFIX}_CALENDLY_WEBHOOK_SECRET`

**Shared:**
- `OPENROUTER_API_KEY` (required)
- `DASHBOARD_PASSWORD`, `DASHBOARD_SECRET`, `OPENROUTER_MODEL`, `PORT`, `NODE_ENV`

New env vars should use the org prefix pattern. Required vars use `requireEnv()`, optional use `process.env.X || ''`.

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

**New env vars in both `.env.example` and `config.ts` with org prefix.**

**LPs are dumb:**
Never add CRM logic, stage decisions, or data transformations to landing pages. LPs POST raw user input to hub endpoints. The hub decides what to do.

## CRM Reference

See `docs/attio-crm-map.md` for the complete Attio CRM schema including all objects, attributes, API slugs, list structures with stage statuses and IDs, Notes API format, relationship graph, and key IDs.

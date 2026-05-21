# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Custom Integration Hub — coded automations deployed on a VPS, replacing n8n. Each integration is a module under `src/integrations/`. All integrations are registered in `integrations.json`.

## Commands

```bash
npm run dev          # Start dev server with hot-reload (tsx watch)
npm run build        # Compile TypeScript to dist/
npm run start        # Run compiled server (production)
npm run typecheck    # Type-check without emitting
```

## Branches

- **main**: production-ready code
- **dev**: active development branch; PRs target `main`

## Architecture

```
src/
  server.ts                          # Express app, loads registry, mounts routes
  config.ts                          # Env validation — fails fast if vars missing
  dashboard.ts                       # Admin dashboard (SSR HTML, auth, rate limiting)
  lib/
    logger.ts                        # Pino logger
    registry.ts                      # Reads integrations.json, dynamic imports
    attio.ts                         # Attio CRM API client
    cloudtalk.ts                     # CloudTalk API client
    openrouter.ts                    # OpenRouter AI API client
  integrations/
    [integration-name]/
      index.ts                       # Exports { router }
      routes.ts                      # Express router
      handler.ts                     # Business logic
      types.ts                       # Integration-specific types
```

### Integration Registry (`integrations.json`)

Central source of truth. Server reads it at startup, mounts only `status: "active"` integrations. Health endpoint (`GET /health`) lists all integrations and their status.

Statuses: `active` | `inactive` | `development`

### Adding a New Integration

1. Create folder `src/integrations/[name]/` with `index.ts`, `routes.ts`, `handler.ts`
2. `index.ts` must export `{ router }` (Express Router)
3. Add entry to `integrations.json` with `status: "development"`
4. Set to `"active"` when ready
5. Routes mount at the `path` specified in registry (e.g., `/my-integration`)

### URL Pattern

`https://custom-integration-hub.velocy.co/[integration-name]/[endpoint]`

### Admin Dashboard

`GET /dashboard` — password-protected status page showing all integrations and their status. Set `DASHBOARD_PASSWORD` in `.env` to enable. Rate-limited login (5 attempts/min, 15 min lockout). Session via signed HttpOnly cookie (7 days).

### Notes in Attio CRM

When creating notes, always create TWO: one on the **Person** and one on the **Deal**. Person note title includes deal name for context. See `docs/attio-crm-map.md` for API details.

## External Services

- **Attio CRM** — schema in `docs/attio-crm-map.md`
- **CloudTalk** — call center, recordings, webhooks. Basic auth (API_ID:API_KEY)
- **OpenRouter** — AI gateway, OpenAI-compatible. Transcription via multimodal models

## Secrets

`.env` file (git-ignored). On VPS, created manually. Keep `.env.example` updated.

## Deployment

VPS: `187.127.88.41` / `custom-integration-hub.velocy.co`

```bash
# On VPS:
git pull origin dev
npm install && npm run build
pm2 restart custom-integration-hub
```

PM2 config: `ecosystem.config.cjs`
Nginx config: `deploy/nginx.conf`

---

## How Integrations Work — Complete Guide

This section explains the architecture so every Claude Code instance builds integrations consistently.

### Core Concept

The server is a single Express app that hosts many independent automations. Each automation is called an **integration**. Integrations are self-contained modules that receive triggers (webhooks, cron) and perform actions (API calls to CRM, AI processing, etc.).

The system has three layers:
1. **Server layer** (`server.ts`) — Express app, middleware, health endpoint, dynamic route mounting
2. **Shared library** (`src/lib/`) — Reusable API clients and utilities shared across all integrations
3. **Integration modules** (`src/integrations/[name]/`) — Self-contained business logic per automation

### How the Server Boots

```
server.ts bootstrap():
  1. loadRegistry()           → reads integrations.json into memory
  2. mount /dashboard         → admin panel (SSR HTML, password-protected)
  3. mount /health            → public JSON status endpoint
  4. for each integration where status === "active":
       dynamic import(entry.module)
       app.use(entry.path, mod.router)
  5. mount global error handler
  6. app.listen(3100)
```

Only integrations with `status: "active"` get their routes mounted. Changing status requires editing `integrations.json` and restarting the server.

### Integration Module Contract

Every integration MUST follow this structure:

```
src/integrations/[name]/
  index.ts      — MUST export { router } (Express Router)
  routes.ts     — Express Router with endpoint definitions
  handler.ts    — Business logic (the "pipeline")
  types.ts      — TypeScript interfaces for payloads/data
```

**`index.ts`** — Always exactly this:
```typescript
export { router } from './routes.js';
```

**`routes.ts`** — Define endpoints relative to the integration path:
```typescript
import { Router } from 'express';
import { webhookHandler } from './handler.js';

const router = Router();
router.post('/webhook', webhookHandler);     // becomes /[integration-name]/webhook
export { router };
```

**`handler.ts`** — The core pipeline. Pattern for webhook integrations:
```typescript
import type { Request, Response } from 'express';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('my-integration');

export async function webhookHandler(req: Request, res: Response): Promise<void> {
  // 1. Respond immediately (prevent webhook retries)
  res.status(200).json({ status: 'accepted' });

  // 2. Process asynchronously
  processPayload(req.body).catch(err => {
    log.error({ err, payload: req.body }, 'Processing failed');
  });
}

async function processPayload(payload: MyPayload): Promise<void> {
  // Business logic here — API calls, data transformation, etc.
}
```

**`types.ts`** — Define interfaces for all external data:
```typescript
export interface MyWebhookPayload {
  id?: string;
  // ... fields from external service
  [key: string]: unknown;   // allow extra fields
}
```

### Registry Entry Format

When adding a new integration, add an entry to `integrations.json`:

```json
{
  "id": "my-integration",
  "name": "Human-readable name",
  "description": "What this integration does in one sentence",
  "status": "development",
  "type": "webhook",
  "path": "/my-integration",
  "module": "./src/integrations/my-integration/index.js",
  "triggers": ["Source: Event that starts this"],
  "targets": ["Destination: What gets created/updated"],
  "addedAt": "2026-05-21"
}
```

Fields:
- **id**: kebab-case unique identifier, matches folder name
- **name**: shown in dashboard, can include emoji arrows like `Source → Action`
- **description**: one sentence, shown in dashboard
- **status**: `"development"` while building, `"active"` when ready, `"inactive"` to disable
- **type**: `"webhook"` (receives HTTP), `"cron"` (scheduled), or `"hybrid"` (both)
- **path**: Express mount path, always `"/[id]"`
- **module**: path to compiled entry point, always `"./src/integrations/[id]/index.js"`
- **triggers**: array of strings describing what starts this integration
- **targets**: array of strings describing what gets modified

### Shared Library (`src/lib/`)

API clients are shared across integrations. Use them instead of making raw fetch calls.

**Attio CRM** (`src/lib/attio.ts`):
- `findPersonByPhone(phone)` — searches with 3 phone format variants (E.164, no +, last 9 digits)
- `findPersonByEmail(email)` — email lookup
- `getDealDetails(recordId)` — fetch single deal
- `pickBestDeal(person)` — selects most relevant deal (active > closed, newest first)
- `createNote({ parentObject, parentRecordId, title, content })` — creates markdown note
- `getPersonName(person)`, `getDealName(deal)`, `getDealStage(deal)` — helper extractors

**CloudTalk** (`src/lib/cloudtalk.ts`):
- `getCallDetails(callId)` — full call metadata
- `getRecentCalls(limit)` — list recent calls
- `downloadRecording(callId)` — returns Buffer (WAV audio) or null

**OpenRouter** (`src/lib/openrouter.ts`):
- `transcribeAudio(audioBuffer)` — audio → text via Gemini multimodal
- `summarizeTranscript(transcript, callMeta)` — text → Polish summary
- `transcribeAndSummarize(audioBuffer, callMeta)` — single-pass: audio → transcript + summary

**Logger** (`src/lib/logger.ts`):
- `logger` — root Pino logger
- `createLogger(name)` — creates child logger with `{ integration: name }`

Every integration should use `createLogger('integration-name')` for structured logging.

### Patterns to Follow

**Webhook handlers respond immediately, process async:**
```typescript
res.status(200).json({ status: 'accepted' });
process(payload).catch(err => log.error({ err }, 'fail'));
```
This prevents the external service from retrying while we're still processing.

**Idempotency for webhooks:**
External services may send duplicate webhooks. Use an in-memory Map with TTL:
```typescript
const processed = new Map<string, number>();
// Check before processing, set after accepting, cleanup on interval
```

**Attio notes always on Person AND Deal:**
When creating notes that relate to a deal, create TWO notes:
1. Person note — title includes deal name for cross-deal context: `"Action — {Deal Name} — {YYYY-MM-DD}"`
2. Deal note — title without deal name (redundant in deal context): `"Action — {YYYY-MM-DD}"`

If no deal is found, create only the Person note.

**Error handling — log and continue, don't crash:**
Integrations run in the same process. An unhandled exception kills everything. Always wrap async pipelines in try/catch and log errors. Never let a single webhook failure bring down the server.

**Use existing API clients:**
Before making raw `fetch()` calls to Attio, CloudTalk, or OpenRouter, check if `src/lib/` already has the function you need. Add new functions to the existing client files rather than creating new ones.

**New external service = new client in `src/lib/`:**
If an integration needs a service that doesn't have a client yet (e.g., Calendly, Stripe), create `src/lib/calendly.ts` following the same pattern: config from `config.ts`, typed response interfaces, exported async functions, child logger.

**Add new env vars to both `.env.example` and `config.ts`:**
All secrets go in `.env` (git-ignored). The `config.ts` file validates them at startup with `requireEnv()` for required vars or `process.env.X || ''` for optional ones. Update `.env.example` with placeholder values.

### Step-by-Step: Building a New Integration

1. **Understand the trigger**: What starts this automation? Webhook from external service? Cron schedule? Manual trigger?

2. **Understand the action**: What should happen? Create CRM records? Send messages? Process data?

3. **Check existing clients**: Does `src/lib/` already have the API client needed? If not, create one.

4. **Create the module**:
   ```bash
   mkdir -p src/integrations/my-integration
   ```
   Create `index.ts`, `routes.ts`, `handler.ts`, `types.ts`.

5. **Register in `integrations.json`** with `status: "development"`.

6. **Implement handler.ts** — the pipeline. Follow the respond-immediately-process-async pattern for webhooks.

7. **Test locally**: `npm run dev` + `curl` to simulate the trigger.

8. **Set status to `"active"`** in `integrations.json`.

9. **Type-check and build**: `npm run typecheck && npm run build`

10. **Deploy**: Commit to `dev`, push, on VPS: `git pull && npm install && npm run build && pm2 restart custom-integration-hub`.

11. **Configure the trigger**: Set up the webhook URL or cron in the external service.

### CRM Reference

See `docs/attio-crm-map.md` for the complete Attio CRM schema including:
- All objects (People, Deals, Companies), their attributes and API slugs
- List (pipeline) structures with stage statuses and IDs
- Notes API format and examples
- Relationship graph between objects
- Key workspace/object/list IDs

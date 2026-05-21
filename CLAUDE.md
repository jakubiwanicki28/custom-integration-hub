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

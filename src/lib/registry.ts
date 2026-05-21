import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Router } from 'express';
import { logger } from './logger.js';

export interface IntegrationEntry {
  id: string;
  name: string;
  description: string;
  status: 'active' | 'inactive' | 'development';
  type: 'webhook' | 'cron' | 'hybrid';
  path: string;
  module: string;
  triggers: string[];
  targets: string[];
  addedAt: string;
}

export interface IntegrationModule {
  router: Router;
}

interface RegistryFile {
  integrations: IntegrationEntry[];
}

let _registry: IntegrationEntry[] = [];

export function loadRegistry(): IntegrationEntry[] {
  const filePath = resolve(process.cwd(), 'integrations.json');
  const raw = readFileSync(filePath, 'utf-8');
  const parsed: RegistryFile = JSON.parse(raw);
  _registry = parsed.integrations;
  logger.info({ count: _registry.length }, 'Registry loaded');
  return _registry;
}

export function getActiveIntegrations(): IntegrationEntry[] {
  return _registry.filter(i => i.status === 'active');
}

export function getAllIntegrations(): IntegrationEntry[] {
  return _registry;
}

export async function importIntegration(entry: IntegrationEntry): Promise<IntegrationModule> {
  // In dev (tsx), .ts extension works. In prod (compiled), .js is used.
  // The module path in integrations.json points to the .js (dist) path.
  // tsx handles .js → .ts resolution automatically.
  const modulePath = resolve(process.cwd(), entry.module);
  const mod = await import(modulePath);
  return mod as IntegrationModule;
}

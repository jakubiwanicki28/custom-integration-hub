import { readFileSync } from 'fs';
import { resolve } from 'path';
import { logger } from './logger.js';
import type {
  IntegrationCatalogEntry,
  OrganizationEntry,
  IntegrationInstance,
  OrgContext,
} from './org-context.js';

// --- Integration catalog (integrations.json) ---

interface IntegrationCatalogFile {
  integrations: IntegrationCatalogEntry[];
}

let _catalog: IntegrationCatalogEntry[] = [];

export function loadIntegrationCatalog(): IntegrationCatalogEntry[] {
  const filePath = resolve(process.cwd(), 'integrations.json');
  const raw = readFileSync(filePath, 'utf-8');
  const parsed: IntegrationCatalogFile = JSON.parse(raw);
  _catalog = parsed.integrations;
  logger.info({ count: _catalog.length }, 'Integration catalog loaded');
  return _catalog;
}

export function getIntegrationCatalog(): IntegrationCatalogEntry[] {
  return _catalog;
}

export function getCatalogEntry(integrationId: string): IntegrationCatalogEntry | undefined {
  return _catalog.find(e => e.id === integrationId);
}

// --- Organizations (organizations.json) ---

interface OrganizationsFile {
  organizations: OrganizationEntry[];
}

let _organizations: OrganizationEntry[] = [];

export function loadOrganizations(): OrganizationEntry[] {
  const filePath = resolve(process.cwd(), 'organizations.json');
  const raw = readFileSync(filePath, 'utf-8');
  const parsed: OrganizationsFile = JSON.parse(raw);
  _organizations = parsed.organizations;
  logger.info({ count: _organizations.length, orgs: _organizations.map(o => o.id) }, 'Organizations loaded');
  return _organizations;
}

export function getAllOrganizations(): OrganizationEntry[] {
  return _organizations;
}

export function getOrganization(orgId: string): OrganizationEntry | undefined {
  return _organizations.find(o => o.id === orgId);
}

// --- Runtime registry (mounted integration instances) ---

export interface MountedIntegration {
  orgId: string;
  integrationId: string;
  instance: IntegrationInstance;
  catalogEntry: IntegrationCatalogEntry;
  ctx: OrgContext;
  status: string;
}

const _mounted = new Map<string, MountedIntegration>();

export function registerMountedIntegration(
  orgId: string,
  integrationId: string,
  instance: IntegrationInstance,
  catalogEntry: IntegrationCatalogEntry,
  ctx: OrgContext,
  status: string,
): void {
  _mounted.set(`${orgId}:${integrationId}`, { orgId, integrationId, instance, catalogEntry, ctx, status });
}

export function getMountedIntegration(orgId: string, integrationId: string): MountedIntegration | undefined {
  return _mounted.get(`${orgId}:${integrationId}`);
}

export function getMountedIntegrationsForOrg(orgId: string): MountedIntegration[] {
  const result: MountedIntegration[] = [];
  for (const entry of _mounted.values()) {
    if (entry.orgId === orgId) result.push(entry);
  }
  return result;
}

export function getAllMountedIntegrations(): MountedIntegration[] {
  return Array.from(_mounted.values());
}

// --- Dynamic import ---

export async function importIntegrationModule(entry: IntegrationCatalogEntry): Promise<{ createIntegration: (ctx: OrgContext) => IntegrationInstance }> {
  const modulePath = resolve(process.cwd(), entry.module);
  const mod = await import(modulePath);
  if (typeof mod.createIntegration !== 'function') {
    throw new Error(`Integration module ${entry.id} does not export createIntegration()`);
  }
  return mod as { createIntegration: (ctx: OrgContext) => IntegrationInstance };
}

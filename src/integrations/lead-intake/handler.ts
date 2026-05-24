import type { OrgContext } from '../../lib/org-context.js';
import { fetchWithTimeout } from '../../lib/fetch.js';
import type { LeadIntakeRequest, LeadIntakeResponse, CampaignConfig } from './types.js';

export function createHandler(ctx: OrgContext) {
  const attio = ctx.clients.attio;
  const log = ctx.log.child({ integration: 'lead-intake' });

  const campaigns = (ctx.integrationConfig.campaigns ?? {}) as Record<string, CampaignConfig>;
  const dealOwnerId = ctx.integrationConfig.dealOwnerId as string;
  const dealStageLeadId = ctx.integrationConfig.dealStageLeadId as string;
  const brevoApiKey = process.env[`${ctx.org.envPrefix}_BREVO_API_KEY`] || '';

  // --- Input validation ---

  function normalizePhone(phone: string): string {
    const digits = phone.replace(/[\s\-\(\)]/g, '');
    if (/^\d{9}$/.test(digits)) return `+48${digits}`;
    if (/^48\d{9}$/.test(digits)) return `+${digits}`;
    if (digits.startsWith('+')) return digits;
    return `+${digits}`;
  }

  function validateRequest(body: unknown): { data: LeadIntakeRequest; error?: undefined } | { data?: undefined; error: string } {
    if (!body || typeof body !== 'object') return { error: 'Invalid request body' };

    const b = body as Record<string, unknown>;
    const email = String(b.email ?? '').trim().toLowerCase();
    const phone = String(b.phone ?? '').trim();
    const campaign = String(b.campaign ?? '').trim();

    if (!email || !email.includes('@')) return { error: 'Valid email is required' };
    if (!phone) return { error: 'Phone is required' };
    if (!campaign || !campaigns[campaign]) return { error: `Unknown campaign: ${campaign}` };

    let firstName: string;
    let lastName: string;

    if (b.fullName && typeof b.fullName === 'string') {
      const parts = b.fullName.trim().split(/\s+/);
      firstName = parts[0] || '';
      lastName = parts.slice(1).join(' ') || '';
    } else {
      firstName = String(b.firstName ?? '').trim();
      lastName = String(b.lastName ?? '').trim();
    }

    if (!firstName) return { error: 'First name is required' };

    return {
      data: { firstName, lastName: lastName || '', email, phone: normalizePhone(phone), campaign },
    };
  }

  // --- Brevo helper (fire-and-forget) ---

  async function sendToBrevo(data: LeadIntakeRequest, listId: number): Promise<void> {
    if (!brevoApiKey) {
      log.warn('Brevo API key not configured, skipping');
      return;
    }

    const body = {
      email: data.email,
      listIds: [listId],
      updateEnabled: true,
      attributes: {
        FIRSTNAME: data.firstName,
        LASTNAME: data.lastName || undefined,
        SMS: data.phone,
      },
    };

    try {
      const res = await fetchWithTimeout('https://api.brevo.com/v3/contacts', {
        method: 'POST',
        headers: { 'api-key': brevoApiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        if (text.includes('duplicate_parameter') || text.includes('SMS')) {
          const { SMS: _, ...attrsNoSms } = body.attributes;
          await fetchWithTimeout('https://api.brevo.com/v3/contacts', {
            method: 'POST',
            headers: { 'api-key': brevoApiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, attributes: attrsNoSms }),
          });
          log.info({ email: data.email }, 'Brevo contact added (without SMS)');
          return;
        }
        log.error({ status: res.status, body: text.slice(0, 300) }, 'Brevo API error');
        return;
      }

      log.info({ email: data.email }, 'Brevo contact added');
    } catch (err) {
      log.error({ err, email: data.email }, 'Brevo send failed');
    }
  }

  // --- Main pipeline ---

  async function processLead(data: LeadIntakeRequest): Promise<LeadIntakeResponse> {
    const campaignConfig = campaigns[data.campaign];
    if (!campaignConfig) return { ok: false, error: `Unknown campaign: ${data.campaign}` };

    // 1. Upsert Person
    const personId = await attio.upsertPerson({
      email: data.email,
      firstName: data.firstName,
      lastName: data.lastName,
      phone: data.phone,
    });
    if (!personId) return { ok: false, error: 'Failed to create person in CRM' };

    // 2. Create Deal
    const dealName = `${campaignConfig.dealPrefix} — ${data.firstName} ${data.lastName}`.trim();
    const dealId = await attio.createDeal({
      name: dealName,
      stageId: dealStageLeadId,
      ownerId: dealOwnerId,
      personRecordId: personId,
    });
    if (!dealId) return { ok: false, error: 'Failed to create deal in CRM' };

    // 3. Add to campaign list
    const entryValues = {
      [campaignConfig.listStatusSlug]: [{ status: campaignConfig.initialStageId }],
    };
    const entryId = await attio.addListEntry(campaignConfig.listId, dealId, entryValues);
    if (!entryId) {
      log.warn({ dealId, campaign: data.campaign }, 'Deal created but failed to add to campaign list');
    }

    // 4. Brevo (fire-and-forget)
    sendToBrevo(data, campaignConfig.brevoListId).catch(err => log.error({ err }, 'Brevo fire-and-forget error'));

    log.info({ personId, dealId, entryId, campaign: data.campaign, email: data.email }, 'Lead processed');
    return { ok: true };
  }

  return { validateRequest, processLead };
}

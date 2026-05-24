/** Raw input from LP frontend (before validation) */
export interface LeadIntakeInput {
  firstName?: string;
  lastName?: string;
  fullName?: string;
  email?: string;
  phone?: string;
  campaign?: string;
}

/** Validated lead data (after validation) */
export interface LeadIntakeRequest {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  campaign: string;
}

export interface LeadIntakeResponse {
  ok: boolean;
  error?: string;
}

export interface CampaignConfig {
  listId: string;
  listStatusSlug: string;
  initialStageId: string;
  dealPrefix: string;
}

export interface LeadIntakeRequest {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  campaign: string;
  // Optional metadata from LP
  source?: string;
  submittedAt?: string;
  company?: string;
}

export interface LeadIntakeResponse {
  ok: boolean;
  error?: string;
}

export interface CampaignConfig {
  listId: string;
  listStatusSlug?: string;
  initialStageId?: string;
  dealPrefix: string;
  brevoListId?: number;
  createNote?: boolean;
}

export interface CalendlyWebhookPayload {
  event: string; // "invitee.created"
  payload: {
    email: string;
    name: string;
    status: string;
    timezone: string;
    uri: string;
    cancel_url: string;
    reschedule_url: string;
    created_at: string;
    updated_at: string;
    calendar_event: {
      start_time: string;
      end_time: string;
    };
    event_type?: {
      name: string;
      uri: string;
    };
    questions_and_answers?: Array<{
      question: string;
      answer: string;
      position: number;
    }>;
  };
}

export interface CampaignListConfig {
  listName: string;
  statusSlug: string;
  konsultacjaStageId: string;
}

export interface BookingSyncResult {
  success: boolean;
  email?: string;
  dealName?: string;
  listName?: string;
  error?: string;
}

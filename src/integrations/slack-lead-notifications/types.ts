export interface AttioWebhookPayload {
  event_type: string;
  id: {
    workspace_id: string;
    list_id: string;
    entry_id: string;
  };
  parent_object_id: string;
  parent_record_id: string;
}

export interface LeadNotificationData {
  personName: string;
  email: string | null;
  phone: string | null;
  dealName: string;
  dealRecordId: string;
  listName: string;
  stage: string;
}

export interface ProcessLeadResult {
  success: boolean;
  personName?: string;
  dealName?: string;
  slackChannel?: string;
  error?: string;
}

export interface CloudTalkWebhookPayload {
  call_id?: string;
  call_uuid?: string;
  phone_number?: string;
  direction?: string;
  duration?: string | number;
  agent_name?: string;
  agent_email?: string;
  has_recording?: string | boolean;
  // CloudTalk may send additional fields depending on workflow config
  [key: string]: unknown;
}

export interface ProcessedNote {
  title: string;
  content: string;
}

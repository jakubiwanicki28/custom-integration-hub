// --- Fathom webhook payload ---

export interface FathomWebhookPayload {
  recording_id: number;
  title: string;
  meeting_title: string | null;
  share_url: string;
  url: string;
  created_at: string;
  scheduled_start_time: string;
  scheduled_end_time: string;
  recording_start_time: string;
  recording_end_time: string;
  meeting_type: string | null;
  transcript_language: string;
  calendar_invitees: Array<{
    name: string | null;
    email: string | null;
    email_domain: string | null;
    is_external: boolean;
    matched_speaker_display_name: string | null;
  }>;
  recorded_by: { name: string; email: string };
  transcript: Array<{
    speaker: { display_name: string; matched_calendar_invitee_email: string | null };
    text: string;
    timestamp: string; // HH:MM:SS
  }> | null;
  default_summary: {
    template_name: string | null;
    markdown_formatted: string | null;
  } | null;
  action_items: Array<{
    description: string;
    user_generated: boolean;
    completed: boolean;
    recording_timestamp: string;
    assignee: { name: string | null; email: string | null } | null;
  }> | null;
}

// --- Integration config (from organizations.json) ---

export interface MeetingRoute {
  match: string;
  channelId: string;
  channelName: string;
  type: string;
}

export interface MeetingChannel {
  channelId: string;
  channelName: string;
  type: string;
}

export interface NotionExtraProperties {
  statusDefault?: string;        // e.g. "Nowy" — set Status select on every new page
  includeFathomUrl?: boolean;    // populate "Fathom URL" url property
  includeDuration?: boolean;     // populate "Duration (min)" number property
}

export interface FathomMeetingConfig {
  meetingPrefix?: string;          // undefined = process ALL meetings (no prefix filter)
  routes?: MeetingRoute[];         // undefined = no routing
  defaultChannel?: MeetingChannel; // undefined = no Slack
  notionDatabaseId: string;
  teamMembers: Record<string, string>; // email → short display name
  generateTitle?: boolean;         // AI-generate descriptive title from content
  notionExtraProperties?: NotionExtraProperties;
}

// --- Processing result ---

export interface ProcessMeetingResult {
  success: boolean;
  meetingTitle?: string;
  meetingType?: string;
  slackChannel?: string;
  notionUrl?: string;
  error?: string;
}

export interface SlackSlashCommandPayload {
  token: string;
  team_id: string;
  team_domain: string;
  channel_id: string;
  channel_name: string;
  user_id: string;
  user_name: string;
  command: string;
  text: string;
  response_url: string;
  trigger_id: string;
}

export interface PRConfig {
  githubOwner: string;
  githubRepo: string;
  allowedChannelId: string;
  allowedUserIds: string[];
  baseBranch: string;
  headBranch: string;
  notificationChannelId: string;
}

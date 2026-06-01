export interface VercelWebhookPayload {
  type: 'deployment.created' | 'deployment.succeeded' | 'deployment.error';
  id: string;
  createdAt: number;
  payload: {
    team?: { id: string } | null;
    user: { id: string };
    deployment: {
      id: string;
      meta: Record<string, string>;
      url: string;
      name: string;
    };
    links: {
      deployment: string;
      project: string;
    };
    target: 'production' | 'staging' | null;
    project: { id: string };
    plan: string;
    regions: string[];
  };
}

export interface DeployState {
  [branch: string]: {
    sha: string;
    deployedAt: string;
  };
}

export interface BranchChannelConfig {
  channelId: string;
  channelName: string;
  environment: string;
}

export interface ProcessDeployResult {
  success: boolean;
  event?: string;
  branch?: string;
  sha?: string;
  channel?: string;
  error?: string;
}

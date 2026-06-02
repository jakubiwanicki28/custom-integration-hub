import type { MetricsSnapshot } from '../metrics.js';

export interface AnalysisResult {
  id: string;                // e.g. '2026-06-02T14' or '2026-06-02-daily'
  timestamp: string;         // ISO 8601
  type: 'hourly' | 'daily' | 'micro';
  status: 'normal' | 'anomaly' | 'critical';
  summary: string;           // AI's Polish-language summary
  anomalies: Anomaly[];
  recommendations?: string[];
}

export interface Anomaly {
  metric: string;
  expected: string;
  actual: string;
  severity: 'low' | 'medium' | 'high';
}

export interface PersistedAnalysis extends AnalysisResult {
  snapshot: MetricsSnapshot;
  prompt: string;            // full prompt sent to AI
  rawResponse: string;       // AI's raw response text
}

export interface VercelProjectHealth {
  projectId: string;
  projectName: string;
  label: string;
  org: string;
  state: 'READY' | 'ERROR' | 'BUILDING' | 'QUEUED' | 'CANCELED' | 'UNKNOWN';
  lastDeployAt: number | null;
  branch?: string;
  commitMessage?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface MonitoringConfig {
  vercel: {
    pollIntervalMs: number;
    projects: Record<string, Array<{ id: string; name: string; label: string }>>;
  };
  slack: {
    channelId: string;
    dailyDigestHour: number;
    timezone: string;
  };
}

import { createHmac, timingSafeEqual } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import type { Request, Response } from 'express';
import type { OrgContext } from '../../lib/org-context.js';
import { createGitHubClient } from '../../lib/github.js';
import type { GitHubCommit } from '../../lib/github.js';
import type { SlackBlock } from '../../lib/slack.js';
import type { VercelWebhookPayload, DeployState, BranchChannelConfig, ProcessDeployResult } from './types.js';

export function createHandler(ctx: OrgContext) {
  if (!ctx.clients.slack) throw new Error('vercel-deploy-notifications requires Slack client');
  if (!ctx.credentials.github) throw new Error('vercel-deploy-notifications requires GitHub token');

  const slack = ctx.clients.slack;
  const log = ctx.log.child({ integration: 'vercel-deploy-notifications' });
  const vercelSecret = ctx.credentials.vercel?.webhookSecret || '';

  // GitHub client — owner/repo from integration config
  const githubOwner = ctx.integrationConfig.githubOwner as string;
  const githubRepo = ctx.integrationConfig.githubRepo as string;
  const github = createGitHubClient(ctx.credentials.github.token, githubOwner, githubRepo, log);

  // Branch → channel mapping from config
  const branchChannelMap = new Map<string, BranchChannelConfig>();
  const rawMap = (ctx.integrationConfig.branchChannelMap ?? {}) as Record<string, BranchChannelConfig>;
  for (const [branch, config] of Object.entries(rawMap)) {
    branchChannelMap.set(branch, config);
  }

  const vercelProjectUrl = ctx.integrationConfig.vercelProjectUrl as string || '';

  // In-memory tracking of "building" messages: deploymentId → { channelId, messageTs }
  const buildingMessages = new Map<string, { channelId: string; messageTs: string }>();

  // Deploy state persistence
  const stateFilePath = join(process.cwd(), 'data', `deploy-state-${ctx.org.id}.json`);

  function loadDeployState(): DeployState {
    try {
      if (existsSync(stateFilePath)) {
        return JSON.parse(readFileSync(stateFilePath, 'utf-8')) as DeployState;
      }
    } catch (err) {
      log.warn({ err }, 'Failed to load deploy state, starting fresh');
    }
    return {};
  }

  function saveDeployState(state: DeployState): void {
    try {
      const dir = dirname(stateFilePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(stateFilePath, JSON.stringify(state, null, 2));
    } catch (err) {
      log.error({ err }, 'Failed to save deploy state');
    }
  }

  // --- Signature verification (Vercel uses HMAC-SHA1) ---

  function verifySignature(rawBody: Buffer, signature: string): boolean {
    if (!vercelSecret) {
      log.warn('Vercel webhook signature verification SKIPPED — no secret configured');
      return true;
    }

    const hmac = createHmac('sha1', vercelSecret);
    hmac.update(rawBody);
    const expected = hmac.digest('hex');

    if (signature.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }

  // --- Extract git metadata from Vercel deployment payload ---

  function extractGitMeta(payload: VercelWebhookPayload['payload']) {
    const meta = payload.deployment.meta;
    return {
      sha: meta.githubCommitSha || meta.gitlabCommitSha || '',
      branch: meta.githubCommitRef || meta.gitlabCommitRef || '',
      message: meta.githubCommitMessage || meta.gitlabCommitMessage || '',
      author: meta.githubCommitAuthorLogin || meta.gitlabCommitAuthorLogin || '',
      deploymentUrl: `https://${payload.deployment.url}`,
      deploymentId: payload.deployment.id,
      projectName: payload.deployment.name,
      vercelDashboardUrl: payload.links.deployment || '',
    };
  }

  // --- Changelog formatting ---

  function groupCommitsByType(commits: GitHubCommit[]): Map<string, GitHubCommit[]> {
    const groups = new Map<string, GitHubCommit[]>();
    const typeLabels: Record<string, string> = {
      feat: '✨ Features',
      fix: '🐛 Fixes',
      refactor: '♻️ Refactor',
      perf: '⚡ Performance',
      docs: '📝 Docs',
      style: '🎨 Style',
      test: '🧪 Tests',
      chore: '🔧 Chore',
      ci: '⚙️ CI',
      build: '📦 Build',
    };

    for (const commit of commits) {
      // Skip merge commits
      if (commit.message.startsWith('Merge ')) continue;

      const match = commit.message.match(/^(\w+)(?:\(.*?\))?[!:]?\s*/);
      const type = match?.[1]?.toLowerCase() || 'other';
      const label = typeLabels[type] || '📋 Other';

      if (!groups.has(label)) groups.set(label, []);
      groups.get(label)!.push(commit);
    }

    return groups;
  }

  function formatChangelogBlocks(commits: GitHubCommit[], stats: { additions: number; deletions: number }): SlackBlock[] {
    const groups = groupCommitsByType(commits);
    const blocks: SlackBlock[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `📋 Changelog (${commits.length} commits)`, emoji: true },
      },
    ];

    for (const [label, groupCommits] of groups) {
      const lines = groupCommits.map(c => `• ${c.message} — @${c.author}`).join('\n');
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*${label}*\n${lines}` },
      });
    }

    if (stats.additions > 0 || stats.deletions > 0) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `📊 +${stats.additions} / -${stats.deletions}` }],
      });
    }

    return blocks;
  }

  // --- Slack message builders ---

  function buildBuildingBlocks(git: ReturnType<typeof extractGitMeta>, channelConfig: BranchChannelConfig): { blocks: SlackBlock[]; text: string } {
    const shortSha = git.sha.slice(0, 7);
    const blocks: SlackBlock[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `⏳ *Building — ${git.projectName}*\n\`${git.branch}\` · \`${shortSha}\` · "${git.message}"`,
        },
      },
    ];
    return { blocks, text: `⏳ Building ${git.projectName} (${git.branch} · ${shortSha})` };
  }

  function buildSuccessBlocks(git: ReturnType<typeof extractGitMeta>, channelConfig: BranchChannelConfig, commitCount: number): { blocks: SlackBlock[]; text: string } {
    const shortSha = git.sha.slice(0, 7);
    const elements: SlackBlock['elements'] = [];

    if (git.deploymentUrl) {
      elements.push({
        type: 'button',
        text: { type: 'plain_text', text: '🔗 Deployment' },
        url: git.deploymentUrl,
        action_id: 'view_deployment',
      });
    }
    if (git.vercelDashboardUrl) {
      elements.push({
        type: 'button',
        text: { type: 'plain_text', text: '⚙️ Vercel' },
        url: git.vercelDashboardUrl,
        action_id: 'view_vercel',
      });
    }

    const blocks: SlackBlock[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🟢 *${channelConfig.environment} Deploy — ${git.projectName}*\n\`${git.branch}\` · \`${shortSha}\` · "${git.message}"${commitCount > 0 ? `\n📋 ${commitCount} commit${commitCount !== 1 ? 's' : ''} since last deploy` : ''}`,
        },
      },
    ];

    if (elements.length > 0) {
      blocks.push({ type: 'actions', elements });
    }

    return { blocks, text: `🟢 ${channelConfig.environment} Deploy — ${git.projectName} (${git.branch} · ${shortSha})` };
  }

  function buildErrorBlocks(git: ReturnType<typeof extractGitMeta>, channelConfig: BranchChannelConfig): { blocks: SlackBlock[]; text: string } {
    const shortSha = git.sha.slice(0, 7);
    const elements: SlackBlock['elements'] = [];

    if (git.vercelDashboardUrl) {
      elements.push({
        type: 'button',
        text: { type: 'plain_text', text: '🔗 View in Vercel' },
        url: git.vercelDashboardUrl,
        style: 'danger',
        action_id: 'view_vercel_error',
      });
    }

    const blocks: SlackBlock[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🔴 *Deploy Failed — ${git.projectName}*\n\`${git.branch}\` · \`${shortSha}\` · "${git.message}"`,
        },
      },
    ];

    if (elements.length > 0) {
      blocks.push({ type: 'actions', elements });
    }

    return { blocks, text: `🔴 Deploy Failed — ${git.projectName} (${git.branch} · ${shortSha})` };
  }

  // --- Event handlers ---

  async function handleDeploymentCreated(payload: VercelWebhookPayload['payload']): Promise<void> {
    const git = extractGitMeta(payload);
    const channelConfig = branchChannelMap.get(git.branch);

    if (!channelConfig) {
      log.info({ branch: git.branch }, 'Branch not mapped to any channel, skipping');
      return;
    }

    const { blocks, text } = buildBuildingBlocks(git, channelConfig);
    const result = await slack.postMessageFull(channelConfig.channelId, blocks, text);

    if (result.ok && result.ts) {
      buildingMessages.set(git.deploymentId, { channelId: channelConfig.channelId, messageTs: result.ts });
      log.info({ deploymentId: git.deploymentId, channel: channelConfig.channelName, ts: result.ts }, 'Building message posted');
    }
  }

  async function handleDeploymentSucceeded(payload: VercelWebhookPayload['payload']): Promise<void> {
    const git = extractGitMeta(payload);
    const channelConfig = branchChannelMap.get(git.branch);

    if (!channelConfig) {
      log.info({ branch: git.branch }, 'Branch not mapped to any channel, skipping');
      return;
    }

    // Delete "building" message if it exists
    const buildingMsg = buildingMessages.get(git.deploymentId);
    if (buildingMsg) {
      await slack.deleteMessage(buildingMsg.channelId, buildingMsg.messageTs);
      buildingMessages.delete(git.deploymentId);
    }

    // Build changelog from GitHub
    const state = loadDeployState();
    const previousSha = state[git.branch]?.sha;
    let commitCount = 0;
    let changelogBlocks: SlackBlock[] | null = null;

    if (previousSha && git.sha) {
      const comparison = await github.compareCommits(previousSha, git.sha);
      if (comparison && comparison.totalCommits > 0) {
        commitCount = comparison.totalCommits;
        changelogBlocks = formatChangelogBlocks(comparison.commits, comparison.stats);
      }
    } else if (git.sha) {
      // First deploy — get recent commits for context
      const recentCommits = await github.getRecentCommits(git.branch, 5);
      if (recentCommits.length > 0) {
        commitCount = recentCommits.length;
        changelogBlocks = formatChangelogBlocks(recentCommits, { additions: 0, deletions: 0 });
      }
    }

    // Post main deploy message
    const { blocks, text } = buildSuccessBlocks(git, channelConfig, commitCount);
    const mainMsg = await slack.postMessageFull(channelConfig.channelId, blocks, text);

    // Post changelog as thread reply
    if (mainMsg.ok && mainMsg.ts && changelogBlocks) {
      await slack.postMessageFull(
        channelConfig.channelId,
        changelogBlocks,
        `Changelog: ${commitCount} commits`,
        { threadTs: mainMsg.ts },
      );
    }

    // Save deploy state
    if (git.sha) {
      state[git.branch] = { sha: git.sha, deployedAt: new Date().toISOString() };
      saveDeployState(state);
      log.info({ branch: git.branch, sha: git.sha, commitCount }, 'Deploy state saved');
    }

    log.info({ branch: git.branch, sha: git.sha, channel: channelConfig.channelName, commitCount }, 'Deploy success notification sent');
  }

  async function handleDeploymentError(payload: VercelWebhookPayload['payload']): Promise<void> {
    const git = extractGitMeta(payload);
    const channelConfig = branchChannelMap.get(git.branch);

    if (!channelConfig) {
      log.info({ branch: git.branch }, 'Branch not mapped to any channel, skipping');
      return;
    }

    // Delete "building" message if it exists
    const buildingMsg = buildingMessages.get(git.deploymentId);
    if (buildingMsg) {
      await slack.deleteMessage(buildingMsg.channelId, buildingMsg.messageTs);
      buildingMessages.delete(git.deploymentId);
    }

    const { blocks, text } = buildErrorBlocks(git, channelConfig);
    await slack.postMessageFull(channelConfig.channelId, blocks, text);

    log.info({ branch: git.branch, sha: git.sha, channel: channelConfig.channelName }, 'Deploy error notification sent');
  }

  // --- Express handler ---

  async function webhookHandler(req: Request, res: Response): Promise<void> {
    // Verify signature
    if (vercelSecret) {
      const signature = req.headers['x-vercel-signature'] as string | undefined;
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;

      if (!signature || !rawBody || !verifySignature(rawBody, signature)) {
        log.warn({ hasSignature: !!signature, hasRawBody: !!rawBody }, 'Invalid Vercel webhook signature');
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }
    }

    const body = req.body as VercelWebhookPayload;
    const eventType = body.type;

    if (!eventType || !body.payload?.deployment) {
      log.warn({ bodyKeys: Object.keys(req.body) }, 'Invalid webhook payload');
      res.status(400).json({ error: 'Invalid payload' });
      return;
    }

    // Respond immediately
    res.status(200).json({ status: 'accepted' });

    // Process async
    try {
      switch (eventType) {
        case 'deployment.created':
          await handleDeploymentCreated(body.payload);
          break;
        case 'deployment.succeeded':
          await handleDeploymentSucceeded(body.payload);
          break;
        case 'deployment.error':
          await handleDeploymentError(body.payload);
          break;
        default:
          log.info({ eventType }, 'Ignoring unhandled Vercel event type');
      }
    } catch (err) {
      log.error({ err, eventType }, 'Error processing Vercel webhook');
    }
  }

  return { webhookHandler };
}

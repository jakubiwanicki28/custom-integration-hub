import { createHmac, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import type { OrgContext } from '../../lib/org-context.js';
import { createGitHubClient } from '../../lib/github.js';
import type { GitHubCommit } from '../../lib/github.js';
import type { SlackBlock } from '../../lib/slack.js';
import { chatCompletion } from '../../lib/openrouter.js';
import { config } from '../../config.js';
import { fetchWithTimeout } from '../../lib/fetch.js';
import { metrics } from '../../lib/metrics.js';
import type { SlackSlashCommandPayload, PRConfig } from './types.js';

export function createHandler(ctx: OrgContext) {
  if (!ctx.clients.slack) throw new Error('github-pr-automation requires Slack client');
  if (!ctx.credentials.github) throw new Error('github-pr-automation requires GitHub token');

  const slack = ctx.clients.slack;
  const log = ctx.log.child({ integration: 'github-pr-automation' });
  const signingSecret = ctx.credentials.slack.signingSecret;

  // Config from organizations.json
  const prConfig: PRConfig = {
    githubOwner: ctx.integrationConfig.githubOwner as string,
    githubRepo: ctx.integrationConfig.githubRepo as string,
    allowedChannelId: ctx.integrationConfig.allowedChannelId as string,
    allowedUserIds: ctx.integrationConfig.allowedUserIds as string[],
    baseBranch: ctx.integrationConfig.baseBranch as string || 'main',
    headBranch: ctx.integrationConfig.headBranch as string || 'dev',
    notificationChannelId: ctx.integrationConfig.notificationChannelId as string,
  };

  const github = createGitHubClient(
    ctx.credentials.github.token, prConfig.githubOwner, prConfig.githubRepo, log,
  );

  // --- Slack signature verification (HMAC-SHA256) ---

  function verifySlackSignature(rawBody: Buffer, timestamp: string, signature: string): boolean {
    // Anti-replay: reject if timestamp is older than 5 minutes
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - Number(timestamp)) > 300) {
      log.warn({ timestamp, now }, 'Slack request timestamp too old');
      return false;
    }

    const sigBasestring = `v0:${timestamp}:${rawBody.toString('utf-8')}`;
    const expected = 'v0=' + createHmac('sha256', signingSecret).update(sigBasestring).digest('hex');

    if (signature.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }

  // --- AI PR description generation ---

  async function generatePRDescription(
    commits: GitHubCommit[], userContext: string,
  ): Promise<{ title: string; body: string } | null> {
    const commitList = commits
      .map(c => `- ${c.sha} ${c.message} (${c.author}, ${c.date.split('T')[0]})`)
      .join('\n');

    const systemPrompt = `You are a technical writer creating GitHub pull request descriptions for a web application. Generate a PR title and description based on the provided commits.

Output format (EXACTLY):
Line 1: PR title (under 70 characters, business-focused, no prefix like "PR:" or "feat:")
Line 2: (empty)
Line 3+: Markdown body

The markdown body must include:
## Summary
- 2-3 bullet points describing the changes from a business/product perspective

## Changes
Group commits by type. Use these categories as needed:
- **Features** — new functionality
- **Fixes** — bug fixes
- **Improvements** — refactors, performance, UX enhancements
- **Other** — chores, docs, config changes

Be concise. Focus on what changed and why it matters, not implementation details.`;

    let userMessage = `Commits between main and dev:\n${commitList}`;
    if (userContext.trim()) {
      userMessage += `\n\nAdditional context from the developer: ${userContext.trim()}`;
    }
    userMessage += '\n\nGenerate the PR title and description.';

    try {
      const result = await chatCompletion(config.openrouter.model, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ]);

      if (!result) return null;

      // Parse: first line = title, rest = body
      const lines = result.trim().split('\n');
      const title = lines[0].trim();
      const body = lines.slice(1).join('\n').trim();

      return { title: title || `Deploy: ${commits.length} changes from dev`, body };
    } catch (err) {
      log.error({ err }, 'AI PR description generation failed');
      return null;
    }
  }

  // --- Slack response_url follow-up ---

  async function respondToSlack(
    responseUrl: string,
    text: string,
    responseType: 'ephemeral' | 'in_channel' = 'ephemeral',
  ): Promise<void> {
    try {
      await fetchWithTimeout(responseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response_type: responseType, text }),
      });
    } catch (err) {
      log.error({ err }, 'Failed to respond to Slack response_url');
    }
  }

  // --- Main async pipeline ---

  async function processSlashCommand(payload: SlackSlashCommandPayload): Promise<void> {
    const trackStart = Date.now();

    try {
      // 1. Compare branches
      const comparison = await github.compareCommits(prConfig.baseBranch, prConfig.headBranch);

      if (!comparison || comparison.totalCommits === 0) {
        await respondToSlack(
          payload.response_url,
          `No new commits on \`${prConfig.headBranch}\` compared to \`${prConfig.baseBranch}\`.`,
        );
        metrics.track({
          integration: 'github-pr-automation', org: ctx.org.id,
          event: 'skip', durationMs: Date.now() - trackStart,
          meta: { reason: 'no-diff' },
        });
        return;
      }

      // 2. Generate AI description
      const description = await generatePRDescription(comparison.commits, payload.text);

      // Fallback if AI fails
      const title = description?.title || `Deploy: ${comparison.totalCommits} changes from dev`;
      const body = description?.body || comparison.commits
        .map(c => `- ${c.message} (${c.author})`)
        .join('\n');

      // 3. Create PR
      const pr = await github.createPullRequest(
        title, body, prConfig.headBranch, prConfig.baseBranch,
      );

      if (pr) {
        // PR created — notify via response_url and channel
        await respondToSlack(
          payload.response_url,
          `PR created: <${pr.html_url}|#${pr.number} — ${pr.title}>`,
          'in_channel',
        );

        // Post Block Kit message to notification channel
        const blocks: SlackBlock[] = [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Pull Request Created — ${prConfig.githubRepo}*\n` +
                `\`${prConfig.headBranch}\` → \`${prConfig.baseBranch}\` · ${comparison.totalCommits} commit${comparison.totalCommits !== 1 ? 's' : ''}\n` +
                `*${pr.title}*`,
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'View PR on GitHub' },
                url: pr.html_url,
                style: 'primary',
                action_id: 'view_pr',
              },
            ],
          },
        ];

        await slack.postMessage(
          prConfig.notificationChannelId,
          blocks,
          `PR #${pr.number}: ${pr.title} — ${pr.html_url}`,
        ).catch(err => {
          log.error({ err, channel: prConfig.notificationChannelId }, 'Failed to post PR notification');
        });

        log.info({ prNumber: pr.number, prUrl: pr.html_url, commits: comparison.totalCommits }, 'PR created');
        metrics.track({
          integration: 'github-pr-automation', org: ctx.org.id,
          event: 'success', durationMs: Date.now() - trackStart,
          meta: { prNumber: String(pr.number), commits: String(comparison.totalCommits) },
        });
      } else {
        // PR likely already exists (422) — find it
        const existing = await github.listOpenPullRequests(prConfig.headBranch, prConfig.baseBranch);

        if (existing.length > 0) {
          const existingPr = existing[0];
          await respondToSlack(
            payload.response_url,
            `PR already exists: <${existingPr.html_url}|#${existingPr.number} — ${existingPr.title}>`,
          );
          log.info({ prNumber: existingPr.number }, 'PR already exists');
          metrics.track({
            integration: 'github-pr-automation', org: ctx.org.id,
            event: 'success', durationMs: Date.now() - trackStart,
            meta: { existing: 'true', prNumber: String(existingPr.number) },
          });
        } else {
          await respondToSlack(payload.response_url, 'Failed to create PR. Check logs for details.');
          metrics.track({
            integration: 'github-pr-automation', org: ctx.org.id,
            event: 'error', durationMs: Date.now() - trackStart,
          });
        }
      }
    } catch (err) {
      log.error({ err }, 'Error in PR automation pipeline');
      await respondToSlack(payload.response_url, 'Failed to create PR. Try again later.').catch(() => {});
      metrics.track({
        integration: 'github-pr-automation', org: ctx.org.id,
        event: 'error', durationMs: Date.now() - trackStart,
      });
    }
  }

  // --- Express handler ---

  async function slashCommandHandler(req: Request, res: Response): Promise<void> {
    // 1. Verify Slack signature (mandatory — no bypass)
    if (!signingSecret) {
      log.error('Slack signing secret not configured — rejecting request');
      res.status(500).json({ error: 'Integration misconfigured' });
      return;
    }

    const timestamp = req.headers['x-slack-request-timestamp'] as string | undefined;
    const signature = req.headers['x-slack-signature'] as string | undefined;
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;

    if (!timestamp || !signature || !rawBody || !verifySlackSignature(rawBody, timestamp, signature)) {
      log.warn({ hasTimestamp: !!timestamp, hasSignature: !!signature, hasRawBody: !!rawBody }, 'Invalid Slack signature');
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    const payload = req.body as SlackSlashCommandPayload;

    // 2. Channel whitelist
    if (payload.channel_id !== prConfig.allowedChannelId) {
      res.status(200).json({
        response_type: 'ephemeral',
        text: `This command can only be used in <#${prConfig.allowedChannelId}>`,
      });
      return;
    }

    // 3. User whitelist
    if (!prConfig.allowedUserIds.includes(payload.user_id)) {
      res.status(200).json({
        response_type: 'ephemeral',
        text: 'You don\'t have permission to use this command.',
      });
      return;
    }

    // 4. Respond immediately (Slack 3s requirement)
    res.status(200).json({
      response_type: 'ephemeral',
      text: `Creating PR \`${prConfig.headBranch}\` → \`${prConfig.baseBranch}\`...`,
    });

    // 5. Process async
    processSlashCommand(payload).catch(err => {
      log.error({ err }, 'Unhandled error in slash command processing');
    });
  }

  return { slashCommandHandler };
}

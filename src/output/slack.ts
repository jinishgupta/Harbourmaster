// ═══════════════════════════════════════════════════════════════
//  Harbourmaster — Slack Deploy Notification
// ═══════════════════════════════════════════════════════════════

import { WebClient } from '@slack/web-api';
import type { Verdict, CheckOptions, ReadinessSnapshot } from '../types.js';

// ─── Post Notification ──────────────────────────────────────

export async function postSlackNotification(
  snapshot: ReadinessSnapshot,
  verdict: Verdict,
  options: CheckOptions
): Promise<void> {
  const token = process.env.SLACK_TOKEN;
  const channelId = process.env.SLACK_CHANNEL_ID;

  if (!token || !channelId) {
    return; // Silently skip if Slack is not configured
  }

  const slack = new WebClient(token);

  const emoji = verdict.verdict === 'GO' ? '✅' : verdict.verdict === 'CAUTION' ? '🟡' : '🔴';
  const service = options.service || 'default-service';
  const release = options.release || 'latest';
  const time = new Date().toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  const statusColor =
    verdict.verdict === 'GO'
      ? '#10B981'
      : verdict.verdict === 'CAUTION'
        ? '#F59E0B'
        : '#EF4444';

  // Build source check summary
  const sourceChecks = [
    `${getIcon(snapshot.github.status)} GitHub: ${snapshot.github.summary}`,
    `${getIcon(snapshot.sentry.status)} Sentry: ${snapshot.sentry.summary}`,
    `${getIcon(snapshot.datadog.status)} Datadog: ${snapshot.datadog.summary}`,
    `${getIcon(snapshot.pagerduty.status)} PagerDuty: ${snapshot.pagerduty.summary}`,
    `${getIcon(snapshot.statusgator.status)} StatusGator: ${snapshot.statusgator.summary}`,
    `${getIcon(snapshot.linear.status)} Linear: ${snapshot.linear.summary}`,
  ].join('\n');

  try {
    await slack.chat.postMessage({
      channel: channelId,
      text: `${emoji} ${verdict.verdict} · ${service} ${release}`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: `${emoji} ${verdict.verdict} · ${service} ${release}`,
            emoji: true,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: verdict.reasoning,
          },
        },
        {
          type: 'divider',
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: sourceChecks,
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `⚓ Harbourmaster · Risk Score: ${verdict.riskScore}/100 · ${time}`,
            },
          ],
        },
      ],
      unfurl_links: false,
    });
  } catch (error) {
    // Don't fail the whole check if Slack notification fails
    console.error(`Slack notification failed: ${(error as Error).message}`);
  }
}

// ─── Utility ────────────────────────────────────────────────

function getIcon(status: string): string {
  switch (status) {
    case 'pass':
      return '✅';
    case 'warn':
      return '⚠️';
    case 'fail':
      return '🔴';
    default:
      return '❓';
  }
}

// ═══════════════════════════════════════════════════════════════
//  Harbourmaster — Terminal Output Renderer
// ═══════════════════════════════════════════════════════════════

import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';
import Table from 'cli-table3';
import type {
  ReadinessSnapshot,
  Verdict,
  SourceCheck,
  CheckOptions,
  SourceStatus,
} from '../types.js';

// ─── Theme Colors ───────────────────────────────────────────

const theme = {
  // Primary palette
  brand: chalk.hex('#7C3AED'),        // Vibrant purple
  brandBold: chalk.hex('#7C3AED').bold,
  accent: chalk.hex('#06B6D4'),       // Cyan accent
  
  // Status colors
  go: chalk.hex('#10B981'),           // Emerald green
  goBg: chalk.bgHex('#10B981').hex('#000000').bold,
  caution: chalk.hex('#F59E0B'),      // Amber
  cautionBg: chalk.bgHex('#F59E0B').hex('#000000').bold,
  hold: chalk.hex('#EF4444'),         // Red
  holdBg: chalk.bgHex('#EF4444').hex('#FFFFFF').bold,
  
  // Text
  dim: chalk.hex('#6B7280'),          // Gray-500
  muted: chalk.hex('#9CA3AF'),        // Gray-400
  bright: chalk.hex('#F9FAFB'),       // Gray-50
  white: chalk.white,
  
  // Source labels
  github: chalk.hex('#E5E7EB'),
  sentry: chalk.hex('#E5E7EB'),
  datadog: chalk.hex('#E5E7EB'),
  pagerduty: chalk.hex('#E5E7EB'),
  statusgator: chalk.hex('#E5E7EB'),
  linear: chalk.hex('#E5E7EB'),
};

// ─── Icons ──────────────────────────────────────────────────

const icons: Record<SourceStatus, string> = {
  pass: '[PASS]',
  warn: '[WARN]',
  fail: '[FAIL]',
};

const verdictIcons: Record<string, string> = {
  GO: '[GO]',
  CAUTION: '[CAUTION]',
  HOLD: '[HOLD]',
};

// ─── Header ─────────────────────────────────────────────────

export function renderHeader(options: CheckOptions): void {
  const title = theme.brandBold('HARBOURMASTER CHECK');
  const meta = [
    options.service ? `service: ${theme.accent(options.service)}` : null,
    options.release ? `release: ${theme.accent(options.release)}` : null,
    options.branch ? `branch: ${theme.accent(options.branch || 'main')}` : `branch: ${theme.accent('main')}`,
  ]
    .filter(Boolean)
    .join('   ');

  console.log('');
  console.log(
    boxen(`${title}\n${meta}`, {
      padding: { top: 0, bottom: 0, left: 2, right: 2 },
      borderStyle: 'round',
      borderColor: '#7C3AED',
      dimBorder: false,
    })
  );
  console.log('');
}

// ─── Spinner ────────────────────────────────────────────────

export function createSpinner(text: string) {
  return ora({
    text: theme.dim(text),
    spinner: 'dots12',
    color: 'magenta',
  });
}

// ─── Source Check Line ──────────────────────────────────────

export function renderSourceCheck(check: SourceCheck): void {
  const icon = icons[check.status];
  const sourceLabel = check.source.charAt(0).toUpperCase() + check.source.slice(1);
  const paddedLabel = sourceLabel.padEnd(12);

  let summaryStyled: string;
  switch (check.status) {
    case 'pass':
      summaryStyled = theme.go(check.summary);
      break;
    case 'warn':
      summaryStyled = theme.caution(check.summary);
      break;
    case 'fail':
      summaryStyled = theme.hold(check.summary);
      break;
  }

  console.log(`  ${icon}  ${theme.bright(paddedLabel)} ${summaryStyled}`);
}

// ─── Risk Score Bar ─────────────────────────────────────────

export function renderRiskScore(score: number): void {
  const barLength = 30;
  const filled = Math.round((score / 100) * barLength);
  const empty = barLength - filled;

  let barColor: (text: string) => string;
  if (score <= 30) barColor = theme.go;
  else if (score <= 60) barColor = theme.caution;
  else barColor = theme.hold;

  const filledBar = barColor('█'.repeat(filled));
  const emptyBar = theme.dim('░'.repeat(empty));
  const scoreText = barColor(`${score}/100`);

  console.log(`  ${theme.dim('Risk Score:')}  ${filledBar}${emptyBar}  ${scoreText}`);
}

// ─── Verdict Box ────────────────────────────────────────────

export function renderVerdict(verdict: Verdict): void {
  const icon = verdictIcons[verdict.verdict] || '[?]';

  let verdictStyled: string;
  let borderColor: string;

  switch (verdict.verdict) {
    case 'GO':
      verdictStyled = theme.goBg(` ${icon} `);
      borderColor = '#10B981';
      break;
    case 'CAUTION':
      verdictStyled = theme.cautionBg(` ${icon} `);
      borderColor = '#F59E0B';
      break;
    case 'HOLD':
      verdictStyled = theme.holdBg(` ${icon} `);
      borderColor = '#EF4444';
      break;
    default:
      verdictStyled = verdict.verdict;
      borderColor = '#6B7280';
  }

  const confidenceText = theme.muted(`${verdict.confidence} confidence`);

  // Format reasoning with word wrap
  const wrappedReasoning = wordWrap(verdict.reasoning, 60);
  const reasoningStyled = wrappedReasoning
    .split('\n')
    .map((line) => `  ${theme.white(line)}`)
    .join('\n');

  // On-call info
  const onCallText =
    verdict.onCall.length > 0
      ? verdict.onCall
          .map((oc) => `${theme.accent(`@${oc.name}`)} ${theme.dim(`(${oc.service})`)}`)
          .join('  ')
      : theme.dim('No on-call data available');

  const content = [
    `${verdictStyled}  ·  ${confidenceText}`,
    '',
    reasoningStyled,
    '',
    `  ${theme.dim('On-call:')} ${onCallText}`,
  ].join('\n');

  console.log('');
  console.log(
    boxen(content, {
      padding: { top: 1, bottom: 1, left: 1, right: 1 },
      borderStyle: 'round',
      borderColor: borderColor,
      dimBorder: false,
    })
  );
}

// ─── Separator ──────────────────────────────────────────────

export function renderSeparator(): void {
  console.log(theme.dim('  ' + '─'.repeat(60)));
}

// ─── Full Render Pipeline ───────────────────────────────────

export function renderFullCheck(
  snapshot: ReadinessSnapshot,
  verdict: Verdict,
  options: CheckOptions,
  durationMs: number
): void {
  renderHeader(options);

  // Source checks
  renderSourceCheck(snapshot.github);
  renderSourceCheck(snapshot.sentry);
  renderSourceCheck(snapshot.datadog);
  renderSourceCheck(snapshot.pagerduty);
  renderSourceCheck(snapshot.statusgator);
  renderSourceCheck(snapshot.linear);

  renderSeparator();
  renderRiskScore(verdict.riskScore);
  renderVerdict(verdict);

  // Footer
  const duration = `${(durationMs / 1000).toFixed(1)}s`;
  console.log(
    theme.dim(`\n  Checked ${theme.accent('6 sources')} via Coral in ${theme.accent(duration)}`)
  );
  console.log(
    theme.dim(`  ${new Date().toLocaleTimeString('en-US', { hour12: true })} · ${snapshot.service} · ${snapshot.release}`)
  );
  console.log('');
}

// ─── JSON Output ────────────────────────────────────────────

export function renderJSON(
  snapshot: ReadinessSnapshot,
  verdict: Verdict
): void {
  const output = {
    timestamp: verdict.timestamp,
    service: snapshot.service,
    release: snapshot.release,
    branch: snapshot.branch,
    verdict: verdict.verdict,
    confidence: verdict.confidence,
    riskScore: verdict.riskScore,
    reasoning: verdict.reasoning,
    onCall: verdict.onCall,
    checks: {
      github: { status: snapshot.github.status, summary: snapshot.github.summary },
      sentry: { status: snapshot.sentry.status, summary: snapshot.sentry.summary },
      datadog: { status: snapshot.datadog.status, summary: snapshot.datadog.summary },
      pagerduty: { status: snapshot.pagerduty.status, summary: snapshot.pagerduty.summary },
      statusgator: { status: snapshot.statusgator.status, summary: snapshot.statusgator.summary },
      linear: { status: snapshot.linear.status, summary: snapshot.linear.summary },
    },
  };

  console.log(JSON.stringify(output, null, 2));
}

// ─── History Table ──────────────────────────────────────────

export function renderHistory(
  entries: Array<{
    timestamp: string;
    service: string;
    release: string;
    verdict: string;
    riskScore: number;
  }>
): void {
  if (entries.length === 0) {
    console.log(theme.dim('\n  No deploy checks recorded yet.\n'));
    return;
  }

  const table = new Table({
    head: [
      theme.brand('Time'),
      theme.brand('Service'),
      theme.brand('Release'),
      theme.brand('Verdict'),
      theme.brand('Risk'),
    ],
    style: { head: [], border: ['gray'] },
    chars: {
      top: '─', 'top-mid': '┬', 'top-left': '┌', 'top-right': '┐',
      bottom: '─', 'bottom-mid': '┴', 'bottom-left': '└', 'bottom-right': '┘',
      left: '│', 'left-mid': '├', mid: '─', 'mid-mid': '┼',
      right: '│', 'right-mid': '┤', middle: '│',
    },
  });

  for (const entry of entries) {
    const time = new Date(entry.timestamp).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

    let verdictStyled: string;
    switch (entry.verdict) {
      case 'GO':
        verdictStyled = theme.go('🟢 GO');
        break;
      case 'CAUTION':
        verdictStyled = theme.caution('🟡 CAUTION');
        break;
      case 'HOLD':
        verdictStyled = theme.hold('🔴 HOLD');
        break;
      default:
        verdictStyled = entry.verdict;
    }

    table.push([time, entry.service, entry.release, verdictStyled, `${entry.riskScore}/100`]);
  }

    console.log('');
  console.log(theme.brandBold('  Deploy History'));
  console.log(table.toString());
  console.log('');
}

// ─── Watch Mode Header ─────────────────────────────────────

export function renderWatchHeader(interval: number): void {
  console.log(
    boxen(
      `${theme.brandBold('HARBOURMASTER WATCH')}\n${theme.dim(`Checking every ${interval}s · Press Ctrl+C to stop`)}`,
      {
        padding: { top: 0, bottom: 0, left: 2, right: 2 },
        borderStyle: 'round',
        borderColor: '#7C3AED',
      }
    )
  );
}

// ─── Error Display ──────────────────────────────────────────

export function renderError(message: string, hint?: string): void {
  console.error('');
  console.error(
    boxen(
      `${theme.hold('[ERROR]')}\n\n  ${theme.white(message)}${hint ? `\n\n  ${theme.dim(hint)}` : ''}`,
      {
        padding: { top: 0, bottom: 0, left: 1, right: 1 },
        borderStyle: 'round',
        borderColor: '#EF4444',
      }
    )
  );
  console.error('');
}

// ─── Utilities ──────────────────────────────────────────────

function wordWrap(text: string, maxWidth: number): string {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if (currentLine.length + word.length + 1 > maxWidth) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = currentLine ? `${currentLine} ${word}` : word;
    }
  }
  if (currentLine) lines.push(currentLine);

  return lines.join('\n');
}

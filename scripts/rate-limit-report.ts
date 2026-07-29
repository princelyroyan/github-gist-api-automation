/**
 * Records GitHub rate-limit usage into the Allure report's Environment panel.
 *
 *   tsx scripts/rate-limit-report.ts --before    # snapshot before the run
 *   tsx scripts/rate-limit-report.ts             # snapshot after, write results
 *
 * Two numbers are worth having in a report against a live third-party API: how
 * many requests the run used, and how many are left. The first should be a
 * measurement rather than an estimate that quietly drifts as tests are added.
 *
 * GET /rate_limit does not itself count against either budget, so measuring is
 * free.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { env } from '../src/config/env';

const RESULTS_DIR = 'allure-results';
const SNAPSHOT = '.rate-limit-snapshot.json';

type Core = { limit: number; remaining: number; used: number; reset: number };
type Snapshot = Record<string, Core>;

/** The three personas the suite draws on. Anonymous is keyed by IP, not by token. */
const PERSONAS: Array<{ key: string; label: string; token?: string }> = [
  { key: 'account_a', label: 'account A', token: env.tokenOwner },
  { key: 'account_b', label: 'account B', token: env.tokenOther },
  { key: 'anonymous', label: 'anonymous', token: undefined },
];

async function core(token?: string): Promise<Core> {
  const response = await fetch(`${env.baseUrl}/rate_limit`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': env.apiVersion,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`GET /rate_limit -> ${response.status}`);
  const body = (await response.json()) as { resources: { core: Core } };
  return body.resources.core;
}

async function snapshot(): Promise<Snapshot> {
  const entries = await Promise.all(
    PERSONAS.map(async ({ key, token }) => [key, await core(token)] as const),
  );
  return Object.fromEntries(entries);
}

async function main() {
  const isBefore = process.argv.includes('--before');
  const now = await snapshot();

  if (isBefore) {
    writeFileSync(SNAPSHOT, JSON.stringify(now, null, 2));
    console.log('Rate-limit snapshot recorded:');
    for (const { key, label } of PERSONAS) {
      console.log(`  ${label.padEnd(10)} ${now[key].remaining}/${now[key].limit} available`);
    }
    return;
  }

  const before: Snapshot | null = existsSync(SNAPSHOT)
    ? JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
    : null;

  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });

  const lines: string[] = [];
  console.log('\nAPI requests:');

  for (const { key, label } of PERSONAS) {
    const after = now[key];
    const was = before?.[key];

    // A window that rolled over mid-run makes the difference meaningless — say
    // so rather than reporting a negative or wildly inflated number.
    const used = was && was.reset === after.reset ? was.remaining - after.remaining : null;

    // Keys stay short and the detail goes in the value: Allure's Environment
    // panel truncates the key column, so `account_a_requests_used_this_run`
    // renders as `account_a_req…` and tells the reader nothing.
    const usedText = used === null ? 'usage unknown (window reset mid-run)' : `${used} used`;
    lines.push(`${key}=${usedText}, ${after.remaining} of ${after.limit} left`);

    console.log(
      `  ${label.padEnd(10)} used ${String(used ?? '?').padStart(4)}` +
        `   left ${String(after.remaining).padStart(4)} of ${after.limit}`,
    );
  }

  const anon = now.anonymous;
  const anonUsed =
    before && before.anonymous.reset === anon.reset
      ? before.anonymous.remaining - anon.remaining
      : null;

  if (anonUsed && anonUsed > 0) {
    // How many runs the anonymous hourly budget alone would allow. This is a
    // ceiling, not a promise — see the label below.
    const runsLeft = Math.floor(anon.remaining / anonUsed);
    // Labelled for what it measures. The hourly anonymous budget is NOT the real
    // cap on run frequency — GitHub's secondary limit on burst content creation
    // blocks a second back-to-back run while this counter still reads healthy.
    // See docs/findings.md #20.
    lines.push(`anon_budget_allows=~${runsLeft} more runs this hour (secondary write limit applies separately)`);
    console.log(
      `\n  anonymous budget allows ~${runsLeft} more runs this hour` +
        '\n  (the secondary write limit is separate — space full runs a few minutes apart)',
    );
  }

  lines.push(`resets_at=${new Date(anon.reset * 1000).toISOString()} (anonymous budget)`);

  // Rewrite rather than blindly append: running this twice against one test run
  // would otherwise leave duplicate keys in the Environment panel.
  const file = `${RESULTS_DIR}/environment.properties`;
  const ours = new Set(lines.map((l) => l.split('=')[0]));
  const kept = existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim() && !ours.has(l.split('=')[0]))
    : [];

  writeFileSync(file, `${[...kept, ...lines].join('\n')}\n`);
  console.log(`\nWritten to ${file}`);
}

main().catch((error) => {
  // Never fail a run over reporting metadata.
  console.error('Rate-limit reporting failed (non-fatal):', error.message);
});
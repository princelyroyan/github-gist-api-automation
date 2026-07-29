/**
 * Writes a run summary to the GitHub Actions run page.
 *
 *   tsx scripts/job-summary.ts        # prints to stdout locally
 *
 * Anything written to $GITHUB_STEP_SUMMARY is rendered as markdown on the run
 * page itself, so the headline numbers are visible without downloading anything.
 * That matters because an artifact link cannot render HTML — clicking it returns
 * a zip — so the report alone would tell you nothing until you unpacked it.
 *
 * Reads what the run already produced; it never calls the API.
 */
import { existsSync, readFileSync, readdirSync, appendFileSync } from 'node:fs';

const RESULTS = 'allure-results';
const REPORT = 'allure-report';

type Result = { name: string; status: string; statusDetails?: { message?: string } };

function readResults(): Result[] {
  if (!existsSync(RESULTS)) return [];
  return readdirSync(RESULTS)
    .filter((f) => f.endsWith('-result.json'))
    .map((f) => JSON.parse(readFileSync(`${RESULTS}/${f}`, 'utf8')) as Result);
}

function readEnvironment(): Array<[string, string]> {
  const file = `${RESULTS}/environment.properties`;
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)] as [string, string];
    });
}

function duration(): string {
  const file = `${REPORT}/summary.json`;
  if (!existsSync(file)) return '—';
  const ms = JSON.parse(readFileSync(file, 'utf8')).duration;
  return typeof ms === 'number' ? `${(ms / 1000).toFixed(1)}s` : '—';
}

/** Collapses a multi-line assertion error to something that fits a table cell. */
function firstLine(message = ''): string {
  return message.split('\n')[0].replace(/\|/g, '\\|').slice(0, 140) || '—';
}

function main() {
  const results = readResults();
  const failed = results.filter((r) => r.status !== 'passed');
  const passed = results.length - failed.length;
  const ok = failed.length === 0 && results.length > 0;

  const md: string[] = [];

  md.push(
    results.length === 0
      ? '## ⚠️ API tests — no results found'
      : `## ${ok ? '✅' : '❌'} API tests — ${passed} passed, ${failed.length} failed`,
    '',
    `Suite: **${process.env.SUITE ?? 'full'}** · Duration: **${duration()}** · Tests: **${results.length}**`,
    '',
  );

  if (failed.length) {
    md.push('### Failures', '', '| Test | Reason |', '|---|---|');
    for (const f of failed.sort((a, b) => a.name.localeCompare(b.name))) {
      md.push(`| ${f.name.replace(/\|/g, '\\|')} | ${firstLine(f.statusDetails?.message)} |`);
    }
    md.push('');
  }

  const env = readEnvironment();
  if (env.length) {
    md.push('### Environment and API budget', '', '| | |', '|---|---|');
    for (const [k, v] of env) md.push(`| \`${k}\` | ${v} |`);
    md.push('');
  }

  // Artifact links download a zip rather than rendering — labelled so nobody
  // clicks one expecting the report to open in the browser.
  const links: string[] = [];
  if (process.env.ALLURE_ARTIFACT_URL) {
    links.push(`[📦 Allure report (downloads a zip)](${process.env.ALLURE_ARTIFACT_URL})`);
  }
  if (process.env.PLAYWRIGHT_ARTIFACT_URL) {
    links.push(`[📦 Playwright report + JUnit](${process.env.PLAYWRIGHT_ARTIFACT_URL})`);
  }
  if (links.length) md.push(links.join(' · '), '');

  const out = md.join('\n');
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (target) {
    appendFileSync(target, `${out}\n`);
    console.log(`Summary written (${passed} passed, ${failed.length} failed).`);
  } else {
    console.log(out);
  }
}

main();

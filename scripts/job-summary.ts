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

/** Escapes markdown table delimiters so a message containing `|` cannot break a row. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

const STATUS_ICON: Record<string, string> = {
  passed: '✅',
  failed: '❌',
  broken: '💥',
  skipped: '⏭️',
};

const AREAS: Array<[string, string]> = [
  ['AUTH', 'Authentication and authorization'],
  ['CRE', 'Create'],
  ['RD', 'Read'],
  ['UPD', 'Update'],
  ['DEL', 'Delete'],
  ['STR', 'Star'],
  ['FRK', 'Fork'],
  ['REV', 'Revisions'],
  ['CMT', 'Comments'],
  ['PAG', 'Pagination and filtering'],
  ['SCH', 'Contract'],
  ['NFR', 'Non-functional'],
];

/**
 * Splits a test title into its catalogue id and its prose.
 *
 * Titles start with the id from docs/test-cases.md, which is what makes the CI
 * output traceable back to the catalogue. A few tests deliberately cover several
 * cases at once — `STR-01/02/03/06 walks the full star state machine` is one
 * test for a four-state machine — so the id is kept verbatim rather than
 * pretending it is a single case.
 */
function parseTitle(name: string): { id: string; title: string; area: string } {
  const m = name.match(/^([A-Z]{2,4}-\d{2}(?:\/\d{2})*)\s+(.*)$/);
  const id = m ? m[1] : '—';
  const rest = m ? m[2] : name;
  return {
    id,
    title: rest.replace(/\s*@\w+/g, '').trim(),
    area: id.split('-')[0],
  };
}

function main() {
  const results = readResults();
  // Skipped is its own outcome, not a failure. The anonymous personas skip when
  // the shared-runner IP budget cannot cover them (docs/findings.md #22), and
  // folding those into the failure count would make a budget problem read as a
  // broken suite — the exact confusion the rest of the harness works to avoid.
  const skipped = results.filter((r) => r.status === 'skipped');
  const failed = results.filter((r) => r.status !== 'passed' && r.status !== 'skipped');
  const passed = results.length - failed.length - skipped.length;
  const ok = failed.length === 0 && results.length > 0;

  const md: string[] = [];

  md.push(
    results.length === 0
      ? '## ⚠️ API tests — no results found'
      : `## ${ok ? '✅' : '❌'} API tests — ${passed} passed, ${failed.length} failed` +
        (skipped.length ? `, ${skipped.length} skipped` : ''),
    '',
    `Suite: **${process.env.SUITE ?? 'full'}** · Duration: **${duration()}** · Tests: **${results.length}**`,
    '',
  );

  // Never collapsed. A skipped test is coverage that did not run, and the whole
  // point of skipping rather than failing is lost if nobody sees it happen.
  if (skipped.length) {
    md.push(
      `### ⏭️ Skipped — ${skipped.length} test${skipped.length === 1 ? '' : 's'} did not run`,
      '',
      '| Test | Why |',
      '|---|---|',
    );
    for (const s of skipped.sort((a, b) => a.name.localeCompare(b.name))) {
      md.push(`| ${cell(s.name)} | ${firstLine(s.statusDetails?.message)} |`);
    }
    md.push('');
  }

  if (failed.length) {
    md.push('### Failures', '', '| Test | Reason |', '|---|---|');
    for (const f of failed.sort((a, b) => a.name.localeCompare(b.name))) {
      md.push(`| ${f.name.replace(/\|/g, '\\|')} | ${firstLine(f.statusDetails?.message)} |`);
    }
    md.push('');
  }

  // Every test, grouped by area to mirror docs/test-cases.md. Collapsed on
  // purpose: 86 rows on a green run would bury the two that actually matter, and
  // the Failures table above is the signal. This is the reference, one click away.
  if (results.length) {
    const parsed = results
      .map((r) => ({ ...parseTitle(r.name), status: r.status, details: r.statusDetails?.message }))
      .sort((a, b) => a.id.localeCompare(b.id));

    md.push(
      '<details>',
      `<summary><b>All test cases (${results.length})</b></summary>`,
      '',
    );

    const known = new Set(AREAS.map(([prefix]) => prefix));
    const groups: Array<[string, typeof parsed]> = AREAS.map(([prefix, label]) => [
      label,
      parsed.filter((t) => t.area === prefix),
    ]);
    const orphans = parsed.filter((t) => !known.has(t.area));
    if (orphans.length) groups.push(['Other', orphans]);

    for (const [label, tests] of groups) {
      if (!tests.length) continue;
      md.push(`#### ${label}`, '', '| ID | Test | Status | Error |', '|---|---|---|---|');
      for (const t of tests) {
        const icon = STATUS_ICON[t.status] ?? t.status;
        const error = t.status === 'passed' ? '—' : firstLine(t.details);
        md.push(`| \`${t.id}\` | ${cell(t.title)} | ${icon} | ${error} |`);
      }
      md.push('');
    }

    md.push('</details>', '');
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

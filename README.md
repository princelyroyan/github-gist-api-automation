# GitHub Gists — API test automation

An API-first test suite for the [GitHub Gists REST API](https://docs.github.com/en/rest/gists),
built with Playwright and TypeScript.

The system under test is a **live, third-party, production API**. There is no staging
environment, no database access, and no control over releases. Every design decision in
here follows from that: tests provision their own data, clean up after themselves,
assert on invariants rather than shared global state, and stay inside GitHub's rate
limits by construction.

## Quick start

```bash
npm install
cp .env.example .env      # then fill in two tokens
npm run test:smoke        # P0 only, ~1m
npm test                  # everything, ~3m — mostly write pacing, see below
npm run allure:serve      # results as an Allure report
```

### Tokens

Two GitHub accounts are required. Account A owns the gists under test; account B exists
to prove that a second user cannot read or write them. A third persona — anonymous, no
token — is exercised with no configuration at all.

For each account: **Settings → Developer settings → Personal access tokens →
Fine-grained tokens**, then **Account permissions → Gists: Read and write**, expiry 7
days. A classic token with the `gist` scope also works; fine-grained is GitHub's
recommended path and expires by default, which is the better hygiene story.

`.env` is gitignored. Nothing in this repo should ever contain a live token.

## Layout

```
src/
  config/env.ts             typed env loading, fails fast on missing config
  clients/                  one method per endpoint, no assertions
  models/                   request types + Zod response schemas
  builders/                 valid-by-default payloads with targeted overrides
  fixtures/api.fixtures.ts  personas, and the factory that guarantees cleanup
  utils/                    unique naming, schema/status assertions, polling,
                            write pacing and throttle back-off
tests/api/                  specs, one file per behaviour area
scripts/cleanup.ts          removes leaked qa-auto-* gists
postman/                    the exploration collection this suite grew out of
docs/                       strategy, test cases, findings
```

### The two rules that keep it maintainable

**Clients never assert. Specs never build URLs.** If a spec contains a string starting
with `/gists`, the abstraction has leaked. If a client contains `expect`, a failure will
report the wrong thing.

| Layer | Responsibility | Must not |
|---|---|---|
| Spec | Arrange–Act–Assert in business language | Contain URLs, headers, or raw JSON |
| Client | One method per endpoint, returns the raw response | Contain assertions |
| Schema | Runtime shape validation | Contain business logic |
| Builder | Valid-by-default payloads | Call the API |
| Fixture | Provision data and guarantee cleanup | Contain assertions |

## Personas

Authorization is an equivalence partition, so it is modelled as fixtures rather than a
token threaded through every call. A spec declares the personas it needs:

| Fixture | Who |
|---|---|
| `ownerClient` | Account A — owns the data |
| `otherClient` | Account B — must be refused |
| `anonClient` | No token |
| `invalidTokenClient` | Garbage token |

## Test data

Three rules, all enforced by fixtures rather than by discipline:

1. **Every test provisions its own data.** No shared fixtures, no hard-coded gist IDs,
   no dependency on execution order. This is what makes `fullyParallel` safe.
2. **Unique, traceable naming.** Every artefact is described as
   `qa-auto-<date>-<runId>-<uuid>`, so an orphan can be traced back to the run that
   leaked it.
3. **Guaranteed teardown.** Cleanup lives in the fixture teardown phase, which Playwright
   runs even when the test throws. An `afterEach` can be skipped; a teardown cannot.

`npm run cleanup` covers what teardown cannot — a killed process or a crashed CI runner.
It is a dry run by default; pass `-- --apply` to actually delete.

## Tags

```
@smoke       P0 only — the PR gate
@P0 @P1 @P2  priority, per docs/test-cases.md
@contract    schema validation
@security    authorization boundaries
@drift       informational: fails when GitHub adds a field
@slow        forks and other multi-second flows
```

```bash
npm run test:smoke
npm run test:contract
npx playwright test --grep "@security"
```

## Rate limits

Three limits, not one, and the one that actually stops you is invisible to every counter.

**Primary budgets** — hourly, per token or per IP. Figures measured, not estimated:

| Persona | Budget | Keyed to | Used per run | Runs/hour |
|---|---|---|---|---|
| Account A | 5000/hr | token | ~220 | ~23 |
| Account B | 5000/hr | token | 13 | ~380 |
| **Anonymous** | **60/hr** | **IP address** | **8** | **~7** |

**Secondary limit** — a throttle on burst *content creation*, and the real cap on how often
this suite can run. It fires while `x-ratelimit-remaining` still reads healthy, and GitHub
sends no `retry-after`, so nothing tells you it is coming or when it lifts:

```
403 You have exceeded a secondary rate limit and have been temporarily
    blocked from content creation.
```

The caps are 80 content-generating requests per minute, 500 per hour, and 900 REST points
per minute (a write costs 5 points, a read 1). A full run makes ~170 writes — which,
issued as fast as four workers can, is **4× the per-minute cap inside a single run**. It
was never a matter of spacing runs apart: CI went red on two pushes 35 minutes apart, and
the same throttle also surfaces as `409 Gist cannot be updated` on a `PATCH` that lands too
soon after the previous write.

So the suite paces its own writes (`src/utils/write-throttle.ts`) to 70/min account-wide,
divided between the workers, and retries with back-off anything that comes back throttled
anyway. That is what makes a run take ~3 minutes rather than ~30 seconds; the 30-second
version was borrowing against the next run. `assertNotRateLimited` still names any throttle
that survives the retries, so it cannot be mistaken for a broken suite. Full write-up in
[`docs/findings.md`](docs/findings.md) #20 and #23.

What this does *not* solve: 500 writes/hour is ~3 full runs, and nothing rations them.

The anonymous limit binds first, so that persona is reserved for the eight tests where
being unauthenticated *is* the thing under test. Everything else — pagination, feed
ordering, not-found lookups — uses the authenticated client even on endpoints that need no
token. An earlier version spent ~20 anonymous requests per run and capped the suite at
roughly three runs an hour, with the overflow showing up as 403s on unrelated tests that
looked like product defects.

**On CI the anonymous budget is not ours.** It is keyed to the runner's IP address, which
is shared with every other job on that machine, so the "used per run" figure above predicts
nothing there — a nightly run began with 4 of 60 available and lost four tests to a budget
it had never spent. The anonymous personas therefore check the budget before running (via
`GET /rate_limit`, which counts against nothing) and **skip** rather than fail when it
cannot cover them. Skips are listed with their reason on the run page, because coverage
that quietly disappears is worse than a red build. See
[`docs/findings.md`](docs/findings.md) #22.

The generalisable point: on a shared, rate-limited, third-party API, *which persona a test
uses is a resource decision as much as a correctness one* — and a budget keyed to something
you do not control is not a budget you can plan against.

Other measures:

- Writes paced to a fixed rate, with the account-wide budget divided between the 4 workers
  — capping workers alone bounds concurrency, not the request *rate*, which is what the
  secondary limits actually measure.
- Fixtures reused across assertions instead of a fresh gist per expectation.
- Retries only in CI, and only once — a 4xx is never retried.
- Rate-limit headers are asserted (NFR-01) rather than deliberately exhausted.
- `assertNotRateLimited` turns an exhausted budget into one clear message naming the
  persona and reset time, instead of a scatter of unrelated assertion failures. It runs
  ahead of both `expectStatus` and `expectSchema`, so a throttled response cannot surface
  as a contract failure.

`npm run quota` prints the current budget for all three personas. `LOG_RATE_LIMIT=1 npm test`
logs the remaining budget after every individual call.

## Reporting

Three reporters run on every execution, because they answer different questions:

| Reporter | Output | For |
|---|---|---|
| `list` | terminal | watching a local run |
| `html` | `playwright-report/` | debugging a failure — carries the trace viewer |
| `junit` | `results.xml` | CI test-result parsing |
| `allure-playwright` | `allure-results/` | the readable report — grouping, trends, history |

```bash
npm test                  # writes allure-results/
npm run allure:serve      # generate + open in one step
npm run allure:generate   # write a browsable allure-report/ to disk
npm run allure:single     # write ONE self-contained allure-report/index.html
npm run allure:open       # serve an already-generated report
npm run test:allure       # test, measure quota, then generate
npm run clean             # remove every generated output directory
```

### Every run starts clean

Allure merges anything it finds — both stale result files and a previous report sitting in
the output directory. Left alone, a green run renders as *84 passed / 2 failed* because
last week's failures are still on disk. So every test script clears `allure-results/`
first, and `allure:generate` clears `allure-report/` before building.

The trade-off is that wiping discards Allure's history, so local trend graphs never
accumulate. That is the right call locally — a correct current report beats trends built
on stale data — but **in CI you want the opposite**: restore the previous run's `history/`
directory into `allure-results/` before generating, and trends, retry counts, and
flakiness tracking start working. That matters here, because the exit criteria in
[`docs/test-strategy.md`](docs/test-strategy.md) are stated as a flake rate over ten
consecutive runs, which is exactly what history is for.

`allure-report/` is ~3.7 MB across ~30 files. Those are the Allure viewer application —
JS chunks, fonts, CSS — not logs. `allure:single` collapses it into one 4.3 MB
`index.html` that opens straight from disk with no server, which is the easier thing to
attach to a CI artifact or send to someone.

Allure 3 is used rather than Allure 2 deliberately: the v2 CLI is a Java application, and
requiring a JDK to read a test report is a barrier for anyone picking this repo up. v3's
CLI is Node-native, so `npm install` is the only prerequisite.

`npm run test:allure` snapshots the rate limit before and after the run, so the report's
**Environment** panel carries both what the run used and what is left:

```
base_url     https://api.github.com
api_version  2026-03-10
account_a    217 used, 4582 of 5000 left
account_b    13 used, 4917 of 5000 left
anonymous    8 used, 7 of 60 left
runs_left    ~0 more this hour (anonymous-limited)
resets_at    2026-07-29 11:10:34 UTC (13:10 Europe/Berlin) (anonymous budget)
```

Keys are kept short on purpose — Allure's Environment panel truncates the key column, so
`account_a_requests_used_this_run` renders as `account_a_req…` and tells the reader
nothing. The detail belongs in the value.

Every time the suite prints is UTC and says so, with the local equivalent alongside — a
budget that "resets at 11:10Z" is arithmetic, and arithmetic at the moment a build goes red
is how people misread it. The local zone comes from the machine, or from `REPORT_TIMEZONE`
(an IANA name such as `Europe/Berlin`). On a CI runner the zone *is* UTC, so the
parenthetical is dropped rather than printed twice.

`GET /rate_limit` doesn't count against either budget, so measuring is free. If a
rate-limit window rolls over mid-run the difference would be meaningless, so it reports
`unknown (rate-limit window reset mid-run)` rather than a wrong number.

The API version is the other field that matters — a run against `2022-11-28` and one
against `2026-03-10` are testing materially different contracts (see SCH-10 and
[`docs/findings.md`](docs/findings.md) #12), so a report that doesn't say which is
misleading.

Tags carry through, so the report can be filtered by `@P0`, `@security`, `@contract`, and
the rest.

**Note:** passing `--reporter=...` on the command line *replaces* the configured reporter
list, Allure included. Use `npm test` rather than `npx playwright test --reporter=list` if
you want Allure results.

## CI

`.github/workflows/api-tests.yml` runs `@smoke` on pull requests, the full suite on
push to `main` and nightly at 01:00 UTC, and cleanup unconditionally afterwards.
Tokens come from repository secrets `GIST_TOKEN_A` / `GIST_TOKEN_B`.

That nightly targets **03:00 Europe/Berlin**. Actions cron is always UTC — there is no
timezone setting — so a fixed schedule moves by an hour locally across a DST change:
01:00 UTC is 03:00 Berlin under CEST and 02:00 under CET. It is also a *lower bound*, not
an appointment. Scheduled runs queue, and the nightlies previously set to 03:00 UTC began
at 04:05, 04:08 and 04:17 UTC — so expect a start nearer 04:00 Berlin than 03:00.

## Documents

- [`docs/test-strategy.md`](docs/test-strategy.md) — risk analysis, layering, constraints
- [`docs/test-cases.md`](docs/test-cases.md) — the full catalogue and what was automated
- [`docs/findings.md`](docs/findings.md) — what exploration actually turned up
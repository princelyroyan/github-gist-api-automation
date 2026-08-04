# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An API test suite for the **GitHub Gists REST API** — Playwright + TypeScript, API-only (no
UI layer). 89 tests across 12 spec files in `tests/api/`.

The system under test is a **live, third-party, production API**. There is no staging, no
database access, and no control over releases. Almost every non-obvious decision in this
repo follows from that, so read "Operational constraints" below before changing test
timing, parallelism, or personas.

## Commands

```bash
npm test                  # full suite (~3 min, 89 tests)
npm run test:smoke        # @smoke only — the PR gate
npm run test:regression   # @P0 + @P1
npm run test:contract     # schema validation
npm run test:security     # authorization boundaries
npm run typecheck         # tsc --noEmit — Playwright does NOT typecheck at runtime
npm run quota             # print remaining API budget for all three personas
npm run cleanup           # dry run; add -- --apply to delete leaked qa-auto-* gists
npm run clean             # wipe all generated output
```

### Running a single test

Grep on the catalogue id, which every test title starts with:

```bash
npx playwright test --grep "RD-07"
npx playwright test tests/api/gists.update.spec.ts        # one file
npx playwright test --grep "UPD-0[234]"                   # a few
```

**Do not pass `--reporter=...`** unless you mean it — a CLI reporter *replaces* the whole
configured list, including Allure, so `allure-results/` ends up empty.

### Reports

```bash
npm run allure:serve      # generate + open
npm run allure:single     # one self-contained allure-report/index.html
npm run test:allure       # test, then generate
```

`npm test` only writes raw results; the report is built by a separate `allure:*` script.
Every test script clears `allure-results/` first and `allure:generate` clears
`allure-report/` — Allure merges anything it finds, so stale files resurface as phantom
failures.

### Setup

Requires **two** GitHub accounts. `GIST_TOKEN_A` / `GIST_TOKEN_B` in `.env`
(`GITHUB_TOKEN_*` accepted as aliases; `GIST_*` is canonical because Actions reserves the
`GITHUB_` prefix). Both are required — `src/config/env.ts` throws at import time, before
Playwright collects tests. Fine-grained tokens with **Gists: Read and write**.

Node pinned in `.nvmrc` (26); CI reads that file rather than a literal, so the two cannot
drift.

## Architecture

Layered, with one rule that matters:

> **Clients never assert. Specs never build URLs.**
> A spec containing a string starting with `/gists` means the abstraction has leaked. An
> `expect` inside a client means failures report the wrong thing.

| Layer | Responsibility |
|---|---|
| `tests/api/*.spec.ts` | Arrange–Act–Assert in business language |
| `src/clients/` | One method per endpoint, returns the raw `APIResponse` |
| `src/models/gist.schemas.ts` | Zod runtime validation (**zod v3** — `.passthrough()`, not v4 syntax) |
| `src/builders/gist.builder.ts` | Valid-by-default payloads; deliberately accepts invalid types for negative cases |
| `src/fixtures/api.fixtures.ts` | Personas + the data factory that guarantees cleanup |
| `src/utils/assertions.ts` | `expectSchema`, `expectStatus`, `expectApiError`, `eventually`, `assertNotRateLimited` |

### Personas are fixtures, not parameters

Authorization is the dimension where this API's behaviour varies most, so it is modelled as
an equivalence partition. A spec declares what it needs and gets it:

`ownerClient` (account A) · `otherClient` (account B) · `anonClient` (no token) ·
`invalidTokenClient` · plus `ownerComments` / `otherComments` / `anonComments`.

Full rationale in `docs/test-strategy.md §5 → The four personas`.

### Test data

`gists` / `otherGists` are factories whose **teardown** deletes everything they created —
teardown runs even when a test throws, which an `afterEach` does not. That is what makes
`fullyParallel` safe against a production account.

Two non-obvious rules, both learned from real failures:

- **Tests needing the raw creation response must call `trackIfCreated(response, gists)`
  *before* asserting.** The natural order — assert, parse, then register — leaks the gist
  whenever the assertion fails, which is exactly when it matters. Two real orphans came
  from this.
- **`gists.create()` polls until the gist is readable *and* its creation commit is listed**
  before returning. See below.

## Operational constraints

These are the things that will waste hours if unknown. All are documented with evidence in
`docs/findings.md`.

**A 201 does not mean the gist is usable.** Read-after-write lag hits every persona,
including the owner writing to their own gist — `UPD-04` once got 404 from `PATCH` on a
gist its own test had just created. The factory settles creations centrally; anything
asserting on a *later* write (a `PATCH`'s new commit, another persona's view) must poll
itself with `eventually`. Never `sleep`.

**Two independent rate limits, and the dangerous one is invisible.**

| | Primary | Secondary |
|---|---|---|
| Scope | requests/hour | rate of *content creation* |
| Signal | `x-ratelimit-remaining: 0` | 403 + message in body only |
| Counter when it fires | 0 | **healthy (e.g. 4642/5000)** |
| `retry-after` | n/a | **not sent** |

The suite creates ~40 gists per run, now paced across ~3 minutes rather than the ~35s it
took before `write-throttle.ts` existed — the pacing *is* the fix, not overhead to tune
away (findings #23). **Two back-to-back full runs trigger the secondary limit**; 4-minute
spacing was still throttled, 8-minute spacing ran clean three times.
Locally, leave several minutes between full runs. `assertNotRateLimited` distinguishes the
two so a throttled run is never mistaken for a broken suite.

**The anonymous budget is 60/hour per IP** against 5000 per token. Only ~8 tests use
`anonClient`, and only where being unauthenticated *is* the subject. Everything else uses a
token even on endpoints that need none. Adding anonymous calls casually caps how often the
suite can run.

On CI that budget is **shared with every other job on the runner's IP**, so it can arrive
already spent. `anonClient` / `anonComments` gate on `MIN_ANON_BUDGET` in
`api.fixtures.ts` and skip when it is too low — the gate fails open if `/rate_limit` cannot
be read. Skips are rendered on the run page by `job-summary.ts` and must stay visible;
never fold them into the pass count. Findings #22.

**API version matters.** Default `2026-03-10` (env-overridable). That version **removed
`history` and `forks` from the gist object**; `2022-11-28` still has them. Read revisions
from `GET /gists/{id}/commits`, never `gist.history`. `SCH-10` pins the difference.

**Shared global state.** Never assert on the contents of `/gists/public` or a gist list —
assert on structural invariants. Parallel workers mutate the same account, so `PAG-07`
re-reads page 1 to confirm the collection did not shift before trusting a comparison.

**A list read straight after a write must poll.** The factory settles the *detail* view
(`GET /gists/{id}` and `/commits`) and nothing else; `GET /gists`, `/gists/starred` and
`/users/{u}/gists` are separate resources that settle on their own schedule. Asserting
"my gist is in the list" immediately after creating or starring it is a race, and it is
one the whole suite passing does not disprove — it only fails under load. Wrap the read
in `eventually` and keep the assertion exactly as it was. `RD-04`, `RD-09`, `PAG-09`,
`STR-04` and `RD-07` are the worked examples. Findings #19.

## Tags

`@smoke` (P0, the PR gate) · `@P0` `@P1` `@P2` · `@contract` · `@security` · `@drift`
(informational — fails when GitHub changes a shape) · `@slow` (forks).

## Docs

- `docs/test-strategy.md` — risk analysis, constraints, personas, exit criteria
- `docs/test-cases.md` — 115 cases identified, 92 automated by 89 tests, with steps and reasons for the rest
- `docs/findings.md` — 24 findings; #12–#24 were discovered by *running* the suite
- `gist-qa-case-study-plan.md` — local-only prep notes, excluded via `.git/info/exclude`

When behaviour changes, update `docs/test-cases.md` (expected values) and `docs/findings.md`
together — several findings name the test that pins them, and a stale claim there is worse
than none.

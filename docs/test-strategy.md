# Test strategy — GitHub Gists API

## 1. Scope

**In scope:** the public REST API for gists (`/gists`, `/gists/{id}`, star, fork,
revisions, comments, and the list endpoints), tested as a black box across four
authorization personas.

**Out of scope, deliberately:** the `gist.github.com` web interface. The UI runs on
GitHub's internal session-authenticated endpoints, not the public REST API, so *"the UI
works"* does not imply *"the API works"*. They are separate contracts with separate
consumers. Two UI-only capabilities are called out as accepted coverage gaps in §7.

## 2. Context and constraints

The system under test is a live, third-party, production API. This is not a normal test
environment, and the strategy is shaped more by these constraints than by the feature set:

| Constraint | Consequence |
|---|---|
| No staging environment | Tests run against production. They must be non-destructive to real data and self-cleaning. |
| No database or log access | Black-box only. Every verification is response-based. |
| Rate limits — 5000/hr authenticated, **60/hr anonymous per IP** | Request budget is a design input, not an afterthought. The anonymous limit decides *which persona each test uses*, not how often the suite runs — see finding #18. |
| **Secondary limit on burst writes** — 80 content requests/min, 900 points/min, 500/hr | Fires while the hourly counter still reads healthy, with no `retry-after`. A full run makes ~170 writes, which unpaced is 4× the per-minute cap *within a single run* — so the write rate is paced in the client rather than by spacing runs apart. See findings #20 and **#23**. |
| Shared global state (`/gists/public`) | Never assert on the contents of a global list; assert on structural invariants. |
| Eventual consistency across resources | Poll with a deadline rather than sleeping a fixed interval. |
| No control over releases | Contract drift detection matters more here than in a service we own. |

## 3. Approach: risk-based, layered

Exhaustive coverage of 20+ endpoints across all inputs is not a good use of budget. The
suite is a risk-based selection on a layered pyramid.

```
      /\        UI E2E (thin)       ~5%   journeys the API cannot reach
     /  \                                 (search, ZIP, embed, rendering)
    /----\      API E2E / workflow   ~20% multi-endpoint flows
   /      \                               (create -> edit -> revise -> fork -> delete)
  /--------\    API functional       ~55% endpoint CRUD, authz, error handling
 /          \
/------------\  Contract / schema    ~20% runtime response validation
```

Unit tests sit below this and belong to the service team — stated so the pyramid is not
misread as "no unit tests".

**Why API-heavy:** the API is the contract third parties depend on, it is faster and more
stable than the UI, and this is scoped as backend QA work.

**Why Playwright rather than supertest, REST Assured, or Cypress:**

- One runner for both API and UI. Two of the gaps in §7 are only reachable through a
  browser; a single tool avoids a second framework, CI job, and reporting stack.
- `APIRequestContext` is first-class, not bolted on — full control of headers, auth, and
  per-context isolation, which is exactly how the personas are modelled.
- Worker-level parallelism out of the box, which matters because the data strategy is
  per-test provisioning.
- Fixtures give composable setup/teardown, the cleanest way to enforce "no orphaned data".
- Tracing, HTML reports, retries, and tagging are built in.

The honest trade-off: for a pure-API suite with no UI component, supertest + Vitest is
lighter and marginally faster. Playwright wins here because of the mixed need and the
tooling, not because it is universally the right answer.

## 4. Risk analysis

Scored on likelihood of failure × business impact. This is what decided the automation
line, and it is the part worth defending.

| Area | Impact | Likelihood | Priority | Rationale |
|---|---|---|---|---|
| Create / read / delete | Critical | Medium | **P0** | Core value; data loss is unrecoverable |
| Authorization boundaries | Critical | Medium | **P0** | A cross-user write is a security incident |
| Update (PATCH merge semantics) | High | **High** | **P0** | Most complex logic; silent data loss |
| Response schema / contract | High | Medium | **P1** | Breaks every downstream consumer at once |
| Revisions / history integrity | High | Low | **P1** | Immutability is an explicit guarantee |
| Star lifecycle | Medium | Low | **P1** | Small state machine, cheap to cover fully |
| Fork | Medium | Low | **P2** | Cross-account and slow, but isolation matters |
| Comments | Medium | Low | **P2** | Standard CRUD on a child resource |
| Pagination / filtering | Medium | Medium | **P2** | Off-by-one prone |
| Rate limiting | Low | Low | **P3** | Expensive to test properly, changes rarely |
| Truncation (>1 MB, >300 files) | Low | Low | **P3** | Edge case; documented, not automated |

**The automation line is P0 + P1.** P3 is documented in
[`test-cases.md`](test-cases.md) with a reason, because identifying a case and choosing not
to automate it is a different skill from writing the test.

### Where the line actually landed

Stating the intent is easy; here is what was built, which is the more useful thing to
defend:

| Priority | Automated | Declined | % |
|---|---|---|---|
| P0 | 26 | 0 | 100% |
| P1 | 44 | 2 | 96% |
| **P2** | **22** | **16** | **58%** |
| P3 | 0 | 5 | 0% |

**P2 went further than "P0 + P1" implies, and that was a deliberate choice rather than
scope creep.** Once the fixtures, builders, and schemas existed, the marginal cost of a P2
test was a few lines, so the question stopped being *"is this critical?"* and became *"does
this earn its few seconds of runtime?"* Three reasons a P2 case was taken:

- **It completes a technique.** Star is only worth its place because the *whole* state
  machine is covered — asserting two of four transitions would demonstrate nothing about
  state-transition design.
- **It covers something structurally unique.** Comments is the only child resource in the
  feature, so it is the only place cascade behaviour and a cross-resource counter can be
  exercised at all.
- **It was already half-written.** Pagination boundaries share one endpoint and one
  assertion helper.

The 16 declined P2s are the counter-evidence that a line exists: each names its reason in
the catalogue, and they were declined on cost (a >1 MB upload on every run), on redundancy
(a second type-coercion case once the first pins the behaviour), or on impossibility (JSON
object keys cannot duplicate, so "duplicate filenames" is not expressible).

**If asked to defend a single number, the honest one is 24** — the `@smoke` subset, which
runs in about ten seconds and is what actually gates a change. That is the "critical
functionality" line. The 86-test suite is what runs nightly, when wall-clock is free and
breadth is worth more than speed.

## 5. Test design techniques

| Technique | Where it is applied |
|---|---|
| Equivalence partitioning | Personas: owner / other user / anonymous / invalid token |
| Boundary value analysis | `per_page` 0, 1, 30, 100, 101; empty file content; deleting the last file |
| Decision table | The PATCH `files` matrix — see `tests/api/gists.update.spec.ts` |
| State transition | Star: unstarred ⇄ starred; gist: created → edited → forked → deleted |
| CRUD lifecycle | create → read → update → read → delete → verify 404 |
| Pairwise | visibility {public, secret} × persona {owner, other, anon} × operation {read, edit, delete} |
| Error guessing | Malformed JSON, SQL-ish IDs, unicode, path traversal in filenames |
| Exploratory charters | Time-boxed sessions on truncation and revision behaviour → `findings.md` |

### The four personas

Authorization is the one dimension where this API's behaviour changes most, so it is
treated as an equivalence partition: every request belongs to exactly one class, and each
class can legitimately get a different answer to the same call.

| Persona | Credential | Represents | Exists to prove |
|---|---|---|---|
| **Owner** (account A) | Token A | The user who created the data | The happy path works, and the owner sees their own secret gists |
| **Other user** (account B) | Token B | A different, legitimate GitHub user | A stranger with a valid token still cannot read or write your data |
| **Anonymous** | No token at all | The public internet | What leaks without any credential — the single most valuable persona here |
| **Invalid token** | A syntactically plausible but fake token | A stale or revoked credential | Bad credentials are rejected cleanly, not treated as anonymous |

Four rules follow from this, and they are the reason the personas are worth naming rather
than passing a token around:

- **Anonymous is a first-class case, not an error path.** Gists are partly public, so an
  unauthenticated caller gets a real 200 for much of this API. `GET /gists` returns a
  completely different resource depending on which persona asks (findings #2), and a
  secret gist is readable with no token at all (#1). Testing only the authenticated path
  would have missed both.
- **"Other user" is what makes the security tests real.** Without a second account you can
  assert that *you* can edit your gist, but never that someone else cannot. That is the
  assertion that matters, and it is the one most candidates skip because it costs a second
  account to set up.
- **Invalid token is distinct from anonymous.** They are easy to conflate, and an API that
  silently downgraded a bad token to anonymous access would be a serious bug. Keeping them
  apart is what lets AUTH-03 assert `Bad credentials` rather than a public-feed 200.
- **The persona is also a budget decision.** Anonymous callers get 60 requests/hour per IP
  against 5000 for a token, so the anonymous persona is reserved for tests where being
  unauthenticated is the subject. Everything else uses a token even on endpoints that need
  none (findings #18).

In the framework each persona is a Playwright fixture — `ownerClient`, `otherClient`,
`anonClient`, `invalidTokenClient` — so a spec declares the personas it needs in its
arguments and gets exactly those, with no auth setup in the test body.

### The PATCH decision table

The clearest single demonstration of test design in the suite, and the reason UPD is
weighted P0 despite being an update rather than a delete:

| `content` | `filename` | Key matches an existing file? | Outcome | Case |
|---|---|---|---|---|
| set | absent | yes | Content updated | UPD-02 |
| absent | set | yes | Renamed | UPD-05 |
| set | set | yes | Renamed **and** updated | UPD-06 |
| absent | absent | yes | **File deleted** | UPD-07 |
| `null` (whole object) | — | yes | File deleted | UPD-04 |
| set | absent | no | New file created | UPD-03 |
| — | — | last remaining file | Boundary — rejected 422 | UPD-08 |
| (file omitted from the payload) | | | Untouched | UPD-02 |

## 6. Test data strategy

1. **Every test provisions its own data.** No shared fixtures, no hard-coded IDs, no
   ordering dependency. This is the precondition for parallel execution.
2. **Unique, traceable naming.** `qa-auto-<date>-<runId>-<uuid>` on every artefact, so a
   leaked gist can be traced back to the run and worker that leaked it.
3. **Guaranteed teardown.** Cleanup is in the fixture teardown phase, which runs even when
   the test throws. `scripts/cleanup.ts` is the backstop for a killed process.
4. **Provisioned data is settled before use.** A 201 from `POST /gists` does not mean the
   gist is usable — reads and even the owner's own writes have returned 404 immediately
   afterwards (findings #19). The factory polls until the gist is readable before handing
   it to the test, so a whole class of read-after-write races is handled in one place
   rather than retried per test.

Two supporting rules came out of failures rather than design, and are worth stating because
they are easy to get wrong:

- **Register for cleanup before asserting.** A test that asserts on a creation response and
  *then* records the id leaks the gist whenever the assertion fails — precisely when it
  matters. `trackIfCreated` registers straight off the 201.
- **Prove freshness before asserting absence.** RD-07 checks that account B cannot see a
  secret gist. Against a stale listing that passes for the wrong reason, because the list
  is missing every recent gist. It polls for a *public* gist first, so the absence of the
  secret one means something.

## 7. Known coverage gaps

Stated rather than hidden, with the reason and the mitigation:

| Gap | Why | Mitigation |
|---|---|---|
| **Gist search has no REST endpoint** | The UI search exists only on internal endpoints | UI test or accepted risk; cannot be covered at the API layer |
| **Download ZIP, embed script** | UI-only features | Thin UI smoke layer, if built |
| **>300 files → top-level truncation** | ~300 write operations for one assertion; disproportionate against the rate-limit budget | Documented in `findings.md` |
| **Secondary rate-limit behaviour** | Triggering it deliberately would degrade the account for other runs — though it was hit accidentally during stability testing, which is how findings #20 was written | Documented; `assertNotRateLimited` names it so a throttled run is never mistaken for a broken suite |
| **Concurrent PATCH / last-write-wins** | No way to observe the resolution from the outside | Documented as an open question |

## 8. Environment and CI

**Local:** `.env`, gitignored, with `.env.example` committed.
**CI:** GitHub Actions, tokens in repository secrets.

| Trigger | What runs | Target |
|---|---|---|
| Pull request | `@smoke` (P0 only) | < 2 min |
| Push to `main` | Full suite | < 5 min |
| Nightly 01:00 UTC (03:00 Berlin) | Full suite + contract drift | — |
| `workflow_dispatch` | Full suite | — |

Cleanup runs unconditionally after the suite, including on failure.

The nightly is expressed in UTC because Actions cron has no timezone, and it is a lower
bound rather than a start time — observed delays on this repo have run to 65–77 minutes.
Neither matters for a nightly, but both matter if anyone reads a run's timestamp as
evidence of when the schedule fired. The UTC value is chosen so the run lands at 03:00
Berlin in summer; it drifts to 02:00 Berlin under CET, which is accepted rather than
chased with a twice-yearly edit.

## 9. Entry and exit criteria

**Entry:** API docs available; both accounts provisioned with valid tokens; base URL
reachable; rate-limit budget confirmed.

**Exit:** every P0 case automated and passing; contract tests green across the core
endpoints; no unexplained failures; flake rate under 2% over 10 consecutive nightly runs;
every open observation triaged into one of the three buckets below.

**A practical caveat on the flake-rate criterion**, learned by attempting it: a full run
takes ~3 minutes, nearly all of it the deliberate pacing that keeps writes under GitHub's
80/min secondary limit (findings #23). Ten runs is half an hour of wall clock at best, and
the 500 content-requests-per-hour limit caps it at three runs an hour — so it is closer to
three hours. Nightly CI satisfies the criterion naturally; a local attempt to "just run it
ten times" back to back will exhaust the hourly write budget around run three.

## 10. Defect reporting

Because this is a third-party API, "defect" splits three ways, and conflating them wastes
everyone's time:

1. **True bugs** — behaviour contradicts the documentation. Report to GitHub.
2. **Documentation gaps** — behaviour is reasonable, the docs are incomplete.
3. **Design observations** — works as intended but creates user risk. The secret-gist
   visibility model is the headline example. This goes to a product owner, not a bug
   tracker.

## 11. Process

- **Shift left.** Review API design before implementation — status codes, error shapes,
  pagination conventions. The cheapest defect is the one caught in the spec.
- **Contract-first.** GitHub publishes an OpenAPI description. Owning this service, I would
  generate types from it so drift becomes a compile error, validate every response in CI,
  and diff the spec between releases to catch breaking changes automatically.
- **Layered ownership.** Devs own unit tests; QA owns integration, contract, and E2E. QA
  builds the framework, devs contribute tests to it. Enabler, not gatekeeper.
- **Flake management with teeth.** Any intermittent failure is quarantined within 24 hours
  and either fixed or deleted within a week. A suite people do not trust is worse than no
  suite.
- **Exploratory testing on a schedule.** Automation confirms known behaviour; exploration
  discovers unknown behaviour. Findings feed back into the suite.

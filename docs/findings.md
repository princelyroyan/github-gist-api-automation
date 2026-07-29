# Findings

Observations from exploring the Gists API, in the order I would present them. Each one
names the test that pins it, so a change in GitHub's behaviour shows up as a failing test
rather than as a stale document.

> **Verification status:** each finding is marked ✅ once the test that pins it has run
> green against the live API. Anything still marked ⏳ is an expectation from the docs and
> from manual exploration that the suite has not yet confirmed.
>
> Findings **#12–#21 were discovered by running the suite**, not by reading the docs.
> Ten of them are cases where the documentation or the obvious assumption was wrong,
> which is the strongest argument I can make for why the automated layer earns its keep:
> every one of them would have shipped as a silently wrong test.

Findings split three ways, and conflating them wastes everyone's time:
**bug** (behaviour contradicts the docs) · **doc gap** (behaviour is fine, docs are
incomplete) · **design observation** (works as intended, creates user risk).

---

## 1. "Secret" gists are unlisted, not private — *design observation*

`POST /gists` with `"public": false`, then `GET /gists/{id}` with **no token at all**,
returns 200 with the full file content.

The web UI's button says *"Create secret gist"*. Secret gists are hidden from search, from
your public profile, and from Discover — but anyone holding the URL can read them while
logged out. That is security by obscurity, not access control.

GitHub documents this. Users routinely misunderstand it anyway, and gist URLs leak through
chat logs, bug reports, and browser history. The interesting part is not *"does the API
work"* but *"does the API's behaviour match the mental model the UI creates"* — and here
it does not. I would raise this with a product owner as a wording risk, not file it as a
bug.

Pinned by **AUTH-08**, which asserts the 200 deliberately. If GitHub ever tightened this,
the test would fail and the reason would be right there in the comment.

Status: ✅

## 2. `GET /gists` returns a different resource depending on auth state — *design observation*

| Caller | Returns |
|---|---|
| Authenticated | The caller's own gists, secret ones included |
| Anonymous | The global feed of all recent public gists |

One path, two contracts. A client whose token silently expires does not get a 401 — it
gets 200 and a completely different, plausible-looking list. That failure is invisible
until someone notices the data is wrong.

This is the strongest argument in the whole exercise for testing every endpoint
anonymously as well as authenticated: the anonymous case is not an error path here, it is a
second contract.

Pinned by **RD-04** and **RD-05**. Status: ✅

## 3. PATCH merges, and the delete rules are obscure — *doc gap*

`PATCH /gists/{id}` merges rather than replaces. Files not mentioned in the payload are
left untouched. Within the `files` map:

| Payload for a key | Effect |
|---|---|
| `{ "content": "..." }` | Content updated |
| `{ "filename": "new.md" }` | Renamed, content preserved |
| `{ "filename": "new.md", "content": "..." }` | Renamed and rewritten |
| `null` | **File deleted** |
| `{}` | **File deleted** |

The last row is the trap. A client sending `{}` as a harmless no-op — a serialiser that
drops undefined fields, say — deletes the file instead. It is documented, but in a single
sentence that is easy to miss, and there is no way to tell from the response that anything
unexpected happened; the 200 looks identical.

Pinned by the full decision table in `gists.update.spec.ts`, **UPD-02 through UPD-08**.
Status: ✅

## 4. Deleting the last file is rejected — *boundary*

A gist cannot exist with zero files, so `PATCH` with the only remaining file set to `null`
returns 422 rather than cascading into a delete of the gist itself. Reasonable, and worth
pinning: the alternative behaviour — silently deleting the gist — would be a data-loss bug
of the worst kind.

Pinned by **UPD-08**. Status: ✅

## 5. Star endpoints overload 404 — *design observation*

`GET /gists/{id}/star` returns 204 when starred and **404 when not starred**. The same 404
is returned when the gist does not exist at all. From the client's side the two are
indistinguishable, so "is this starred?" and "does this exist?" cannot be answered
separately without a second call.

Pinned by **STR-01** and **STR-08**, which assert the same status for opposite meanings —
deliberately adjacent in the file so the overloading is obvious to anyone reading it.

Status: ✅

## 6. Cross-user writes return 404, not 403 — *correct, and easy to "fix" by mistake*

User B patching or deleting User A's gist gets **404**, not 403. This is deliberate: a 403
would confirm the resource exists, which leaks information about private data to someone
with no right to it.

It is good security practice and it looks like a bug to anyone who has not thought about
it. That is exactly why it belongs in the suite with a comment — otherwise a well-meaning
engineer "corrects" it to 403 one day.

Pinned by **AUTH-05** and **AUTH-06**. Note that AUTH-06 also re-reads the gist afterwards:
the right status code with a partial delete behind it would be worse than the wrong status
code.

Status: ✅

## 7. Starring is not a write to the gist — *doc gap*

Cross-user `PATCH` is refused, but cross-user `PUT .../star` succeeds. The permission
boundary is around the gist's content, not around every operation that touches it. Obvious
in hindsight, not obvious from the docs, and worth having both cases sitting next to each
other in the suite.

Pinned by **STR-10** against **AUTH-05**. Status: ✅

## 8. Visibility is immutable after creation — *doc gap / API–UI parity*

`PATCH` with `"public": true` on a secret gist returns 200, and the gist stays secret. The
field is accepted and ignored rather than rejected, so a client has no way to discover that
its request did nothing.

The web UI is consistent here — there is no "make public" control on an existing secret
gist either — so this is a genuine API/UI parity observation rather than a gap. The API
being *silent* about it is the part I would raise: a 422 would be more honest than a 200.

Pinned by **UPD-13**. Status: ✅

## 9. History is immutable, and that is a real guarantee — *works as documented*

`GET /gists/{id}/{sha}` returns the content as it was at that revision, not the current
content. This is what backs the Revisions tab, and it is the one data-integrity guarantee
in the feature worth testing directly rather than inferring.

Pinned by **REV-03**, which reads an old SHA and the current gist in the same test and
asserts they differ.

Status: ✅

## 10. Truncation is silent unless you check the flag — *design observation*

- File > 1 MB → `truncated: true`, `content` is partial, full content only via `raw_url`
- File > 10 MB → content omitted entirely; clone via `git_pull_url`
- More than 300 files → **top-level** `truncated: true`

A client that ignores `truncated` processes partial data believing it is complete. There is
no error, no warning, and the response is otherwise well-formed.

**Not automated**, and the reason is a cost judgement rather than an oversight: the >1 MB
case is affordable but adds a multi-megabyte upload to every run; the 300-file case needs
~300 write operations for a single assertion, which is a poor trade against the rate-limit
budget and the secondary limits on burst writes. Documented here, with `raw_url`
reachability covered instead by **SCH-07**.

Status: not automated by design — `raw_url` reachability is covered instead by **SCH-07** ✅

## 11. There is no gist search API — *capability gap*

The UI offers search with `language:` filters. There is no REST endpoint behind it; the web
interface runs on GitHub's internal session-authenticated endpoints. Gist search therefore
cannot be automated at the API layer at all.

This is the sharpest illustration of why *"the UI works"* does not imply *"the API works"*:
they are separate contracts with separate consumers, and here one has a feature the other
has never had. Download-ZIP and the embed script are the same shape of gap.

Recorded as an accepted coverage gap in
[`test-strategy.md §7`](test-strategy.md#7-known-coverage-gaps).

---

# Discovered by running the suite

## 12. API version 2026-03-10 removed `history` and `forks` — *breaking change* ✅

The headline technical finding. Both versions are currently supported:

| Field on the gist object | `2022-11-28` | `2026-03-10` |
|---|---|---|
| `history` | present | **removed** |
| `forks` | present | **removed** |

A client reading `gist.history[0].version` to find a revision SHA gets `undefined` the
moment it adopts the newer version. No error, no deprecation notice in the response, no
change in status code. The only surviving route to revision data is
`GET /gists/{id}/commits`, which behaves identically on both versions.

This is precisely the class of change a contract suite exists to catch, and it caught it
on the first run — the original schema required `history` and six tests failed at once.
Worth noting that the case study plan's own Postman snippet
(`pm.environment.set("sha", body.history[0].version)`) is broken against the current
default version for exactly this reason.

Pinned by **SCH-10**, which asserts the difference across both versions in one test, and
by every revision assertion now reading `/commits`.

## 13. The public feed is not sorted by update time — *doc gap* ✅

The docs describe `GET /gists/public` as sorted by most recently updated. Measured over
two samples of 30 and 100, ordering by `updated_at` had inversions; ordering by
`created_at` was exact. A gist edited after creation keeps its original position in the
feed.

Minor on its own, but it is the kind of assumption a client builds an "recently changed"
view on top of.

Pinned by **RD-06**, asserted against observed behaviour with the mismatch documented.

## 14. Conditional requests really are free — *works as documented* ✅

`If-None-Match` with a current ETag returns 304 with an empty body, and measured
serially, `x-ratelimit-remaining` is **unchanged** across the pair — delta 0.

The test asserts only the 304. The rate-limit half is deliberately not asserted: four
parallel workers share one token bucket, so the counter moves underneath any single test
for reasons unrelated to the 304. Asserting it would buy a flaky test and no extra
coverage. Verified out-of-band instead, recorded here.

Pinned by **RD-10**.

## 15. A deleted secret gist stays anonymously readable for ~60s — *design observation* ✅

The one with real user consequence, and it only appears when you combine two behaviours:

1. Secret gists are readable by anyone with the URL (finding #1).
2. Anonymous responses carry `Cache-Control: public, max-age=60, s-maxage=60`.

So after `DELETE /gists/{id}`:

| Caller | Immediately after delete |
|---|---|
| Owner | 404 |
| Anonymous (URL previously fetched) | **200, full content, for at least 10s** |

Measured at 200 continuously through +10s, consistent with the 60-second cache header.

The scenario that matters: someone pastes a secret gist URL somewhere public, realises the
mistake, and deletes it. The API confirms deletion with a 204 — while the content stays
served to anonymous callers for up to another minute. Nothing in the response tells the
owner that. Not a bug; a gap between what "deleted" means to the user and what it means to
the CDN.

Pinned by **DEL-02**, which asserts the cached 200 as current behaviour rather than
endorsing it.

## 16. Forking returns the list shape, not the detail shape — *doc gap* ✅

`POST /gists/{id}/forks` returns 201 with a gist object whose `files` entries carry
metadata but **no `content`** — the list representation. `POST /gists` returns the full
detail shape from the same-looking endpoint family, so the inconsistency is easy to trip
over: reading `content` off the fork response yields `undefined`, not an error.

Pinned by **FRK-01**, which asserts the absence and then re-fetches to check the content
actually copied.

## 17. Path traversal is rejected with HTML, breaking the error contract — *bug* ✅

| Input | Status | Content-Type |
|---|---|---|
| `!!!` | 404 | `application/json` |
| `1' OR '1'='1` | 404 | `application/json` |
| `..%2F..%2Fuser` | **400** | **`text/html`** |

The traversal attempt is rejected at the edge before reaching the API, so it never gets
the documented JSON error body. A client that parses error responses as JSON — which the
documented contract entitles it to do — throws a parse exception instead of handling a
400.

The rejection itself is correct and nothing leaks. The contract violation is the finding,
and it is the one item here I would actually file with GitHub.

Pinned by **RD-03**.

## 18. The anonymous budget constrains how the suite is written — *our problem, not GitHub's* ✅

> Superseded in part by **#20**: this was originally titled "the binding constraint", which
> turned out to be wrong. The anonymous budget shapes *which persona each test uses*; the
> secondary write limit is what actually caps run frequency.

Not an API finding — a framework one, and the most useful thing the live runs taught me.

Anonymous callers get **60 requests per hour per IP**; authenticated callers get 5000. The
first version of this suite spent roughly 20 anonymous requests per run on tests that used
the anonymous client incidentally — pagination, feed ordering, a 404 lookup — none of
which were testing anonymity at all. That capped the suite at about three runs an hour
before unrelated tests started failing with 403s that looked like product defects.

Two changes:

- Every test that did not specifically need the anonymous persona now uses the
  authenticated client. Anonymous usage dropped from ~20 to a measured 8 per run.
- `assertNotRateLimited` converts an exhausted budget into one explicit message naming the
  persona and the reset time, instead of a scattering of unrelated assertion failures.

The lesson generalises: on a shared, rate-limited, third-party API, *which persona a test
uses is a resource decision as much as a correctness one*. On a fresh IP, budget roughly
six full runs per hour.

## 19. A 201 does not mean the gist is usable yet — *design observation* ✅

**Corrected.** This finding originally claimed the owner sees a gist immediately and only
*other* callers lag. That is wrong, and the suite disproved it: UPD-04 failed with a 404
while `PATCH`ing a gist its own test had created seconds earlier, using the owner's token.

The lag is general read-after-write consistency, and it has now surfaced in four
unrelated tests:

| Test | Operation | Symptom |
|---|---|---|
| **UPD-04** | **owner `PATCH`es their own new gist** | **404** |
| SCH-03 / REV-02 | `GET /gists/{id}/commits` after a 200 from `PATCH` | new revision missing from the list |
| **REV-04** | same, read as `commits[0]` | reads the **creation** commit and reports the diff as wrong |
| RD-07 | account B lists the owner's gists | a public gist created moments earlier is absent |
| AUTH-08 / DEL-02 | anonymous `GET /gists/{id}` | 404 for a gist the owner can read |

All of them are intermittent, appear under parallel load, and vanish when the API is idle —
which is why they survived a dozen green runs before showing themselves. Non-owners lag
*more*, but nobody is exempt, including the writer.

**The mechanism is not confirmed, and the obvious explanation is wrong.** The natural
suspect was the `private, max-age=60` cache header on these responses, but direct probing
ruled it out: a plain request immediately after creation returned the new gist, no `age`
header was ever present, and `Cache-Control: no-cache`, `Pragma: no-cache`, and a
cache-busting query parameter all made no difference. A read replica is the likely
candidate, but that cannot be demonstrated from outside, so the tests say "eventually
consistent" rather than naming a cause they cannot show.

**Read alongside #15, a symmetry emerges:** visibility is not synchronous in *either*
direction. A new gist takes time to become usable; a deleted one takes up to 60 seconds to
stop being readable anonymously. The owner's view leads and everyone else's trails it —
but the owner's view is not instantaneous either, which is the part that surprised me.

For a client, the practical consequence is narrow but real: create a gist, hand the URL
straight to someone else, and they may get a 404 on a resource that definitely exists. Any
"share immediately after creating" flow needs to tolerate that.

**Consequence for the suite, which is the more useful lesson:** *nothing may assume that
data is usable the moment the API says it was created.*

The fix belongs in the fixture, not the specs. `gists.create()` now polls until the gist
is readable **and** its creation commit is listed, which covers every test that touches
fresh data without each one having to remember.
The alternative — a retry bolted onto every test that touches fresh data — is repetitive
and, worse, easy to forget on the next test someone writes. It costs one extra GET per
gist, trivial against the 5000/hr authenticated budget.

Where a specific operation lags independently of creation, the test polls: SCH-03 and
REV-02 for the commits list, AUTH-08 for the anonymous read. AUTH-08 is bounded to three
attempts rather than thirty, because every anonymous request spends from the 60/hr budget
in #18.

There is a subtler trap here that polling also fixes. RD-07's real assertion is that
account B *cannot* see the owner's secret gist. Against a stale listing that assertion
passes for the wrong reason — the list is missing every recent gist, secret and public
alike. Polling until the *public* gist appears proves the listing is fresh, which is what
makes the absence of the secret one meaningful. A security test that passes vacuously is
worse than no test, because it reports confidence it hasn't earned.

---

## 20. The secondary rate limit is the real cap on run frequency — *our problem, not GitHub's* ✅

Running the suite four times back to back produced this:

| Run | Result |
|---|---|
| 1 | 83 passed, 3 failed |
| 2 | 31 passed, **55 failed** |
| 3 | 25 passed, **61 failed** |
| 4 | 25 passed, **61 failed** |

47 of run 2's failures were one error:

```
403 You have exceeded a secondary rate limit and have been temporarily
    blocked from content creation.
```

That looks like the suite collapsing. It is not — it is GitHub throttling burst writes,
and it is a different mechanism from the hourly budget in #18:

| | Primary limit | Secondary limit |
|---|---|---|
| Scope | requests per hour | rate of *content creation* |
| Signal | `x-ratelimit-remaining: 0` | 403 + a message in the body |
| `x-ratelimit-remaining` when it fires | 0 | **4642 — untouched** |
| `retry-after` header | n/a | **not sent** |
| Recovery | known reset timestamp | unknown; minutes |

**The primary budget tells you nothing about it.** When run 2 collapsed, account A still
had 4643 of 5000 requests available. Anyone diagnosing from the hourly counter alone would
conclude the suite was broken.

**And there is no `retry-after`**, so a client cannot know how long to back off. That is
the part I would raise with GitHub: the documented advice for a 403 of this kind is to
honour `retry-after`, and here it is absent.

This suite creates ~40 gists per run in ~35 seconds across 4 workers. One run is fine; a
second immediately afterwards is not. Writes were available again a few minutes later.

**This corrects #18.** I reported the anonymous budget as "the binding constraint" and had
the report printing `runs_left_this_hour` based on it. That figure is only about anonymous
*reads*. The real limit on how often this suite can run is the secondary write throttle,
which no header exposes and no counter predicts. The metric is now labelled for what it
actually measures rather than implying a guarantee it cannot make.

**Consequences for the suite:**

- `assertNotRateLimited` now distinguishes the two. A secondary block reports itself as a
  burst-write throttle and states that `x-ratelimit-remaining` is still healthy, instead
  of 47 identical "fixture setup failed" errors that read like a broken framework.
- The gist factory routes its failures through the same guard, so throttled setup is
  named correctly at the point it happens.
- Leave a few minutes between full runs locally. In CI this is a non-issue — PR, push, and
  nightly runs are naturally spaced.

**The honest conclusion about stability:** four consecutive runs could not establish a
flake rate, because the environment stops cooperating after the first. Demonstrating the
"under 2% over 10 consecutive runs" exit criterion in `test-strategy.md` requires spacing
runs several minutes apart — roughly an hour of wall clock. That is a property of testing
against a live third-party API, and it is better stated than glossed over.

---

## 21. A 304 is an optimisation, not a guarantee — *works as specified* ✅

RD-10 was the last unexplained flake in the suite. It asserted that a conditional GET with
a current `If-None-Match` returns 304, and it intermittently got a full 200 instead.

Two hypotheses were tested and disproved:

| Hypothesis | Disproved by |
|---|---|
| Response caching served something stale | No `age` header; nothing stale ever returned |
| The ETag is unstable across replicas | Six consecutive reads of an unchanged gist returned **one identical** ETag, and conditional requests succeeded 5/5 in isolation |

The answer was that the test was wrong, not the API. RFC 9110 permits a server to answer a
conditional request with the full representation even when the validator still matches —
returning 200 is always a legal response. 304 is a bandwidth optimisation the server *may*
apply, not a contract it must honour.

So a strict `expect(304)` asserts something the specification does not promise, and is
flaky by construction. The test now retries and requires that a 304 occurs *at least once*,
which proves the capability works without claiming it fires on any particular request. If
no attempt ever yields a 304, conditional requests are genuinely broken and it still fails.

**The generalisable lesson, and the reason this is worth a finding at all:** before
treating an intermittent failure as a product defect or a race, check whether the
assertion is even entitled to hold. A flaky test is sometimes a correct test meeting an
unreliable system, and sometimes — as here — an incorrect test meeting a system behaving
exactly as specified.

---

## UI ↔ API traceability

| UI action | API equivalent | Gap |
|---|---|---|
| Create secret gist | `POST /gists` `public:false` | — |
| Edit / delete | `PATCH` / `DELETE /gists/{id}` | — |
| Star | `PUT /gists/{id}/star` | — |
| Fork | `POST /gists/{id}/forks` | — |
| Comment | `POST /gists/{id}/comments` | — |
| Revisions diff view | `GET /gists/{id}/commits` + `/{sha}` | UI computes the diff; the API returns only `change_status` counts |
| Discover feed | `GET /gists/public` | Approximately equivalent |
| **Search by language** | *none* | **No REST endpoint** |
| Download ZIP | *none* | UI-only |
| Embed script | *none* | UI-only |
| Make an existing secret gist public | *none* | Neither surface supports it (finding 8) |

## Open questions

Things I would ask the service owner rather than guess at:

- Concurrent `PATCH`es to the same gist — is last-write-wins intended, and is there any
  optimistic-concurrency mechanism a client could use?
- Is the `{}` = delete rule in `files` intentional, or an artefact of the parameter
  parsing? Its behaviour is load-bearing for clients either way.
- What is the intended SLA for `GET /gists/{id}`? Without one, NFR-03 cannot be written as
  a pass/fail test.
- Is the fork list eventually consistent by design, and what is the expected upper bound?
  The suite polls with a 15-second deadline chosen by observation, not by contract.
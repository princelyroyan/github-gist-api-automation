# Test case catalogue

**115 cases identified. 92 automated.** The gap is deliberate: identifying a case and
choosing not to automate it are separate skills, and the reasoning behind the line is in
[`test-strategy.md §4`](test-strategy.md#4-risk-analysis).

The suite has **86 `test()` functions**, which is fewer than 92 because five tests each
cover a group of related cases — `STR-01/02/03/06` walks one state machine in a single
test — and `SCH-04` is asserted inside the comments tests rather than having one of its
own. Every automated case is traceable: each test title begins with its id here.

Legend — **P0** automate first (smoke gate), **P1** automate (regression), **P2**
automate if cheap, **P3** documented, not automated.

Status — ✅ automated, ⬜ not automated (reason given).

**Personas** — the Steps below refer to these four. Every request belongs to exactly one;
full rationale in [`test-strategy.md §5`](test-strategy.md#the-four-personas).

| Name in the steps | Credential | Represents |
|---|---|---|
| **Owner** / account A | Token A | The user who created the gist |
| **Account B** | Token B | A different, legitimate user — must be refused |
| **Anonymous** | No token | The public internet |
| **Invalid token** | A fake token | A stale or revoked credential |

---

## Authentication and authorization → `tests/api/auth.spec.ts`

| ID | Scenario | Expected | Pri | Status |
|---|---|---|---|---|
| AUTH-01 | Valid token → `GET /gists` | 200 | P0 | ✅ |
| AUTH-02 | No token → `GET /gists/starred` | 401 | P0 | ✅ |
| AUTH-03 | Garbage token | 401 `Bad credentials` | P0 | ✅ |
| AUTH-04 | Expired / revoked token | 401 | P1 | ⬜ Cannot be produced on demand without burning a token per run |
| AUTH-05 | User B `PATCH`es User A's gist | **404**, not 403 | P0 | ✅ |
| AUTH-06 | User B `DELETE`s User A's gist | **404**, gist survives | P0 | ✅ |
| AUTH-07 | Anonymous `POST /gists` | 401 | P0 | ✅ |
| AUTH-08 | Anonymous reads User A's **secret** gist by id | 200 — polled; the read can 404 briefly (#19) | P0 | ✅ |
| AUTH-09 | Token without gist scope creates a gist | 403/404 | P2 | ⬜ Needs a third token provisioned solely to be wrong |
| AUTH-10 | Malformed `Authorization` header | 401 | P2 | ✅ |

<details>
<summary><b>Steps</b></summary>

- **AUTH-01** — GET /gists as account A
- **AUTH-02** — GET /gists/starred with no token
- **AUTH-03** — GET /gists with a garbage token
- **AUTH-04** — Revoke a token → GET /gists with it
- **AUTH-05** — Owner creates a secret gist → Account B PATCHes it
- **AUTH-06** — Owner creates a secret gist → Account B DELETEs it → Owner re-reads it
- **AUTH-07** — POST /gists with no token
- **AUTH-08** — Owner creates a secret gist → GET /gists/{id} with no token (polled)
- **AUTH-09** — Make a token without gist scope → POST /gists with it
- **AUTH-10** — GET /gists with `Authorization: Basic notatoken`

</details>

## Create → `tests/api/gists.create.spec.ts`

| ID | Scenario | Expected | Pri | Status |
|---|---|---|---|---|
| CRE-01 | Public gist, single file | 201, `public:true` | P0 | ✅ |
| CRE-02 | Secret gist | 201, `public:false` | P0 | ✅ |
| CRE-03 | Multi-file gist (3 files) | 201, all present | P0 | ✅ |
| CRE-04 | No `description` | 201, empty/null | P1 | ✅ |
| CRE-05 | `files` omitted | 422 | P0 | ✅ |
| CRE-06 | `files: {}` | 422 | P0 | ✅ |
| CRE-07 | File with `content: ""` | 422 | P1 | ✅ |
| CRE-08 | `public` as the string `"true"` | 201, coerced | P1 | ✅ |
| CRE-09 | `public` as `123` / `"maybe"` | 422 | P2 | ⬜ Low value once CRE-08 pins the coercion behaviour |
| CRE-10 | Unicode filename and content | 201, round-trips | P1 | ✅ |
| CRE-11 | Filename with spaces | 201 | P2 | ⬜ Subsumed by CRE-10 |
| CRE-12 | Reserved filename `gistfile1.txt` | Verify | P2 | ⬜ See `findings.md` |
| CRE-13 | Very long description (>10k) | Verify limit | P2 | ⬜ Documented |
| CRE-14 | File content >1 MB | 201, later `truncated:true` | P2 | ⬜ Costly per run; see `findings.md` |
| CRE-15 | Malformed JSON body | **422**, not 400 — reported as a validation error | P1 | ✅ |
| CRE-16 | `Content-Type: text/plain` | Verify | P3 | ⬜ Documented |
| CRE-17 | Duplicate filenames in one request | Verify | P2 | ⬜ Not expressible — JSON object keys are unique |

<details>
<summary><b>Steps</b></summary>

- **CRE-01** — POST /gists (public, one file) → GET /gists/{id}/commits
- **CRE-02** — POST /gists with `public: false`
- **CRE-03** — POST /gists with three files → Compare each file back
- **CRE-04** — POST /gists with files only, no description
- **CRE-05** — POST /gists with no `files` key
- **CRE-06** — POST /gists with `files: {}`
- **CRE-07** — POST /gists with `content: ""`
- **CRE-08** — POST /gists with `public: "true"` as a string
- **CRE-09** — POST /gists with `public: 123`
- **CRE-10** — POST /gists with emoji / CJK / RTL name and body → Compare the round-trip
- **CRE-11** — POST /gists with filename `my file.txt`
- **CRE-12** — POST /gists with filename `gistfile1.txt`
- **CRE-13** — POST /gists with a description over 10k characters
- **CRE-14** — POST /gists with over 1 MB of content → GET /gists/{id}
- **CRE-15** — POST /gists with a truncated JSON string as the body
- **CRE-16** — POST /gists with `Content-Type: text/plain`
- **CRE-17** — POST /gists with the same filename twice

</details>

## Read → `tests/api/gists.read.spec.ts`

| ID | Scenario | Expected | Pri | Status |
|---|---|---|---|---|
| RD-01 | Get own gist by id | 200, content matches | P0 | ✅ |
| RD-02 | Non-existent id | 404 | P0 | ✅ |
| RD-03 | Malformed id (`!!!`, SQL-ish, traversal) | 404 JSON; traversal **400 HTML** | P1 | ✅ |
| RD-04 | Authenticated `GET /gists` includes secret gists | 200 | P0 | ✅ |
| RD-05 | Anonymous `GET /gists` returns the public feed | 200 | P1 | ✅ |
| RD-06 | `GET /gists/public` ordering | **`created_at`** descending, not `updated_at` | P1 | ✅ |
| RD-07 | `GET /users/{login}/gists` visibility | Owner sees own secret gists; **others and anon do not** | P0 | ✅ |
| RD-08 | Non-existent user | 404 | P1 | ✅ |
| RD-09 | List omits file `content`, detail includes it | Contract difference | P1 | ✅ |
| RD-10 | `ETag` → `If-None-Match` | 304 **achievable**, not guaranteed — a 200 is spec-legal (#21). Rate-limit delta verified serially, not asserted | P2 | ✅ |

<details>
<summary><b>Steps</b></summary>

- **RD-01** — Create a gist with known content → GET /gists/{id}
- **RD-02** — GET /gists/{32 zeros}
- **RD-03** — GET /gists/`!!!` → GET /gists/`1' OR '1'='1` → GET /gists/`..%2F..%2Fuser`
- **RD-04** — Create a secret gist → GET /gists?per_page=100
- **RD-05** — Create a secret gist → GET /gists with no token
- **RD-06** — GET /gists/public?per_page=100 → Check the `created_at` ordering
- **RD-07** — Create one secret and one public gist → GET /users/{login}/gists as the owner → Repeat as account B and anonymously
- **RD-08** — GET /users/{nonexistent}/gists
- **RD-09** — Create a gist → GET /gists (list) → GET /gists/{id} (detail)
- **RD-10** — GET /gists/{id} and keep the ETag → GET again with `If-None-Match`

</details>

## Update → `tests/api/gists.update.spec.ts`

| ID | Scenario | Expected | Pri | Status |
|---|---|---|---|---|
| UPD-01 | Description only | 200, files untouched | P0 | ✅ |
| UPD-02 | One file's content | 200, others unchanged | P0 | ✅ |
| UPD-03 | Add a file | 200, count +1 | P0 | ✅ |
| UPD-04 | Delete a file (`null`) | 200, count −1. Exposed owner read-after-write lag (#19) | P0 | ✅ |
| UPD-05 | Rename | 200, content preserved | P0 | ✅ |
| UPD-06 | Rename and rewrite together | 200, both applied | P1 | ✅ |
| UPD-07 | Empty file object `{}` | File deleted | P1 | ✅ |
| UPD-08 | Delete the **only** file | 422, gist survives | P1 | ✅ |
| UPD-09 | PATCH with empty body `{}` | Verify | P1 | ⬜ No observable effect to assert |
| UPD-10 | PATCH a non-existent gist | 404 | P0 | ✅ |
| UPD-11 | `updated_at` advances | Increases | P1 | ✅ |
| UPD-12 | Concurrent PATCHes | Documented | P3 | ⬜ Resolution not observable from outside |
| UPD-13 | Visibility toggle via PATCH | Ignored | P2 | ✅ |

<details>
<summary><b>Steps</b></summary>

- **UPD-01** — Create a one-file gist → PATCH the description only
- **UPD-02** — Create with a.txt and b.txt → PATCH a.txt content
- **UPD-03** — Create with a.txt → PATCH adding b.txt
- **UPD-04** — Create with keep.txt and drop.txt → PATCH `drop.txt: null`
- **UPD-05** — Create with old.md → PATCH `filename: new.md`
- **UPD-06** — Create with old.md → PATCH filename and content together
- **UPD-07** — Create with keep.txt and drop.txt → PATCH `drop.txt: {}`
- **UPD-08** — Create with one file → PATCH that file to `null` → GET the gist
- **UPD-09** — Create a gist → PATCH with `{}`
- **UPD-10** — PATCH /gists/{32 zeros}
- **UPD-11** — Create a gist → PATCH the content → Compare `updated_at`
- **UPD-12** — Fire two PATCHes at the same gist simultaneously
- **UPD-13** — Create a secret gist → PATCH `public: true`

</details>

## Delete → `tests/api/gists.delete.spec.ts`

| ID | Scenario | Expected | Pri | Status |
|---|---|---|---|---|
| DEL-01 | Delete own gist | 204, empty body | P0 | ✅ |
| DEL-02 | Read after delete | Owner 404; **anonymous 200 for ~60s** (CDN cache). Pre-delete anon read polled (#19) | P0 | ✅ |
| DEL-03 | Delete twice | Second → 404 | P1 | ✅ |
| DEL-04 | Delete non-existent | 404 | P1 | ✅ |
| DEL-05 | Delete a gist that has forks | Fork survives | P2 | ⬜ Cross-account and slow; low risk |

<details>
<summary><b>Steps</b></summary>

- **DEL-01** — Create a gist → DELETE /gists/{id}
- **DEL-02** — Create a secret gist → Read it anonymously (polled) → DELETE it → Re-read as owner, then anonymously
- **DEL-03** — Create a gist → DELETE it → DELETE it again
- **DEL-04** — DELETE /gists/{32 zeros}
- **DEL-05** — Fork a gist → Delete the original → GET the fork

</details>

## Star → `tests/api/gists.star.spec.ts`

| ID | Scenario | Expected | Pri | Status |
|---|---|---|---|---|
| STR-01 | Check star on an unstarred gist | 404 | P1 | ✅ |
| STR-02 | Star | 204 | P1 | ✅ |
| STR-03 | Check after starring | 204 | P1 | ✅ |
| STR-04 | Appears in `/gists/starred` | Present | P1 | ✅ |
| STR-05 | Star twice | 204, idempotent | P1 | ✅ |
| STR-06 | Unstar | 204 | P1 | ✅ |
| STR-07 | Unstar an unstarred gist | 204 | P2 | ✅ |
| STR-08 | Star a non-existent gist | 404 | P2 | ✅ |
| STR-09 | Star without auth | 401 | P1 | ✅ |
| STR-10 | User B stars User A's public gist | 204 | P2 | ✅ |

<details>
<summary><b>Steps</b></summary>

- **STR-01** — Create a gist → GET /gists/{id}/star
- **STR-02** — PUT /gists/{id}/star
- **STR-03** — PUT star → GET star
- **STR-04** — PUT star → GET /gists/starred
- **STR-05** — PUT star twice → GET star
- **STR-06** — PUT star → DELETE star → GET star
- **STR-07** — DELETE star on an unstarred gist, twice
- **STR-08** — PUT /gists/{32 zeros}/star
- **STR-09** — PUT star with no token
- **STR-10** — Owner creates a public gist → Account B PUTs star

</details>

## Fork → `tests/api/gists.fork.spec.ts`

| ID | Scenario | Expected | Pri | Status |
|---|---|---|---|---|
| FRK-01 | User B forks User A's public gist | 201; body is the **list shape**, re-fetch for content | P1 | ✅ |
| FRK-02 | Fork appears on the original | Present (polled) | P2 | ✅ |
| FRK-03 | Fork your own gist | 422 | P1 | ✅ |
| FRK-04 | Fork the same gist twice | Verify | P2 | ⬜ Documented |
| FRK-05 | Fork without auth | 401 | P1 | ✅ |
| FRK-06 | Editing a fork leaves the original alone | Unchanged | P1 | ✅ |
| FRK-07 | Fork a secret gist you do not own | Verify | P2 | ⬜ Documented |

<details>
<summary><b>Steps</b></summary>

- **FRK-01** — Owner creates a public gist → Account B POSTs /forks → Account B GETs the fork
- **FRK-02** — Account B forks the gist → Poll GET /gists/{id}/forks
- **FRK-03** — Owner creates a public gist → Owner POSTs /forks on it
- **FRK-04** — Fork a gist → Fork the same gist again
- **FRK-05** — POST /forks with no token
- **FRK-06** — Account B forks → Account B PATCHes the fork → Owner re-reads the original
- **FRK-07** — Owner creates a secret gist → Account B POSTs /forks

</details>

## Revisions → `tests/api/gists.revisions.spec.ts`

| ID | Scenario | Expected | Pri | Status |
|---|---|---|---|---|
| REV-01 | New gist has exactly 1 commit | 1 entry from `/commits` (`history` is gone — SCH-10); the factory settles `/commits` before the test runs | P1 | ✅ |
| REV-02 | Each PATCH appends a commit | Count increments — polled; `/commits` lags the write (#19) | P1 | ✅ |
| REV-03 | `GET /gists/{id}/{sha}` returns historical content | Old content | P1 | ✅ |
| REV-04 | `change_status` matches the real diff | Accurate — polled for the 2nd commit first, or it reads the creation commit (#19) | P2 | ✅ |
| REV-05 | Invalid SHA | 404/422 | P2 | ✅ |
| REV-06 | SHA belonging to another gist | **422** (needs distinct content — identical gists share a SHA) | P2 | ✅ |

<details>
<summary><b>Steps</b></summary>

- **REV-01** — Create a gist → GET /gists/{id}/commits
- **REV-02** — Create a gist → PATCH twice → Poll /commits for three entries
- **REV-03** — Create with "version one" → Read the first SHA from /commits → PATCH to "version two" → GET /gists/{id}/{sha}
- **REV-04** — Create a two-line file → PATCH adding one line → Poll /commits for two entries → Read `commits[0].change_status`
- **REV-05** — GET /gists/{id}/not-a-sha
- **REV-06** — Create gists A and B with different content → GET /gists/{A}/{SHA of B}

</details>

## Comments → `tests/api/gists.comments.spec.ts`

| ID | Scenario | Expected | Pri | Status |
|---|---|---|---|---|
| CMT-01 | Create | 201, body echoed | P2 | ✅ |
| CMT-02 | List | 200, includes it | P2 | ✅ |
| CMT-03 | Gist `comments` counter increments | +1 | P2 | ✅ |
| CMT-04 | Update own comment | 200 | P2 | ✅ |
| CMT-05 | Delete own comment | 204 | P2 | ✅ |
| CMT-06 | User B edits User A's comment | 403/404 | P2 | ✅ |
| CMT-07 | Empty body | 422 | P2 | ✅ |
| CMT-08 | Comment on a non-existent gist | 404 | P2 | ✅ |
| CMT-09 | Comments cascade on gist delete | Verify | P3 | ⬜ Parent is gone; nothing left to query |

<details>
<summary><b>Steps</b></summary>

- **CMT-01** — POST /gists/{id}/comments
- **CMT-02** — POST a comment → GET /gists/{id}/comments
- **CMT-03** — POST a comment → GET /gists/{id} and read `comments`
- **CMT-04** — POST a comment → PATCH its body
- **CMT-05** — POST a comment → DELETE it → GET it
- **CMT-06** — Owner comments on a public gist → Account B PATCHes that comment → Owner re-reads it
- **CMT-07** — POST a comment with `body: ""`
- **CMT-08** — POST /gists/{32 zeros}/comments
- **CMT-09** — Comment on a gist → Delete the gist → GET the comment

</details>

## Pagination and filtering → `tests/api/gists.pagination.spec.ts`

| ID | Scenario | Expected | Pri | Status |
|---|---|---|---|---|
| PAG-01 | Default `per_page` = 30 | ≤30 | P1 | ✅ |
| PAG-02 | `per_page=1` | 1 | P1 | ✅ |
| PAG-03 | `per_page=100` | ≤100 | P1 | ✅ |
| PAG-04 | `per_page=101` | Clamped | P1 | ✅ |
| PAG-05 | `per_page=0` / negative | Verify | P2 | ⬜ Documented |
| PAG-06 | `Link` header has `rel="next"` | Present | P1 | ✅ |
| PAG-07 | Pages 1 and 2 are disjoint | No overlap; provisions its own 4 gists; re-reads page 1 to confirm the list did not shift (8 attempts) | P1 | ✅ |
| PAG-08 | Very high page number | **422** `pagination is limited`, not an empty array | P2 | ✅ |
| PAG-09 | Valid `since` | Only newer | P1 | ✅ |
| PAG-10 | Malformed `since` | Verify | P2 | ⬜ Documented |
| PAG-11 | Future-dated `since` | Empty | P2 | ✅ |

<details>
<summary><b>Steps</b></summary>

- **PAG-01** — GET /gists/public with no params
- **PAG-02** — GET /gists/public?per_page=1
- **PAG-03** — GET /gists/public?per_page=100
- **PAG-04** — GET /gists/public?per_page=101
- **PAG-05** — GET ?per_page=0 → GET ?per_page=-1
- **PAG-06** — GET /gists/public?per_page=5 → Read the `Link` header
- **PAG-07** — Create four gists → GET page 1 and page 2 at per_page=2 → Re-read page 1 to confirm no shift → Compare the two id sets
- **PAG-08** — GET /gists/public?per_page=100&page=99999
- **PAG-09** — Note a cutoff time → Create a gist → GET /gists?since={cutoff}
- **PAG-10** — GET /gists?since=not-a-date
- **PAG-11** — GET /gists?since={tomorrow}

</details>

## Contract → `tests/api/gists.contract.spec.ts`

| ID | Scenario | Pri | Status |
|---|---|---|---|
| SCH-01 | Gist object matches the schema | P0 | ✅ |
| SCH-02 | List item schema (no file `content`) | P0 | ✅ |
| SCH-03 | Commit / history object schema | P1 | ✅ (in `gists.update.spec.ts`; polled — `/commits` lags, #19) |
| SCH-04 | Comment object schema | P2 | ✅ (in `gists.comments.spec.ts`) |
| SCH-05 | Error object schema | P1 | ✅ |
| SCH-06 | Timestamps are ISO 8601 UTC | P1 | ✅ |
| SCH-07 | Response URLs are well formed and reachable | P1 | ✅ |
| SCH-08 | No unexpected fields — strict drift detection | P1 | ✅ `@drift` |
| SCH-09 | `Content-Type: application/json; charset=utf-8` | P2 | ✅ |
| SCH-10 | `history`/`forks` removed in API version 2026-03-10 | P1 | ✅ `@drift` |

<details>
<summary><b>Steps</b></summary>

- **SCH-01** — GET /gists/{id} → Validate against the Zod gist schema
- **SCH-02** — GET /gists?per_page=10 → Validate against the list schema
- **SCH-03** — Create then PATCH a gist → Poll /commits → Validate the commit schema
- **SCH-04** — POST a comment → Validate the comment schema
- **SCH-05** — GET a missing gist → POST /gists with `files: {}` → Validate the error schema
- **SCH-06** — GET /gists/{id} → Regex `created_at` and `updated_at`
- **SCH-07** — GET /gists/{id} → Parse the `url` and `html_url` hosts → GET the `raw_url`
- **SCH-08** — GET /gists/{id} → Validate against the **strict** schema
- **SCH-09** — GET /gists?per_page=1 → Read `Content-Type`
- **SCH-10** — GET /gists/{id} on 2026-03-10 → GET again on 2022-11-28 → Compare against GET /commits

</details>

## Non-functional

| ID | Scenario | Pri | Status |
|---|---|---|---|
| NFR-01 | Rate-limit headers on every response | P1 | ✅ (in `gists.read.spec.ts`) |
| NFR-02 | `x-ratelimit-remaining` decrements | P2 | ⬜ Cannot be isolated — four workers share one token bucket, so the counter moves for unrelated reasons. Verified serially instead (delta 0 on a 304) and recorded in `findings.md` #14 |
| NFR-03 | Response time SLA | P2 | ⬜ Needs an agreed SLA with the service owner first |
| NFR-04 | Security headers | P3 | ⬜ Documented |
| NFR-05 | XSS payload stored raw, escaped on render | P2 | ⬜ The render half is a UI concern |
| NFR-06 | Path traversal in a filename | P2 | ⬜ Partially covered by RD-03; see `findings.md` |
| NFR-07 | Secondary rate-limit behaviour | P3 | ⬜ Not automated — but **hit accidentally** during stability testing and documented in `findings.md` #20. `assertNotRateLimited` names it so a throttled run is never read as a broken suite |

<details>
<summary><b>Steps</b></summary>

- **NFR-01** — GET /gists → Read the `x-ratelimit-*` headers
- **NFR-02** — GET, then GET with `If-None-Match` → Compare `x-ratelimit-remaining`
- **NFR-03** — Time repeated GET /gists/{id} → Compute p95
- **NFR-04** — GET /gists → Inspect the security headers
- **NFR-05** — Create a gist with a `<script>` payload → GET it → Open it in the web UI
- **NFR-06** — POST /gists with filename `../../etc/passwd`
- **NFR-07** — Create gists rapidly until a 403 → Inspect the body and headers

</details>
---
plan3: true
status: ready
created: 2026-10-14
updated: 2026-10-14T14:54:14.746Z
reviewed: 2026-10-14
started: 2026-10-14T14:33:33.649Z
---

# DomainCheck: free domain discoverer for .com, .bg and .eu with pi-driven name ideas

## Original request

> lets make a free domain disoverer. think of a fast way to verify if a domain name is taken. we are looking for .com, .bg, .eu ony and when query for some to specify (ask_user checkboxes) which ones to consider. if we find more than one way to quickly verify programatically availability then we can load balance and distribute checks between them and execut ein parallel. thats part 1. part 2 is actually getting the creativity here - a description of what we want to get and the domain name how to look it uses all plan models to get ideas, then suggest. this will be a web page connected to us here and using pi to search. so we will have projects that will be separate, for example we search domain name for phtobook, or for interrior design site, etc. for each we can have a rules that will be remembered + preferences that will accumulate. like rule for interrior design site to contain something about design, or creativity, or transfor or house, etc, can have suffixes like studio, home, so design.com, designhome.com etc. or some prefixes. then accept how many to receive and I can say some I like some I dislike some are uncertain. and update the rules. all these are saved so no longer try some that are tried, also saves which sites are already taken to never check or offer them again. an then several steps forward with changing direction we can get the site we want. it saves and always shows candidates and the uncertain ones and I can always change some of them into uncertain or outright remove. actually instead of uncertain or good lets have 3 states of liking - medal, thumbs up, some wave of uncertainty and red X to outright reject. use frontend design to make it somewhat readable

## Goal, requirements, and non-goals

Goal: a local web page, backed by a zero-dependency Node server, that generates domain-name ideas per project with pi models. It checks availability in parallel across several verification methods, remembers everything, and narrows down to a name over repeated rounds.

Requirements:
- **R1 TLDs:** only .com, .bg and .eu. Each request carries checkboxes for which of them to check. The default is the project's last selection.
- **R2 Fast checks:** use more than one verification method where possible. Spread checks across methods with per-method concurrency caps, run them in parallel, and fail over when a method errors.
- **R3 Projects:** separate projects (for example photobook or interior design site). Each has a description, remembered rules and accumulated preferences.
- **R4 Rules:** free-text rules per project, such as keywords (design, creativity, transform, house), suffixes (studio, home) and prefixes. The user edits them.
- **R5 Ideation:** every model in `workOrchestrator.plan3.models` (pi settings, read at runtime) generates ideas in parallel. The results are merged and deduplicated.
- **R6 Count:** the user asks for N, which means N names that are free in at least one ticked TLD. Rounds repeat until N are found or a round cap is hit.
- **R7 Memory:** every tried name is stored per project and never generated again. Taken domains are cached forever and never checked or offered again.
- **R8 Ratings:** four states: medal, thumbs up, wave (uncertain) and red X (reject). Any rating can be changed at any time. Red X removes a name from the board but keeps it remembered.
- **R9 Board:** the page always shows the current candidates: unrated, medal, thumbs up and wave.
- **R10 Batch commit:** ratings are staged on the page. The user rates many names, then presses Commit. Only after a commit does one pi call suggest rule changes, which the user accepts or ignores one by one.
- **R11 Readable UI:** designed with the frontend-design skill (direction below).

Non-goals:
- No TLDs beyond the three. No registration, purchase or pricing.
- No accounts or multi-user access. No hosting beyond localhost.
- No web search, trademark search or tools in the pi calls (see Q-03).
- No frameworks, build step or npm dependencies.

Acceptance examples:
- New project "Interior design site", rule "contains design, home, house or transform; may end in studio or home", N=10, ticked .com and .bg. The board fills with 10 names, each showing a lit chip for every ticked TLD where it is free.
- Asking again never shows a name from an earlier round, and never re-checks a domain cached as taken.
- The user marks 20 names red X and 5 thumbs up, then presses Commit. All 25 save in one request, and pi then shows a few rule suggestions with Accept and Ignore buttons.
- After a restart of `node server.mjs`, projects, rules, ratings and the taken cache are all still there.

## Decisions

- **D-01 Stack:** Node 24 with zero dependencies: `node:http` server, `node:sqlite` storage, `fetch` for RDAP and DoH, `node:net` for WHOIS, and vanilla HTML, CSS and JS served statically. Source: user answer, 2026-10-14. Rationale: everything needed is built in, so there is nothing to install. Note: `node:sqlite` prints an ExperimentalWarning on Node 24.14 but works (verified).
- **D-02 pi integration:** spawn one child per model: `node C:\Users\Flex\.pi\agent\bin\pi-launcher.js --print --model <m> --thinking <t> --no-tools --no-session --no-extensions --no-skills --no-context-files`, with the prompt on stdin. Source: user answer, 2026-10-14. Rationale: smallest isolated option, and it reuses existing pi credentials. Verified: a gpt-6-astra call this way returned a clean JSON array in about 4 s. Spawning `node` directly avoids the `.cmd` shell requirement on Windows. Resolve the launcher path from `PI_LAUNCHER` env or the default above.
- **D-03 Models:** read `workOrchestrator.plan3.models` (model and thinking pairs) from `C:\Users\Flex\.pi\agent\settings.json` on every generation. Today these are openai-codex/gpt-6-astra (high) and anthropic/claude-opus-5-5 (high). Source: user answer, 2026-10-14.
- **D-04 Count semantics:** N means N available names; rounds repeat up to a cap. Source: user answer, 2026-10-14.
- **D-05 Rule updates:** the user edits rules manually. pi suggests rule changes only after a committed batch of ratings, and the user accepts or ignores each suggestion. Source: user answer, 2026-10-14 ("present free ones then I do check check check, commit and THEN that runs").
- **D-06 Verification methods** (measured once from this machine on 2026-10-14; rate limits not measured):
  - DoH NS lookup via `https://cloudflare-dns.com/dns-query` and `https://dns.google/resolve` (`accept: application/dns-json`), for all TLDs, at 6 to 130 ms. Only Status 0 with at least one NS record (type 2) in `Answer` means taken (final). Anything else needs registry confirmation: Status 3 (NXDOMAIN), Status 0 with an empty answer, SERVFAIL, or a malformed or throttled reply. Names can be registered without NS records, or reserved. (Amended after review, finding 1.)
  - .com RDAP: `https://rdap.verisign.com/com/v1/domain/<d>` returns 200 when taken and 404 when free, at about 140 to 190 ms.
  - .com WHOIS: `whois.verisign-grs.com:43` answers `No match for "<D>"` when free, at about 60 to 100 ms.
  - .bg WHOIS: `whois.register.bg:43` answers `registration status: available` or `busy, active`, at about 35 to 55 ms. .bg has no RDAP (IANA bootstrap).
  - .eu WHOIS: `whois.eu:43` answers `Status: AVAILABLE` when free; a taken name shows Registrar and Name servers instead. About 75 to 110 ms. .eu has no RDAP (IANA bootstrap).
  - Source: IANA `https://data.iana.org/rdap/dns.json` and live probes (research notebook).
- **D-07 Pipeline:** DoH prefilter first, with the two resolvers load-balanced. Every name without a positive NS answer goes to the registry, load-balanced across RDAP and WHOIS for .com; .bg and .eu have one registry method each. An error or timeout fails over to another method of the same kind. When none succeeds, the result is `unknown` and is not cached.
- **D-08 Method limits** (P1-1 probe, `C-PROBE`, 2026-10-14). Each method got up to 40 queries at concurrency 1, then 4, then 8, and stopped at the first error. About 1 in 5 queries was a known-taken name.

  | Method | p50 | Worst seen | First problem | Cap | Timeout |
  |---|---|---|---|---|---|
  | DoH Cloudflare | 8 ms | 55 ms | none in 40 | 8 | 3 s |
  | DoH Google | 47 ms | 500 ms (at concurrency 4 and 8) | none in 40 | 4 | 3 s |
  | .com RDAP | 103 ms | 144 ms | none in 40 | 8 | 5 s |
  | .com WHOIS | 91 ms | 135 ms | a timeout at concurrency 8 (query 39) | 4 | 5 s |
  | .eu WHOIS | 74 ms | 3094 ms (at concurrency 8) | none in 40 | 4 | 5 s |
  | .bg WHOIS | 35 ms | 76 ms | `Query limit exceeded, try again later.` after 5 queries at concurrency 1 | 1, slow queue (D-09) | 5 s |

  The .bg block lasted at least 35 minutes. Repeated polling during the block may have extended it, which was not measured. Any reply that is not a recognised free or taken marker counts as throttling for that method. The scheduler then stops using that method for 10 minutes (assumed), and the result is `unknown`.
- **D-09 .bg checks:** .bg uses DoH only during rounds. A positive NS answer means taken; anything else is `likely` (likely free). A per-name Confirm button sends one WHOIS query to whois.register.bg through a server-side queue. The queue sends at most 1 query per 60 s (assumed). After a `Query limit exceeded` reply it pauses for 30 minutes (assumed) and reports the result as pending. Source: user answer, 2026-10-14, after the P1-1 probe hit the .bg limit. This supersedes D-07 for .bg.
- **Assumption A-03 (assumed):** for R6/D-04 counting, a `likely` .bg result counts as free. Otherwise a .bg-only request could never finish.
- **Assumption A-01 (over 95%):** single user, server bound to 127.0.0.1. "Connected to us here" means this machine.
- **Assumption A-02 (over 95%):** the taken cache is global across projects because a domain is taken for everyone. The tried-names list is per project.
- **Q-01** Should a rating belong to the base name or to each domain?
  - Context: a candidate like `designhome` can be free in .bg and taken in .com. The user's request rates "sites", but the board groups by name with TLD chips.
  - Recommendation: rate the base name, and show per-TLD availability as chips. This is simpler and matches how names are judged.
  - Option: Per base name — one rating per name, with TLD chips for information only.
  - Option: Per domain — separate ratings for designhome.com and designhome.bg. More precise, but triples the clicks.
  - Independent: yes
  - Answer: {"kind":"selection","selections":["Per base name"]}
  - Source: user via ask_user /plan3 resolve; not independently verified.
- **Q-02** How long should a "free" result stay trusted?
  - Context: R7 caches taken domains forever, as requested. Free domains can be registered later by someone else.
  - Recommendation: re-check free domains whose result is older than 24 hours when they are shown, and offer a manual "Recheck" button on the board.
  - Option: 24 h re-check on display — fresh enough, with few queries.
  - Option: Never re-check free — fewest queries, but the board can go stale.
  - Option: Re-check only on button — fully manual.
  - Independent: yes
  - Answer: {"kind":"selection","selections":["Re-check only on button"]}
  - Source: user via ask_user /plan3 resolve; not independently verified.
- **Q-03** Does "using pi to search" mean pi should also search the web, for example for brand clashes?
  - Context: D-02 runs pi with `--no-tools` for fast, clean JSON output. Web search would slow each call and needs tools enabled.
  - Recommendation: idea generation only, no tools, for now. Brand-clash search goes to the backlog.
  - Option: Ideas only — fast and deterministic output.
  - Option: Ideas plus web check — richer, but slower and costlier per round.
  - Independent: yes
  - Answer: {"kind":"selection","selections":["Ideas only"]}
  - Source: user via ask_user /plan3 resolve; not independently verified.
- **Q-04** What round cap and idea count per model should generation use?
  - Context: under D-04, generation loops until N free names are found. Each round costs one pi call per model (about 4 s or more each, in parallel) plus the checks.
  - Recommendation: each model asks for 2×N ideas per round, with at most 4 rounds. Stop early once N are free, and show "found k of N" when the cap is hit.
  - Option: 2×N per model, 4 rounds — balanced.
  - Option: 3×N per model, 2 rounds — fewer pi calls, larger prompts.
  - Independent: yes
  - Answer: {"kind":"selection","selections":["2×N per model, 4 rounds"]}
  - Source: user via ask_user /plan3 resolve; not independently verified.
- **Q-05** Should names outside ASCII, such as Cyrillic .bg or .eu IDNs, be supported?
  - Context: .bg and .eu accept IDNs, and the WHOIS behaviour for punycode names was not probed.
  - Recommendation: ASCII only (letters, digits and hyphen); reject anything else before checking.
  - Option: ASCII only — smallest scope.
  - Option: Support IDN via punycode — needs extra probes and UI.
  - Independent: yes
  - Answer: {"kind":"selection","selections":["ASCII only"]}
  - Source: user via ask_user /plan3 resolve; not independently verified.
- **Q-06** What happens to surplus free names when a round finds more than N?
  - Context: checks run in parallel, so the last round can find more than N free names; for example, N=1 can finish with 4 free. Those names are already checked. The tried memory (R7) stops them from ever being generated again, so dropping them loses them.
  - Recommendation: show all of them as candidates on the board. This is the smallest option and loses nothing; the count message says "found k" when k is more than N.
  - Option: Show all — the board may get a few more than N.
  - Option: Show N, keep the rest in reserve — the reserve is served first on the next request. Exact counts, but adds a reserve state.
  - Independent: yes
  - Answer: {"kind":"selection","selections":["Show all"]}
  - Source: user via ask_user /plan3 resolve; not independently verified.
- **Q-07** Which model writes the rule suggestions after a commit?
  - Context: D-05 needs one pi call per commit. D-03 covers ideation only. Settings have `workOrchestrator.plan3.planningModel` = anthropic/claude-opus-5-5, and `workOrchestrator.plan3.models` lists gpt-6-astra and claude-opus-5-5 (read 2026-10-14).
  - Recommendation: use `workOrchestrator.plan3.planningModel`, read at runtime like D-03. It is one model and follows your settings.
  - Option: planningModel — one call, follows settings.
  - Option: First entry of plan3.models — reuses the D-03 list.
  - Option: All plan3.models, with merged suggestions — more ideas, but more calls and duplicates.
  - Independent: yes
  - Answer: {"kind":"selection","selections":["planningModel"]}
  - Source: user via ask_user /plan3 resolve; not independently verified.



## Open questions

### Blocking

None.

### Deferred

None.

## Relevant files and approach

The repository is empty (`git init` only). New files, all ES modules:

- `package.json`: `"type": "module"` and scripts `start` (`node server.mjs`) and `test` (`node --test`). No dependencies.
- `server.mjs`: `node:http` on 127.0.0.1:8787 (review finding 3). It checks request boundaries:
  - It rejects a `Host` that is not `127.0.0.1:8787` or `localhost:8787`, which blocks DNS rebinding.
  - Mutations must carry `Content-Type: application/json` and an `Origin` that is absent or matches the same host, which blocks cross-site requests.
  - Bodies are limited to 64 KB. N must be an integer from 1 to 50. TLDs must be a non-empty subset of com, bg and eu. A rating must be one of the four values, or null, for a label that belongs to that project.
  - Static paths resolve inside `public/` only.
  - The page renders all user and model text with `textContent`, never as HTML.
  - It serves `public/` and a small JSON API: projects CRUD, rules CRUD, `POST /api/projects/:id/generate` (body: N and TLDs), `POST /api/projects/:id/ratings` (batch commit, which triggers the rule-suggestion call), suggestion accept and ignore, recheck, and .bg confirm (D-09).
- `src/check.mjs`: method table (D-06), DoH prefilter, a per-method concurrency cap with a least-busy pick, timeouts, failover, and response parsers. Exports `checkDomains(domains) -> Map<domain, 'free'|'taken'|'likely'|'unknown'>`. During rounds, .bg is checked by DoH only, which yields taken or `likely` (D-09). `confirmBg(domain)` runs the slow .bg WHOIS queue.
- `src/db.mjs`: `node:sqlite` file `data/domaincheck.db` (gitignored). Tables:
  - `projects(id, name, description, tlds, created)`
  - `rules(id, project_id, text, created)`
  - `names(project_id, label, state, rating, tlds, round, created, unique(project_id, label))`. `state` is `tried` (generated, never shown) or `candidate` (offered on the board). `rating` is null, medal, up, wave or reject. `tlds` holds the TLDs ticked for that request. The board is rebuilt from `state = candidate` and its rating, never from availability alone (review finding 2)
  - `availability(domain primary key, status, method, checked_at)`, holding taken and free results. Free results are never re-checked automatically, only by the Recheck button (Q-02); a re-check that finds a domain taken caches it as taken
  - `suggestions(id, project_id, text, status)`
- `src/ideas.mjs`: reads models from pi settings (D-03), builds the prompt (description, rules, names grouped by rating, the recent tried list), spawns pi per model in parallel (D-02), and parses a JSON array of labels. It validates labels against `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`, then merges and deduplicates. It also exports `suggestRules(project, committedRatings)`.
- `src/generate.mjs`: the round loop (D-04 and Q-04). Each model asks for 2×N ideas per round, for at most 4 rounds. Each round drops names already tried, inserts the new names, checks them in the ticked TLDs (skipping taken-cached domains) and stops at N free. Every free name found becomes a candidate, even when the total is more than N (Q-06); the result then reports "found k". When the cap is hit, the result reports "found k of N".
- `public/index.html`, `public/app.css`, `public/app.js`: one page.
- `test/*.test.mjs`: `node:test` unit tests for parsers, scheduler, label validation, the generate loop with stubs, and the db round trip.
- `.gitignore`: `data/`.

Pi prompt rules: ask for `ONLY a JSON array of lowercase labels without TLD`. Extract the first `[...]` from stdout as a fallback. A model that fails or times out (90 s) is skipped and the round continues with the others. The launcher starts the real CLI as a grandchild (`pi-launcher.js` line 28, `spawnSync`), so a timeout kills the whole process tree, using `taskkill /pid <pid> /T /F` on Windows, and waits for the child's `close` event before the call counts as finished (review finding 4).

Rating commit (review finding 5): the whole batch is saved in one SQLite transaction. An invalid entry rolls back the batch. Only after the save succeeds does the server run `suggestRules`. The response reports `saved` and `suggestions` separately, with an error field when pi fails. The page clears staged ratings only after `saved` is confirmed, and a pi failure never undoes saved ratings.

Design direction (frontend-design skill: `C:\soft\git\ce-workflow\skills\frontend-design\SKILL.md`; proposed by the agent, not user-approved):

- Subject: a naming bench, where names are the specimen. The memorable element is each name set large in a wide grotesk, with a row of three TLD chips that light up when free.
- Palette: slate paper `#E9EDF1`, ink `#16202E`, free green `#1F7A57`, taken grey `#9AA4B0`, medal gold `#B8862B`, thumbs-up blue `#2F5FD0`, wave violet `#6E56B0`, reject red `#B3261E`.
- Type: Archivo with width 125 (from Google Fonts, with a `system-ui` fallback) for names; `system-ui` for the interface. Sentence case, no all-caps labels.
- Layout: a left rail lists projects. The main column has the project description and rules on top, then a request bar (N, TLD checkboxes, Generate), then the board grouped as Medal, Thumbs up, Wave and Unrated. A sticky bar shows "k changes staged" with a Commit button. Rule suggestions appear inline under the rules after a commit, and a filter shows rejected names so they can be restored.
- Quality floor: keyboard rating (1 to 4 keys on a focused card), visible focus, mobile-width single column, `prefers-reduced-motion` respected, rating icons with text labels for screen readers.

## Commands

- **C-TEST:** `npm test`, which runs `node --test` (the Node built-in runner; defined by this plan because the repo has no existing commands).
- **C-RUN:** `npm start`, then open `http://127.0.0.1:8787`.
- **C-PROBE:** `node "%TEMP%\dc-probe.mjs"`, a scratch rate-limit probe kept outside the repo.

## Phases

### Phase 1: Verification method limits [think]

- [x] **P1-1** Probed all 6 methods. The D-08 table of caps and timeouts was added. .bg WHOIS throttles after 5 queries, so the user chose D-09: .bg is DNS-only and labelled "likely free", with WHOIS confirmation on demand.
- [x] **P1-2** 16 parser fixtures are in test/fixtures. The DoH, RDAP and WHOIS fixtures for .com and .eu, the .bg throttle reply and the reserved .eu ("Status: NOT AVAILABLE") are live captures. .bg free and taken are synthetic, built from the observed markers, because the registry is still blocking us. A malformed DoH reply is synthetic.

### Phase 2: Availability checker [code]

- [x] **P2-1** Added package.json, .gitignore and src/check.mjs: parsers, DoH prefilter, least-busy scheduler with caps, failover and throttle backoff, the .bg "likely" result and the confirm queue.
- [wip] **P2-2** Add scheduler tests: the least-busy pick, cap respected, failover on error, and `unknown` when every method fails.
  - Also test throttle backoff, and that the .bg confirm queue spaces queries and pauses after a limit reply (D-09).
  - Use stubbed methods, no network. Check: C-TEST passes.

### Phase 3: Storage and ideation [code]

- [ ] **P3-1** Create `src/db.mjs` with the schema above and tests for round trip, unique tried names, global taken cache and candidate state.
  - Also test that a failed rating batch rolls back, and that the board rebuilds from candidate rows after the database reopens.
  - Check: C-TEST passes using an in-memory database.
- [ ] **P3-2** Create `src/ideas.mjs` with model loading from settings, prompt building, the parallel pi spawn, and label parsing and validation.
  - Test parsing and validation with canned stdout.
  - Timeout test: a stub launcher starts a long-lived grandchild; after the timeout, both processes are gone and the call resolves.
  - Check: C-TEST passes.
- [ ] **P3-3** Create `src/generate.mjs` with the round loop and cap, skipping tried names and taken-cached domains.
  - Test with stubbed ideas and check functions: it stops at N, stops after 4 rounds with "found k of N", requests 2×N ideas per model, and makes no repeat checks.
  - Also test N=1 with several free names in one round: all of them become candidates (Q-06). Also test that changing the ticked TLDs checks only the new ones.
  - Check: C-TEST passes.

### Phase 4: Web page and API [code]

- [ ] **P4-1** Create `server.mjs` with the static file server and JSON API listed above, bound to 127.0.0.1.
  - Add HTTP tests using a server started on an ephemeral port: wrong Host is refused, cross-origin POST is refused, non-JSON POST is refused, an oversized body is refused, and `/../` traversal is refused.
  - Check: C-TEST passes. Then run C-RUN and confirm `curl http://127.0.0.1:8787/api/projects` returns `[]` on a fresh database.
- [ ] **P4-2** Build `public/` following the design direction, with staged ratings, Commit, suggestion Accept and Ignore, and the rejected filter.
  - Ratings apply to the base name (Q-01). TLD chips are information only. A Recheck button re-checks a name's free domains (Q-02). .bg chips show "likely free" with a Confirm button and a pending state (D-09).
  - Check: C-RUN, then capture the page with `screen_read` (browser target, headless) at desktop and mobile widths, and review it against the direction.
- [ ] **P4-3** Wire the batch commit to a `suggestRules` call that runs once per commit and returns pending suggestions.
  - Uses `workOrchestrator.plan3.planningModel` (Q-07), read from pi settings at runtime like D-03. Save and suggestion outcomes are separate, as described under Rating commit.
  - Test with a stubbed `suggestRules`: a valid batch saves; an invalid batch rolls back; pi failing after the save keeps the ratings and returns an error. Check: C-TEST passes.
  - Manual check: a commit of 3 ratings produces one pi call, visible in the server log, and suggestions appear.

### Phase 5: Prompt quality and flow tuning [think]

- [ ] **P5-1** Run two real projects (photobook, interior design) for three rounds each, and tune the ideation and suggestion prompts.
  - Judge: share of free names, rule adherence, repeats, and diversity across the models. Record prompt changes in Amendments.
  - Check: a round of N=10 on .com and .bg reaches 10 free names within the cap.
- [human] **P5-2** User tries the page on a real naming task and confirms the flow and readability.
  - Check: user approval, recorded in Decisions.
  - note: Needs the user to try the page.

## Global validation

- C-TEST passes with no network access (all network code stubbed in tests).
- Manual check of the acceptance examples above with C-RUN, including the restart persistence check.
- No product files outside the paths listed in Relevant files; `data/` is not committed.

## Backlog

- Brand-clash web search per name (Q-03).
- IDN support (Q-05).
- A registrar link per free domain.
- Export the shortlist.
- Replace the synthetic .bg free and taken fixtures with live captures once whois.register.bg unblocks.
- Find a real .com registered without NS records for a fixture; the pipeline already sends such names to the registry.


## Resume context

All questions, Q-01 to Q-07, are answered and written into the plan. Surplus free names all become candidates, and rule suggestions use planningModel. The review findings are applied. No questions remain open. The repo has only git init and this plan. Next: P1-1, a rate-limit probe with a scratch script in %TEMP%, outside the repo.

## Amendments

Append material changes and their reasons; preserve the original request and settled decisions.
- 2026-10-14 P1-1: whois.register.bg throttled after 5 queries, so the user chose D-09: .bg uses DNS only and is labelled "likely free", with WHOIS confirmation on demand. Added D-08 limits and the A-03 counting assumption, and amended check.mjs, P1-2, P2-1, P2-2 and P4-2 to match. The scope is unchanged apart from the user-approved D-09.
- 2026-10-14: carried the Q-06 and Q-07 answers into the build steps. All surplus free names become candidates (generate.mjs, P3-3). Rule suggestions use planningModel (P4-3). No change to scope.
- 2026-10-14 review (plan3-advisor, gpt-6-astra high), every finding validated against the plan and the launcher source:
  - Finding 1, DoH NOERROR treated as taken: **accepted**. D-06 and D-07 now treat only a positive NS answer as taken, and P1-2 adds DoH fixtures. These were agent research decisions, not user decisions, so amending them is in scope.
  - Finding 2, tried names versus board candidates: **accepted**. `names` gains `state` and `tlds`, and P3-1 and P3-3 gain tests. Surplus handling is raised as Q-06.
  - Finding 3, local API trust boundary: **accepted**. Host, Origin, JSON, size and path checks, `textContent` rendering, and HTTP tests in P4-1. Binding to localhost alone does not stop DNS rebinding or cross-site POSTs.
  - Finding 4, grandchild process on timeout: **accepted**, confirmed in `C:\Users\Flex\.pi\agent\bin\pi-launcher.js` line 28, which uses `spawnSync` to start the CLI. Tree kill and a stub test were added to P3-2.
  - Finding 5, commit durability and pi failure: **accepted**. Transactional save, separate outcomes, and tests in P3-1 and P4-3. The suggestion model is raised as Q-07.
- 2026-10-14: carried the Q-01 to Q-05 answers into the build steps. Ratings are per base name and a Recheck button handles free results (P4-2). The round loop asks each model for 2×N ideas for at most 4 rounds and reports "found k of N" (P3-3 and generate.mjs). Free results are only re-checked manually (availability table). No change to scope.

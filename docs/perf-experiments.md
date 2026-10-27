# Performance experiments log

Every latency experiment on fx0's prompt path is recorded here: hypothesis, change, security review, measured result, and decision. Measurements come from `npm run perf:lab` (see [performance.md](performance.md)). Raw runs and HTML reports stay local under `.next/fx0-lab/<experiment>/`. They are not committed.

## Ground rules

- **Security is not traded for speed.** Every change keeps authentication, revocation, ownership, same-origin checks, funding-before-admission, idempotency, and durability exactly as strong as before. A candidate that weakens any of them is rejected regardless of its gain.
- One hypothesis per experiment. Span-level traces attribute each part when one candidate carries two independent changes.
- Paired A/B with balanced, seeded order, equal instrumentation, and the same account, team, model settings, workload, and environment. Failures are kept, never retried.
- An A/A control measures noise first. Effects smaller than that noise are reported as "not detected", not as gains.
- Local caveat: `next dev` on a laptop talks to remote Redis and Neon, so database-bound stages are larger than on Vercel (iad1). Prefer relative, same-environment comparisons, and confirm on a preview before claiming production impact.

## Baseline anatomy (local-development, warm, "Reply exactly OK. Do not use tools.")

Medians from 4 warm prompts on 2026-10-27, server clock relative to the start of the request handler:

| Stage | Start | Duration |
| --- | ---: | ---: |
| `request.auth` (cookies, revocation check) | 0 | ~155 ms |
| auth → journal gap (route checks, ownership) | | ~195 ms (varies 190–900 ms) |
| `prompt.journal` | ~350 | ~160 ms |
| `prompt.credential` (save turn funding) | ~515 | ~330 ms |
| `prompt.hydrate` | ~850 | ~165 ms |
| `prompt.bind` (libfx session) | ~1010 | ~185 ms |
| `prompt.accepted` (libfx admission) | ~1195 | ~10 ms |
| wait for first journal read before headers | | ~170 ms |
| `model.prepare` (funding, draft observer, step budget) | | ~560 ms |
| `model.headers` (AI Gateway until response headers) | | ~880 ms |

Browser: Sending (POST → headers) ≈ 1.39 s; first text ≈ 3.4–4.2 s.

## Noise: A/A control

`aa-smoke`, 2 pairs, same source both sides: Sending paired Δ −0.3 ms; first text paired Δ −226 ms. Sending is stable. First text is dominated by model-side variance (±300 ms per prompt), so it needs ~10+ pairs to detect effects below ~200 ms.

## Experiment 1: early headers + parallel funding save

- **Date:** 2026-10-27. **Lab:** `.next/fx0-lab/early-ack`. **Branch (local):** `esteban/fx0-perf-early-ack`.
- **Hypothesis A:** response headers wait for the first journal read (~170 ms). The trace confirmed this in 4 of 4 prompts: browser POST→headers matched handler start→first SSE delivery within 7 ms. Writing an SSE comment frame when the stream opens sends the headers immediately.
- **Hypothesis B:** saving the turn credential (~330 ms) does not depend on hydrating or binding the libfx session (~350 ms), so the two can run together. Both settle before libfx sees the message.
- **Change:** `lib/event-stream.ts` sends `: open` on start; `lib/agent.ts` runs credential save and hydrate→bind with `Promise.all`, then admits. Tests: the stream opens before any journal read finishes; the funding record is saved before libfx sees the message even while the session is prepared alongside it; a failed credential save stops the prompt before libfx.
- **Security review:**
  - The comment frame is written only after the route returns its `Response`, which happens after auth, revocation, same-origin, ownership, funding, and admission have all completed. Rotated cookies are still appended to the same headers. Clients already ignore comment frames (the 15 s heartbeat uses one).
  - Funding-before-admission is unchanged and now has a regression test. If the credential save fails after the session is bound, the result is a bound libfx session with no message. That is the same state a new chat reaches when a later step fails, and it grants nothing.
  - No credential, token, or ownership check is skipped, cached, or reordered after a write.
- **Result:** 10 valid pairs, compatible, 0 failures.

  | Metric (paired median) | Δ |
  | --- | ---: |
  | Sending | **−333 ms (23 %)** |
  | Server admission end | −99 ms |
  | First text | −28 ms (not detected; noise ±200 ms) |

- **Attribution from spans:** early headers reduced handler-end→headers from ~190 ms to ~8 ms in every candidate run. Parallel save cut the handler by ~330 ms when the save took its usual time. In 3 of 10 runs the save itself slowed to 514–713 ms under concurrency, which absorbed the gain.
- **Decision:** keep early headers (consistent, no security impact). Keep parallel save provisionally: a small median gain with variance. Re-test it on a Vercel preview, where database round trips are shorter, before deciding.

## Finding: the local handler is a chain of ~7 serial round trips

Added measurement-only spans `request.revocation`, `request.owner`, and `prompt.activate` (2026-10-27, lab `gap-probe`, 4 warm prompts). The auth → journal gap is now fully explained:

| Stage | Duration | Round trips |
| --- | ---: | --- |
| `request.revocation` (nearly all of `request.auth`) | ~160 ms | 1 Redis GET |
| `request.owner` | 175–210 ms | 1 Neon query |
| `prompt.journal` | ~170 ms | 1 Redis script |
| `prompt.credential` | ~330 ms | 2: revocation GET, then write pipeline |
| `prompt.hydrate` | ~165 ms | 1 Redis read |
| `prompt.bind` | ~165 ms | 1 Redis write (new chat) |

Each round trip from this laptop to Redis/Neon in iad1 costs ~160 ms, so the local lab inflates database-bound stages by an order of magnitude compared with Vercel. **What transfers to production is the count of serial round trips, not the local milliseconds.** Production Sending is instead dominated by libfx's Vercel admission: 465–1070 ms in earlier preview logs, including the queue backstop. Local file durability hides that (~10 ms locally).

Two more observations:

- The headless driver types and presses Enter immediately. The draft reservation (`POST /api/sessions`) and the typing warm-up (`POST /api/warm`) therefore race the prompt in the same process. Real users usually type for seconds first, so local runs include contention that real sends mostly avoid. This is equal on both A/B sides, but it inflates variance.
- The server trace recorder lives in a process global and keeps its allowlist across hot reloads. **Restart `next dev` after adding trace names**, or new spans are silently dropped.

## Production-like anatomy (vercel-preview, warm)

Preview `fx0-git-esteban-fx0-request-tracing.labs.vercel.dev`, commit `d5b8bc7`, tracing enabled only for that branch through `FX0_TRACE_PREVIEW=1`. Lab `preview-aa`: 6 warm prompts in 3 A/A pairs, plus 1 excluded cold sample. Medians:

| Stage | Median | Note |
| --- | ---: | --- |
| `request.revocation` | 4 ms | |
| `request.owner` | 14 ms | |
| `prompt.journal` + `credential` + `hydrate` + `bind` | ~25 ms | `bind` was 326 ms once (cold libfx backend) |
| **`prompt.accepted` (libfx Vercel admission)** | **549 ms** | **92 % of the handler** |
| Handler total | 599 ms | |
| Outside the handler (browser ↔ Vercel network) | ~320 ms | Sending minus handler |
| **Sending** | **849 ms** | |
| Accepted → `model.prepare` start (libfx turn start in the request) | ~196 ms | |
| `model.prepare` | 17 ms | |
| `model.headers` (AI Gateway TTFB) | ~741 ms | Once 1.5 s |
| **First text** | **2.55 s** | Local was 3.4–4.2 s |

The cold first sample took 2.59 s Sending: `prompt.bind` 453 ms and `prompt.accepted` 1124 ms.

**Correction to Experiment 1:** in production, fx0's own database stages total ~45 ms, so early headers save ~18 ms and the parallel credential save at most ~10 ms. The local −333 ms came from laptop-to-iad1 round trips and does not transfer. The real targets are libfx admission (549 ms), libfx turn start (~196 ms), and model TTFB (~741 ms).

To see inside admission, the server recorder now also observes every undici request through `diagnostics_channel`, including the copy bundled into libfx's Vercel World. It records only a fixed category (`net.workflow`, `net.queue`, `net.oidc`, `net.vercel_api`, `net.redis`, `net.neon`, `net.gateway`, `net.other`), the status, and the time to response headers. It never records the URL, path, headers or body. It only runs when tracing is enabled, and never in production.

## Inside libfx admission (vercel-preview, network spans)

Lab `preview-net`, commit `9a418d1`, 4 warm prompts to new chats. `prompt.accepted` took 377–534 ms (Sending 605–771 ms; first text 1.82–2.09 s). Its network calls are the same in every run, and all serial:

| # | Call | Status | Duration |
| --- | --- | --- | ---: |
| 1 | Session log length (`log.ui.length()`) | 404 | 43–114 ms |
| 2 | Session log read, twice in parallel (caller's `log.read()` and the one inside `send()`) | 404, 404 | 40–60 ms |
| 3–5 | Three Workflow writes (message record and seeding) | 200 | 49–62, 55–92, 72–186 ms |
| 6 | Vercel Queues backstop | 201 | 49–84 ms |

Reading `libfx` 0.0.14 `durable.js` (`startTurn` / `send`) explains this. fx0 passes an explicit `messageId` so a retried send cannot duplicate the message, which takes the idempotent path: read the log length, then read the log while `send()` opens the session, reads the log again, records the message, and sends the queue backstop. Then `turn.accepted` resolves.

- Calls 1–2 read a session that this same request just created with `newSessionId()`. For a chat's first message they cannot find anything (404 every time). That is ~100–170 ms of serial reads with no information.
- Recording the message and creating the backstop before acknowledging are durability contracts (no accepted message may be lost if the function dies). They stay.
- The three writes are serial; whether any can be combined without losing atomicity is a libfx question.
- After admission, the turn starts in the same request: Redis/Neon funding reads (~10 ms) and more Workflow writes (100–460 ms, partly in parallel), then `model.prepare` and the Gateway call.

Host `vercel-workflow.com` was initially classified `net.other`. It is now `net.workflow`.

## Experiment 2: overlap libfx's viewer-start read with send()

**Hypothesis.** On a prompt with an explicit `messageId`, libfx 0.0.14 awaits `log.ui.length()` (the viewer's start, World `streams.getInfo`) before `send()` begins. The invariant only needs that read to land before the message is written to the log, and before the log read that answers the retry. Starting it alongside `send()`'s own session read removes one serial World round trip: expected −40…110 ms on Sending and on first text.

**Where the code lives.** libfx is `vercel-labs/fx` `sdk/durable.js`. Current `main` has the same structure (`startTurn` / `send`), so a positive result becomes a libfx PR there, with the TLA+ models in `tests/tla/sdk/` updated and checked. fx0 then needs a libfx release.

**What else in admission was checked and left alone.**

- The run creation (`ensureRun`) and the two appends (seed checkpoint, then input) use optimistic concurrency on `eventCount`, one at a time. Combining them needs a batch API in World.
- The Queues backstop must exist before acknowledging, so an accepted message survives the function dying.
- The duplicate log read already runs in parallel, so removing it saves nothing.

**Method.** Branch `esteban/fx0-perf-libfx-viewer-start` (commit `c6a9957`, never merged) patches the installed libfx at install time with `scripts/patch-libfx-experiment.mjs`. The script checks the exact version and that each fragment matches exactly once, so it fails the build rather than patching partially. Vercel's build log shows it applied. `FX0_TRACE_PREVIEW=1` is scoped to that branch. A/B: 10 balanced pairs against the tracing preview (`2d31e59`), plus one warm-up each, lab `exp2-viewer-start`.

**Security and correctness review.** Nothing about auth, credentials, tenancy or the queue changes. Tests on the real installed libfx with an instrumented local World (`tests/libfx-viewer-start-experiment.test.mjs`) prove:

- No log write happens before the viewer start lands.
- `send()`'s read now overlaps it: this check fails on unpatched libfx and passes on the patched one.
- A failed stream lookup (libfx counts it as an empty stream) still runs the turn once and shows the whole turn.
- A retry of the same `messageId` answers from the log without running the model again.

The 4 existing real-libfx tests also pass, along with core 170, auth 261, trace 59, typecheck and build.

**Result.** 10 valid pairs, 0 failures (lab `exp2-viewer-start`).

| Metric | Baseline p50 | Candidate p50 | Paired delta p50 |
| --- | ---: | ---: | ---: |
| Admission start → first write (the patched step) | 158 ms | 118 ms | **−44 ms** (7 of 10 pairs faster) |
| `prompt.accepted` | 526 ms | 509 ms | −99 ms (noisy: +213, +333, +120 in some pairs) |
| Sending | 832 ms | 884 ms | +1 ms |
| First text | 2063 ms | 2174 ms | +195 ms (inside preview noise, ~±300 ms) |

The network spans confirm the mechanism in production: on the candidate, the viewer-start read and `send()`'s read start together, and the first write follows the viewer start. When `streams.getInfo` itself is slow (242 ms once), the write still waits for it, by design.

**Decision.** The change works and is safe, but saves one round trip (~45 ms, ~5 % of Sending). That is below the per-prompt spread, so 10 pairs cannot show it end to end; ~40+ pairs would be needed. It is a reasonable small libfx PR (it helps every libfx app on Vercel), but not the big win. The experiment branch stays unmerged.

**Finding from the same data: cold starts.** 3 of 20 prompts (both sides: baseline 3 and 5, candidate 3 and 4) had 2.1–3.0 s Sending. The extra time sat before the handler started (+0.7…1.3 s outside it) and in `prompt.bind` (+470 ms, libfx agent creation). If ~15 % of prompts pay +1.5–2 s, that dwarfs any 45 ms admission tweak. Next: confirm they are cold function instances (new trace lanes) and measure what instance startup and the first `createFxAgent` cost.

## Cold starts: what a new instance's first prompt pays

**Measurement added** (numbers only, tracing-enabled previews only): `request.handle` carries the process `uptime` and `first` (first traced request of the process); `registered` and `loaded` record when Next ran `instrumentation.ts` `register()` and when the prompt route module was evaluated; `agent.create` and `agent.session_id` split `prompt.bind`.

**Fresh-deploy samples** (labs `cold-1` and `cold-2`; the first prompt after a deploy is guaranteed cold):

| Stage | Cold (2 samples) | Warm | Extra |
| --- | ---: | ---: | ---: |
| Outside the handler (Next initializes, route module loads) | 629–725 ms | 200–360 ms | ~+430 ms |
| Before `prompt.bind` (auth, journal, credential, hydrate) | 217–222 ms | 35–47 ms | ~+180 ms |
| `agent.session_id` (libfx durable backend init; no network) | 331–351 ms | 0–1 ms | ~+340 ms |
| `prompt.accepted` | 951–1088 ms | 394–537 ms | ~+500 ms; mostly the first Vercel Queues send (574 ms vs ~50–85 ms) |
| **Sending** | **2170–2388 ms** | **659–885 ms** | **~+1.5 s** |

**Findings.**

1. Every slow outlier in Experiment 2 (`prompt.bind` > 300 ms) was the first prompt of a process.
2. Vercel had started the cold process 20–28 s before the prompt, but Next initializes lazily: `register()` ran 157 ms before the handler. So `instrumentation.ts` cannot move this work ahead of the request; it would run inside it.
3. Routes are bundled into functions by configuration. The `maxDuration = 800` group is `prompt`, `events`, `model`, `answer`, `cancel`, `libfx`. `/api/warm` had `maxDuration = 60`, so it ran in a different function and never warmed the prompt's instances. That is why the earlier warm-up (PR #33) showed no gain. A prompt landing on an instance that had served `/api/events` or `/api/model` had the libfx agent already created.
4. Process mixing is visible: the second prompt in `cold-2` landed on a different instance (registered at 0.5 s) than the first.

**Method lessons recorded.**

- Before every measurement, verify that the branch alias serves the deployment of the exact commit: use `vercel list --meta githubCommitSha=<sha>` and `vercel inspect <alias>`. Do not use the GitHub status: a second Vercel project (`shadcn/fx0`) posts the same "Vercel – fx0" context for these branches.
- `next build` deletes `.next`. Earlier lab runs stored there were lost (their numbers survive in this log). `perf:lab` now refuses an `--out` inside `.next`; labs live in `~/.fx0-perf-labs/`.

## Experiment 3: warm the prompt's own function while the user types

**Hypothesis.** If `/api/warm` shares the prompt's function, the existing typing warm-up (hydrate, create the libfx agent, plus loading libfx's durable backend) initializes the instance the prompt will use. That would remove most of the ~1.5 s a cold first prompt pays, provided the person pauses before sending.

**Change** (branch `esteban/fx0-perf-warm-group`, commit `60a1c5f`):

- `/api/warm` sets `maxDuration = 800`, the same as `/api/prompt`.
- `warmChat` also awaits `agent().newSessionId()`, which loads the durable backend and returns an id without writing anything.
- `tests/function-grouping.test.mjs` keeps both routes' `maxDuration` equal. It fails when they differ (checked by mutation).

**Security review.** `/api/warm` keeps the same auth (`withSessionRoute`) and ownership check, and does the same work plus one id generation. `maxDuration` only caps run time; the route still returns in milliseconds. Nothing reaches the model and nothing is written.

**Method.** Cold A/B: before each pair, both previews are redeployed and the run waits until each alias serves its new READY deployment, so both sides' prompts land on fresh instances. One prompt per side, alternating order, `--think-ms 3000` on both sides. Lab `~/.fx0-perf-labs/exp3-warm-group-cold`.

**Result (cold).** 6 pairs, 12 prompts, 0 failures, same workload (`reply-ok-think3000ms`):

| Metric | Baseline p50 | Candidate p50 | Paired delta p50 | Per-pair deltas |
| --- | ---: | ---: | ---: | --- |
| **Sending** | 2580 ms | 1559 ms | **−983 ms (−38 %)** | −1014, −621, −916, −1130, −952, −1229 (6 of 6 faster) |
| **First text** | 3856 ms | 2931 ms | **−1056 ms** | +1520, −2306, −756, −1355, −321, −1757 (5 of 6 faster) |
| Outside the handler | 775 ms | 426 ms | −340 ms | |
| Before `prompt.bind` | 220 ms | 56 ms | −165 ms | |
| `agent.session_id` (backend init) | 346 ms | 0 ms | −346 ms | |
| `prompt.accepted` | 1119 ms | 1009 ms | −62 ms | |
| First Queues send | 545 ms | 420 ms | −52 ms | |

All 6 baseline prompts were their process's first request; all 6 candidate prompts landed on an instance the warm-up had already served. Every Sending delta exceeds the measured preview noise (~±250 ms) several times over.

**Still paid on a cold candidate prompt.** The prompt route's own module loads on its first request (~+150–200 ms outside the handler), and the first Vercel Queues send costs ~420 ms against ~50–85 ms warm. These are the next targets.

The report tool refused deltas (`condition_unknown`) because `run` was not told the condition. The script now passes `--condition cold`. The deltas above were computed per pair from the saved runs.

**Result (warm, no redeploys).** `ab` with one warm-up per side, 4 pairs, `--think-ms 3000` (lab `~/.fx0-perf-labs/exp3-warm-group-warm`). No regression: Sending p50 1323 → 1150 ms (paired −309 ms), first text 2741 → 2363 ms (paired −268 ms). With 4 pairs this is descriptive only. More telling: even after a warm-up, 2 of 4 baseline prompts still paid libfx backend initialization (`agent.session_id` 352 and 325 ms; one was its process's first request), because Vercel spreads prompts across several instances. 0 of 4 candidate prompts did. Cold initialization is not limited to fresh deploys; it shows up in normal use.

**Decision.** Ship it. The change gives `/api/warm` the prompt's `maxDuration`, loads the durable backend during the warm-up, and adds the grouping test. It is configuration plus one side-effect-free call, auth is unchanged, and it removes ~1 s from a cold first prompt when the person pauses about 3 s or more before sending. A paste-and-Enter in under a second gets only part of the benefit.

## Phase 0: instance lifetime, follow-ups, page-load guard rails

**Instance lifetime probe** (tracing preview, lab `~/.fx0-perf-labs/idle-probe`; each gap is from the previous prompt):

| Gap | Sending | Process |
| --- | ---: | --- |
| Fresh deploy | 3423 ms | New; started 7.7 min earlier but uninitialized (`register()` ran with the request) |
| 1 min | 973 ms | Same process, warm |
| 2 min | **2434 ms** | **A different process**, started 103 s earlier, uninitialized |
| 5 min | 848 ms | Warm |
| 10 min | not run | Stopped to move faster |

Vercel keeps started-but-uninitialized Node processes, and routes prompts to them even while a warm one exists. Cold initialization depends on routing, not only on idle time.

**Follow-ups.** `perf:lab --follow-up-gap-ms N` sends a setup prompt, keeps the page open for N ms, then measures a second prompt in the same chat. The gap is part of the workload id. Baseline, gap 5 s, 4 samples (lab `~/.fx0-perf-labs/followup-baseline`):

- Warm follow-ups are faster than a new chat: Sending 560–727 ms, admission 303–411 ms. Admission is 4 serial calls instead of 6: reads find data, and there is no run creation or seed checkpoint.
- 1 of 4 landed on another process that had not loaded the prompt route or created the libfx agent: Sending 1551 ms. That was 5 s after the previous turn finished.
- The per-chat typing warm-up is throttled to once a minute per chat, so a follow-up typed soon after the first message does not warm again. Candidate: warm when a turn finishes.

**Page-load guard rails.** Every run now records FCP, LCP, DOMContentLoaded, load and composer ready from the browser's Performance APIs, as bounded numbers. Baseline follow-up runs: FCP 244–1268 ms, composer ready 589–1548 ms.

**Method note.** The dedicated profile lost its session on the tracing host once; the lab refused to send ("not signed in") and nothing was sent. The first `login` on a brand-new branch host has failed twice and succeeded on the immediate retry.

## Experiment 4: warm the instance when the app opens

**Change** (branch `esteban/fx0-perf-warm-open`, commit `248a948`, on top of Experiment 3): `POST /api/warm` without a chat warms only the instance (libfx agent and durable backend) for a signed-in, same-origin caller, and reads or writes no chat. The client fires it in the background once the app is idle after first paint, on New chat, and when the tab returns, at most once a minute. A security test covers no session (401, no warm-up), cross-origin (refused), signed-in (204, no query, no chat touched) and a foreign chat id (refused).

**Result A: instant send** (Experiment 3 vs 4, fresh deploys, `--think-ms 0`, 4 pairs, lab `exp4-open-cold`). The candidate is worse: Sending +252 ms paired, first text +900 ms. In 3 of 4 pairs the candidate prompt was the first request of a brand-new process (uptime ~650 ms, a full Node boot). Deployment logs for pair 1 show the open warm-up 560 ms before the prompt, and the chat warm-up arriving together with the prompt. Hypothesis: a warm-up still running when the prompt arrives makes Vercel start another instance, and the prompt lands on it. The lab's instant send (0.5 s after the page is ready) is also unrealistic for this feature, so the realistic case was measured with `--settle-ms`.

**Result B: 5 s after opening, then an immediate send** (`--settle-ms 5000 --think-ms 0`, 4 pairs, lab `exp4-open-cold-settle5s`). Sending −764 ms paired; first text +873 ms paired. The first-text change is not the warm-up's doing. AI Gateway time to headers ranged from 34 ms to 3305 ms across these runs (one candidate run never logged headers and took 5.4 s after acceptance), all after admission, where the warm-up does nothing. Only 2 of 4 candidate prompts landed on the warmed instance; the other 2 were first requests of brand-new processes.

**Why it lands only sometimes.** In Experiment 3 the chat warm-up finished 3 s before the send, and all 6 prompts landed on the warmed instance. With an immediate send, the chat warm-up and the prompt leave together (both wait for the chat reservation), and in those cases the prompt tends to land on a new instance.

**Decision.** Do not ship Experiment 4 as is. Next candidate (Experiment 5): do not send the per-chat warm-up when a send is already pending for that chat, so it never competes with the prompt. Then re-measure the open warm-up with a settle pause.

**Measurement note.** First text on these previews is dominated by AI Gateway variance (34 ms to 3.3 s to headers), so small samples cannot judge it. Sending, and the stage that a change touches, are the metrics to compare.

## Opening a chat from the history sidebar (user report)

**Report.** A user recording showed: click a history chat → the item says "loading" while the URL and the screen stay on the previous view for ~1 s → the chat appears → the preview fills in over ~2 s more. Feedback: "move immediately to the next url, and render a fallback synchronously, like empty."

**Code.** `switchSession` (`components/chat-app.tsx`) awaits `loadSession` (`GET /api/session`) before `showSession` and `history.pushState`. `switchingTo` also blocks other clicks while it loads. The preview iframe (`/api/artifact-frame`) can only start after the snapshot arrives, because it needs the revision.

**Measurement.** `scripts/perf-switch.mjs` loads the app fresh, hovers a history item for 300 ms (the app prefetches on hover), clicks with real input events, and records numbers only: click → URL, chat painted, preview presented, plus Resource Timing for `/api/session` and `/api/artifact-frame`. It used 6 seeded test chats with a minimal design (workload `design-tiny`), never personal chats. Baseline, 6 samples (lab `~/.fx0-perf-labs/switch-baseline`):

| From the click | Sample 0 (cold) | Samples 1–5 |
| --- | ---: | ---: |
| `/api/session` starts | −304 ms (hover prefetch) | −302 ms |
| `/api/session` ends = URL changes | 796 ms | 151–223 ms |
| Chat painted | 833 ms | 184–245 ms |
| Preview presented | 1295 ms | 547–779 ms |

**Where the time goes.**

- `/api/session` waits 452–525 ms for its first byte (1088 ms cold); its handler takes 15–64 ms (236 ms on a first request after 14 idle minutes). Every function request pays a ~200–300 ms floor from here: the edge `gru1` forwards to the function in `iad1` (`/api/teams` costs the same). `/api/session` has `maxDuration = 300`, so it is its own function and is often cold.
- The preview is requested only after the snapshot (serial), then downloads in 100–410 ms. It is one 122 KB script (raw; ~35 KB on the wire), 97 KB of which is the fast-snap capture runtime inlined into every frame.

**Candidates, in order of expected effect.**

1. Navigate immediately: `pushState` and an empty chat shell in the click's frame; fill in when data arrives; drop the `switchingTo` block (a later click wins). URL and shell at ~0 ms instead of 150–800 ms.
2. Start the preview in parallel with `/api/session`: carry the latest design revision in the history list, so the iframe starts at click (or on hover) instead of after the snapshot. Expected ~200–400 ms earlier.
3. Put `/api/session` GET in a warm function group (same `maxDuration` grouping lesson as Experiment 3). Removes the ~0.6–0.9 s cold case.
4. Serve the capture runtime as a cached, same-origin static script instead of inlining 97 KB per frame. Security-sensitive (frame CSP and sandbox), so last.

## Experiment 6: open a history chat at once (A) and move /api/session (C)

**Change** (branch `esteban/fx0-perf-instant-switch`, commit `b977b06`):

- A: `switchSession` pushes the URL and shows the existing `html.chat-url` empty chat (skeletons) in the click itself, and highlights the clicked item at once. A later click wins; a stale response is dropped. A failed load returns to a new chat with the usual notice. Typing while a chat opens warms that chat instead of reserving a draft.
- C: `/api/session` uses `maxDuration = 800` (the prompt's function).
- A UI test covers the four behaviors. It fails on the current code at "the URL names the chat in the click itself", and fails when the typing guard is removed (checked by mutation).

**Measurement fix.** The first run compared different moments: "chat painted" on the candidate was the empty chat, and the preview was read before it existed. The script now records the clicked item becoming current (the empty chat or the content) and, separately, current and no longer loading (`aria-busy` gone, i.e. the content). It waits for the preview after the content.

**Result** (12 samples per side, interleaved in 2 rounds of 6, lab `~/.fx0-perf-labs/switch-ab`), medians from the click:

| Metric | Baseline | Candidate |
| --- | ---: | ---: |
| URL changes | 78 ms (max 362; 3035 in a cold case earlier) | **0.3 ms** (all < 1 ms) |
| Chat shown (empty or content) | 102 ms | **13 ms** (max 35) |
| Chat content | 102 ms | 170 ms |
| Preview presented | 620 ms | 709 ms |
| `/api/session` ends | 78 ms | 142 ms |

**Decision.** A does what the report asked: the URL and the chat move in the click itself, every time. Ship A.

C made content and preview later in this test. `/api/session` was slower on the candidate, with two cold cases (1.4 s and 2.5 s): in the prompt's function it landed on instances no prompt had used on that fresh deploy, while the baseline's own function was already warm. Drop C from the change. A better candidate to test separately: the 30 s group (`teams`, `credits`), which every page load calls and therefore keeps warm when a person opens the history. This needs a check that the route's `DELETE` fits in 30 s.

## Experiment 7: start the preview with the chat (B); C dropped

**Change** (branch `esteban/fx0-perf-instant-switch`, commit `407623b`, on top of A):

- History summaries carry `artifactRevision` when it is above 0, read in the same `HMGET` (no extra Redis request); the transcript summary carries it too, so the list keeps it after a visit.
- While an uncached chat opens, the preview's source is that chat at the listed revision. The snapshot then names the same source, so the frame keeps loading instead of starting over. If the chat published since the list loaded, the preview moves to the newer revision when the snapshot arrives.
- `/api/session` returns to `maxDuration = 300`. Moving it into the prompt's function made it colder (Experiment 6), and the 30 s group is unsafe: its `DELETE` renews a cleanup lease every 30 s and deletes design assets, so it is built to run longer than 30 s.
- Tests: summaries include the revision only when it is above 0 (fails on the base code). The UI test asserts the early preview source, and fails when it is never set (checked by mutation).

**Result** (12 samples per side, interleaved, lab `~/.fx0-perf-labs/switch-ab2`):

| From the click | Baseline | A + B |
| --- | ---: | ---: |
| URL changes (median) | 95 ms | **0.4 ms** |
| Chat shown (median) | 138 ms | **13 ms** |
| Chat content (median) | 138 ms | 156 ms |
| Preview (median) | 618 ms | **558 ms** |
| Preview (worst) | 1501 ms | **690 ms** |

The preview no longer waits for `/api/session`. In one candidate sample `/api/session` took 723 ms (cold), and the preview showed at 453 ms, before the transcript. Whenever the baseline's `/api/session` was slow (890 and 957 ms), its preview took 1.5 s. Content time is unchanged within noise; neither change touches it.

**D (capture runtime out of every frame) is not part of this change.** It would cut ~95 KB raw (~29 KB brotli) from each preview, but loading it as a shared script means widening the design document's CSP to allow a same-origin script. That needs its own security design, not a performance tweak.

## Candidate ideas

| Idea | Expected effect | Security assessment | Status |
| --- | --- | --- | --- |
| Early headers (comment frame) | Sending −170 ms | Safe: after all checks | Done (Exp. 1) |
| Parallel credential save + session prep | Sending −100…330 ms | Safe: funding still precedes admission | Done (Exp. 1), re-test on preview |
| Cache funding in memory for `model.prepare` | First text −100+ ms | **Rejected:** sign-out must stop the next model step through the authoritative funding read; a cache could keep billing a revoked login | Rejected |
| Skip ownership query for repeat prompts | Sending −150 ms | Already done safely in-process when the runtime is bound to the same user; widening it (e.g. to a cookie hint) would trust client state | Keep as is |
| Decompose auth → journal gap | Explained | Measurement only | Done |
| Atomic credential store: revocation check + writes in one Lua script | −1 round trip on admission | **Stronger than today:** removes the window between the revocation check and the write | Proposed |
| Funding read for each model step in one round trip (credential + revocation) | −1 round trip per model step, on the first-text path | Same authoritative read and revocation check, from one consistent snapshot | Proposed |
| Return session state from the journal script (journal + hydrate) | −1 round trip on admission | Same owner-checked chat and data; no new trust | Proposed |
| Run revocation and ownership reads together, act only after both pass | −1 round trip on every chat route | Reads only; nothing is written or returned before both checks pass | Proposed |
| Measure on a Vercel preview with `FX0_TRACE_PREVIEW=1` | Real production anatomy | Tracing stays off in production by code | Done |
| Decompose libfx admission (549 ms) with network spans | Found 6 serial calls | Measurement only | Done |
| libfx: skip the pre-reads for a session created in the same request | Sending −100…170 ms on a chat's first message | **Rejected:** two requests can race on a new chat's binding, so "created here" does not prove the log is empty | Rejected |
| libfx: overlap the viewer-start read with `send()` (Experiment 2) | −44 ms to first write | Same invariants, proven on the real SDK | Works; below end-to-end noise. Small libfx PR candidate |
| Cold starts: 3 of 20 prompts at 2–3 s Sending | Up to −1.5…2 s for those prompts | Measure first | Measured: ~+1.5 s per cold first prompt |
| Warm the prompt's own function while typing (Experiment 3) | Sending −983 ms cold (6/6 pairs) | Auth unchanged; no writes | **Ship** |
| Load the prompt route module during the warm-up | ~−150…200 ms on a cold prompt | Import only | Next |
| First Vercel Queues send on an instance (~420 ms vs ~60 ms) | ~−350 ms on a cold prompt | Must not send a real message | Investigate |
| libfx: combine the serial admission writes | Sending −50…150 ms | Only if the message record stays atomic and precedes the backstop | Investigate (libfx) |
| fx0: drop the explicit `messageId` | Faster admission path | **Rejected:** a retried send could duplicate the message | Rejected |

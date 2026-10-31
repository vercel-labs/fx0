# fx0 together

fx0 together is a multiplayer demo of fx0 at `/ampersand`, built on the Ampersand Agents API. Everyone in a room shares one conversation and one versioned HTML page, and an Ampersand Builder and optional Reviewer turn the room's requests into that page. It reuses fx0's sidebar and thread.

## Run it locally

You'll need Node.js 24, an Ampersand API key from the [developer console](https://ampersand.humansand.ai/) and a Neon Postgres database (`DATABASE_URL`), but not Sign in with Vercel, Redis or an AI Gateway account. The key stays on the server. Normal fx0's `/` page, APIs, auth and journal do not use Ampersand configuration; their existing setup and behavior are unchanged.

**Yes, the demo requires a database migration.** Apply only `migrations/006_ampersand_rooms.sql` to the database selected for this demo. It creates or updates only `ampersand_*` tables and does not alter existing fx0 account, ownership or history tables. For local testing, use a development database/branch, not production. Set the server's `DATABASE_URL` to that same database and `AMPERSAND_API_KEY` to your developer-console key before starting.

```sh
npm ci
# DATABASE_URL must already be exported in this shell; psql does not read .env.local.
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f migrations/006_ampersand_rooms.sql
npm run dev
```

Alternatively, paste that one SQL file into the selected database's SQL editor and run it as one transaction. Do not use `npm run db:migrate` for a demo-only setup on an existing database: that script replays **all** numbered migrations, including older fx0 account/history migrations. The raw `006` SQL has no migration-ledger dependency. Deployments need these same environment variables and this migration applied explicitly to their chosen database; this PR does not migrate or deploy anything.

| Variable | Default |
|---|---|
| `AMPERSAND_API_KEY` | None. Required to send messages |
| `AMPERSAND_BASE_URL` | `https://ampersand.humansand.ai/v1` |
| `AMPERSAND_MODEL` | `ampersand-v0.1` |
| `DATABASE_URL` | None. fx0's Neon database; `migrations/006_ampersand_rooms.sql` adds the room tables |
| `FX0_COLLAB_ORIGIN` | The request's own origin. Set it to the exact browser origin behind a reverse proxy that rewrites the host; an HTTPS origin makes the identity cookie Secure |

Open `http://localhost:3000/ampersand`, choose a name and create a room. Without a key you can still create rooms and invite people, but sending is disabled. To see two people at work, use **invite** in the chat header to copy a link into a second browser profile, since one profile is one identity. Ask for a page from the first, then send a change from the second while the agents work. Both requests remain open while the agents catch up, **agent activity** above the message box shows the Builder working, and both people can reopen each published version or read its source. Turn on **review** in the chat header to have the Reviewer check changes and coordinate with the Builder.

## How it works

People's messages join a durable queue. After a 250 ms quiet period, each batch hands every still-pending message to the active agents, oldest first. New input supersedes an active batch: the active sessions are stopped before the next batch starts with all unprocessed requests, the cumulative transcript and the current page. Published revisions and replies already delivered remain in the history. Each saved effect checks its runner token, lease expiry and input watermark under the same room lock as the write. A superseded or expired run cannot publish, reply or mark requests complete. Teammate API messages check current ownership and input before dispatch; the external API call is not part of the database transaction. Different rooms can run at the same time.

Rooms live in Postgres, so any function invocation can serve any request. Short Neon HTTP transactions acquire locks in a separate statement before the dependent reads, at READ COMMITTED isolation. A shared coordination row serializes quota and running-room-cap decisions; room locks serialize admission with each agent write. No lock is held across an Ampersand API call. A message's own request runs its room's queue after responding, with Next's `after()`. One invocation at a time holds a room's lease and renews it while it runs; a message stored by another invocation finds the lease taken and stays pending, and the runner sees it at its next input-watermark check, supersedes its batch and runs the next one with it. When a runner releases the lease it checks for input that arrived meanwhile and takes it on. If an invocation ends mid-run, its lease lapses within a minute, and the next member poll that finds work waiting 15 seconds with no live lease starts it again.

Each agent keeps one persistent session per room, made with the `openai` client's `client.beta.agents.sessions` API. A room's first batch creates it from a setup message and the whole saved transcript. Later batches post only the new messages to it as one input event, and the Reviewer also gets the Builder's room replies it hasn't seen. Each person who joined since the session's last message comes in as a notice ("Robert joined the room."), in time order among the new messages, under a stable ID so a repeat is ignored. Every input message carries metadata: an `id`, `source: 'fx0-collab'`, a `sender` and `sender_name` for the member, agent or app that wrote it, a `channel` (`setup`, `room`, `team` or `notice`) and a Unix `timestamp`.

A stored session is replaced from the transcript, and the old one deleted, when it's missing, failed, busy, made with other settings (say, a new `AMPERSAND_MODEL`), or already holds part of the batch. That last case covers every interrupted batch, whether a turn failed, a session hit a limit, a response was lost or the server restarted. Ampersand ignores a repeated message `id`, so resending to the old session couldn't restart it. The replacement holds the room's messages but not the old session's tool calls.

The agents act only through function tools, with no shell, files or network. Tool operations across both seats are serialized; a published revision becomes readable only after its database write succeeds. Both can call `read_design`, which returns the HTML, its revision number and `pending_requests` with every open message's ID, author and text. `publish_design` must name the revision it started from; a stale one is rejected, so the agent reads again and merges. `send_message` reaches the teammate's session and shows under agent activity, not in the room. Only the Reviewer can call `finish_review`, for the current revision after reading it in this batch. Only the Builder can call `room_reply`; when review is on and a page exists, a reply is accepted only after this batch's review of the current revision. Both can call `pass` to end a turn without acting, the chat primitive from the Agents API guide. The app tells the other agent when a revision is published and tells the Builder when one is approved. Text an agent writes outside a tool call stays private.

People in a room also talk to each other, so the instructions treat a message addressed to someone else, or a proposal waiting on another person's agreement, as their conversation rather than a request. Nobody owns the page, and when people disagree the agents ask them instead of taking a side.

The review, and the Builder's reply or pass, must include `addressed_message_ids` covering every open request exactly once. A later person's message never silently replaces an earlier request: the agents incorporate it, answer it, ask the people involved to settle a conflict, or leave a conversation between people to them. The ID check prevents accidental partial settlement; it is not a proof that a model's claims are correct. A batch that leaves the page alone succeeds once the Builder replies or passes. A batch that publishes succeeds once the Builder has told the room about it and, when review is on, the Reviewer has approved the latest revision; the Builder's pass is refused after a publish.

Review is off in a new room; existing rooms keep their saved preference. Any member can switch it with **review** in the chat header, and the switch applies from the room's next batch. With review off only the Builder runs, with no teammate and no `send_message`: it replies after its own change without an approval, under the same coverage rule. The Builder's session settings differ between the two modes, so each switch starts it over from the transcript. The Reviewer keeps its session, and when review comes back on it is sent every message since its last batch.

## Limits and failures

- A batch has a five-minute deadline, which also stops a runaway exchange between the agents.
- Accepted messages stay pending until a batch succeeds. The processed watermark and successful idle status commit together. Catching up after new input uses no extra daily admission unit. A failed batch records its input watermark, shows its error and a retry button, and keeps revisions and replies already made. A delayed callback cannot rerun the same failed inputs. A newer message can restart an ordinary failure, or an explicit retry atomically reserves quota and admits one retry. A retry of a room that hasn't failed, and a resend of an already stored message, start nothing and spend no quota.
- A deploy or an invocation that ends mid-run keeps the queue, and a member's poll resumes it once the lease lapses.
- A dropped event stream is reopened, but one that closes more than three times in a row without an event fails the batch. Session creation retries an HTTP 429 up to five times, and reads and event posts use the client's five automatic retries. All rooms share your account's [rate limits](https://ampersand.humansand.ai/docs/PRICING.html).
- Each room that has run keeps a Builder session on your Ampersand account, plus a Reviewer session once review has been enabled. The app deletes one only to replace it or when the room expires (see [Hosting it publicly](#hosting-it-publicly)), and deleting the database leaves them there. Cancellation and deletion use bounded attempts. Uncertain agent cleanup retains known session IDs and persists a cleanup barrier, including after a renewal transport failure. New messages may be saved, but neither they nor polls clear that barrier; only an explicit admitted retry does. If a creation response never confirms an ID, inspect the account's sessions before explicitly retrying; a later retry is not a guarantee that unknown work was stopped. Use `GET /v1/agents/sessions` with the account's key.
- An open room polls every 800 ms while its tab is visible. A poll gets the room only when it has changed, and then without any revision's HTML: the preview loads each revision on its own, and the Source view reads one revision when it opens. Browsers receive only the room's latest 32 agent activity entries. Interactive state inside the preview stays in each browser.

## Hosting it publicly

Anyone who can reach the server spends your Ampersand credit, so a public host should set these limits. Each one is off unless set. An invalid value makes every room request, including `GET /api/ampersand`, fail with an error in the server log, so a health check on that path catches it.

| Variable | Effect |
|---|---|
| `FX0_COLLAB_PAUSED=1` | Refuses new messages and retries, and leaves accepted ones queued. Rooms stay readable |
| `FX0_COLLAB_DAILY_MESSAGES` | Messages and retries per UTC day across all rooms, counted in the database. Resuming accepted work counts nothing more |
| `FX0_COLLAB_HOURLY_MESSAGES` | Messages and retries per hour for each browser |
| `FX0_COLLAB_TRUSTED_PROXIES` | How many `X-Forwarded-For` entries your proxies append after the client's, for example `1` behind a Google Cloud load balancer. Needed by the per-address limits. A request whose header is too short to hold the client's address is refused and logged |
| `FX0_COLLAB_HOURLY_ADDRESS_MESSAGES` | Messages and retries per hour for each client address, which everyone on one office or venue network shares |
| `FX0_COLLAB_HOURLY_ROOMS` | Rooms created or joined per hour for each client address |
| `FX0_COLLAB_MAX_MEMBERS` | Members per room |
| `FX0_COLLAB_MAX_RUNNING_ROOMS` | Rooms whose agents run at once, counted by live leases. A room past the cap keeps its messages pending and starts from a member's poll once a slot frees, which keeps a burst within your account's [rate limits](https://ampersand.humansand.ai/docs/PRICING.html) |
| `FX0_COLLAB_ROOM_TTL_DAYS` | Rooms with no join, message or agent activity for this many days are deleted, with their Ampersand sessions; opening a room doesn't count. An hourly sweep, started by reads of `GET /api/ampersand` such as health checks, deletes up to 50 rooms at a time and logs a summary. A room whose session delete fails keeps its session IDs and waits a day, so rooms that keep failing can't block the rest |

Hourly and daily quota reservations commit atomically with the admitted action. Deduplication is checked under the same lock before reserving quota, so refused actions and simultaneous resends spend nothing extra. Counts live in the database, so every invocation shares them. Rejoining an existing membership does not spend room quota. Every tool result counts as a work request, so a public host needs an account tier whose work-request limit fits `FX0_COLLAB_MAX_RUNNING_ROOMS` busy rooms.

The expiry sweep claims exclusive cleanup ownership before deleting external sessions. Admissions are temporarily refused while it owns the room. If deletion fails, ownership remains as a durable barrier; another sweep can take over after its cleanup lease expires, but messages cannot reopen a partly retired room.

## Safety

Room reads, invites, messages, retries and saved designs all need room membership, and a non-member gets the same 404 as a missing room. Requests that change rooms must come from the deployment's own origin, or `FX0_COLLAB_ORIGIN` when set. Browser credentials and invites are stored only as hashes. The credential travels only in an HttpOnly, SameSite=Strict cookie that lasts seven days, and an invite rides in the URL fragment, which browsers don't send to the server. Anyone with an invite link can join, read the room, send messages and invite others, and names aren't verified, so treat invite links and the cookie as credentials.

Published pages pass fx0's artifact validation: one HTML file of at most 512 KiB with no external assets, and images as data URLs. The preview runs each one in an opaque, script-enabled sandbox under fx0's network-blocking Content Security Policy, so it gets no credentials, network calls, forms, popups or nested frames. Builder replies render as markdown with images turned into links, so a reply can't make anyone's browser fetch an image. HTTPS links inside a published page request an explicit confirmation through fx0's link dialog; only messages from the current preview iframe are accepted, and they never open a URL automatically.

The room never shows provider error bodies. A failed request names only its HTTP status, or `no response`, and its step, as in `Ampersand API request failed (HTTP 429) [events]`, and a failed turn names only its agent, status and error code. The key and token-shaped strings are redacted from stored errors. `AMPERSAND_BASE_URL` must use HTTPS, except on loopback, with no credentials or query, and redirects are refused so the key stays on that origin.

## Where things are

| Path | What's there |
|---|---|
| [`lib/collab/`](../lib/collab) | The Postgres store, the leased per-room queue worker, one batch on the two sessions, the model tools and review gate, the prompts and the Ampersand client |
| [`app/api/ampersand/`](../app/api/ampersand), [`app/ampersand/`](../app/ampersand), [`components/collab-*`](../components) | The room API, the sandboxed route for saved revisions and the `/ampersand` page around fx0's sidebar and thread |
| [`migrations/006_ampersand_rooms.sql`](../migrations/006_ampersand_rooms.sql) | The room tables |
| [`tests/`](../tests) | `collab-*.test.mjs`, `fixtures/agents-api.mjs`, an in-process fake of the Agents API, and `fixtures/rooms-db.mjs`, the migration on in-process Postgres (PGlite) |

## Test

```sh
npm run test:collab   # in-process Postgres and the fake Agents API; no API key or database needed
npm run test:core
npm run test:auth     # includes shared sidebar/brand default and opt-in regression tests
npm run typecheck
npm run build
npm run test:normal:isolation # production guest page/APIs with no auth, Ampersand, Redis or DB config
npm run test:smoke    # production auth flow with synthetic credentials and mocked external services
```

The collab suites drive the real `openai` client against the fake, whose scripted agents act only through tool calls. They aren't evidence of model quality, so also try a real model with two people whose requests overlap.

For real multi-connection locking proof, start a disposable local Postgres cluster with a Unix socket and `psql` on PATH, then run:

```sh
FX0_COLLAB_TEST_SOCKET=/tmp/your-disposable-cluster/socket FX0_COLLAB_TEST_PORT=55432 npm run test:collab:postgres
```

This opt-in suite captures production SQL batches, forces lock waits between independent connections at READ COMMITTED, and checks quota, deduplication, membership/run caps and write fences. It uses isolated temporary schemas, never loads `.env` or `DATABASE_URL`, and skips without the explicit socket setting. It does not exercise Neon HTTP transport.

## Changes to fx0

| File | Change |
|---|---|
| [`README.md`](../README.md) | An intro paragraph for fx0 together and an `npm run test:collab` line in Test |
| [`.env.example`](../.env.example) | Optional server-only Ampersand settings and a pointer to the `006`-only migration instructions |
| [`package.json`](../package.json) | The collab, local Postgres and normal-isolation test scripts, the `openai` dependency and the `@electric-sql/pglite` dev dependency |
| [`package-lock.json`](../package-lock.json) | Those packages |
| [`components/brand.tsx`](../components/brand.tsx) | An optional `href`, `/` by default, so the collab sidebar's logo links to `/ampersand` |
| [`components/sidebar.tsx`](../components/sidebar.tsx) | Optional `homeHref`, `help` and `onDelete` props, and rows typed to just the fields they show, so it can list rooms without fx0's help or delete buttons |
| [`tests/guest-ui.test.mjs`](../tests/guest-ui.test.mjs) | Regression proof for shared defaults and explicit demo overrides |

The two shared component changes avoid copying the entire sidebar and its brand markup into the demo. Normal callers pass no `href`/`homeHref` or `help` override: the home link remains `/`, `HowItWorks` and `AccountMenu` remain present, and the existing `onDelete` callback retains its spacing and two-click confirmation. Narrowing the row type to displayed fields changes no runtime data. No existing page, API, auth, journal, migration or migration-runner implementation is modified.

## License

fx0 together builds on [vercel-labs/fx0](https://github.com/vercel-labs/fx0) under its [Apache-2.0 license](../LICENSE). The files listed in [Changes to fx0](#changes-to-fx0) are modified from upstream fx0, and the files fx0 together adds are released under the same license.

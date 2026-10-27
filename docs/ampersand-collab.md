# fx0 together

fx0 together is a multiplayer demo of fx0 at `/collab`, built on the Ampersand Agents API. Everyone in a room shares one conversation and one versioned HTML page, and an Ampersand Builder and optional Reviewer turn the room's requests into that page. It reuses fx0's sidebar and thread.

## Run it locally

You'll need Node.js 24 and an Ampersand API key from the [developer console](https://ampersand.humansand.ai/), but not Sign in with Vercel, Neon, Redis or an AI Gateway account. Install the pinned dependencies, then start the server with `AMPERSAND_API_KEY` in its environment. The key stays on the server.

```sh
npm ci
npm run dev:collab
```

| Variable | Default |
|---|---|
| `AMPERSAND_API_KEY` | None. Required to send messages |
| `AMPERSAND_BASE_URL` | `https://ampersand.humansand.ai/v1` |
| `AMPERSAND_MODEL` | `ampersand-v0.1` |
| `FX0_COLLAB_ORIGIN` | `http://127.0.0.1:3025`. Set it to the exact browser origin for another port or a reverse proxy; an HTTPS origin makes the identity cookie Secure |
| `FX0_COLLAB_DATABASE` | `.collab-data/rooms.sqlite`, which is gitignored. It holds every room, so keep it on durable private storage |

Open `http://127.0.0.1:3025/collab`, choose a name and create a room. Without a key you can still create rooms and invite people, but sending is disabled. To see two people at work, use **invite** in the chat header to copy a link into a second browser profile, since one profile is one identity. Ask for a page from the first, then send a change from the second while the agents work. Both requests remain open while the agents catch up, **agent activity** above the message box shows the Builder working, and both people can reopen each published version or read its source. Turn on **review** in the chat header to have the Reviewer check changes and coordinate with the Builder.

## How it works

People's messages join a durable queue. After a 250 ms quiet period, each batch hands every still-pending message to the active agents, oldest first. New input supersedes an active batch: the active sessions are stopped before the next batch starts with all unprocessed requests, the cumulative transcript and the current page. Published revisions and replies already delivered remain in the history. Input-watermark checks prevent a superseded run from publishing, replying, sending teammate messages or marking requests complete, even before the new request's background callback runs. Different rooms can run at the same time.

Each agent keeps one persistent session per room, made with the `openai` client's `client.beta.agents.sessions` API. A room's first batch creates it from a setup message and the whole saved transcript. Later batches post only the new messages to it as one input event, and the Reviewer also gets the Builder's room replies it hasn't seen. Each person who joined since the session's last message comes in as a notice ("Robert joined the room."), in time order among the new messages, under a stable ID so a repeat is ignored. Every input message carries metadata: an `id`, `source: 'fx0-collab'`, a `sender` and `sender_name` for the member, agent or app that wrote it, a `channel` (`setup`, `room`, `team` or `notice`) and a Unix `timestamp`.

A stored session is replaced from the transcript, and the old one deleted, when it's missing, failed, busy, made with other settings (say, a new `AMPERSAND_MODEL`), or already holds part of the batch. That last case covers every interrupted batch, whether a turn failed, a session hit a limit, a response was lost or the server restarted. Ampersand ignores a repeated message `id`, so resending to the old session couldn't restart it. The replacement holds the room's messages but not the old session's tool calls.

The agents act only through function tools, with no shell, files or network. Both can call `read_design`, which returns the HTML, its revision number and `pending_requests` with every open message's ID, author and text. `publish_design` must name the revision it started from; a stale one is rejected, so the agent reads again and merges. `send_message` reaches the teammate's session and shows under agent activity, not in the room. Only the Reviewer can call `finish_review`, for the current revision after reading it in this batch. Only the Builder can call `room_reply`; when review is on and a page exists, a reply is accepted only after this batch's review of the current revision. Both can call `pass` to end a turn without acting, the chat primitive from the Agents API guide. The app tells the other agent when a revision is published and tells the Builder when one is approved. Text an agent writes outside a tool call stays private.

People in a room also talk to each other, so the instructions treat a message addressed to someone else, or a proposal waiting on another person's agreement, as their conversation rather than a request. Nobody owns the page, and when people disagree the agents ask them instead of taking a side.

The review, and the Builder's reply or pass, must include `addressed_message_ids` covering every open request exactly once. A later person's message never silently replaces an earlier request: the agents incorporate it, answer it, ask the people involved to settle a conflict, or leave a conversation between people to them. The ID check prevents accidental partial settlement; it is not a proof that a model's claims are correct. A batch that leaves the page alone succeeds once the Builder replies or passes. A batch that publishes succeeds once the Builder has told the room about it and, when review is on, the Reviewer has approved the latest revision; the Builder's pass is refused after a publish.

Review is off in a new room; existing rooms keep their saved preference. Any member can switch it with **review** in the chat header, and the switch applies from the room's next batch. With review off only the Builder runs, with no teammate and no `send_message`: it replies after its own change without an approval, under the same coverage rule. The Builder's session settings differ between the two modes, so each switch starts it over from the transcript. The Reviewer keeps its session, and when review comes back on it is sent every message since its last batch.

## Limits and failures

- This is a local demo for a single Node server. The queue worker is process-local, so don't run it across serverless instances or several processes.
- A batch has a five-minute deadline, which also stops a runaway exchange between the agents.
- Accepted messages stay pending until a batch succeeds. Catching up after new input uses no extra daily admission unit. A failed batch shows its error and a retry button and keeps the revisions and replies it already made. A new message, or a retry of the failed room, reruns every pending message, and a room that failed waits for one. A retry of a room that hasn't failed, and a resend of a message the room already has (as the page sends after a lost response), start nothing.
- Restarting the server keeps the queue, and the next member to open an interrupted room resumes it once.
- A dropped event stream is reopened, but one that closes more than three times in a row without an event fails the batch. Session creation retries an HTTP 429 up to five times, and reads and event posts use the client's five automatic retries. All rooms share your account's [rate limits](https://ampersand.humansand.ai/docs/PRICING.html).
- Each room that has run keeps a Builder session on your Ampersand account, plus a Reviewer session once review has been enabled. The app deletes one only to replace it or when the room expires (see [Hosting it publicly](#hosting-it-publicly)), and deleting the database leaves them there. Cancellation and deletion use bounded attempts; a failed cleanup retains known session IDs and stops automatic catch-up. If a creation response never confirms an ID, inspect the account's sessions before explicitly retrying; a later retry is not a guarantee that unknown work was stopped. Use `GET /v1/agents/sessions` with the account's key.
- An open room polls every 800 ms while its tab is visible. A poll gets the room only when it has changed, and then without any revision's HTML: the preview loads each revision on its own, and the Source view reads one revision when it opens. Browsers receive only the room's latest 32 agent activity entries. Interactive state inside the preview stays in each browser.

## Hosting it publicly

Anyone who can reach the server spends your Ampersand credit, so a public host should set these limits. Each one is off unless set. An invalid value makes every room request, including `GET /api/collab`, fail with an error in the server log, so a health check on that path catches it.

| Variable | Effect |
|---|---|
| `FX0_COLLAB_PAUSED=1` | Refuses new messages and retries, and leaves accepted ones queued. Rooms stay readable |
| `FX0_COLLAB_DAILY_MESSAGES` | Messages, retries and resumed runs per UTC day across all rooms. Counted in the database, so a restart doesn't reset it. Once it's reached, an interrupted room waits for the next day |
| `FX0_COLLAB_HOURLY_MESSAGES` | Messages and retries per hour for each browser |
| `FX0_COLLAB_TRUSTED_PROXIES` | How many `X-Forwarded-For` entries your proxies append after the client's, for example `1` behind a Google Cloud load balancer. Needed by the per-address limits. A request whose header is too short to hold the client's address is refused and logged |
| `FX0_COLLAB_HOURLY_ADDRESS_MESSAGES` | Messages and retries per hour for each client address, which everyone on one office or venue network shares |
| `FX0_COLLAB_HOURLY_ROOMS` | Rooms created or joined per hour for each client address |
| `FX0_COLLAB_MAX_MEMBERS` | Members per room |
| `FX0_COLLAB_MAX_RUNNING_ROOMS` | Batches whose agents run at once. Later batches show as working and wait in arrival order, a busy room's next batch included, which keeps a burst within your account's [rate limits](https://ampersand.humansand.ai/docs/PRICING.html) |
| `FX0_COLLAB_ROOM_TTL_DAYS` | Rooms with no join, message or agent activity for this many days are deleted, with their Ampersand sessions; opening a room doesn't count. An hourly sweep, started by reads of `GET /api/collab` such as health checks, deletes up to 50 rooms at a time and logs a summary. A room whose session delete fails keeps its session IDs and waits a day, so rooms that keep failing can't block the rest |

Hourly counts are checked before a message, retry or room is accepted and counted after, so a refused request or a resend uses none. They live in memory, so a restart forgets the current hour. Every tool result counts as a work request, so a public host needs an account tier whose work-request limit fits `FX0_COLLAB_MAX_RUNNING_ROOMS` busy rooms. Set `FX0_COLLAB_ORIGIN` to the public HTTPS origin.

## Safety

Room reads, invites, messages, retries and saved designs all need room membership, and a non-member gets the same 404 as a missing room. Requests that change rooms must come from `FX0_COLLAB_ORIGIN`. Browser credentials and invites are stored only as hashes. The credential travels only in an HttpOnly, SameSite=Strict cookie that lasts seven days, and an invite rides in the URL fragment, which browsers don't send to the server. Anyone with an invite link can join, read the room, send messages and invite others, and names aren't verified, so treat invite links and the cookie as credentials.

Published pages pass fx0's artifact validation: one HTML file of at most 512 KiB with no external assets, and images as data URLs. The preview runs each one in an opaque, script-enabled sandbox under fx0's network-blocking Content Security Policy, so it gets no credentials, network calls, forms, popups or nested frames. Builder replies render as markdown with images turned into links, so a reply can't make anyone's browser fetch an image.

The room never shows provider error bodies. A failed request names only its HTTP status, or `no response`, and its step, as in `Ampersand API request failed (HTTP 429) [events]`, and a failed turn names only its agent, status and error code. The key and token-shaped strings are redacted from stored errors. `AMPERSAND_BASE_URL` must use HTTPS, except on loopback, with no credentials or query, and redirects are refused so the key stays on that origin.

## Where things are

| Path | What's there |
|---|---|
| [`lib/collab/`](../lib/collab) | The SQLite store, the per-room queue worker, one batch on the two sessions, the model tools and review gate, the prompts and the Ampersand client |
| [`app/api/collab/`](../app/api/collab), [`app/collab/`](../app/collab), [`components/collab-*`](../components) | The room API, the sandboxed route for saved revisions and the `/collab` page around fx0's sidebar and thread |
| [`tests/`](../tests) | `collab-*.test.mjs` and `fixtures/agents-api.mjs`, an in-process fake of the Agents API |

## Test

```sh
npm run test:collab   # temporary databases and the fake Agents API; no API key needed
npm run typecheck
npm run build
```

The collab suites drive the real `openai` client against the fake, whose scripted agents act only through tool calls. They aren't evidence of model quality, so also try a real model with two people whose requests overlap.

## Changes to fx0

| File | Change |
|---|---|
| [`README.md`](../README.md) | An intro paragraph for fx0 together and an `npm run test:collab` line in Test |
| [`package.json`](../package.json) | The `dev:collab` and `test:collab` scripts and the `openai` dependency |
| [`package-lock.json`](../package-lock.json) | The `openai` package |
| [`.gitignore`](../.gitignore) | `.collab-data/`, the default database directory |
| [`components/brand.tsx`](../components/brand.tsx) | An optional `href`, `/` by default, so the collab sidebar's logo links to `/collab` |
| [`components/sidebar.tsx`](../components/sidebar.tsx) | Optional `homeHref`, `help` and `onDelete` props, and rows typed to just the fields they show, so it can list rooms without fx0's help or delete buttons |

## License

fx0 together builds on [vercel-labs/fx0](https://github.com/vercel-labs/fx0) under its [Apache-2.0 license](../LICENSE). The files listed in [Changes to fx0](#changes-to-fx0) are modified from upstream fx0, and the files fx0 together adds are released under the same license.

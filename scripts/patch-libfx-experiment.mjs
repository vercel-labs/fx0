// EXPERIMENT ONLY: never merge this branch. Measures, on a Vercel preview, a shorter
// libfx 0.0.14 admission before proposing it in vercel-labs/fx (sdk/durable.js).
//
// Today a prompt with a messageId is accepted after, in series: the viewer's start
// (streams.getInfo), the log read, the log write(s), then the queue backstop. This patch:
// 1. Starts the viewer's start alongside send(), and waits for it right before the first
//    write, so it still lands before the message can produce anything (Experiment 2).
// 2. When the request runs the turn itself, queues the backstop before the log is opened,
//    and waits for it after the write. The backstop is delivered only after this request's
//    deadline (plus a margin), so it cannot precede the write; a delivery whose input never
//    reached the log is refused as "unknown message" (SessionWorker.consume). Acceptance
//    still waits for both, so the caller hears "accepted" only once the input is logged and
//    the backstop is queued, as before.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../node_modules/libfx/', import.meta.url))
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
if (version !== '0.0.14') throw new Error(`patch-libfx-experiment targets libfx 0.0.14, found ${version}`)

const file = path.join(root, 'durable.js')
const marker = '// fx0 experiment: shorter admission'
let source = readFileSync(file, 'utf8')
if (source.includes(marker)) {
  console.log('libfx admission experiment already applied')
  process.exit(0)
}

const sendBefore = `      const send = async (message, { inRequest = false } = {}) => {
        const { created, id: sessionId } = await resolved;
        const extra = {
          ...(seeded ? {} : { seed }),
          ...(context === undefined ? {} : { context }),
          ...(settings === undefined ? {} : { settings }),
        };
        const full = { ...message, ...extra, agent: agentName, sessionId };
        // The input and its caller's context reach the log here, on the
        // app's own call, before the caller hears it was accepted. The queue
        // carries only which input to run, so a delivery cannot choose what
        // a turn runs or as whom (\`tests/tla/sdk/TenantIsolation.tla\`
        // OnlySentRuns), and a queue that ends with the process loses no
        // input.
        const log = await created.session(sessionId);
        await recordMessage(log, foldSessionLog(await log.read()), full);
        const queued = queuedMessage(full, created.store);
        const idempotencyKey = \`\${sessionId}:\${message.type}:\${message.messageId}\`;
        if (inRequest && created.runInRequest) {
          await created.refreshDeadline?.();
          const deadline = deliveryDeadline(created);
          if (deadline !== null) {
            // This request runs the turn, and the queue keeps the message as
            // a backstop it delivers only after the request's deadline, by
            // when the request has stopped. The lease names the backstop, so
            // if the request died, the backstop takes the session over and
            // continues the turn.
            const delaySeconds = Math.ceil(Math.max(0, deadline - Date.now()) / 1000) + inlineBackstopMarginSeconds;
            const { messageId: backstop } = await created.queue.send(queued, { idempotencyKey, delaySeconds }) ?? {};
            seeded = true;
            const delivery = backstop ? { messageId: backstop, attempt: 0 } : null;
            // receive() reports a failure to the host; the backstop retries it.
            const work = receive(created, queued, delivery, { inRequest: true }).then(() => {}, () => {});
            created.waitUntil?.(work);
            return;
          }
        }
        await created.queue.send(queued, { idempotencyKey });
        seeded = true;
      };
`

const sendAfter = `      ${marker}
      const send = async (message, { inRequest = false, viewerStart = null } = {}) => {
        const { created, id: sessionId } = await resolved;
        const extra = {
          ...(seeded ? {} : { seed }),
          ...(context === undefined ? {} : { context }),
          ...(settings === undefined ? {} : { settings }),
        };
        const full = { ...message, ...extra, agent: agentName, sessionId };
        const queued = queuedMessage(full, created.store);
        const idempotencyKey = \`\${sessionId}:\${message.type}:\${message.messageId}\`;
        // This request runs the turn: the backstop goes out now, alongside the
        // log write, since the queue delivers it only after the request's
        // deadline, by when the write has landed or failed. A delivery whose
        // input never reached the log is refused ("unknown message").
        let backstopSent = null;
        if (inRequest && created.runInRequest) {
          await created.refreshDeadline?.();
          const deadline = deliveryDeadline(created);
          if (deadline !== null) {
            const delaySeconds = Math.ceil(Math.max(0, deadline - Date.now()) / 1000) + inlineBackstopMarginSeconds;
            backstopSent = created.queue.send(queued, { idempotencyKey, delaySeconds });
            void backstopSent.catch(() => {});
          }
        }
        // The input and its caller's context reach the log here, on the
        // app's own call, before the caller hears it was accepted.
        const log = await created.session(sessionId);
        const known = foldSessionLog(await log.read());
        // The caller's viewer start lands before anything is written.
        if (viewerStart) await viewerStart;
        await recordMessage(log, known, full);
        if (backstopSent) {
          const { messageId: backstop } = await backstopSent ?? {};
          seeded = true;
          const delivery = backstop ? { messageId: backstop, attempt: 0 } : null;
          // receive() reports a failure to the host; the backstop retries it.
          const work = receive(created, queued, delivery, { inRequest: true }).then(() => {}, () => {});
          created.waitUntil?.(work);
          return;
        }
        await created.queue.send(queued, { idempotencyKey });
        seeded = true;
      };
`

const startBefore = `                from = await log.ui.length();
                const [state] = await Promise.all([
                  log.read().then(foldSessionLog),
                  send({ type, messageId, ...(input === undefined ? {} : { input }) }, { inRequest: type === "prompt" }).then(() => accept.resolve({ messageId, sessionId })),
                ]);
`

const startAfter = `                // The viewer's start is still read before the retry answer's log read
                // and before send() writes anything; send() opens and reads alongside it.
                const viewerStart = log.ui.length();
                void viewerStart.catch(() => {});
                const [state] = await Promise.all([
                  viewerStart.then(() => log.read()).then(foldSessionLog),
                  send({ type, messageId, ...(input === undefined ? {} : { input }) }, { inRequest: type === "prompt", viewerStart }).then(() => accept.resolve({ messageId, sessionId })),
                ]);
                from = await viewerStart;
`

for (const [before, after] of [[sendBefore, sendAfter], [startBefore, startAfter]]) {
  const count = source.split(before).length - 1
  if (count !== 1) throw new Error(`patch-libfx-experiment: expected one match, found ${count}`)
  source = source.replace(before, after)
}
writeFileSync(file, source)
console.log('libfx admission experiment applied')

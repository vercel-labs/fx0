// EXPERIMENT ONLY: never merge this branch. Measures, on a Vercel preview, what fx0 would
// pay if libfx stopped running a prompt's turn inside the request that sent it.
//
// libfx 0.0.14's default Vercel durability is vercel(), which turns on queueLeases and so
// runInRequest: /api/prompt runs the turn and Vercel Queues only keeps a delayed backstop.
// vercel({ leaseMs }) turns both off: the prompt is queued without a delay and the turn runs
// when Queues delivers it to /api/libfx (the same Vercel function group as /api/prompt).
// That is the queue-hop model discussed for the safer queue API; the lease is renewed in the
// session log while a turn runs instead of being held by the queue.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../node_modules/libfx/', import.meta.url))
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
if (version !== '0.0.14') throw new Error(`patch-libfx-experiment targets libfx 0.0.14, found ${version}`)

const marker = '/* fx0 experiment: queue hop */'
const before = '    return vercel();\n'
const after = `    return vercel({ leaseMs: 30000 }); ${marker}\n`
for (const name of ['node.js', 'node.cjs']) {
  const file = path.join(root, name)
  let source = readFileSync(file, 'utf8')
  if (source.includes(marker)) {
    console.log(`libfx queue-hop experiment already applied to ${name}`)
    continue
  }
  const count = source.split(before).length - 1
  if (count !== 1) throw new Error(`patch-libfx-experiment: expected one match in ${name}, found ${count}`)
  source = source.replace(before, after)
  writeFileSync(file, source)
  console.log(`libfx queue-hop experiment applied to ${name}`)
}

import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { createRoomStore } from '../../lib/collab/store.ts'

const schema = readFileSync(new URL('../../migrations/006_ampersand_rooms.sql', import.meta.url), 'utf8')

/** An in-process Postgres with the rooms migration applied, so tests run the production SQL. */
export async function createRoomsDatabase() {
  const db = new PGlite()
  // Match the Neon migration runner's statement splitting, including on fresh databases.
  const statements = schema.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n')
    .split(';').map((text) => text.trim()).filter(Boolean)
  await db.transaction(async (tx) => {
    for (const text of statements) await tx.query(text)
  })
  return db
}

/** A store over `db`; closing it leaves the database open, as a restarted process would find it. */
export function storeOn(db) {
  const query = async (text, values = []) => (await db.query(text, values)).rows
  query.transaction = (statements) => db.transaction(async (tx) => {
    const results = []
    for (const { text, values = [] } of statements) results.push((await tx.query(text, values)).rows)
    return results
  })
  return createRoomStore(query)
}

/** Every stored value as text, to check what reaches the database. */
export async function databaseText(db) {
  const tables = (await db.query("SELECT tablename FROM pg_tables WHERE tablename LIKE 'ampersand_%'")).rows.map((row) => row.tablename)
  const dumps = await Promise.all(tables.map(async (table) => JSON.stringify((await db.query(`SELECT * FROM ${table}`)).rows)))
  return dumps.join('\n')
}

/**
 * Offline smoke test for the DSH-delete host half.
 *
 * Runs the real handler against a synthetic DSH_HOME so no live session is
 * touched: request guards, the archived-only gate, the open-turn refusal, and a
 * full deletion of an archived session.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-delete-'))
process.env.DSH_HOME = home

// The plugin also prunes the billion-context index when one exists. Point its
// XDG data home at a sandbox so the real ledger is never touched, and build a
// tiny stand-in index with the same table shape.
const dataHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-delete-bili-'))
process.env.XDG_DATA_HOME = dataHome
const biliDir = path.join(dataHome, 'billion-context', 'sessions')
await fsp.mkdir(biliDir, { recursive: true })
const biliFile = path.join(biliDir, 'index.db')
const { DatabaseSync } = await import('node:sqlite')
const BILI_TABLES = ['sessions', 'conversations', 'messages', 'blocks', 'refs', 'checkpoints', 'message_media', 'ccr_entries', 'session_ext', 'dead_refs']
{
  const db = new DatabaseSync(biliFile)
  for (const table of BILI_TABLES) db.exec(`CREATE TABLE ${table} (session_id TEXT)`)
  db.close()
}

const module = await import('../index.js')

const routes = []
const detached = []
const unarchived = []
const memberIds = []
const emitted = []

/** A workspace whose membership reacts to detachSession like the real one. */
const workspace = {
  id: 'w-test',
  get sessionIds() {
    return memberIds.filter((candidate) => !detached.includes(candidate))
  },
  async detachSession(sessionId) {
    detached.push(sessionId)
  },
}

const ctx = {
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
  workspaceRegistry: {
    list: () => [workspace],
    async unarchiveSession(sessionId) {
      unarchived.push(sessionId)
    },
  },
  effect(register) {
    register()
  },
  emit(event, ...args) {
    emitted.push([event, ...args])
  },
}

const ARCHIVED = 'session-11111111-2222-3333-4444-555555555555'
const LIVE = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const ARCHIVED_RUNNING = 'session-22222222-3333-4444-5555-666666666666'
const ARCHIVED_NO_FILES = 'session-33333333-4444-5555-6666-777777777777'

async function seed(sessionId, projection) {
  const dir = path.join(home, 'sessions', '--D-test--', sessionId)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, 'session.v4.jsonl.zstd'), 'frame')
  const cacheDir = path.join(home, 'storages', 'session_projcache', 'sessions')
  await fsp.mkdir(cacheDir, { recursive: true })
  await fsp.writeFile(path.join(cacheDir, `${sessionId}.json`), JSON.stringify(projection))
}

const closed = { turnBoundary: { val: { openTurnStartSeq: null } }, approvalState: { val: { turnOpen: false } } }
const running = { turnBoundary: { val: { openTurnStartSeq: 4 } }, approvalState: { val: { turnOpen: true } } }

await seed(ARCHIVED, closed)
await seed(LIVE, closed)
await seed(ARCHIVED_RUNNING, running)
memberIds.push(ARCHIVED, LIVE, ARCHIVED_RUNNING, ARCHIVED_NO_FILES)

// Give the stand-in index a ledger row for every seeded session, so the purge
// has something to remove and the plan-ahead paths can be told apart.
function biliRows(sessionId) {
  const db = new DatabaseSync(biliFile)
  try {
    const counts = {}
    for (const table of BILI_TABLES) {
      counts[table] = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE session_id = ?`).get(sessionId).c
      if (counts[table] === 0) db.prepare(`INSERT INTO ${table} (session_id) VALUES (?)`).run(sessionId)
    }
    return counts
  } finally {
    db.close()
  }
}

function biliSessionRows(sessionId) {
  const db = new DatabaseSync(biliFile, { readOnly: true })
  try {
    return db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE session_id = ?').get(sessionId).c
  } finally {
    db.close()
  }
}

for (const id of [ARCHIVED, LIVE, ARCHIVED_RUNNING, ARCHIVED_NO_FILES]) biliRows(id)

await fsp.mkdir(path.join(home, 'storages'), { recursive: true })
await fsp.writeFile(
  path.join(home, 'storages', 'workspace.json'),
  JSON.stringify({
    global: { archivedSessionIds: [ARCHIVED, ARCHIVED_RUNNING, ARCHIVED_NO_FILES], pinnedSessionIds: [] },
    tables: { workspaces: {} },
  }),
)

module.apply(ctx)
assert.equal(routes.length, 2)
assert.equal(routes[0].path, '/dsh-delete/delete')
assert.equal(routes[0].kind, 'exact')
assert.equal(routes[1].path, '/dsh-delete/settings')
assert.equal(routes[1].kind, 'exact')

function call({ method = 'POST', body = '', headers = {}, origin = 'http://127.0.0.1:49827', host = '127.0.0.1:49827' } = {}) {
  const req = {
    method,
    headers: { host, ...(origin === null ? {} : { origin }), ...headers },
    on(event, handler) {
      if (event === 'data' && body !== '') handler(Buffer.from(body))
      if (event === 'end') handler()
      return this
    },
    destroy() {},
  }
  const result = { status: 0, payload: null }
  const res = {
    writeHead(status) { result.status = status },
    end(text) { result.payload = text ? JSON.parse(text) : null },
  }
  return Promise.resolve(routes[0].handler(req, res)).then(() => result)
}

const payload = (sessionId) => JSON.stringify({ sessionId })

function callSettings({ method = 'GET', body = '', headers = {}, origin = 'http://127.0.0.1:49827', host = '127.0.0.1:49827' } = {}) {
  const req = {
    method,
    headers: { host, ...(origin === null ? {} : { origin }), ...headers },
    on(event, handler) {
      if (event === 'data' && body !== '') handler(Buffer.from(body))
      if (event === 'end') handler()
      return this
    },
    destroy() {},
  }
  const result = { status: 0, payload: null }
  const res = {
    writeHead(status) { result.status = status },
    end(text) { result.payload = text ? JSON.parse(text) : null },
  }
  return Promise.resolve(routes[1].handler(req, res)).then(() => result)
}

// The bili index is somebody else's database: untouched unless opted in.
let settings = await callSettings()
assert.equal(settings.status, 200)
assert.deepEqual(settings.payload.settings, { purgeBiliIndex: false })
assert.equal(await callSettings({ method: 'PUT' }).then((r) => r.status), 405)
assert.equal(await callSettings({ method: 'POST', body: 'not json' }).then((r) => r.status), 400)
assert.equal(
  await callSettings({ method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: '{}' }).then((r) => r.status),
  403,
)

let result = await call({ method: 'GET' })
assert.equal(result.status, 405)

result = await call({ headers: { 'sec-fetch-site': 'cross-site' } })
assert.equal(result.status, 403)

result = await call({ origin: 'http://evil.example' })
assert.equal(result.status, 403)

result = await call({ body: 'not json' })
assert.equal(result.status, 400)

result = await call({ body: payload('../../etc') })
assert.equal(result.status, 400)

// A live (not archived) session must be refused even though its files exist.
result = await call({ body: payload(LIVE) })
assert.equal(result.status, 409)
assert.equal(result.payload.code, 'not-archived')
assert.ok(fs.existsSync(path.join(home, 'sessions', '--D-test--', LIVE)))
assert.ok(!detached.includes(LIVE))

// Archived but still running.
result = await call({ body: payload(ARCHIVED_RUNNING) })
assert.equal(result.status, 409)
assert.equal(result.payload.code, 'running')
assert.ok(fs.existsSync(path.join(home, 'sessions', '--D-test--', ARCHIVED_RUNNING)))
assert.ok(!detached.includes(ARCHIVED_RUNNING))

// Archived, listed in the workspace, but already gone from disk: this is what a
// second click looks like, so it must clean up the stale row and succeed.
result = await call({ body: payload(ARCHIVED_NO_FILES) })
assert.equal(result.status, 200)
assert.equal(result.payload.removed, 0)
assert.ok(detached.includes(ARCHIVED_NO_FILES))
assert.ok(unarchived.includes(ARCHIVED_NO_FILES))
assert.deepEqual(emitted, [['api-session/removed', ARCHIVED_NO_FILES]])

// The happy path. Short sweep delays so the follow-up cleanup is observable.
process.env.DSH_DELETE_SWEEP_DELAYS = '20,80'

// With the default settings the bili index must be left completely alone.
result = await call({ body: payload(ARCHIVED) })
assert.equal(result.status, 200)
assert.deepEqual(result.payload.bili, { skipped: true }, 'the index is off limits by default')
assert.equal(biliSessionRows(ARCHIVED), 1, 'a default delete must not touch the bili index')
assert.ok(!fs.existsSync(path.join(home, 'sessions', '--D-test--', ARCHIVED)))
assert.ok(!fs.existsSync(path.join(home, 'storages', 'session_projcache', 'sessions', `${ARCHIVED}.json`)))
assert.ok(detached.includes(ARCHIVED))
assert.ok(unarchived.includes(ARCHIVED))
assert.ok(!workspace.sessionIds.includes(ARCHIVED), 'the row must leave the workspace')
assert.deepEqual(emitted.at(-1), ['api-session/removed', ARCHIVED], 'the browser must be told to drop the row')

// Turning the switch on persists it, and only then is the index edited.
const enabled = await callSettings({ method: 'POST', body: JSON.stringify({ purgeBiliIndex: true }) })
assert.equal(enabled.status, 200)
assert.equal(enabled.payload.settings.purgeBiliIndex, true)
assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'dsh-delete.json'), 'utf8')).purgeBiliIndex, true)
assert.equal((await callSettings()).payload.settings.purgeBiliIndex, true)

// ARCHIVED_NO_FILES was deleted earlier, so its files are gone but its index
// rows are still there: this pass is what purges them.
result = await call({ body: payload(ARCHIVED_NO_FILES) })
assert.equal(result.status, 200)
assert.equal(result.payload.removed, 0)
const bili = result.payload.bili
assert.equal(bili.present, true)
assert.equal(bili.purged, true)
assert.equal(bili.removedRows, BILI_TABLES.length, 'one row per table must be purged')
assert.equal(biliSessionRows(ARCHIVED_NO_FILES), 0, 'the bili index must lose the session')
assert.equal(biliSessionRows(LIVE), 1, 'a refused delete must leave the bili index alone')
assert.ok(
  fs.readdirSync(biliDir).some((name) => name.startsWith('index.db.dsh-delete-')),
  'the bili index must be backed up before editing',
)

// A late projection-cache write must not leave a shell behind: the plugin
// schedules sweeps after the delete, so a recreated entry is removed too.
const cacheFile = path.join(home, 'storages', 'session_projcache', 'sessions', `${ARCHIVED}.json`)
fs.writeFileSync(cacheFile, '{"recreated":true}')
await new Promise((resolve) => setTimeout(resolve, 150))
assert.ok(!fs.existsSync(cacheFile), 'the scheduled sweep must remove a recreated projection cache')

// A retry finds no files and no membership: it still reports success.
result = await call({ body: payload(ARCHIVED) })
assert.equal(result.status, 200)
assert.equal(result.payload.removed, 0)

// Every path that removes a row announced it exactly once, and no refused
// request leaked an announcement.
const announcements = emitted.filter((entry) => entry[0] === 'api-session/removed').map((entry) => entry[1])
assert.deepEqual(announcements, [ARCHIVED_NO_FILES, ARCHIVED, ARCHIVED_NO_FILES, ARCHIVED])

console.log('all host-half checks passed')
await fsp.rm(home, { recursive: true, force: true })



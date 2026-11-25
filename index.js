/**
 * Host half of DSH-delete.
 *
 * DSH exposes no session-delete API (the workspace registry only archives,
 * unarchives and pins sessions), so this half deletes at the storage layer. It
 * stays deliberately narrow:
 *
 *   - only sessions that are ALREADY archived may be deleted;
 *   - never a session with an open turn;
 *   - only the session's own directory plus its projection cache entry.
 *
 * Deleting the files is not enough for the sidebar. Two in-memory accounts keep
 * the row alive: the workspace registry's own session ids, and the Host's
 * session list, which the browser caches until something tells it otherwise.
 * Afterwards we therefore detach the id from its workspace, clear its archived
 * flag (so a restart derives the same state), and emit the forwarded
 * `api-session/removed` notification that makes the browser drop the row at
 * once instead of moving it to the ungrouped bucket.
 *
 * Archiving is the user's explicit step: the client menu entry is hidden until
 * a session is archived, and this route re-checks the archive list on disk so a
 * stale UI cannot delete a live session.
 *
 * Third-parties keep their own copy of the conversation. The billion-context
 * proxy stores per-session ledger rows in its own SQLite index, which knows
 * nothing about DSH's storage, so a deleted session would linger in that
 * project's session list forever. `purgeBiliIndex` removes those rows too
 * (best effort, after a consistent backup). Its long-lived daemon also keeps a
 * live in-memory copy of every session it has seen, and exposes no API to drop
 * one; those entries disappear when that daemon restarts, which is outside our
 * reach from inside DSH.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-delete'
export const inject = ['webServer', 'workspaceRegistry']

const ROUTE_PATH = '/dsh-delete/delete'
const SETTINGS_PATH = '/dsh-delete/settings'
const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_BODY_BYTES = 8 * 1024

/**
 * Editing another program's SQLite index is reasonable only if the user asked for
 * it, so this is off unless somebody turns it on. The toggle lives in Settings →
 * 「删除对话」; the file is ours (`$DSH_HOME/dsh-delete.json`).
 */
export const SETTINGS_DEFAULTS = { purgeBiliIndex: false }

export function normalizeSettings(input) {
  const source = input && typeof input === 'object' ? input : {}
  return {
    purgeBiliIndex: source.purgeBiliIndex === true,
  }
}

function settingsFile(home) {
  return path.join(home, 'dsh-delete.json')
}

/** Tiny JSON store: tolerant on read (a broken file means defaults), atomic-ish on write. */
export function createSettingsStore({ file, readText, writeText }) {
  let cached = null
  return {
    async read() {
      if (cached !== null) return cached
      let parsed = null
      try {
        parsed = JSON.parse(await readText(file, 'utf8'))
      } catch (error) {
        parsed = null
      }
      cached = normalizeSettings(parsed)
      return cached
    },
    async write(patch) {
      const current = await this.read()
      const next = normalizeSettings({ ...current, ...normalizeSettings(patch) })
      await writeText(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      cached = next
      return next
    },
  }
}

function dshHome() {
  const fromEnvironment = process.env.DSH_HOME
  if (typeof fromEnvironment === 'string' && fromEnvironment.trim() !== '') return fromEnvironment
  return path.join(os.homedir(), '.dsh')
}

function workspaceFile(home) {
  return path.join(home, 'storages', 'workspace.json')
}

function sessionCacheFile(home, sessionId) {
  return path.join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
}

/**
 * The projection cache writes behind the session: a checkpoint is flushed when
 * the session is created, throttled during a turn, and once more when the
 * session leaves memory. A delete can therefore be followed by one late write
 * that recreates a shell entry (`identity` + `rows`, no log). It is inert for
 * the sidebar, but it confuses anyone auditing the folder, so sweep it a few
 * times after the delete instead of hoping the first `rm` was last.
 */
const DEFAULT_SWEEP_DELAYS = [2000, 5000, 10000, 20000, 40000, 60000]
const sweeps = new Set()

function sweepDelays() {
  const raw = process.env.DSH_DELETE_SWEEP_DELAYS
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = raw
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value) && value >= 0)
    if (parsed.length > 0) return parsed
  }
  return DEFAULT_SWEEP_DELAYS
}

function scheduleCacheSweep(home, sessionId) {
  const file = sessionCacheFile(home, sessionId)
  for (const delay of sweepDelays()) {
    const timer = setTimeout(() => {
      sweeps.delete(timer)
      // `force` makes a missing file a no-op, so an already clean cache is free.
      void fsp.rm(file, { force: true }).catch(() => {})
    }, delay)
    // Never keep the Host alive on our account.
    if (typeof timer.unref === 'function') timer.unref()
    sweeps.add(timer)
  }
}

function reply(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

/** The page talks to us same-origin; anything else must not reach a destructive route. */
function trustedRequest(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  const host = req.headers.host
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) return false
    } catch (error) {
      return false
    }
  }
  return true
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Archived session ids, read from the workspace storage DSH itself keeps. */
async function archivedSessionIds(home) {
  try {
    const parsed = JSON.parse(await fsp.readFile(workspaceFile(home), 'utf8'))
    const listed = parsed && parsed.global && parsed.global.archivedSessionIds
    return Array.isArray(listed) ? listed.filter((id) => typeof id === 'string') : []
  } catch (error) {
    return []
  }
}

async function sessionDirectories(home, sessionId) {
  const root = path.join(home, 'sessions')
  const found = []
  let groups = []
  try {
    groups = await fsp.readdir(root, { withFileTypes: true })
  } catch (error) {
    return found
  }
  for (const group of groups) {
    if (!group.isDirectory()) continue
    const candidate = path.join(root, group.name, sessionId)
    try {
      const stats = await fsp.stat(candidate)
      if (stats.isDirectory()) found.push(candidate)
    } catch (error) {
      // Not under this group.
    }
  }
  return found
}

async function hasOpenTurn(home, sessionId) {
  let projection
  try {
    projection = JSON.parse(await fsp.readFile(sessionCacheFile(home, sessionId), 'utf8'))
  } catch (error) {
    return false
  }
  const boundary = projection && projection.turnBoundary && projection.turnBoundary.val
  if (boundary && typeof boundary === 'object') {
    const open = boundary.openTurnStartSeq
    if (open !== null && open !== undefined) return true
  }
  const approval = projection && projection.approvalState && projection.approvalState.val
  return Boolean(approval && approval.turnOpen === true)
}

function messageOf(error) {
  return String((error && error.message) || error)
}

/**
 * Take the deleted session out of the live registry so the sidebar drops its
 * row immediately. Best effort: the files are already gone, and a failure here
 * only costs a restart.
 */async function forgetSession(ctx, sessionId) {
  const registry = ctx && ctx.workspaceRegistry
  const result = { detached: false, unarchived: false }
  if (!registry) return result
  try {
    const owners = registry.list().filter((workspace) => workspace.sessionIds.includes(sessionId))
    for (const owner of owners) {
      await owner.detachSession(sessionId)
      result.detached = true
    }
  } catch (error) {
    // The next start derives membership from what is on disk anyway.
  }
  try {
    await registry.unarchiveSession(sessionId)
    result.unarchived = true
  } catch (error) {
    // Same: a stale archived id is harmless once the row is gone.
  }
  return result
}

/**
 * Tell connected pages the session no longer exists. `api-session/removed` is on
 * the Host's forwarded-event allowlist, so this reaches the browser's session
 * list, which drops the row (detaching alone would only move it to "ungrouped").
 */
function announceRemoval(ctx, sessionId) {
  try {
    if (ctx && typeof ctx.emit === 'function') ctx.emit('api-session/removed', sessionId)
    return true
  } catch (error) {
    return false
  }
}

/**
 * Where the billion-context proxy keeps its own index. It follows the XDG
 * convention (`xdg("XDG_DATA_HOME", ".local/share")`), and `BILI_SESSIONS_DIR`
 * can move the whole folder, so mirror both instead of hard-coding a path.
 */
function biliDataDir() {
  const fromEnvironment = process.env.XDG_DATA_HOME
  const base = typeof fromEnvironment === 'string' && fromEnvironment.trim() !== ''
    ? fromEnvironment
    : path.join(os.homedir(), '.local', 'share')
  return path.join(base, 'billion-context')
}

function biliSessionsDir() {
  const fromEnvironment = process.env.BILI_SESSIONS_DIR
  if (typeof fromEnvironment === 'string' && fromEnvironment.trim() !== '') {
    return path.resolve(fromEnvironment)
  }
  return path.join(biliDataDir(), 'sessions')
}

/** Tables that carry a `session_id` column in the proxy's index. */
const BILI_SESSION_TABLES = [
  'messages',
  'refs',
  'blocks',
  'session_ext',
  'ccr_entries',
  'checkpoints',
  'message_media',
  'dead_refs',
  'conversations',
  'sessions',
]

/** Keep the newest few backups; each one is a full copy of the index. */
async function pruneBiliBackups(directory, keep) {
  try {
    const entries = await fsp.readdir(directory)
    const backups = entries
      .filter((name) => name.startsWith('index.db.dsh-delete-'))
      .sort()
      .reverse()
    for (const name of backups.slice(keep)) {
      await fsp.rm(path.join(directory, name), { force: true }).catch(() => {})
    }
  } catch (error) {
    // Rotation is nice-to-have only.
  }
}

/**
 * Remove the session from the billion-context index. The proxy is a separate
 * program with its own SQLite file; nothing in DSH notifies it about a deletion,
 * and it has no delete endpoint, so the only way to stop its session list from
 * showing the conversation is to edit that file. We take a consistent snapshot
 * (`VACUUM INTO`) first: the proxy may be mid-write, and this is somebody
 * else's data.
 */
async function purgeBiliIndex(sessionId) {
  const directory = biliSessionsDir()
  const file = path.join(directory, 'index.db')
  try {
    await fsp.access(file)
  } catch (error) {
    return { present: false, purged: false }
  }

  let DatabaseSync
  try {
    ;({ DatabaseSync } = await import('node:sqlite'))
  } catch (error) {
    return { present: true, purged: false, reason: 'node:sqlite 不可用' }
  }

  let db
  try {
    db = new DatabaseSync(file)
  } catch (error) {
    return { present: true, purged: false, reason: messageOf(error) }
  }

  try {
    let known = 0
    try {
      known = Number(db.prepare('select count(*) as c from sessions where session_id = ?').get(sessionId).c || 0)
    } catch (error) {
      // An index without a sessions table has nothing for us.
      known = 0
    }
    if (known === 0) return { present: true, purged: true, removedRows: 0 }

    if (process.env.DSH_DELETE_BILI_BACKUP !== '0') {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
      const unique = `${stamp}-${Date.now().toString(36)}`
      const backup = path.join(directory, `index.db.dsh-delete-${unique}`)
      db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`)
      await pruneBiliBackups(directory, 3)
    }

    let removedRows = 0
    db.exec('BEGIN')
    try {
      for (const table of BILI_SESSION_TABLES) {
        try {
          const info = db.prepare(`delete from "${table}" where session_id = ?`).run(sessionId)
          removedRows += Number(info.changes || 0)
        } catch (error) {
          // A table may be missing on an older index; keep going.
        }
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return { present: true, purged: true, removedRows }
  } catch (error) {
    return { present: true, purged: false, reason: messageOf(error) }
  } finally {
    try {
      db.close()
    } catch (error) {
      // Already closed.
    }
  }
}

async function deleteSession(ctx, req, res, store) {
  if (req.method !== 'POST') {
    reply(res, 405, { ok: false, code: 'method', message: '只接受 POST 请求' })
    return
  }
  if (!trustedRequest(req)) {
    reply(res, 403, { ok: false, code: 'origin', message: '请求来源不受信任' })
    return
  }

  let payload
  try {
    const text = await readBody(req)
    payload = JSON.parse(text === '' ? '{}' : text)
  } catch (error) {
    reply(res, 400, { ok: false, code: 'body', message: '请求体不是合法 JSON' })
    return
  }

  const rawId = payload && payload.sessionId
  const sessionId = typeof rawId === 'string' ? rawId.trim().toLowerCase() : ''
  if (!SESSION_ID.test(sessionId)) {
    reply(res, 400, { ok: false, code: 'id', message: '会话 ID 不合法' })
    return
  }

  const home = dshHome()
  const settings = store ? await store.read() : SETTINGS_DEFAULTS
  const purgeBili = settings.purgeBiliIndex ? await purgeBiliIndex(sessionId) : { skipped: true }

  const directories = await sessionDirectories(home, sessionId)
  if (directories.length === 0) {
    // Already gone (for example a retry): clear the stale row and report
    // success so the menu entry stops offering a delete that cannot happen.
    const forgotten = await forgetSession(ctx, sessionId)
    const announced = announceRemoval(ctx, sessionId)
    scheduleCacheSweep(home, sessionId)
    reply(res, 200, { ok: true, sessionId, removed: 0, ...forgotten, announced, bili: purgeBili })
    return
  }

  const archivedIds = await archivedSessionIds(home)
  if (!archivedIds.includes(sessionId)) {
    reply(res, 409, { ok: false, code: 'not-archived', message: '只有已归档的对话才能删除，请先归档' })
    return
  }

  if (await hasOpenTurn(home, sessionId)) {
    reply(res, 409, { ok: false, code: 'running', message: '这个对话还有未结束的回合，等它结束后再删' })
    return
  }

  try {
    for (const directory of directories) {
      await fsp.rm(directory, { recursive: true, force: true })
    }
    await fsp.rm(sessionCacheFile(home, sessionId), { force: true })
  } catch (error) {
    reply(res, 500, { ok: false, code: 'io', message: `删除文件失败：${messageOf(error)}` })
    return
  }

  const forgotten = await forgetSession(ctx, sessionId)
  const announced = announceRemoval(ctx, sessionId)
  scheduleCacheSweep(home, sessionId)
  reply(res, 200, {
    ok: true,
    sessionId,
    removed: directories.length,
    ...forgotten,
    announced,
    bili: purgeBili,
  })
}

/** `GET` reports the current settings, `POST` merges a patch into them. */
export function createSettingsHandler(store) {
  return async (req, res) => {
    if (req.method === 'GET') {
      reply(res, 200, { ok: true, settings: await store.read() })
      return
    }
    if (req.method !== 'POST') {
      reply(res, 405, { ok: false, code: 'method', message: '只接受 GET 或 POST 请求' })
      return
    }
    if (!trustedRequest(req)) {
      reply(res, 403, { ok: false, code: 'origin', message: '请求来源不受信任' })
      return
    }
    let payload
    try {
      const text = await readBody(req)
      payload = JSON.parse(text === '' ? '{}' : text)
    } catch (error) {
      reply(res, 400, { ok: false, code: 'body', message: '请求体不是合法 JSON' })
      return
    }
    try {
      const settings = await store.write(payload)
      reply(res, 200, { ok: true, settings })
    } catch (error) {
      reply(res, 500, { ok: false, code: 'io', message: `写入设置失败：${messageOf(error)}` })
    }
  }
}

export function apply(ctx) {
  const store = createSettingsStore({
    file: settingsFile(dshHome()),
    readText: (file, encoding) => fsp.readFile(file, encoding),
    writeText: (file, text, encoding) => fsp.writeFile(file, text, encoding),
  })

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: (req, res) => deleteSession(ctx, req, res, store),
    }),
    'dsh-delete: delete route',
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: SETTINGS_PATH,
      handler: createSettingsHandler(store),
    }),
    'dsh-delete: settings route',
  )
  ctx.effect(
    () => () => {
      for (const timer of sweeps) clearTimeout(timer)
      sweeps.clear()
    },
    'dsh-delete: pending cache sweeps',
  )
}

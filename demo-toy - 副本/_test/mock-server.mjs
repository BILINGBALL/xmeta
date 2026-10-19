/**
 * 本地假 xmeta 服务，只用于把 demo 页面完整跑一遍。
 *
 * 它实现了 demo 用到的那部分接口：身份换票、profiles、/api/kv 的
 * 单条读写 / list / inc / 日志 / openEdit。数据全在内存里。
 */
import http from 'node:http'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// _test 可能在 demo 目录里面，也可能被挪到外面（方便打包上传）。
function findDemoRoot() {
  const candidates = [
    path.resolve(__dirname, '..', '新建文件夹'),
    path.resolve(__dirname, '..'),
  ]
  return candidates.find((p) => existsSync(path.join(p, 'index.html'))) || candidates[1]
}
const ROOT = findDemoRoot()

export const CLIENT_ID = 'xmeta_OXSY7nxlpKooXGd0oS95Cg'
export const TOY_ID = '41072244021248'
export const MY_UID = '2001'

const MARKER = 'xmeta-lobby-v2'
const BOSS_MAX = 100000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 测试用：故意慢慢回，复现「攻击先回来、心跳/轮询晚回来」的竞态 */
const delays = { getRow: 0, heartbeat: 0 }
/** 开延迟时给大厅拍一张快照；延迟响应一律回这张旧快照，确保竞态可复现 */
let frozenLobby = null

const nowIso = () => new Date().toISOString()
const ago = (ms) => new Date(Date.now() - ms).toISOString()

let nextLogId = 1
const users = new Map([
  ['1001', { uid: '1001', nickname: '房主', avatar: null }],
  ['1002', { uid: '1002', nickname: '小明', avatar: TINY_PNG() }],
  [MY_UID, { uid: MY_UID, nickname: '测试玩家', avatar: null }],
])

function TINY_PNG() {
  // 1x1 透明 PNG，用来验证头像加载路径
  return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
}

const rows = new Map()
const logs = new Map()
const requests = []
const usedCodes = new Set()
const tokenLog = []
/** 和线上一样：list 有缓存，写单条不会让它失效。用来确认页面不依赖「列表立刻是新的」。 */
const listCache = new Map()
const LIST_CACHE_MS = 30_000

const keyOf = (scope, uid) => scope + ':' + String(uid)

function row(uid, scope, fields) {
  return {
    uid: String(uid),
    scope,
    isPublic: false,
    openEdit: [],
    tagTinyint: 0,
    tagInt1: 0,
    tagInt2: 0,
    tagBigint: '0',
    text1: null,
    text2: null,
    textLong: null,
    extra: null,
    expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    createdAt: ago(600_000),
    updatedAt: nowIso(),
    ...fields,
  }
}

function putRow(r) {
  rows.set(keyOf(r.scope, r.uid), r)
  return r
}

function addLog(scope, uid, actorUid, action, changed, before, after, at) {
  const entry = {
    id: String(nextLogId++),
    dataId: keyOf(scope, uid),
    actorUid: actorUid === null ? null : String(actorUid),
    action,
    changed: changed.slice(),
    before: before ? JSON.parse(JSON.stringify(before)) : null,
    after: after ? JSON.parse(JSON.stringify(after)) : null,
    createdAt: at || nowIso(),
  }
  const k = keyOf(scope, uid)
  if (!logs.has(k)) logs.set(k, [])
  logs.get(k).push(entry)
  return entry
}

function seed() {
  const createdAgo = 3 * 60 * 60_000
  // 一间已经开了三小时的大厅。两个人刚留过心跳，所以进页面就能看到他们在线。
  const lobby = putRow(row('1001', 'lobby', {
    isPublic: true,
    openEdit: ['text1', 'tagInt1', 'tagInt2'],
    tagTinyint: 1,
    tagInt1: 777,
    tagInt2: BOSS_MAX - 1234,
    text1: '消息 119',
    text2: MARKER,
    textLong: '公共大厅：在线看心跳，聊天从日志按 text1 翻，伤害榜在 damage scope。',
    extra: { demo: MARKER, bossMax: BOSS_MAX },
    createdAt: ago(createdAgo),
  }))

  addLog('lobby', '1001', '1001', 'create', [
    'isPublic', 'openEdit', 'tagInt1', 'tagInt2', 'text1', 'text2', 'textLong', 'extra'
  ], null, {
    isPublic: true,
    openEdit: ['text1', 'tagInt1', 'tagInt2'],
    tagInt1: 1, tagInt2: BOSS_MAX, text1: '', text2: MARKER,
    textLong: lobby.textLong, extra: lobby.extra,
  }, ago(createdAgo))

  let prev = ''
  addLog('lobby', '1001', '1001', 'update', ['text1'],
    { text1: prev }, { text1: '大家好，欢迎来玩' }, ago(createdAgo - 60_000))
  prev = '大家好，欢迎来玩'
  addLog('lobby', '1001', '1002', 'update', ['text1'],
    { text1: prev }, { text1: '我是小明，来打 Boss' }, ago(createdAgo - 120_000))
  prev = '我是小明，来打 Boss'

  // 120 条聊天，中间夹着心跳 —— 用来验证聊天按 changed=text1 翻页，
  // 不会被同一条数据上的心跳挤掉。
  const startAgo = createdAgo - 180_000
  const endAgo = 60_000
  const step = (startAgo - endAgo) / 120
  for (let i = 0; i < 120; i++) {
    const at = ago(startAgo - i * step)
    const actor = i % 2 === 0 ? '1001' : '1002'
    const next = '消息 ' + i
    addLog('lobby', '1001', actor, 'update', ['text1'],
      { text1: prev }, { text1: next }, at)
    prev = next
    if (i % 7 === 0) {
      addLog('lobby', '1001', actor, 'update', ['tagInt1'],
        { tagInt1: 100 + i }, { tagInt1: 200 + i }, at)
    }
  }

  // 伤害榜：一人一条公开数据，不是从日志里算的
  putRow(row('1001', 'damage', {
    isPublic: true, openEdit: [], tagInt2: 700, text1: '累计伤害',
    createdAt: ago(8 * 60_000), updatedAt: ago(8 * 60_000),
  }))
  putRow(row('1002', 'damage', {
    isPublic: true, openEdit: [], tagInt2: 534, text1: '累计伤害',
    createdAt: ago(7 * 60_000), updatedAt: ago(7 * 60_000),
  }))

  // 最近的心跳：45 秒在线窗口内
  addLog('lobby', '1001', '1001', 'update', ['tagInt1'],
    { tagInt1: 600 }, { tagInt1: 700 }, ago(20_000))
  addLog('lobby', '1001', '1002', 'update', ['tagInt1'],
    { tagInt1: 1 }, { tagInt1: 2 }, ago(10_000))

  putRow(row('1001', 'home', {
    isPublic: true, openEdit: ['tagInt1'], tagInt1: 7,
    text1: '月下喝茶', text2: 'moon',
    extra: { theme: 'moon', emoji: '🌙' },
    createdAt: ago(86400_000), updatedAt: ago(3600_000),
  }))
  putRow(row('1002', 'home', {
    isPublic: true, openEdit: ['tagInt1'], tagInt1: 3,
    text1: '猫在窗台', text2: 'cat',
    extra: { theme: 'cat', emoji: '🐱' },
    createdAt: ago(7200_000), updatedAt: ago(1800_000),
  }))
}

seed()

// ── JWT ────────────────────────────────────────────────────────
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')

function mintJwt(uid, ttlSec = 6 * 3600) {
  const now = Math.floor(Date.now() / 1000)
  const head = b64({ alg: 'ES256', typ: 'JWT' })
  const payload = b64({
    iss: 'http://mock-xmeta.local',
    sub: String(uid),
    aud: TOY_ID,
    jti: crypto.randomUUID(),
    iat: now,
    iat_ms: Date.now(),
    exp: now + ttlSec,
  })
  return head + '.' + payload + '.' + crypto.randomBytes(32).toString('base64url')
}

function subOf(req) {
  const auth = req.headers.authorization || ''
  const m = /^Bearer\s+(.+)$/i.exec(auth)
  if (!m) return null
  try {
    const part = m[1].split('.')[1]
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    if (!claims || !claims.sub) return null
    if (typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now()) return null
    return String(claims.sub)
  } catch (e) { return null }
}

// ── 路由用的小工具 ─────────────────────────────────────────────
function send(res, status, body, extraHeaders) {
  const text = body === undefined ? '' : JSON.stringify(body)
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Expose-Headers': 'Date',
  }, extraHeaders || {}))
  res.end(text)
}

function fail(res, status, code, message) {
  send(res, status, { error: { code, message } })
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  if (!chunks.length) return null
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch (e) { return null }
}

function wire(r) {
  return {
    uid: r.uid, scope: r.scope, isPublic: r.isPublic, openEdit: r.openEdit.slice(),
    tagTinyint: r.tagTinyint, tagInt1: r.tagInt1, tagInt2: r.tagInt2, tagBigint: r.tagBigint,
    text1: r.text1, text2: r.text2, textLong: r.textLong, extra: r.extra,
    expiresAt: r.expiresAt, createdAt: r.createdAt, updatedAt: r.updatedAt,
  }
}

const FIELD = {
  tagTinyint: 'tagTinyint', tagInt1: 'tagInt1', tagInt2: 'tagInt2', tagBigint: 'tagBigint',
  text1: 'text1', text2: 'text2', textLong: 'textLong', extra: 'extra',
}

function sameValue(a, b) {
  return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b)
}

function applyWrite(r, body, isOwn) {
  const changed = []
  const before = {}
  const after = {}

  for (const field of Object.keys(FIELD)) {
    if (!(field in body)) continue
    const value = body[field]
    if (!sameValue(r[field], value)) {
      before[field] = r[field]
      after[field] = value === undefined ? null : value
      r[field] = value === undefined ? null : value
      changed.push(field)
    }
  }

  if (body.inc && typeof body.inc === 'object') {
    for (const [field, delta] of Object.entries(body.inc)) {
      if (!(field in FIELD) || typeof delta !== 'number') continue
      const prev = Number(r[field]) || 0
      const next = prev + delta
      if (next !== prev) {
        before[field] = prev
        after[field] = next
        r[field] = next
        changed.push(field)
      }
    }
  }

  if (body.isPublic !== undefined && r.isPublic !== body.isPublic) {
    before.isPublic = r.isPublic
    after.isPublic = body.isPublic
    r.isPublic = body.isPublic
    changed.push('isPublic')
  }
  if (Array.isArray(body.openEdit) && !sameValue(r.openEdit, body.openEdit)) {
    before.openEdit = r.openEdit.slice()
    after.openEdit = body.openEdit.slice()
    r.openEdit = body.openEdit.slice()
    changed.push('openEdit')
  }
  if (typeof body.ttl === 'number' && body.ttl > 0) {
    const next = new Date(Date.now() + body.ttl * 1000).toISOString()
    if (next !== r.expiresAt) {
      before.expiresAt = r.expiresAt
      after.expiresAt = next
      r.expiresAt = next
      changed.push('expiresAt')
    }
  }

  r.updatedAt = nowIso()
  return { changed, before, after, isOwn }
}

function applyPatch(r, body, caller) {
  const isOwn = String(r.uid) === String(caller)
  const touched = []
  for (const k of Object.keys(body || {})) {
    if (k in FIELD || k === 'isPublic' || k === 'openEdit' || k === 'ttl') touched.push(k)
  }
  if (body && body.inc) touched.push(...Object.keys(body.inc))

  if (!isOwn) {
    const denied = touched.filter((k) => {
      if (k === 'isPublic' || k === 'openEdit' || k === 'ttl') return true
      return r.openEdit.indexOf(k) < 0
    })
    if (denied.length) {
      const err = new Error('这几个字段不允许你改：' + denied.join(', ') +
        '。这条数据开放的是：' + (r.openEdit.join(', ') || '（没有开放任何字段）'))
      err.code = 'forbidden'
      throw err
    }
  }
  return applyWrite(r, body, isOwn)
}

// ── 服务 ───────────────────────────────────────────────────────
export async function startMockServer(port = 0) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const method = req.method || 'GET'

    if (method === 'OPTIONS') {
      return send(res, 204, undefined, { 'Access-Control-Max-Age': '600' })
    }

    if (url.pathname.startsWith('/api/') || url.pathname === '/test/state' || url.pathname === '/test/session') {
      requests.push({ method, path: url.pathname + url.search, at: nowIso() })
    }

    // ── 测试辅助 ──
    if (url.pathname === '/test/state') {
      return send(res, 200, {
        rows: Array.from(rows.values()).map(wire),
        logs: Object.fromEntries(Array.from(logs.entries()).map(([k, v]) => [k, v.slice(-120)])),
        requests,
        tokenLog,
      })
    }
    if (url.pathname === '/test/session') {
      const uid = url.searchParams.get('uid') || MY_UID
      const ttl = Math.max(1, Number(url.searchParams.get('ttl') || 6 * 3600))
      const jwt = mintJwt(uid, ttl)
      return send(res, 200, {
        jwt,
        uid,
        expiresAt: Date.now() + ttl * 1000,
      })
    }
    if (url.pathname === '/test/token') {
      const uid = url.searchParams.get('uid') || MY_UID
      return send(res, 200, { access_token: mintJwt(uid), expires_in: 21600, token_type: 'Bearer' })
    }
    if (url.pathname === '/test/delay' && method === 'POST') {
      const body = await readBody(req) || {}
      delays.getRow = Math.max(0, Number(body.getRow) || 0)
      delays.heartbeat = Math.max(0, Number(body.heartbeat) || 0)
      const lobby = Array.from(rows.values()).find((r) => r.scope === 'lobby')
      frozenLobby = (delays.getRow || delays.heartbeat) && lobby
        ? JSON.parse(JSON.stringify(wire(lobby)))
        : null
      return send(res, 200, { delays, frozen: !!frozenLobby })
    }

    // ── 身份 ──
    if (url.pathname === '/api/bridge/context') {
      if (url.searchParams.get('cid') !== CLIENT_ID) {
        return fail(res, 404, 'unknown_client', '没有这个 client_id')
      }
      return send(res, 200, {
        clientId: CLIENT_ID, toyId: TOY_ID, slug: 'b15pXRp8Ak4eBelk', title: '联机 Demo',
        iconUrl: null, authorName: '三弟建模', authorMid: '29987088', ttlSeconds: 60,
      })
    }

    if (url.pathname === '/api/oauth/token' && method === 'POST') {
      const body = await readBody(req)
      if (!body || body.client_id !== CLIENT_ID) {
        return fail(res, 400, 'invalid_client', 'client_id 不对')
      }
      if (!body.code) return fail(res, 400, 'invalid_request', '缺 code')
      if (usedCodes.has(body.code)) return fail(res, 400, 'code_used', '这枚 code 已经用过了')
      usedCodes.add(body.code)
      const jwt = mintJwt(MY_UID)
      tokenLog.push({ code: body.code, uid: MY_UID, at: nowIso() })
      return send(res, 200, { access_token: jwt, token_type: 'Bearer', expires_in: 21600 })
    }

    // ── 需要令牌的接口 ──
    const caller = subOf(req)
    if (/^\/api\/(kv|user)\//.test(url.pathname) && !caller) {
      return fail(res, 401, 'unauthorized', '令牌没了或过期了')
    }

    if (url.pathname === '/api/user/profiles' && method === 'POST') {
      const body = await readBody(req)
      const wanted = Array.isArray(body && body.uids) ? body.uids.map(String) : []
      const profiles = wanted.filter((uid) => users.has(uid)).map((uid) => users.get(uid))
      return send(res, 200, { profiles })
    }

    // /api/kv/:scope/list
    const listMatch = /^\/api\/kv\/([^/]+)\/list$/.exec(url.pathname)
    if (listMatch && method === 'GET') {
      const scope = listMatch[1]
      const page = Math.max(1, Number(url.searchParams.get('page') || 1))
      const size = Math.min(100, Math.max(1, Number(url.searchParams.get('size') || 20)))
      const sortField = url.searchParams.get('sort') || ''
      const order = url.searchParams.get('order') === 'asc' ? 'asc' : 'desc'
      const cacheKey = scope + ':' + page + ':' + size + ':' + sortField + ':' + order
      const cached = listCache.get(cacheKey)
      if (cached && Date.now() - cached.at < LIST_CACHE_MS) {
        return send(res, 200, cached.body)
      }
      const sortable = ['tagInt1', 'tagInt2', 'tagTinyint']
      const all = Array.from(rows.values())
        .filter((r) => r.scope === scope && r.isPublic && new Date(r.expiresAt).getTime() > Date.now())
        .sort((a, b) => {
          if (sortable.includes(sortField)) {
            const d = (Number(a[sortField]) || 0) - (Number(b[sortField]) || 0)
            if (d !== 0) return order === 'asc' ? d : -d
          }
          return Number(a.uid) - Number(b.uid)
        })
      const items = all.slice((page - 1) * size, page * size).map(wire)
      const body = { items, page, size, total: all.length, hasNext: page * size < all.length }
      listCache.set(cacheKey, { at: Date.now(), body })
      return send(res, 200, body)
    }

    // /api/kv/:scope/:uid/log
    const logMatch = /^\/api\/kv\/([^/]+)\/([^/]+)\/log$/.exec(url.pathname)
    if (logMatch && method === 'GET') {
      const scope = logMatch[1]
      const uid = logMatch[2]
      const r = rows.get(keyOf(scope, uid))
      if (!r) return fail(res, 404, 'not_found', '那条数据不存在')
      if (String(r.uid) !== String(caller) && !r.isPublic) {
        return fail(res, 403, 'forbidden', '这条数据是私有的')
      }
      const page = Math.max(1, Number(url.searchParams.get('page') || 1))
      const size = Math.min(100, Math.max(1, Number(url.searchParams.get('size') || 20)))
      const changed = url.searchParams.get('changed') || ''
      let all = (logs.get(keyOf(scope, uid)) || []).slice().reverse()
      if (changed) all = all.filter((e) => e.changed.includes(changed))
      const items = all.slice((page - 1) * size, page * size)
      return send(res, 200, { items, page, size, total: all.length, hasNext: page * size < all.length })
    }

    // /api/kv/:scope/:uid（DELETE）
    const rowMatch = /^\/api\/kv\/([^/]+)\/([^/]+)$/.exec(url.pathname)
    if (rowMatch && method === 'DELETE') {
      const scope = rowMatch[1]
      const uid = rowMatch[2]
      const r = rows.get(keyOf(scope, uid))
      if (!r) return fail(res, 404, 'not_found', '那条数据不存在')
      if (String(uid) !== String(caller)) return fail(res, 403, 'forbidden', '只能删自己的')
      rows.delete(keyOf(scope, uid))
      logs.delete(keyOf(scope, uid))
      return send(res, 200, { deleted: 1, data: wire(r) })
    }

    // /api/kv/:scope
    const kvMatch = /^\/api\/kv\/([^/]+)$/.exec(url.pathname)
    if (kvMatch) {
      const scope = kvMatch[1]
      const target = String(url.searchParams.get('uid') || caller)

      if (method === 'GET') {
        const r = rows.get(keyOf(scope, target))
        let payload
        if (!r) {
          payload = { data: null }
        } else if (target !== String(caller) && !r.isPublic) {
          return fail(res, 403, 'forbidden', '这条数据是私有的')
        } else {
          payload = { data: wire(r) }
        }
        // 开了延迟就一律回「开延迟那一刻」的旧快照（模拟还没更新的缓存）
        if (delays.getRow && scope === 'lobby' && frozenLobby) {
          payload = { data: JSON.parse(JSON.stringify(frozenLobby)) }
          await sleep(delays.getRow)
        }
        return send(res, 200, payload)
      }

      if (method === 'PUT') {
        if (target !== String(caller)) return fail(res, 403, 'forbidden', '不能替别人建数据')
        const body = await readBody(req) || {}
        const existing = rows.get(keyOf(scope, target))
        const created = !existing
        const r = existing || row(target, scope, {})
        const result = applyWrite(r, body, true)
        putRow(r)
        if (created) {
          addLog(scope, target, caller, 'create', result.changed, null, result.after)
        } else if (result.changed.length) {
          addLog(scope, target, caller, 'update', result.changed, result.before, result.after)
        }
        return send(res, 200, {
          data: wire(r), created, modified: result.changed.length > 0, changed: result.changed,
        })
      }

      if (method === 'PATCH') {
        const body = await readBody(req) || {}
        const r = rows.get(keyOf(scope, target))
        if (!r) return fail(res, 404, 'not_found', '这条数据还不存在，请先用 PUT 创建')
        let result
        try {
          result = applyPatch(r, body, caller)
        } catch (e) {
          return fail(res, e.code === 'forbidden' ? 403 : 400, e.code || 'invalid_param', e.message)
        }
        if (result.changed.length) {
          addLog(scope, target, caller, 'update', result.changed, result.before, result.after)
        }
        const payload = {
          data: wire(r), modified: result.changed.length > 0, changed: result.changed,
        }
        const isHeartbeat = scope === 'lobby' && body.tagInt1 !== undefined && !body.inc
        if (delays.heartbeat && isHeartbeat) {
          if (frozenLobby) {
            payload.data = JSON.parse(JSON.stringify(frozenLobby))
          }
          await sleep(delays.heartbeat)
        }
        return send(res, 200, payload)
      }
    }

    // ── 静态文件 ──
    let file = url.pathname === '/' ? '/index.html' : url.pathname
    if (file === '/index-test.html') {
      let html = await fs.readFile(path.join(ROOT, 'index.html'), 'utf8')
      html = html.replace('//s1.hdslb.com/bfs/seed/toy/app/sdk/toy-sdk.js', '/test-toy-sdk.js')
      html = html.replace('https://www.oxth.com:8443/xmeta-client.js', '/test-sdk.js')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end(html)
    }
    if (file === '/test-sdk.js') {
      const js = await fs.readFile(path.join(ROOT, '..', '..', 'toy-side', 'xmeta-client.js'), 'utf8')
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end(js)
    }
    if (file === '/test-toy-sdk.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end('window.toy = window.toy || { navigate: function () { return Promise.resolve() } };')
    }

    const allowed = ['/demo.js', '/xmeta-ui.css', '/index.html']
    if (!allowed.includes(file)) {
      return fail(res, 404, 'not_found', '没有这个文件：' + file)
    }
    try {
      const data = await fs.readFile(path.join(ROOT, file))
      const type = file.endsWith('.css') ? 'text/css; charset=utf-8'
        : file.endsWith('.js') ? 'text/javascript; charset=utf-8'
          : 'text/html; charset=utf-8'
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' })
      res.end(data)
    } catch (e) {
      fail(res, 404, 'not_found', '没有这个文件：' + file)
    }
  })

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  const addr = server.address()
  return {
    server,
    port: addr.port,
    origin: 'http://127.0.0.1:' + addr.port,
    close: () => new Promise((resolve) => server.close(resolve)),
    state: () => ({
      rows: Array.from(rows.values()).map(wire),
      logs: Object.fromEntries(Array.from(logs.entries()).map(([k, v]) => [k, v.slice(-120)])),
      requests,
      tokenLog,
    }),
    seed,
  }
}

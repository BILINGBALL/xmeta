/**
 * 联机 Demo —— 一个能直接用 xmeta 玩起来的 toy 端页面
 *
 * 这一页把 xmeta 的几件事都串起来了：
 *   ① 身份：过桥拿 JWT，显示 uid / 有效期，过期了能重新申请
 *   ② 大厅：所有人往同一条 lobby 数据上写心跳和消息，在线状态从改动日志里读
 *   ③ 世界 Boss：用 inc 原子扣血，伤害榜也从改动日志里算
 *   ④ 小窝：公开、只开放一个字段给别人串门计数
 *   ⑤ 背包：私有数据，金币用 inc 加，道具放 extra
 *
 * 数据怎么放、为什么这么放，写在同目录的 README.md 里。
 */
(function () {
  'use strict'

  // ─────────────────────────────────────────────────────────────
  // 配置
  // ─────────────────────────────────────────────────────────────
  const CONFIG = {
    apiBase: 'https://www.oxth.com:8443',
    centerToySlug: 'xmeta',
    centerToyId: '39945062320128',
    // 认领这个 toy 时拿到的 client_id。改 toy 的时候记得一起换。
    clientId: 'xmeta_OXSY7nxlpKooXGd0oS95Cg',

    lobbyScope: 'lobby',
    // 改了字段布局就换一版标记，别让页面接着用旧房间的旧数据。
    // v1 的房间（比如还带着 0 血或者别的字段含义）会被当成不存在。
    lobbyMarker: 'xmeta-lobby-v2',
    homeScope: 'home',
    bagScope: 'bag',
    // 伤害榜：一人一条，公开。攻击时只加自己这条。
    // 不读改动日志 —— 一千个人打十次就是一万条日志，客户端翻不动。
    damageScope: 'damage',

    bossMaxHp: 100000,
    pollMs: 3000,             // 大厅同步间隔
    heartbeatMs: 12000,       // 心跳间隔（在线判定看心跳留下的日志）
    presenceMs: 45000,        // 45 秒内有心跳就算在线
    homeRefreshMs: 15000,     // 小窝人气榜刷新间隔
    damageRefreshMs: 15000,   // 伤害榜刷新间隔
    actionCooldownMs: 5000,   // 攻击 / 打工 / 捡道具的点击间隔
    logSize: 100,             // 一次拉多少条改动（接口上限 100）
    chatPageSize: 100,        // 聊天历史一页多少条（按 changed=text1 筛过）
    chatKeepMax: 1000         // 最多在页面里留多少条已加载的消息
  }

  // 只在本地打开时允许测试脚本改 apiBase。
  // 线上的 toy 页面不会走到这里 —— 不然别人给你一个带参数的链接，
  // 就能把请求（连同心跳和凭证）引到他自己的服务器。
  if (
    (location.hostname === '127.0.0.1' || location.hostname === 'localhost') &&
    window.__XMETA_DEMO_OVERRIDE__
  ) {
    Object.assign(CONFIG, window.__XMETA_DEMO_OVERRIDE__)
  }

  const STORAGE_PREFIX = 'xmeta-demo:'
  const LOBBY_HOST_KEY = STORAGE_PREFIX + 'lobby-host:' + CONFIG.clientId

  const THEMES = {
    sakura: { emoji: '🌸', name: '樱花小院' },
    moon: { emoji: '🌙', name: '月夜屋顶' },
    camp: { emoji: '🏕️', name: '林间营地' },
    cat: { emoji: '🐱', name: '猫猫小屋' },
    space: { emoji: '🚀', name: '太空舱' }
  }

  const ITEMS = [
    { id: 'sword', emoji: '🗡️', name: '生锈的剑' },
    { id: 'potion', emoji: '🧪', name: '红色药水' },
    { id: 'gem', emoji: '💎', name: '闪光的石头' },
    { id: 'bread', emoji: '🍞', name: '半块面包' },
    { id: 'leaf', emoji: '🍃', name: '奇怪的叶子' },
    { id: 'key', emoji: '🗝️', name: '旧钥匙' },
    { id: 'shell', emoji: '🐚', name: '海螺' },
    { id: 'coin', emoji: '🪙', name: '幸运币' }
  ]

  // ─────────────────────────────────────────────────────────────
  // 小工具
  // ─────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id)

  /** 所有渲染都走 textContent / createElement，不拼 innerHTML，免得昵称里的标签生效 */
  function el(tag, cls, text) {
    const node = document.createElement(tag)
    if (cls) node.className = cls
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild)
  }

  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)) }

  function pad2(n) { return String(n).padStart(2, '0') }

  /** 时:分:秒 —— 秒位在动，一眼能看出倒计时还活着 */
  function fmtLeft(ms) {
    const s = Math.max(0, Math.floor(ms / 1000))
    const h = Math.floor(s / 3600)
    return (h > 0 ? h + ':' : '') + pad2(Math.floor((s % 3600) / 60)) + ':' + pad2(s % 60)
  }

  function fmtNum(n) {
    const v = Number(n) || 0
    return v.toLocaleString('zh-CN')
  }

  function fmtAgo(iso) {
    const t = new Date(iso).getTime()
    if (!Number.isFinite(t)) return ''
    const diff = serverNow() - t
    if (diff < 10_000) return '刚刚'
    if (diff < 60_000) return Math.max(1, Math.floor(diff / 1000)) + ' 秒前'
    if (diff < 3600_000) return Math.floor(diff / 60_000) + ' 分钟前'
    return Math.floor(diff / 3600_000) + ' 小时前'
  }

  function fmtClock(iso) {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
  }

  function storageGet(key) {
    try { return localStorage.getItem(key) || '' } catch (e) { return '' }
  }
  function storageSet(key, value) {
    try { localStorage.setItem(key, value) } catch (e) { /* 隐私模式 */ }
  }
  function storageDel(key) {
    try { localStorage.removeItem(key) } catch (e) { /* 忽略 */ }
  }

  /** 服务端时间估计：日志里的时间都以服务端为准，别让本机时钟跑偏把人在线状态算错 */
  let serverOffset = 0
  function serverNow() { return Date.now() + serverOffset }

  function decodeClaims(jwt) {
    try {
      const b64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return JSON.parse(new TextDecoder().decode(bytes))
    } catch (e) { return null }
  }

  // ─────────────────────────────────────────────────────────────
  // 状态
  // ─────────────────────────────────────────────────────────────
  const state = {
    started: false,
    starting: false,
    online: false,
    authLost: false,
    myUid: null,
    session: null,
    tab: 'lobby',

    lobbyHost: null,
    room: null,
    logs: [],                 // 最近 100 条改动，只用来算谁在线
    lastLogAt: 0,
    lastHeartbeatAt: 0,
    heartbeatValue: 0,

    // 伤害榜：一人一条公开数据，按 tagInt2 排序取前 N 条。
    // 不翻改动日志 —— 攻击次数是无限的，玩家数是有限的。
    damageRows: new Map(),    // uid -> damage Row
    myDamage: null,
    damageAt: 0,
    damageLoading: false,

    // 聊天：按 changed=text1 从日志里翻，不会被心跳挤掉
    chatLogs: [],             // 已加载的消息，按时间升序
    chatPage: 0,              // 已经加载到第几页（从 1 开始）
    chatHasNext: false,
    chatLoading: false,
    chatLoadingOlder: false,
    chatInitialized: false,

    profiles: new Map(),      // uid -> { uid, nickname, avatar }
    homes: new Map(),         // uid -> home Row
    bag: null,
    home: null,
    myLogs: [],

    reqs: [],
    loops: [],
    pendingChat: [],
    homeDirty: false,
    homeTheme: '',
    cooldowns: { attack: 0, work: 0, find: 0 },
    busy: { attack: false, work: false, find: false },

    toastTimer: null,
    errTimer: null,
    lastError: '',
    syncing: false
  }

  function session() {
    try {
      return typeof XMETA !== 'undefined' ? XMETA.getSession() : null
    } catch (e) { return null }
  }

  // ─────────────────────────────────────────────────────────────
  // 请求封装
  // ─────────────────────────────────────────────────────────────
  function pathOf(p) { return CONFIG.apiBase + p }

  function logReq(entry) {
    state.reqs.unshift(entry)
    if (state.reqs.length > 50) state.reqs.length = 50
    if (state.tab === 'debug') renderReqs()
  }

  async function api(method, p, body, opts) {
    opts = opts || {}
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now())
    const headers = {}
    const s = session()
    if (s && s.jwt) headers.Authorization = 'Bearer ' + s.jwt
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    let res
    let json = null
    // 请求挂住时别把轮询卡死。15 秒够慢网络用，也够让下一轮接手。
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), 15000) : null
    try {
      res = await fetch(pathOf(p), {
        method,
        headers,
        signal: controller ? controller.signal : undefined,
        body: body === undefined ? undefined : JSON.stringify(body)
      })
      if (timer) clearTimeout(timer)
      // 拿服务端的 Date 对一下表，在线状态按服务端时间算
      const date = res.headers.get('date')
      if (date) {
        const t = Date.parse(date)
        if (Number.isFinite(t)) serverOffset = t - Date.now()
      }
      try { json = await res.json() } catch (e) { json = null }
    } catch (e) {
      if (timer) clearTimeout(timer)
      logReq({
        method, path: p, status: 0,
        ms: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0),
        code: e.name === 'AbortError' ? 'timeout' : 'network',
        message: e.name === 'AbortError' ? '请求超时（15 秒）' : (e.message || String(e))
      })
      const err = new Error(e.name === 'AbortError' ? '请求超时，请检查网络' : ('网络请求失败：' + (e.message || e)))
      err.code = e.name === 'AbortError' ? 'timeout' : 'network'
      throw err
    }

    const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0)
    const errCode = res.ok ? null : ((json && json.error && json.error.code) || ('http_' + res.status))
    // 轮询的 GET 不写进请求日志，否则每 3 秒两条会把真正值得看的写操作刷走。
    // 失败的照样记，不然网络问题就看不见了。
    if (!opts.quiet || !res.ok) {
      logReq({
        method, path: p, status: res.status, ms,
        code: errCode,
        message: res.ok ? null : ((json && json.error && json.error.message) || '')
      })
    }

    if (!res.ok) {
      if (res.status === 401) handleAuthLost()
      const err = new Error((json && json.error && json.error.message) || ('HTTP ' + res.status))
      err.code = errCode
      err.status = res.status
      throw err
    }
    return json || {}
  }

  function kvPath(scope, uid) {
    return '/api/kv/' + encodeURIComponent(scope) + (uid ? '?uid=' + encodeURIComponent(uid) : '')
  }

  function logPath(scope, uid, size, page) {
    return '/api/kv/' + encodeURIComponent(scope) + '/' + encodeURIComponent(uid) +
      '/log?page=' + (page || 1) + '&size=' + (size || 20)
  }

  // ─────────────────────────────────────────────────────────────
  // 身份与会话
  // ─────────────────────────────────────────────────────────────
  function handleAuthLost() {
    if (state.authLost) return
    state.authLost = true
    state.online = false
    stopLoops()
    renderConnection()
    showAuthBanner(true)
    showError('联机凭证已过期或失效。再申请一次就能继续玩，之前的 uid 和本地数据都还在。')
  }

  function onSessionGained(s) {
    state.session = s
    state.myUid = String(s.uid)
    state.authLost = false
    showAuthBanner(false)
    if (!state.started) {
      boot()
    } else {
      state.online = true
      renderConnection()
      startLoops()
      refreshLobby().catch(reportError)
      refreshHomes().catch(reportError)
    }
  }

  function onSessionLost() {
    stopLoops()
    state.online = false
    state.started = false
    state.starting = false
    state.myUid = null
    state.session = null
    state.room = null
    state.logs = []
    state.bag = null
    state.home = null
    state.homes.clear()
    state.profiles.clear()
    state.pendingChat = []
    state.homeDirty = false
    state.homeTheme = ''
    state.damageRows.clear()
    state.myDamage = null
    state.damageAt = 0
    state.chatLogs = []
    state.chatPage = 0
    state.chatHasNext = false
    state.chatInitialized = false
    state.cooldowns = { attack: 0, work: 0, find: 0 }
    state.busy = { attack: false, work: false, find: false }
    showGuest()
  }

  async function boot() {
    if (state.starting || state.started) return
    const s = session()
    if (!s) { showGuest(); return }

    state.starting = true
    state.session = s
    state.myUid = String(s.uid)
    state.online = true
    state.authLost = false
    showGame()
    renderConnection()
    showLoading(true)

    try {
      // 背包、小窝、伤害榜都是一人一条，首次进来自动建好
      await Promise.all([ensureBag(), ensureHome(), ensureDamage()])
      await ensureLobby()
      state.lastHeartbeatAt = Date.now()   // 先把自己算在线，第一次心跳马上补上
      state.started = true
      showLoading(false)
      renderAll()
      startLoops()
      await refreshLobby()
      await Promise.all([refreshHomes(), refreshDamage(true)])
      $('app').setAttribute('data-ready', '1')
    } catch (e) {
      showLoading(false)
      state.started = true
      $('app').setAttribute('data-ready', 'error')
      reportError(e, true)
    } finally {
      state.starting = false
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 数据初始化
  // ─────────────────────────────────────────────────────────────
  function bagDefaults() {
    return {
      ttl: 7 * 24 * 3600,
      isPublic: false,
      openEdit: [],
      tagInt2: 0,
      text1: '我的背包',
      extra: { items: [] }
    }
  }

  function homeDefaults() {
    const theme = 'sakura'
    return {
      ttl: 7 * 24 * 3600,
      isPublic: true,
      openEdit: ['tagInt1'],       // 只开「串门次数」给所有人加
      tagInt1: 0,
      text1: '欢迎来坐坐',
      text2: theme,
      extra: { theme, emoji: THEMES[theme].emoji }
    }
  }

  function lobbyDefaults() {
    return {
      ttl: 30 * 24 * 3600,         // 公共大厅开久一点；房主心跳时还会续期
      isPublic: true,
      // 心跳、聊天、Boss 血量都写在这一条上 —— 所以这三个字段要开给所有人
      openEdit: ['text1', 'tagInt1', 'tagInt2'],
      tagTinyint: 1,
      tagInt1: nextHeartbeatValue(),
      tagInt2: CONFIG.bossMaxHp,
      text1: '',
      text2: CONFIG.lobbyMarker,   // 房间标记，不开放给其他人改
      textLong: '这是 xmeta 联机 Demo 的公共大厅。在线看心跳，聊天从日志读；伤害榜在 damage scope，一人一条。',
      extra: { demo: CONFIG.lobbyMarker, bossMax: CONFIG.bossMaxHp }
    }
  }

  async function ensureBag() {
    const r = await api('GET', kvPath(CONFIG.bagScope))
    if (r.data) { state.bag = r.data; return }
    const w = await api('PUT', kvPath(CONFIG.bagScope), bagDefaults())
    state.bag = w.data
  }

  async function ensureHome() {
    const r = await api('GET', kvPath(CONFIG.homeScope))
    if (r.data) { state.home = r.data; return }
    const w = await api('PUT', kvPath(CONFIG.homeScope), homeDefaults())
    state.home = w.data
  }

  function damageDefaults() {
    return {
      ttl: 30 * 24 * 3600,    // 累计伤害放久一点；每次攻击会续期
      isPublic: true,         // 排行榜要读得到
      openEdit: [],           // 只有自己能改
      tagInt2: 0,             // 累计伤害
      text1: '累计伤害'
    }
  }

  async function ensureDamage() {
    const r = await api('GET', kvPath(CONFIG.damageScope))
    if (r.data) {
      state.myDamage = r.data
      state.damageRows.set(state.myUid, r.data)
      return
    }
    const w = await api('PUT', kvPath(CONFIG.damageScope), damageDefaults())
    state.myDamage = w.data
    state.damageRows.set(state.myUid, w.data)
  }

  function usableRoom(row) {
    if (!row || row.isPublic !== true) return false
    if (row.text2 !== CONFIG.lobbyMarker) return false
    const open = Array.isArray(row.openEdit) ? row.openEdit : []
    if (!['text1', 'tagInt1', 'tagInt2'].every((f) => open.indexOf(f) >= 0)) return false
    // 血量上限必须是我们写进去的那个。旧房间没有这个字段、或者血量不是
    // 从满血开始的，不要拿来接着打 —— 否则显示和实际扣血会对不上。
    const max = row.extra && Number(row.extra.bossMax)
    return Number.isFinite(max) && max > 0
  }

  function uidCompare(a, b) {
    const na = Number(a)
    const nb = Number(b)
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
    return String(a).localeCompare(String(b))
  }

  function newerRow(a, b) {
    if (!a) return b
    if (!b) return a
    return roomStamp(b) >= roomStamp(a) ? b : a
  }

  function roomStamp(row) {
    const t = row && row.updatedAt ? new Date(row.updatedAt).getTime() : NaN
    return Number.isFinite(t) ? t : 0
  }

  /**
   * 收下一行大厅数据，但**旧响应不许覆盖新响应**。
   *
   * 攻击、心跳、3 秒轮询是三个并发请求，响应到达顺序不保证：
   * 攻击已经把血量写下去了，晚到的轮询响应可能还是攻击前的旧行。
   * 服务端的单条读缓存也有一个很窄的「回源和写并发」窗口，会把旧行再缓存 30 秒。
   *
   * 每一行都有服务端写的 updatedAt，拿它当版本号：比当前旧的直接丢掉。
   * 只有同一行才比较（切大厅时 uid 不同，必须接受新行）。
   */
  function setRoom(row) {
    if (!row) return false
    const same = state.room &&
      String(state.room.uid) === String(row.uid) &&
      state.room.scope === row.scope
    if (same) {
      const prev = roomStamp(state.room)
      const next = roomStamp(row)
      if (prev && next && next < prev) return false
    }
    state.room = row
    return true
  }

  function resetChat() {
    state.chatLogs = []
    state.chatPage = 0
    state.chatHasNext = false
    state.chatInitialized = false
    state.chatLoading = false
    state.chatLoadingOlder = false
    state.pendingChat = []
  }

  function switchLobby(host, row) {
    const next = String(host)
    if (state.lobbyHost && state.lobbyHost !== next) {
      resetChat()
      state.logs = []
    }
    state.lobbyHost = next
    storageSet(LOBBY_HOST_KEY, next)
    setRoom(row)
    renderRoomInfo()
  }

  /**
   * 找大厅：先看本地记的房主 uid，再列一遍找最早建的那间，最后才自己建。
   *
   * 「最早建的那间」不是随便挑的：列表接口有最多 30 秒的缓存，
   * 两个人在缓存窗口里同时进来时可能各自建一间。按创建时间挑，
   * 所有人最后会收敛到最早那间。
   */
  async function ensureLobby() {
    const saved = state.lobbyHost || storageGet(LOBBY_HOST_KEY)
    if (saved) {
      const r = await api('GET', kvPath(CONFIG.lobbyScope, saved)).catch((e) => {
        if (e.code === 'forbidden') return { data: null }
        throw e
      })
      if (usableRoom(r.data)) {
        switchLobby(saved, r.data)
        return
      }
      storageDel(LOBBY_HOST_KEY)
      state.lobbyHost = null
    }

    const listed = await api(
      'GET',
      '/api/kv/' + encodeURIComponent(CONFIG.lobbyScope) + '/list?page=1&size=100'
    )
    const candidates = (listed.items || [])
      .filter(usableRoom)
      .sort((a, b) => {
        const ta = new Date(a.createdAt).getTime() || 0
        const tb = new Date(b.createdAt).getTime() || 0
        return ta - tb || uidCompare(a.uid, b.uid)
      })

    if (candidates.length) {
      const pick = candidates[0]
      const r = await api('GET', kvPath(CONFIG.lobbyScope, pick.uid))
      if (usableRoom(r.data)) {
        switchLobby(pick.uid, r.data)
        return
      }
    }

    // 还没有大厅：自己建一间。第一条 lobby 数据就是所有人的公共房间。
    const w = await api('PUT', kvPath(CONFIG.lobbyScope), lobbyDefaults())
    switchLobby(state.myUid, w.data)
  }

  /**
   * 单人测试用：把自己的 lobby 行建成新大厅，指针指过去。
   * 这样 Boss 血量、聊天、心跳都在自己名下，不会再改到别人的行。
   */
  async function createOwnLobby() {
    if (!state.online) return
    try {
      const w = await api('PUT', kvPath(CONFIG.lobbyScope), lobbyDefaults())
      resetChat()
      switchLobby(state.myUid, w.data)
      state.logs = []
      renderAll()
      showToast('开好了。这间大厅归你，打 Boss 只会改你自己的数据。')
      await refreshLobby()
    } catch (e) {
      showError(e)
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 心跳 / 同步
  // ─────────────────────────────────────────────────────────────

  /** tagInt1 当心跳值：每次都不一样，才算一次真正的改动（没改动就不会留日志） */
  function nextHeartbeatValue() {
    let v = (Math.floor(Date.now() / 1000) % 30000) + 1
    if (v === state.heartbeatValue) v = (v % 30000) + 1
    state.heartbeatValue = v
    return v
  }

  async function heartbeat() {
    if (!state.online || !state.lobbyHost || state.authLost) return
    const body = { tagInt1: nextHeartbeatValue() }
    // 续期只有属主能做（别人的数据不接受 ttl），房主心跳时顺手把大厅续上
    if (state.lobbyHost === state.myUid) body.ttl = 30 * 24 * 3600

    try {
      const r = await api('PATCH', kvPath(CONFIG.lobbyScope, state.lobbyHost), body, { quiet: true })
      if (!r.data) return
      setRoom(r.data)
      state.lastHeartbeatAt = Date.now()
      renderBoss()
    } catch (e) {
      if (e.code === 'not_found') {
        // 大厅那条数据没了（过期或被删），重新找一间
        state.lobbyHost = null
        storageDel(LOBBY_HOST_KEY)
        await ensureLobby()
      } else if (e.code !== 'network' && e.code !== 'timeout' && e.status !== 401) {
        showError(e)
      }
    }
  }

  /** 从最近 100 条改动里解出谁在线。聊天和伤害各自走自己的数据。 */
  function parseLogs() {
    const logs = state.logs
    const now = serverNow()

    // 在线：45 秒内留下过心跳或发言的人
    const seen = new Map()
    for (const e of logs) {
      if (!e.actorUid) continue
      const at = new Date(e.createdAt).getTime()
      if (!Number.isFinite(at)) continue
      if (now - at > CONFIG.presenceMs) continue
      const uid = String(e.actorUid)
      if (!seen.has(uid) || seen.get(uid) < at) seen.set(uid, at)
    }
    if (state.myUid) {
      const mineAt = state.lastHeartbeatAt || (state.started ? 0 : now)
      if (mineAt && now - mineAt <= CONFIG.presenceMs) seen.set(state.myUid, mineAt)
    }
    return { online: seen }
  }

  /** 一条「动过 text1」的日志就是一句话 */
  function logToMessage(e) {
    if (!e || !e.changed || e.changed.indexOf('text1') < 0) return null
    const text = e.after && e.after.text1
    if (typeof text !== 'string' || !text.trim()) return null
    return {
      id: String(e.id),
      uid: e.actorUid ? String(e.actorUid) : null,
      text: text,
      at: e.createdAt
    }
  }

  function collectUids() {
    const set = new Set()
    if (state.myUid) set.add(String(state.myUid))
    if (state.lobbyHost) set.add(String(state.lobbyHost))
    for (const e of state.logs) if (e.actorUid) set.add(String(e.actorUid))
    for (const uid of state.damageRows.keys()) set.add(String(uid))
    for (const m of state.chatLogs) if (m.uid) set.add(String(m.uid))
    for (const uid of state.homes.keys()) set.add(String(uid))
    return Array.from(set)
  }

  async function ensureProfiles(uids) {
    const missing = []
    for (const uid of uids) {
      if (!uid || state.profiles.has(String(uid))) continue
      missing.push(String(uid))
      if (missing.length >= 100) break
    }
    if (!missing.length) return
    try {
      const r = await api('POST', '/api/user/profiles', { uids: missing })
      for (const p of r.profiles || []) {
        state.profiles.set(String(p.uid), p)
      }
      // 接口只回「在本 toy 出现过的人」。没回的人也记一下，别每轮都问
      for (const uid of missing) {
        if (!state.profiles.has(uid)) state.profiles.set(uid, { uid, nickname: null, avatar: null })
      }
    } catch (e) {
      if (e.status !== 401 && e.status !== 429) showError(e)
    }
  }

  async function refreshLobby() {
    if (!state.online || state.authLost || state.syncing) return
    if (!state.lobbyHost) { await ensureLobby(); return }

    state.syncing = true
    try {
      const [rowRes, logRes] = await Promise.all([
        api('GET', kvPath(CONFIG.lobbyScope, state.lobbyHost), undefined, { quiet: true }),
        api('GET', logPath(CONFIG.lobbyScope, state.lobbyHost, CONFIG.logSize), undefined, { quiet: true })
      ])

      if (!rowRes.data) {
        // 大厅被删了或过期了，重新找一间
        state.lobbyHost = null
        storageDel(LOBBY_HOST_KEY)
        await ensureLobby()
        return
      }

      setRoom(rowRes.data)
      state.logs = logRes.items || []
      state.lastLogAt = Date.now()
      // 聊天单独按 changed=text1 拉；不阻塞在线状态
      loadChat(1, false).catch(() => {})

      await ensureProfiles(collectUids())
      renderPlayers()
      renderChat()
      renderBoss()
      renderHomeBoard()
      renderRoomInfo()
      refreshDamage(false).catch(() => {})
      if (state.tab === 'debug') renderRaw()
    } catch (e) {
      if (e.code === 'not_found') {
        state.lobbyHost = null
        storageDel(LOBBY_HOST_KEY)
        await ensureLobby()
      } else if (e.status !== 401 && e.status !== 429 && e.code !== 'network' && e.code !== 'timeout') {
        showError(e)
      }
    } finally {
      state.syncing = false
    }
  }

  async function refreshHomes() {
    if (!state.online || state.authLost) return
    try {
      const r = await api(
        'GET',
        '/api/kv/' + encodeURIComponent(CONFIG.homeScope) + '/list?page=1&size=100',
        undefined,
        { quiet: true }
      )
      const homes = new Map()
      for (const row of r.items || []) {
        const key = String(row.uid)
        // 列表可能来自缓存（最多 30 秒）。刚串过门的那一行以更新过的本地版本为准，
        // 否则会出现「先变 1、又被列表刷回 0」。
        homes.set(key, newerRow(state.homes.get(key), row))
      }
      // 列表缓存里可能还没有刚建好的小窝，本地已经有的先保留
      for (const [key, row] of state.homes) {
        if (!homes.has(key)) homes.set(key, row)
      }
      state.homes = homes
      // 自己的小窝以单条读到的为准（列表有缓存，自己刚改完可能还没刷新）
      if (state.home) {
        state.homes.set(state.myUid, newerRow(state.homes.get(state.myUid), state.home))
      }
      await ensureProfiles(collectUids())
      renderPlayers()
      renderHomeBoard()
      renderMe()
    } catch (e) {
      if (e.status !== 401 && e.status !== 429 && e.code !== 'network' && e.code !== 'timeout') showError(e)
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 伤害榜 / 聊天历史
  // ─────────────────────────────────────────────────────────────

  /**
   * 伤害榜：一人一条公开数据，按 tagInt2 排序取前 100 条。
   *
   * 为什么不从改动日志算：攻击次数是无限的，1000 个人各打 10 次就是 1 万条日志，
   * 客户端翻全量既不现实也会被限流。玩家数是有限的，1000 人 = 1000 行，
   * 按分数排序后一页 100 条就够显示前 8 名。
   *
   * 列表缓存最多 30 秒；自己刚打的那一下以单条写入的返回为准，先本地更新。
   */
  async function refreshDamage(force) {
    if (!state.online || state.authLost) return
    if (state.damageLoading) return
    if (!force && Date.now() - state.damageAt < CONFIG.damageRefreshMs - 2000) return

    state.damageLoading = true
    try {
      const r = await api(
        'GET',
        '/api/kv/' + encodeURIComponent(CONFIG.damageScope) +
          '/list?page=1&size=100&sort=tagInt2&order=desc',
        undefined,
        { quiet: true }
      )
      const rows = new Map()
      for (const row of r.items || []) rows.set(String(row.uid), row)

      // 自己的那条以较新的版本为准：列表有缓存，刚打完可能还没刷新
      const mineFromList = rows.get(state.myUid)
      if (state.myDamage && (!mineFromList || roomStamp(state.myDamage) >= roomStamp(mineFromList))) {
        rows.set(state.myUid, state.myDamage)
      } else if (mineFromList) {
        state.myDamage = mineFromList
      }

      state.damageRows = rows
      state.damageAt = Date.now()
      await ensureProfiles(collectUids())
      renderBoard()
      renderRaw()
    } catch (e) {
      if (e.status !== 401 && e.status !== 429 && e.code !== 'network' && e.code !== 'timeout') {
        showError(e)
      }
    } finally {
      state.damageLoading = false
    }
  }

  /**
   * 聊天历史。`changed=text1` 只回「动过 text1」的日志，
   * 不会被同一条大厅数据上的心跳挤掉；翻页就能一直往前看。
   *
   * 参数 page 从 1 开始；older=true 表示点「加载更早的消息」。
   */
  async function loadChat(page, older) {
    if (!state.online || state.authLost || !state.lobbyHost) return
    if (older) {
      if (state.chatLoadingOlder || !state.chatHasNext) return
    } else if (state.chatLoading) {
      return
    }

    const box = $('chatList')
    const keep = older && box ? { height: box.scrollHeight, top: box.scrollTop } : null
    if (older) state.chatLoadingOlder = true
    else state.chatLoading = true

    try {
      const r = await api(
        'GET',
        logPath(CONFIG.lobbyScope, state.lobbyHost, CONFIG.chatPageSize, page) + '&changed=text1',
        undefined,
        { quiet: true }
      )
      const items = (r.items || []).map(logToMessage).filter(Boolean)

      if (older) {
        const seen = new Set(state.chatLogs.map((m) => m.id))
        const add = items.filter((m) => !seen.has(m.id))
        state.chatLogs = add.concat(state.chatLogs)
        state.chatPage = Math.max(state.chatPage, page)
        state.chatHasNext = !!r.hasNext
      } else {
        // 第 1 页只做合并，不把已经翻出来的更早消息冲掉
        const map = new Map(state.chatLogs.map((m) => [m.id, m]))
        for (const m of items) map.set(m.id, m)
        state.chatLogs = Array.from(map.values())
        if (!state.chatInitialized) {
          state.chatInitialized = true
          state.chatPage = 1
          state.chatHasNext = !!r.hasNext
        }
        // 已经翻到更早的页时，别用第 1 页的 hasNext 把按钮关掉
      }

      if (state.chatLogs.length > CONFIG.chatKeepMax) {
        state.chatLogs = state.chatLogs.slice(-CONFIG.chatKeepMax)
      }

      await ensureProfiles(collectUids())
      renderChat(keep ? { keep } : undefined)
    } catch (e) {
      if (e.status !== 401 && e.status !== 429 && e.code !== 'network' && e.code !== 'timeout') {
        showError(e)
      }
    } finally {
      state.chatLoading = false
      state.chatLoadingOlder = false
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 定时循环
  // ─────────────────────────────────────────────────────────────
  function loop(fn, ms) {
    let stopped = false
    let timer = null
    const tick = async () => {
      if (stopped) return
      try { await fn() } catch (e) { /* 单个失败不结束循环 */ }
      if (!stopped) timer = setTimeout(tick, ms)
    }
    timer = setTimeout(tick, ms)
    return function stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }

  function stopLoops() {
    state.loops.forEach((stop) => { try { stop() } catch (e) { /* 忽略 */ } })
    state.loops = []
  }

  function startLoops() {
    stopLoops()
    state.loops.push(loop(() => (document.hidden ? null : refreshLobby()), CONFIG.pollMs))
    state.loops.push(loop(() => (document.hidden ? null : heartbeat()), CONFIG.heartbeatMs))
    state.loops.push(loop(() => (document.hidden ? null : refreshHomes()), CONFIG.homeRefreshMs))
  }

  function renderAll() {
    renderConnection()
    renderPlayers()
    renderChat()
    renderBoss()
    renderHomeBoard()
    renderRoomInfo()
    renderMe()
    renderReqs()
    renderClaims()
    renderRaw()
  }

  // ─────────────────────────────────────────────────────────────
  // 界面：连接状态 / 标签
  // ─────────────────────────────────────────────────────────────
  function showGuest() {
    $('viewGuest').classList.remove('xm-hidden')
    $('viewGame').classList.add('xm-hidden')
    $('app').setAttribute('data-mode', 'guest')
    showAuthBanner(false)
    stopLoops()
  }

  function showGame() {
    $('viewGuest').classList.add('xm-hidden')
    $('viewGame').classList.remove('xm-hidden')
    $('app').setAttribute('data-mode', 'game')
    showAuthBanner(false)
    switchTab(state.tab || 'lobby')
  }

  function showLoading(on) {
    const node = $('gameLoading')
    if (node) node.classList.toggle('xm-hidden', !on)
  }

  function showAuthBanner(on) {
    const node = $('authBanner')
    if (node) node.classList.toggle('xm-hidden', !on)
  }

  function renderConnection() {
    const s = session()
    const connected = !!s && !state.authLost
    const dot = $('vState')
    if (dot) {
      dot.textContent = connected ? '已连接' : (state.authLost ? '需要重新申请' : '未连接')
      dot.className = connected ? 'xm-live xm-live--on' : 'xm-live'
    }
    const uid = state.myUid || (s && s.uid) || '—'
    if ($('vUid')) $('vUid').textContent = uid
    if ($('meUid')) $('meUid').textContent = uid
    if ($('meName')) $('meName').textContent = nickname(uid)
    if ($('meAvatar')) paintAvatar($('meAvatar'), uid, 'demo-avatar__img')
    updateCountdown()
    renderReqs()
  }

  function setText(node, value) {
    if (node && node.textContent !== value) node.textContent = value
  }

  // 凭证总时长：JWT 里的 exp - iat。本地算，不发请求。
  let tokenLifetimeCache = { jwt: '', ms: 0 }
  function tokenLifetimeMs() {
    const s = session()
    if (!s || !s.jwt) return 0
    if (tokenLifetimeCache.jwt === s.jwt) return tokenLifetimeCache.ms
    const claims = decodeClaims(s.jwt)
    const ms = claims && claims.iat && claims.exp
      ? Math.max(1, (claims.exp - claims.iat) * 1000)
      : 0
    tokenLifetimeCache = { jwt: s.jwt, ms }
    return ms
  }

  /** 有效期进度条。数值来自本地时钟，每 200ms 走一格，带 CSS transition 平滑。 */
  function updateTokenBar(left) {
    const bar = $('vTokenBar')
    if (!bar) return
    const total = tokenLifetimeMs()
    const pct = state.online && total > 0
      ? Math.max(0, Math.min(100, (left / total) * 100))
      : 0
    const width = pct.toFixed(2) + '%'
    if (bar.style.width !== width) bar.style.width = width
    bar.classList.toggle('is-warn', state.online && left > 0 && left < 5 * 60 * 1000)
  }

  function updateCountdown() {
    const left = (typeof XMETA !== 'undefined' && state.online) ? XMETA.getRemainingMs() : 0
    const text = state.online ? fmtLeft(left) : '—'
    setText($('vLeft'), text)
    setText($('meLeft'), text)
    const warn = state.online && left > 0 && left < 5 * 60 * 1000
    if ($('vLeft')) $('vLeft').classList.toggle('is-warn', warn)
    updateTokenBar(left)
    if (state.online && left <= 0 && !state.authLost) handleAuthLost()
    updateActionButtons()
  }

  /**
   * UI 时钟：每 200ms 看一次本地时间。
   *
   * **和心跳 / 轮询无关** —— 剩余时间只来自凭证的 exp 和 Date.now()。
   * 以前用 setInterval(1000) 刷文本，定时器漂移会偶尔跳秒；现在按「显示值
   * 真的变了」才写 DOM，进度条则每 200ms 连续走，所以看起来是平滑的。
   */
  let tickerStarted = false
  let lastTickerKey = ''

  function tickerTick() {
    const left = (typeof XMETA !== 'undefined' && state.online) ? XMETA.getRemainingMs() : 0
    updateTokenBar(left)

    const key = state.online ? String(Math.floor(left / 1000)) : 'off'
    if (key !== lastTickerKey) {
      lastTickerKey = key
      updateCountdown()
    } else {
      updateActionButtons()
    }
  }

  function startTicker() {
    if (tickerStarted) return
    tickerStarted = true
    tickerTick()
    setInterval(tickerTick, 200)
  }

  function switchTab(tab) {
    const known = ['lobby', 'boss', 'me', 'debug']
    state.tab = known.indexOf(tab) >= 0 ? tab : 'lobby'
    document.querySelectorAll('[data-tab-btn]').forEach((btn) => {
      const on = btn.getAttribute('data-tab-btn') === state.tab
      btn.classList.toggle('is-active', on)
      btn.setAttribute('aria-selected', on ? 'true' : 'false')
    })
    document.querySelectorAll('[data-tab-panel]').forEach((panel) => {
      panel.classList.toggle('xm-hidden', panel.getAttribute('data-tab-panel') !== state.tab)
    })
    if (state.tab === 'boss') {
      renderBoss()
      refreshDamage(false).catch(() => {})
    }
    if (state.tab === 'me') {
      renderMe()
      if (state.started) refreshMyLogs().catch(() => { /* 日志不是关键路径 */ })
    }
    if (state.tab === 'debug') {
      renderReqs()
      renderClaims()
      renderRaw()
    }
    try { history.replaceState(null, '', '#' + state.tab) } catch (e) { /* 忽略 */ }
  }

  // ─────────────────────────────────────────────────────────────
  // 界面：大厅
  // ─────────────────────────────────────────────────────────────
  function nickname(uid) {
    const key = String(uid)
    const p = state.profiles.get(key)
    return (p && p.nickname) || ('玩家 ' + key)
  }

  function paintAvatar(node, uid, imgClass) {
    if (!node) return
    const key = String(uid || '')
    const p = state.profiles.get(key)
    clear(node)
    if (p && p.avatar) {
      const img = document.createElement('img')
      img.className = imgClass || ''
      img.src = p.avatar
      img.alt = ''
      img.referrerPolicy = 'no-referrer'   // B站 CDN 的图
      img.loading = 'lazy'
      img.onerror = function () {
        clear(node)
        node.textContent = (p.nickname || key || '?').slice(0, 1)
      }
      node.appendChild(img)
    } else {
      node.textContent = (p && p.nickname ? p.nickname : (key || '?')).slice(0, 1)
    }
  }

  function renderPlayers() {
    const box = $('playerList')
    if (!box) return
    const { online } = parseLogs()
    const list = Array.from(online.entries())
      .sort((a, b) => {
        if (a[0] === state.myUid) return -1
        if (b[0] === state.myUid) return 1
        return b[1] - a[1]
      })

    if ($('onlineCount')) $('onlineCount').textContent = String(list.length)
    clear(box)

    if (!list.length) {
      box.appendChild(el('p', 'xm-empty', '大厅里还没有人。等一会儿，或者叫朋友一起进来。'))
      return
    }

    for (const [uid, at] of list) {
      const card = el('div', 'demo-player')
      if (uid === state.myUid) card.classList.add('is-me')

      const avatar = el('div', 'demo-player__avatar')
      paintAvatar(avatar, uid, 'demo-player__img')

      const main = el('div', 'demo-player__main')
      const nameRow = el('div', 'demo-player__name')
      nameRow.appendChild(el('b', null, nickname(uid)))
      if (uid === state.myUid) nameRow.appendChild(el('span', 'demo-tag', '我'))
      main.appendChild(nameRow)
      main.appendChild(el('span', 'demo-player__uid', 'uid ' + uid))

      const home = state.homes.get(uid)
      const theme = home && home.text2 && THEMES[home.text2] ? THEMES[home.text2] : null
      const meta = el('span', 'demo-player__meta',
        (theme ? theme.emoji + ' ' + theme.name : '还没有小窝') +
        (home ? ' · 被串门 ' + fmtNum(home.tagInt1) + ' 次' : '') +
        ' · ' + fmtAgo(new Date(at).toISOString()))
      main.appendChild(meta)

      card.appendChild(avatar)
      card.appendChild(main)

      if (uid !== state.myUid) {
        if (home) {
          const btn = el('button', 'xm-btn xm-btn--ghost xm-btn--sm demo-player__visit', '串门')
          btn.addEventListener('click', () => openHome(uid))
          card.appendChild(btn)
        } else {
          card.appendChild(el('span', 'demo-player__nohome', '还没建窝'))
        }
      }

      box.appendChild(card)
    }
  }

  // ── 串门：真打开对方的小窝看一眼 ──────────────────────────
  let visitBusy = false

  function openHomeModal() {
    closeModal()           // 和「什么是 xmeta」互斥
    const node = $('homeModal')
    if (node) node.classList.remove('xm-hidden')
  }

  function closeHomeModal() {
    const node = $('homeModal')
    if (node) node.classList.add('xm-hidden')
  }

  function renderHomeModal(uid, home) {
    const key = String(uid)
    if ($('homeModalName')) $('homeModalName').textContent = nickname(key)
    if ($('homeModalUid')) $('homeModalUid').textContent = 'uid ' + key
    if ($('homeModalAvatar')) paintAvatar($('homeModalAvatar'), key, 'demo-home-modal__img')

    const theme = (home && THEMES[home.text2]) || { emoji: '🏠', name: '小窝' }
    if ($('homeModalEmoji')) $('homeModalEmoji').textContent = theme.emoji
    if ($('homeModalTheme')) $('homeModalTheme').textContent = theme.name
    if ($('homeModalMotto')) $('homeModalMotto').textContent = (home && home.text1) || '欢迎来坐坐'
    if ($('homeModalVisits')) $('homeModalVisits').textContent = fmtNum(home ? home.tagInt1 : 0)
  }

  function setHomeModalVisits(n) {
    const node = $('homeModalVisits')
    if (!node) return
    node.textContent = fmtNum(n)
    // 数字弹一下，让「+1」这件事看得见
    node.classList.remove('is-pop')
    void node.offsetWidth
    node.classList.add('is-pop')
  }

  /**
   * 串门：先把对方的小窝信息弹出来，再把「被串门次数」+1。
   *
   * 次数用 PATCH 的返回值更新本地，并用 updatedAt 挡住随后那份旧的列表缓存 ——
   * 否则会看到「先变 1、又被刷回 0」。
   */
  async function openHome(uid) {
    if (!state.online || visitBusy) return
    const key = String(uid)
    const home = state.homes.get(key) || (key === state.myUid ? state.home : null)
    if (!home && key !== state.myUid) {
      showToast('对方还没布置小窝')
      return
    }

    visitBusy = true
    renderHomeModal(key, home)
    openHomeModal()

    try {
      if (key === state.myUid) return
      const r = await api('PATCH', kvPath(CONFIG.homeScope, key), { inc: { tagInt1: 1 } })
      if (r.data) {
        const merged = newerRow(state.homes.get(key), r.data)
        state.homes.set(key, merged)
        if (key === state.myUid) state.home = merged
        setHomeModalVisits(merged.tagInt1)
        renderPlayers()
        renderHomeBoard()
      }
    } catch (e) {
      if (e.code === 'not_found') {
        showToast('对方还没布置小窝')
      } else {
        showError(e)
      }
    } finally {
      visitBusy = false
    }
  }

  function renderHomeBoard() {
    const box = $('homeBoard')
    if (!box) return
    const rows = Array.from(state.homes.values())
      .sort((a, b) => (Number(b.tagInt1) || 0) - (Number(a.tagInt1) || 0))
      .slice(0, 5)

    clear(box)
    if (!rows.length) {
      box.appendChild(el('p', 'xm-empty', '还没有人布置小窝。去「我的」里挑一个主题吧。'))
      return
    }

    rows.forEach((row, i) => {
      const uid = String(row.uid)
      const theme = THEMES[row.text2] || { emoji: '🏠', name: '小窝' }
      const item = el('div', 'demo-home-row')
      item.appendChild(el('span', 'demo-home-row__rank', String(i + 1)))
      const avatar = el('div', 'demo-home-row__avatar')
      paintAvatar(avatar, uid, 'demo-home-row__img')
      item.appendChild(avatar)
      const main = el('div', 'demo-home-row__main')
      main.appendChild(el('b', null, nickname(uid) + ' 的' + theme.name))
      main.appendChild(el('span', 'demo-home-row__meta', theme.emoji + ' 被串门 ' + fmtNum(row.tagInt1) + ' 次'))
      item.appendChild(main)
      if (uid !== state.myUid) {
        const btn = el('button', 'xm-btn xm-btn--quiet xm-btn--sm', '去看看')
        btn.addEventListener('click', () => openHome(uid))
        item.appendChild(btn)
      }
      box.appendChild(item)
    })
  }

  function renderRoomInfo() {
    if (!$('roomInfo')) return
    if (!state.room || !state.lobbyHost) {
      $('roomInfo').textContent = '正在找大厅…'
      return
    }
    const mine = state.lobbyHost === state.myUid
    $('roomInfo').textContent =
      (mine ? '这间大厅是你开的' : '大厅房主 uid ' + state.lobbyHost) +
      ' · 每 ' + Math.round(CONFIG.pollMs / 1000) + ' 秒同步 · 在线看心跳'
  }

  // 聊天区
  let chatAutoscroll = true

  function renderChat(opts) {
    const box = $('chatList')
    if (!box) return

    const chat = state.chatLogs
    // 刚发出去、日志还没轮询到的消息先在本地顶上，等日志里出现同一条就撤掉
    const stillPending = state.pendingChat.filter((p) => !chat.some(
      (m) => m.uid === p.uid && m.text === p.text
    ))
    state.pendingChat = stillPending
    const merged = chat.concat(stillPending)
      .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
    const shown = merged.slice(-CONFIG.chatKeepMax)

    const prevHeight = box.scrollHeight
    const prevTop = box.scrollTop
    const nearBottom = prevHeight - prevTop - box.clientHeight < 60
    clear(box)

    if (!shown.length) {
      box.appendChild(el('p', 'xm-empty', '还没有人说话。发一句试试？'))
    } else {
      // 每条都带头像和昵称。同一个人连发两条也各自显示，不做「省略头像」的合并。
      for (const m of shown) {
        const row = el('div', 'demo-msg' + (m.uid === state.myUid ? ' is-me' : ''))
        const avatar = el('div', 'demo-msg__avatar')
        paintAvatar(avatar, m.uid, 'demo-msg__img')
        row.appendChild(avatar)

        const body = el('div', 'demo-msg__body')
        const head = el('div', 'demo-msg__head')
        head.appendChild(el('b', null, nickname(m.uid)))
        head.appendChild(el('span', null, fmtAgo(m.at)))
        body.appendChild(head)
        body.appendChild(el('p', 'demo-msg__text', m.text))
        row.appendChild(body)
        box.appendChild(row)
      }
    }

    if (opts && opts.keep) {
      // 往上翻历史：保持用户当前看到的位置，别一跳到底
      box.scrollTop = box.scrollHeight - opts.keep.height + opts.keep.top
    } else if (nearBottom || chatAutoscroll) {
      box.scrollTop = box.scrollHeight
    }
    chatAutoscroll = false

    const older = $('btnOlderChat')
    if (older) {
      older.classList.toggle('xm-hidden', !(state.chatHasNext || state.chatLoadingOlder))
      older.textContent = state.chatLoadingOlder ? '加载中…' : '加载更早的消息'
      older.disabled = state.chatLoadingOlder
    }

    if ($('chatHint')) {
      $('chatHint').textContent = state.lastLogAt
        ? '每 ' + Math.round(CONFIG.pollMs / 1000) + ' 秒同步 · 历史从改动日志里读'
        : '正在连接…'
    }
  }

  async function sendChat(text) {
    if (!state.online || !state.lobbyHost) return false
    const msg = text.trim()
    if (!msg) return false
    const btn = $('btnSend')
    if (btn) btn.disabled = true
    try {
      const r = await api('PATCH', kvPath(CONFIG.lobbyScope, state.lobbyHost), { text1: msg })
      if (r.modified === false) {
        showToast('和上一条一模一样，xmeta 不会记重复改动')
        return false
      }
      if (r.data) setRoom(r.data)
      state.pendingChat.push({ id: 'local-' + Date.now(), uid: state.myUid, text: msg, at: new Date().toISOString() })
      renderChat()
      await loadChat(1, false)
      await refreshLobby()
      return true
    } catch (e) {
      showError(e)
      return false
    } finally {
      if (btn) btn.disabled = false
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 界面：世界 Boss
  // ─────────────────────────────────────────────────────────────
  function bossMax() {
    const n = state.room && state.room.extra && Number(state.room.extra.bossMax)
    return Number.isFinite(n) && n > 0 ? n : CONFIG.bossMaxHp
  }

  function bossHp() {
    const n = state.room ? Number(state.room.tagInt2) : NaN
    return Number.isFinite(n) ? n : bossMax()
  }

  function renderBoss() {
    const hp = bossHp()
    const max = bossMax()
    const shown = clamp(hp, 0, max)
    const pct = max > 0 ? (shown / max) * 100 : 0
    const dead = hp <= 0

    if ($('hpNow')) $('hpNow').textContent = fmtNum(shown)
    if ($('hpMax')) $('hpMax').textContent = fmtNum(max)
    if ($('hpBar')) {
      $('hpBar').style.width = pct + '%'
      $('hpBar').className = pct <= 10 ? 'is-low' : (pct <= 30 ? 'is-warn' : '')
    }
    if ($('bossFace')) $('bossFace').textContent = dead ? '💀' : '👹'
    const bossCard = $('bossCard')
    if (bossCard) bossCard.classList.toggle('is-dead', dead)
    if ($('btnResetBoss')) $('btnResetBoss').classList.toggle('xm-hidden', !dead)
    if ($('bossHint')) {
      // 说清楚这条血量在谁名下：世界 Boss 是「所有人写同一条公共数据」，
      // 不是谁把谁的背包改了。开放字段之外的东西（背包、小窝）碰不到。
      const mine = state.lobbyHost === state.myUid
      const owner = state.lobbyHost
        ? '公共血量在这间大厅的数据里（' + (mine ? '你自己的 uid ' : '房主 uid ') +
          state.lobbyHost + '），所有人只能改开放的血量字段。'
        : ''
      $('bossHint').textContent = owner + (dead
        ? 'Boss 倒下了，点「重置 Boss」让它满血复活。伤害榜是累计的，不会清零。'
        : '每次攻击都是一次 inc 原子扣血 —— 多少人同时点都不会丢伤害。')
    }

    updateActionButtons()
    renderBoard()
  }

  function renderBoard() {
    const box = $('board')
    if (!box) return

    // 一人一条公开的 damage 数据；按累计伤害从高到低。列表接口已经按
    // tagInt2 排好序（?sort=tagInt2&order=desc），这里再排一次不影响。
    const rows = Array.from(state.damageRows.values())
      .filter((r) => Number(r.tagInt2) > 0)
      .sort((a, b) => (Number(b.tagInt2) || 0) - (Number(a.tagInt2) || 0))
      .slice(0, 8)

    if ($('boardHint')) {
      // 血量这轮掉的和榜上的累计是两回事：重置 Boss 只回血，榜不清零
      const dealt = Math.max(0, bossMax() - clamp(bossHp(), 0, bossMax()))
      $('boardHint').textContent = '本轮 Boss 已掉 ' + fmtNum(dealt)
    }

    clear(box)
    if (!rows.length) {
      box.appendChild(el('p', 'xm-empty', '还没有人出手。打一下就会记在自己那条伤害数据上。'))
      return
    }

    rows.forEach((r, i) => {
      const uid = String(r.uid)
      const dmg = Number(r.tagInt2) || 0
      const row = el('li', 'demo-board__row' + (uid === state.myUid ? ' is-me' : ''))
      row.appendChild(el('span', 'demo-board__rank', ['🥇', '🥈', '🥉'][i] || String(i + 1)))
      const avatar = el('div', 'demo-board__avatar')
      paintAvatar(avatar, uid, 'demo-board__img')
      row.appendChild(avatar)
      row.appendChild(el('span', 'demo-board__name', nickname(uid)))
      row.appendChild(el('b', 'demo-board__dmg', '-' + fmtNum(dmg)))
      box.appendChild(row)
    })
  }

  // ── 按钮冷却 ──────────────────────────────────────────────
  function cooldownLeft(key) {
    return Math.max(0, (state.cooldowns[key] || 0) - Date.now())
  }

  function beginCooldown(key) {
    state.cooldowns[key] = Date.now() + CONFIG.actionCooldownMs
    updateActionButtons()
  }

  function cooldownBlocked(key, label) {
    const left = cooldownLeft(key)
    if (left > 0) {
      if (label) showToast(label + '还要等 ' + Math.ceil(left / 1000) + ' 秒')
      return true
    }
    return false
  }

  /**
   * 攻击 / 打工 / 捡道具：请求在飞的时候禁用；冷却期间按钮**不置灰**，
   * 但文字显示还剩几秒，点下去只会提示「还要等 N 秒」，不会发请求。
   *
   * 不靠定时器把 disabled 改回来 —— 页面切到后台时定时器会被节流，
   * 按钮可能一直灰着。冷却判断以时间戳为准，点一下就知道能不能动。
   */
  function setButton(btn, disabled, text) {
    if (!btn) return
    if (btn.disabled !== disabled) btn.disabled = disabled
    if (btn.textContent !== text) btn.textContent = text
  }

  function updateActionButtons() {
    const online = state.online && !state.authLost

    const attackLeft = cooldownLeft('attack')
    setButton(
      $('btnAttack'),
      !online || bossHp() <= 0 || state.busy.attack,
      state.busy.attack
        ? '攻击中…'
        : (attackLeft > 0 ? '攻击（' + Math.ceil(attackLeft / 1000) + 's）' : '攻击')
    )

    const workLeft = cooldownLeft('work')
    setButton(
      $('btnWork'),
      !online || state.busy.work,
      state.busy.work
        ? '打工中…'
        : (workLeft > 0 ? '打工（' + Math.ceil(workLeft / 1000) + 's）' : '打工 +金币')
    )

    const findLeft = cooldownLeft('find')
    setButton(
      $('btnFind'),
      !online || state.busy.find,
      state.busy.find
        ? '翻找中…'
        : (findLeft > 0 ? '捡道具（' + Math.ceil(findLeft / 1000) + 's）' : '捡一件道具')
    )
  }

  /** 把自己这一刀的伤害写进 damage 那条（一人一条，只加自己的） */
  async function addMyDamage(dmg) {
    const body = { inc: { tagInt2: dmg }, ttl: 30 * 24 * 3600 }
    try {
      const r = await api('PATCH', kvPath(CONFIG.damageScope), body)
      if (r.data) {
        state.myDamage = r.data
        state.damageRows.set(state.myUid, r.data)
      }
    } catch (e) {
      if (e.code !== 'not_found') throw e
      // 过期或被删了：重建一条再记
      await ensureDamage()
      const r = await api('PATCH', kvPath(CONFIG.damageScope), body)
      if (r.data) {
        state.myDamage = r.data
        state.damageRows.set(state.myUid, r.data)
      }
    }
  }

  async function attack() {
    if (!state.online || !state.lobbyHost || state.busy.attack) return
    if (bossHp() <= 0) return
    if (cooldownBlocked('attack', '攻击')) return

    state.busy.attack = true
    updateActionButtons()

    const base = 20 + Math.floor(Math.random() * 41)
    const crit = Math.random() < 0.15
    const dmg = crit ? base * 3 : base

    try {
      // ① 公共血量：inc 原子扣血
      const r = await api('PATCH', kvPath(CONFIG.lobbyScope, state.lobbyHost), {
        inc: { tagInt2: -dmg }
      })
      if (r.data) setRoom(r.data)

      // ② 自己的伤害：单独一条，只加不加别人的
      try {
        await addMyDamage(dmg)
      } catch (e) {
        showError('Boss 血量扣了，但这一刀没记进伤害榜：' + (e.message || e))
      }

      floatDamage(dmg, crit)
      renderBoss()
      refreshDamage(true).catch(() => {})
      beginCooldown('attack')
      await refreshLobby()
    } catch (e) {
      showError(e)
    } finally {
      state.busy.attack = false
      updateActionButtons()
    }
  }

  /**
   * 危险动作点两下确认。
   *
   * 不用 window.confirm：toy 页面跑在 iframe 里，sandbox 不一定给 allow-modals，
   * 被拦掉时 confirm 会静默返回 false，按钮看起来就像坏了。
   */
  function armButton(btn, confirmLabel, action, ms) {
    if (!btn) { action(); return }
    if (btn.getAttribute('data-armed') === '1') {
      btn.removeAttribute('data-armed')
      btn.textContent = btn.getAttribute('data-label') || '确定'
      action()
      return
    }
    btn.setAttribute('data-label', btn.textContent)
    btn.setAttribute('data-armed', '1')
    btn.textContent = confirmLabel
    setTimeout(() => {
      if (btn.getAttribute('data-armed') === '1') {
        btn.removeAttribute('data-armed')
        btn.textContent = btn.getAttribute('data-label') || '确定'
      }
    }, ms || 4000)
  }

  async function resetBoss() {
    if (!state.online || !state.lobbyHost) return
    armButton($('btnResetBoss'), '再点一次确认重置', async () => {
      try {
        const r = await api('PATCH', kvPath(CONFIG.lobbyScope, state.lobbyHost), {
          tagInt2: bossMax()
        })
        if (r.data) setRoom(r.data)
        renderBoss()
        showToast('Boss 满血复活了（伤害榜累计保留）')
        await refreshLobby()
      } catch (e) {
        showError(e)
      }
    })
  }

  function floatDamage(dmg, crit) {
    const layer = $('dmgFloat')
    if (!layer) return
    const node = el('span', 'demo-dmg__num' + (crit ? ' is-crit' : ''), '-' + dmg)
    layer.appendChild(node)
    setTimeout(() => { if (node.parentNode) node.parentNode.removeChild(node) }, 1000)
  }

  // ─────────────────────────────────────────────────────────────
  // 界面：我的
  // ─────────────────────────────────────────────────────────────
  function renderMe() {
    if (!state.myUid) return
    if ($('meName')) $('meName').textContent = nickname(state.myUid)
    if ($('meUid')) $('meUid').textContent = state.myUid
    if ($('meAvatar')) paintAvatar($('meAvatar'), state.myUid, 'demo-avatar__img')
    if ($('meBigAvatar')) paintAvatar($('meBigAvatar'), state.myUid, 'demo-me__img')
    updateCountdown()

    // 背包
    const bag = state.bag
    if ($('gold')) $('gold').textContent = bag ? fmtNum(bag.tagInt2) : '—'
    const itemsBox = $('bagItems')
    if (itemsBox) {
      clear(itemsBox)
      const items = (bag && bag.extra && Array.isArray(bag.extra.items)) ? bag.extra.items : []
      if (!items.length) {
        itemsBox.appendChild(el('p', 'xm-empty', '背包空空的。点下面「捡一件道具」。'))
      } else {
        for (const it of items) {
          const chip = el('span', 'demo-item')
          chip.appendChild(el('span', 'demo-item__emoji', it.emoji || '📦'))
          chip.appendChild(el('span', null, it.name || it.id || '道具'))
          itemsBox.appendChild(chip)
        }
      }
    }

    // 小窝
    const home = state.home
    const themeKey = state.homeDirty ? state.homeTheme : (home && THEMES[home.text2] ? home.text2 : 'sakura')
    state.homeTheme = themeKey
    const theme = THEMES[themeKey] || THEMES.sakura
    if ($('homePreview')) {
      clear($('homePreview'))
      $('homePreview').appendChild(el('span', 'demo-home-preview__emoji', theme.emoji))
      const text = el('div', 'demo-home-preview__text')
      text.appendChild(el('b', null, theme.name))
      text.appendChild(el('span', null, (home && home.text1) || '欢迎来坐坐'))
      $('homePreview').appendChild(text)
    }
    if ($('homeMotto') && document.activeElement !== $('homeMotto') && !state.homeDirty) {
      $('homeMotto').value = (home && home.text1) || ''
    }
    if ($('homeVisits')) $('homeVisits').textContent = fmtNum(home ? home.tagInt1 : 0)
    renderThemeChips()

    // 调试信息
    renderClaims()
    renderRaw()
  }

  function renderThemeChips() {
    const box = $('themeChips')
    if (!box) return
    clear(box)
    Object.keys(THEMES).forEach((key) => {
      const t = THEMES[key]
      const btn = el('button', 'demo-chip' + (key === state.homeTheme ? ' is-active' : ''), t.emoji + ' ' + t.name)
      btn.type = 'button'
      btn.addEventListener('click', () => {
        state.homeTheme = key
        state.homeDirty = true
        renderMe()
      })
      box.appendChild(btn)
    })
  }

  async function saveHome() {
    if (!state.online) return
    const motto = ($('homeMotto') && $('homeMotto').value || '').trim() || '欢迎来坐坐'
    const themeKey = THEMES[state.homeTheme] ? state.homeTheme : 'sakura'
    const theme = THEMES[themeKey]
    try {
      const r = await api('PATCH', kvPath(CONFIG.homeScope), {
        text1: motto,
        text2: themeKey,
        extra: { theme: themeKey, emoji: theme.emoji }
      })
      if (r.data) {
        state.home = r.data
        state.homes.set(state.myUid, r.data)
      }
      state.homeDirty = false
      renderMe()
      renderPlayers()
      renderHomeBoard()
      showToast('小窝已保存')
    } catch (e) {
      showError(e)
    }
  }

  async function work() {
    if (!state.online || state.busy.work) return
    if (cooldownBlocked('work', '打工')) return

    state.busy.work = true
    updateActionButtons()
    try {
      const gain = 10 + Math.floor(Math.random() * 21)
      const r = await api('PATCH', kvPath(CONFIG.bagScope), { inc: { tagInt2: gain } })
      if (r.data) state.bag = r.data
      renderMe()
      showToast('打工赚到 ' + gain + ' 金币')
      beginCooldown('work')

      // 三成概率顺手捡到一件东西。extra 是整块覆盖，只改自己这条，不用担心别人。
      if (Math.random() < 0.3) await findItem(true)
    } catch (e) {
      showError(e)
    } finally {
      state.busy.work = false
      updateActionButtons()
    }
  }

  async function findItem(silent) {
    if (!state.online || state.busy.find) return
    if (cooldownBlocked('find', silent ? '' : '捡道具')) return

    state.busy.find = true
    if (!silent) updateActionButtons()
    try {
      const bag = state.bag || { extra: {} }
      const extra = Object.assign({}, bag.extra || {})
      const items = Array.isArray(extra.items) ? extra.items.slice() : []
      if (items.length >= 12) {
        if (!silent) showToast('背包最多放 12 件，先清一清吧')
        return
      }
      const pick = ITEMS[Math.floor(Math.random() * ITEMS.length)]
      items.push({ id: pick.id + '-' + Date.now(), emoji: pick.emoji, name: pick.name })
      extra.items = items
      extra.lastFoundAt = new Date().toISOString()
      const r = await api('PATCH', kvPath(CONFIG.bagScope), { extra })
      if (r.data) state.bag = r.data
      renderMe()
      beginCooldown('find')
      if (!silent) showToast('捡到了 ' + pick.emoji + ' ' + pick.name)
    } catch (e) {
      showError(e)
    } finally {
      state.busy.find = false
      updateActionButtons()
    }
  }

  async function clearBag() {
    if (!state.online) return
    armButton($('btnClearBag'), '再点一次，真的删掉', async () => {
      try {
        await api('DELETE', '/api/kv/' + encodeURIComponent(CONFIG.bagScope) + '/' + encodeURIComponent(state.myUid))
        state.bag = null
        await ensureBag()
        renderMe()
        showToast('背包清空了')
      } catch (e) {
        showError(e)
      }
    })
  }

  async function refreshMyLogs() {
    if (!state.online || !state.myUid) return
    try {
      const [bagLog, homeLog] = await Promise.all([
        api('GET', logPath(CONFIG.bagScope, state.myUid, 10)),
        api('GET', logPath(CONFIG.homeScope, state.myUid, 10))
      ])
      const rows = []
      for (const e of (bagLog.items || [])) rows.push(Object.assign({ _scope: '背包' }, e))
      for (const e of (homeLog.items || [])) rows.push(Object.assign({ _scope: '小窝' }, e))
      rows.sort((a, b) => {
        const ta = new Date(a.createdAt).getTime() || 0
        const tb = new Date(b.createdAt).getTime() || 0
        return tb - ta
      })
      state.myLogs = rows.slice(0, 10)
      renderMyLogs()
    } catch (e) {
      if (e.status !== 401 && e.status !== 429 && e.code !== 'network' && e.code !== 'timeout') showError(e)
    }
  }

  function describeLog(e) {
    const scope = e._scope
    const changed = Array.isArray(e.changed) ? e.changed : []
    const before = e.before || {}
    const after = e.after || {}

    if (e.action === 'create') return '建好了' + scope
    if (changed.indexOf('expiresAt') >= 0 && changed.length === 1) return '续期了' + scope
    if (changed.indexOf('tagInt1') >= 0 && scope === '小窝') {
      const b = Number(before.tagInt1) || 0
      const a = Number(after.tagInt1) || 0
      if (a > b) return '被串门 +' + (a - b)
    }
    if (changed.indexOf('tagInt2') >= 0 && scope === '背包') {
      const b = Number(before.tagInt2) || 0
      const a = Number(after.tagInt2) || 0
      return '金币 ' + fmtNum(b) + ' → ' + fmtNum(a)
    }
    if (changed.indexOf('text1') >= 0 && scope === '小窝') {
      return '门牌改成「' + String(after.text1 || '') + '」'
    }
    if (changed.indexOf('extra') >= 0) return '更新了' + scope + '里的道具/装扮'
    return '改了' + (changed.length ? changed.join('、') : '一些东西')
  }

  function renderMyLogs() {
    const box = $('myLogs')
    if (!box) return
    clear(box)
    if (!state.myLogs.length) {
      box.appendChild(el('p', 'xm-empty', '还没有改动记录。'))
      return
    }
    for (const e of state.myLogs) {
      const row = el('div', 'demo-log')
      const who = e.actorUid && String(e.actorUid) !== state.myUid
        ? nickname(e.actorUid)
        : '我'
      row.appendChild(el('span', 'demo-log__who', who))
      row.appendChild(el('span', 'demo-log__what', (e._scope || '') + ' · ' + describeLog(e)))
      row.appendChild(el('span', 'demo-log__when', fmtAgo(e.createdAt)))
      box.appendChild(row)
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 界面：调试
  // ─────────────────────────────────────────────────────────────
  function renderReqs() {
    const box = $('reqList')
    if (!box) return
    clear(box)
    if (!state.reqs.length) {
      box.appendChild(el('p', 'xm-empty', '还没有请求。'))
      return
    }
    for (const r of state.reqs.slice(0, 30)) {
      const row = el('div', 'demo-req')
      const ok = r.status >= 200 && r.status < 300
      row.appendChild(el('span', 'demo-req__method', r.method))
      row.appendChild(el('span', 'demo-req__path', r.path))
      row.appendChild(el('span', 'demo-req__status' + (ok ? ' is-ok' : ' is-bad'),
        r.status ? String(r.status) : (r.code || 'ERR')))
      row.appendChild(el('span', 'demo-req__ms', r.ms + 'ms'))
      box.appendChild(row)
    }
  }

  function renderClaims() {
    const box = $('claims')
    if (!box) return
    const s = session()
    if (!s || !s.jwt) { box.textContent = '还没有凭证。'; return }
    const claims = decodeClaims(s.jwt)
    box.textContent = JSON.stringify({
      uid: s.uid,
      剩余: fmtLeft(XMETA.getRemainingMs()),
      payload: claims
    }, null, 2)
  }

  function renderRaw() {
    const box = $('rawData')
    if (!box) return
    box.textContent = JSON.stringify({
      lobbyHost: state.lobbyHost,
      lobby: state.room,
      bag: state.bag,
      home: state.home,
      damage: {
        mine: state.myDamage,
        rows: Array.from(state.damageRows.values()).slice(0, 20)
      },
      chat: {
        loaded: state.chatLogs.length,
        page: state.chatPage,
        hasNext: state.chatHasNext
      },
      onlineSeen: Array.from(parseLogs().online.keys()),
      logCount: state.logs.length
    }, null, 2)
  }

  // ─────────────────────────────────────────────────────────────
  // 提示 / 错误
  // ─────────────────────────────────────────────────────────────
  function showToast(msg, type) {
    const node = $('toast')
    if (!node) return
    node.textContent = msg
    node.className = 'demo-toast' + (type ? ' is-' + type : '')
    node.classList.remove('xm-hidden')
    if (state.toastTimer) clearTimeout(state.toastTimer)
    state.toastTimer = setTimeout(() => node.classList.add('xm-hidden'), 2600)
  }

  function showError(e, persistent) {
    const msg = typeof e === 'string' ? e : ((e && e.message) || String(e))
    const code = e && e.code ? ' [' + e.code + ']' : ''
    state.lastError = msg
    const node = $('errBox')
    if (!node) return
    node.textContent = msg + code
    node.classList.remove('xm-hidden')
    if (state.errTimer) clearTimeout(state.errTimer)
    if (!persistent) state.errTimer = setTimeout(() => node.classList.add('xm-hidden'), 9000)
  }

  function reportError(e, persistent) {
    if (!e) return
    if (e.status === 401) { handleAuthLost(); return }
    if (e.code === 'network') {
      // 网络抖动很常见，别拿它铺满整页；下一轮会自己重试
      if (state.tab === 'debug') showError(e)
      return
    }
    if (e.code === 'rate_limited') {
      showToast('请求有点快，缓一缓再试', 'warn')
      return
    }
    showError(e, persistent)
  }

  // ─────────────────────────────────────────────────────────────
  // 事件绑定
  // ─────────────────────────────────────────────────────────────
  function toyReady() {
    return typeof toy !== 'undefined' && toy && typeof toy.navigate === 'function'
  }

  function bind() {
    // 申请联机凭证 —— 必须在用户手势里同步调用 toy.navigate，中间不能 await
    $('btnLogin').addEventListener('click', () => {
      clearGuestErr()
      if (typeof XMETA === 'undefined') {
        showGuestError('xmeta-client.js 没加载。检查网络后刷新页面。')
        return
      }
      if (!toyReady()) {
        showGuestError('要在 B站 App 或 toy 页面里打开才能申请 —— 直接开网页没有 toy.navigate。')
        return
      }
      XMETA.login().catch((e) => {
        showGuestError('申请失败：' + (e.message || e))
      })
    })

    $('btnReauth').addEventListener('click', () => {
      if (typeof XMETA === 'undefined') return
      if (!toyReady()) {
        showError('要在 B站 App 或 toy 页面里打开才能重新申请。')
        return
      }
      XMETA.login().catch((e) => showError('申请失败：' + (e.message || e)))
    })
    $('btnReauthTop').addEventListener('click', () => {
      if (typeof XMETA === 'undefined') return
      if (!toyReady()) {
        showError('要在 B站 App 或 toy 页面里打开才能重新申请。')
        return
      }
      XMETA.login().catch((e) => showError('申请失败：' + (e.message || e)))
    })

    $('btnLogout').addEventListener('click', () => {
      if (typeof XMETA !== 'undefined') XMETA.logout()
      onSessionLost()
      showToast('本地凭证已清除')
    })

    document.querySelectorAll('[data-tab-btn]').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.getAttribute('data-tab-btn')))
    })

    $('chatForm').addEventListener('submit', async (e) => {
      e.preventDefault()
      const input = $('chatInput')
      const text = input.value
      input.value = ''
      const ok = await sendChat(text)
      if (!ok) input.value = text      // 没发出去就把话还回输入框
    })
    $('chatList').addEventListener('scroll', () => {
      const box = $('chatList')
      chatAutoscroll = box.scrollHeight - box.scrollTop - box.clientHeight < 60
    })
    $('btnOlderChat').addEventListener('click', () => {
      loadChat(state.chatPage + 1, true).catch(() => {})
    })

    $('btnAttack').addEventListener('click', attack)
    $('btnResetBoss').addEventListener('click', resetBoss)
    $('btnRefresh').addEventListener('click', () => {
      refreshLobby().catch(reportError)
      refreshHomes().catch(reportError)
      refreshDamage(true).catch(reportError)
      showToast('已刷新')
    })

    $('btnWork').addEventListener('click', work)
    $('btnFind').addEventListener('click', () => findItem(false))
    $('btnClearBag').addEventListener('click', clearBag)
    $('btnSaveHome').addEventListener('click', saveHome)
    $('homeMotto').addEventListener('input', () => { state.homeDirty = true })

    $('btnClearReq').addEventListener('click', () => {
      state.reqs = []
      renderReqs()
    })
    $('btnRebuildLobby').addEventListener('click', async () => {
      storageDel(LOBBY_HOST_KEY)
      state.lobbyHost = null
      state.room = null
      state.logs = []
      resetChat()
      try {
        await ensureLobby()
        await refreshLobby()
        refreshDamage(true).catch(() => {})
        showToast('换到另一间大厅了')
      } catch (e) { reportError(e, true) }
    })
    $('btnOwnLobby').addEventListener('click', () => {
      armButton($('btnOwnLobby'), '再点一次确认（会重置你自己的大厅）', createOwnLobby, 6000)
    })

    $('btnKnow').addEventListener('click', () => openModal())
    $('xmetaLink').addEventListener('click', () => openModal())
    document.querySelectorAll('[data-close-modal]').forEach((node) => {
      node.addEventListener('click', closeModal)
    })
    document.querySelectorAll('[data-close-home]').forEach((node) => {
      node.addEventListener('click', closeHomeModal)
    })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeModal()
        closeHomeModal()
      }
    })

    $('btnGoXmeta').addEventListener('click', () => {
      closeModal()
      const go = (typeof toy !== 'undefined' && toy.navigate)
        ? toy.navigate({ type: 'toy', id: CONFIG.centerToySlug, extra: {} })
        : Promise.reject(new Error('toy SDK 没加载'))
      go.catch((e) => {
        const url = location.protocol + '//www.bilibili.com/toy/' +
          encodeURIComponent(CONFIG.centerToySlug) + '/index.html'
        let opened = null
        try { opened = window.open(url, '_blank') } catch (err) { /* 忽略 */ }
        if (!opened) showToast('跳转没有成功：' + (e.message || e), 'warn')
      })
    })

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return
      tickerTick()   // 切回前台立刻对一次表，别等定时器
      if (!state.online || state.authLost) return
      heartbeat().catch(() => {})
      refreshLobby().catch(() => {})
    })

    // 本地 UI 时钟：倒计时和进度条，跟心跳 / 轮询完全无关
    startTicker()
  }

  function showGuestError(msg) {
    const node = $('guestErr')
    if (!node) return
    node.textContent = msg
    node.classList.remove('xm-hidden')
  }
  function clearGuestErr() {
    const node = $('guestErr')
    if (node) node.classList.add('xm-hidden')
  }

  function openModal() {
    closeHomeModal()
    const node = $('xmetaModal')
    if (node) node.classList.remove('xm-hidden')
  }
  function closeModal() {
    const node = $('xmetaModal')
    if (node) node.classList.add('xm-hidden')
  }

  // ─────────────────────────────────────────────────────────────
  // 启动
  // ─────────────────────────────────────────────────────────────
  function init() {
    bind()

    if (typeof XMETA === 'undefined') {
      showGuestError('xmeta-client.js 没加载 —— 检查网络后刷新页面。')
      return
    }

    try {
      XMETA.configure({
        apiBase: CONFIG.apiBase,
        centerToySlug: CONFIG.centerToySlug,
        centerToyId: CONFIG.centerToyId,
        clientId: CONFIG.clientId
      })
    } catch (e) {
      showGuestError('初始化失败：' + (e.message || e))
      return
    }

    // 有会话时 onSession 会立刻回调（包括从 localStorage 恢复）
    XMETA.onSession((s) => {
      if (s) onSessionGained(s)
      else onSessionLost()
    })

    // 从中心 toy 回来时，SDK 检测到授权码就通知这里。直接兑换 —— 只有一个
    // 页面实例能成功，输的那个 SDK 会采纳赢家写下的会话。
    if (typeof XMETA.onCodeReady === 'function') {
      XMETA.onCodeReady(async () => {
        clearGuestErr()
        try {
          await XMETA.completeLogin()
        } catch (e) {
          showGuestError('兑换凭证失败：' + (e.message || e) + '（刷新页面可重试）')
        }
      })
    } else {
      showGuestError('xmeta-client.js 还是旧版本（没有 onCodeReady），请强制刷新页面。')
    }

    // 进来先画一遍；configure 时已经恢复过会话的话，onSession 已经启动过了
    const s = session()
    if (s) onSessionGained(s)
    else showGuest()

    const hash = (location.hash || '').replace('#', '')
    state.tab = ['lobby', 'boss', 'me', 'debug'].indexOf(hash) >= 0 ? hash : 'lobby'
    switchTab(state.tab)

    // 调试面板里显示一版空白内容，别等用户点进去才崩
    renderReqs()
    renderClaims()
    renderRaw()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }

  // 给本地测试脚本留一个手柄。线上页面不挂它，免得把内部状态白送出去。
  if (location.hostname === '127.0.0.1' || location.hostname === 'localhost') {
    window.__XMETA_DEMO__ = {
      state,
      config: CONFIG,
      parseLogs,
      refresh: () => refreshLobby(),
      refreshHomes,
      heartbeat,
    }
  }
})()

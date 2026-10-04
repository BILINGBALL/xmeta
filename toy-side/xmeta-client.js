/**
 * xmeta-client.js —— 第三方玩具接入脚本
 *
 * 用法：
 *   <script src="//s1.hdslb.com/bfs/seed/toy/app/sdk/toy-sdk.js"></script>
 *   <script src="xmeta-client.js"></script>
 *   <script>
 *     XMETA.configure({
 *       apiBase: 'https://your-api.example.com',
 *       centerToySlug: '<中心玩具的 slug>',
 *       clientId: '<认领后拿到的 client_id>'
 *     })
 *
 *     // 必须在用户点击里调用（toy.navigate 需要手势）
 *     btn.onclick = () => XMETA.login()
 *
 *     // 从中心玩具跳回来之后会自动换取 JWT 并派发事件
 *     XMETA.onSession(s => console.log(s.jwt, s.uid))
 *
 *     // 想知道还剩多久，用来提示用户
 *     XMETA.getRemainingMs()
 *   </script>
 *
 * 关于 centerToySlug —— 这是**中心玩具**的 slug，不是你自己玩具的。
 * 你不需要告诉 SDK 自己是谁：client_id 已经唯一标识了你的玩具，
 * 服务端由它反查出你的 slug 和 toy_id，回跳目标也由服务端给出。
 * 客户端指定不了回跳地址，这样就堵掉了开放重定向。
 *
 * 关于有效期 —— **用户在授权时自己选** token 能活多久（3/6/12/24 小时，
 * 默认 6 小时）。最长 24 小时，没有自动续期，所以到期后需要用户回
 * 中心玩具再授权一次。
 *
 * 会话存在本地（localStorage，key 带 clientId 前缀），**刷新页面、
 * 重开 App 都不用重新授权**，只有真的到期了才需要。所以接入方应该把
 * 剩余时间显示给用户，别让他玩到一半突然掉线：
 *   XMETA.getRemainingMs()   还剩多少毫秒，没登录返回 0
 *   XMETA.onSession(fn)      有身份时触发（包括从本地恢复），fn 收到 session
 *   XMETA.logout()           主动清掉本地会话
 *
 * 用户也可能在中心玩具里手动把自己在某个玩具上的身份失活。
 * 那种情况本地验签看不出来（JWT 是自包含的），需要确认就打
 * POST /api/oauth/introspect。
 *
 * 注意：localStorage 在 www.bilibilitoy.com 下是所有玩具共享的，
 * 所以 key 都带上 clientId 前缀，避免互相踩。
 */
(function (global) {
  'use strict'

  var CFG = { apiBase: '', centerToySlug: '', clientId: '' }
  var SESSION = null            // { jwt, uid, expiresAt, raw? }
  var listeners = []
  var errorListeners = []
  var VERIFIER_KEY = ''
  var SESSION_KEY = ''
  var pollTimer = null

  /**
   * 玩具之间跳转用的传参通道。
   *
   * B站 App 里 toy.navigate 走的是原生 JSB，实测 **不会透传 extra**：
   * 传 {cid,cc,st} 过去，目标页的 location.search 里只有原生自己加的
   * from_spmid=toy.toy-detail.<来源id>.0。Web 端则正常（SDK 自己拼 URL）。
   *
   * 好在所有玩具的内层 iframe 都在 www.bilibilitoy.com 这一个源下
   * （sandbox 带 allow-same-origin），localStorage 是共享的 —— 实测
   * 玩具 A 写进去的键，玩具 B 读得到。所以拿它当兜底通道。
   *
   * 两边都走：URL 参数优先（Web 端能用），拿不到再读 localStorage。
   * 只在同一台设备上有效，但过桥本来就是同设备跳过去再跳回来。
   */
  var REQ_KEY = 'xmeta:req'      // 发起方写：{ cid, cc, st, ts }
  var RES_KEY = 'xmeta:res'      // 中心玩具写：{ code, st, returnSlug, ts }
  var SHARED_TTL_MS = 3 * 60 * 1000

  function writeShared(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)) } catch (e) { /* 隐私模式 */ }
  }

  /** 只认新鲜的，避免上一次残留的请求串到这一次 */
  function readShared(key) {
    try {
      var v = JSON.parse(localStorage.getItem(key) || 'null')
      if (!v || typeof v !== 'object' || !v.ts) return null
      if (Date.now() - v.ts > SHARED_TTL_MS) return null
      return v
    } catch (e) {
      return null
    }
  }

  function clearShared(key) {
    try { localStorage.removeItem(key) } catch (e) { /* 忽略 */ }
  }

  /** 从内层 iframe 的路径 /toy/<slug>/... 里解出自己的 slug */
  function mySlug() {
    var m = /^\/toy\/([^/]+)\//.exec(global.location.pathname)
    return m ? m[1] : null
  }

  function b64url(bytes) {
    var s = ''
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }

  function randomString(n) {
    var a = new Uint8Array(n)
    crypto.getRandomValues(a)
    return b64url(a)
  }

  async function s256(input) {
    var data = new TextEncoder().encode(input)
    var digest = await crypto.subtle.digest('SHA-256', data)
    return b64url(new Uint8Array(digest))
  }

  async function post(path, body) {
    let res
    try {
      res = await fetch(CFG.apiBase + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
    } catch (e) {
      // 浏览器原生报错是 "Load failed" / "Failed to fetch"，没有上下文
      throw new Error(
        '连不上 ' + CFG.apiBase + '（' + (e.message || e) + '）。' +
          '检查这个地址是否外网可达、是否为 HTTPS。'
      )
    }
    var json = await res.json().catch(function () { return {} })
    if (!res.ok) {
      var err = new Error((json && json.error && json.error.message) || ('HTTP ' + res.status))
      err.code = json && json.error && json.error.code
      throw err
    }
    return json
  }

  function emit() {
    listeners.forEach(function (fn) {
      try { fn(SESSION) } catch (e) { console.error('[xmeta] listener 出错', e) }
    })
  }

  function configure(opts) {
    CFG = Object.assign(CFG, opts || {})
    if (!CFG.apiBase || !CFG.centerToySlug || !CFG.clientId) {
      throw new Error('[xmeta] 请先配置 apiBase / centerToySlug / clientId')
    }
    // 提前把配置错误喊出来。否则要等到用户点了登录，才收到一句
    // 没头没脑的 "Load failed"。
    if (/(\/\/)(127\.0\.0\.1|localhost)(:|\/|$)/.test(CFG.apiBase)) {
      console.warn(
        '[xmeta] apiBase 指向 ' + CFG.apiBase + '，那指的是**访问者自己的设备**，' +
          '不是你部署的服务器。手机上的 127.0.0.1 就是手机本身。'
      )
    }
    if (global.location.protocol === 'https:' && /^http:\/\//.test(CFG.apiBase)) {
      console.warn('[xmeta] apiBase 是 http 而页面是 https，请求会被浏览器按混合内容拦截。')
    }
    VERIFIER_KEY = 'xmeta:pkce:' + CFG.clientId
    SESSION_KEY = 'xmeta:sess:' + CFG.clientId

    // 上次拿到的身份还在有效期内就直接恢复：用户刷新页面、重开 App
    // 都不该再走一遍过桥
    restoreSession()
  }

  /** 当前这一轮尝试的 state（login 时写入） */
  function currentState() {
    try { return localStorage.getItem(VERIFIER_KEY + ':st') } catch (e) { return null }
  }

  /** 丢掉本轮尝试的 PKCE 记录 */
  function clearAttempt() {
    try {
      localStorage.removeItem(VERIFIER_KEY)
      localStorage.removeItem(VERIFIER_KEY + ':st')
    } catch (e) { /* 忽略 */ }
  }

  /**
   * 从共享存储里取「属于本轮尝试」的结果，取到就立刻删掉。
   *
   * 两点必须做，否则会把用户永久卡住：
   *
   *   1. 立刻删。code 是一次性的，留着它只会在每次进页面时重放一次
   *      注定失败的请求 —— 报错、不清、再报错，永远出不来。
   *
   *   2. 按 state 过滤。上一轮如果中途放弃（比如点了拒绝），它的结果
   *      可能还躺在那里；拿旧结果去换只会得到一个对不上号的错。
   */
  function takeSharedResult() {
    var shared = readShared(RES_KEY)
    if (!shared || !shared.code) return null
    clearShared(RES_KEY)

    var mine = mySlug()
    if (shared.returnSlug && mine && shared.returnSlug !== mine) return null

    // 必须对得上「当前正在进行的这一轮」。
    //
    // 注意这里是 `!expect ||` 而不是 `expect &&` —— 没有正在进行的尝试时
    // 一定要拒绝。那说明这是一条残留：上一轮的结果没被消费掉（页面没重载
    // 且轮询超时，或者轮询压根没跑起来），而它的 verifier 早就没了。
    // 放行的话就会拿着一条无主的 code 去换，报「找不到本次登录的 PKCE 记录」。
    var expect = currentState()
    if (!expect || shared.st !== expect) return null

    return shared
  }

  /** 发起过桥。必须在用户手势（click）里调用。 */
  async function login() {
    if (!CFG.clientId) throw new Error('[xmeta] 还没 configure')

    // 新一轮开始：把上一轮可能残留的结果清掉。
    // 不清的话它会被当成这一轮的结果拿去换，报一个莫名其妙的错。
    clearShared(RES_KEY)

    var verifier = randomString(32)
    var challenge = await s256(verifier)
    var state = randomString(16)

    try {
      localStorage.setItem(VERIFIER_KEY, verifier)
      localStorage.setItem(VERIFIER_KEY + ':st', state)
    } catch (e) { /* 隐私模式下写不进去，下面换 code 会失败并提示 */ }

    // App 内 navigate 不透传 extra，所以参数另写一份到共享的 localStorage。
    // URL 那份照样带着 —— Web 端能生效，且这样两端的排查方式一致。
    //
    // claimed 表示「中心玩具已经接手过这个请求」。不标记的话，用户在这之后
    // 直接打开中心玩具，会被一个还"新鲜"的旧请求弹到过桥页，而不是首页。
    writeShared(REQ_KEY, {
      cid: CFG.clientId,
      cc: challenge,
      st: state,
      ts: Date.now(),
      claimed: false
    })

    await toy.navigate({
      type: 'toy',
      id: CFG.centerToySlug,
      extra: { cid: CFG.clientId, cc: challenge, st: state }
    })

    // 回来时页面要是没有重新加载，handleRedirect 就不会再跑，
    // 所以这里起个轮询盯着共享存储，等中心玩具把结果写进来。
    startPolling()
  }

  /**
   * 盯着 RES_KEY，等中心玩具写回 { code, st, returnSlug }。
   * 页面重新加载时走 handleRedirect 就够了；这个是为了覆盖
   * 「App 里跳回来但页面没重载」的情况。
   */
  function startPolling() {
    // 先清掉可能还在跑的旧轮询：它的截止时间是按上一轮算的
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }

    var deadline = Date.now() + SHARED_TTL_MS
    pollTimer = setInterval(function () {
      if (Date.now() > deadline) {
        clearInterval(pollTimer)
        pollTimer = null
        return
      }
      var shared = takeSharedResult()
      if (!shared) return
      clearInterval(pollTimer)
      pollTimer = null
      doExchange(shared.code, shared.st).catch(function (e) {
        console.error('[xmeta] 换取 JWT 失败：', e.message)
        emitError(tagged('等待结果', e))
      })
    }, 1000)
  }

  /**
   * 页面加载时检查是不是「从中心玩具跳回来」。
   * 是的话用 code 换 JWT。返回 session 或 null。
   */
  async function handleRedirect() {
    var qs = new URLSearchParams(global.location.search)
    var code = qs.get('code')
    var state = qs.get('st')

    if (code) {
      // Web 端：SDK 自己拼 URL，extra 会带过来
      try {
        global.history.replaceState(null, '', global.location.pathname + global.location.hash)
      } catch (e) { /* 忽略 */ }
    } else {
      // App 端：navigate 不透传 extra，改从共享的 localStorage 取
      var shared = takeSharedResult()
      if (shared) { code = shared.code; state = shared.st }
    }

    if (code) return doExchange(code, state)

    // 没有可用的结果 —— 什么都不做，等用户点「开启联机」重新授权一次
    return null
  }

  /** 用 code + code_verifier 换 JWT */
  async function doExchange(code, state) {
    var verifier = null
    var expectState = null
    try {
      verifier = localStorage.getItem(VERIFIER_KEY)
      expectState = localStorage.getItem(VERIFIER_KEY + ':st')
    } catch (e) { /* 忽略 */ }

    // 无论成败都先清掉。code 是一次性的，重试注定失败；
    // 留着它只会让每次进页面都重放一次失败的请求。
    clearAttempt()
    clearShared(RES_KEY)
    clearShared(REQ_KEY)

    // 没有 verifier / state 对不上，是「这轮没得换」，不是错误。
    //
    // 典型来路：上一轮残留的结果，或者用户清了缓存之后又点进来。
    // 这时候用户什么都没做错，弹一个红字只会让他以为坏了 ——
    // 其实界面上显示「未获取」，再点一次「开启联机」就好了。
    // 这里不抛，只是安静地当没登录。
    if (!verifier) {
      console.warn('[xmeta] 收到一个授权结果，但本地没有对应的 PKCE 记录，已忽略')
      return null
    }
    if (expectState && state !== expectState) {
      console.warn('[xmeta] state 不匹配，已忽略这次结果')
      return null
    }

    var res = await post('/api/oauth/token', {
      grant_type: 'authorization_code',
      code: code,
      client_id: CFG.clientId,
      code_verifier: verifier
    })

    return applyTokens(res)
  }

  /** 处理一次成功的 token 响应 */
  function applyTokens(res) {
    SESSION = {
      jwt: res.access_token,
      uid: decodeSub(res.access_token),
      expiresAt: Date.now() + res.expires_in * 1000,
      raw: res
    }
    saveSession()
    emit()
    return SESSION
  }

  /**
   * 把会话存到本地。
   *
   * 不存的话，页面一刷新身份就没了，用户每次进来都得重新走一遍过桥 ——
   * 而 token 本来能活 3~24 小时，中间刷新几十次是常态。
   *
   * 存 localStorage 而不是 B站 云存储：云存储的读额度是**整个玩具的
   * 所有玩家共享**的，每次进页面都读一次，人一多就会被限流打爆，而且是
   * 被别的玩家连累。localStorage 不限速、同步读、秒出。
   *
   * 代价：token 会在 localStorage 里躺到过期。同源的其它玩具理论上读得到，
   * 但 token 绑定了 aud（只对这个玩具有效），而且用户随时能在个人中心
   * 手动失活。要提前结束也可以调 XMETA.logout()。
   */
  function saveSession() {
    if (!SESSION) return
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        jwt: SESSION.jwt,
        uid: SESSION.uid,
        expiresAt: SESSION.expiresAt
      }))
    } catch (e) { /* 隐私模式，忽略 */ }
  }

  function clearStoredSession() {
    try { localStorage.removeItem(SESSION_KEY) } catch (e) { /* 忽略 */ }
  }

  /** 从本地恢复。过期的顺手清掉，免得每次都要解析一遍。 */
  function restoreSession() {
    var raw = null
    try { raw = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null') } catch (e) { return }

    if (!raw || !raw.jwt || !raw.expiresAt) return
    if (raw.expiresAt <= Date.now()) { clearStoredSession(); return }

    SESSION = { jwt: raw.jwt, uid: raw.uid, expiresAt: raw.expiresAt }
    emit()
  }

  /** 这枚 token 还剩多少毫秒。没登录或已过期返回 0。 */
  function getRemainingMs() {
    if (!SESSION) return 0
    return Math.max(0, SESSION.expiresAt - Date.now())
  }

  /** 清掉本地会话。下次要用得重新过桥。 */
  function logout() {
    clearAttempt()
    clearShared(REQ_KEY)
    clearShared(RES_KEY)
    clearStoredSession()
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
    SESSION = null
    emit()
  }

  /** 只解析 payload，不验签。验签必须在服务端做。 */
  function decodeSub(jwt) {
    try {
      var b64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
      var bin = atob(b64)
      var bytes = new Uint8Array(bin.length)
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return JSON.parse(new TextDecoder().decode(bytes)).sub
    } catch (e) {
      return null
    }
  }

  function onSession(fn) {
    listeners.push(fn)
    if (SESSION) fn(SESSION)
    return function () {
      listeners = listeners.filter(function (f) { return f !== fn })
    }
  }

  /**
   * 订阅错误。自动续期/回跳路径上的失败原来只进 console ——
   * 手机上根本看不到，用户只会觉得「点了没反应」。
   * 接入方应该把它接到自己的界面上。
   */
  function onError(fn) {
    errorListeners.push(fn)
    return function () {
      errorListeners = errorListeners.filter(function (f) { return f !== fn })
    }
  }

  function emitError(e) {
    errorListeners.forEach(function (fn) {
      try { fn(e) } catch (err) { console.error('[xmeta] onError 回调出错', err) }
    })
  }

  /**
   * 给错误打上「从哪条路来的」。
   *
   * 换取触发有两个入口：页面加载时的回跳处理，和等结果的轮询。
   * 正常情况下只有一个会跑；两个都跑就意味着有东西重入了 ——
   * 而两边换的是同一个一次性 code，必然一个成功一个失败。
   * 报错时带上入口名，一眼就能看出是不是这种情况。
   */
  function tagged(stage, e) {
    var msg = (e && e.message) ? e.message : String(e)
    var err = new Error('[' + stage + '] ' + msg)
    err.stage = stage
    err.cause = e
    return err
  }

  function getSession() {
    if (SESSION && SESSION.expiresAt > Date.now() + 5000) return SESSION
    return null
  }

  global.XMETA = {
    configure: configure,
    login: login,
    handleRedirect: handleRedirect,
    onSession: onSession,
    /** 订阅错误，接到自己的界面上 */
    onError: onError,
    getSession: getSession,
    /** 这枚 token 还剩多少毫秒，没登录返回 0 */
    getRemainingMs: getRemainingMs,
    /** 主动清掉本地会话 */
    logout: logout
  }

  // 自动处理回跳。必须等 load —— 调用方的 XMETA.configure() 在
  // 本文件之后的 inline script 里执行，那时配置才就绪。
  function autoHandle() {
    if (!CFG.clientId) return
    handleRedirect().catch(function (e) {
      console.error('[xmeta] 换取 JWT 失败：', e.message)
      emitError(tagged('页面加载', e))
    })
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'complete') {
      setTimeout(autoHandle, 0)
    } else {
      global.addEventListener('load', function () { setTimeout(autoHandle, 0) })
    }
  }
})(typeof window !== 'undefined' ? window : this)

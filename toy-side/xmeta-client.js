/**
 * xmeta-client.js —— 第三方 toy 接入脚本
 *
 * 用法：
 *   <script src="//s1.hdslb.com/bfs/seed/toy/app/sdk/toy-sdk.js"></script>
 *   <script src="xmeta-client.js"></script>
 *   <script>
 *     XMETA.configure({
 *       apiBase: 'https://your-api.example.com',
 *       centerToySlug: '<中心 toy 的 slug>',
 *       clientId: '<认领后拿到的 client_id>'
 *     })
 *
 *     // 必须在用户点击里调用（toy.navigate 需要手势）
 *     btn.onclick = () => XMETA.login()
 *
 *     // 从中心 toy 跳回来之后，SDK 会检测到那枚授权码并通知你 ——
 *     // 但**不会自动兑换**，兑换要用户再点一次：
 *     XMETA.onCodeReady(() => { btnFinish.hidden = false })
 *     btnFinish.onclick = async () => {
 *       try { await XMETA.completeLogin() } catch (e) { showError(e.message) }
 *     }
 *
 *     // 有身份时触发（包括从本地恢复）
 *     XMETA.onSession(s => console.log(s.jwt, s.uid))
 *
 *     // 想知道还剩多久，用来提示用户
 *     XMETA.getRemainingMs()
 *   </script>
 *
 * 关于 centerToySlug —— 这是**中心 toy**的 slug，不是你自己 toy 的。
 * 你不需要告诉 SDK 自己是谁：client_id 已经唯一标识了你的 toy，
 * 服务端由它反查出你的 slug 和 toy_id，回跳目标也由服务端给出。
 * 客户端指定不了回跳地址，这样就堵掉了开放重定向。
 *
 * 关于「为什么要用户再点一次」—— 过桥是「跳走再跳回来」，而跳走时
 * 那个页面实例并没有消失，只是看不见了。如果兑换是自动的，看不见的
 * 那个实例就可能抢在用户看得见的实例之前，把一次性 code 消费掉，
 * 结果就是「第一次授权回来显示未连接，再授权一次才行」。
 *
 * 所以这里把两件事拆开：
 *   检测 —— 只读、幂等，多少个实例同时检测都互不影响
 *   兑换 —— 绑在用户手势上，只有用户点得到的那个页面能触发
 * 竞态就不再是「靠时序侥幸避开」，而是结构上不存在。
 *
 * 关于有效期 —— **用户在授权时自己选** token 能活多久（3/6/12/24 小时，
 * 默认 6 小时）。最长 24 小时，没有自动续期，所以到期后需要用户回
 * 中心 toy 再授权一次。
 *
 * 会话存在本地（localStorage，key 带 clientId 前缀），**刷新页面、
 * 重开 App 都不用重新授权**，只有真的到期了才需要。所以接入方应该把
 * 剩余时间显示给用户，别让他玩到一半突然掉线：
 *   XMETA.getRemainingMs()   还剩多少毫秒，没登录返回 0
 *   XMETA.onSession(fn)      有身份时触发（包括从本地恢复），fn 收到 session
 *   XMETA.setSession(jwt)    装上一枚已有的 token（例如你存在自己云存储里
 *                            的那份），有效返回 true、无效/过期返回 false
 *   XMETA.logout()           主动清掉本地会话
 *
 * token 是拿去向数据服务读写数据的凭证 —— 前端不用验签，客户端自己知道
 * 自己是谁。需要再确认一次有效性就打 POST /api/oauth/introspect。
 *
 * 注意：localStorage 在 www.bilibilitoy.com 下是所有 toy 共享的，
 * 所以 key 都带上 clientId 前缀，避免互相踩。
 */
(function (global) {
  'use strict'

  var CFG = { apiBase: '', centerToySlug: '', clientId: '' }
  var SESSION = null            // { jwt, uid, expiresAt, raw? }
  var listeners = []
  var VERIFIER_KEY = ''
  var SESSION_KEY = ''
  var pollTimer = null
  var sessionWatchTimer = null   // 等另一个页面实例把会话交出来
  var prepared = null            // 预生成的 PKCE 对，login() 时同步取用
  var exchanging = false         // completeLogin 页面内互斥，防止手快连点打出两次 POST

  /**
   * toy 之间跳转用的传参通道。
   *
   * B站 App 里 toy.navigate 走的是原生 JSB，实测 **不会透传 extra**：
   * 传 {cid,cc,st} 过去，目标页的 location.search 里只有原生自己加的
   * from_spmid=toy.toy-detail.<来源id>.0。Web 端则正常（SDK 自己拼 URL）。
   *
   * 好在所有 toy 的内层 iframe 都在 www.bilibilitoy.com 这一个源下
   * （sandbox 带 allow-same-origin），localStorage 是共享的 —— 实测
   * toy A 写进去的键，toy B 读得到。所以拿它当兜底通道。
   *
   * 两边都走：URL 参数优先（Web 端能用），拿不到再读 localStorage。
   * 只在同一台设备上有效，但过桥本来就是同设备跳过去再跳回来。
   */
  var REQ_KEY = 'xmeta:req'          // 发起方写：{ cid, cc, st, ts, claimed }
  /**
   * 中心 toy 写下的「待兑换授权码」槽。**这是一份公开契约**，
   * 键名、值结构、TTL 都写在 README 里，第三方 toy 可以只读它。
   *
   * 键是全局单槽（所有 toy 共用一个），所以值里的 clientId 不能省 ——
   * 它是「这枚码不是给我的」的唯一判据。
   */
  var CODE_KEY = 'xmeta:code'
  /** 旧版本的槽（键名不同、无 expiresAt）。过渡期清一清，见 bridge.html。 */
  var LEGACY_RES_KEY = 'xmeta:res'
  var SHARED_TTL_MS = 3 * 60 * 1000
  /** 没检测到 code 时，等另一个页面实例把会话写出来的最长时间 */
  var SESSION_WATCH_MS = 10 * 1000
  /** 槽里没有 expiresAt 时的兜底有效期（URL 那条路用它，量的是「页面加载至今」） */
  var FALLBACK_CODE_TTL_MS = 60 * 1000

  var loadedAt = Date.now()
  /** 已通知过的 code —— 只在内存里去重，绝不写共享键（那又会变成一个会被抢的槽） */
  var notifiedCode = null

  function writeShared(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)) } catch (e) { /* 隐私模式 */ }
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

  /**
   * 预生成一对 PKCE（verifier + challenge）。
   *
   * challenge 要过 crypto.subtle.digest，那是 async 的；而 toy.navigate 前
   * 不能跨 await（需要瞬时用户手势）。所以在页面加载时就先算好，login()
   * 里同步取走。用完即弃，马上再预生成一对给下一次。
   */
  function preparePkce() {
    var verifier = randomString(32)
    s256(verifier).then(function (challenge) {
      prepared = { verifier: verifier, challenge: challenge }
    }).catch(function () {
      prepared = null
    })
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

  // ── 检测待兑换的 code ────────────────────────────────────────────
  //
  //      ★ 不变式：槽只在三种**终态**被删 —— 兑换成功 / 判定过期 / 用户取消。
  //        任何「看一眼」都不许删。
  //
  //      以前这里是 takeSharedResult()：先 clearShared() 再校验 state。
  //      于是一个**没有 verifier 的实例**读一眼也能把结果毁掉，让真正能
  //      兑换的实例扑空 —— 两败俱伤。这和「后台实例先醒」是并列的两个杀手，
  //      只把兑换改成手动、不动这里，等于留了个洞。
  // ────────────────────────────────────────────────────────────────

  /** 读槽。**纯读**，绝不删。 */
  function readPending() {
    try {
      var p = JSON.parse(localStorage.getItem(CODE_KEY) || 'null')
      if (!p || typeof p !== 'object' || !p.code) return null
      return p
    } catch (e) {
      return null
    }
  }

  function clearPending() {
    clearShared(CODE_KEY)
    clearShared(LEGACY_RES_KEY)
  }

  /**
   * 槽里那枚 code 是不是「此刻、本实例、该兑换的那一枚」。**纯读**。
   * 不满足就返回 null —— 除了「已过期」，其它情况一律**不清槽**。
   */
  function detectPending() {
    var p = readPending()
    if (!p) return null

    // 单槽是所有 toy 共用的，这枚码可能根本不是发给我的
    if (p.clientId !== CFG.clientId) return null

    var mine = mySlug()
    if (p.returnSlug && mine && p.returnSlug !== mine) return null

    // 过期是终态：清掉它，免得每次进页面都拿一枚死码来问
    var expiresAt = typeof p.expiresAt === 'number'
      ? p.expiresAt
      : (typeof p.ts === 'number' ? p.ts + FALLBACK_CODE_TTL_MS : 0)
    if (!expiresAt || Date.now() > expiresAt) {
      clearPending()
      return null
    }

    // 必须对得上「当前正在进行的这一轮」。
    //
    // 注意是 `!expect ||` 而不是 `expect &&` —— 没有进行中的一轮时一定要
    // 拒绝。那说明这是一条残留：上一轮的结果没被消费掉（页面没重载且轮询
    // 超时），而它的 verifier 早就没了。放行就会拿着一条无主的 code 去换，
    // 报「找不到本次登录的 PKCE 记录」。
    var expect = currentState()
    if (!expect || !p.state || p.state !== expect) return null

    // 已经连上了就别再冒一个「完成登录」的按钮
    if (SESSION && getRemainingMs() > 0) return null

    return { code: p.code, state: p.state, returnSlug: p.returnSlug || null }
  }

  /**
   * 检测有没有可兑换的 code，两个来源：
   *   1. 中心 toy 写下的共享槽（App 和 Web 都走这条）；
   *   2. URL 上的 ?code=，只在槽读不到时兜底（Web 端 navigate 会把
   *      extra 拼进地址）。URL 里没有时间戳，只能按「页面加载至今」估。
   *
   * **纯读，不消耗。**
   */
  function detectCode() {
    var fromSlot = detectPending()
    if (fromSlot) return fromSlot

    var qs = new URLSearchParams(global.location.search)
    var code = qs.get('code')
    if (!code) return null

    if (Date.now() - loadedAt > FALLBACK_CODE_TTL_MS) return null

    var expect = currentState()
    var state = qs.get('st')
    if (!expect || !state || state !== expect) return null
    if (SESSION && getRemainingMs() > 0) return null

    return { code: code, state: state, returnSlug: null }
  }

  var codeReadyListeners = []

  /**
   * 订阅「检测到待兑换的授权码」。回调收 { code, state, returnSlug }。
   *
   * 只读、幂等：同一枚 code 在一个页面实例里只通知一次，多个实例同时
   * 检测也互不影响。接入方应该据此渲染一个按钮，由用户点它去兑换。
   */
  function onCodeReady(fn) {
    codeReadyListeners.push(fn)
    return function () {
      codeReadyListeners = codeReadyListeners.filter(function (f) { return f !== fn })
    }
  }

  function emitCodeReady(pending) {
    if (!pending || pending.code === notifiedCode) return
    notifiedCode = pending.code
    codeReadyListeners.forEach(function (fn) {
      try { fn(pending) } catch (e) { console.error('[xmeta] onCodeReady 回调出错', e) }
    })
  }

  /** 检测一次；有就通知接入方。返回检测结果（纯读） */
  function probe() {
    var pending = detectCode()
    if (pending) emitCodeReady(pending)
    return pending
  }

  /** 发起过桥。必须在用户手势（click）里调用。 */
  async function login() {
    if (!CFG.clientId) throw new Error('[xmeta] 还没 configure')

    // 新一轮开始：把上一轮可能残留的结果清掉，免得被当成这一轮的结果。
    // 这就是「用户重新发起」那个终态。
    clearPending()
    notifiedCode = null

    // 取预生成好的 PKCE。极小概率还没就绪（脚本刚加载就点），兜底现场算一次。
    var pair = prepared
    if (!pair) {
      var v = randomString(32)
      pair = { verifier: v, challenge: await s256(v) }
    }
    prepared = null
    preparePkce()

    var state = randomString(16)

    try {
      localStorage.setItem(VERIFIER_KEY, pair.verifier)
      localStorage.setItem(VERIFIER_KEY + ':st', state)
    } catch (e) { /* 隐私模式下写不进去，下面换 code 会失败并提示 */ }

    // App 内 navigate 不透传 extra，所以参数另写一份到共享的 localStorage。
    // URL 那份照样带着 —— Web 端能生效，且这样两端的排查方式一致。
    //
    // claimed 表示「中心 toy 已经接手过这个请求」。不标记的话，用户在这之后
    // 直接打开中心 toy，会被一个还"新鲜"的旧请求弹到过桥页，而不是首页。
    writeShared(REQ_KEY, {
      cid: CFG.clientId,
      cc: pair.challenge,
      st: state,
      ts: Date.now(),
      claimed: false
    })

    await toy.navigate({
      type: 'toy',
      id: CFG.centerToySlug,
      extra: { cid: CFG.clientId, cc: pair.challenge, st: state }
    })

    // 回来时页面要是没有重新加载，handleRedirect 就不会再跑，
    // 所以这里起个轮询盯着共享存储，等中心 toy 把结果写进来。
    startPolling()
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  }

  /**
   * 短时间盯着共享的会话记录，谁先拿到算谁的。
   *
   * 兑换只认一个一次性 code，而可能有两个页面实例在抢：用户点的那个
   * （跳走之后还在后台跑）和跳回来时新加载的那个。没抢到的那边**不能**
   * 就此显示未连接 —— 抢到的那边会把会话写进 localStorage
   * （xmeta:sess:<clientId>，同源共享），等一下就能读到。
   *
   * 少了这一步，「第一次授权回来显示未连接、再授权一次才行」就会出现：
   * 输的那边检查时赢的那边还没写完，于是双方都停在未连接。
   */
  function stopWatching() {
    if (sessionWatchTimer) { clearInterval(sessionWatchTimer); sessionWatchTimer = null }
  }

  function watchForSession(timeoutMs) {
    if (sessionWatchTimer) return
    var deadline = Date.now() + (timeoutMs || SESSION_WATCH_MS)
    sessionWatchTimer = setInterval(function () {
      if (Date.now() > deadline) { stopWatching(); return }
      restoreSession()          // 读到就 emit，接入方的 onSession 会收到
      if (SESSION && getRemainingMs() > 0) stopWatching()
    }, 500)
  }

  /**
   * 盯着共享槽，等中心 toy 把 code 写进来 —— 覆盖「App 里跳回来但页面
   * 没重载」的情况（这种情况下 handleRedirect 不会再跑）。
   *
   * **只检测、只通知，不兑换。** 兑换交给用户点按钮。
   */
  function startPolling() {
    // 先清掉可能还在跑的旧轮询：它的截止时间是按上一轮算的
    stopPolling()

    var deadline = Date.now() + SHARED_TTL_MS
    pollTimer = setInterval(function () {
      if (Date.now() > deadline) {
        stopPolling()
        return
      }
      if (probe()) stopPolling()   // 通知过了就收工，后面用户自己会点
    }, 1000)
  }

  /**
   * 处理「从中心 toy 跳回来」。**只检测、只通知，不兑换。**
   *
   * 兑换要用户点按钮（completeLogin），这样只有用户看得见、点得到的
   * 那个页面会去消费那枚一次性 code，后台实例拿它没办法。
   *
   * 返回待兑换的 code 信息或 null；同时会触发 onCodeReady。
   */
  function handleRedirect() {
    // 已经有有效 session 就直接用 —— 可能是另一个窗口刚兑换完写进来的，
    // 也可能是本页 restoreSession 时还没写完、现在补一次。
    if (SESSION && getRemainingMs() > 0) return null
    restoreSession()
    if (SESSION) return null

    return probe()
  }

  /** 把 URL 上的 ?code= / ?st= 抹掉 */
  function stripCodeFromUrl() {
    try {
      if (!new URLSearchParams(global.location.search).get('code')) return
      global.history.replaceState(null, '', global.location.pathname + global.location.hash)
    } catch (e) { /* 忽略 */ }
  }

  /**
   * 兑换失败的善后。返回一个 session 表示「其实算成功」（两个 tab 都点了
   * 按钮时，输的那边可以采纳赢的那边写下的会话）。
   */
  function settleAfterFailure(e) {
    var code = e && e.code

    if (code === 'code_used') {
      // 另一个 tab 抢先兑换了。它的会话就在同源的 localStorage 里。
      restoreSession()
      if (SESSION && getRemainingMs() > 0) {
        clearPending()
        clearAttempt()
        stripCodeFromUrl()
        return SESSION
      }
    }

    // 只有「这枚 code 已经确定没用了」才算终态、才清槽。
    // 网络抖动之类的可重试错误必须留着，否则用户再点一次会被告知
    // 「没有待兑换的授权码」—— 明明按钮还在，莫名其妙。
    if (code === 'code_used' || code === 'code_expired' || code === 'invalid_code') {
      clearPending()
      clearAttempt()
      stripCodeFromUrl()
    }

    return null
  }

  /**
   * 兑换待处理的授权码，建立会话。**必须在用户手势里调用。**
   *
   * 这是整条链路上**唯一**会消费那枚一次性 code 的地方。绑在用户手势上，
   * 意味着只有用户看得见的页面能触发它 —— 看不见的后台实例想抢也抢不了。
   *
   * 成功返回 session；失败抛错，接入方应该接住并显示给用户。
   */
  async function completeLogin() {
    if (SESSION && getRemainingMs() > 0) return SESSION

    // 兑换前重新检测一次：可能已经过期了，也可能已经没得换了
    var pending = detectCode()
    if (!pending) {
      // 没有待兑换的。要是已经有会话（别的实例刚兑换完），当成成功。
      restoreSession()
      if (SESSION && getRemainingMs() > 0) return SESSION
      var none = new Error('没有待兑换的授权码，请点「开启联机」重新授权一次')
      none.code = 'no_pending_code'
      throw none
    }

    // 页面内互斥，**同步置位** —— 防止用户手快连点，那样会打出两次 POST，
    // 而 code 是一次性的，第二次必然失败。
    if (exchanging) return null
    exchanging = true

    var verifier = null
    var expectState = null
    try {
      verifier = localStorage.getItem(VERIFIER_KEY)
      expectState = localStorage.getItem(VERIFIER_KEY + ':st')
    } catch (e) { /* 忽略 */ }

    if (!verifier || !expectState || pending.state !== expectState) {
      // 本地没有对应的 PKCE 记录 / state 对不上 = 这轮没得换。
      // 用户什么都没做错，但也没法在这点上成功，清掉残留让他重新发起。
      clearAttempt()
      exchanging = false
      var stale = new Error('本地找不到本次登录的 PKCE 记录，请点「开启联机」重新授权一次')
      stale.code = 'no_pkce_record'
      throw stale
    }

    try {
      var res = await post('/api/oauth/token', {
        grant_type: 'authorization_code',
        code: pending.code,
        client_id: CFG.clientId,
        code_verifier: verifier
      })
      // 成功是终态：清槽 + 清 PKCE 记录 + 抹掉 URL 上的 code
      clearPending()
      clearAttempt()
      stripCodeFromUrl()
      return applyTokens(res)
    } catch (e) {
      var adopted = settleAfterFailure(e)
      if (adopted) return adopted
      throw e
    } finally {
      exchanging = false
    }
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
   * 装上一枚手上已有的 access_token，返回它能不能用。
   *
   * 这是给「凭证本来就存在别处」的场景：接入方把 token 存在自己的云存储里
   * （按「登录用户 + toy」隔离、跨设备），换台设备打开时读回来装进去，
   * 就等于已连接，不用再过一次桥。
   *
   * 有效性只看 payload 里的 exp —— 前端不验签，要不要验是收数据那边的
   * 责任。返回 false 表示这枚 token 解不开或已过期，调用方应当按
   * 「未连接」处理，引导用户重新授权。
   */
  function setSession(jwt) {
    if (typeof jwt !== 'string' || !jwt) return false

    var claims = decodeClaims(jwt)
    if (!claims || typeof claims.exp !== 'number') return false

    var expiresAt = claims.exp * 1000
    if (expiresAt <= Date.now()) return false

    SESSION = { jwt: jwt, uid: claims.sub || null, expiresAt: expiresAt }
    saveSession()
    emit()
    return true
  }

  /**
   * 把会话存到本地。
   *
   * 不存的话，页面一刷新身份就没了，用户每次进来都得重新走一遍过桥 ——
   * 而 token 本来能活 3~24 小时，中间刷新几十次是常态。
   *
   * 存 localStorage 而不是 B站 云存储：云存储的读额度是**整个 toy 的
   * 所有玩家共享**的，每次进页面都读一次，人一多就会被限流打爆，而且是
   * 被别的玩家连累。localStorage 不限速、同步读、秒出。
   *
   * 代价：token 会在 localStorage 里躺到过期。同源的其它 toy 理论上读得到，
   * 但 token 绑定了 aud（只对这个 toy 有效）。要提前结束也可以调
   * XMETA.logout()。
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

  /** 清掉本地会话，以及所有躺着的中间状态。下次要用得重新过桥。 */
  function logout() {
    clearAttempt()
    clearShared(REQ_KEY)
    clearPending()
    notifiedCode = null
    clearStoredSession()
    stopPolling()
    stopWatching()
    SESSION = null
    emit()
  }

  /** 只解析 payload。前端不验签 —— 验不验是收数据那边的事。 */
  function decodeClaims(jwt) {
    try {
      var b64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
      var bin = atob(b64)
      var bytes = new Uint8Array(bin.length)
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return JSON.parse(new TextDecoder().decode(bytes))
    } catch (e) {
      return null
    }
  }

  function decodeSub(jwt) {
    var claims = decodeClaims(jwt)
    return claims ? claims.sub || null : null
  }

  function onSession(fn) {
    listeners.push(fn)
    // 立即回调也要包 try/catch。
    //
    // emit() 里包了，这里原来没包 —— 而注册时如果已经有 session（比如
    // 刚从本地恢复），回调是**同步**跑的，它一抛错就会沿着调用栈冒到
    // 调用方的脚本里。
    //
    // 实测踩过：demo toy 的 onSession 回调里引用了还没声明的变量，
    // 抛出的 ReferenceError 把后面注册的两个按钮监听一起带走了，
    // 界面上表现为「点了没反应」。一个监听器的问题不该让整页瘫掉。
    if (SESSION) {
      try { fn(SESSION) } catch (e) { console.error('[xmeta] onSession 回调出错', e) }
    }
    return function () {
      listeners = listeners.filter(function (f) { return f !== fn })
    }
  }

  function getSession() {
    if (SESSION && SESSION.expiresAt > Date.now() + 5000) return SESSION
    return null
  }

  global.XMETA = {
    configure: configure,
    login: login,
    /**
     * 处理「从中心 toy 跳回来」：只检测、只通知 onCodeReady，**不兑换**。
     * 返回待兑换的 code 信息或 null。
     */
    handleRedirect: handleRedirect,
    /** 订阅「检测到待兑换的授权码」。据此渲染按钮，让用户点。 */
    onCodeReady: onCodeReady,
    /**
     * 兑换待处理的授权码，建立会话。**必须在用户手势里调用。**
     * 成功返回 session，失败抛错（接住它并显示给用户）。
     */
    completeLogin: completeLogin,
    onSession: onSession,
    getSession: getSession,
    /** 这枚 token 还剩多少毫秒，没登录返回 0 */
    getRemainingMs: getRemainingMs,
    /** 装上一枚已有的 token（比如从自己的云存储读回来的），返回能不能用 */
    setSession: setSession,
    /** 主动清掉本地会话 */
    logout: logout
  }

  // 页面加载时就预生成好 PKCE 对，login() 里同步取用（toy.navigate 前不能 await）
  preparePkce()

  // 自动处理回跳。必须等 load —— 调用方的 XMETA.configure() 在
  // 本文件之后的 inline script 里执行，那时配置才就绪。
  function autoHandle() {
    if (!CFG.clientId) return
    handleRedirect()      // 只检测、只通知 onCodeReady，不兑换
    // 别的实例可能正在兑换 / 刚兑换完。它的会话会写进同源的 localStorage，
    // 等一下就能接手 —— 没有这一步，「另一个实例在兑换」的这段时间里
    // 本页会一直停在未连接。见 watchForSession 的注释。
    watchForSession()
  }

  /**
   * 页面切到后台就停掉轮询，回到前台立刻补一次检测。
   *
   * 兑换不再自动发生，所以后台实例的轮询已经没有破坏性了 —— 这里停掉
   * 纯粹是省点无用功。回到前台立刻检测一次，是为了「同一个实例回去、
   * 页面没重载」时不用再等一个轮询周期，按钮能马上出来。
   */
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { stopPolling(); return }
      if (probe()) { stopPolling(); return }
      restoreSession()
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

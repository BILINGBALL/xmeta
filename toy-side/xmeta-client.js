/**
 * xmeta-client.js —— 第三方玩具接入脚本
 *
 * 用法：
 *   <script src="//s1.hdslb.com/bfs/seed/toy/app/sdk/toy-sdk.js"></script>
 *   <script src="xmeta-client.js"></script>
 *   <script>
 *     XMETA.configure({
 *       apiBase: 'https://your-api.example.com',
 *       myToySlug: '<中心玩具的 slug>',
 *       clientId: '<认领后拿到的 client_id>'
 *     })
 *
 *     // 必须在用户点击里调用（toy.navigate 需要手势）
 *     btn.onclick = () => XMETA.login()
 *
 *     // 从中心玩具跳回来之后会自动换取 JWT 并派发事件
 *     XMETA.onSession(s => console.log(s.jwt, s.uid))
 *   </script>
 *
 * 注意：localStorage 在 www.bilibilitoy.com 下是所有玩具共享的，
 * 所以 key 都带上 clientId 前缀，避免互相踩。它只用来暂存一次性的
 * PKCE verifier，真正的凭证只放内存。
 */
(function (global) {
  'use strict'

  var CFG = { apiBase: '', myToySlug: '', clientId: '' }
  var SESSION = null            // { jwt, uid, expiresAt }
  var listeners = []
  var VERIFIER_KEY = ''

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
    var res = await fetch(CFG.apiBase + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
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
    if (!CFG.apiBase || !CFG.myToySlug || !CFG.clientId) {
      throw new Error('[xmeta] 请先配置 apiBase / myToySlug / clientId')
    }
    VERIFIER_KEY = 'xmeta:pkce:' + CFG.clientId
  }

  /** 发起过桥。必须在用户手势（click）里调用。 */
  async function login() {
    if (!CFG.clientId) throw new Error('[xmeta] 还没 configure')

    var verifier = randomString(32)
    var challenge = await s256(verifier)
    var state = randomString(16)

    try {
      localStorage.setItem(VERIFIER_KEY, verifier)
      localStorage.setItem(VERIFIER_KEY + ':st', state)
    } catch (e) { /* 隐私模式下写不进去，下面换 code 会失败并提示 */ }

    await toy.navigate({
      type: 'toy',
      id: CFG.myToySlug,
      extra: { cid: CFG.clientId, cc: challenge, st: state }
    })
  }

  /**
   * 页面加载时检查是不是「从中心玩具跳回来」。
   * 是的话用 code 换 JWT。返回 session 或 null。
   */
  async function handleRedirect() {
    var qs = new URLSearchParams(global.location.search)
    var code = qs.get('code')
    var state = qs.get('st')
    if (!code) return null

    // 把 code 从地址栏抹掉，避免被复制/进历史
    try {
      var clean = global.location.pathname + global.location.hash
      global.history.replaceState(null, '', clean)
    } catch (e) { /* 忽略 */ }

    var verifier = null
    var expectState = null
    try {
      verifier = localStorage.getItem(VERIFIER_KEY)
      expectState = localStorage.getItem(VERIFIER_KEY + ':st')
      localStorage.removeItem(VERIFIER_KEY)
      localStorage.removeItem(VERIFIER_KEY + ':st')
    } catch (e) { /* 忽略 */ }

    if (!verifier) {
      throw new Error('[xmeta] 找不到本次登录的 PKCE 记录，是不是换了设备或清了缓存？')
    }
    if (expectState && state !== expectState) {
      throw new Error('[xmeta] state 不匹配，可能被伪造，已中止')
    }

    var res = await post('/api/oauth/token', {
      grant_type: 'authorization_code',
      code: code,
      client_id: CFG.clientId,
      code_verifier: verifier
    })

    SESSION = {
      jwt: res.access_token,
      uid: decodeSub(res.access_token),
      expiresAt: Date.now() + res.expires_in * 1000,
      raw: res
    }
    emit()
    return SESSION
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

  function getSession() {
    if (SESSION && SESSION.expiresAt > Date.now() + 5000) return SESSION
    return null
  }

  global.XMETA = {
    configure: configure,
    login: login,
    handleRedirect: handleRedirect,
    onSession: onSession,
    getSession: getSession
  }

  // 自动处理回跳。必须等 load —— 调用方的 XMETA.configure() 在
  // 本文件之后的 inline script 里执行，那时配置才就绪。
  function autoHandle() {
    if (!CFG.clientId) return
    handleRedirect().catch(function (e) {
      console.error('[xmeta] 换取 JWT 失败：', e.message)
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

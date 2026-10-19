/**
 * 对线上 xmeta 服务做一轮只读检查（不会写任何数据）。
 *
 * 跑法：node _test/live-check.mjs
 */
const API = 'https://www.oxth.com:8443'
const CLIENT_ID = 'xmeta_OXSY7nxlpKooXGd0oS95Cg'
const TOY_ID = '41072244021248'
const ORIGIN = 'https://www.bilibilitoy.com'

const failures = []
const ok = (msg, extra) => console.log('  ✓ ' + msg + (extra ? '  ' + extra : ''))
const bad = (msg) => { failures.push(msg); console.log('  ✗ ' + msg) }

async function get(path, opts) {
  return fetch(API + path, Object.assign({
    headers: { Origin: ORIGIN },
    signal: AbortSignal.timeout(15000),
  }, opts || {}))
}

async function main() {
  console.log('线上检查：' + API)

  // 1. 健康检查
  try {
    const res = await get('/health')
    const json = await res.json()
    if (res.ok && json.ok) ok('服务在线', '/health → 200')
    else bad('/health 返回异常：' + res.status)
  } catch (e) {
    bad('连不上服务：' + e.message)
  }

  // 2. client_id 对应的 toy
  try {
    const res = await get('/api/bridge/context?cid=' + encodeURIComponent(CLIENT_ID))
    const json = await res.json()
    if (res.ok && json.clientId === CLIENT_ID && json.toyId === TOY_ID) {
      ok('client_id 能查到这台 toy', json.slug + ' / ' + json.title)
    } else {
      bad('client_id 查不到这台 toy：' + JSON.stringify(json).slice(0, 200))
    }
  } catch (e) {
    bad('查询 client_id 失败：' + e.message)
  }

  // 3. 元信息
  try {
    const res = await get('/.well-known/xmeta-configuration')
    const json = await res.json()
    const ttl = json.token_ttl_hours_options || []
    if (res.ok && ttl.includes(3) && ttl.includes(24)) {
      ok('授权时长档位对得上', ttl.join(' / ') + ' 小时')
    } else {
      bad('元信息和页面不一致：' + JSON.stringify(json).slice(0, 200))
    }
  } catch (e) {
    bad('读元信息失败：' + e.message)
  }

  // 4. 线上接入脚本是不是新版
  try {
    const res = await get('/xmeta-client.js')
    const text = await res.text()
    const need = ['onCodeReady', 'completeLogin', 'getSession', 'handleRedirect']
    const missing = need.filter((k) => !text.includes(k))
    if (res.ok && !missing.length) {
      ok('线上 xmeta-client.js 包含页面要用的方法', need.join(' / '))
    } else {
      bad('线上 xmeta-client.js 缺方法：' + missing.join(' / '))
    }
  } catch (e) {
    bad('下载 xmeta-client.js 失败：' + e.message)
  }

  // 5. CORS 预检：toy 内层 iframe 的源要能带 Authorization 跨域
  try {
    const res = await fetch(API + '/api/kv/lobby', {
      method: 'OPTIONS',
      headers: {
        Origin: ORIGIN,
        'Access-Control-Request-Method': 'PATCH',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
      signal: AbortSignal.timeout(15000),
    })
    const allowOrigin = res.headers.get('access-control-allow-origin') || ''
    const allowHeaders = (res.headers.get('access-control-allow-headers') || '').toLowerCase()
    if (res.status < 400 && (allowOrigin === ORIGIN || allowOrigin === '*') &&
        allowHeaders.includes('authorization')) {
      ok('CORS 预检通过', 'allow-origin=' + allowOrigin)
    } else {
      bad('CORS 预检不通过：status=' + res.status +
        ' allow-origin=' + allowOrigin + ' allow-headers=' + allowHeaders)
    }
  } catch (e) {
    bad('CORS 预检请求失败：' + e.message)
  }

  // 6. 不带令牌的数据接口应该 401（而不是 500 或放行）
  try {
    const res = await get('/api/kv/lobby')
    const json = await res.json().catch(() => ({}))
    if (res.status === 401 && json.error) {
      ok('数据接口会拒绝没有令牌的请求', json.error.code)
    } else {
      bad('没有令牌却返回了 ' + res.status + '：' + JSON.stringify(json).slice(0, 160))
    }
  } catch (e) {
    bad('无令牌请求失败：' + e.message)
  }

  // 7. 假 code 换票：应该按错误码拒绝，不能 5xx
  try {
    const res = await fetch(API + '/api/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: 'definitely-not-a-real-code',
        client_id: CLIENT_ID,
      }),
      signal: AbortSignal.timeout(15000),
    })
    const json = await res.json().catch(() => ({}))
    if (res.status >= 400 && res.status < 500 && json.error && json.error.code) {
      ok('假 code 会被拒绝', res.status + ' ' + json.error.code)
    } else {
      bad('假 code 的返回不对：' + res.status + ' ' + JSON.stringify(json).slice(0, 160))
    }
  } catch (e) {
    bad('换票接口请求失败：' + e.message)
  }

  // 8. 统计接口（公开只读）
  try {
    const res = await get('/api/stats')
    const json = await res.json()
    if (res.ok && typeof json.toyServices === 'number') {
      ok('统计接口正常', 'toys=' + json.toys + ' users=' + json.users + ' services=' + json.toyServices)
    } else {
      bad('统计接口返回异常：' + JSON.stringify(json).slice(0, 160))
    }
  } catch (e) {
    bad('统计接口请求失败：' + e.message)
  }

  if (failures.length) {
    console.error('\n线上检查有 ' + failures.length + ' 项没过。')
    process.exitCode = 1
  } else {
    console.log('\n线上检查通过。')
  }
}

main().catch((e) => {
  console.error('检查失败：', e)
  process.exitCode = 1
})

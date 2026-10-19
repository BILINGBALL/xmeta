# 怎么拿 JWT

拿到 JWT，就说明玩家在 xmeta 里授权过你的 toy。三步：跳去中心 toy、读回 code、换 JWT。

## 先确认

- toy 已认领，手上有 `client_id`（一个 toy 一个）
- 页面里能拿到「申请联机凭证」那颗按钮，id 和文字随意
- 已引入 B站 toy SDK（`toy.navigate` 要用）

## 第一步：跳去中心 toy

用户点按钮时，先把请求写进 localStorage，再跳：

```js
const API           = 'https://www.oxth.com:8443'
const CENTER_SLUG   = 'xmeta'                 // 中心 toy 的 slug，navigate 用
const CENTER_TOY_ID = '39945062320128'        // 可选，抄过去就行：从xmeta跳回时只能识别到这个，然后才去local读code。其他toy跳转过来不读
const CLIENT_ID     = 'xmeta_v8lTN7_zee7Kv11TxkN7BQ'
// CLIENT_ID：你的 toy 在 XMETA 里认领后拿到，一个 toy 对应一个

const loginBtn = document.querySelector('#你的按钮')   // id 和按钮文字都随意

loginBtn.onclick = () => {
  // App 内 navigate 不透传 extra，先写一份给中心 toy
  localStorage.setItem('xmeta:req', JSON.stringify({
    cid: CLIENT_ID, ts: Date.now(), claimed: false
  }))

  // 不能跨 await，必须直接写在 click 里
  toy.navigate({
    type: 'toy',
    id: CENTER_SLUG,
    extra: { cid: CLIENT_ID }
  }).catch(e => console.error(e))
}
```

Web 端 `extra` 会变成地址上的 `?cid=`；App 端原生跳转不带 `extra`，只能靠这份 `xmeta:req`。地址上的 `from_spmid` 只说明「你从哪个 toy 来的」，中心 toy 拿它做来源校验，不用它找 `client_id`。

## 第二步：回来读 code

中心 toy 跳回来之前，已经把 code 写进 localStorage，键名是约定好的 `xmeta:code`：

```js
// { v, clientId, code, returnSlug, expiresAt, ts }
```

```js
function readCode() {
  // App：读中心 toy 写好的约定槽
  try {
    const p = JSON.parse(localStorage.getItem('xmeta:code') || 'null')
    if (p && p.code && p.clientId === CLIENT_ID && p.expiresAt >= Date.now()) {
      return p.code
    }
  } catch (e) {}

  // Web：中心 toy 把 code 拼在地址上带回来
  return new URLSearchParams(location.search).get('code')
}

const code = readCode()
```

## 第三步：用 code 换 JWT

```js
async function redeem(code) {
  const res = await fetch(API + '/api/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      client_id: CLIENT_ID
    })
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error?.message || res.status)
  return data   // data.access_token 就是 JWT
}
```

```js
if (code) {
  const { access_token, expires_in } = await redeem(code)
  localStorage.removeItem('xmeta:code')   // 换成功才删
}
```

## 注意

**拿到之后**

```txt
JWT 怎么存、怎么带，xmeta 不管，接入方自己决定。

如果存 localStorage：www.bilibilitoy.com 下所有 toy 同源，别的 toy 也读得到，不安全但操作简单。
如果存cloudStorage的话，注意获取云存储是异步的，在读和存jwt之前都要等待异步结束再操作。否则容易出BUG
不存的话，刷新页面就要重新走一遍授权，存本地，重启B站APP就丢失，需要重新申请。
```

**过期时间**

不用公钥，payload 是明文：

```js
const payload = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
payload.exp * 1000   // 过期时间
```

刚换完更直接：响应里的 `expires_in` 就是秒数。

**公钥**

```txt
从这里可以获取公钥，有了公钥就可以再自己的服务器自己解析用户的jwt：
https://www.oxth.com:8443/.well-known/jwks.json

只用来验签（ES256）。验签放在 toy 自己的服务端做，顺便核对 aud === 你的 toy_id。
纯前端验签没有意义。
```

## 不想手写？用 SDK

用 script 标签依次引入下面两个地址：

```txt
//s1.hdslb.com/bfs/seed/toy/app/sdk/toy-sdk.js
https://www.oxth.com:8443/xmeta-client.js
```

```js
XMETA.configure({
  apiBase: API,
  centerToySlug: CENTER_SLUG,
  centerToyId: CENTER_TOY_ID,
  clientId: CLIENT_ID
})

loginBtn.onclick = () => XMETA.login()          // 必须在用户手势里
XMETA.onCodeReady(() => XMETA.completeLogin())  // 检测到 code 就兑换
XMETA.onSession(s => console.log(s.jwt))
```

SDK 会自己把会话存进 localStorage。不接受存本地，就别用它，按上面三步走。

## 报错看这里

| 页面提示 | 多半是 |
|---|---|
| navigate requires user activation | 跨了 `await`，或不是用户手势 |
| 没有待兑换的授权码 | code 过期 / 换过 / `client_id` 不对 |
| code_used | 已被另一个页面实例换走 |
| code_expired | 超过 60 秒，重新申请 |
| 401 | JWT 过期，或 `aud` 不是你的 toy |

---

**为什么要 code 换 JWT？** code 一次性、60 秒、只对签发它的 toy 有效；JWT 也绑死 `aud`，A toy 的凭证访问不了 B toy。

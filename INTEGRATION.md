# 第三方 toy 接入：验签与用户身份

你是第三方 toy 的作者，玩家从 xmeta 拿着一枚 **JWT** 回到你的玩具。这份文档说清楚：
**这枚令牌怎么验、公钥从哪来、验过之后怎么从里面取出用户身份。**

> 一句话概括：令牌是 xmeta 用**私钥**签的，你用**公钥**验。验过就说明「这枚令牌
> 确实是 xmeta 发的、内容没被改过」，且「它是发给**你这个 toy** 的」。
> 你不用问 xmeta，也不用给它任何回调地址 —— **你只需要一个公钥**。

---

## 0. 你会拿到什么

| 东西 | 从哪来 | 用途 |
|---|---|---|
| `client_id` | 在中心 toy 认领自己的 toy 后拿到 | 前端 `XMETA.configure({ clientId })`，你后端用不到 |
| **你的 toy_id** | `curl 'https://api.bilibili.com/x/sunflower/artifex/toy/detail?slug=<你的slug>'` → `data.id` | ★ **必须**拿它校 `aud` |
| xmeta 的 API 基址 | 就是发这枚令牌的那个域名，例如 `https://www.oxth.com:8443` | 取公钥、必要时调 introspect |

> `toy_id` 是个数字串（bigint 的量级），**别用 JS 的 number 存** —— 会丢精度。
> 用字符串。

---

## 1. 公钥从哪拿

标准 JWKS，公开、无鉴权：

```
GET {API_BASE}/.well-known/jwks.json
```

```json
{
  "keys": [
    { "kty": "EC", "crv": "P-256", "kid": "xxxxxxxx", "use": "sig", "alg": "ES256",
      "x": "...", "y": "..." }
  ]
}
```

几个要点：

- **只有公钥**，私钥不出门（谁都能验，但只有 xmeta 能签）。
- **`kid` 可能不止一个**：xmeta 轮换密钥时，新旧会同时发布一段时间。**按 `kid` 挑**，
  别写死一把 —— 用现成的库就不用操心这件事。
- 响应带 `Cache-Control: public, max-age=300`，缓存 5 分钟很安全。
- 别把这个 URL 写死：`GET {API_BASE}/.well-known/xmeta-configuration` 里有
  `jwks_uri` 和 `issuer`，从那儿取更稳。

---

## 2. 令牌怎么到你手上

前端拿到之后交给你，**放在 `Authorization` 头里**：

```js
XMETA.onSession(s => {
  // s.jwt 就是那枚令牌，s.uid 是从里面解出来的 sub（方便你前端展示用）
  fetch('/api/xxx', { headers: { Authorization: 'Bearer ' + s.jwt } })
})
```

几点规矩：

- **不要放进 URL / query**（会进日志、进浏览器历史）。前端那侧 xmeta 已经特意
  只下发一次性 `code` 就是这个道理。
- 你的后端**自己存**（会话 / cookie / 设备），但要**自己管过期**：`exp` 到了就是
  无效，别延长。
- 令牌里**没有昵称头像**。要展示的话，在自己页面上调一次
  `toy.getUserProfile()` 拿（那是 B站 给当前用户的公开资料，纯展示用 ——
  **别拿它返回的 `toyOpenId` 当身份**，那是另一个命名空间里的东西，和 `sub` 不是一回事）。

---

## 3. 后端验签（Node / `jose`）

```js
import { createRemoteJWKSet, jwtVerify } from 'jose'

const API_BASE = 'https://www.oxth.com:8443'   // xmeta 的地址（固定，就是发你令牌的那个域名）
const MY_TOY_ID = '27289601636352'             // ★ 你自己的 toy_id，字符串

// 会自己缓存公钥、按需刷新
const JWKS = createRemoteJWKSet(new URL(API_BASE + '/.well-known/jwks.json'))

/** 从请求里解出用户 uid；验不过就抛 */
async function requireUid(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token) throw new Error('没有令牌')

  const { payload } = await jwtVerify(token, JWKS, {
    issuer: API_BASE,        // 必须是 xmeta 的基址
    audience: MY_TOY_ID,     // ★ 必须是自己的 toy_id
    algorithms: ['ES256'],   // 锁死算法，别让攻击者挑
  })

  return payload.sub         // ← 自己库里的用户主键
}
```

其它语言都是同一套：**取 JWKS → 按 `kid` 找公钥 → 验 ES256 签名 → 校 `iss` / `aud` / `exp`**。

| 语言 | 用什么 |
|---|---|
| Node / 浏览器 | `jose`（上面这套） |
| Python | `PyJWT` + `PyJWKClient` |
| Go | `github.com/golang-jwt/jwt/v5` + `github.com/MicahParks/keyfunc` |
| Java / Kotlin | `nimbus-jose-jwt` 的 `RemoteJWKSet` |
| PHP | `firebase/php-jwt` + `CachedKeySet` |

---

## 4. 必须校的四样

| 校验 | 为什么 |
|---|---|
| **签名**（ES256） | 确认真是 xmeta 签的、没被改过。**顺手锁死 `algorithms`** —— 不锁的话某些库会被 `alg` 头骗（`alg: none` / 换成 HS256 拿公钥当密钥算） |
| **`aud` == 自己的 toy_id** ★ | 不校的话，A toy 的令牌能拿到你这里冒充用户 —— 这是最容易漏、后果最重的一条 |
| **`iss` == xmeta 的基址** | 万一你同时接了好几个身份服务，防止串台 |
| **`exp`** | 过期就是无效。库一般自动校 |

---

## 5. 令牌里有什么（解出来长这样）

```json
{
  "iss": "https://www.oxth.com:8443",   // 签发方
  "sub": "42",                          // ★ 用户 uid —— 你该用的就是它
  "aud": "27289601636352",              // ★ 目标 toy_id —— 必须校
  "jti": "5f3c…",                       // 令牌唯一 id（现在没用上，将来做吊销会用到）
  "iat": 1791041000,                    // 签发时刻（秒）
  "iat_ms": 1791041000123,              // 毫秒版，可忽略
  "exp": 1791041900                     // 到期时刻。用户授权时自己选的，3~24 小时
}
```

- payload 是 **base64url，不是加密** —— 谁拿到都能解开看。所以里面**没有**任何隐私
  字段：没有昵称头像、没有 B站 UID、没有别的 toy 的任何信息。
- **`sub` 就是这个人在你这儿的唯一身份**。拿它当主键建你自己的用户表，别的都不用管。
- ⚠️ **`sub` 是跨 toy 稳定的**。所以别把它直接展示出去，也别把它塞进公开可读的数据里 ——
  否则同一个人玩 A、B 两款 toy，两边的玩家一对照就知道是同一个人。要署名感就用
  `HMAC(你的密钥, toy_id + sub)` 取前几位当假名：同 toy 内稳定，跨 toy 对不上。

---

## 6. 想再确认一次：`introspect`

刚拿到令牌、或者你怀疑的时候，可以调：

```bash
curl -X POST {API_BASE}/api/oauth/introspect \
  -H 'Content-Type: application/json' \
  -d '{"token":"<那枚 JWT>"}'
# → { "active": true, "uid": "42", "audience": "27289601636352",
#     "iat": 1791041000, "exp": 1791041900, "remaining": 8321 }
```

**别每个请求都调这个。** 它能做的只是「再验一次签名 + 报一下剩余时长」，
你自己用公钥验完全一样、还不用走网络。它的意义在于「服务端权威确认一次」，
适合放在登录那一刻。同理，它**只验签名和 `iss`**，`aud` 得你自己比。

---

## 7. 验签失败排查

| 现象 | 多半是 |
|---|---|
| 签名验不过 | 拿的是**别的服务**的令牌；或者 JWKS 缓存太久，xmeta 刚轮换完密钥（清缓存/等 5 分钟重取） |
| `iss` 对不上 | `API_BASE` 写错了 —— 注意**端口号也要一致**（例如 `:8443`） |
| `aud` 对不上 | 拿了别的 toy 的令牌，或者 `MY_TOY_ID` 填错了（是**你**的 toy_id，不是 xmeta 的） |
| 令牌解不开 / 缺字段 | 前端塞进 `Authorization` 的时候带上了引号、或者中间被截断了 |
| 昨天还好好的今天全失效 | `exp` 到了（用户选的时长用完），让用户回中心 toy 重新授权一次 |

---

## 8. 安全底线

- **令牌只回答「用户是谁」，不回答「用户能做什么」。** 权限、封禁、是不是管理员 ——
  全部在你自己服务端判。别把角色写进令牌去信任。
- **私钥永远拿不到**，也不该需要 —— 你只需要公钥。反过来说：**能验签的不只有你**，
  任何人都能验。所以令牌本身不保密，别当成密码来保管。
- **没有「吊销某一枚令牌」这回事**：xmeta 不存令牌记录。用户手上的令牌到期才失效；
  真出事只能在 xmeta 那侧轮换密钥（全体重授权）。你自己要踢人，就维护一份自己的
  黑名单（按 `sub` 或 `jti`）。
- 令牌进你后端以后，按你对待会话凭证那套来：不进日志、不进 URL、不进前端渲染。

---

## 附：最小可用清单

1. 拿到你的 `toy_id`（字符串）和 xmeta 的 `API_BASE`
2. 后端接上 JWKS（`createRemoteJWKSet` 之类，让它自己缓存）
3. 每个请求：`Authorization: Bearer` → 验签 → 校 `iss` / `aud` → 取 `sub`
4. 用 `sub` 当自己库里的用户主键
5. 权限、封禁、展示用的昵称头像，全部自己另外处理

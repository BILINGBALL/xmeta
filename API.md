# xmeta 接口文档

给**接入方**看的（第三方 toy 的作者，以及它们的服务端）。
中心 toy 自己那几个页面怎么用这些接口，在 [README.md](README.md)；服务端怎么验签、怎么从令牌里取用户身份，在 [INTEGRATION.md](INTEGRATION.md)。

- **服务基址**：就是你部署时填的 `PUBLIC_BASE_URL`（下文的 `https://your-api.example.com` 都是它）。线上**必须 https** —— toy 页面跑在 https 上，调 http 会被浏览器按混合内容拦掉。
- 所有请求/响应都是 JSON，请求体上限 64 KB。
- 时间一律是 ISO 8601 字符串（`2026-10-10T12:00:00.000Z`）。

---

## 目录

- [0. 五分钟版](#0-五分钟版)
- [1. 通用的几件事](#1-通用的几件事)
- [2. 认领](#2-认领)
- [3. 过桥](#3-过桥)
- [4. 令牌](#4-令牌)
- [5. 联机数据](#5-联机数据)
- [6. 统计与元信息](#6-统计与元信息)
- [7. 错误码总表](#7-错误码总表)

---

## 0. 五分钟版

一个第三方 toy 接进来只有三件事：

1. **认领**（一次性，作者做）：证明「这个 toy 是你发布的」，换一枚 `client_id`。
2. **过桥**（每个用户做）：用户点授权，拿到一枚 60 秒命的一次性 `code`。
3. **换令牌**：`code` 换 JWT，之后所有数据请求带这枚 JWT。

用 SDK 的话，第 2、3 步各一行（[README](README.md) 有完整例子）：

```js
document.querySelector('#login').onclick = () => XMETA.login()      // 必须在用户手势里同步调用
XMETA.onCodeReady(() => XMETA.completeLogin())                        // 回到页面后兑换
XMETA.onSession(s => console.log('uid =', s.uid, 'jwt =', s.jwt))
```

不用 SDK 也行 —— [README 的「坑」一节](README.md#几个必须知道的坑) 写了 `xmeta:code` 这个共享槽的契约，照着读就行。

---

## 1. 通用的几件事

### 1.1 两类接口，两种认证

| | 认证方式 | 谁调 |
|---|---|---|
| **身份类**<br>`/api/claim/*`、`/api/toy/*`、`/api/bridge/*`、`/api/oauth/token`、`/api/me` | 请求体里的 `toyOpenId` | 中心 toy 的页面 |
| **数据类**<br>`/api/kv/*`、`/api/user/profiles` | `Authorization: Bearer <jwt>` | 第三方 toy |

数据类接口的归属**只看 JWT**：命名空间取 `aud`（你的 toy_id），用户取 `sub`，**绝不读请求体里的 toy/uid**。

### 1.2 `toyOpenId` 只走 POST body

它是密钥级数据 —— 泄漏了别人就能冒用你的身份换 JWT。所以它**只允许出现在 POST 的请求体里**，不进 URL、不进日志（服务端的日志里这两个字段被 redact 掉了）。

`toyOpenId` 的格式要求：8~512 个可打印 ASCII 字符。太短通常是中心 toy 没开 OpenID 模式。

### 1.3 请求体里没写的字段呢？

看接口：

- `PUT /api/kv/:scope`：**没写就清空**（整行覆盖）。
- `PATCH /api/kv/:scope`：**没写就是不动**；显式传 `null` 才是清空。

### 1.4 出错长什么样

```json
{
  "error": {
    "code": "forbidden",
    "message": "这一格是私有的",
    "detail": { }
  }
}
```

**按 `code` 分支，别按 `message` 匹配** —— `code` 是机器可读且稳定的，`message` 是给人看的，随时会改。`detail` 不一定有（参数校验失败时会带 zod 的 issues）。

另外两种非业务错误：

| 情况 | code | HTTP |
|---|---|---|
| 请求体不是合法 JSON、缺 `Content-Type` 等 | `bad_request` | 4xx |
| 服务端炸了 | `internal_error` | 500 |
| 路径不存在 | `not_found` | 404 |

### 1.5 限流

固定窗口，**60 秒**一次；超了返回 `429` + `rate_limited`，`detail.retryAfter` 是还要等几秒。

| 接口 | 上限 | 按什么算 |
|---|---|---|
| `POST /api/claim/start` | 20 | IP |
| `POST /api/claim/verify` | 10 | IP |
| `POST /api/toy/mine` | 60 | IP |
| `POST /api/toy/refresh` | 10 | IP |
| `GET /api/bridge/context` | 120 | IP |
| `POST /api/bridge/authorize` | 30 | IP |
| `POST /api/oauth/token` | 60 | IP |
| `POST /api/oauth/introspect` | 120 | IP |
| `POST /api/me` | 60 | IP |
| `GET /api/stats` | 60 | IP |
| `GET /api/kv/:scope`（读一格） | 240 | **uid** |
| `GET /api/kv/:scope/list` | 120 | **uid** |
| `PUT` / `PATCH /api/kv/:scope`（写） | 120 | **uid** |
| `GET /api/kv/:scope/:uid/log` | 120 | **uid** |
| `POST /api/user/profiles` | 120 | **uid** |
| `DELETE /api/kv/:scope/:uid`、`DELETE /api/kv/:scope` | 30 | **uid** |

> 数据类的额度是**按 uid** 算的，不是按 IP —— 一个 toy 的所有玩家各算各的。
>
> 限流是单实例内存态的，多实例部署要换 Redis（见 README 的「还没做」）。

### 1.6 CORS

默认只放行 `https://www.bilibilitoy.com`（toy 内层 iframe 的源）。要加就改 `ALLOWED_ORIGINS`（逗号分隔）。预检缓存 10 分钟。

---

## 2. 认领

### POST /api/claim/start

发起认领：服务端查一下这个 slug 的 toy，生成一枚 nonce 让作者写进源码。

**请求**

```json
{
  "toyOpenId": "xxxxxx",
  "nickname": "昵称",
  "avatar": "https://...",
  "slug": "your-toy-slug"
}
```

`nickname` / `avatar` 可选。`slug` 只能含字母、数字、下划线、短横线，最长 64。

**响应** —— 还没认领过（有 `nonce` 和指引）：

```json
{
  "state": "pending",
  "toyId": "27289601636352",
  "slug": "your-toy-slug",
  "title": "我的玩具",
  "authorName": "作者名",
  "iconUrl": "https://...",
  "nonce": "a1b2c3...",
  "reused": false,
  "expiresAt": "2026-10-11T12:00:00.000Z",
  "attemptsLeft": 10,
  "instructions": "把下面这行加进你 toy 的 index.html..."
}
```

| 字段 | 说明 |
|---|---|
| `nonce` | 要写进 `index.html` 的那串验证码 |
| `reused` | `true` 表示沿用了上次那枚（**重复发起不会换码**，别以为变了） |
| `expiresAt` | nonce 的有效期，默认 24 小时 |
| `attemptsLeft` | 还能验几次，默认 10 |

**响应** —— 已经认领过（幂等）：

```json
{ "state": "verified", "toyId": "...", "slug": "...", "title": "...",
  "clientId": "xmeta_xxx", "message": "这个 toy 已经归你所有了" }
```

**错误**：`toy_not_found`(404)、`toy_already_claimed`(409，别人认领走了)、`invalid_param`(400)、`rate_limited`(429)。

---

### POST /api/claim/verify

真的去 `bilibilitoy.com` 抓你的页面源码，看里面有没有那枚 nonce。通过就下发 `client_id`。

**请求**

```json
{ "toyOpenId": "xxxxxx", "nickname": "昵称", "avatar": "https://...", "slug": "your-toy-slug" }
```

**响应**

```json
{ "state": "verified", "toyId": "27289601636352", "slug": "your-toy-slug", "clientId": "xmeta_xxx" }
```

**错误**

| code | HTTP | 说明 |
|---|---|---|
| `nonce_not_in_source` | 422 | 源码里没找到验证码。常见原因：改完没点发布、写到了别的文件、源码里还留着旧验证码 |
| `claim_not_found` | 404 | 没进行中的认领，先调 `start` |
| `claim_expired` | 410 | nonce 过期了，重新发起 |
| `claim_attempts_exceeded` | 429 | 验太多次了，重新发起 |
| `upstream_fetch_failed` | 502 | 抓 B站 页面失败，稍后重试 |
| `upstream_blocked` | 400 | 目标地址不在允许的域名内 |
| `toy_already_claimed` | 409 | 已被别人认领 |

> **为什么用 nonce 而不是比对用户资料**：`toy.getUserProfile()` 不返回 mid，昵称/头像又是客户端上报的，谁都能伪造。nonce 证明的是「**你有权发布这个 toy 的内容**」—— 要往 `index.html` 里加东西，必须有 B站 toy 后台的发布权限，这才是真凭证。

---

### POST /api/toy/mine

我认领了哪些 toy。

**请求**：`{ "toyOpenId": "xxxxxx" }`

**响应**

```json
{
  "uid": "42",
  "nickname": "昵称",
  "toys": [
    { "toyId": "...", "slug": "...", "title": "...", "iconUrl": "https://...",
      "authorName": "...", "state": "verified", "clientId": "xmeta_xxx", "revoked": false }
  ]
}
```

`state` 是 `pending`（还没验完）或 `verified`。`revoked` 目前恒为 `false`（撤销接口还没做）。

---

### POST /api/toy/refresh

作者手动刷新自己 toy 的元数据（图标、作者名/头像），走 B站 detail 接口重新拉一遍。只有该 toy 的所有者能调。

**请求**：`{ "toyOpenId": "xxxxxx", "slug": "your-toy-slug" }`

**响应**

```json
{ "toyId": "...", "slug": "...", "title": "...", "iconUrl": "https://...",
  "authorName": "...", "state": "verified", "clientId": "xmeta_xxx",
  "revoked": false, "syncedAt": "2026-10-10T12:00:00.000Z" }
```

**错误**：`toy_not_found`(404)、`forbidden`(403，你不是该 toy 的所有者)、`rate_limited`(429，10 次/分钟)。

---

## 3. 过桥

```
第三方 toy               中心 toy（我的页面）            服务端
    │                          │                          │
    │ ① toy.navigate(slug)     │                          │
    ├─────────────────────────►│                          │
    │                          │ ② GET /api/bridge/context?cid=      │
    │                          ├─────────────────────────►│
    │                          │◄── 玩具信息 ─────────────┤
    │                          │                          │
    │                          │ ③ 用户点「同意授权」        │
    │                          │    toy.getUserProfile()  │
    │                          │ ④ POST /api/bridge/authorize        │
    │                          ├─────────────────────────►│
    │                          │◄── 一次性 code（60 秒） ──┤
    │                          │                          │
    │ ⑤ 带 code 跳回来           │                          │
    │◄─────────────────────────┤                          │
    │                                                     │
    │ ⑥ POST /api/oauth/token ───────────────────────────►│
    │◄────────────────────────────── JWT ─────────────────┤
```

### GET /api/bridge/context?cid=&lt;client_id&gt;

过桥页加载时用：确认这枚 client_id 有效，顺便拿要展示的玩具信息。

**响应**

```json
{
  "clientId": "xmeta_xxx",
  "toyId": "27289601636352",
  "slug": "your-toy-slug",
  "title": "我的玩具",
  "iconUrl": "https://...",
  "authorName": "...",
  "authorMid": "...",
  "ttlSeconds": 60
}
```

`ttlSeconds` 是授权码的有效期。

**错误**：`invalid_param`(400，缺 cid)、`client_not_found`(404)、`toy_not_verified`(403)。

---

### POST /api/bridge/authorize

用户点了「同意授权」之后调用，请求体里带 `toy.getUserProfile()` 的结果。

**请求**

```json
{
  "toyOpenId": "xxxxxx",
  "nickname": "昵称",
  "avatar": "https://...",
  "cid": "xmeta_xxx",
  "fromToyId": "27289601636352",
  "ttl": 6
}
```

| 字段 | 说明 |
|---|---|
| `cid` | 要授权的 client_id，最长 128 |
| `fromToyId` | **必填**。这一跳来自哪个 toy_id —— 授权页从地址上读出来的（App 端是原生拼的 `from_spmid`，Web 端是 SDK 拼的 `spm_id_from`）。服务端拿它和 cid 反查出来的 toy 比，对不上直接 `403` |
| `ttl` | 可选，用户选的授权时长（小时），只接受 `3` / `6` / `12` / `24`。不传按 `6` |

**响应**

```json
{
  "code": "一次性授权码",
  "returnSlug": "your-toy-slug",
  "returnToyTitle": "我的玩具",
  "expiresIn": 60,
  "tokenTtlSeconds": 21600
}
```

| 字段 | 说明 |
|---|---|
| `code` | 一次性，60 秒命，**只对签发它的那个 toy 有效** |
| `returnSlug` | 回跳目标。**由服务端按 cid 查库决定**，不取 URL 参数（防开放重定向） |
| `expiresIn` | `code` 自己的有效期（秒） |
| `tokenTtlSeconds` | 这枚 code 换出来的 JWT 能活多久（`ttl` × 3600） |

**错误**：`client_not_found`(404)、`toy_not_verified`(403)、`source_toy_mismatch`(403，来源和 cid 不是同一个 toy)、`invalid_param`(400，ttl 不在档位里)、`rate_limited`(429)。

> **`source_toy_mismatch` 是干什么的**：`client_id` 不保密（它本来就在跳转链接里），所以抄走别人包体的人照样能把流程跑起来。他唯一改不了的是平台在跳转时盖在地址上的那个「来自哪个 toy」—— 报上来一比就知道「他在替谁要凭证」和「他自己是谁」对不上。
>
> 为了不给抄的人递线索，这个错误**不会回带原 toy 的 id**。要排查就去看授权页写在 `localStorage['xmeta:bridge']` 里的东西。

---

## 4. 令牌

### POST /api/oauth/token

用一次性 code 换 JWT。

**请求**

```json
{ "grant_type": "authorization_code", "code": "一次性授权码", "client_id": "xmeta_xxx" }
```

**响应**

```json
{
  "access_token": "eyJhbGciOiJFUzI1NiIs...",
  "token_type": "Bearer",
  "expires_in": 21600,
  "audience": "27289601636352",
  "toy_slug": "your-toy-slug"
}
```

`audience` 就是你的 toy_id，方便自检这枚 token 只对你有效。`expires_in` 是用户选的那个时长（秒）。

**错误**

| code | HTTP | 说明 |
|---|---|---|
| `invalid_code` | 400 | 码不存在，或者 `client_id` 和签发这枚码的 toy 对不上 |
| `code_expired` | 410 | 超过 60 秒了，回中心 toy 重新过桥 |
| `code_used` | 409 | 已经被兑换过了 |
| `client_not_found` | 404 | client_id 不存在或已失效 |
| `toy_not_verified` | 403 | 这个 toy 还没完成认领 |

> **没有 PKCE，code 就是唯一的凭据。** 敢这么简化是因为 `code` 的暴露面已经被压得很小：60 秒命、一次性、只对签发它的那个 toy 有效。这是给玩具生态用的，不是给银行用的。
>
> 代价说清楚：`code` 会出现在 URL 里，谁在这 60 秒内看到它、又抢在你前面兑换，谁就能顶掉你这一次登录。要回到 PKCE，`auth_code` 表那三列还在，加回去就行。
>
> 注意 code 是**先消费再校验**的：取走即作废，后面任何一步失败都不会放回去。

---

### POST /api/oauth/introspect

查一枚 token 还有效吗。纯查询，不改状态。JWT 是自包含的，本地验签只能验出「签名对、没过期」；这个端点让**你的服务端**再确认一次。

**请求**：`{ "token": "eyJ..." }`

**响应**（有效）

```json
{ "active": true, "uid": "42", "audience": "27289601636352",
  "iat": 1791041000, "exp": 1791041900, "remaining": 8432 }
```

**响应**（无效、过期、iss 不对 —— 一律 `active: false`，不区分原因）

```json
{ "active": false }
```

> 故意不区分失败原因，否则这个端点就成了一把探针。

---

### JWT 长什么样

Header：`{ "alg": "ES256", "kid": "...", "typ": "JWT" }`

Payload：

```json
{
  "iss": "https://your-api.example.com",
  "sub": "42",                    // xmeta 内的用户 id，不是 B站 UID
  "aud": "27289601636352",        // ★ 你的 toy_id，必须校验
  "jti": "...",
  "iat": 1791041000,              // 整秒（标准 NumericDate）
  "iat_ms": 1791041000123,        // 签发时的毫秒时间戳，可忽略
  "exp": 1791041900
}
```

**`aud` 一定要校验**，不然 A toy 拿到的 token 能被 B toy 拿去冒充用户。怎么验写在 [INTEGRATION.md](INTEGRATION.md)。

---

## 5. 联机数据

给接入方一个**数据交换**用的格子。一行 = 一个用户在一个 `scope` 下的一条数据。

> **它不是长期存储。** 作者该有自己的持久化，xmeta 只负责「把数据从 A 交换到 B」。

### 5.1 两条硬约束

- **额度**：普通用户每个 toy 最多 **128 条**，toy 作者 **512 条**（按**这条数据的属主**算）。超了 `quota_exceeded`(409)。
- **强制过期**：写入时可以带 `ttl`（**秒**）定有效期，不带就按 7 天。带一次就从**当前时刻**重算一次 —— 也就是说续期是显式的：`PATCH { "ttl": 2592000 }`。单次最多 30 天，**续期本身不封顶**。到点就查不到了。

### 5.2 权限一表

| 动作 | 谁能做 |
|---|---|
| 读一条 | 自己的随便读；别人的要 `isPublic: true`；**作者能读本 toy 全部（含别人的私有数据）** |
| 建 | 自己的随便建；`admin` 开头的 scope 只有作者能建 |
| 改自己的 | 全部字段 |
| 改别人的 | 只能动 `openEdit` 里列的字段（**`extra` 永远不在里面**） |
| 删 | 属主删自己那条（腾额度，不用等过期）；作者能删本 toy 任何一条 |

> **「私有」是对其他玩家私有，对作者不是。** 玩家写进 xmeta 的东西作者看得到，别让人误以为作者也看不到。

### 5.3 数据字段

请求体里用**驼峰**，响应里也用驼峰：

| 字段 | 类型 / 范围 | 说明 |
|---|---|---|
| `tagTinyint` | 0 ~ 255 | 数字标签。当 boolean 用就传 0/1 |
| `tagInt1` | ±32767 | 数字标签 |
| `tagInt2` | ±21 亿 | 数字标签 |
| `tagBigint` | 字符串 | 超出 JS 安全整数，所以**收字符串**（`"-9007199254740993"`），也收小整数 |
| `text1` | ≤ 128 字符 | |
| `text2` | ≤ 512 字符 | |
| `textLong` | ≤ 1024 字符 | 超长请放 `extra` |
| `extra` | ≤ 2048 字节 | 任意 JSON。**别人永远改不了**，只有属主和作者能动 |

四个数字标签语义完全由玩具自己定（等级、血量、是否出战……）。

字段名一律**驼峰**，请求和响应都一样。**写错名字不会被静默放过** —— 两个写接口的 schema 都是 strict 的：`tag_int1` 这种会 `400`，报错里还会点出是哪个字段。

### 5.4 `?uid=` 参数

默认操作**自己的**数据。带 `?uid=<别人的uid>` 就能指定别人 —— 「改别人的数据」本来就是 `openEdit` 的用法（世界 boss 就是靠这个让大家一起打）。

**指定成别人不会自动获得权限**：读仍然要求 `isPublic`，写仍然受 `openEdit` 约束。唯一「指定别人」本身就是作者专属的动作是**创建**别人的数据。

`uid` 不存在会返回 `invalid_param`(400)。

---

### GET /api/kv/:scope

读一条数据。

**Query**：`?uid=`（可选，见 5.4）

**响应**

```json
{ "data": { /* Row，见 5.6 */ } }
```

没建过、或者已经过期 → `{ "data": null }`。**这不是错误**，别当失败处理。

**错误**：`forbidden`(403，别人的私有数据)、`unauthorized`(401)。

---

### GET /api/kv/:scope/list

列这个 scope 下的数据。**非作者只看得见 `isPublic` 的那些。**

**Query**

| 参数 | 默认 | 说明 |
|---|---|---|
| `page` | 1 | |
| `size` | 20 | 一页最多 100 |
| `tagTinyint` | — | 按这个数字标签精确筛选 |

**响应**

```json
{ "items": [ /* Row */ ], "page": 1, "size": 20, "total": 3, "hasNext": false }
```

---

### PUT /api/kv/:scope

**整行覆盖**。属主或作者；不存在则新建。

**Query**：`?uid=`（可选）

**请求** —— 没写的字段会被**清空**，日常别用它，改数据用 PATCH：

```json
{
  "ttl": 604800,
  "isPublic": false,
  "openEdit": ["tagInt1"],
  "tagInt1": 100,
  "text1": "我的背包",
  "extra": { "items": ["sword"] }
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `ttl` | 604800 | 有效期（**秒**），1 ~ 2592000（30 天）。带上它就把过期时刻从当前时刻重算 |
| `isPublic` | `false` | |
| `openEdit` | `[]` | 别人能改哪些字段，见 5.5 |

**响应**

```json
{
  "data": { /* 写完之后的整行 */ },
  "created": true,
  "changed": ["tagInt1", "text1", "isPublic", "openEdit"]
}
```

`changed` 里是**接口字段名**（驼峰）。新建时会把所有被写入的列都列出来。

**错误**：`forbidden`(403，建别人的数据 / 非作者建 `admin*` scope / 覆盖别人的数据)、`quota_exceeded`(409)、`invalid_param`(400)。

---

### PATCH /api/kv/:scope

**部分更新**。属主全字段；别人的数据只能动 `openEdit` 里列的。

**Query**：`?uid=`（可选）

**请求**

```json
{ "text1": "只改这一项", "inc": { "tagInt1": -10 } }
```

没写的字段**不动**；显式传 `null` 才是清空。

**`ttl` 也一样**：不带就一动不动，带了才从当前时刻重算过期时间。所以「顺手改个字段」不会把有效期也续上。

#### `inc` —— 原子加减

```json
{ "inc": { "tagInt1": -10 } }
```

只认 `tagTinyint` / `tagInt1` / `tagInt2` / `tagBigint` 四个数字标签。

**为什么需要它**：客户端「读出来 + 2 再写回去」在并发下必然丢更新（A 读到 1、B 也读到 1，各写 3 和 4，最后是 4 不是 6）。把**增量**交给服务端，一条 `col = col + $n` 才是原子的 —— 同行并发加减永远不会丢。

**不做任何业务边界**：血量能不能变负、负数在游戏里什么意思，是玩具自己的事（前端把 `-100HP` 显示成 `0HP` 就行）。服务端只保证不超出列类型范围 —— 超了返回 `invalid_param`(400)。

同一个字段不能既赋值又加减，会 `invalid_param`(400)。

**响应**

```json
{ "data": { /* 写完之后的整行，inc 的新值也在里面，不用再查一次 */ },
  "changed": ["tagInt1", "text1"] }
```

**错误**：`not_found`(404，这条数据还不存在，请先用 PUT 建)、`forbidden`(403，改别人没开放的字段)、`invalid_param`(400)。

---

### DELETE /api/kv/:scope/:uid

删一条数据。路径里的 `:uid` 就是这条数据的属主 —— 删自己的传自己的 uid；作者可以传任何人的。

**响应**

```json
{ "deleted": 1, "data": { /* 被删掉的那一行 */ } }
```

回带整行是因为客户端要显示「删掉了什么」，而此刻已经查不到了。

**错误**：`forbidden`(403，删别人的)、`not_found`(404)。

---

### DELETE /api/kv/:scope?all=1

删掉整个 scope（**所有人的**数据，日志跟着级联删）。只有 toy 作者能调。

**必须显式带 `?all=1`**，不然 `invalid_param`(400) —— 免得手滑。

**响应**

```json
{ "deleted": 12, "scope": "package" }
```

---

### GET /api/kv/:scope/:uid/log

某一条数据的改动记录。**读权限跟那条数据走**（私有数据的日志只有属主和作者看得到）。

**Query**：`page`(默认 1)、`size`(默认 20，最多 100)

**响应**

```json
{
  "items": [
    {
      "id": 901,
      "dataId": 77,
      "actorUid": "42",
      "action": "update",
      "changed": ["tagInt1", "text1"],
      "before": { "tagInt1": 100, "text1": "旧值" },
      "after":  { "tagInt1": 90,  "text1": "新值" },
      "createdAt": "2026-10-10T12:00:00.000Z"
    }
  ],
  "page": 1, "size": 20, "total": 2, "hasNext": false
}
```

| 字段 | 说明 |
|---|---|
| `actorUid` | **真正动手的人** —— 作者替玩家改的时候，这里记的是作者 |
| `action` | `create` 或 `update`（没有 delete 日志） |
| `changed` | 这次动了哪几个字段 |
| `before` / `after` | **只含被改字段**的前后值，不是整行快照。创建时 `before` 是 `null` |

> `changed` / `before` / `after` 和写接口响应里的 `changed` 用同一套字段名（驼峰）。

💡 **日志是白送的事件流。** 要记「谁打了 boss 多少血」「谁来过我家」这类流水，从这里拿就行，不用每件事占一条数据 —— 怎么写见 [GUIDE.md 场景六](GUIDE.md#场景六日志当事件流谁干了什么)。

**错误**：`not_found`(404，那条数据不存在或已过期)、`forbidden`(403，私有数据的日志)。

---

### POST /api/user/profiles

数据里只存 `uid`（作者那边也该只存 id、渲染在本地），要显示名字就来这里换。

**请求**：一次最多 50 个

```json
{ "uids": ["42", "466"] }
```

`uid` 只能是数字字符串。

**响应**

```json
{ "profiles": [ { "uid": "42", "nickname": "昵称", "avatar": "https://..." } ] }
```

**只包含「在你这个 toy 出现过的人」** —— 没出现过的直接不出现在结果里（不是报错）。

> **为什么要这道限制**：`uid` 是全平台唯一的，放开就等于开了一个「拿 uid 枚举全平台用户资料」的入口。限定在自己 toy 的玩家范围里，排行榜那种场景照样够用。
>
> 昵称/头像是**客户端上报的**（`getUserProfile` 来的），只当展示用，别拿它做鉴权或唯一性判断。头像 URL 是 B站 CDN 的，前端记得加 `referrerPolicy="no-referrer"`。

---

### 5.5 `openEdit` 能填什么

能且仅能填这 7 个字段：

```
tagTinyint   tagInt1   tagInt2   tagBigint   text1   text2   textLong
```

`extra`、`isPublic`、`scope`、`uid`、`openEdit`、`expiresAt` **永远不在名单里**（数据库还有一道 CHECK 兜着，API 写错也越不了权）。填了别的会 `invalid_param`(400)。

> 老代码里写的**数据库列名**（`tag_int1`）照样能用 —— 两种都收。库里存的始终是列名，出网一律换成字段名。新写就用字段名。

空数组 = 只读。

### 5.6 数据字典

**Row** —— 一条数据，读写接口返回的形状：

```json
{
  "uid": "42",
  "scope": "package",
  "isPublic": false,
  "openEdit": ["tagInt1"],
  "tagTinyint": 1,
  "tagInt1": 100,
  "tagInt2": 0,
  "tagBigint": 0,
  "text1": "我的背包",
  "text2": null,
  "textLong": null,
  "extra": { "items": ["sword"], "gold": 1000 },
  "expiresAt": "2026-10-17T12:00:00.000Z",
  "createdAt": "2026-10-10T12:00:00.000Z",
  "updatedAt": "2026-10-10T12:00:00.000Z"
}
```

字段名一律驼峰（`openEdit` 里的也是）。写错不会静默通过：会 `400`，报错里点出是哪个字段。

**Log** —— 一次改动，见上面的 log 接口。

---

## 6. 统计与元信息

### GET /api/stats

公开只读，返回的全是聚合数字，没有任何用户信息。

```json
{
  "toys": 12,
  "users": 345,
  "toyServices": 890,
  "tokens": 2345,
  "guardSeconds": 42000000
}
```

| 字段 | 口径 |
|---|---|
| `toys` | 已接入的 toy 数（认领通过的） |
| `users` | 中心 toy 上的用户总数 |
| `toyServices` | 服务对数：一行 = 一个「用户 × toy」。一人玩 10 款记 10，另一人玩 5 款记 5，合计 15 |
| `tokens` | 凭证分发总次数 |
| `guardSeconds` | 守护时长：每次签发的有效期之和（秒） |

> `guardSeconds` 是「所有分发时长直接相加」，**不是墙上时钟** —— 同一个人同时在玩三款 toy，那 6 小时会被算三遍。

---

### GET /.well-known/jwks.json

你验签用的公钥。`Cache-Control: public, max-age=300`。

```json
{ "keys": [ { "kty": "EC", "crv": "P-256", "kid": "...", "use": "sig", "alg": "ES256", "x": "...", "y": "..." } ] }
```

### GET /.well-known/xmeta-configuration

接入方元信息，省得把 issuer 写死在代码里。

```json
{
  "issuer": "https://your-api.example.com",
  "jwks_uri": "https://your-api.example.com/.well-known/jwks.json",
  "authorization_endpoint": "https://www.bilibili.com/toy/xmeta/index.html",
  "token_endpoint": "https://your-api.example.com/api/oauth/token",
  "token_endpoint_auth_methods_supported": ["none"],
  "grant_types_supported": ["authorization_code"],
  "id_token_signing_alg_values_supported": ["ES256"],
  "token_ttl_hours_options": [3, 6, 12, 24],
  "token_ttl_hours_default": 6,
  "auth_code_ttl": 60,
  "audience": "toy_id"
}
```

### GET /xmeta-client.js

接入脚本。**不用自己存，也不用传到 toy 平台**，直接 `<script src>` 引服务端这个地址就行。

响应带 `ETag` + `Cache-Control: no-cache`（每次回源校验，没变就 304），所以服务端改了会立刻对所有 toy 生效。响应头 `X-Xmeta-Asset-Hash` 是内容哈希前 8 位，`curl -I` 一眼能看出线上跑的哪一版。

### GET /health

```json
{ "ok": true }
```

---

## 7. 错误码总表

| code | HTTP | 什么时候 |
|---|---|---|
| `invalid_param` | 400 | 参数不合法（`detail` 里有具体哪一项） |
| `invalid_identity` | 400 | toyOpenId 不合法 |
| `invalid_code` | 400 | 授权码无效，或 client_id 对不上 |
| `upstream_blocked` | 400 | 抓取目标不在允许的域名内 |
| `unauthorized` | 401 | 令牌缺失 / 验不过 / 过期 / 对不上 toy |
| `forbidden` | 403 | 没权限 |
| `toy_not_verified` | 403 | 这个 toy 还没完成认领 |
| `source_toy_mismatch` | 403 | 来源 toy 和 client_id 不是同一个 |
| `toy_not_found` | 404 | toy 不存在或已被删除 |
| `client_not_found` | 404 | client_id 不存在或已失效 |
| `claim_not_found` | 404 | 没有进行中的认领 |
| `not_found` | 404 | 这条数据不存在 |
| `toy_already_claimed` | 409 | 该 toy 已被认领 |
| `code_used` | 409 | 授权码已被使用 |
| `quota_exceeded` | 409 | 行数额度用满（128 / 512，见 5.1） |
| `claim_expired` | 410 | 认领已过期 |
| `code_expired` | 410 | 授权码已过期 |
| `nonce_not_in_source` | 422 | 源码里没找到验证码 |
| `rate_limited` | 429 | 请求过于频繁，`detail.retryAfter` 是还要等几秒 |
| `claim_attempts_exceeded` | 429 | 认领验证次数过多 |
| `upstream_fetch_failed` | 502 | 抓 B站 页面失败 |
| `bad_request` | 4xx | 请求体不是合法 JSON 等 |
| `internal_error` | 500 | 服务端内部错误 |

---

## 已知的不一致

- `toy/mine` 和 `toy/refresh` 的 `revoked` 目前恒为 `false` —— 撤销接口还没做（见 README 的「还没做」）。

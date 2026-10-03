# ucs — B站 Toy 跨 toy 身份桥

给 B站 Toy 提供「跨玩具的稳定用户身份」。第三方玩具把用户送到中心玩具完成一次授权，
拿回一个只对它自己有效的 JWT，用这个 JWT 认人。

**只做身份，不做游戏数据。**

---

## 它是怎么工作的

B站 Toy 的 `toyOpenId` 是**每个玩具各自独立**的假名，A 玩具认不出 B 玩具的同一个人。
本服务做的是：在中心玩具里把这个假名换成我们自己的 uid，再对第三方玩具签发 JWT。

```
  ① 认领（一次性）
  作者 ──► 中心玩具注册页 ──► 下发 nonce ──► 作者写进自己 toy 的 index.html
                              ──► 服务端抓真实源码校验 ──► 下发 client_id

  ② 过桥
  第三方玩具 ──toy.navigate(cid, PKCE challenge, state)──► 中心玩具
  用户点授权 ──► toy.getUserProfile() ──► toyOpenId ──► 服务端
                              ──► 一次性 code ──toy.navigate──► 第三方玩具

  ③ 换 JWT
  第三方玩具 ──code + code_verifier──► /api/oauth/token ──► JWT(aud=该玩具)
```

### 为什么归属验证用 nonce，而不是比对用户资料

`toy.getUserProfile()` 返回 `{avatar, nickname, toyOpenId}`，**不返回 mid**，
所以拿它去和 `detail` 接口返回的 `user_info.mid` 根本无从比对。
而 nickname / avatar 是客户端上报的，任何人 curl 一下就能伪造。

nonce 方案证明的是「**你有权发布这个玩具的内容**」——要往 `index.html` 里加东西，
必须有 B站 玩具后台的发布权限。这是真正的凭证。

---

## 快速开始

```bash
npm install
cp .env.example .env      # 填 DATABASE_URL 等
npm run db:create         # 建库（只建，不动已有数据）
npm run db:migrate        # 建表
npm run dev               # http://127.0.0.1:8787
```

必须配的几项：

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | PostgreSQL 连接串 |
| `PUBLIC_BASE_URL` | 对外可访问的地址，会写进 JWT 的 `iss`，**必须和真实部署一致** |
| `MY_TOY_ID` | 中心玩具的 toy_id。所有身份都锚定在它的 `toyOpenId` 上 |
| `MY_TOY_SLUG` | 中心玩具的 slug |
| `ALLOWED_ORIGINS` | 默认 `https://www.bilibilitoy.com`（toy 内层 iframe 的源） |
| `TRUST_PROXY` | 只有在反向代理后面才设 `true`，否则可伪造 IP 绕过限流 |

`MY_TOY_ID` 从哪来：
`curl 'https://api.bilibili.com/x/sunflower/artifex/toy/detail?slug=<你的slug>'` → `data.id`

---

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/claim/start` | 发起认领，返回 nonce |
| POST | `/api/claim/verify` | 抓源码校验 nonce，通过则下发 client_id |
| POST | `/api/toy/mine` | 查询自己认领了哪些玩具 |
| GET | `/api/bridge/context?cid=` | 过桥页加载时确认 client_id 有效 |
| POST | `/api/bridge/authorize` | 用 toyOpenId 换一次性 code |
| POST | `/api/oauth/token` | 用 code 换 JWT |
| GET | `/.well-known/jwks.json` | 公钥，接入方拿来验签 |
| GET | `/.well-known/ucs-configuration` | 接入方元信息 |
| GET | `/health` | 健康检查 |

> 所有带 `toyOpenId` 的调用都必须是 POST。它是密钥级数据，
> 进 URL 就会漏进日志和浏览器历史。

### JWT

ES256 签名，接入方用 JWKS 公钥验签（拿不到签发能力）。

```json
{
  "iss": "https://your-api.example.com",
  "sub": "42",                    // 我们的 uid
  "aud": "27289601636352",        // ★ 目标 toy_id，接入方必须校验
  "jti": "...",
  "iat": 1791041000,
  "exp": 1791041900
}
```

**`aud` 一定要校验。** 不校验的话，A 玩具拿到的 token 能被 B 玩具拿去冒充用户。

---

## 玩具端

`toy-side/` 下的文件：

| 文件 | 放哪 |
|---|---|
| `claim.html` | 上传到**中心玩具**，作者用来认领 |
| `bridge.html` | 上传到**中心玩具**，用户过桥时落到这里 |
| `ucs-client.js` | 给**第三方玩具**引入 |

两个 HTML 里都有 `const API_BASE = '...'`，部署前改成你的域名。

第三方玩具这么接：

```html
<script src="//s1.hdslb.com/bfs/seed/toy/app/sdk/toy-sdk.js"></script>
<script src="ucs-client.js"></script>
<script>
  UCS.configure({
    apiBase: 'https://your-api.example.com',
    myToySlug: '<中心玩具 slug>',
    clientId: '<认领拿到的 client_id>'
  })

  // 必须在用户手势里调用，toy.navigate 需要手势
  document.querySelector('#login').onclick = () => UCS.login()

  UCS.onSession(s => {
    // 把 s.jwt 交给自己的服务端验签
    console.log('登录成功，uid =', s.uid)
  })
</script>
```

---

## 测试

```bash
npm test        # 端到端：认领 → 过桥 → 换 JWT → 用 JWKS 验签
npm run typecheck
```

B站的接口和外网抓取在测试里用桩替代，DB / 状态机 / PKCE / 签名都是真的。
测试会往 `ucs` 库里写 `testtoy*` 前缀的临时数据，跑完自己清理。

---

## 几个必须知道的坑

1. **中心玩具必须开启 OpenID 模式**，否则 `getUserProfile()` 不返回 `toyOpenId`，整条链断掉。
2. **`getUserProfile()` 在外部手机浏览器里不支持**，只在 B站 App 内和桌面 Web 可用。
3. **绝不能用云存储做实时联机同步**：`getCloudStorage` / `submitScore` 是按「玩具」限流的，
   同一个玩具的所有玩家共享一份额度，几个人同时在玩就会互相把额度打光（错 307044）。
4. **`toyOpenId` 跨设备的稳定性没验证过**，上线前务必在手机 App 和桌面 Web 上各测一次。
   如果不稳定，作者会只能在某一台设备上管理自己的玩具。
5. **`/x/sunflower/artifex/toy/detail` 是未公开接口**，随时可能变更或限流。
   抓 shell 页面解 `__TOY_META__` 是可用的兜底路径。生产环境建议给 toy 元数据加缓存。
6. **`localStorage` 在 `www.bilibilitoy.com` 下是所有玩具共享的**（同源），
   所以 `ucs-client.js` 的 key 都带 clientId 前缀，且只存一次性的 PKCE verifier。
7. **nonce 的钓鱼风险无技术解**：不能阻止作者被别人骗着把验证码贴进代码。
   这是所有域名验证方案的共同弱点，只能靠文案提示降低概率。

---

## 还没做

- 撤销 / 轮换 client_id 的接口（DB 里 `toy_client.revoked_at` 已预留）
- refresh token（目前 15 分钟过期后要重新过桥）
- 密钥轮转的运维接口（`jwt_signing_key` 支持多把共存，缺的是发起轮转的入口）
- 限流目前是单实例内存态，多实例部署要换 Redis
- 认领的重认领流程（nonce 证明的是内容控制权，所以真作者永远能重新证明自己）

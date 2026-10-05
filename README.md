# xmeta — B站 Toy 身份桥

给 B站 Toy 提供统一的身份管理服务。每个 toy 的 toyOpenId、JWT、数据各自独立、互不互通，
由中心 toy 统一签发身份凭证并集中管理。第三方 toy 把用户送到中心 toy 完成一次授权，
拿回一个只对它自己有效的 JWT，用这个 JWT 认人。

**只做身份，不做游戏数据。**

---

## 它是怎么工作的

B站 Toy 的 `toyOpenId` 是**每个 toy 各自独立**的假名，A toy 认不出 B toy 的同一个人。
本服务做的是：在中心 toy 里把这个假名换成我们自己的 uid，再对第三方 toy 签发 JWT。

```
  ① 认领（一次性）
  作者 ──► 中心 toy 注册页 ──► 下发 nonce ──► 作者写进自己 toy 的 index.html
                              ──► 服务端抓真实源码校验 ──► 下发 client_id

  ② 过桥
  第三方 toy ──toy.navigate(cid, PKCE challenge, state)──► 中心 toy
  用户点授权 ──► toy.getUserProfile() ──► toyOpenId ──► 服务端
                              ──► 一次性 code ──toy.navigate──► 第三方 toy

  ③ 换 JWT
  第三方 toy ──code + code_verifier──► /api/oauth/token ──► JWT(aud=该 toy)
```

### 为什么归属验证用 nonce，而不是比对用户资料

`toy.getUserProfile()` 返回 `{avatar, nickname, toyOpenId}`，**不返回 mid**，
所以拿它去和 `detail` 接口返回的 `user_info.mid` 根本无从比对。
而 nickname / avatar 是客户端上报的，任何人 curl 一下就能伪造。

nonce 方案证明的是「**你有权发布这个 toy 的内容**」——要往 `index.html` 里加东西，
必须有 B站 toy 后台的发布权限。这是真正的凭证。

---

## 快速开始

> 部署到线上服务器看 [DEPLOY.md](DEPLOY.md)，下面是本地开发。

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
| `MY_TOY_ID` | 中心 toy 的 toy_id。所有身份都锚定在它的 `toyOpenId` 上 |
| `MY_TOY_SLUG` | 中心 toy 的 slug |
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
| POST | `/api/toy/mine` | 查询自己认领了哪些 toy |
| POST | `/api/me` | 个人中心：身份 + 认领的 toy + 使用记录 |
| GET | `/api/bridge/context?cid=` | 过桥页加载时确认 client_id 有效 |
| POST | `/api/bridge/authorize` | 用 toyOpenId 换一次性 code |
| POST | `/api/oauth/token` | 用 code 换 JWT |
| POST | `/api/oauth/introspect` | 查一枚 token 还有效吗 |
| GET | `/.well-known/jwks.json` | 公钥，接入方拿来验签 |
| GET | `/.well-known/xmeta-configuration` | 接入方元信息 |
| GET | `/xmeta-client.js` | 接入脚本，第三方 toy 直接 `<script src>` 引入 |
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
  "iat": 1791041000,              // 整秒（标准 NumericDate）
  "iat_ms": 1791041000123,        // 签发时的毫秒时间戳，接入方可忽略
  "exp": 1791041900
}
```

**`aud` 一定要校验。** 不校验的话，A toy 拿到的 token 能被 B toy 拿去冒充用户。

**PKCE 是必填的。** `/api/bridge/authorize` 不带 `cc`（challenge）会直接 400，
`/api/oauth/token` 不带 `code_verifier` 也会失败。`code` 会出现在 URL 里
（Web 端拼在 query 上），没有 PKCE 的话，谁看到这条 URL 都能在过期前把它换掉。

### 有效期

**token 能活多久由用户在授权时自己选**：3 / 6 / 12 / 24 小时，默认 6 小时。
没有自动续期，到期后用户回中心 toy 再授权一次。

> 24 小时是上限，这是刻意的 —— 意味着用户每天都要回中心 toy 续一次，
> 而不是靠刷新令牌把人一直留在登录态里。档位在 `src/config.ts` 的
> `ALLOWED_TOKEN_TTL_HOURS`，改那里就改可选范围。

接入方拿 `XMETA.getRemainingMs()` 能看到还剩多久，**应该显示给用户**，
别让人玩到一半突然掉线。

需要服务端再确认一次 token 有效性，调 `POST /api/oauth/introspect`。

---

## toy 端

`toy-side/` 下的文件：

| 文件 | 放哪 |
|---|---|
| `index.html` | 中心 toy 的入口。带 `?cid=` 时自动转发给 `bridge.html`，否则是导航页 |
| `claim.html` | 上传到**中心 toy**，作者用来认领 |
| `bridge.html` | 上传到**中心 toy**，用户过桥时落到这里 |
| `me.html` | 上传到**中心 toy**，个人中心：看自己的身份和被哪些 toy 用过 |
| `demo-toy/index.html` | 一个最小的**第三方 toy**示例，用来跑通整条链路 |
| `demo-toy/raw.html` | **不用 SDK 的裸接入示例** —— 整条链路约 60 行，想自己接就抄它 |
| `xmeta-client.js` | 接入脚本。**不用自己存**，服务端已挂在 `/xmeta-client.js` |
| `xmeta-ui.css` | 页面共用的设计系统。**随页面一起上传**，用相对路径本地引用 |

> 第三方 toy 用 `toy.navigate({ type:'toy', id:'<中心 toy slug>' })` 跳过来时，
> 落点固定是 `index.html`，所以 `index.html` 必须保留那行转发逻辑。

`claim.html` / `bridge.html` / `demo-toy/index.html` 里都有
`API_BASE`（或 `CONFIG.apiBase`），部署前改成你的域名。**必须是 https**——
toy 页面本身跑在 https 上，调 http 接口会被浏览器按混合内容拦掉。

第三方 toy 这么接：

```html
<script src="//s1.hdslb.com/bfs/seed/toy/app/sdk/toy-sdk.js"></script>
<script src="https://your-api.example.com/xmeta-client.js"></script>
<script>
  XMETA.configure({
    apiBase: 'https://your-api.example.com',
    centerToySlug: '<中心 toy slug>',
    clientId: '<认领拿到的 client_id>'
  })

  // 必须在用户手势里调用，toy.navigate 需要手势
  document.querySelector('#login').onclick = () => XMETA.login()

  // 用户授权完跳回来，SDK 只会**检测到**那枚授权码，不会替你兑换。
  // 兑换要用户再点一次 —— 这样只有用户看得见的这个页面能消费掉它。
  XMETA.onCodeReady(() => { document.querySelector('#finish').hidden = false })
  document.querySelector('#finish').onclick = async () => {
    try { await XMETA.completeLogin() } catch (e) { alert(e.message) }
  }

  XMETA.onSession(s => {
    // 把 s.jwt 交给自己的服务端验签
    // s.uid 是 xmeta 内的用户 id，不是 B站 UID
    console.log('已就绪，uid =', s.uid)
  })
</script>
```

> **为什么兑换要用户再点一次。** 过桥是「跳走再跳回来」，而跳走时那个页面
> 实例并没有消失，只是看不见了。如果兑换是自动的，看不见的那个实例就可能
> 抢在用户看得见的实例之前把一次性 `code` 消费掉，表现就是「第一次授权
> 回来显示未连接，再授权一次才行」。
>
> 所以 SDK 把两件事拆开：**检测**只读、幂等，多少实例同时检测都互不影响；
> **兑换**绑在用户手势上，只有用户点得到的页面能触发。竞态不是被绕开，是
> 结构上不存在了。

---

## 测试

```bash
npm test        # 端到端：认领 → 过桥 → 换 JWT → 用 JWKS 验签
npm run typecheck
```

B站的接口和外网抓取在测试里用桩替代，DB / 状态机 / PKCE / 签名都是真的。
测试会往 `xmeta` 库里写 `testtoy*` 前缀的临时数据，跑完自己清理。

---

## 几个必须知道的坑

1. **中心 toy 必须开启 OpenID 模式**，否则 `getUserProfile()` 不返回 `toyOpenId`，整条链断掉。
2. **B站 App 里 `toy.navigate` 不会透传 `extra`**（Web 端正常）。

   实测：从 toy A 调 `toy.navigate({ type:'toy', id:'toyB', extra:{foo:'bar'} })`，
   toy B 的 `location.search` 里只有原生自己加的 `from_spmid=toy.toy-detail.<A 的 toy_id>.0`，
   `foo` 丢了。SDK 里 `navigate` 分两条路：非 App 走 `window.open(at(e))`，
   `extra` 会被拼进 URL；App 走原生 JSB（`ipc.request({kind:'navigate'})`），
   原生侧拼 URL 时没带上 `extra`。文档里 `extra` 写的是「透传给目标页面」，
   且 `type` 明确包含 `toy`——**App 端的行为与文档不符**。

   所以本项目的过桥参数（leg 1 的 `cid/cc/st`、leg 2 的 `code`）都走**双通道**：

   - URL 参数优先（Web 端能生效）
   - 拿不到时回落到 **localStorage** —— B站 所有 toy 的内层 iframe 同在
     `www.bilibilitoy.com` 一个源下（sandbox 带 `allow-same-origin`），存储是共享的。
     这条路是实测验证过的。

   > 依赖「跨 toy 同源」属于平台未公开的实现细节，B站 改沙箱配置就会断。
   > 所以 URL 那条路一直保留着，而不是直接删掉。

   正因为它全 toy 共享，`xmeta-client.js` 的 key 一律带 `clientId` 前缀，
   免得不同 toy 互相踩。

   **`xmeta:code` 是一份公开契约**（想自己接、不用 `xmeta-client.js` 的，
   照它读就行）：

   | | |
   |---|---|
   | 键 | `xmeta:code` —— 全局单槽，所有 toy 共用 |
   | 值 | `{ v, clientId, code, state, returnSlug, expiresAt, ts }` |
   | 时效 | 到 `expiresAt` 为止（= 授权码的 60 秒有效期） |
   | 读方 | **只读**。只在「兑换成功 / 判定过期 / 用户取消」三种终态才允许删 |

   `clientId` 不能省 —— 单槽是所有 toy 共用的，它是「这枚码不是给我的」
   唯一判据。leg 1 的 `xmeta:req`（发起方写、中心 toy 读）不在这个契约里。

   ⚠️ 注意这份共享是**双向**的：PKCE verifier 和暂存的会话也在同一个源下，
   同源的别的 toy 都读得到。凭证的暴露面见下面「几个必须知道的坑」。

3. **`getUserProfile()` 在外部手机浏览器里不支持**，只在 B站 App 内和桌面 Web 可用。
4. **`toy.navigate` 必须在用户手势里「同步」调用，不能跨 `await`。**

   SDK 内部会检查 `navigator.userActivation.isActive` —— 那是**瞬时**状态，
   只在用户交互后的很短时间内为真。写成 `async` 处理函数、中间插一次
   `await`，就可能在检查时已经失效，然后抛
   `navigate requires user activation`。

   ```js
   // ❌ 跨了 await
   btn.onclick = async () => { await something(); toy.navigate(...) }

   // ✅ 紧贴手势
   btn.onclick = () => { toy.navigate(...).catch(handle) }
   ```

   顺带一提：这个失败**不要**跳到一个只有「重试」的错误页，那会把人困在
   「重试 → 再点 → 又失败」的循环里。就地提示、保留按钮，用户再点一次
   就是一次全新的手势。
4. **绝不能用云存储做实时联机同步**：`getCloudStorage` / `submitScore` 是按「toy」限流的，
   同一个 toy 的所有玩家共享一份额度，几个人同时在玩就会互相把额度打光（错 307044）。
5. **`toyOpenId` 跨设备的稳定性没验证过**，上线前务必在手机 App 和桌面 Web 上各测一次。
   如果不稳定，作者会只能在某一台设备上管理自己的 toy。
6. **`/x/sunflower/artifex/toy/detail` 是未公开接口**，随时可能变更或限流。
   抓 shell 页面解 `__TOY_META__` 是可用的兜底路径。生产环境建议给 toy 元数据加缓存。
7. **nonce 的钓鱼风险无技术解**：不能阻止作者被别人骗着把验证码贴进代码。
   这是所有域名验证方案的共同弱点，只能靠文案提示降低概率。

---

## 还没做

- 撤销 / 轮换 client_id 的接口（DB 里 `toy_client.revoked_at` 已预留）
- refresh token（目前 15 分钟过期后要重新过桥）
- 密钥轮转的运维接口（`jwt_signing_key` 支持多把共存，缺的是发起轮转的入口）
- 限流目前是单实例内存态，多实例部署要换 Redis
- 认领的重认领流程（nonce 证明的是内容控制权，所以真作者永远能重新证明自己）

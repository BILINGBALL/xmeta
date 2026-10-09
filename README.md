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
  第三方 toy ──toy.navigate(cid)──► 中心 toy
  用户点授权 ──► toy.getUserProfile() ──► toyOpenId ──► 服务端
                              ──► 一次性 code ──toy.navigate──► 第三方 toy

  ③ 换 JWT
  第三方 toy ──code──► /api/oauth/token ──► JWT(aud=该 toy)
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
| POST | `/api/toy/refresh` | 作者手动刷新自己 toy 的元数据（图标、作者名/头像） |
| POST | `/api/me` | 个人中心：身份 + 认领的 toy + 使用记录 |
| GET | `/api/bridge/context?cid=` | 过桥页加载时确认 client_id 有效 |
| POST | `/api/bridge/authorize` | 用 toyOpenId 换一次性 code |
| POST | `/api/oauth/token` | 用 code 换 JWT |
| POST | `/api/oauth/introspect` | 查一枚 token 还有效吗 |
| GET | `/api/stats` | 服务统计（公开只读，全是聚合数） |
| GET | `/api/kv/:scope` | 读自己那一格（作者可 `?uid=` 读别人的） |
| GET | `/api/kv/:scope/list` | 列一个 scope 下所有人的格（分页） |
| PUT | `/api/kv/:scope` | 整行覆盖（属主 / 作者） |
| PATCH | `/api/kv/:scope` | 部分改（别人的行受 `open_edit` 限制） |
| POST | `/api/user/profiles` | 按 uid 批量取昵称/头像（只给本 toy 出现过的人） |
| GET | `/api/kv/:scope/:uid/log` | 改动日志（分页） |
| DELETE | `/api/kv/:scope/:uid` | 删一行（属主删自己的腾地方；作者删任何一格） |
| DELETE | `/api/kv/:scope?all=1` | 删整个 scope（作者） |
| GET | `/.well-known/jwks.json` | 公钥，接入方拿来验签 |
| GET | `/.well-known/xmeta-configuration` | 接入方元信息 |
| GET | `/xmeta-client.js` | 接入脚本，第三方 toy 直接 `<script src>` 引入 |
| GET | `/health` | 健康检查 |

> 所有带 `toyOpenId` 的调用都必须是 POST。它是密钥级数据，
> 进 URL 就会漏进日志和浏览器历史。

### 统计

`GET /api/stats`，公开只读 —— 返回的全是聚合数字，没有任何用户信息。

```json
{
  "toys": 12,           // 已接入的 toy 数（认领通过的那些）
  "users": 345,         // 中心 toy 上的用户总数
  "toyServices": 890,   // 服务对数：一行 = 一个「用户 × toy」。
                        // 一人玩 10 款 toy 记 10，另一人玩 5 款记 5，合计 15
  "tokens": 2345,       // 凭证分发总次数
  "guardSeconds": 42000000  // 守护时长：每次签发的有效期之和（秒）
}
```

口径全落在 `identity_usage` 这张表上（`sql/002`）：**一行 = 一个用户 × 一款
toy**，行数就是 `toyServices`，`sum(uses)` 是 `tokens`，`sum(seconds)` 是
`guardSeconds`。所以它必须长期保留 —— `auth_code` 是短命凭证，清掉之后就
再也回溯不出这些数了。`users` / `toys` 顺手从 `app_user` / `toy` 数。

> `guardSeconds` 是「所有分发时长直接相加」，不是墙上时钟 —— 同一个人同时在
> 玩三款 toy，那 6 小时会被算三遍。它衡量「一共守护了多少份、每份多久」，
> 不是「服务覆盖了多长时间段」。
>
> 这一列从 `sql/005` 开始累计，之前的历史补不回来（那时的 `auth_code` 早被
> 清理了），所以它起步时会比 `tokens` 显得少。

### 联机数据（`/api/kv`）

给接入方一个**数据交换**用的格子：一行 = 一个用户在某个 `scope` 下的一格。
**它不是长期存储** —— 作者该有自己的持久化（云存储/本地），这里只负责交换。
所以有两道硬约束：**额度**（普通用户每 toy 64 行，作者 256）和**强制过期**
（1~30 天，创建时定死、任何编辑都不续期、最多改到「创建 + 30 天」）。

| 概念 | 说明 |
|---|---|
| `scope` | 业务分类，如 `package`/`bag`/`roles`/`weapon`。`admin*` 开头是保留的，只有作者能建 |
| `is_public` | 默认 `false`：只有属主和作者看得见。`true` 则本 toy 的用户都能读 |
| `open_edit` | 别人能改哪些字段的**白名单**。空数组 = 只读。`extra` 永远不在名单里 |
| `inc`（PATCH 专用） | **原子加减**：`{ "inc": { "tagInt1": -10 } }`。客户端自己「读出来加一再写回去」在并发下必然丢更新，把增量交给服务端才不会。**不做任何业务边界** —— 血量能不能变负是玩具自己的事，前端把 `-100HP` 显示成 `0HP` 就行 |
| 字段 | `tag_tinyint/tag_int1/tag_int2/tag_bigint`（数字，给筛选用）、`text_1`(128) / `text_2`(512) / `text_long`(1024)、`extra`（JSON，≤2048 字节的容器） |

权限：读要令牌（非作者只看公开的）；写自己的行全字段，写别人的行只能动
`open_edit` 里的；删只有属主（自己那格）和作者。**作者对自己的 toy 有最高权限**——
含读玩家的私有行。

**写操作的响应里带结果**：`PUT` / `PATCH` 回的 `data` 是**写完之后的整行**
（`inc` 也一样，新值直接就在里面，不用再查一次）；`DELETE` 回带被删掉的那一行。
`changed` 列出这次动了哪几个字段。

**昵称头像怎么来**：数据里只存 `uid`（作者那边也该只存 id、渲染在本地），要显示
名字就 `POST /api/user/profiles { "uids": [...] }`（一次最多 50 个）。**只给「在本
toy 出现过的人」** —— uid 是全平台唯一的，不限制就等于开了一个拿 uid 枚举全平台
资料的入口。注意昵称/头像是**客户端上报的**（`getUserProfile` 来的），只当展示用，
别拿它做鉴权或唯一性判断；头像 URL 是 B站 CDN 的，前端记得加
`referrerPolicy="no-referrer"`。

> **「私有」是对其他玩家私有，对作者不是。** 玩家写进 xmeta 的东西作者看得到，
> 别让人误以为作者也看不到。

想手动把这些接口点一遍：`demo-toy/kv.html` 是个现成的测试台（11 条快捷填充，
每条都写明这条接口在干什么）。

> 读缓存：配了 `REDIS_URL` 就开（单格写完主动失效、列表靠 `CACHE_TTL_SECONDS`
> 过期，默认 30 秒）。**没配就纯走库**，功能一模一样。

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

**没有 PKCE，code 是唯一的凭据。** 换 token 只要 `{ code, client_id }`，
接入方不需要在本地存任何东西、也不需要理解 verifier/challenge。
敢这么简化是因为 `code` 的暴露面已经被别的东西压住了：60 秒命、一次性、
只对签发它的那个 toy 有效（`aud` 也绑死）。这是给一个玩具生态用的，
不是给银行用的。

> 代价说清楚：`code` 会出现在 URL 里（Web 端拼在 query 上），谁在这 60 秒内
> 看到它、又抢在你前面兑换，谁就能顶掉你这一次登录。要回到 PKCE 的话，
> `auth_code` 表那三列（`code_challenge` / `code_challenge_method` / `state`）
> 还在，加回去、`/api/oauth/token` 补一道
> `sha256(code_verifier) == code_challenge` 就行。

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

`toy-side/` 是跑在**中心 toy** 上的页面，`demo-toy/` 是一个最小的**第三方 toy**示例
（两边各带一份自己的 `xmeta-ui.css`：中心 toy 那份是全的，demo 这份是精简过的）：

| 文件 | 放哪 |
|---|---|
| `toy-side/index.html` | 中心 toy 的入口。带 `?cid=` 时自动转发给 `bridge.html`，否则是导航页 |
| `toy-side/claim.html` | 上传到**中心 toy**，作者用来认领 |
| `toy-side/bridge.html` | 上传到**中心 toy**，用户过桥时落到这里 |
| `toy-side/me.html` | 上传到**中心 toy**，个人中心：看自己的身份和被哪些 toy 用过 |
| `toy-side/xmeta-ui.css` | 页面共用的设计系统。**随页面一起上传**，用相对路径本地引用 |
| `toy-side/xmeta-client.js` | 接入脚本。**不用自己存，也不用传到 toy 平台**，服务端已挂在 `/xmeta-client.js` |
| `demo-toy/index.html` | 一个最小的**第三方 toy**示例，用来跑通整条链路 |

> 第三方 toy 用 `toy.navigate({ type:'toy', id:'<中心 toy slug>' })` 跳过来时，
> 落点固定是 `index.html`，所以 `index.html` 必须保留那行转发逻辑。
>
> B站 官方那份 toy SDK 能力清单（`navigate` / `getUserProfile` / 云存储 /
> 排行榜等每个方法的参数与返回值）在仓库根目录：
> [bilibili-toy-sdk.md](bilibili-toy-sdk.md)。本项目对它的依赖只集中在
> 「几个必须知道的坑」那一节。

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
    centerToyId: '<中心 toy 的 toy_id>',   // 可选，用来认「刚从中心 toy 回来」
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
>
> **手上已经有凭证时，`onCodeReady` 照样会响。** 用户点「重新申请」的目的
> 就是换掉手上那枚（3 小时换成 24 小时之类），所以回来的新码必须照常检测、
> 照常兑换 —— 别在接入方那边写「已连接就忽略新码」的逻辑，那会让用户永远
> 换不上。SDK 内部同一条规矩：`completeLogin()` 在没有新码时幂等地返回已有
> 会话，一有新码就把它换掉。
>
> **也可以在 `onCodeReady` 里直接兑换，不设第二个按钮**（`demo-toy/index.html`
> 就是这么写的）。code 一次性，只有一个实例能兑换成功；输的那个会拿到
> `code_used`，而 SDK 会自动采纳赢家写在同源 localStorage 里的会话当成成功 ——
> 谁先谁后都不影响结果。要不要第二个按钮，纯粹是接入方的 UX 选择。
>
> **你的服务端怎么验签、怎么从令牌里取出用户身份**（公钥从哪拿、必须校哪几样、
> `sub` 该怎么用、有哪些坑）—— 单独写在 [INTEGRATION.md](INTEGRATION.md)。

---

## 测试

```bash
npm test        # test/client.test.ts（SDK 单测）+ test/e2e.test.ts（整条链路）
npm run typecheck
```

端到端那条覆盖：认领 → 过桥 → 换 JWT → 用 JWKS 验签 → 统计接口。
B站的接口和外网抓取在测试里用桩替代，DB / 状态机 / 签名都是真的。
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

   所以本项目的过桥参数（leg 1 的 `cid`、leg 2 的 `code`）都走**双通道**：

   - URL 参数优先（Web 端能生效）
   - 拿不到时回落到 **localStorage** —— B站 所有 toy 的内层 iframe 同在
     `www.bilibilitoy.com` 一个源下（sandbox 带 `allow-same-origin`），存储是共享的。
     这条路是实测验证过的。

   > 依赖「跨 toy 同源」属于平台未公开的实现细节，B站 改沙箱配置就会断。
   > 所以 URL 那条路一直保留着，而不是直接删掉。

   正因为它全 toy 共享，SDK 存下来的会话 key 带 `clientId` 前缀
   （`xmeta:sess:<clientId>`），免得不同 toy 互相踩。

   **`xmeta:code` 是一份公开契约**（想自己接、不用 `xmeta-client.js` 的，
   照它读就行）：

   | | |
   |---|---|
   | 键 | `xmeta:code` —— 全局单槽，所有 toy 共用 |
   | 值 | `{ v, clientId, code, returnSlug, expiresAt, ts }` |
   | 时效 | 到 `expiresAt` 为止（= 授权码的 60 秒有效期） |
   | 读方 | **只读**。只在「兑换成功 / 判定过期 / 用户取消」三种终态才允许删 |

   `clientId` 不能省 —— 单槽是所有 toy 共用的，它是「这枚码不是给我的」
   唯一判据。leg 1 的 `xmeta:req`（发起方写、中心 toy 读）不在这个契约里。

   这一份就是发起方换 JWT 的**全部依据**：加上 URL 上的 `code`，没有别的。
   曾经还要求「槽里的 state == 本地记的 state」，那条路依赖第三方 toy 自己
   写在 localStorage 里的记录 —— 而用户可能在中心 toy 那边挑好几分钟时长，
   这段时间里那份记录会被平台回收，于是带着一枚好端端的码回来却什么都换
   不了（本地判据对不上，而且**不报错**）。现在判据全在槽自己身上。

   判定「这一跳是不是刚从中心 toy 回来」有三条路：Web 端 SDK 自己把 `code`
   拼在 URL 上；App 端原生拼的是 `from_spmid=toy.toy-detail.<中心 toy 的
   toy_id>.0`（这就是 `centerToyId` 的用处）；外加「槽里躺着一枚新鲜的、
   写给我的码」兜底。

   ⚠️ 注意这份共享是**双向**的：暂存的会话也在同一个源下，
   **同源的别的 toy 都读得到**。凭证的暴露面见下面「几个必须知道的坑」。

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
5. **绝不能用云存储做实时联机同步**：`getCloudStorage` / `submitScore` 是按「toy」限流的，
   同一个 toy 的所有玩家共享一份额度，几个人同时在玩就会互相把额度打光（错 307044）。
6. **`toyOpenId` 跨设备的稳定性没验证过**，上线前务必在手机 App 和桌面 Web 上各测一次。
   如果不稳定，作者会只能在某一台设备上管理自己的 toy。
7. **`/x/sunflower/artifex/toy/detail` 是未公开接口**，随时可能变更或限流。
   抓 shell 页面解 `__TOY_META__` 是可用的兜底路径。生产环境建议给 toy 元数据加缓存。
8. **nonce 的钓鱼风险无技术解**：不能阻止作者被别人骗着把验证码贴进代码。
   这是所有域名验证方案的共同弱点，只能靠文案提示降低概率。
9. **`client_id` 不是密钥，但抄别人的也不好使。**

   它本来就会出现在跳转链接里，谁都能拿到；服务端只用它反查 toy —— 所以抄来的
   cid 只会把玩家送回**原 toy**（回跳目标是服务端按 cid 查的），凭证也是原 toy
   的，抄的人自己那个 toy 一点身份都拿不到。

   为了连这点错位都不发生，**服务端在签发那一步核一下来源**：中心 toy 的授权页
   把「这一跳来自哪个 toy」原样报上来（`POST /api/bridge/authorize` 的
   `fromToyId`，必填），服务端拿它和 cid 反查出来的 toy 比，对不上直接拒
   （`source_toy_mismatch`，403）。抄包体的人报上来的是**他自己**那个 toy 的 id
   —— 那是平台在跳转时盖章的，他改不了；而他并不知道原 toy 的 id，也伪造不出来。
   第三方 toy 一行都不用改，全在中心 toy 的授权页里。

   来源从地址上认，优先取原生那个：

   | 环境 | 地址上的样子 | 谁拼的 |
   |---|---|---|
   | B站 App | `from_spmid=toy.toy-detail.<来源 toy 的 toy_id>.0` | 原生，**页面伪造不了** |
   | Web | `spm_id_from=333.40216.<当前 toy 的 toy_id>.0` | SDK 自己拼（`at()`），可伪造 |

   两个都取不到（比如手敲地址直接打开授权页）会被授权页挡在门外 —— 没有可信任
   的来源就不签发。被挡下来时错误页上会多一个「认领 toy」按钮，点一下回中心 toy
   首页，从那儿走认领拿到属于自己的 client_id。

   > **上线顺序**：先把 `bridge.html` 传上去，再部署服务端。反过来，新版服务端
   > 收到没有 `fromToyId` 的旧页面会 400。
   >
   > 局限，别当墙：`fromToyId` 终究是页面报的，肯下功夫的人可以去查原 toy 的
   > toy_id（`toy/detail` 接口是公开的）然后谎报。它挡的是「顺手复制包体」，
   > 不是权限边界。
   >
   > 排查用：授权页每次加载都会把「认出了什么」写进 `localStorage['xmeta:bridge']`
   > （`src` 是认出来的来源 toy_id，另外两个是参数原文）。服务端的拒绝信息里
   > **不会**回带原 toy 的 id —— 那等于告诉抄的人该伪造什么。

---

## 还没做

- 撤销 / 轮换 client_id 的接口（DB 里 `toy_client.revoked_at` 已预留）
- 密钥轮转的运维接口（`jwt_signing_key` 支持多把共存，缺的是发起轮转的入口）
- 限流目前是单实例内存态，多实例部署要换 Redis
- 认领的重认领流程（nonce 证明的是内容控制权，所以真作者永远能重新证明自己）
- 统计的按天趋势（现在只有累计值，没有时间轴）

> **刻意不做**：refresh token。理由见上面的「有效期」—— token 能活多久由
> 用户在授权时自己选（最长 24 小时），到期就回中心 toy 再授权一次。不靠
> 刷新令牌把人一直留在登录态里。

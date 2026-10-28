# 压力 / 并发测试报告

- **测试时间**：2026-10-29
- **目标**：`https://www.oxth.com:8443`（生产环境）
- **服务器**：2 vCPU / 3.5 GB / Ubuntu 26.04
- **运行时**：Node 22.22，pm2 **fork 模式（单实例）**，nginx 1.28 + TLS，Redis（阿里云 Tair，同 VPC），PostgreSQL（阿里云 RDS）
- **工具**：`tools/loadtest.mjs`（本仓库自带，Node 原生 `fetch`，无第三方依赖）
- **方法**：
  - **应用层**：在服务器上打 `127.0.0.1:8787`，绕开网络和 nginx，只看应用本身；
  - **真实链路**：从开发机走 `https://www.oxth.com:8443`，含 TLS、nginx、公网往返。

> 测试全程只用了只读接口和一条可删除的测试数据；测试身份和那行数据**已清理**（见文末）。

---

## 一、结论

1. **单进程吞吐约 1,500–1,900 rps**（应用层）。真实链路从单一客户端能跑到 **1,100 rps**（c=20），延迟 p50 约 17ms —— 这个数基本是客户端到服务器的往返决定的，不是服务器顶不住。
2. **CPU 先到顶**：c=50 时 `vmstat` 里 `us` 稳定在 89–90%，而机器是 2 核。**pm2 用的是 fork 模式，只吃了 1 个核**，第二个核基本闲着。
3. **限流是真正的天花板**，不是性能。各接口的额度（每分钟）实测完全生效：`/api/stats` 60、`/api/bridge/context` 120、KV 读 240、KV 写 120。超出部分返回 429，且 429 只要 **0.7ms**（在进数据库之前就被挡下），对服务器几乎没有成本。
4. **并发写的正确性没问题**：100 个并发 `inc` 打同一行，最终值刚好 100，一次都没丢。
5. **两个值得改的点**：每次验签都查一次数据库；IP 限流可以被 `X-Forwarded-For` 绕过。

---

## 二、原始数据

### 2.1 应用层（服务器 loopback）

| 场景 | 并发 | 请求数 | RPS | p50 | p95 | p99 |
|---|---:|---:|---:|---:|---:|---:|
| `GET /health` | 10 | 7,246 | 1,447 | 5.0ms | 15.4ms | 26.5ms |
| `GET /health` | 50 | 7,693 | 1,535 | 28.4ms | 58.7ms | 83.8ms |
| `GET /health`（复测） | 50 | 15,004 | 1,872 | 20.6ms | 49.5ms | 68.8ms |
| `GET /.well-known/jwks.json` | 10 | 6,927 | 1,385 | 5.5ms | 15.7ms | 22.4ms |
| `GET /.well-known/jwks.json` | 50 | 7,026 | 1,401 | 31.0ms | 69.0ms | 93.9ms |
| `GET /api/stats`（额度内） | 5 | 50 | — | 7.8ms | 38.8ms | 129.4ms |
| `GET /api/bridge/context`（额度内） | 10 | 100 | — | 19.1ms | 44.9ms | 53.1ms |

> `/jwks.json` 每次请求都要**查一次数据库**（见 2.5），RPS 却和纯内存的 `/health` 差不多 —— 说明 RDS 的往返在 1ms 级，不是瓶颈。

### 2.2 真实链路（开发机 → 公网 → TLS → nginx → 应用）

| 场景 | 并发 | RPS | p50 | p95 | p99 |
|---|---:|---:|---:|---:|---:|
| `GET /health` | 3 | 157 | 18.3ms | 19.5ms | 55.3ms |
| `GET /health` | 20 | 1,108 | 17.0ms | 20.2ms | 25.4ms |
| `GET /.well-known/jwks.json` | 3 | 156 | 18.4ms | 21.1ms | 53.7ms |
| `GET /api/stats`（额度内） | 3 | 161 | 18.1ms | 19.0ms | 51.8ms |
| `GET /api/kv/:scope`（带 JWT，200 次） | 10 | 341 | 19.4ms | 81.5ms | 100.7ms |

**p50 ≈ 17–19ms** 基本就是客户端到服务器的网络往返，与服务器处理时间无关（应用层 p50 是 5ms）。

### 2.3 限流额度实测

| 接口 | 额度 | 实测 |
|---|---|---|
| `GET /api/stats` | 60/分钟/IP | 10 秒内发出 12,272 次：**60 次 200，12,212 次 429**；429 的 p50 = **0.7ms** |
| `GET /api/bridge/context` | 120/分钟/IP | 同样：前 120 次 200，之后全 429 |
| `GET /api/kv/:scope` | 240/分钟/uid | 200 次请求全部 200（在额度内） |
| `PATCH /api/kv/:scope` | 120/分钟/uid | 100 次并发全部 200（在额度内） |

### 2.4 并发正确性（原子加减）

同一行上 **100 个并发 `PATCH { inc: { tagInt1: 1 } }`**：

```
100/100 返回 200
最终值 = 100            ← 一次都没有丢
延迟   p50 482ms / p95 494ms / p99 497ms
```

这 100 个请求在数据库里是**排队**的（`SELECT … FOR UPDATE` 锁住那一行），所以每个请求的延迟约等于「排队等到自己的时间」，单行吞吐大约 **200 次/秒**。

### 2.5 资源占用（c=50 持续压 `/health`）

```
vmstat：us 89–90%，sy 9–11%，id 1–2%      ← 2 核里约 1.8 核在忙
node 进程 RSS：约 128 MB
系统空闲内存：约 1.65 GB
```

---

## 三、发现的问题（按影响排序）

### 1. 每次验签都查一次数据库 ⚠️

`src/lib/jwt.ts:156`：

```ts
export async function verifyToken(token: string): Promise<JWTPayload> {
  const jwks = createLocalJWKSet({ keys: await listPublicJwks() });  // ← 每次都查
  ...
}
```

**每个带 JWT 的请求**（所有 `/api/kv/*`、`/api/user/profiles`）都会先执行一条
`select public_jwk from jwt_signing_key ...`。签名密钥几个月才轮转一次，完全可以
在进程内缓存（带个几十秒的重载间隔就行）。

现在没出问题是因为 RDS 往返在 1ms 级；但它让「鉴权」变成了「鉴权 + 一次数据库往返」，
在数据库抖动时会直接放大成接口抖动。

### 2. 只用了 1 个核

pm2 是 `fork` 模式（单实例）。机器有 2 个 vCPU，压测时 `us` 到 90% 就上不去了。
如果确实需要更高吞吐，`pm2 start dist/server.js -i 2`（cluster 模式）就能用满两核。

> 注意：cluster 模式下限流仍是**进程内内存态**，每个实例各算各的，实际额度会翻倍；
> 要严格限流得先把限流搬到 Redis（README 的「还没做」里也记着这条）。

### 3. IP 限流可以被 `X-Forwarded-For` 绕过 ⚠️

nginx 用的是 `$proxy_add_x_forwarded_for`（**追加**），而应用是 `TRUST_PROXY=true`
（信任所有代理），于是 `req.ip` 取的是请求头里**最左边**那个 —— 也就是客户端自己填的。

实测：

```
X-Forwarded-For: 203.0.113.7   发 70 次 → 60 × 200，10 × 429   ← 额度按这个假 IP 算
X-Forwarded-For: 203.0.113.99  再发 5 次 → 5 × 200             ← 换一个就又是满额度
```

任何人都能靠轮换这个头绕开所有按 IP 的限流（认领、过桥、token、stats）。

**修法（二选一，推荐第一个）：**

```nginx
# nginx：用真实对端地址覆盖，而不是追加
proxy_set_header X-Forwarded-For $remote_addr;
```

或者把 Fastify 的 `trustProxy: true` 改成具体的跳数（`1`）。

### 4. 同一行的并发写会串行

100 个并发 `inc` 打同一行，p50 482ms、单行约 200 次/秒。这是 `SELECT … FOR UPDATE`
行锁的必然结果（也是「不丢更新」的代价）。世界 boss 那种全服打一行的场景，几百人同时
点会看到 0.5 秒左右的延迟 —— 对游戏来说可以接受，但前端别把「扣血」做成同步等待，
并且要能容忍 429/超时后重试。

### 5. `/api/stats` 限流很紧、查询不轻

它是 5 个 `count/sum` 子查询，实测 p99 129ms；但额度只有 60/分钟/IP。
公开接口被刷是必然的，当前策略是「宁可多 429」—— 如果前端有轮询，注意别把自己 429 了
（建议前端降到 30 秒一次以上，或者干脆静态化/缓存几秒）。

---

## 四、建议（按性价比）

| 优先级 | 改动 | 收益 |
|---|---|---|
| 高 | `verifyToken` 里缓存公钥（进程内 + 短 TTL） | 每个鉴权请求少一次 DB 往返 |
| 高 | nginx 改 `X-Forwarded-For $remote_addr` | 堵掉限流绕过 |
| 中 | 需要更高吞吐时上 pm2 cluster（同时把限流迁到 Redis） | 用满第二个核 |
| 中 | `/api/stats` 加 5–10 秒缓存 | 少打数据库，p99 更稳 |
| 低 | 给 `tools/loadtest.mjs` 加个「多 IP 模拟」开关 | 压测时不用手工伪造 header |

---

## 五、怎么复现

```bash
# 应用层（在服务器上）
node tools/loadtest.mjs http://127.0.0.1:8787/health 50 10
node tools/loadtest.mjs http://127.0.0.1:8787/.well-known/jwks.json 50 10

# 真实链路
node tools/loadtest.mjs https://www.oxth.com:8443/health 20 5

# 限流接口：用 --count 把请求数控制在额度内，才能量到干净的延迟
node tools/loadtest.mjs https://www.oxth.com:8443/api/stats 5 20 --count 50

# 并发写（需要一枚 JWT）
node tools/loadtest.mjs "https://www.oxth.com:8443/api/kv/<scope>" 100 30 --count 100 \
  --method PATCH --body '{"inc":{"tagInt1":1}}' --header "Authorization: Bearer <jwt>"
```

---

## 附：测试数据清理

测并发写时用一个一次性身份建了一行测试数据，测完已经删干净：

```
DELETE /api/kv/loadtest/<uid>    → 200
auth_code 1 条 / identity_usage 1 条 / app_user 1 条 → 已删除
```

未触碰任何真实用户的数据。

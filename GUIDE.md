# xmeta 使用说明

这份讲**怎么用**：几个能直接抄的场景。
接口的参数、返回、错误码在 [API.md](API.md)。

---

## 先记住这几条

1. **数据按「类」放**（`scope`）。一个用户在一个类下**只能有一条**，重复 `PUT` 就是覆盖那一条。
2. **存 id，不存名字。** 玩家名会改，uid 不会。要显示名字时用 `POST /api/user/profiles` 现换。
3. **默认是私有的。** 不给 `isPublic: true`，别人读不到；不给 `openEdit`，别人改不了。
4. **改数据用 `PATCH`。** `PUT` 是整行覆盖，没写的字段会**清空**。
5. **加数字用 `inc`。** 自己「读出来加一再写回去」在并发下必然丢更新。
6. **不是长期存储。** 写的时候可以带 `ttl`（**秒**，单次最多 30 天）定有效期；带一次就从当前时刻重算一次（续期），不带就不动。到点就查不到了 —— 自己的存档自己存。
7. **「私有」是对其他玩家私有，对作者不是。** 玩家写进来的东西作者看得到。
8. **日志是白送的事件流。** 每次改动都留一条（谁、动了哪个字段、改前改后）。要记「谁干了什么」这种流水，从日志拿，**别一件事占一条数据**。

---

## 场景一：背包（只有自己看得见）

一个玩家一个背包。存 itemId，渲染时本地查表。

```js
// 建 / 覆盖背包
await kv('PUT', '/api/kv/bag', {
  ttl: 30 * 24 * 3600,
  isPublic: false,          // 默认就是 false，写出来是为了明确
  openEdit: [],             // 不给任何人改
  tagInt1: 500,             // 金币
  extra: { items: [{ id: 'sword', n: 1 }, { id: 'potion', n: 3 }] }
})

// 捡到东西：只改 extra
await kv('PATCH', '/api/kv/bag', {
  extra: { items: [{ id: 'sword', n: 1 }, { id: 'potion', n: 4 }] }
})

// 捡到金币：用 inc，别读出来加一再写回去
await kv('PATCH', '/api/kv/bag', { inc: { tagInt1: 50 } })

// 读
const { data } = await kv('GET', '/api/kv/bag')
// data 是 null = 还没建过（不是出错）
```

**金币为什么不放 `extra`？** `extra` 每次都得整个重写，两个人同时捡东西就会互相覆盖。

> `extra` 序列化后不能超过 **2048 字节**。道具多的话只在里面存 id 数组，名字/图标放本地。

---

## 场景二：世界 boss（所有人一起打）

关键点：**boss 那一行是作者建的**，玩家用 `?uid=<作者的 uid>` 去改它，**开一个数字标签当血量**给所有人打。

```js
// 作者：建 boss（admin 开头的 scope 只有作者建得了）
await kv('PUT', '/api/kv/admin_world', {
  ttl: 30 * 24 * 3600,
  isPublic: true,                 // 所有人都要读得到血量
  openEdit: ['tagInt2'],         // 只开血量这一个字段
  tagInt2: 100000,                // tagInt1 只有 ±32767，血量用 tagInt2
  text1: '世界 Boss',
  extra: { respawn: '每天 20:00' }
})

// 玩家：打一下（AUTHOR_UID 是作者的 uid，玩具自己知道）
const r = await kv('PATCH', `/api/kv/admin_world?uid=${AUTHOR_UID}`, {
  inc: { tagInt2: -37 }
})
console.log('剩余血量', r.data.tagInt2)   // 新值直接就在返回里
```

```js
// 任何玩家：读当前血量（isPublic: true 所以读得到）
const { data } = await kv('GET', `/api/kv/admin_world?uid=${AUTHOR_UID}`)
if (data.tagInt2 <= 0) showBossDead()
```

**为什么必须用 `inc`：** 100 个人同时点，客户端自己算的话最后只会记一次。`inc` 是服务端 `col = col + n`，一条都不会丢。

**服务端不管业务边界** —— 血量能打成负数，是玩具自己在前端把 `-100` 显示成 `0`。

**结算**：作者自己 `GET` 那条看到 `tagInt2 <= 0`，就 `PATCH` 把血量写回满值、或者发奖励。走一次就够，不用轮询得太勤（读限流 240 次/分钟）。

> **boss 要长期开着，记得续期。** 一条数据单次最多存 30 天，所以别让它到期消失 —— 作者自己（或者替玩家建行的 toy 作者）定期推一下：
> `PATCH /api/kv/admin_world?uid=<作者uid> { "ttl": 2592000 }`。这一下不改数据，纯粹把过期时间从「现在」往后推 30 天。

> **「谁打了多少」不用另开数据。** 每次 `inc` 都会在 boss 这条数据的日志里留一条 —— 是谁打的、加减了多少，全在里面。伤害榜直接算出来就行，见[场景六](#场景六日志当事件流谁干了什么)。

---

## 场景三：家园（别人能来看，但改不了）

公开 + **只读**：`isPublic: true` + `openEdit: []`。

```js
// 房主：布置自己的家园
await kv('PUT', '/api/kv/home', {
  ttl: 30 * 24 * 3600,
  isPublic: true,
  openEdit: [],                                   // 开了公开，但谁都不许改
  text1: '我的小院子',
  extra: { layout: ['tree', 'fence', 'well'] }
})

// 任何玩家：去别人家看看
const { data } = await kv('GET', `/api/kv/home?uid=${OTHER_UID}`)
if (!data) return showEmptyPlot()      // null = 对方还没建家园，不是出错
render(data.extra.layout, data.text1)

// 逛「家园广场」：列出所有人的公开家园
const { items, hasNext } = await kv('GET', '/api/kv/home/list?page=1&size=20')

// 显示房主名字（数据里只有 uid）
const { profiles } = await kv('POST', '/api/user/profiles', {
  uids: items.map(r => r.uid)          // 一次最多 100 个，正好是一页的最大长度
})
const nameOf = Object.fromEntries(profiles.map(p => [p.uid, p.nickname]))
```

**只能有一个家园**（一个人一个 scope 一条）。想做多个，把多个坐标塞进 `extra` 里自己切。

> 列表**只返回公开的**（除非你是作者）。所以别人没开 `isPublic` 的家园，你既搜不到也进不去。
>
> 头像记得加 `referrerPolicy="no-referrer"`，那是 B站 CDN 的图。

---

## 场景四：留言板（别人能往你的数据里写）

公开 + **开放某个字段**给别人改。

```js
// 房主：开一个留言位
await kv('PUT', '/api/kv/board', {
  ttl: 30 * 24 * 3600,
  isPublic: true,
  openEdit: ['text1'],        // 只开放 text1
  text1: '欢迎来玩',
  text2: '签名档'
})

// 别人：留言
await kv('PATCH', `/api/kv/board?uid=${HOST_UID}`, {
  text1: '我来过啦'            // 请求体里是驼峰 text1
})
```

改别人没开放的字段 → `403`，报错信息里会告诉你那条开放了哪些。

字段名一律**驼峰**，请求体和 `openEdit` 里都是 `text1`。（老代码里写的 `text_1` 也还认，新写就别用了。）

**这是一块牌子**：一个人一个 scope 只能有一条，所以谁都只能留一句，后写的盖掉前一句。

要留言**流**（一条条叠起来、还能看到历史），两条路：

- **一人一条**：各自 `PUT /api/kv/msg { text1 }`，读的时候 `GET /api/kv/msg/list` 汇总。能读能改，代价是每人占一条额度。
- **写在同一条上，拿日志当历史**：所有人 `PATCH` 房主那条的 `text1`，日志里就留下了每一句话和是谁说的，**不占额外额度**。见[场景六](#场景六日志当事件流谁干了什么)。

---

## 场景五：排行榜

一人一条，公开，客户端排序。

```js
// 自己上报
await kv('PUT', '/api/kv/rank', {
  ttl: 30 * 24 * 3600, isPublic: true,
  tagInt2: 982341,            // 分数；tagInt1 只有 ±32767，分大就用 tagInt2
  text1: '第 3 关'
})

// 拉榜单
const { items } = await kv('GET', '/api/kv/rank/list?page=1&size=100')
const top = items.sort((a, b) => b.tagInt2 - a.tagInt2).slice(0, 10)

// 补名字
const { profiles } = await kv('POST', '/api/user/profiles',
  { uids: top.map(r => r.uid) })
```

分页：`total` 是总数，`hasNext` 是还有没有下一页。翻页就 `page=2&size=100`。

> 一次最多 100 条，要更多就多翻几页。想按某个标签筛：`?tagTinyint=1`（比如「已出战」）。

## 场景六：日志当事件流（谁干了什么）

**每次改动都会留一条日志**，记着三件事：谁动的（`actorUid`）、动了哪个字段、改前改后的值。
这些**不占额度** —— 日志是附在数据上的，不是新数据。

所以「谁打了 boss 多少血」，直接从 boss 那条的日志里拿，不用给每个人开一条数据：

```js
const { items, total } = await kv(
  'GET', `/api/kv/admin_world/${AUTHOR_UID}/log?page=1&size=100`)

// 每条 update 的 before/after 里就是那次加减的前后值，差值就是这一下打了多少
const hits = items
  .filter(e => e.action === 'update' && e.changed.includes('tagInt2'))
  .map(e => ({ uid: e.actorUid, dmg: e.before.tagInt2 - e.after.tagInt2 }))
  .filter(h => h.dmg > 0)                  // 作者把血加回去的那几次不算伤害

// 按人汇总，做伤害榜
const byPlayer = {}
for (const h of hits) byPlayer[h.uid] = (byPlayer[h.uid] ?? 0) + h.dmg
const board = Object.entries(byPlayer).sort((a, b) => b[1] - a[1])

// 补名字
const { profiles } = await kv('POST', '/api/user/profiles', { uids: board.map(([uid]) => uid) })
```

日志里的 `changed` / `before` / `after` 和写接口返回的 `changed` 是同一套字段名。

**同一招还能用在别处：**

| 想要的东西 | 怎么留痕 |
|---|---|
| 谁来过我家 | 拜访时 `PATCH` 房主那条，`inc` 一个访问计数 —— 日志里就有「谁、什么时候」 |
| 谁给我送过礼 | 送礼时 `inc` 一个礼物计数，日志留底 |
| 世界频道 / 留言流 | 所有人写**同一条**的 `text1`，日志就是完整历史（每条 `after.text1` 就是那句话） |
| 谁改过我的公共数据 | 本来就是日志的用途 |

**什么时候别用它：**

- **要长期归档的** —— 数据一删，日志跟着级联删。它记的是「这条数据身上发生过什么」，不是档案柜。
- **要跨行汇总的** —— 日志是**逐行**的，一个人的日志只有他那条上的事。要一个统一的事件流，就得让所有人都写在同一行上。
- **要全量排行榜 / 玩家很多时** —— 一人一条汇总行，列表用 `?sort=tagInt2&order=desc` 取前 N。翻日志聚合的代价是「攻击次数」，全量榜的代价应该只跟「玩家数」有关；百万级玩家也不是 KV 该干的事，得放到自己的后端。
- **写得太频繁的** —— 写和读日志都是每人 120 次/分钟，打 boss 的次数天花板就是它。
- **想记「谁来看过」的** —— 只有 create / update 会留痕，单纯读一眼不记；改完值没变也不记。

---

## 抄一个就够用的封装

```js
const API = 'https://your-api.example.com'

async function kv(method, path, body) {
  const jwt = XMETA.getSession()?.jwt          // SDK 里拿
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(jwt ? { Authorization: 'Bearer ' + jwt } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  const json = await res.json().catch(() => null)
  if (!res.ok) {
    // 按 code 分支，别按 message 匹配
    const code = json?.error?.code
    if (code === 'unauthorized') XMETA.login()          // 令牌过期了，重新授权
    throw new Error(code + ': ' + json?.error?.message)
  }
  return json
}
```

`XMETA` 从哪来、令牌怎么拿，见 [README](README.md) 和 [API.md 的 3、4 节](API.md)。

---

## 常见坑

| 现象 | 原因 |
|---|---|
| 读出来 `data: null` | 还没建过，或者**已经过期了**。不是出错，重新 `PUT` 一条 |
| 用 `PUT` 改数据，别的字段没了 | `PUT` 是整行覆盖。改数据用 `PATCH` |
| 两个人同时加分，少的没算上 | 自己读出来加一再写回去必然丢更新。用 `inc` |
| `400 invalid_param`，说「不认识的字段」 | 字段名写错了（比如把 `tagInt1` 写成 `tag_int1`）。一律驼峰 |
| `403` 改不动别人的数据 | 对方没开 `openEdit`，或者没开你改的那个字段 |
| `409 quota_exceeded` | 一个玩具里每人最多 128 条（作者 512 条）。删掉不用的腾地方 |
| `401 unauthorized` | 令牌没了或过期了。重新走一次授权，最长 24 小时 |
| 长期开着的东西突然查不到了 | 有效期到了。写的时候带 `ttl`（秒）续一次，单次最多 30 天 |
| 写完了但日志里没记录 | 看响应里的 `modified`：`false` 就是你提交的内容和原来一模一样，什么都没改 |
| 玩家说「刚玩到一半就掉线了」 | 令牌到期了。把剩余时间显示给用户（`XMETA.getRemainingMs()`） |
| 日志里没有我要的记录 | 只记 create / update，读不记；值没变也不记。确认你要的字段真的动了 |

---

## 关于额度：128 条真的够吗

够用，前提是**一条换一批，而不是一样一条**。

- 背包 → 1 条（东西全塞 `extra` 里）
- 家园 → 1 条
- 自己的战斗记录 → 1 条（数组塞 `extra`）
- 排行榜 → 1 条/人
- **世界 boss 伤害 → 0 条**（日志里本来就有）
- **谁来过我家、谁送过礼 → 0 条**（同上）

按「一人一样」算，128 条能放 128 样东西。会撑爆的是**「一件事一条」** —— 一次战斗一条、一句话一条。
这些要么塞进 `extra`，要么靠日志（见[场景六](#场景六日志当事件流谁干了什么)）。
真要长期留存的，存到你自己的地方：xmeta 只负责交换，不是档案柜。

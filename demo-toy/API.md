# 拿到 JWT 之后：联机数据 API

认领、拿 JWT 见 `CLAIM.md` 和 `JWT.md`。这份只讲拿到凭证后怎么读写数据。

- 基址：`https://www.oxth.com:8443`
- 请求头：`Authorization: Bearer 你的JWT`
- 请求和响应都是 JSON，请求体上限 64KB
- CORS 默认放行 `bilibilitoy.com` 和 `bilibili.com`
- 数据接口按 JWT 里的 `aud`（你的 toy）和 `sub`（用户）归属，**不要在请求体里传 toy 或 uid**

## 一、有哪些接口

| 方法 + 路径 | 用途                     |
|---|------------------------|
| `GET /api/kv/:scope` | 读一条数据                  |
| `GET /api/kv/:scope/list` | 列一个 scope，分页 / 筛选 / 排序 |
| `PUT /api/kv/:scope` | 新建或整行覆盖                |
| `PATCH /api/kv/:scope` | 改几个字段，或原子加减            |
| `DELETE /api/kv/:scope/:uid` | 删一条                    |
| `DELETE /api/kv/:scope?all=1` | 删整个 scope（只有作者）        |
| `GET /api/kv/:scope/:uid/log` | 某条数据的改动日志              |
| `POST /api/user/profiles` | 批量把 uid 换成昵称头像         |
| `POST /api/oauth/introspect` | 服务端确认一枚 JWT 还有效        |

`uid` 不传就是自己；传 `?uid=` 是操作别人，权限照下面算。

列表支持 `page`、`size`（最多 100）、`tagTinyint`、`tagBigint`、`q`（搜 `text2`）、`sort`、`order`。

`profiles` 一次最多 100 个 uid，只返回在本 toy 出现过的人。出错统一是 `{ "error": { "code", "message" } }`，按 `code` 分支，别匹配 `message`。

### 怎么发

| fetch 的 method | 什么时候用 |
|---|---|
| `GET` | 读，参数拼在 URL 上，不带 body |
| `PUT` | 建一条，或整行覆盖 |
| `PATCH` | 只改一部分，推荐日常都用它 |
| `DELETE` | 删 |
| `POST` | 只有 `profiles`、`introspect` 这类动作接口用 |

```js
const API = 'https://www.oxth.com:8443'

async function kv(method, path, body) {
  const jwt = XMETA.getSession()?.jwt
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(jwt ? { Authorization: 'Bearer ' + jwt } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) {
    const code = json?.error?.code
    if (code === 'unauthorized') XMETA.login()
    throw new Error(code + ': ' + json?.error?.message)
  }
  return json
}
```

```js
// 建 / 覆盖自己的背包
await kv('PUT', '/api/kv/bag', {
  ttl: 2592000,
  isPublic: false,
  openEdit: [],
  tagInt1: 500,
  extra: { items: ['sword', 'potion'] }
})

// 读自己
const { data } = await kv('GET', '/api/kv/bag')

// 原子加金币
const r = await kv('PATCH', '/api/kv/bag', { inc: { tagInt1: 50 } })
console.log(r.data.tagInt1)   // 新值直接就在返回里

// 排行榜前 100
const { items } = await kv('GET', '/api/kv/rank/list?size=100&sort=tagInt2&order=desc')
```

## 二、数据长什么样

一条数据 = 一个用户在一个 scope 下的一行。

| 字段 | 类型 | 范围 / 说明 |
|---|---|---|
| `tagTinyint` | int | 0 ~ 255，当 boolean 就传 0/1 |
| `tagInt1` | int | -32767 ~ 32767 |
| `tagInt2` | int | -21 亿 ~ 21 亿 |
| `tagBigint` | string | 64 位整数，收字符串 |
| `text1` | string | 最多 128 字 |
| `text2` | string | 最多 512 字 |
| `textLong` | string | 最多 1024 字 |
| `extra` | JSON | 最多 2048 字节，能塞数组和对象 |
| `isPublic` | bool | 默认 `false`，只有自己和作者能读 |
| `openEdit` | string[] | 别人能改哪些字段，空数组 = 只读 |
| `expiresAt` | string | 过期时间（ISO） |
| `uid` `scope` | string | 属主、分类 |
| `createdAt` `updatedAt` | string | ISO 时间 |

- 字段名一律**驼峰**。写成 `tag_int1` 会 `400`，不会静默丢掉。
- `PUT` 没写的字段会被**清空**；`PATCH` 没写就不动，显式传 `null` 才清空。
- 写接口返回的 `data` 是写完后的整行，`changed` 是这次动了哪些字段。
- 权限：自己的行全字段可改；别人的行要 `isPublic` 才读得到，改只能动 `openEdit` 里的字段；作者对本 toy 所有行有最高权限（含别人的私有行）。
- `openEdit` 只能放那 7 个数据字段，**`extra` 永远不能开放给别人改**；`inc` 只支持四个数字标签。

## 三、Scope

`scope` 是数据分类，不是表。一个用户在一个 scope 下**只能有一条**，重复 `PUT` 就是覆盖。

- 格式：小写字母开头，只能用 `a-z 0-9 _`，最长 16 位。
- 例子：`bag`、`home`、`board`、`rank`、`lobby`。
- 设计时**一个分类一个 scope**，别一个道具一个 scope；一堆同类数据塞进 `extra`。
- `admin` 开头的 scope 建给作者：只有 toy 作者能创建，通常放共享数据（世界 boss、大厅）。玩家能不能改，由那条数据的 `openEdit` 决定。

## 四、限流

固定 60 秒窗口，超了返回 `429 rate_limited`，`detail.retryAfter` 是还要等几秒。**按这个预算设计，实际略高：**

| 接口 | 建议上限 |
|---|---|
| 读一条 | 60 次/分钟 |
| 列表 / 日志 / profiles | 30 次/分钟 |
| 写（PUT / PATCH） | 60 次/分钟 |
| 删除 | 10 次/分钟 |
| 换 JWT | 10 次/分钟 |
| introspect | 30 次/分钟 |

数据接口按 **uid** 算，一个玩具的所有玩家各算各的；换 token / introspect 按 **IP** 算。

## 五、KV 生命周期

- 单次写入最多 **30 天**（`ttl: 2592000` 秒）；不传 `ttl` 的新数据默认 **7 天**。
- 续期是**显式**的：`PATCH { "ttl": 2592000 }`，用用户自己的 JWT。改别的字段不会顺手续期。
- 过期后 `GET` 返回 `data: null`；服务端约每 30 分钟清理一次，数据行和它的日志一起删掉，**无法恢复**。
- 额度：普通用户每个 toy 最多 **128 条**，toy 作者 **512 条**（按这条数据的属主算）。过期但还没清理的行仍占额度。
- 作废的数据及时 `DELETE`；过期或删掉就没了。

**这里不是长期存储。** 重要数据要按时落盘到 B站官方 toy 云存储（那里才是永久），别把 xmeta 的 KV 当档案柜。

## 六、日志

每条数据都有日志，记 `create` / `update`，**读不记、删除不记**。日志跟着数据走，数据删了日志一起删；私有数据的日志只有属主和作者看得到。

| 字段 | 说明 |
|---|---|
| `actorUid` | 谁动的手（作者替玩家改就记作者） |
| `action` | `create` / `update` |
| `changed` | 这次动了哪些字段 |
| `before` / `after` | 只含被改字段的前后值 |
| `createdAt` | 时间 |

```js
// 聊天记录：所有人都写同一行的 text1，日志就是完整历史
const { items } = await kv(
  'GET', '/api/kv/lobby/' + HOST_UID + '/log?size=100&changed=text1'
)
```

**数字用 `inc` 传差值，不要传结果。** 服务端执行 `col = col + 差值`，并发不会丢：

```js
// 打 boss：公共血量 -37，自己的伤害行 +37
await kv('PATCH', '/api/kv/admin_world?uid=' + AUTHOR_UID, { inc: { tagInt2: -37 } })
await kv('PATCH', '/api/kv/damage', { inc: { tagInt2: 37 } })

// 有人来我家：访问计数 +1，日志里就有「谁来过」
await kv('PATCH', '/api/kv/home?uid=' + OWNER_UID, { inc: { tagInt1: 1 } })
```

日志适合做事件流：谁打了多少伤害、谁来过、聊天内容，都能从 `before` / `after` 和 `actorUid` 里还原，不占额外额度。但它空间有限，别把每秒心跳写进去；写得太频繁会让日志表膨胀，也可能被服务端清理。要长期保存就落盘。

## 七、注意事项

- **用户输入先过合规检查。** 会展示给别人的文本，写入前调 `toy.checkInputSafety({ text, scene })`，只有 `passed === true` 才写。`rejected`、`unavailable`、环境不支持、调用异常一律不放行（`unavailable` 不等于通过）。提交时调一次，别每次按键都调；`text` 最多 16384 字节，`scene` 用 ASCII 业务标记。
- **JWT 存云存储要等异步结束。** `toy.getCloudStorage` 是异步的，存 JWT 或读 JWT 之前都必须先 `await`，否则容易出 bug。JWT 最长 24 小时，到期要重新授权。
- **30 天是硬线。** 用户超过 30 天不来，数据会被清理，无法找回。长期数据要定期落盘到官方云存储；不用的 KV 及时删除腾额度。
- **按 `error.code` 分支，别按 `message`。** `401` 重新授权；`409 quota_exceeded` 删旧数据；`429` 按 `retryAfter` 退避。
- **私有是对其他玩家私有，作者看得见。** 别让玩家误以为作者也看不到。
- **列表最多有 30 秒缓存。** 刚写完的那条以写接口返回为准，别马上列表回读。

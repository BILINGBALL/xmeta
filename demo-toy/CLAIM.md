# 怎么认领一个 toy

认领就是证明「这个 toy 是我发布的」。做完拿到一个 `client_id`，你的 toy 就能用 xmeta 的联机身份了。

不写后端、不配回调，就三步。

## 先确认

- 你的 toy 已经发布
- 知道它的 slug：地址 `.../toy/<这一段>/index.html` 中间那一段
- 能改它的 `index.html` 并重新发布

## 第一步：打开认领页

进中心 toy `xmeta`，点「认领我的 toy」：

```
https://www.bilibili.com/toy/xmeta/index.html
```

## 第二步：填 slug，拿验证码

填上你的 toy slug，点「下一步」。

页面会给你一行：

```html
<meta name="xmeta-verify" content="一串验证码">
```

## 第三步：写进 index.html，发布，验证

把这行加到**入口那个** `index.html` 的 `<head>` 里，位置随意：

```html
<head>
  <meta charset="utf-8">
  <meta name="xmeta-verify" content="一串验证码">
  <!-- 你原来那些 -->
</head>
```

保存、发布，再回认领页点「我已发布，开始验证」。

通过后页面直接给你 `client_id`，填进来就完事：

```js
XMETA.configure({
  apiBase: 'https://www.oxth.com:8443',
  centerToySlug: 'xmeta',
  clientId: '认领拿到的那个'
})
```

## 注意

- 验证码 **24 小时**内有效，验证通过后那行可以删掉。
- 重复点「下一步」还是同一枚码，不用重新发布。
- 要写进**入口** `index.html`，写别的文件不算。
- 改完**必须发布**，只保存不发布不算。
- 一个 toy 只归一个账号，被别人先认领了你就认不了。

## 报错看这里

| 页面提示 | 多半是 |
|---|---|
| 源码里没找到验证码 | 没发布 / 写到了别的文件 / 页面上还是旧验证码 |
| 这个 toy 已被认领 | 被别的账号认领走了 |
| 抓取页面失败 | B站那边暂时抓不到，过会儿再试 |
| 当前环境不支持获取用户信息 | 在 B站 App 或电脑浏览器里打开认领页 |

---

**为什么这么验？** toy 的 SDK 不返回 B站 UID，客户端报上来的昵称头像谁都能伪造。能改 `index.html` 并且发布出去，才是「这个 toy 归你」的硬证据。

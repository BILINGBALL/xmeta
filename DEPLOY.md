# 部署

## 0. 前置条件

| 需要什么 | 为什么 |
|---|---|
| 一台有**公网域名 + HTTPS** 的服务器 | 玩具跑在 `https://www.bilibilitoy.com`，浏览器会拦 http 的混合内容。**没有 HTTPS 整个服务用不了** |
| Node.js ≥ 20（建议 22） | `engines` 要求 |
| PostgreSQL | 已经在用阿里云 RDS |
| 域名解析 | 例：`api.xmeta.xxx.com` → 服务器 IP |

> 玩具访问你的 API 是**跨域**的，服务已经放开了 `ALLOWED_ORIGINS=https://www.bilibilitoy.com`。
> 如果换成自己托管的玩具域，记得同步改。

---

## 1. 数据库

RDS 不用新建实例，只要：

1. **把服务器 IP 加进 RDS 白名单**（阿里云控制台 → RDS → 数据安全性 → 白名单）。
   不加的话服务器连不上，报 `connect ETIMEDOUT`。
2. 确认账号有 `CREATEDB` 权限（`db:create` 要用）。

库和表都由脚本创建，不用手工建。

---

## 2. 服务器

### 2.1 装 Node

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git
node -v   # 应 >= v20
```

### 2.2 拉代码

```bash
sudo mkdir -p /srv && cd /srv
sudo git clone https://github.com/BILINGBALL/xmeta.git ucs
sudo chown -R $USER:$USER /srv/ucs
cd /srv/ucs
npm ci
```

### 2.3 配置

```bash
cp .env.example .env
nano .env
```

**必须改的**：

```ini
DATABASE_URL=postgresql://<用户名>:<密码>@<RDS内网地址>:5432/ucs
PUBLIC_BASE_URL=https://api.你的域名.com     # ← 必须和真实访问地址完全一致
MY_TOY_ID=39945062320128                     # xmeta 的 toy_id
MY_TOY_SLUG=xmeta
ALLOWED_ORIGINS=https://www.bilibilitoy.com
TRUST_PROXY=true                             # 在 nginx 后面，必须开
```

> `PUBLIC_BASE_URL` 会写进 JWT 的 `iss`，也是 `/.well-known/ucs-configuration`
> 里发布的 issuer。**写成 http 或写成内网地址都会让接入方的验签失败。**
> RDS 建议用**内网地址**，走公网既慢又可能被白名单挡。

### 2.4 建库建表

```bash
npm run db:create     # 只建库，不动已有数据
npm run db:migrate    # 建表（幂等的，重复跑没事）
npm run build
```

### 2.5 常驻运行

用 PM2：

```bash
sudo npm i -g pm2
pm2 start dist/server.js --name ucs
pm2 save
pm2 startup     # 照着输出的提示再执行一次它给的那行命令
```

服务启动时会自动跑一次迁移并加载签名密钥，日志里会打印
`[ucs] 签名密钥就绪` 和 `[ucs] 监听 http://...`。

> ⚠️ `MY_TOY_ID` / `MY_TOY_SLUG` 还是占位值时启动会打警告。看到警告说明没配好。

---

## 3. nginx + HTTPS

```nginx
server {
    listen 443 ssl http2;
    server_name api.你的域名.com;

    ssl_certificate     /etc/letsencrypt/live/api.你的域名.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.你的域名.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name api.你的域名.com;
    return 301 https://$host$request_uri;
}
```

证书用 certbot：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.你的域名.com
```

> `X-Forwarded-For` 那两行必须有，配合 `TRUST_PROXY=true` 才能拿到真实 IP。
> 拿不到真实 IP 的话限流会把所有玩家当成同一个人。
> 反过来说：**没放 nginx 时千万不要把 `TRUST_PROXY` 设成 true**，否则客户端可以伪造 IP 绕过限流。

### 安全组

- 开放 `443`（和 `80`，用于证书续期跳转）
- **不要**开放 `8787`
- RDS 的 `5432` 只对服务器 IP 开放

---

## 4. 上线后自查

```bash
curl https://api.你的域名.com/health
curl https://api.你的域名.com/.well-known/jwks.json
curl https://api.你的域名.com/.well-known/ucs-configuration
```

`jwks.json` 应该返回一把 `"kty":"EC","crv":"P-256"` 的密钥。
`ucs-configuration` 里的 `issuer` 应该等于你的 `PUBLIC_BASE_URL`。

再验一下 CORS（玩具是跨域调用的，这条不过整个链路就废了）：

```bash
curl -i -X OPTIONS https://api.你的域名.com/api/bridge/authorize \
  -H "Origin: https://www.bilibilitoy.com" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type" | grep -i access-control
```

应该能看到 `access-control-allow-origin: https://www.bilibilitoy.com`。

---

## 5. 更新玩具端

1. 把 `toy-side/` 下的 `index.html`、`claim.html`、`bridge.html` 里的
   `const API_BASE = 'http://127.0.0.1:8787'` **改成你的 HTTPS 域名**。

   > 忘了改是新手最常见的坑：`127.0.0.1` 在用户手机上指的是用户自己的手机。

2. 把三个文件上传到 `xmeta`（覆盖原来的 `index.html`），发布。
   `ucs-client.js` 是给第三方玩具作者用的，不用传到 xmeta。

3. **在 B站 玩具后台开启 `xmeta` 的 OpenID 模式。**
   不开的话 `getUserProfile()` 不返回 `toyOpenId`，整条链断在第一环。

4. 在手机 B站 App 里打开 `xmeta`，走一遍认领流程试试。

---

## 6. 排障

| 现象 | 原因 |
|---|---|
| 页面报 `Failed to fetch` | `API_BASE` 没改成 HTTPS 域名，或 CORS 没放开 |
| `getUserProfile` 抛 `unsupported` | 在外部手机浏览器里打开了。只能在 B站 App 内或桌面 Web 用 |
| 拿不到 `toyOpenId` | 玩具没开 OpenID 模式 |
| 认领报 `nonce_not_in_source` | 改了没重新发布，或 nonce 没写进 `index.html`（要写进入口那个文件） |
| 认领报 `upstream_fetch_failed` | 服务器访问不了 `bilibili.com`，检查出网和 DNS |
| 限流报 429 | 限流是单实例内存态。多实例部署要换 Redis，见 README「还没做」 |
| `connect ETIMEDOUT` 连数据库 | RDS 白名单没加服务器 IP |
| 接入方验签失败 | `PUBLIC_BASE_URL` 和实际访问地址不一致 |

---

## 7. 升级

```bash
cd /srv/ucs
git pull
npm ci
npm run build
pm2 restart ucs
```

迁移是幂等的，启动时自动跑，不用单独执行。

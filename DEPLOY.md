# 部署

## 0. 前置条件

| 需要什么 | 为什么 |
|---|---|
| 一台有**公网域名 + HTTPS** 的服务器 | toy 跑在 `https://www.bilibilitoy.com`，浏览器会拦 http 的混合内容。**没有 HTTPS 整个服务用不了** |
| Node.js ≥ 20（建议 22） | `engines` 要求 |
| PostgreSQL | 已经在用阿里云 RDS |
| 域名解析 | 例：`api.xmeta.xxx.com` → 服务器 IP |

> toy 访问你的 API 是**跨域**的，服务已经放开了 `ALLOWED_ORIGINS=https://www.bilibilitoy.com`。
> 如果换成自己托管的 toy 域，记得同步改。

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
sudo git clone https://github.com/BILINGBALL/xmeta.git xmeta
sudo chown -R $USER:$USER /srv/xmeta
cd /srv/xmeta
npm ci
```

### 2.3 配置

```bash
cp .env.example .env
nano .env
```

**完整配置**（照抄，把尖括号里的换掉）：

```ini
DATABASE_URL=postgresql://<用户名>:<密码>@<RDS内网地址>:5432/xmeta
HOST=127.0.0.1
PORT=8787
PUBLIC_BASE_URL=https://api.你的域名.com
MY_TOY_ID=39945062320128
MY_TOY_SLUG=xmeta
ALLOWED_ORIGINS=https://www.bilibilitoy.com
JWT_TTL_SECONDS=900
AUTH_CODE_TTL_SECONDS=60
CLAIM_NONCE_TTL_HOURS=24
CLAIM_MAX_ATTEMPTS=10
TRUST_PROXY=true
```

三个最容易配错的：

**① `PUBLIC_BASE_URL` 必须和真实访问地址逐字符一致。**
它会写进 JWT 的 `iss`，也是 `/.well-known/xmeta-configuration` 发布的 issuer。
写成 `http://` 或内网地址，接入方验签会全部失败。

**② `DATABASE_URL` 用 RDS 内网地址，并且不要加 `sslmode`。**
这台 RDS **不支持 SSL**（实测 `sslmode=require` 直接报
`The server does not support SSL connections`）。所以：

- 加了 `sslmode=require` → 连不上
- 用**公网地址** → 密码和数据在全网明文传输

服务器和 RDS 同地域的话，一定要用控制台上的**内网地址**，流量不出 VPC。

**③ `HOST=127.0.0.1`（在 nginx 后面时）。**
默认的 `0.0.0.0` 会让 8787 对全网可访问。绑到回环地址后，
即使安全组配错了端口也不会暴露。

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
pm2 start dist/server.js --name xmeta --cwd /srv/xmeta
pm2 save
pm2 startup     # 照着输出的提示再执行一次它给的那行命令
```

> `--cwd` 不能省。`.env` 是由 dotenv 按**进程工作目录**读取的，
> 而 pm2 守护进程的工作目录未必是 `/srv/xmeta`。不指定的话会读到
> 空配置，启动时报「环境变量校验失败」。

服务启动时会自动跑一次迁移并加载签名密钥，日志里会打印
`[xmeta] 签名密钥就绪` 和 `[xmeta] 监听 http://...`。

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

#### 443 已经被别的站点占用怎么办

不用抢 443，也不必改 DNS。另开一个 TLS 端口即可（证书可以直接复用）：

```nginx
server {
    listen 8443 ssl;
    server_name 你的域名;

    ssl_certificate     /path/to/fullchain.pem;   # 用 `nginx -T | grep ssl_certificate` 查实际路径
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

这时对外地址是 `https://你的域名:8443`，`.env` 里的 `PUBLIC_BASE_URL`
和 toy 端 `API_BASE` 都要带上端口号。记得在安全组放行 `8443`。

> 端口可以换，但**协议不能是 http**。toy 页面跑在 https 上，
> 它调 http 接口会被浏览器按混合内容拦掉——只有 `127.0.0.1`
> 是例外（Chrome 把它当作可信来源），所以本地能跑通不代表线上能跑通。

---

## 4. 上线后自查

```bash
curl https://api.你的域名.com/health
curl https://api.你的域名.com/.well-known/jwks.json
curl https://api.你的域名.com/.well-known/xmeta-configuration
```

`jwks.json` 应该返回一把 `"kty":"EC","crv":"P-256"` 的密钥。
`xmeta-configuration` 里的 `issuer` 应该等于你的 `PUBLIC_BASE_URL`。

再验一下 CORS（toy 是跨域调用的，这条不过整个链路就废了）：

```bash
curl -i -X OPTIONS https://api.你的域名.com/api/bridge/authorize \
  -H "Origin: https://www.bilibilitoy.com" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type" | grep -i access-control
```

应该能看到 `access-control-allow-origin: https://www.bilibilitoy.com`。

---

## 5. 更新 toy 端

1. 把 `toy-side/` 下的 `index.html`、`claim.html`、`bridge.html` 里的
   `const API_BASE = 'http://127.0.0.1:8787'` **改成你的 HTTPS 域名**。

   > 忘了改是新手最常见的坑：`127.0.0.1` 在用户手机上指的是用户自己的手机。

2. 把三个文件上传到 `xmeta`（覆盖原来的 `index.html`），发布。
   `xmeta-client.js` 是给第三方 toy 作者用的，不用传到 xmeta。

3. **在 B站 toy 后台开启 `xmeta` 的 OpenID 模式。**
   不开的话 `getUserProfile()` 不返回 `toyOpenId`，整条链断在第一环。

4. 在手机 B站 App 里打开 `xmeta`，走一遍认领流程试试。

---

## 6. 排障

| 现象 | 原因 |
|---|---|
| 页面报 `Failed to fetch` | `API_BASE` 没改成 HTTPS 域名，或 CORS 没放开 |
| `getUserProfile` 抛 `unsupported` | 在外部手机浏览器里打开了。只能在 B站 App 内或桌面 Web 用 |
| 拿不到 `toyOpenId` | toy 没开 OpenID 模式 |
| 认领报 `nonce_not_in_source` | 改了没重新发布，或 nonce 没写进 `index.html`（要写进入口那个文件） |
| 认领报 `upstream_fetch_failed` | 服务器访问不了 `bilibili.com`，检查出网和 DNS |
| 限流报 429 | 限流是单实例内存态。多实例部署要换 Redis，见 README「还没做」 |
| `connect ETIMEDOUT` 连数据库 | RDS 白名单没加服务器 IP |
| 接入方验签失败 | `PUBLIC_BASE_URL` 和实际访问地址不一致 |

---

## 7. 升级

```bash
cd /srv/xmeta
git pull
npm ci
npm run build
pm2 restart xmeta
```

迁移是幂等的，启动时自动跑，不用单独执行。

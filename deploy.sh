#!/usr/bin/env bash
#
# 一键部署到服务器。
#
#   ./deploy.sh root@1.2.3.4          # 或者 export XMETA_HOST=root@1.2.3.4
#
# 做的三件事：
#   1. 服务器能连 GitHub → git fetch + reset --hard origin/main
#      连不上（新服务器经常这样）→ 本机 git archive + scp + 解包
#   2. 只有 package-lock.json 变了才 npm ci
#   3. npm run build → pm2 restart → 打一次 /health
#
# 注意：
#   · 部署的是本地 HEAD 的内容，工作区里未提交的改动不会上去
#   · 服务器的工作区会被重置到 origin/main（那边不该有本地改动）
#   · .env / node_modules / dist 不在 git 里，不会被碰
#
set -euo pipefail

HOST="${1:-${XMETA_HOST:-}}"
DIR="${XMETA_DIR:-/srv/xmeta}"
APP="${XMETA_APP:-xmeta}"

if [ -z "$HOST" ]; then
  echo "用法: ./deploy.sh <user@host>   （或 export XMETA_HOST=user@host）" >&2
  exit 1
fi

cd "$(dirname "$0")"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "⚠️  工作区有未提交的改动 —— 部署的是 HEAD，不含这些改动：" >&2
  git status --short | head -10 >&2
  echo >&2
fi

echo "==> 目标 $HOST:$DIR"

# lock 的校验和：解包会刷新 mtime，所以不能用 -nt 判断
lock_sum() {
  ssh "$HOST" "cd $DIR 2>/dev/null && [ -f package-lock.json ] && md5sum package-lock.json | cut -d' ' -f1 || echo none"
}
LOCK_BEFORE=$(lock_sum || true)

# ── 1. 取代码 ───────────────────────────────────────────────
# 先花 15 秒探一下 GitHub 通不通，别让 pull 卡两分钟
if ssh "$HOST" "cd $DIR && timeout 15 git fetch -q origin main" 2>/dev/null; then
  echo "==> GitHub 可达，用 git"
  ssh "$HOST" "cd $DIR && git reset --hard origin/main && git log --oneline -1"
else
  echo "==> GitHub 不可达，改走本机打包 + scp"
  TMP="${TMPDIR:-/tmp}/xmeta-deploy-$$.tar.gz"
  git archive --format=tar.gz -o "$TMP" HEAD
  scp -q "$TMP" "$HOST:/srv/xmeta-deploy.tar.gz"
  rm -f "$TMP"
  ssh "$HOST" "cd $DIR && tar xzf /srv/xmeta-deploy.tar.gz && rm -f /srv/xmeta-deploy.tar.gz"
  echo "==> 注意：这条路径不会更新服务器的 git HEAD，下次能连上 GitHub 时"
  echo "   脚本会用 reset --hard 自动对齐，不用管。"
fi

# ── 2. 依赖：只有 lock 的内容变了才重装 ─────────────────────
echo "==> 依赖"
LOCK_AFTER=$(lock_sum || true)
if [ "$LOCK_BEFORE" != "$LOCK_AFTER" ]; then
  echo "    lock 变了，npm ci"
  ssh "$HOST" "cd $DIR && npm ci --silent"
else
  echo "    lock 没变，跳过 npm ci"
fi

# ── 3. 构建 + 重启 + 自检 ────────────────────────────────────
echo "==> 构建"
ssh "$HOST" "cd $DIR && rm -rf dist && npm run build 2>&1 | tail -2"

echo "==> 重启"
ssh "$HOST" "pm2 restart $APP --update-env >/dev/null 2>&1 && sleep 3 && pm2 list | grep $APP | head -1"

echo "==> 自检"
ssh "$HOST" "curl -sS --max-time 8 http://127.0.0.1:8787/health && echo"

echo
echo "完成。页面（toy-side/*.html）不在这个脚本里 —— 那些要手动传到 toy 平台。"

#!/usr/bin/env bash
# 在服务器上安装 / 升级。用法：
#   sudo bash deploy/install.sh
#
# 前提：仓库已经放在 /opt/super-writer，且 /opt/super-writer/.env.local 已经填好
#      DEEPSEEK_API_KEY 和 SITE_URL。
set -euo pipefail

APP_DIR=/opt/super-writer
RUN_USER=sw

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 root 运行：sudo bash deploy/install.sh"
[[ -d "$APP_DIR" ]] || die "找不到 $APP_DIR，先把仓库放到这里"

say "1/6 检查 Node"
command -v node >/dev/null || die "没装 Node。Ubuntu: curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[[ "$NODE_MAJOR" -ge 22 ]] || die "Node 版本太低（$NODE_MAJOR），需要 22 以上"
echo "    node $(node -v)"

say "2/6 检查配置"
[[ -f "$APP_DIR/.env.local" ]] || die "缺 $APP_DIR/.env.local（从 .env.example 复制并填 DEEPSEEK_API_KEY / SITE_URL）"
grep -q '^DEEPSEEK_API_KEY=sk-' "$APP_DIR/.env.local" || die ".env.local 里没有有效的 DEEPSEEK_API_KEY"
grep -q '^SITE_URL=http' "$APP_DIR/.env.local" || echo "   \033[33m提醒：.env.local 里没设 SITE_URL，订阅源里的链接会指向本地地址\033[0m"

say "3/6 建用户 $RUN_USER"
if ! id -u "$RUN_USER" >/dev/null 2>&1; then
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$RUN_USER"
  echo "    已创建"
else
  echo "    已存在"
fi

say "4/6 安装依赖"
cd "$APP_DIR"
if [[ -f package-lock.json ]]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi

say "5/6 装 systemd 单元"
install -d -o "$RUN_USER" -g "$RUN_USER" "$APP_DIR/runs"
# 全部归运行用户，这样后续 git pull 和 npm ci 都能直接用 sw 跑
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"
# 密钥只有属主能读
chmod 600 "$APP_DIR/.env.local"

install -m 644 "$APP_DIR/deploy/super-writer-reader.service" /etc/systemd/system/
install -m 644 "$APP_DIR/deploy/super-writer-night.service"  /etc/systemd/system/
install -m 644 "$APP_DIR/deploy/super-writer-night.timer"    /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now super-writer-reader.service
systemctl enable --now super-writer-night.timer
echo "    阅读器已启动，夜班已排进 02:00"

say "6/6 自检"
sleep 1
if curl -fsS http://127.0.0.1:8787/healthz >/tmp/hz.json 2>/dev/null; then
  echo "    healthz: $(cat /tmp/hz.json)"
else
  echo "    \033[31mhealthz 不通，看日志：journalctl -u super-writer-reader -n 50\033[0m"
fi

cat <<EOF

$(printf '\033[32m装好了\033[0m')

  阅读器日志   journalctl -u super-writer-reader -f
  夜班日志     tail -f $APP_DIR/runs/night.log
  手动跑夜班   systemctl start super-writer-night.service
  下次夜班     systemctl list-timers super-writer-night.timer

  如果还没配反向代理：
    把 deploy/Caddyfile 里的 example.com 换成你的域名，复制到 /etc/caddy/Caddyfile，
    然后 systemctl reload caddy
EOF

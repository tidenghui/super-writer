#!/usr/bin/env bash
# 把代码推到服务器。
#
#   首次（连书稿一起灌上去）：
#     SITE_HOST=root@1.2.3.4 SEED=1 bash deploy/push.sh
#
#   以后每次改代码：
#     SITE_HOST=root@1.2.3.4 bash deploy/push.sh
#
# 为什么不带 --delete、且默认不推 books/：
#   上线之后服务器才是内容的唯一真相（夜班在上面写新章）。
#   从本地覆盖 books/ 会把线上新写的章节抹掉。
set -euo pipefail

HOST=${SITE_HOST:?用法：SITE_HOST=user@host [SEED=1] bash deploy/push.sh}
KEY="$(cd "$(dirname "$0")/.." && pwd)/.deploy-key/id_ed25519"
DEST=/opt/super-writer
SSH_OPTS="-i $KEY -o UserKnownHostsFile=$KEY.known_hosts -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15"

[[ -f "$KEY" ]] || { echo "缺部署私钥：$KEY"; exit 1; }

echo "→ 目标 $HOST:$DEST"
ssh $SSH_OPTS "$HOST" "sudo mkdir -p $DEST && sudo chown \$(id -un):\$(id -gn) $DEST"

RSYNC_ARGS=(
  -az
  --exclude node_modules
  --exclude .npm-cache
  --exclude runs
  --exclude .git
  --exclude .deploy-key
  --exclude .env.local
  --exclude '.DS_Store'
)

if [[ "${SEED:-0}" != "1" ]]; then
  # 常规部署：不动书稿
  RSYNC_ARGS+=(--exclude books)
  echo "→ 跳过 books/（服务器上有线上章节）"
else
  # 上线之后 books/ 以服务器为准。SEED=1 只该在第一次部署时用。
  echo "→ 首次：连书稿一起推（会覆盖服务器上的 books/，仅限首次）"
  REMOTE_N=$(ssh $SSH_OPTS "$HOST" "ls $DEST/books/*/chapters/*.md 2>/dev/null | wc -l" || echo 0)
  LOCAL_N=$(ls books/*/chapters/*.md 2>/dev/null | wc -l | tr -d ' ')
  if [ "${REMOTE_N:-0}" -gt "${LOCAL_N:-0}" ]; then
    echo "！服务器上有 $REMOTE_N 章，本地只有 $LOCAL_N 章。"
    echo "！SEED=1 会用本地旧稿覆盖线上内容。确认要这么做再加 FORCE=1。"
    [[ "${FORCE:-0}" == "1" ]] || exit 1
  fi
fi

rsync "${RSYNC_ARGS[@]}" --rsync-path="sudo rsync" -e "ssh $SSH_OPTS" ./ "$HOST:$DEST/"

echo "→ 补权限"
# sudo rsync 写出来的文件属主是 root，必须还给运行用户，否则 sw 读不了代码
ssh $SSH_OPTS "$HOST" "sudo chown -R sw:sw $DEST && sudo chmod 600 $DEST/.env.local && sudo chmod +x $DEST/deploy/*.sh" || true

echo "→ 完成。接下来在服务器上跑："
echo "     sudo bash $DEST/deploy/install.sh"

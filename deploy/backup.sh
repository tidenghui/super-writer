#!/usr/bin/env bash
# 备份这本书的全部创作产物。书稿是纯文本，几十 KB，备份成本几乎为零。
#
# 挂到 cron：
#   17 3 * * * /opt/super-writer/deploy/backup.sh >> /var/log/super-writer-backup.log 2>&1
set -euo pipefail

APP_DIR=/opt/super-writer
DEST=/var/backups/super-writer
KEEP=14

mkdir -p "$DEST"
STAMP=$(date +%Y-%m-%d)
OUT="$DEST/super-writer-$STAMP.tar.gz"

tar -czf "$OUT" \
  -C "$APP_DIR" \
  books \
  config \
  .env.local \
  package.json \
  package-lock.json

# 只留最近 KEEP 份
ls -1t "$DEST"/super-writer-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

echo "$(date '+%F %T') 备份完成 $(du -h "$OUT" | cut -f1)  $OUT"

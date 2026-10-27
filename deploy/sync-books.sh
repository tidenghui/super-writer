#!/usr/bin/env bash
# 把服务器上的书同步成 GitHub 上的独立仓库。
#
#   ./deploy/sync-books.sh            同步全部
#   ./deploy/sync-books.sh mingce     只同步一本
#
# 一本书 = 一个仓库 = tidenghui/book-<slug>
# 仓库里放这本书的全部东西：圣经、正文、事实表、伏笔、特征、账本。
# 服务器仍然是唯一真相，GitHub 是公开镜像与备份。
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)
MIRROR="$ROOT/.book-mirror"
KEY="$ROOT/.deploy-key/id_ed25519"
KNOWN="$ROOT/.deploy-key/known_hosts"
HOST="ecs-user@47.253.6.103"
ORG="tidenghui"
AUTHOR_NAME="${GIT_AUTHOR_NAME:-Zhe Feng}"
AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-fengzhe1983@gmail.com}"

only="${1:-}"

echo "→ 从服务器同步 books/"
mkdir -p "$MIRROR"
rsync -az -e "ssh -i $KEY -o UserKnownHostsFile=$KNOWN" "$HOST:/opt/super-writer/books/" "$MIRROR/"

# 为一本书生成 README：书名、一句话、简介、目录
gen_readme() {
  local dir="$1" out="$2"
  python3 - "$dir" "$out" <<'PY'
import json, sys, glob, os, re
d, out = sys.argv[1], sys.argv[2]
info = {}
p = os.path.join(d, 'book.json')
if os.path.exists(p):
    info = json.load(open(p, encoding='utf-8'))
title = info.get('title', os.path.basename(d))
tagline = info.get('tagline', '')
genre = info.get('genre', '')
author = info.get('author', '灯下人')
synopsis = re.sub(r'<[^>]+>', '', info.get('synopsis', '') or '')

rows = []
for f in sorted(glob.glob(os.path.join(d, 'chapters', '*.md'))):
    n = os.path.basename(f)[:3]
    body = open(f, encoding='utf-8').read()
    name = ''
    meta_p = os.path.join(d, 'chapters', f'{n}.meta.json')
    if os.path.exists(meta_p):
        try:
            name = json.load(open(meta_p, encoding='utf-8')).get('title', '') or ''
        except Exception:
            name = ''
    if not name:
        m = re.search(r'^#\s*(.+)$', body, re.M)
        name = m.group(1).strip() if m else os.path.basename(f)
    words = len(re.sub(r'\s', '', body))
    rows.append((int(n), name, words))

total = sum(r[2] for r in rows)
lines = [f'# {title}', '']
if tagline: lines += [f'> {tagline}', '']
if genre:   lines += [f'**题材**：{genre}　**作者**：{author}　**{len(rows)} 章 · {total:,} 字**', '']
if synopsis: lines += [synopsis.strip(), '']
lines += ['## 目录', '', '| 章 | 标题 | 字数 |', '|---|---|---|']
lines += [f'| {n} | {t} | {w} |' for n, t, w in rows]
lines += ['', '---', '',
          '这本书的全部创作资料都在这个仓库里：`bible/` 是设定与大纲，`chapters/` 是正文，`canon/` 是事实表、伏笔账本、角色特征。',
          '', '写作过程就是提交历史。']
open(out, 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
PY
}

pushed=0
for dir in "$MIRROR"/*/; do
  slug=$(basename "$dir")
  [ -n "$only" ] && [ "$slug" != "$only" ] && continue
  [ -d "$dir/chapters" ] || continue

  repo="book-$slug"
  cd "$dir"

  if [ ! -d .git ]; then
    git init -q -b main
    git config user.name "$AUTHOR_NAME"
    git config user.email "$AUTHOR_EMAIL"
  fi

  gen_readme "$dir" "$dir/README.md"

  git add -A
  if git rev-parse --verify HEAD >/dev/null 2>&1 && git diff --cached --quiet; then
    echo "  $repo 无变化"
  else
    n=$(ls chapters/*.md 2>/dev/null | wc -l | tr -d ' ')
    git commit -q -m "同步：${n} 章" || true
  fi

  # 远端不存在就建一个公开仓库
  if ! git remote get-url origin >/dev/null 2>&1; then
    if gh repo view "$ORG/$repo" >/dev/null 2>&1; then
      git remote add origin "git@github.com:$ORG/$repo.git"
    else
      title=$(python3 -c "import json,sys;print(json.load(open('book.json')).get('title','$slug'))" 2>/dev/null || echo "$slug")
      gh repo create "$ORG/$repo" --public --description "$title —— 提灯会" >/dev/null
      git remote add origin "git@github.com:$ORG/$repo.git"
    fi
  fi

  git push -q -u origin main 2>&1 | tail -2 || true
  echo "  $repo ✔"
  pushed=$((pushed+1))
  cd "$ROOT"
done

echo "→ 完成：$pushed 本"

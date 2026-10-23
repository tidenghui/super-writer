# 部署手册

目标：一台服务器上同时跑**阅读器**（对外）和**夜班流水线**（每天 02:00 写一章，写完自动出现在站上）。

---

## 0. 买什么

**服务器**：2 核 2G、40G SSD、Ubuntu 24.04 LTS 就够。这套东西是纯 Node 进程 + 文本文件，
一天最多几十个请求（除非你真火了）。

**机房位置——这是唯一需要想清楚的事**：

| 选择 | 备案 | 说明 |
|---|---|---|
| 香港 / 新加坡 | **不需要** | 最快能上线。香港到大陆延迟 30–60ms，够用 |
| 大陆（阿里云/腾讯云） | **需要 ICP 备案** | 用域名 + 80/443 对公网提供服务，未备案会被服务商拦截。备案要 2–4 周，需要身份证/主体信息 |

我的建议：**先香港，跑起来再说**。等真的有读者了，再决定要不要迁回大陆并走备案。

**域名**：随便哪家注册商，A 记录指向服务器公网 IP。香港机房不需要备案就能直接上 HTTPS。

**安全组/防火墙**：放行 22、80、443。8787 端口**不要**对外——它只绑 127.0.0.1，由 Caddy 反代。

**每月成本**：服务器 ¥30–70 + 模型 API 约 ¥15（¥0.5/章 × 30 章）。

---

## 1. 装

```bash
# 本地把代码推上去，或者在服务器上 clone
sudo mkdir -p /opt && cd /opt
sudo git clone <你的仓库地址> super-writer
cd super-writer

# 填配置
sudo cp .env.example .env.local
sudo nano .env.local
```

`.env.local` 至少要有这两行：

```bash
DEEPSEEK_API_KEY=sk-xxxxxxxx
SITE_URL=https://tidenghui.com
```

> `SITE_URL` 决定 RSS 和 sitemap 里的绝对链接，不填会写成 127.0.0.1。

然后一条命令：

```bash
sudo bash deploy/install.sh
```

它会：建运行用户 `sw`、装依赖、写 systemd 单元、启动阅读器、把夜班排进 02:00，最后打一次 healthz 自检。

---

## 2. 上 HTTPS

```bash
# 装 Caddy（Ubuntu/Debian）
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

# 配站点
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile      # 确认域名是 tidenghui.com
sudo mkdir -p /var/log/caddy && sudo chown caddy:caddy /var/log/caddy
sudo systemctl reload caddy
```

Caddy 会自动申请证书。前提：域名的 A 记录已经指向这台机器，且 80/443 通。

验证：

```bash
curl -s https://tidenghui.com/healthz     # {"ok":true,"books":1,"chapters":10}
curl -s https://tidenghui.com/feed.xml | head
```

---

## 3. 日常运维

```bash
# 阅读器
systemctl status super-writer-reader
journalctl -u super-writer-reader -f

# 夜班
systemctl start super-writer-night        # 手动跑一次
systemctl list-timers super-writer-night  # 下次什么时候
tail -f /opt/super-writer/runs/night.log  # 夜班日志

# 站上现在有哪些章
cd /opt/super-writer && npm run canon
```

**写完会自动上线。** 阅读器每次请求都从磁盘读文件，不需要重启。夜班写完一章，
下一次刷新就能看到。

---

## 4. 备份

书稿是纯文本，几十 KB。

```bash
sudo cp deploy/backup.sh /usr/local/bin/super-writer-backup
sudo chmod +x /usr/local/bin/super-writer-backup

# 每天 03:17 备份，保留 14 份
echo '17 3 * * * /usr/local/bin/super-writer-backup >> /var/log/super-writer-backup.log 2>&1' | sudo crontab -
```

恢复：解开 tar 到 `/opt/super-writer`，`systemctl restart super-writer-reader`。

---

## 5. 升级代码

```bash
cd /opt/super-writer
sudo -u sw git pull
sudo npm ci --no-audit --no-fund
sudo systemctl restart super-writer-reader
```

夜班下次触发时会自动用新代码。

---

## 6. 出问题怎么查

| 现象 | 先看 |
|---|---|
| 网站打不开 | `systemctl status super-writer-reader`；`curl 127.0.0.1:8787/healthz` |
| 502 | 上面的进程挂了，或端口不是 8787 |
| 证书没发下来 | 域名是否解析到本机；`journalctl -u caddy -n 50` |
| 夜班没跑 | `systemctl list-timers`；`runs/night.log` 最后几行 |
| 夜班跑了但没新章 | 章没过闸门，会存成草稿并**停更**（连载不允许缺章）。日志里会写「第 N 章没有过线」 |
| 草稿卡住整本书 | `npm run fix -- --n N --m "批注"` 修一修，或 `npm run chapter -- --n N` 重跑 |

**重要**：流水线遇到没过闸门的章节会**停下来**，不会跳过去写下一章。所以日志里看到
「没有过线」时，站上不会出现缺章，但也不会继续更新，需要人工介入（改批注或重跑）。
这是故意的——宁可停更，不可缺章。

---

## 7. 还没做的

- **多书支持**：数据结构已经是多书的，但流水线和界面都只针对一本。
- **读者反馈回流**：追读率、弃书点这些埋点还没接。接上之后才能按真实数据调质量。
- **备案/合规**：如果迁回大陆机房，需要走 ICP 备案；内容层面这是原创小说，没有版权问题。

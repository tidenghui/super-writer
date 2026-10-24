# 超级写作 · Super Writer

无人值守的中文连载小说创作引擎。

一本书，一群分工明确的智能体，一整夜的自我审稿，早上七点发布一章。

---

## 现在跑起来

```bash
# 0. 依赖（首次）
npm install

# 1. 填 API key
cp .env.example .env.local
#    编辑 .env.local，写入 DEEPSEEK_API_KEY

# 2. 自检
npm run doctor

# 3. 生成第一章
npm run chapter -- --n 1 --print

# 4. 看看这本书现在什么样
npm run canon

# 5. 打开阅读器
npm run read          # → http://127.0.0.1:8787
```

**没有 API key 也想跑通全流程？** 用离线 mock：

```bash
SW_MOCK=1 npm run chapter -- --n 1              # 演练，不花钱不写盘
SW_MOCK=1 SW_MOCK_STRICT=1 npm run chapter -- --n 1  # 强制走一遍修订循环
```

> 注意：本机 `node` 在 `/opt/homebrew/bin`，如果你的 shell 里找不到 node，先
> `export PATH=/opt/homebrew/bin:$PATH`。

## 现状（2026-10）

《藏经阁的最后一页》已连更十章、24340 字，全部定稿并发布。

| 指标 | 结果 |
|---|---|
| 单章成本 | ¥0.5（含规划、八个候选开场、五批评家、三轮冷读） |
| 单章耗时 | 2–3 分钟 |
| 整章冷读 | 10/10 章都是 3/3「会继续读」 |
| 首屏测试 | 8/10 章 3/3，2 章 2/3 |
| 批评家评分 | 5.2–6.4，前三章在最高档 |
| 累计实验花费 | ¥21（含所有失败尝试） |

**怎么自己验一遍**：

```bash
npm run doctor -- --ping   # 配置 + 真实调用
npm run calibrate          # 判据是否还有分辨力（烂稿必须 0/3）
npm run score -- --all     # 五批评家逐章打分
npm run firstscreen -- --all
npm run canon              # 章节、伏笔、逾期告警
npm run read               # 打开阅读器
```

没有 API key 也能验：

```bash
SW_MOCK=1 npm run doctor
SW_MOCK=1 npm run chapter -- --n 1
```

## 已知局限

- **评分天花板在 6.0 左右。** 段落级打磨实测无效（均分 6.00 → 5.84，已回退），
  瓶颈不在措辞，在「这一章发生了什么」。
- **批评家保证不了跨章一致。** 阿满的性别在第五章被写成「她」54 次，五个批评家一次都没报——
  它们每次只读一章。只有通读全书的审计抓得到。
- **判断读者的是同一个模型。** 三个「读者分身」和写手同源，夸的可能就是自己。
  已用反例 calibration（烂稿 0/3）证明判据不是摆设，但它替代不了真人的手感。
- **人工抽查仍然必要。** 我自己通读一遍，一次就抓到四处批评家和审计都没发现的问题
  （详见 `docs/engine.md`）。

## 这里有什么

```
books/<slug>/bible/     故事圣经 —— 这本书的宪法，人手写的
  premise.md            前提、读者契约、结局
  world.md              硬设定（墨池机制、修为体系、时间线）
  style.md              文风规范（禁用词、句式、比喻来源）
  characters.json       人物卡（含「说话方式」，防所有人一个腔调）
  outline.json          30 章大纲 + 三卷结构
  promises.json         伏笔账本 —— 对读者许下的债

books/<slug>/canon/     引擎写回的内容
  facts.jsonl           已写进正文的事实（防改口）

books/<slug>/chapters/  产出的章节
  001.md                正文
  001.meta.json         元数据：评分、冷读票、修订轮次、成本

src/engine/             引擎
  chapter.ts            流水线编排
  critics.ts            五个专职批评家
  coldRead.ts           三个读者分身（放行判据）
  context.ts            上下文装配
  llm.ts                模型调用（重试、记账、预算护栏）
  config.ts             角色 → 模型路由

config/models.json      哪个角色用哪家模型（改这里就换模型）
runs/<slug>/<时间>/     每次运行的完整日志（含所有 prompt）
```

## 一条命令背后发生了什么

| 阶段 | 谁 | 干什么 |
|---|---|---|
| 规划 | planner | 把大纲拆成 2–3 个场景，每个场景必须有转折 |
| 开场 | opener ×4 → judge | 写 4 个不同切入的开场，由一个挑剔编辑选出最好的 |
| 起草 | writer | 按场景表写完整章，章末必须落在钩子上 |
| 审稿 | 5 个 critic 并行 | 连续性 / 角色 / 节奏 / 逻辑 / 文风，各自只需引用原文挑刺 |
| 冷读 | 3 个读者分身并行 | 老书虫 / 通勤读者 / 解谜读者：会不会点下一章 |
| 放行 | gate | 无硬伤 且 均分 ≥7.5 且 冷读 ≥2/3 |
| 修订 | reviser | 只改被点名的句子，不重写 |
| 归档 | canonRecorder | 沉淀事实、还债、记新债、写摘要 |

**关键设计**：批评家必须**逐字引用原文**才能提意见。引用在正文里找不到的缺陷会被自动作废——这是防止模型"编造问题"的唯一有效手段。

## 阅读器

```bash
npm run read     # http://127.0.0.1:8787
```

零依赖、服务端渲染、文件即数据库。没有构建步骤，没有前端框架——一章三千字，用户要的是「打开就能读」。

- 书架、作品页、正文、翻章、RSS 和 sitemap 统一只显示从第一章开始连续发布的章节；遇到草稿、缺章或未来发布时间即停止。
- 新读者从第一章开始；回访读者可继续上次阅读，目录支持倒序与本机阅读记录标记。
- 响应式书架、排版书封、移动端阅读工具栏、目录抽屉与桌面侧边工具。
- 阅读设置：纸白 / 暖纸 / 夜读 / 跟随系统、16–28px 字号、三档行距与宋体 / 黑体；偏好及进度保存在当前浏览器。
- 键盘 ← → 翻章；设置或目录打开时暂停快捷键。
- `?theme=dark` / `?theme=light` / `?theme=sepia` 可用于主题预览。
- 草稿预览默认关闭。仅在服务进程配置 `SW_PREVIEW_TOKEN` 后，携带 `Authorization: Bearer <token>` 请求 `?draft=1`；令牌不放 URL，预览响应禁止缓存和索引。浏览器预览需由可信内部代理或请求头工具附带该请求头。
- 启动服务后可在本机预览；无需连接生产服务器。受限环境可用 `node --import tsx src/serve/server.ts` 启动。

平台回归测试：`node --import tsx --test src/serve/*.test.ts`（启动临时本机 HTTP 服务，需要回环监听权限）。

## 质检命令

```bash
npm run calibrate            # 标定读者分身：烂稿必须被拒（换模型后必跑）
npm run firstscreen -- --all # 首屏测试：只看开头 320 字，会不会继续滑
npm run reread -- --all      # 改过正文后重跑读者测
npm run compare              # 两两对比，给各章开头排名
npm run audit                # 通读全书找漂移
npm run fix -- --n 3 --m "批注"   # 人工批注定点修订
npm run recanon -- --n 3     # 重算某章的事实与伏笔
```

## 无人值守

```bash
npm run night        # 审计全书 → 写下一章（黄金三章自动跑 3 个变体挑一个）
```

挂到 crontab 上，就是「24 小时不间断」的真实形态：

```cron
0 2 * * * cd /Users/zhefeng/development/Repositories/super-writer && PATH=/opt/homebrew/bin:$PATH npm run night >> runs/night.log 2>&1
```

## 成本

单章流水线约 20–40 次模型调用，实测 **¥0.3–0.6/章**，2 分钟左右跑完。30 章不到 ¥20。
`SW_MAX_CHAPTER_COST_CNY` 是硬护栏，超了直接中止。

## 还没做的

- 阅读器 App（等第一章读得下去了再做）
- 真正的 24/7 调度（现在是手动跑，之后上 cron）
- 读者反馈回流（需要先有读者）
- 全书漂移审计 `npm run audit` 已有雏形，还没接进每晚的流水线

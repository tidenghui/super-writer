# 超级写作 · Super Writer

无人值守的中文连载小说创作引擎。

一本书，一群分工明确的智能体，一整夜的自我审稿，早上七点发布一章。

---

## 现在跑起来

```bash
# 1. 填 API key
cp .env.example .env.local
#    编辑 .env.local，写入 DEEPSEEK_API_KEY

# 2. 自检
npm run doctor

# 3. 生成第一章
npm run chapter -- --n 1 --print

# 4. 看看这本书现在什么样
npm run canon
```

> 注意：本机 `node` 在 `/opt/homebrew/bin`，如果你的 shell 里找不到 node，先
> `export PATH=/opt/homebrew/bin:$PATH`。

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

## 成本

单章流水线大约 4–8 次模型调用，¥1–3。30 章不到 ¥100。
`SW_MAX_CHAPTER_COST_CNY` 是硬护栏，超了直接中止。

## 还没做的

- 阅读器 App（等第一章读得下去了再做）
- 真正的 24/7 调度（现在是手动跑，之后上 cron）
- 读者反馈回流（需要先有读者）
- 全书漂移审计 `npm run audit` 已有雏形，还没接进每晚的流水线

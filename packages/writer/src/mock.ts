/**
 * 离线 mock 模型。
 *
 * 用途：在没有 API key（或不想花钱）的情况下把整条流水线跑一遍，
 * 验证编排、解析、重试、修订循环、归档逻辑是否正确。
 *
 * 打开方式：SW_MOCK=1
 * 严格模式：SW_MOCK_STRICT=1  —— 第一轮审稿故意给低分，强制走一遍修订循环
 *
 * mock 产出的正文是占位文本，没有文学价值，不要拿它当作品。
 */
import type { CallOpts, CallResult } from './llm.ts';

const used = new Map<string, number>();

export function isMock(): boolean {
  return process.env.SW_MOCK === '1' || process.env.SW_MOCK === 'true';
}

function strict(): boolean {
  return process.env.SW_MOCK_STRICT === '1';
}

/** 从 prompt 里把正文捞出来（批评家用「待审正文」，修订用「待修订正文」） */
function bodyFrom(user: string): string {
  const m = user.match(/## 待(?:修订|审)正文[^\n]*\n\n([\s\S]*?)(?:\n\n---\n\n|\n\n## |$)/);
  if (m?.[1]) return m[1].trim();

  // 兜底：取最后一个分隔段
  const idx = user.lastIndexOf('---');
  const tail = idx >= 0 ? user.slice(idx + 3) : user;
  return tail.replace(/^[\s\S]*?\n\n/, '').trim();
}

function firstLine(body: string): string {
  const line = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length >= 8 && !l.startsWith('#'));
  return (line ?? '他把书合上了').slice(0, 30);
}

const PLACEHOLDER = `雨是酉时下的。

藏经阁的木楼挨着崖。雨一大，檐水就往窗棂里灌。我把三层的窗都关了，只剩东边那扇漏风的没关严。这扇关不上，二十年了。老周说让它漏。

灯在第三排书架上。

我抄的是《云台县志》，四百年前的，纸都酥了，翻的时候要用竹起子。抄到第十七页，我停了。

我抄的那一行，和原本上的那一行，不一样。

我以为是眼花。我揉了揉眼，重新对了一遍。

原本上写的是：秋七月，大水。

我纸上写的是：秋七月，他还活着。

我把纸揉了。

第二次抄，还是那六个字。

楼下有人咳嗽。老周。他总是这个时辰上来查灯，脚步很轻，轻得像不在这楼上。

我把纸塞进袖子，站起来，把笔搁在砚台上。

“抄完了？”他在楼梯口问。声音是从下往上飘的。

“快了。”

“嗯。”他站了一会儿，“别抄太晚。”

他走了。脚步声一直到一楼才听见。

我坐回去，没有再看那张纸。

我把《云台县志》合上，放回原位，然后抽出了另一本。

《引气篇》。我练了十年的那本。

书很旧了，封皮上有一层油，是十年里被手摸出来的。

我翻到最后一页。`;

function evaluate(label: string, user: string): string {
  // 批评家
  if (label.startsWith('critic:')) {
    const count = (used.get(label) ?? 0) + 1;
    used.set(label, count);

    if (strict() && count === 1) {
      return JSON.stringify({
        score: 6,
        verdict: 'revise',
        praise: '开头的雨写得很实。',
        defects: [
          {
            quote: firstLine(bodyFrom(user)),
            problem: '这一段信息密度不够，读者容易划走',
            severity: 'major',
            fix: '压缩到两行以内，把关键动作提前',
          },
        ],
      });
    }

    return JSON.stringify({
      score: 8,
      verdict: 'pass',
      praise: '短句用得住，物件都有分量。',
      defects: [],
    });
  }

  // 冷读
  if (label.startsWith('coldread:')) {
    return JSON.stringify({
      willContinue: true,
      dropPoint: null,
      hookedBy: '我抄的那一行，和原本上的那一行，不一样。',
      wantNext: '想看他翻到最后一页之后看见了什么。',
      verdict: '有点意思，但还差一口狠的',
    });
  }

  // 规划
  if (label === 'plan') {
    return JSON.stringify({
      title: '最后一页',
      scenes: [
        {
          location: '藏经阁三层',
          cast: ['shenyan'],
          goal: '抄完《云台县志》最后几页',
          conflict: '抄出来的字和原本不一样',
          turn: '他发现不是抄错，是书在改',
          exit: '抽出《引气篇》',
        },
        {
          location: '藏经阁三层',
          cast: ['shenyan', 'laozhou'],
          goal: '避开老周的盘问',
          conflict: '老周知道得比他多',
          turn: '老周没有阻止他',
          exit: '决心翻最后一页',
        },
      ],
      openingLine: '雨是酉时下的。',
      plant: ['p1'],
      pay: [],
      endHook: '那点血还是湿的',
      wordTarget: 2600,
      mustNot: ['雨中打斗', '回忆杀', '长段内心独白'],
    });
  }

  if (label.startsWith('openings:')) {
    return JSON.stringify({
      openings: [
        PLACEHOLDER.slice(0, 300),
        '老周说过，藏经阁里的书，翻到哪一页都行。\n\n只有一页不行。\n\n' + PLACEHOLDER.slice(0, 220),
        '我把笔搁下的时候，第三排的灯芯爆了一下。\n\n' + PLACEHOLDER.slice(0, 240),
        '“抄完了？”\n\n“快了。”\n\n' + PLACEHOLDER.slice(0, 260),
      ],
    });
  }

  if (label === 'opening-judge') {
    return JSON.stringify({ winner: 2, why: '第二句就把规矩立起来了，缺口最清楚。' });
  }

  // 起草 / 扩写 / 修订：都返回占位正文
  if (label.startsWith('draft:') || label.startsWith('expand:') || label.startsWith('revise:')) {
    if (label.startsWith('revise:')) return bodyFrom(user);
    return PLACEHOLDER;
  }

  // 归档
  if (label.startsWith('canon:')) {
    return JSON.stringify({
      summary: '雨夜，沈砚在藏经阁抄《云台县志》，抄出的字与原本不符。老周来查灯，没有阻止他。他最终翻开《引气篇》的最后一页。',
      newFacts: [
        { subject: '藏经阁', fact: '三层东边的窗关不严，二十年没修' },
        { subject: '老周', fact: '每夜这个时辰来查灯，脚步极轻' },
      ],
      promiseUpdates: [{ id: 'p4', paidAt: 1 }],
      newPromises: [{ text: '血为什么三十年不干', dueBy: 9, importance: 2 }],
    });
  }

  if (label === 'audit') {
    return JSON.stringify({
      drift: [
        {
          kind: '口吻',
          where: '第1章',
          quote: '我把纸揉了',
          problem: '（mock）示例漂移项',
          fix: '（mock）忽略',
        },
      ],
      biggestRisk: '（mock）示例',
    });
  }

  return JSON.stringify({ ok: true, mock: label });
}

export function mockCall(opts: CallOpts): CallResult {
  const text = evaluate(opts.label ?? opts.role, opts.user);
  const inTok = Math.ceil(opts.user.length / 2);
  const outTok = Math.ceil(text.length / 2);
  return {
    text,
    model: `mock:${opts.label ?? opts.role}`,
    ms: 1,
    usage: { in: inTok, out: outTok },
    costCny: 0,
  };
}

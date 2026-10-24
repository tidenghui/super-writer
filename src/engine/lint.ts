/**
 * 文本体检。
 *
 * 有些毛病不该花钱问模型——它们是可以机械判定的：
 * 禁用词、超长句、出戏的术语、直接命名情绪。
 *
 * 在批评家之前跑一遍，成本为零，命中率极高。
 * 命中的句子会交给「清洗」阶段定点修补。
 */

export interface Violation {
  kind: '禁用词' | '失声' | '长句' | '情绪直陈' | '越界' | '引号' | '人称' | '串味';
  /** 命中的词或规则说明 */
  rule: string;
  /** 原文里出问题的句子 */
  sentence: string;
}

/** 文风禁用词（网文套话） */
const STYLE_BANNED = [
  '不禁',
  '仿佛',
  '宛若',
  '宛如',
  '心中一凛',
  '瞳孔骤缩',
  '嘴角勾起',
  '倒吸一口凉气',
  '不由得',
  '空气仿佛凝固',
  '如同实质',
  '深不可测',
  '杀意凛然',
  '气息一变',
];

/**
 * 失声词：沈砚是抄书匠。
 * 修行术语可以有「引气」（那是书名），但不能有修行者的行话。
 */
const POV_BANNED = [
  '气感',
  '内息',
  '真元',
  '灵脉',
  '神识',
  '神通',
  '法力',
  '灵力',
  '元力',
];

/** 直接命名情绪（应该用动作写） */
const EMOTION_BANNED = [
  '我很害怕',
  '我心里一惊',
  '我心中一震',
  '我心里一沉',
  '我心中一紧',
  '他愤怒地',
  '我惊恐地',
  '我感到恐惧',
  '我松了一口气',
];

const ALL_BANNED = [
  ...STYLE_BANNED.map((w) => ({ w, kind: '禁用词' as const })),
  ...POV_BANNED.map((w) => ({ w, kind: '失声' as const })),
  ...EMOTION_BANNED.map((w) => ({ w, kind: '情绪直陈' as const })),
];

/** 把正文切成句子（按中文句末标点） */
function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[。！？])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function lintProse(body: string): Violation[] {
  const out: Violation[] = [];
  const sentences = sentencesOf(body);

  for (const sentence of sentences) {
    for (const { w, kind } of ALL_BANNED) {
      if (sentence.includes(w)) {
        out.push({ kind, rule: `出现「${w}」`, sentence: sentence.slice(0, 80) });
      }
    }

    // 长句：超过 25 字且有 3 个以上逗号串起来
    const commas = (sentence.match(/，/g) ?? []).length;
    if (sentence.length > 25 && commas >= 3) {
      out.push({
        kind: '长句',
        rule: `${sentence.length} 字、${commas} 个逗号串成一句`,
        sentence: sentence.slice(0, 80),
      });
    }
  }

  // 同一句不要报多次
  const seen = new Set<string>();
  return out.filter((v) => {
    const k = v.kind + v.sentence;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * 角色红线。
 *
 * 有三条规则是「这个人说不出这句话」，不是文笔问题：
 *   - 老周舌上有禁制，涉及墨池/献祭的直白陈述他说不出来
 *   - 柳青梧是执法堂，不知道墨池真相
 *   - 玄清不主动交底
 *
 * 这类约束交给模型自觉是靠不住的（实测三轮里违反率仍很高）。
 * 但它是**可判定的**：找到引号里的话，找到说话的人，看有没有踩词。
 * 所以放在这里，机械拦截。
 */
interface SpeakerRule {
  who: string;
  aliases: string[];
  cannotSay: string[];
  notNear?: string[];
  why: string;
  sinceChapter?: number;
}

/** 说话人归属：只认「名字 + 说话动词」或「名字 + 冒号」两种可靠形式 */
const SPEECH_VERB = /(说|道|问|答|喊|叫|开口|低声|笑道|吼道)/;

function attributeQuote(text: string, start: number, end: number, rules: SpeakerRule[]): SpeakerRule | null {
  const before = text.slice(Math.max(0, start - 30), start);

  for (const rule of rules) {
    for (const alias of rule.aliases) {
      if (new RegExp(`${alias}\\s*[:：]\\s*$`).test(before)) return rule;

      const idx = before.lastIndexOf(alias);
      if (idx >= 0) {
        const tail = before.slice(idx + alias.length);
        // 同一个小句里，名字后 12 字内出现说话动词
        if (tail.length <= 12 && !/[。！？]/.test(tail) && SPEECH_VERB.test(tail)) return rule;
      }
    }
  }
  return null;
}

/**
 * 角色红线。
 *
 * 规则来自 bible/rules.json，不写死在代码里——
 * 否则「第13章新立的规矩，第14章就失效」。归档时可以往表里追加。
 */
export function redlineViolations(body: string, rules: SpeakerRule[], atChapter = Infinity): Violation[] {
  const out: Violation[] = [];
  const active = rules.filter((r) => (r.sinceChapter ?? 0) <= atChapter);
  const quoteRe = /[“「]([^”」]{1,120})[”」]/g;

  let m: RegExpExecArray | null;
  while ((m = quoteRe.exec(body)) !== null) {
    const utterance = m[1] ?? '';
    const who = attributeQuote(body, m.index, m.index + m[0].length, active);
    if (!who) continue;

    const hit = who.cannotSay.find((w) => utterance.includes(w));
    if (hit) {
      out.push({
        kind: '越界',
        rule: `${who.who}${who.why}，但这句里出现了「${hit}」`,
        sentence: m[0],
      });
    }
  }
  return out;
}

/**
 * 人称一致性。
 *
 * 只看「这一段里只有一个角色」的情况——出现多个角色时，「他」指谁有歧义，容易误伤。
 * 误报比漏报更糟：它会逼修订去改一句本来没问题的句子。
 */
export function pronounViolations(
  body: string,
  cast: Array<{ name: string; gender?: string }>,
): Violation[] {
  const out: Violation[] = [];
  for (const para of body.split(/\n{2,}/)) {
    const text = para.trim();
    if (!text) continue;

    const present = cast.filter((c) => c.gender && text.includes(c.name));
    if (present.length !== 1) continue;

    const c = present[0]!;
    const wrong = c.gender === 'female' ? /(^|[^其])他(?![们日])/ : /她/;
    if (wrong.test(text)) {
      out.push({
        kind: '人称',
        rule: `${c.name}是${c.gender === 'female' ? '女性' : '男性'}，这一段却用了「${c.gender === 'female' ? '他' : '她'}」`,
        sentence: text.slice(0, 80),
      });
    }
  }
  return out;
}

/**
 * 确定性引号修复。
 *
 * 模型改不干净这类错：它能发现「多了一个右引号」，但一改就改出新问题。
 * 引号是纯语法，用栈扫一遍就行，不该问模型。
 *
 * 规则：扫描全文，多的右引号删掉；没闭合的左引号在句末补上。
 */
export function normalizeQuotes(body: string): string {
  const pairs: Record<string, string> = { '“': '”', '「': '」' };
  const closers = new Set(Object.values(pairs));

  return body
    .split(/(\n{2,})/)
    .map((block) => {
      if (/^\n+$/.test(block)) return block;

      const out: string[] = [];
      const stack: string[] = [];

      for (const ch of block) {
        if (pairs[ch]) {
          stack.push(pairs[ch] as string);
          out.push(ch);
        } else if (closers.has(ch)) {
          if (stack.length) {
            stack.pop();
            out.push(ch);
          }
          // 没有对应的左引号，这个右引号是多余的，直接丢弃
        } else {
          out.push(ch);
        }
      }

      // 还有没闭合的，在段末补齐
      while (stack.length) out.push(stack.pop() as string);
      return out.join('');
    })
    .join('');
}

/**
 * 引号配对。看着很蠢，但这是模型最容易犯、读者最容易卡住的错。
 */
export function quoteViolations(body: string): Violation[] {
  const out: Violation[] = [];
  for (const para of body.split(/\n{2,}/)) {
    const text = para.trim();
    if (!text) continue;
    const left = (text.match(/[“「]/g) ?? []).length;
    const right = (text.match(/[”」]/g) ?? []).length;
    if (left !== right) {
      out.push({ kind: '引号', rule: `左引号 ${left} 个、右引号 ${right} 个，不配对`, sentence: text.slice(0, 80) });
    }
  }
  return out;
}

/**
 * 邻近禁忌：某个短语不能和某个角色出现在同一段里。
 *
 * 典型场景：把老周的步态（两短一长）安到柳青梧身上。
 * 这类错写手会犯，因为它读章纲时不会去比对「谁走路什么样」。
 */
export function proximityViolations(text: string, rules: SpeakerRule[], atChapter = Infinity): Violation[] {
  const out: Violation[] = [];
  const active = rules.filter((r) => (r.notNear?.length ?? 0) > 0 && (r.sinceChapter ?? 0) <= atChapter);

  for (const para of text.split(/\n{2,}/)) {
    const p = para.trim();
    if (!p) continue;
    for (const rule of active) {
      if (!rule.aliases.some((a) => p.includes(a))) continue;
      for (const phrase of rule.notNear ?? []) {
        if (p.includes(phrase)) {
          out.push({
            kind: '串味',
            rule: `${rule.who}${rule.why}，但这一段里出现了「${phrase}」`,
            sentence: p.slice(0, 80),
          });
        }
      }
    }
  }
  return out;
}

export function formatViolations(vs: Violation[]): string {
  return vs
    .map((v, i) => `${i + 1}. [${v.kind}] ${v.rule}\n   原句：${v.sentence}`)
    .join('\n');
}


/** 章形：段数、对话占比、平均段长。连载注水的第一征兆就是对话占比飙升。 */
export interface Shape {
  paragraphs: number;
  dialogue: number;
  dialogueRatio: number;
  avgParaLen: number;
}

export function chapterShape(body: string): Shape {
  const paras = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const dialogue = paras.filter((p) => /^[“"「]/.test(p)).length;
  const totalChars = paras.reduce((n, p) => n + p.length, 0);

  return {
    paragraphs: paras.length,
    dialogue,
    dialogueRatio: paras.length ? dialogue / paras.length : 0,
    avgParaLen: paras.length ? Math.round(totalChars / paras.length) : 0,
  };
}


/**
 * 公式化检测。
 *
 * 单章看不出来，通读才看得出来：老周每章都咳、每章都用「不是A，是B」、
 * 每章灯芯都「短了」。写手会不知不觉把上一章的手法再抄一遍。
 */
export function repetitionWarnings(body: string): string[] {
  const out: string[] = [];
  const count = (re: RegExp) => (body.match(re) ?? []).length;

  const cough = count(/咳/g);
  if (cough > 6) out.push(`「咳」出现 ${cough} 次，人物的口头习惯已经变成噪点`);

  const negate = count(/不是[^。！？]{0,14}，?是/g);
  if (negate > 3) out.push(`「不是A，是B」句式出现 ${negate} 次，成了公式`);

  const lamp = count(/灯芯/g);
  if (lamp > 1) out.push(`「灯芯」出现 ${lamp} 次，同一物件别反复当节拍器`);

  return out;
}

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
  kind: '禁用词' | '失声' | '长句' | '情绪直陈' | '越界' | '引号';
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
  name: string;
  aliases: string[];
  banned: string[];
  why: string;
}

const SPEAKER_RULES: SpeakerRule[] = [
  {
    name: '老周',
    aliases: ['老周', '周无咎'],
    banned: ['墨池', '献祭', '入池', '写成书', '抄成', '换一人', '书里', '最后一页', '第七行', '后山潭'],
    why: '舌上有禁制，说不出墨池真相的直白陈述',
  },
  {
    name: '柳青梧',
    aliases: ['柳青梧'],
    banned: ['墨池', '献祭', '入池', '换一人', '写成书', '抄成书'],
    why: '执法堂只查刑律，不知墨池真相',
  },
  {
    name: '玄清',
    aliases: ['玄清'],
    banned: ['自己走进', '换一人', '池底', '水底', '抄的是人'],
    why: '知道一切但不主动交底',
  },
];

/**
 * 判断这句话是谁说的。
 *
 * 只认两种可靠形式：
 *   1. 名字 + 说话动词（老周说 / 玄清道 / 柳青梧问）
 *   2. 名字 + 冒号，紧贴引号（老周：“……”）
 *
 * 早先的做法是「附近有名字就算他说」，结果把沈砚的话算到老周头上——
 * 误报比漏报更糟：它会让修订去改一句本来没问题的话。
 */
const SPEECH_VERB = /(说|道|问|答|喊|叫|开口|低声|笑道|吼道)/;

function attributeQuote(text: string, start: number, end: number): SpeakerRule | null {
  const before = text.slice(Math.max(0, start - 30), start);

  for (const rule of SPEAKER_RULES) {
    for (const alias of rule.aliases) {
      // 形式二：名字 + 冒号紧贴引号
      if (new RegExp(`${alias}\\s*[:：]\\s*$`).test(before)) return rule;

      // 形式一：名字后面 8 字内有说话动词
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
 * 引号配对。
 *
 * 看着很蠢，但这是模型最容易犯、读者最容易卡住的错：
 * 多一个右引号，手机上就会读成"对话断了又接上"。
 */
export function quoteViolations(body: string): Violation[] {
  const out: Violation[] = [];
  for (const para of body.split(/\n{2,}/)) {
    const text = para.trim();
    if (!text) continue;
    const left = (text.match(/[“「]/g) ?? []).length;
    const right = (text.match(/[”」]/g) ?? []).length;
    if (left !== right) {
      out.push({
        kind: '引号',
        rule: `左引号 ${left} 个、右引号 ${right} 个，不配对`,
        sentence: text.slice(0, 80),
      });
    }
  }
  return out;
}

export function redlineViolations(body: string): Violation[] {
  const out: Violation[] = [];
  const quoteRe = /[“「]([^”」]{1,120})[”」]/g;

  let m: RegExpExecArray | null;
  while ((m = quoteRe.exec(body)) !== null) {
    const utterance = m[1] ?? '';
    const start = m.index;
    const end = m.index + m[0].length;
    const who = attributeQuote(body, start, end);
    if (!who) continue;

    const hit = who.banned.find((w) => utterance.includes(w));
    if (hit) {
      out.push({
        kind: '越界',
        rule: `${who.name}${who.why}，但这句里出现了「${hit}」`,
        sentence: m[0],
      });
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

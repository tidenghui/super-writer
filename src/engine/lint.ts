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
  kind: '禁用词' | '失声' | '长句' | '情绪直陈';
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

export function formatViolations(vs: Violation[]): string {
  return vs
    .map((v, i) => `${i + 1}. [${v.kind}] ${v.rule}\n   原句：${v.sentence}`)
    .join('\n');
}

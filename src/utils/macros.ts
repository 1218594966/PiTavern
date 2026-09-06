/**
 * 宏替换（SillyTavern 风格）：把卡生态文本里的占位宏展开成实际名字。
 *
 * 支持：
 *   {{user}} / {{User}}  → 玩家档案名（无 persona 时保留原文 <user> 语义不变）
 *   {{char}} / {{Char}}  → 主讲/主角名（无则保留原文）
 *
 * 用法：角色卡 openingLine / mes_example / 系统提示 里常写 {{user}}；
 * greeting 播种与 persona 设置后展开，让开场白自然带出玩家名。
 */

export interface MacroContext {
  /** 玩家档案名（persona.name） */
  userName?: string;
  /** 主讲角色名（发言者/主角卡名） */
  charName?: string;
}

/** 无 persona 时的 {{user}} 兜底（保留可读性，语义同 SillyTavern 的 <user>） */
export const FALLBACK_USER = '<user>';

export function expandMacros(text: string, ctx: MacroContext = {}): string {
  if (!text) return text;
  const user = ctx.userName?.trim() || FALLBACK_USER;
  const char = ctx.charName?.trim() || null;
  let out = text;
  // {{random:选项1|选项2|…}} → 随机一个（可重复出现，各自独立随机）
  out = out.replace(/\{\{\s*random\s*:\s*([^}]+?)\s*\}\}/gi, (_m, choicesRaw: string) => {
    const choices = String(choicesRaw)
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean);
    if (choices.length === 0) return '';
    return choices[Math.floor(Math.random() * choices.length)]!;
  });
  // 大小写变体（{{user}} / {{User}} / {{USER}}…）统一替换
  out = out.replace(/\{\{\s*user\s*\}\}/gi, user);
  if (char) out = out.replace(/\{\{\s*char\s*\}\}/gi, char);
  return out;
}

/** 取一段文本里是否还残留未展开的宏（调试用） */
export function hasUnresolvedMacros(text: string): boolean {
  return /\{\{\s*(user|char|random[^}]*)\s*\}\}/i.test(text);
}

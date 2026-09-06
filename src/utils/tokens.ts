/**
 * 轻量 token 估算（纯代码，无网络）。
 * 阶段 2 用它保证「永远 < 900 Token」，不依赖任何 tokenizer 服务。
 * 中文按每字约 1 token 估算（与主流 BPE 分词的中文表现接近），
 * 英文按 4 字符/token，两者混合时取加权和。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(ch)) cjk++;
    else other++;
  }
  // CJK 单字 ≈ 0.8 token；其他按 4 字符/token，且至少 1
  return Math.ceil(cjk * 0.8 + Math.max(1, other / 4));
}

/** 将文本截断到预算内，优先从尾部裁（历史窗口内容最旧） */
export function truncateToBudget(text: string, budgetTokens: number): string {
  if (estimateTokens(text) <= budgetTokens) return text;
  // 二分：找最长的前缀（按字符数近似）满足预算
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid)) <= budgetTokens) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}

/** 从头部裁剪到预算内（保留文本尾部 —— 组装器兜底用：最新输入在尾部，不能丢） */
export function truncateHeadToBudget(text: string, budgetTokens: number): string {
  if (estimateTokens(text) <= budgetTokens) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (estimateTokens(text.slice(mid)) <= budgetTokens) hi = mid;
    else lo = mid + 1;
  }
  return text.slice(lo);
}

/** 人类可读 token 数（调试用） */
export function fmtTokens(text: string): string {
  return `${estimateTokens(text)} tok`;
}

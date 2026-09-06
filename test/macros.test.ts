import { describe, it, expect } from 'vitest';
import { expandMacros, hasUnresolvedMacros, FALLBACK_USER } from '../src/utils/macros.js';

describe('M4-1 宏替换 expandMacros', () => {
  it('{{user}} → persona 名（大小写变体）', () => {
    expect(expandMacros('你好，{{user}}！', { userName: '旅人' })).toBe('你好，旅人！');
    expect(expandMacros('{{User}} 来了', { userName: '旅人' })).toBe('旅人 来了');
    expect(expandMacros('快看 {{USER}}', { userName: '旅人' })).toBe('快看 旅人');
  });

  it('无 persona 时 {{user}} → <user> 兜底（SillyTavern 语义）', () => {
    expect(expandMacros('你是{{user}}吗')).toBe(`你是${FALLBACK_USER}吗`);
  });

  it('{{char}} → 主讲角色名', () => {
    expect(expandMacros('{{char}}推门进来', { charName: '艾莉西亚' })).toBe('艾莉西亚推门进来');
    expect(expandMacros('{{char}} 与 {{user}}', { charName: '艾莉西亚', userName: '旅人' })).toBe('艾莉西亚 与 旅人');
  });

  it('未提供 charName 时 {{char}} 原样保留', () => {
    expect(expandMacros('{{char}} 沉默')).toBe('{{char}} 沉默');
    expect(hasUnresolvedMacros('{{char}} 沉默')).toBe(true);
    expect(hasUnresolvedMacros('艾莉西亚 沉默')).toBe(false);
  });

  it('{{random:选项1|选项2}} 随机取一且总是命中候选集', () => {
    const picks = new Set<string>();
    for (let i = 0; i < 40; i++) picks.add(expandMacros('今天天气是 {{random:晴|雨|雪}}'));
    expect([...picks].every((p) => /^今天天气是 (晴|雨|雪)$/.test(p))).toBe(true);
    // 空选项 → 空串
    expect(expandMacros('a{{random:  |  }}b')).toBe('ab');
  });
});

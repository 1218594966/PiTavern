import { describe, it, expect } from 'vitest';
import { importCards, parsePngCard } from '../src/cards/importer.js';
import type { TavernCardV2, WorldPack } from '../src/cards/schema.js';

/** 标准 SillyTavern V2 角色卡（含 character_book） */
const v2Alicia: TavernCardV2 = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '艾莉西亚',
    description: '三十出头，左眉一道旧疤，围裙口袋里常年揣着一把开信刀。灰烬镇旅馆老板。',
    personality: '嘴硬心软，警惕生人，对自己人极其护短',
    scenario: '深夜暴雨，外乡人推门进店',
    first_mes: '外乡人，雨这么大还赶路？',
    mes_example: '<START>\n{{user}}: 安德鲁在哪？\n{{char}}: 呵，那笔货款够他烧三年了。',
    system_prompt: '禁止八股套话，用电影镜头般的微动作。',
    character_book: {
      name: '艾莉西亚的世界',
      entries: [
        {
          keys: ['安德鲁', '铁匠'],
          content: '三年前安德鲁卷走合伙铺子的货款，艾莉西亚从此不提他，提起来就冷笑。',
          enabled: true,
          insertion_order: 1,
        },
        {
          keys: ['短剑', '血'],
          content: '桌上那把带血的短剑是三天前一个满身是血的客人留下的。',
          enabled: true,
          insertion_order: 2,
        },
      ],
    },
    extensions: {
      pitavern: {
        speechStyle: '短句、带刺、爱用反问；紧张时用指节敲柜台',
        scenes: [
          {
            id: 'scene_inn',
            name: '麋鹿与铁砧旅馆',
            description: '炉火噼啪，麦酒桶沿墙排开，木楼梯通往二楼。窗外雨把灰烬镇浇成一片墨色。',
          },
        ],
        world: {
          id: 'world_ash',
          name: '灰烬镇',
          rules: ['把现实玩家（Master）和扮演角色分清楚', '只演当前场景与在场角色'],
        },
      },
    },
  },
};

/** PiTavern 世界包：多角色 + 多场景 + lore（拼接式） */
const worldPack: WorldPack = {
  schema: 'pitavern-world/v1',
  world: { id: 'world_ash', name: '灰烬镇', rules: ['禁止八股套话'] },
  characters: [v2Alicia],
  scenes: [
    { id: 'scene_smithy', name: '铁匠铺', description: '风箱鼓动余烬，墙上挂满半成品镰刀。安德鲁不在，炉火还旺着。' },
  ],
  items: [
    { id: 'item_dagger', name: '带血的短剑', description: '剑鞘沾着干涸的暗红，柄上缠着旅馆的旧绳结。', ownerCharacterId: 'char_艾莉西亚' },
    { id: 'item_note', name: '无名信笺', description: '字迹潦草，落款模糊。' },
  ],
  lore: [{ keys: ['决裂'], content: '三年前，艾莉西亚与安德鲁的合伙铺子散伙，镇上传闻安德鲁欠了一笔货款。' }],
};

describe('卡片导入器（SillyTavern 兼容）', () => {
  it('V2 角色卡自动拆卡：1 角色 + 2 记忆（character_book）+ 1 场景 + 1 世界观', async () => {
    const result = await importCards(v2Alicia);
    const { cards, summary } = result;

    expect(cards.length).toBe(5);
    // 角色卡
    const char = cards.find((c) => c.kind === 'character');
    expect(char?.name).toBe('艾莉西亚');
    expect(char?.speechStyle).toContain('短句');
    expect(char?.openingLine).toContain('雨这么大');
    // 记忆卡 × 2（character_book）
    const mems = cards.filter((c) => c.kind === 'memory');
    expect(mems.length).toBe(2);
    expect(mems[0]!.keys).toContain('安德鲁');
    expect(mems[0]!.body).toContain('卷走合伙铺子的货款');
    // 场景卡
    const scene = cards.find((c) => c.kind === 'scene');
    expect(scene?.name).toBe('麋鹿与铁砧旅馆');
    expect(scene?.presentCharacterNames).toContain('艾莉西亚');
    // 世界观卡（system）—— 来自 extensions.pitavern.world
    const sys = cards.find((c) => c.kind === 'system');
    expect(sys?.name).toBe('灰烬镇');
    expect(sys?.body).toContain('把现实玩家（Master）和扮演角色分清楚');
    expect(sys?.body).toContain('只演当前场景与在场角色');
    // 摘要
    expect(summary.characters).toEqual(['艾莉西亚']);
    expect(summary.memories).toBe(2);
    expect(summary.scenes).toEqual(['麋鹿与铁砧旅馆']);
  });

  it('世界包拆分：多卡拼接（世界观 + 角色 + 场景 + 物品 + lore）', async () => {
    const result = await importCards(worldPack);
    const { cards, summary } = result;

    // system 卡：世界包自带 1 张 + V2 卡扩展里的 world 1 张 = 2（各自独立，可去重合并）
    expect(cards.filter((c) => c.kind === 'system').length).toBe(2);
    expect(cards.filter((c) => c.kind === 'character').length).toBe(1);
    // 场景卡：V2 扩展里的旅馆 + 世界包的铁匠铺 = 2
    expect(cards.filter((c) => c.kind === 'scene').length).toBe(2);
    const its = cards.filter((c) => c.kind === 'item');
    expect(its.length).toBe(2);
    expect(cards.filter((c) => c.kind === 'memory').length).toBe(3); // 2 character_book + 1 lore
    expect(summary.world).toBe('灰烬镇');
    expect(summary.items).toEqual(['带血的短剑', '无名信笺']);
    // M10：物品归属透传（有主 / 无主缺省）
    const it = its.find((x) => x.name === '带血的短剑');
    expect(it?.ownerCharacterId).toBe('char_艾莉西亚');
    expect(its.find((x) => x.name === '无名信笺')?.ownerCharacterId).toBeUndefined();
  });

  it('V1 裸字段卡也能解析（历史兼容）', async () => {
    const v1 = {
      name: '老安德鲁',
      description: '镇上唯一的铁匠，固执记仇',
      personality: '话少，句句带铁锈味',
      scenario: '铁匠铺内',
      first_mes: '（头也不抬）修什么？',
      mes_example: '',
    };
    const result = await importCards(v1);
    expect(result.cards.length).toBe(1);
    expect(result.cards[0]!.kind).toBe('character');
    expect(result.cards[0]!.name).toBe('老安德鲁');
  });

  it('PNG 嵌卡解析：伪造 Chara tEXt chunk 能被提取', async () => {
    // 构造最小合法 PNG：8 字节头 + 一个 tEXt chunk 装 Chara
    const json = JSON.stringify(v2Alicia);
    const textData = Buffer.concat([Buffer.from('Chara\0', 'latin1'), Buffer.from(json, 'utf8')]);
    const chunk = Buffer.alloc(8 + textData.length + 4);
    chunk.writeUInt32BE(textData.length, 0);
    chunk.write('tEXt', 4, 'ascii');
    textData.copy(chunk, 8);
    // CRC 随便填（解析不校验）
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk]);

    const parsed = await parsePngCard(png);
    expect(parsed).not.toBeNull();
    const r = await importCards(png);
    expect(r.cards.some((c) => c.name === '艾莉西亚')).toBe(true);
    // M1-4：PNG 嵌卡的图像本身成为角色头像（dataURL）
    const char = r.cards.find((c) => c.kind === 'character');
    expect(char?.avatar).toMatch(/^data:image\/png;base64,/);
  });

  it('M10-P0：V3 规格 + 小写 chara 字段 + base64 包裹（校园.png 同款）可导入', async () => {
    const v3card = {
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: '暧昧高手',
        description: '',
        personality: '',
        scenario: '',
        first_mes: '九月的午后…',
        mes_example: '',
        character_book: {
          name: 'book',
          entries: [
            { keys: [], content: '# 世界观详情\n浮城（华城）…', enabled: true, comment: '', selective: false, constant: false, position: 'before_char' },
            { keys: ['郑剑'], content: '郑剑，十六岁…', enabled: true, comment: '', selective: false, constant: false, position: 'before_char' },
          ],
        },
      },
    };
    // 1) 小写 chara tEXt + base64 包裹 JSON（真实工具写法）
    const b64 = Buffer.from(JSON.stringify(v3card)).toString('base64');
    const textData = Buffer.concat([Buffer.from('chara\0', 'latin1'), Buffer.from(b64, 'utf8')]);
    const chunk = Buffer.alloc(8 + textData.length + 4);
    chunk.writeUInt32BE(textData.length, 0);
    chunk.write('tEXt', 4, 'ascii');
    textData.copy(chunk, 8);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk]);

    const parsed = await parsePngCard(png);
    expect(parsed).not.toBeNull();
    expect((parsed as { spec?: string }).spec).toBe('chara_card_v3');
    const r = await importCards(png);
    // M12：空壳群像主体不再生成 NPC 角色（暧昧高手只是容器壳）
    expect(r.cards.some((c) => c.name === '暧昧高手' && c.kind === 'character')).toBe(false);
    // 世界开场白提升（first_mes → worldGreeting）
    expect((r as { worldGreeting?: { text: string } }).worldGreeting?.text).toContain('九月的午后');
    expect(r.cards.filter((c) => c.kind === 'memory').length).toBeGreaterThanOrEqual(1);
    // 2) ccv3 字段名也认
    const textData2 = Buffer.concat([Buffer.from('ccv3\0', 'latin1'), Buffer.from(b64, 'utf8')]);
    const chunk2 = Buffer.alloc(8 + textData2.length + 4);
    chunk2.writeUInt32BE(textData2.length, 0);
    chunk2.write('tEXt', 4, 'ascii');
    textData2.copy(chunk2, 8);
    const png2 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk2]);
    const parsed2 = await parsePngCard(png2);
    expect(parsed2).not.toBeNull();
  });

  it('无法识别的输入抛错', async () => {
    await expect(importCards('{"foo": 1}')).rejects.toThrow('未识别的卡格式');
  });

  it('M10-P1B：book 里 {{user}} 人设条目启发式识别为玩家角色卡', async () => {
    const v3 = {
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: '世界主角群像',
        description: '',
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
        character_book: {
          name: 'book',
          entries: [
            { keys: [], content: '{{user}}（范伟），16 岁，身高 176cm，单亲家庭。', enabled: true, comment: '', selective: false, constant: false, position: 'before_char' },
            { keys: ['郑剑'], content: '郑剑，学习委员，嫉妒心强。', enabled: true, comment: '', selective: false, constant: false, position: 'before_char' },
            { keys: [], content: '世界观详情: 浮城…', enabled: true, comment: '', selective: false, constant: false, position: 'before_char' },
          ],
        },
      },
    };
    const r = await importCards(v3);
    const p = r.cards.find((c) => (c as { player?: boolean }).player);
    expect(p).toBeDefined();
    expect(p!.name).toBe('玩家·范伟');
    expect((p as { body: string }).body).toContain('16 岁');
    expect((p as { body: string }).body).not.toContain('{{user}}');
    // 其余仍为记忆卡
    const mems = r.cards.filter((c) => c.kind === 'memory');
    expect(mems.length).toBe(2);
  });

  it('M11：worldview/plot mclass + constant 直读 + 标题命名（校园.png 同款语义）', async () => {
    const v3 = {
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: '暧昧高手',
        description: '',
        personality: '', scenario: '', first_mes: '开场', mes_example: '',
        character_book: {
          name: 'book',
          entries: [
            { keys: [], content: '---\n世界观详情:\n  世界名称: 浮城\n  地理格局: 环状扩张型都市', enabled: true, constant: true, comment: '', selective: true, position: 'before_char', insertion_order: 100 },
            { keys: [], content: '# 暧昧高手 - 主线剧情发展大纲\n【剧情结构】多女主并行', enabled: true, constant: true, comment: '', selective: true, position: 'before_char', insertion_order: 100 },
            { keys: ['郑剑', '郑同学'], content: '郑剑，十六岁，是平安县第二中学附属初中初三六班的学习委员。他出身优渥，父亲是县里的纪委书记。理论上他是品学兼优的好学生，但实际上他心胸狭隘，嫉妒心极强。他暗恋方佳怡，发现 {{user}} 与方佳怡越走越近便产生强烈敌意，视 {{user}} 为人渣，会指使跟班肖达去挑衅。', enabled: true, comment: '', selective: true, position: 'before_char', insertion_order: 100 },
            { keys: [], content: '{{user}}，16 岁，单亲家庭。', enabled: true, comment: '', selective: true, position: 'before_char', insertion_order: 100 },
          ],
        },
      },
    };
    const r = await importCards(v3);
    const mems = r.cards.filter(c => c.kind === 'memory');
    const wv = mems.find((m) => (m as { mclass?: string }).mclass === 'worldview');
    expect(wv).toBeDefined();
    expect(wv!.name).toBe('世界观详情');
    expect((wv as { constant?: boolean }).constant).toBe(true);
    const pl = mems.find((m) => (m as { mclass?: string }).mclass === 'plot');
    expect(pl).toBeDefined();
    expect(pl!.name).toBe('主线剧情发展大纲'); // 副题命名（主名与主体同名）
    expect((pl as { constant?: boolean }).constant).toBe(true);
    // 人物志 → 角色池（无 constant）
    const zj = r.cards.find(c => c.kind === 'character' && !(c as { player?: boolean }).player && c.name === '郑剑');
    expect(zj).toBeDefined();
    expect((zj as { constant?: boolean }).constant).toBeUndefined();
    // 玩家卡常驻
    const player = r.cards.find((c) => (c as { player?: boolean }).player);
    expect((player as { constant?: boolean }).constant).toBe(true);
  });

  it('M12：空壳群像包 → 无主体 NPC，first_mes 提升为世界开场白', async () => {
    const v3 = {
      spec: 'chara_card_v3', spec_version: '3.0',
      data: {
        name: '校园群像', description: '', personality: '', scenario: '',
        first_mes: '九月的午后，阳光洒进教室。',
        mes_example: '',
        character_book: { name: 'b', entries: [
          { keys: ['郑剑', '郑同学'], content: '郑剑，十六岁，学习委员。郑剑，十六岁，是平安县第二中学附属初中初三六班的学习委员。他出身优渥，父亲是县里的纪委书记。理论上他是品学兼优的好学生，但实际上他心胸狭隘，嫉妒心极强。', enabled: true },
          { keys: [], content: '世界观详情: 浮城，环状扩张型都市。', enabled: true, constant: true },
          { keys: [], content: '{{user}}，16 岁，单亲家庭。', enabled: true },
        ] },
      },
    };
    const r = await importCards(v3 as never);
    // 无主体 NPC（空壳跳过）；郑剑进池；玩家卡生成；世界观卡存在
    expect(r.cards.some(c => c.kind === 'character' && c.name === '校园群像')).toBe(false);
    expect(r.cards.some(c => c.kind === 'character' && c.name === '郑剑')).toBe(true);
    expect(r.cards.some(c => (c as { player?: boolean }).player)).toBe(true);
    expect(r.cards.some(c => c.kind === 'memory' && (c as { mclass?: string }).mclass === 'worldview')).toBe(true);
    // first_mes → 世界开场白
    expect(r.worldGreeting?.text).toBe('九月的午后，阳光洒进教室。');
    // 对照组：有实质 description 的主体 → 正常生成角色（开场白留在角色上）
    const r2 = await importCards({
      spec: 'chara_card_v3', spec_version: '3.0',
      data: { name: '艾莉西亚', description: '旅馆老板娘，左眉旧疤。', personality: '嘴硬心软', scenario: '深夜暴雨', first_mes: '外乡人，雨这么大还赶路？', mes_example: '', character_book: { name: 'b', entries: [] } },
    } as never);
    expect(r2.cards.some(c => c.kind === 'character' && c.name === '艾莉西亚' && (c as { openingLine?: string }).openingLine)).toBe(true);
    expect(r2.worldGreeting).toBeUndefined();
  });

  it('同包同名人物志拆出独立角色卡，id 全部唯一（防撞 id 去重）', async () => {
    const longChar = (extra: string) =>
      `郑剑，十六岁，是平安县第二中学附属初中初三六班的学习委员。他出身优渥，父亲是县里的纪委书记。理论上他是品学兼优的好学生，但实际上他心胸狭隘，嫉妒心极强。${extra}这是为了满足人物志长文识别条件而补充的背景细节，让这条目进入角色池而不是事件记忆。`;
    const v3 = {
      spec: 'chara_card_v3', spec_version: '3.0',
      data: {
        name: '群像', description: '', personality: '', scenario: '',
        first_mes: '', mes_example: '',
        character_book: { name: 'b', entries: [
          { keys: ['郑剑', '郑同学'], content: longChar('其一。'), enabled: true },
          { keys: ['郑剑', '剑'], content: longChar('其二。他曾因竞赛作弊被抓，格外在意名声。'), enabled: true },
          { keys: ['浮城', '世界观'], content: '浮城，环状扩张型都市，黑道势力盘踞。', enabled: true },
        ] },
      },
    };
    const r = await importCards(v3 as never);
    const chars = r.cards.filter(c => c.kind === 'character' && !(c as { player?: boolean }).player);
    // 两条含「郑剑」的人物志都拆成独立角色卡（非常驻 NPC 进角色池）
    expect(chars.length).toBe(2);
    const ids = r.cards.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(chars.some(c => c.body.includes('竞赛作弊'))).toBe(true);
    expect(chars.some(c => c.body.includes('心胸狭隘'))).toBe(true);
    // 短的浮城条目 → 事件记忆
    const mems = r.cards.filter(c => c.kind === 'memory');
    expect(mems.some(m => m.body.includes('黑道势力'))).toBe(true);
  });
});

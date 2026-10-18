// 演示数据 —— 仅在真实 Steam 库不可用时使用（浏览器 Mock、未登录、未绑定 Steam、请求失败）。
// 结构与 user.getSteamGameList() 返回的 SteamGameListItem 完全一致，单位为秒，字段名不改动。
// 界面在任何情况下都必须标注这批数据是演示数据，不能让它冒充真实游戏库。
// appid / steamAppid 仅作示意，不保证与线上游戏目录一致；不含图片字段，页面会渲染首字母占位块。

const h = (hours) => Math.round(hours * 3600)

/** @type {import('@heybox/hb-sdk').SteamGameListItem[]} */
export const DEMO_LIBRARY = [
  // ── 最近两周在玩：构成"当前风格"的信号来源 ──────────────────────────
  {
    appid: 1145350,
    steamAppid: 1145350,
    name: '哈迪斯 II',
    playtime2Weeks: h(8.5),
    playtimeForever: h(62),
    tags: ['Roguelike', '动作', '砍杀', '轻度 Rogue', '神话'],
  },
  {
    appid: 632360,
    steamAppid: 632360,
    name: '雨中冒险 2',
    playtime2Weeks: h(5),
    playtimeForever: h(210),
    tags: ['Roguelike', '第三人称射击', '合作', '动作', '刷宝'],
  },
  {
    appid: 548430,
    steamAppid: 548430,
    name: '深岩银河',
    playtime2Weeks: h(4),
    playtimeForever: h(340),
    tags: ['合作', '第一人称射击', '挖掘', '职业', '程序生成'],
  },
  {
    appid: 892970,
    steamAppid: 892970,
    name: '英灵神殿',
    playtime2Weeks: h(3),
    playtimeForever: h(120),
    tags: ['生存', '建造', '合作', '开放世界', '维京'],
  },
  {
    appid: 105600,
    steamAppid: 105600,
    name: '泰拉瑞亚',
    playtime2Weeks: h(2),
    playtimeForever: h(96),
    tags: ['沙盒', '建造', '2D 平台', '合作', '生存'],
  },

  // ── 买了没玩：主力推荐候选（playtimeForever 为 0）──────────────────
  {
    appid: 588650,
    steamAppid: 588650,
    name: '死亡细胞',
    playtimeForever: 0,
    tags: ['Roguelike', '动作', '像素', '困难'],
  },
  {
    appid: 311690,
    steamAppid: 311690,
    name: '挺进地牢',
    playtimeForever: 0,
    tags: ['Roguelike', '弹幕射击', '像素', '合作'],
  },
  {
    appid: 602960,
    steamAppid: 602960,
    name: '潜渊症',
    playtimeForever: 0,
    tags: ['合作', '生存', '模拟', '潜水艇', '恐怖'],
  },
  {
    appid: 457140,
    steamAppid: 457140,
    name: '缺氧',
    playtimeForever: 0,
    tags: ['殖民模拟', '建造', '资源管理', '生存'],
  },
  {
    appid: 526870,
    steamAppid: 526870,
    name: '幸福工厂',
    playtimeForever: 0,
    tags: ['建造', '自动化', '开放世界', '合作'],
  },
  {
    appid: 244850,
    steamAppid: 244850,
    name: '太空工程师',
    playtimeForever: 0,
    tags: ['建造', '沙盒', '太空', '模拟'],
  },
  {
    appid: 275850,
    steamAppid: 275850,
    name: '无人深空',
    playtimeForever: 0,
    tags: ['开放世界', '生存', '探索', '太空'],
  },
  {
    appid: 413150,
    steamAppid: 413150,
    name: '星露谷物语',
    playtimeForever: 0,
    tags: ['农场模拟', '像素', '建造', '角色扮演'],
  },
  {
    appid: 504230,
    steamAppid: 504230,
    name: '蔚蓝',
    playtimeForever: 0,
    tags: ['平台跳跃', '精确平台', '像素', '困难'],
  },
  {
    appid: 367520,
    steamAppid: 367520,
    name: '空洞骑士',
    playtimeForever: 0,
    tags: ['类银河战士恶魔城', '平台跳跃', '困难', '探索'],
  },
  {
    appid: 294100,
    steamAppid: 294100,
    name: '环世界',
    playtimeForever: 0,
    tags: ['殖民模拟', '建造', '策略', '故事生成'],
  },
  {
    appid: 427520,
    steamAppid: 427520,
    name: '异星工厂',
    playtimeForever: 0,
    tags: ['自动化', '建造', '资源管理', '策略'],
  },

  // ── 短流程候选：用来验证"快玩一会"档位真的有效 ──────────────────
  // 一个真实的游戏库不会只有长线游戏；没有这几款，"快玩一会"就永远无匹配。
  {
    appid: 620,
    steamAppid: 620,
    name: '传送门 2',
    playtimeForever: 0,
    tags: ['解谜', '短篇', '合作'],
  },
  {
    appid: 501300,
    steamAppid: 501300,
    name: '艾迪芬奇的记忆',
    playtimeForever: 0,
    tags: ['步行模拟', '短篇', '剧情', '解谜'],
  },
  {
    appid: 304430,
    steamAppid: 304430,
    name: 'Inside',
    playtimeForever: 0,
    tags: ['解谜', '短篇', '像素'],
  },
  {
    appid: 1102130,
    steamAppid: 1102130,
    name: '佛罗伦萨',
    playtimeForever: 0,
    tags: ['视觉小说', '短篇'],
  },

  // ── 久未启动：玩过、时长不低，但近两周为 0 ────────────────────────
  {
    appid: 582010,
    steamAppid: 582010,
    name: '怪物猎人：世界',
    playtime2Weeks: 0,
    playtimeForever: h(150),
    tags: ['动作', '合作', '角色扮演', '刷宝'],
  },
  {
    appid: 374320,
    steamAppid: 374320,
    name: '黑暗之魂 III',
    playtime2Weeks: 0,
    playtimeForever: h(42),
    tags: ['类魂', '动作', '困难', '角色扮演'],
  },
  {
    appid: 322330,
    steamAppid: 322330,
    name: '饥荒联机版',
    playtime2Weeks: 0,
    playtimeForever: h(88),
    tags: ['生存', '合作', '建造', '2D 平台'],
  },
  {
    appid: 108600,
    steamAppid: 108600,
    name: '僵尸毁灭工程',
    playtime2Weeks: 0,
    playtimeForever: h(37),
    tags: ['生存', '僵尸', '沙盒', '建造'],
  },
  {
    appid: 264710,
    steamAppid: 264710,
    name: '深海迷航',
    playtime2Weeks: 0,
    playtimeForever: h(29),
    tags: ['生存', '探索', '开放世界', '建造'],
  },
  {
    appid: 646570,
    steamAppid: 646570,
    name: '杀戮尖塔',
    playtime2Weeks: 0,
    playtimeForever: h(54),
    tags: ['Roguelike', '卡牌', '策略', '轻度 Rogue'],
  },

  // ── 口味不符的对照样本：用来验证推荐确实在做风格匹配，而不是随机挑 ──
  {
    appid: 292030,
    steamAppid: 292030,
    name: '巫师 3：狂猎',
    playtime2Weeks: 0,
    playtimeForever: h(85),
    tags: ['角色扮演', '开放世界', '剧情', '奇幻'],
  },
  {
    appid: 1222140,
    steamAppid: 1222140,
    name: '底特律：变人',
    playtime2Weeks: 0,
    playtimeForever: h(12),
    tags: ['剧情', '选择导向', '电影式', '科幻'],
  },
  {
    appid: 632470,
    steamAppid: 632470,
    name: '极乐迪斯科',
    playtime2Weeks: 0,
    playtimeForever: h(9),
    tags: ['角色扮演', '剧情', '文字', '侦探'],
  },
  {
    appid: 289070,
    steamAppid: 289070,
    name: '文明 VI',
    playtime2Weeks: 0,
    playtimeForever: h(70),
    tags: ['策略', '回合制', '4X', '历史'],
  },
  {
    appid: 1091500,
    steamAppid: 1091500,
    name: '赛博朋克 2077',
    playtime2Weeks: 0,
    playtimeForever: h(55),
    tags: ['角色扮演', '开放世界', '第一人称射击', '剧情'],
  },
];

/** 让演示库与真实接口返回的分页结构保持一致，便于上层代码走同一条分支。 */
export const DEMO_LIBRARY_PAGE = {
  gameList: DEMO_LIBRARY,
  hasMore: false,
  nextOffset: DEMO_LIBRARY.length,
  total: DEMO_LIBRARY.length,
  isMe: true,
};

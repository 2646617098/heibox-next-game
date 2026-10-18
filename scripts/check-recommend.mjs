// 推荐算法自检脚本（不参与小程序打包，仅本地开发用）：
//   npm run check
// 用内置演示库跑完整链路，打印画像 / 排名，并断言必须成立的性质。

import { DEMO_LIBRARY } from '../src/demo-library.js';
import { recommendNext, buildStyleProfile, describeRecommendation } from '../src/recommend.js';

const failures = [];
const check = (label, condition) => {
  if (!condition) failures.push(label);
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
};

const games = DEMO_LIBRARY;
const { profile, ranked, top, alternatives, mode, coverage } = recommendNext(games);

// ── 风格画像 ───────────────────────────────────────────────────────────────
console.log('\n── 风格画像 ────────────────────────────────');
console.log(
  `口径 basis=${profile.basis}  可信度=${profile.confidence}  参与画像=${profile.sourceGames.length} 款  总时长=${profile.totalHours.toFixed(1)}h`,
);
console.log(
  'Top 标签: ' +
    profile.rankedTags
      .slice(0, 8)
      .map((entry) => `${entry.tag} ${(entry.weight * 100).toFixed(1)}%`)
      .join(' / '),
);

// ── 候选池前 10 ────────────────────────────────────────────────────────────
console.log('\n── 候选池前 10 ─────────────────────────────');
console.log(`模式 mode=${mode}  候选 ${coverage.candidates} 款，其中有标签 ${coverage.withTags} 款`);
console.log('游戏            契合度  候选池加成  得分     对上的标签');
for (const item of ranked.slice(0, 10)) {
  console.log(
    `${item.game.name.padEnd(12, '　')}  ${(item.affinity * 100).toFixed(0).padStart(4)}%  ` +
      `${item.poolKind.padEnd(9)}  ${item.score.toFixed(3).padStart(6)}  ` +
      `${item.matched.slice(0, 3).map((m) => m.tag).join('、') || '—'}`,
  );
}

// ── 断言 ───────────────────────────────────────────────────────────────────
console.log('\n── 断言 ────────────────────────────────────');

check('画像口径为"最近两周"', profile.basis === 'recent');
check('产生了推荐结果', Boolean(top));
check('推荐分从高到低排列', ranked.every((item, i) => i === 0 || ranked[i - 1].score >= item.score));
check(
  '正在玩的游戏（近两周 > 0）没有被推荐',
  ranked.every((item) => (item.game.playtime2Weeks ?? 0) <= 0),
);
check(
  '首选与备选不重复',
  new Set([top, ...alternatives].map((item) => item.game.appid)).size === alternatives.length + 1,
);
check('首选必须有匹配标签', top && top.matched.length > 0);
check('首选属于"买了没玩"或"久未启动"之一', Boolean(top) && ['unplayed', 'backlog'].includes(top.poolKind));
check(
  '最终得分 === 契合度 × 0.7 + 候选池加成 × 0.3',
  ranked.every((item) => Math.abs(item.score - (item.affinity * 0.7 + item.poolBonus * 0.3)) < 1e-12),
);
check(
  '候选结果里不再包含时长估算字段',
  ranked.every((item) => item.duration === undefined && item.durationFit === undefined),
);
// 界面读的是 model.xxx，算法层删字段时这条会失败 —— 曾经因为删掉 references 而让页面
// 在「渲染推荐时出错」上崩过一次，当时自检没拦住（浏览器验证才抓到）。
check(
  '模型返回的字段与界面约定一致',
  Object.keys(recommendNext(games)).sort().join(',') ===
    'alternatives,coverage,mode,profile,ranked,styleMatched,top',
);

// —— 文案：这两个 bug 在浏览器验证里被抓到过，加断言防止回归。
const sample = describeRecommendation(top, profile);
check('推荐理由不超过两条', sample.bullets.length <= 2);
check(
  '用户文案不出现时长/档位字样',
  (() => {
    const text = [sample.headline, ...sample.bullets].join(' ').toLowerCase();
    return !/小时|时长|档位|short|medium|long|endless/.test(text);
  })(),
);
check('没有匹配标签时不谎称"按口味挑的"', (() => {
  const noMatch = ranked.find((item) => item.matched.length === 0);
  if (!noMatch) return true;
  return !describeRecommendation(noMatch, profile).headline.includes('口味挑的');
})());

// —— IDF：通用标签必须被压下去，否则推荐理由会变成「按你最近的『单人』口味挑的」。
const idfCorpus = [];
for (let i = 0; i < 20; i += 1) {
  idfCorpus.push({
    appid: 90000 + i,
    steamAppid: 90000 + i,
    name: `corpus-${i}`,
    playtimeForever: 3600 * (i + 1),
    playtime2Weeks: i < 3 ? 3600 : 0,
    // 「单人」「独立」几乎每款都有；「牌组构建」只出现在最近在玩的三款里。
    tags: i < 3 ? ['单人', '独立', '牌组构建'] : ['单人', '独立'],
  });
}
const idfProfile = buildStyleProfile(idfCorpus);
const idfWeight = (tag) => idfProfile.tagWeights.get(tag) ?? 0;
check(
  'IDF：通用标签「单人」的画像权重低于特色标签「牌组构建」',
  idfWeight('牌组构建') > idfWeight('单人'),
);
check('IDF：画像头号标签是特色标签而不是通用标签', idfProfile.rankedTags[0]?.tag === '牌组构建');

// —— 边界
const fallbackProfile = buildStyleProfile(games.map((g) => ({ ...g, playtime2Weeks: 0 })));
check('近两周全为 0 时回退到累计时长画像', fallbackProfile.basis === 'lifetime');
check('回退画像仍有标签权重', fallbackProfile.tagWeights.size > 0);
check('空库不抛错且无推荐', recommendNext([]).top === null);
check(
  '所有游戏都在玩时不产生推荐',
  recommendNext(games.map((g) => ({ ...g, playtime2Weeks: 3600 }))).top === null,
);
check(
  '完全没有标签时退回行为模式，不谎称风格匹配',
  recommendNext(
    games.map((g) => ({ ...g, tags: [] })),
  ).mode === 'behavioral',
);

// ── 卡片文案抽样 ───────────────────────────────────────────────────────────
console.log('\n── 卡片文案抽样（首选）────────────────────');
const described = describeRecommendation(top, profile);
console.log(`  ${top.game.name}`);
console.log(`  标题：${described.headline}`);
for (const line of described.bullets) console.log(`  · ${line}`);

console.log(`\n${failures.length === 0 ? '全部通过' : `失败 ${failures.length} 项：\n - ${failures.join('\n - ')}`}`);
process.exitCode = failures.length === 0 ? 0 : 1;

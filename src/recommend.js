// 「下一个玩什么」的推荐算法 —— 纯函数，不依赖 SDK、不碰 DOM，便于单独验证和后续调参。
//
// 思路（两阶段）：
//   1. 风格画像：用"用户最近在玩的时长"给游戏标签加权，得到一张「口味分布表」。
//      近两周时长全为 0 时回退到累计时长，避免近期没玩的用户拿到空画像。
//   2. 候选打分：从库里排除"正在玩"的游戏，对剩下每款算
//         score = 标签契合度 × AFFINITY_WEIGHT + 候选池加成 × POOL_WEIGHT
//      标签契合度用 cosine 相似度，天然惩罚"标签堆砌"的游戏，也不会被标签数量放大。
//
// 这里**不做时长估算**：平台的接口给不出游戏长度，SteamSpy 与 HowLongToBeat 又都在反爬后面，
// 任何"预计投入多少小时"都只能靠手写先验编出来，含 77% 的游戏落在同一个值上。
// 与其显示一个假的精确数字，不如不做这一层 —— 时长相关的整条链路已移除。

export const AFFINITY_WEIGHT = 0.7;
export const POOL_WEIGHT = 0.3;

/** 候选池加成：买了从没启动过的，优先于玩过但久未启动的。 */
export const POOL_BONUS = {
  unplayed: 1,
  backlog: 0.75,
};

export function secondsToHours(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return 0;
  return seconds / 3600;
}

/** 标签去重：trim、丢空值、按小写去重但保留首次出现的写法。 */
export function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const result = [];
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }
  return result;
}

/** 标签的文档频率：某个标签出现在多少款游戏里。 */
function tagDocumentFrequency(games) {
  const df = new Map();
  for (const game of games) {
    for (const tag of new Set(normalizeTags(game.tags))) {
      df.set(tag, (df.get(tag) ?? 0) + 1);
    }
  }
  return df;
}

/**
 * 平滑 IDF：越常见的标签权重越低。
 *
 * 没有这一步画像会被通用标签淹没。实测真实库 874 款里「单人」出现在 712 款、「独立」400 款，
 * 而「牌组构建」只出现在少数游戏里 —— 均摊权重下头号标签会是「单人」，
 * 推荐理由变成「按你最近的『单人』口味挑的」，等于没说。
 */
function inverseDocumentFrequency(documentFrequency, corpusSize) {
  return Math.log((corpusSize + 1) / (documentFrequency + 1)) + 1;
}

/**
 * 建立风格画像。
 * @param {Array} games SteamGameListItem[]
 * @returns {{
 *   basis: 'recent'|'lifetime'|'empty',
 *   tagWeights: Map<string, number>,   // 归一化后的口味分布，权重和为 1
 *   norm: number,                      // sqrt(Σ w²)，cosine 分母用
 *   rankedTags: Array<{tag: string, weight: number}>,
 *   sourceGames: Array<{game: object, hours: number}>,
 *   totalHours: number,
 *   confidence: 'high'|'low'|'none',
 * }}
 */
export function buildStyleProfile(games) {
  const list = Array.isArray(games) ? games : [];
  const recent = list.filter((g) => (g.playtime2Weeks ?? 0) > 0);
  const basis = recent.length > 0 ? 'recent' : 'lifetime';

  const sourceGames = basis === 'recent' ? recent : list.filter((g) => (g.playtimeForever ?? 0) > 0);

  // 只有同时具备"有效时长"和"标签"的游戏才能参与画像。
  const usable = sourceGames
    .map((game) => {
      const seconds = basis === 'recent' ? game.playtime2Weeks : game.playtimeForever;
      return { game, hours: secondsToHours(seconds), tags: normalizeTags(game.tags) };
    })
    .filter((entry) => entry.hours > 0 && entry.tags.length > 0);

  const totalHours = usable.reduce((sum, entry) => sum + entry.hours, 0);

  const df = tagDocumentFrequency(list);
  const corpusSize = Math.max(list.length, 1);
  const idf = (tag) => inverseDocumentFrequency(df.get(tag) ?? 0, corpusSize);

  const rawWeights = new Map();
  for (const { hours, tags } of usable) {
    // 一款游戏的时长按标签的 IDF 比例分配：特色标签拿大头，通用标签拿小头。
    // 这样既不会让"标签多的游戏"占便宜（总时长固定），也不会被「单人」这类标签淹没。
    const scores = tags.map(idf);
    const total = scores.reduce((sum, value) => sum + value, 0);
    if (total <= 0) continue;
    tags.forEach((tag, index) => {
      rawWeights.set(tag, (rawWeights.get(tag) ?? 0) + (hours * scores[index]) / total);
    });
  }

  const totalWeight = [...rawWeights.values()].reduce((sum, w) => sum + w, 0);
  const tagWeights = new Map();
  if (totalWeight > 0) {
    for (const [tag, weight] of rawWeights) {
      tagWeights.set(tag, weight / totalWeight);
    }
  }

  const norm = Math.sqrt([...tagWeights.values()].reduce((sum, w) => sum + w * w, 0));
  const rankedTags = [...tagWeights.entries()]
    .map(([tag, weight]) => ({ tag, weight }))
    .sort((a, b) => b.weight - a.weight || a.tag.localeCompare(b.tag));

  // 画像可信度：既要有带标签的游玩记录，也要有足够的时长分布广度。
  let confidence = 'none';
  if (tagWeights.size > 0) {
    confidence = usable.length >= 3 && tagWeights.size >= 5 ? 'high' : 'low';
  }

  return {
    basis: usable.length > 0 ? basis : 'empty',
    tagWeights,
    norm,
    rankedTags,
    sourceGames: usable.map(({ game, hours }) => ({ game, hours })),
    totalHours,
    confidence,
  };
}

/**
 * 对候选游戏打分并排序。
 * @param {Array} games 全部库内游戏
 * @param {ReturnType<typeof buildStyleProfile>} profile
 * @param {{ excludeAppIds?: Iterable<number> }} [options]
 */
export function scoreCandidates(games, profile, options = {}) {
  const excluded = new Set(options.excludeAppIds ?? []);
  const list = Array.isArray(games) ? games : [];

  return list
    .filter((game) => {
      if (excluded.has(game.appid)) return false;
      if (excluded.has(game.steamAppid)) return false;
      // 正在玩的游戏不需要被推荐。
      return (game.playtime2Weeks ?? 0) <= 0;
    })
    .map((game) => {
      const tags = normalizeTags(game.tags);
      const forever = secondsToHours(game.playtimeForever);
      const poolKind = forever > 0 ? 'backlog' : 'unplayed';

      const matched = tags
        .filter((tag) => profile.tagWeights.has(tag))
        .map((tag) => ({ tag, weight: profile.tagWeights.get(tag) }))
        .sort((a, b) => b.weight - a.weight || a.tag.localeCompare(b.tag));

      // cosine(口味分布, 候选的二元标签向量)
      const dot = matched.reduce((sum, entry) => sum + entry.weight, 0);
      const candidateNorm = Math.sqrt(tags.length);
      const affinity = profile.norm > 0 && candidateNorm > 0 ? dot / (profile.norm * candidateNorm) : 0;

      const poolBonus = POOL_BONUS[poolKind];

      // 行为信号：累计时长越长说明你越投入。它不进总分（总分保持"风格 + 候选池"两因素），
      // 只作为**并列时的次级排序**，避免同分候选退化成字母序 —— 那看起来像推荐，其实不是。
      const engagement = poolKind === 'backlog' ? Math.min(1, forever / 50) : 0;

      return {
        game,
        tags,
        matched,
        foreverHours: forever,
        poolKind,
        engagement,
        affinity,
        poolBonus,
        score: affinity * AFFINITY_WEIGHT + poolBonus * POOL_WEIGHT,
        // 一个标签都没对上：不是错误，但推荐理由会很弱，界面需要降调说明。
        lowConfidence: matched.length === 0,
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.matched.length - a.matched.length ||
        b.engagement - a.engagement ||
        // 最后才用名称，只为保证顺序确定；它不代表优劣，界面在行为模式下会明说。
        a.game.name.localeCompare(b.game.name),
    );
}

/**
 * 一次完整的推荐计算。
 * @returns {{ profile: object, ranked: Array, top: object|null, alternatives: Array }}
 */
export function recommendNext(games, options = {}) {
  const { excludeAppIds, alternativeCount = 5 } = options;
  const profile = buildStyleProfile(games);
  const ranked = scoreCandidates(games, profile, { excludeAppIds });

  // 风格模式 vs 行为模式。一款候选都没对上标签时，说明风格匹配无依据，
  // 排序实际由"候选池 + 行为信号"决定 —— 界面必须换个说法，不能谎称"按口味挑的"。
  const styleMatched = ranked.filter((item) => item.matched.length > 0).length;
  const mode = styleMatched > 0 ? 'style' : 'behavioral';

  const withTags = ranked.filter((item) => item.tags.length > 0).length;

  return {
    profile,
    mode,
    styleMatched,
    coverage: {
      candidates: ranked.length,
      withTags,
      tagCoverage: ranked.length === 0 ? 0 : withTags / ranked.length,
      styleMatched,
    },
    ranked,
    top: ranked[0] ?? null,
    alternatives: ranked.slice(1, 1 + alternativeCount),
  };
}

/**
 * 把打分结果翻译成用户能看懂的理由，界面直接渲染。
 * 只保留两条短理由：口味对上了哪些标签（对不上就直说）+ 为什么轮到它。
 */
export function describeRecommendation(item, profile) {
  if (!item) return { headline: '', bullets: [], game: null };

  const { game, matched, poolKind, foreverHours } = item;
  const bullets = [];

  if (matched.length > 0) {
    const top = matched.slice(0, 3).map((entry) => `「${entry.tag}」`);
    bullets.push(`和你近期的口味重合：${top.join('、')}`);
  } else {
    bullets.push('库里没有能对上的标签');
  }

  bullets.push(
    poolKind === 'unplayed'
      ? '买了之后一次都没启动过'
      : `累计玩过 ${Math.round(foreverHours)} 小时，近两周没碰`,
  );

  const headline = matched.length > 0 ? `按你最近的「${matched[0].tag}」口味挑的` : '从吃灰的库里挑的';

  return { headline, bullets, game };
}

// 打包的游戏标签数据集查询层。
//
// 为什么需要它：实测 user.getSteamGameList() 只返回 7 个字段，tags 与 price 从未出现。
// 而"按游玩风格推荐必须有游戏元数据"。数据集由 scripts/build-game-metadata.mjs 在开发期
// 生成（数据来源：Steam 商店页热门用户标签，简体中文），随包发布，运行时不联网。
//
// 合并策略：接口给标签就用接口的；接口没给就用打包数据；两者都没有就标记为无标签，
// 由上层退回行为策略，并且**必须让用户看出来**当前是降级状态。
//
// 存储格式：字典 + 索引（`encoding: 'dict+index'`）。
// 4500 款 × 19 个标签如果直接存字符串，启动时要创建 8 万多个字符串对象；
// 改成"标签字典 + 每款一组整数索引"后只需要创建字典里的几百个字符串，
// 标签在查询时按需还原、并缓存。体积也从 1.17 MiB 降到约 350 KiB。

// `with { type: 'json' }` 是给 Node 看的：Vite 原生支持 JSON 导入，但 Node 的 ESM
// 加载器要求显式声明，否则 `npm run check:library` 这类本地脚本无法导入本模块。
import metadata from './data/game-metadata.json' with { type: 'json' };

const dict = Array.isArray(metadata?.dict) ? metadata.dict : [];
const table = metadata?.games ?? {};
const cache = new Map();

/** 按 Steam App ID 查标签；没有标签返回 null。 */
export function lookupTags(steamAppid) {
  const key = String(steamAppid);
  if (cache.has(key)) return cache.get(key);

  const indices = table[key];
  const tags =
    Array.isArray(indices) && indices.length > 0
      ? indices.map((index) => dict[index]).filter((tag) => typeof tag === 'string' && tag)
      : null;

  cache.set(key, tags);
  return tags;
}

/** 数据集自身的统计信息，用于界面说明与诊断。 */
export function metadataStats() {
  const entries = Object.entries(table);
  let withTags = 0;
  let tagTotal = 0;
  for (const [, indices] of entries) {
    if (Array.isArray(indices) && indices.length > 0) {
      withTags += 1;
      tagTotal += indices.length;
    }
  }
  return {
    generatedAt: metadata?.generatedAt ?? null,
    source: metadata?.source ?? null,
    language: metadata?.language ?? null,
    encoding: metadata?.encoding ?? 'inline',
    dictionarySize: dict.length,
    entries: entries.length,
    withTags,
    averageTags: withTags === 0 ? 0 : tagTotal / withTags,
  };
}

/**
 * 把打包标签合并到游戏列表上。
 * @returns {{ games: Array, fromApi: number, fromMetadata: number, missing: number }}
 */
export function attachMetadata(list) {
  let fromApi = 0;
  let fromMetadata = 0;
  let missing = 0;

  const games = (Array.isArray(list) ? list : []).map((game) => {
    const apiTags = Array.isArray(game.tags) ? game.tags.filter((t) => typeof t === 'string' && t.trim()) : [];
    if (apiTags.length > 0) {
      fromApi += 1;
      return { ...game, tags: apiTags, tagsSource: 'api' };
    }
    const bundleTags = lookupTags(game.steamAppid);
    if (bundleTags) {
      fromMetadata += 1;
      return { ...game, tags: bundleTags, tagsSource: 'metadata' };
    }
    missing += 1;
    return { ...game, tags: [], tagsSource: 'none' };
  });

  return { games, fromApi, fromMetadata, missing };
}

// 游戏标签数据集生成器（开发期运行一次，产物随包发布；不参与小程序运行时）
//
// 背景：平台不提供游戏标签。实测 user.getSteamGameList() 只返回 7 个字段
// （appid / steamAppid / name / image / icon / playtime2Weeks / playtimeForever），
// tags 与 price 从未出现。要恢复"按游玩风格推荐"，只能自己打包一份标签数据。
//
// 来源：Steam 商店页（store.steampowered.com/app/<appid>/）的「热门用户标签」区块。
// 用 Accept-Language + ?l=schinese 固定取简体中文，标签口径与项目里的标签档位表一致。
// 注意：这是抓取第三方页面，数据来源的合规责任在开发者。
//
// 用法：
//   node scripts/build-game-metadata.mjs                 # 用默认种子，续跑（已抓过的跳过）
//   node scripts/build-game-metadata.mjs --limit 20      # 只抓前 20 个，用于试跑
//   node scripts/build-game-metadata.mjs --seed <path>   # 换种子文件（[{steamAppid, name}]）
//   node scripts/build-game-metadata.mjs --out <path>
//
// 特性：增量续跑（每 25 款落盘一次）、失败重试、抓不到的记为 null 避免反复重试。

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const SEED_PATH = resolve(here, arg('--seed', 'appid-seed.json'));
const OUT_PATH = resolve(here, '..', arg('--out', 'src/data/game-metadata.json'));
const LIMIT = Number(arg('--limit', '0')) || Infinity;
const DELAY_MS = Number(arg('--delay', '1300'));
const MAX_TAGS = 20;
const SAVE_EVERY = 25;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let certHintShown = false;

/** 读取 JSON 并容忍 UTF-8 BOM（PowerShell 的 Set-Content -Encoding utf8 会写入 BOM）。 */
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));

/**
 * 证书问题的可行动提示。
 * 实测：Node 自带 CA 列表不含 store.steampowered.com 的中间证书，fetch 会以
 * `UNABLE_TO_VERIFY_LEAF_SIGNATURE` 失败，而 PowerShell / 浏览器（走系统证书库）正常。
 * 解法是加 `--use-system-ca`（Node 自己的报错里也这么提示）。
 */
function certHint(error) {
  const text = `${error?.cause?.code ?? ''} ${error?.cause?.message ?? ''} ${error?.message ?? ''}`;
  if (/UNABLE_TO_VERIFY|CERT_|SELF_SIGNED|leaf signature/i.test(text)) {
    return '看起来是证书问题：请改用 `node --use-system-ca scripts/build-game-metadata.mjs` 运行（Node 自带 CA 列表不含该中间证书）。';
  }
  return null;
}

/** 从商店页 HTML 里取「热门用户标签」，只认 popular_tags 区块内的 app_tag。 */
export function extractTags(html) {
  const anchor = html.indexOf('popular_tags');
  const scope = anchor >= 0 ? html.slice(anchor, anchor + 8000) : html;
  const tags = [];
  const seen = new Set();
  const re = /class="app_tag"[^>]*>\s*([^<]+?)\s*</g;
  let m;
  while ((m = re.exec(scope)) !== null) {
    const tag = m[1].replace(/\s+/g, ' ').trim();
    if (!tag || tag.length > 40 || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

/**
 * 抓单个游戏的标签，自带 429/5xx 退避重试。
 *
 * 实测 Steam 会对连续请求限流（搜索接口约 36 次后就开始 429），抓几千个游戏的商店页
 * 几乎一定会撞到。**限流绝不能当成"这个游戏没有标签"记下来** —— 那样以后再跑会直接跳过，
 * 永久丢失这批游戏。
 *
 * @returns {{tags: string[]}|{retryable: true, reason: string}|{permanent: true, reason: string}}
 */
async function fetchTags(steamAppid, maxAttempts = 4) {
  const url = `https://store.steampowered.com/app/${steamAppid}/?l=schinese&cc=cn`;
  let delay = 4000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: {
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        },
        signal: AbortSignal.timeout(25000),
      });

      if (res.status === 429 || res.status >= 500) {
        await sleep(delay);
        delay = Math.min(delay * 2, 60000);
        continue;
      }
      // 404/410 之类是永久性的：下架、区域限制，重试也没用。
      if (!res.ok) return { permanent: true, reason: `HTTP ${res.status}` };

      const html = await res.text();
      return { tags: extractTags(html) };
    } catch (error) {
      if (!certHintShown) {
        const hint = certHint(error);
        if (hint) {
          console.error(`\n⚠ ${hint}\n`);
          certHintShown = true;
        }
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 60000);
    }
  }
  return { retryable: true, reason: `重试 ${maxAttempts} 次仍失败` };
}

// ── 读取种子与已有产物 ─────────────────────────────────────────────────────
const seed = readJson(SEED_PATH);

const STORE_SOURCE = 'steam-store-page-popular-tags';

/**
 * 读入已有产物并统一成内部结构 `{ [appid]: { tags: string[]|null, retryable?, error? } }`。
 * 同时兼容旧的"直接存 tags 字符串数组"格式，这样换编码不用重抓。
 */
function loadStore() {
  if (!existsSync(OUT_PATH)) return { games: {} };
  const raw = readJson(OUT_PATH);
  const games = {};

  if (raw.encoding === 'dict+index') {
    const dict = Array.isArray(raw.dict) ? raw.dict : [];
    for (const [appid, indices] of Object.entries(raw.games ?? {})) {
      games[appid] = {
        tags: Array.isArray(indices) ? indices.map((i) => dict[i]).filter(Boolean) : [],
      };
    }
    for (const appid of raw.retry ?? []) {
      games[appid] = { tags: null, retryable: true, error: '上次限流未完成' };
    }
    for (const [appid, reason] of Object.entries(raw.failed ?? {})) {
      games[appid] = { tags: null, error: String(reason) };
    }
  } else {
    for (const [appid, entry] of Object.entries(raw.games ?? {})) {
      games[appid] = {
        tags: Array.isArray(entry.tags) ? entry.tags : null,
        retryable: entry.retryable === true,
        error: entry.error,
      };
    }
  }
  return { games };
}

let store = loadStore();
store.games ??= {};

/**
 * 序列化成字典 + 索引格式。
 *
 * 为什么编码：4500 款 × 19 个标签直接存字符串，小程序启动要创建 8 万多个字符串对象，
 * 产物也大 3 倍多。字典 + 整数索引后只需创建字典里的几百个字符串，标签查询时按需还原。
 * 4500 款的实测：1196 KiB → 约 360 KiB。
 */
function serialize() {
  const used = new Set();
  for (const entry of Object.values(store.games)) {
    if (Array.isArray(entry.tags)) for (const tag of entry.tags) used.add(tag);
  }
  const dict = [...used].sort();
  const dictIndex = new Map(dict.map((tag, index) => [tag, index]));

  const games = {};
  const retry = [];
  const failed = {};
  for (const [appid, entry] of Object.entries(store.games)) {
    if (entry.retryable === true) {
      retry.push(appid);
      continue;
    }
    if (!Array.isArray(entry.tags)) {
      failed[appid] = String(entry.error ?? 'unknown');
      continue;
    }
    games[appid] = entry.tags.map((tag) => dictIndex.get(tag));
  }

  return {
    generatedAt: new Date().toISOString(),
    source: STORE_SOURCE,
    language: 'zh-CN',
    encoding: 'dict+index',
    dict,
    games,
    retry,
    failed,
  };
}

const targets = seed
  .filter((g) => Number.isInteger(g.steamAppid) && g.steamAppid > 0)
  .slice(0, LIMIT === Infinity ? undefined : LIMIT);

// 待抓 = 种子里还没有的 + 上次因限流/超时标记为 retryable 的（后者必须重新尝试，
// 否则那批游戏会被永久跳过）。
const todo = targets.filter((g) => {
  const entry = store.games[String(g.steamAppid)];
  if (!entry) return true;
  return entry.retryable === true;
});
const retryCount = todo.filter((g) => store.games[String(g.steamAppid)]?.retryable).length;
console.log(
  `种子 ${seed.length} 条；本次目标 ${targets.length} 条；已有 ${Object.keys(store.games).length} 条；` +
    `待抓 ${todo.length} 条（其中上次限流待重试 ${retryCount} 条）`,
);
console.log(`产物路径 ${OUT_PATH}`);

function save() {
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(serialize()), 'utf8');
}

let done = 0;
let failed = 0;
let retryLater = 0;
let empty = 0;
const startedAt = Date.now();

for (const game of todo) {
  const key = String(game.steamAppid);
  const result = await fetchTags(game.steamAppid);

  if (result.retryable) {
    // 限流/超时：**不落盘**，下次运行会重新尝试，不会永久丢游戏。
    store.games[key] = { name: game.name, tags: null, retryable: true, error: result.reason };
    retryLater += 1;
  } else if (result.permanent) {
    store.games[key] = { name: game.name, tags: null, error: result.reason };
    failed += 1;
  } else if (result.tags.length === 0) {
    store.games[key] = { name: game.name, tags: [] };
    empty += 1;
  } else {
    store.games[key] = { name: game.name, tags: result.tags };
  }

  done += 1;
  const entry = store.games[key];
  const label = entry.retryable
    ? `稍后重试(${entry.error})`
    : entry.tags === null
      ? `失败(${entry.error})`
      : entry.tags.length === 0
        ? '无标签'
        : `${entry.tags.length} 个标签`;
  if (done % 25 === 0 || done === todo.length || done <= 3) {
    const rate = done / ((Date.now() - startedAt) / 1000);
    const remain = Math.round((todo.length - done) / Math.max(rate, 0.001) / 60);
    console.log(`[${done}/${todo.length}] ${game.steamAppid} ${game.name} → ${label}  (约剩 ${remain} 分钟)`);
  }

  if (done % SAVE_EVERY === 0) save();
  await sleep(DELAY_MS);
}

save();

// ── 统计 ───────────────────────────────────────────────────────────────────
const all = Object.values(store.games);
const withTags = all.filter((g) => Array.isArray(g.tags) && g.tags.length > 0);
const noTags = all.filter((g) => Array.isArray(g.tags) && g.tags.length === 0);
const pending = all.filter((g) => g.retryable === true);
const permanentFail = all.filter((g) => g.tags === null && g.retryable !== true);
console.log('\n── 统计 ────────────────────────────────');
console.log(
  `产物条目 ${all.length}；有标签 ${withTags.length}；无标签 ${noTags.length}；` +
    `限流待重试 ${pending.length}；永久失败(下架/区域限制) ${permanentFail.length}`,
);
console.log(
  `有标签条目的平均标签数 ${(withTags.reduce((s, g) => s + g.tags.length, 0) / Math.max(withTags.length, 1)).toFixed(1)}`,
);
const freq = new Map();
for (const g of withTags) for (const t of g.tags) freq.set(t, (freq.get(t) ?? 0) + 1);
console.log('出现最多的 20 个标签：');
console.log(
  [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([t, c]) => `${t}×${c}`)
    .join('、'),
);
const finalBytes = statSync(OUT_PATH).size;
const finalStore = serialize();
console.log(
  `产物大小 ${(finalBytes / 1024).toFixed(1)} KiB（${finalBytes} bytes，编码 ${finalStore.encoding}，` +
    `标签字典 ${finalStore.dict.length} 项）`,
);
if (pending.length > 0) {
  console.log(`提示：有 ${pending.length} 条因限流未抓到，再运行一次本脚本即可续抓（会跳过已完成的）。`);
}

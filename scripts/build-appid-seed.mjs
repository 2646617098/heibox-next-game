// 大众游戏 appid 种子生成器（开发期运行，用于扩大标签数据集的覆盖面）
//
// 背景：标签数据集是按 appid 白名单抓的，所以"收录哪些游戏"直接决定推荐质量。
// 只拿某个人的库当种子，别人用就会大面积空标签。这里改成从 Steam 商店的**热度榜**取种子，
// 再与个人库种子合并（保证不丢已收录的游戏）。
//
// 两个来源（实测有效）：
//   - sort_by=Recommendations_DESC：按推荐/评测总数排序，最接近"拥有量"，覆盖长尾；
//   - filter=topsellers：当下热销，保证新出的热门游戏也在里面。
// 注意 sort_by=Reviews_DESC 实测排序不生效（返回冷门独立游戏），不要用。
//
// 用法：
//   node --use-system-ca scripts/build-appid-seed.mjs               # 默认规模
//   node --use-system-ca scripts/build-appid-seed.mjs --popular 1000 --topsellers 200
//   node --use-system-ca scripts/build-appid-seed.mjs --dry-run     # 只统计不写文件

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);

const SEED_PATH = resolve(here, 'appid-seed.json');
const POPULAR_TARGET = Number(arg('--popular', '3000'));
const TOPSELLER_TARGET = Number(arg('--topsellers', '500'));
const PAGE_SIZE = 100;
const DELAY_MS = Number(arg('--delay', '2000'));
const DRY_RUN = has('--dry-run');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读取 JSON 并容忍 UTF-8 BOM（PowerShell 的 Set-Content -Encoding utf8 会写入 BOM）。 */
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));

const HEADERS = {
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  'X-Requested-With': 'XMLHttpRequest',
};

/** 从搜索结果 HTML 里抽 appid 与名称，保持出现顺序。 */
function parseResults(html) {
  const rows = [];
  // 每个搜索结果是一行：<a ... data-ds-appid="123" ...> ... <span class="title">名字</span>
  const rowRe = /<a\b[^>]*data-ds-appid="(\d+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const appid = Number(m[1]);
    const title = /<span class="title">([^<]+)<\/span>/.exec(m[2]);
    if (!Number.isInteger(appid) || appid <= 0) continue;
    rows.push({ appid, steamAppid: appid, name: title ? title[1].trim() : String(appid) });
  }
  return rows;
}

/**
 * 带 429 退避的单页抓取。
 * 实测：约 36 次请求后 Steam 会开始返回 429，必须退避重试而不是直接跳过，
 * 否则每次跑到一半就断。
 */
async function fetchPage(url, label, pageNo, maxAttempts = 5) {
  let delay = 3000;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
      if (res.status === 429) {
        console.log(
          `  [${label}] 第 ${pageNo} 页被限流(429)，等待 ${Math.round(delay / 1000)}s 后重试（第 ${attempt}/${maxAttempts} 次）`,
        );
        await sleep(delay);
        delay = Math.min(delay * 2, 60000);
        continue;
      }
      if (!res.ok) {
        console.log(`  [${label}] 第 ${pageNo} 页 HTTP ${res.status}，跳过`);
        return null;
      }
      return JSON.parse(await res.text());
    } catch (error) {
      console.log(
        `  [${label}] 第 ${pageNo} 页出错：${error.message}，等待 ${Math.round(delay / 1000)}s 后重试`,
      );
      await sleep(delay);
      delay = Math.min(delay * 2, 60000);
    }
  }
  console.log(`  [${label}] 第 ${pageNo} 页重试 ${maxAttempts} 次仍失败，跳过`);
  return null;
}

/** 按热度翻页抓取，直到拿够 target 条或没有更多结果。 */
async function collect(label, query, target) {
  const found = [];
  const seen = new Set();
  const pages = Math.ceil(target / PAGE_SIZE);
  let total = null;

  for (let page = 0; page < pages; page += 1) {
    const start = page * PAGE_SIZE;
    const url = `https://store.steampowered.com/search/results/?query&start=${start}&count=${PAGE_SIZE}&${query}&infinite=1&cc=cn&l=schinese`;
    const payload = await fetchPage(url, label, page + 1);
    if (!payload) continue;

    if (total === null) total = payload.total_count ?? null;
    const rows = parseResults(payload.results_html ?? '');
    let added = 0;
    for (const row of rows) {
      if (seen.has(row.steamAppid)) continue;
      seen.add(row.steamAppid);
      found.push(row);
      added += 1;
    }
    console.log(
      `  [${label}] 第 ${page + 1}/${pages} 页：新增 ${added}，累计 ${found.length}${total ? ` / 榜单共 ${total}` : ''}`,
    );
    if (added === 0) break;
    if (found.length >= target) break;
    await sleep(DELAY_MS);
  }
  return found.slice(0, target);
}

console.log(`目标：热度榜 ${POPULAR_TARGET} 款 + 热销榜 ${TOPSELLER_TARGET} 款\n`);

console.log('抓取「最受推荐」（≈拥有量）…');
const popular = await collect('热度', 'sort_by=Recommendations_DESC&category1=998', POPULAR_TARGET);

await sleep(DELAY_MS);
console.log('\n抓取「当前热销」…');
const topsellers = await collect('热销', 'filter=topsellers&category1=998', TOPSELLER_TARGET);

// 与已有种子合并：个人库里的游戏必须保留（它已经被抓过、也可能包含榜单外的游戏）
const existing = existsSync(SEED_PATH) ? readJson(SEED_PATH) : [];
console.log(`\n已有种子 ${existing.length} 条`);

const merged = new Map();
for (const g of existing) {
  if (Number.isInteger(g.steamAppid) && g.steamAppid > 0) merged.set(g.steamAppid, g);
}
const beforeSize = merged.size;
for (const g of [...popular, ...topsellers]) {
  if (!merged.has(g.steamAppid)) merged.set(g.steamAppid, g);
}

const out = [...merged.values()].sort((a, b) => a.steamAppid - b.steamAppid);
console.log(`合并后 ${out.length} 条（原有 ${beforeSize} + 新增 ${out.length - beforeSize}）`);
console.log(`其中热度榜贡献 ${popular.length}、热销榜贡献 ${topsellers.length}`);

if (DRY_RUN) {
  console.log('\n--dry-run：不写文件。样例：');
  console.log(out.slice(0, 10).map((g) => `${g.steamAppid}:${g.name}`).join(' | '));
} else {
  writeFileSync(SEED_PATH, JSON.stringify(out, null, 2), 'utf8');
  const bytes = Buffer.byteLength(JSON.stringify(out, null, 2), 'utf8');
  console.log(`\n已写入 ${SEED_PATH}（${(bytes / 1024).toFixed(1)} KiB）`);
}

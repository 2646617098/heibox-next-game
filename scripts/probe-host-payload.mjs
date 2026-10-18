// Host 游戏库返回值的原始载荷探针（开发工具，不参与小程序打包）
//
// 用途：绕开业务代码，直接问 Host「user.getSteamGameList 到底返回哪些字段」，
// 用来回答「平台有没有提供某个数据」这类问题，而不是靠读文档推测。
// 换排序、加搜索词、开 includeHidden 各问一遍，逐条打印键名合集与原始记录。
//
// 做法：用 CDP 连到调试台的小程序 frame，从 Vite 转换后的 main.js 里提取 SDK 的
// 预打包模块地址，动态 import 拿到**与页面同一个单例**（同 URL → 同实例，握手已完成），
// 然后直接调用 SDK。不修改任何小程序代码。
//
// 前置：
//   1. npm run dev 正在运行（页面服务 5173、调试台 5174）
//   2. 无头 Chrome 带 --remote-debugging-port=9222 且已打开调试台地址
//
// 用法：node scripts/probe-host-payload.mjs
//
// 2026-10 实测结论（876 款游戏；三种排序 + 关键字搜索 + includeHidden 共 6 组）：
//   返回字段恒为 appid / icon / image / name / playtime2Weeks / playtimeForever / steamAppid，
//   **tags 与 price 从未出现**（契约里是两个可选字段，服务端不填）。
//   即：玩过的时长拿得到，游戏标签与通关时间拿不到。

const CDP_URL = process.env.CDP_URL ?? 'http://127.0.0.1:9222';
const MINI_ORIGIN = process.env.MINI_ORIGIN ?? 'http://127.0.0.1:5173';

const QUERIES = [
  { label: 'sort=weeks', options: { limit: 2, sort: 'weeks' } },
  { label: 'sort=achieved', options: { limit: 2, sort: 'achieved' } },
  { label: 'q=哈迪斯', options: { limit: 5, q: '哈迪斯', sort: 'all' } },
  { label: 'q=暗黑地牢', options: { limit: 5, q: '暗黑地牢', sort: 'all' } },
  { label: 'q=Dishonored', options: { limit: 5, q: 'Dishonored', sort: 'all' } },
  { label: 'includeHidden', options: { limit: 2, includeHidden: true, sort: 'all' } },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`${CDP_URL}/json/list`)).json();
const target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!target) throw new Error('没有找到可调试页面');

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

const pending = new Map();
let nextId = 1;
const contexts = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.executionContextCreated') contexts.push(msg.params.context);
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

await send('Runtime.enable');

// 等小程序 frame 出现
let mini = null;
for (let i = 0; i < 60 && !mini; i += 1) {
  mini = contexts.filter((c) => typeof c.origin === 'string' && c.origin.startsWith(MINI_ORIGIN)).at(-1);
  if (!mini) await sleep(500);
}
if (!mini) throw new Error(`没等到小程序 frame 上下文（${MINI_ORIGIN}）`);
console.log(`小程序 frame: id=${mini.id}\n`);

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    contextId: mini.id,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

// 从 Vite 转换后的 main.js 里提取 SDK 的预打包模块地址。用它动态 import，
// 拿到的是与页面同一个单例（同一 URL → 同一模块实例），因此握手已完成。
const mainSrc = await (await fetch(`${MINI_ORIGIN}/src/main.js`)).text();
const found = mainSrc.match(/["']([^"']*\.vite\/deps\/[^"']*heybox[^"']*)["']/);
const sdkUrl = found
  ? new URL(found[1], MINI_ORIGIN).href
  : await evaluate(`
      (() => {
        const urls = performance.getEntriesByType('resource').map((e) => e.name);
        return urls.find((n) => /heybox/i.test(n)) || null;
      })()
    `);
console.log(`SDK 模块地址: ${sdkUrl}\n`);
if (!sdkUrl) {
  const all = await evaluate(`JSON.stringify(performance.getEntriesByType('resource').map((e) => e.name).slice(0, 40))`);
  console.log('已加载资源（前 40）:', all);
  throw new Error('没有找到 SDK 模块地址');
}

for (const { label, options } of QUERIES) {
  const payload = JSON.stringify(options);
  const raw = await evaluate(`
    (async () => {
      try {
        const mod = await import(${JSON.stringify(sdkUrl)});
        const sdk = mod.default ?? mod;
        const r = await sdk.user.getSteamGameList(${payload});
        if (!r.isLogin || !r.isBound) return JSON.stringify({ state: { isLogin: r.isLogin, isBound: r.isBound } });
        const items = r.data.gameList ?? [];
        return JSON.stringify({
          count: items.length,
          total: r.data.total ?? null,
          keysUnion: [...new Set(items.flatMap((it) => Object.keys(it)))].sort(),
          tagsPresent: items.filter((it) => Array.isArray(it.tags) && it.tags.length > 0).length,
          first: items[0] ?? null,
        });
      } catch (e) { return JSON.stringify({ error: String(e && e.code || e && e.message || e) }); }
    })()
  `);
  console.log(`── ${label} ─────────────────────────────`);
  try {
    const parsed = JSON.parse(raw);
    console.log(`  命中 ${parsed.count ?? '-'} / total=${parsed.total ?? '-'}  带标签的条目数=${parsed.tagsPresent ?? '-'}`);
    if (parsed.keysUnion) console.log(`  键名合集: ${parsed.keysUnion.join(', ')}`);
    if (parsed.error) console.log(`  错误: ${parsed.error}`);
    if (parsed.first) console.log(`  首条原始记录: ${JSON.stringify(parsed.first)}`);
  } catch {
    console.log(`  原始返回: ${raw}`);
  }
  console.log('');
}

// 可选：DUMP_LIBRARY=<path> 时，翻完整个游戏库并把 appid 清单写到该文件。
// 用来给 scripts/build-game-metadata.mjs 生成种子列表。
const dumpPath = process.env.DUMP_LIBRARY;
if (dumpPath) {
  const raw = await evaluate(`
    (async () => {
      const mod = await import(${JSON.stringify(sdkUrl)});
      const sdk = mod.default ?? mod;
      const out = [];
      let offset = 0;
      for (let page = 0; page < 20; page += 1) {
        const r = await sdk.user.getSteamGameList({ limit: 100, offset, sort: 'all' });
        if (!r.isLogin || !r.isBound) return JSON.stringify({ error: 'not-bound' });
        out.push(...r.data.gameList.map((it) => ({ appid: it.appid, steamAppid: it.steamAppid, name: it.name })));
        if (!r.data.hasMore) break;
        offset = r.data.nextOffset;
      }
      return JSON.stringify({ count: out.length, games: out });
    })()
  `);
  const parsed = JSON.parse(raw);
  if (parsed.error) throw new Error(`导出失败：${parsed.error}`);
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { dirname, resolve } = await import('node:path');
  mkdirSync(dirname(resolve(dumpPath)), { recursive: true });
  writeFileSync(resolve(dumpPath), JSON.stringify(parsed.games, null, 2), 'utf8');
  console.log(`已导出 ${parsed.count} 款游戏的 appid 清单 → ${resolve(dumpPath)}\n`);
}

ws.close();

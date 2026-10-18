// 浏览器 Mock 渲染验证（开发工具，不参与小程序打包）
//
// 用途：用无头 Chrome 打开 hb-sdk 调试台，进入跨源 iframe 里的小程序，读取真实渲染出来的
// DOM，确认「读库 → 算画像 → 出推荐」这条链路跑通、没有运行时异常。
//
// 前置：
//   1. npm run dev 已在运行（页面服务 5173、调试台 5174）
//   2. 无头 Chrome 带 --remote-debugging-port=9222 已启动并打开了调试台地址
//      注意：**不要加 --hide-scrollbars**，否则滚动条宽度为 0，布局稳定性就测不出来了。
//
// 用法：
//   node scripts/verify-browser-mock.mjs
//   CDP_URL=http://127.0.0.1:9222 VERIFY_TIMEOUT_MS=60000 node scripts/verify-browser-mock.mjs
//   SCREENSHOT=out.png node scripts/verify-browser-mock.mjs

const CDP_URL = process.env.CDP_URL ?? 'http://127.0.0.1:9222';
const MINI_ORIGIN = process.env.MINI_ORIGIN ?? 'http://127.0.0.1:5173';
const TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS ?? 30000);

const PROBE = `(() => {
  const el = (id) => document.querySelector('[data-testid="' + id + '"]');
  const text = (id) => { const n = el(id); return n ? n.textContent.trim() : null; };
  const list = (sel) => Array.from(document.querySelectorAll(sel)).map((n) => n.textContent.trim());
  const once = (id) => { const n = el(id); return n ? { hidden: n.hidden, text: n.textContent.trim() } : null; };

  // 关键：不能只看 hidden 属性。作者样式表里的 display:flex 会盖掉 [hidden] 的 display:none，
  // 于是 el.hidden === true 但元素照样显示。必须判断**实际是否渲染**。
  // 注意 getComputedStyle(子元素).display 不反映祖先被隐藏，所以用 checkVisibility /
  // getClientRects —— 祖先 display:none 时两者都会判为不可见。
  const visible = (id) => {
    const n = el(id);
    if (!n) return null;
    if (typeof n.checkVisibility === 'function') {
      return n.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    return n.getClientRects().length > 0;
  };

  return JSON.stringify({
    title: document.title,
    badge: text('source-badge'),
    detail: text('source-detail'),
    sourceDetailVisible: visible('source-detail'),
    probeNote: el('probe-note') && visible('probe-note') ? text('probe-note') : null,
    visibleSections: {
      loading: visible('state-loading'),
      error: visible('state-error'),
      result: visible('result'),
    },
    loading: once('state-loading'),
    error: once('state-error'),
    result: once('result'),
    loadingText: text('loading-text'),
    errorTitle: text('error-title'),
    retryVisible: visible('retry-button'),
    reloadVisible: visible('reload-button'),
    randomVisible: visible('random-button'),
    scorePanelVisible: visible('score-panel'),

    // 底部操作条：必须是 fixed，且滚动时位置不变。
    dock: (() => {
      const n = el('action-dock');
      if (!n) return null;
      const r = n.getBoundingClientRect();
      return {
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        position: getComputedStyle(n).position,
      };
    })(),

    // 「纯随机」按钮不能是透明底，否则和页面背景糊在一起看不见。
    randomButtonBg: (() => {
      const n = el('random-button');
      return n ? getComputedStyle(n).backgroundColor : null;
    })(),

    headline: text('pick-headline'),
    name: text('pick-name'),
    // 类型标签（"这是什么类型"），数据来自打包的标签数据集。
    tags: list('[data-testid="pick-tags"] li'),
    tagsVisible: visible('pick-tags'),
    meta: text('pick-meta'),
    reasons: list('[data-testid="pick-reasons"] li'),
    scoreBars: list('[data-testid="score-bars"] li'),
    profileHint: text('profile-hint'),
    profileBars: list('[data-testid="profile-bars"] li'),

    // 折叠面板：打分构成默认收起，口味画像默认展开。
    scoreOpen: (() => { const n = el('score-panel'); return n ? n.open === true : null; })(),
    profileOpen: (() => { const n = el('profile-panel'); return n ? n.open === true : null; })(),
    scoreSummary: (() => {
      const n = el('score-panel');
      return n?.querySelector('summary')?.textContent.trim() ?? null;
    })(),

    // 备选列表、回到首选、排名提示都应该已经从页面上消失。
    alternativesGone: document.querySelectorAll('[data-testid="alternatives-panel"], .alts').length === 0,
    resetGone: document.querySelectorAll('[data-testid="reset-button"]').length === 0,
    rankNoteGone: document.querySelectorAll('[data-testid="rank-note"], .rank-note').length === 0,

    // 布局稳定性：展开折叠面板时滚动条不该挤压视口（否则居中内容会左移抖动）。
    layout: (() => {
      const root = document.documentElement;
      const app = document.querySelector('.app');
      const box = app ? app.getBoundingClientRect() : null;
      return {
        clientWidth: root.clientWidth,
        clientHeight: root.clientHeight,
        scrollHeight: root.scrollHeight,
        bodyScrollWidth: document.body.scrollWidth,
        appLeft: box ? Math.round(box.left) : null,
        appWidth: box ? Math.round(box.width) : null,
      };
    })(),
  });
})()`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findPageTarget() {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`${CDP_URL}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // Chrome 还没起来，继续等
    }
    await sleep(400);
  }
  throw new Error(`在 ${TIMEOUT_MS}ms 内没有找到可调试的页面目标（${CDP_URL}）`);
}

function createClient(ws) {
  const pending = new Map();
  const events = [];
  let nextId = 1;

  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
      return;
    }
    events.push(message);
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  return { send, events };
}

const target = await findPageTarget();
console.log(`调试目标: ${target.url}`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

const { send, events } = createClient(ws);
await send('Runtime.enable');
await send('Page.enable');

/**
 * 当前**存活**的执行上下文。
 * 必须跟踪销毁事件：只按"最后一个 created"取，会把已经被 HMR 换掉的死 context 捡回来，
 * 重试就永远失败（Cannot find context with specified id）。
 */
function liveContexts() {
  const destroyed = new Set();
  const created = [];
  for (const event of events) {
    if (event.method === 'Runtime.executionContextDestroyed') {
      destroyed.add(event.params.executionContextId);
    } else if (event.method === 'Runtime.executionContextsCleared') {
      created.length = 0;
    } else if (event.method === 'Runtime.executionContextCreated') {
      created.push(event.params.context);
    }
  }
  return created.filter((ctx) => !destroyed.has(ctx.id));
}

/**
 * 等待小程序 frame 的 execution context 出现（跨源 iframe 需要用它自己的 context 求值）。
 * `graceMs` 之后即使只剩"被排除的那个"也接受 —— 重试总比直接放弃有用。
 */
async function findMiniContext(excludeId = null, graceMs = 8000, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  const graceEnd = Date.now() + graceMs;
  while (Date.now() < deadline) {
    const candidates = liveContexts().filter(
      (ctx) => typeof ctx.origin === 'string' && ctx.origin.startsWith(MINI_ORIGIN),
    );
    const fresh = candidates.filter((ctx) => ctx.id !== excludeId).at(-1);
    if (fresh) return fresh;
    if (Date.now() > graceEnd && candidates.length > 0) return candidates.at(-1);
    await sleep(300);
  }
  return null;
}

/**
 * 等到小程序 frame 出现；等不到就重载调试台再来一轮。
 *
 * 调试台偶发不创建 iframe（同一台机器、同一命令，下一次又正常）。这是调试台自身的问题，
 * 但会让整轮验证白跑，所以在这里自愈，而不是让人盯着偶发失败去猜是不是应用坏了。
 */
async function waitForMiniContext(rounds = 3, perRoundMs = 25000) {
  for (let round = 1; round <= rounds; round += 1) {
    const ctx = await findMiniContext(null, 5000, perRoundMs);
    if (ctx) return ctx;
    const iframeCount = await send('Runtime.evaluate', {
      expression: `document.querySelectorAll('iframe').length`,
      returnByValue: true,
    })
      .then((r) => r.result.value)
      .catch(() => '?');
    console.error(`第 ${round}/${rounds} 轮没等到小程序 frame（调试台 iframe 数：${iframeCount}）`);
    if (round < rounds) {
      await send('Page.reload', { ignoreCache: true }).catch(() => {});
      await sleep(4000);
    }
  }
  return null;
}

/**
 * 在指定 frame 里求值。
 * Vite HMR、调试台重建 iframe、以及重启 `hb-sdk dev` 都会换掉 execution context，
 * 导致 Cannot find context / Execution context was destroyed。这类错误一律重试，
 * 否则一次热更新就能让整轮验证崩掉（真发生过）。
 */
async function evaluateIn(contextId, expression, retries = 3) {
  try {
    const result = await send('Runtime.evaluate', {
      expression,
      contextId,
      returnByValue: true,
      awaitPromise: false,
    });
    if (result.exceptionDetails) {
      throw new Error(`页面内求值抛出异常 ${result.exceptionDetails.text}`);
    }
    return result.result.value;
  } catch (error) {
    const recoverable = /Cannot find context|Execution context was destroyed|Target closed/i;
    if (retries > 0 && recoverable.test(error.message)) {
      await sleep(500);
      // 这里不再排除旧 id：context 可能已经被整体重建，最新存活的那个就是目标。
      const fresh = await findMiniContext();
      if (fresh) {
        context = fresh;
        return evaluateIn(fresh.id, expression, retries - 1);
      }
    }
    throw error;
  }
}

let context = await waitForMiniContext();
if (!context) {
  console.error(`没有等到小程序 frame 的上下文（期望来自 ${MINI_ORIGIN}）。`);
  const seen = events
    .filter((e) => e.method === 'Runtime.executionContextCreated')
    .map((e) => e.params.context);
  console.error('  已观察到的执行上下文：');
  console.error(
    seen.length
      ? seen.map((ctx) => `    - id=${ctx.id} origin=${ctx.origin} name=${ctx.name || ''}`).join('\n')
      : '    (一个都没有)',
  );

  // 在宿主页里查一下到底有没有建出 iframe，以及它卡在哪一步。
  const hostContext = seen.find(
    (ctx) => typeof ctx.origin === 'string' && ctx.origin.includes(':5174'),
  );
  if (hostContext) {
    try {
      const report = await evaluateIn(
        hostContext.id,
        `JSON.stringify({
          iframes: Array.from(document.querySelectorAll('iframe')).map((f) => f.src || '(no src)'),
          bodyText: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 400),
        })`,
      );
      console.error(`  宿主页状态：${report}`);
    } catch (error) {
      console.error(`  读取宿主页状态失败：${error.message}`);
    }
  }

  console.error(`  当前调试目标：${target.url}`);
  ws.close();
  process.exit(1);
}
console.log(`小程序 frame context: id=${context.id} origin=${context.origin}`);

async function evaluate(expression) {
  return evaluateIn(context.id, expression);
}

// 轮询到"结果"或"错误"分支出现为止（数据加载 + 算法 + 渲染都是异步的）。
// 单次求值失败不算失败：页面可能正在热重载，重试比直接崩掉有用。
let snapshot = null;
let rendered = false;
let lastError = null;
const deadline = Date.now() + TIMEOUT_MS;
while (Date.now() < deadline) {
  try {
    snapshot = JSON.parse(await evaluate(PROBE));
    lastError = null;
  } catch (error) {
    lastError = error;
    await sleep(800);
    continue;
  }
  const resultShown = snapshot.result && snapshot.result.hidden === false;
  const errorShown = snapshot.error && snapshot.error.hidden === false;
  if (resultShown || errorShown) {
    rendered = true;
    break;
  }
  await sleep(500);
}
if (!snapshot && lastError) {
  console.error(`读取页面快照一直失败：${lastError.message}`);
  ws.close();
  process.exit(1);
}

const readSnapshot = async () => JSON.parse(await evaluate(PROBE));

async function waitFor(predicate, timeout = 10000) {
  const until = Date.now() + timeout;
  let last = await readSnapshot();
  while (Date.now() < until) {
    if (predicate(last)) return last;
    await sleep(250);
    last = await readSnapshot();
  }
  return last;
}

let fold = null;
let reroll = null;
let random = null;
let detail = null;

if (rendered && snapshot.result?.hidden === false) {
  // 1) 折叠面板：两个都默认展开；点标题能收起/再展开，且互不影响。
  //    默认状态就是"内容最长"的状态，正好用来测滚动条挤压与底部操作条固定。
  fold = {
    initialScoreOpen: snapshot.scoreOpen,
    initialProfileOpen: snapshot.profileOpen,
    layoutBefore: snapshot.layout,
    dockBeforeScroll: snapshot.dock,
    randomButtonBg: snapshot.randomButtonBg,
  };

  // 滚到底部：固定的操作条不能跟着动。
  await evaluate(
    `(() => { window.scrollTo(0, document.documentElement.scrollHeight); return window.scrollY; })()`,
  );
  await sleep(400);
  fold.scrollY = await evaluate(`Math.round(window.scrollY)`);
  const scrolled = await readSnapshot();
  fold.dockAfterScroll = scrolled?.dock;
  fold.layoutBothOpen = scrolled?.layout;
  await evaluate(`(() => { window.scrollTo(0, 0); return true; })()`);
  await sleep(300);

  // 收起打分构成：口味画像必须不受影响。
  await evaluate(`document.querySelector('[data-testid="score-panel"] > summary').click(), true`);
  const scoreClosed = await waitFor((s) => s.scoreOpen === false);
  fold.afterCollapseScoreOpen = scoreClosed?.scoreOpen;
  fold.profileStaysOpen = scoreClosed?.profileOpen;

  // 再展开回来，确认可以反复切换。
  await evaluate(`document.querySelector('[data-testid="score-panel"] > summary').click(), true`);
  const scoreReopened = await waitFor((s) => s.scoreOpen === true);
  fold.afterReExpandScoreOpen = scoreReopened?.scoreOpen;

  // 口味画像也要能收起。
  await evaluate(`document.querySelector('[data-testid="profile-panel"] > summary').click(), true`);
  const profileClosed = await waitFor((s) => s.profileOpen === false);
  fold.afterCollapseProfileOpen = profileClosed?.profileOpen;
  fold.layoutAfterCollapse = profileClosed?.layout;

  // 2) 只用「换一个」翻推荐：连续两次都必须换成不同的游戏。
  const first = snapshot.name;
  await evaluate(`document.querySelector('[data-testid="reroll-button"]').click(), true`);
  const secondState = await waitFor((s) => s.name && s.name !== first);
  const second = secondState?.name ?? null;
  await evaluate(`document.querySelector('[data-testid="reroll-button"]').click(), true`);
  const thirdState = await waitFor((s) => s.name && s.name !== second && s.name !== first);
  reroll = { first, second, third: thirdState?.name ?? null };

  // 3) 「纯随机」：标题变成「随机」、隐藏打分构成，且连点两次换到不同游戏。
  await evaluate(`document.querySelector('[data-testid="random-button"]').click(), true`);
  const random1 = await waitFor((s) => /随机/.test(s.headline ?? ''));
  await evaluate(`document.querySelector('[data-testid="random-button"]').click(), true`);
  const random2 = await waitFor((s) => s.name && s.name !== (random1?.name ?? ''));
  await evaluate(`document.querySelector('[data-testid="reroll-button"]').click(), true`);
  const backToRanked = await waitFor((s) => !/随机/.test(s.headline ?? ''));
  random = {
    first: {
      name: random1?.name ?? null,
      headline: random1?.headline ?? null,
      tags: random1?.tags ?? null,
      scorePanelVisible: random1?.scorePanelVisible,
    },
    second: { name: random2?.name ?? null },
    backToRanked: {
      name: backToRanked?.name ?? null,
      headline: backToRanked?.headline ?? null,
      scorePanelVisible: backToRanked?.scorePanelVisible,
    },
  };

  // 4) 深链按钮：浏览器 Mock 里点它**不会跳转**，调试台会弹「打开页面」模拟对话框，
  //    因此这里只确认点击不会让页面报错或崩掉（真机验收才能确认真的跳转）。
  await evaluate(`document.querySelector('[data-testid="open-detail-button"]').click(), true`);
  await sleep(1500);
  const afterClick = await readSnapshot();
  detail = {
    resultStillVisible: afterClick?.visibleSections?.result === true,
    dockStillFixed: afterClick?.dock?.position === 'fixed',
  };
}

const consoleErrors = events
  .filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
  .map((e) => e.params.args.map((a) => a.value ?? a.description ?? '').join(' '));

// 必须单独统计未捕获异常：模块求值阶段抛错不会走 console.error，只会触发
// Runtime.exceptionThrown。少了这一条，页面白屏时会查不出任何原因（真遇到过）。
const uncaughtErrors = events
  .filter((e) => e.method === 'Runtime.exceptionThrown')
  .map((e) => {
    const d = e.params.exceptionDetails;
    const desc = d.exception?.description ?? d.text ?? '(无可读描述)';
    return `${desc.split('\n')[0]}  @${d.url ?? '?'}:${d.lineNumber ?? '?'}`;
  });

// 页面里的 console.info 也收集起来：数据层会在这里打印字段探针与字段普查结果。
const consoleInfo = events
  .filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type !== 'error')
  .map((e) => e.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
  .filter((line) => line.includes('[字段'));

console.log('\n── 渲染快照 ────────────────────────────────');
console.log(JSON.stringify(snapshot, null, 2));

console.log('\n── 页面的 console.error ────────────────────');
console.log(consoleErrors.length === 0 ? '(无)' : consoleErrors.join('\n'));

console.log('\n── 未捕获异常 ──────────────────────────────');
console.log(uncaughtErrors.length === 0 ? '(无)' : uncaughtErrors.join('\n'));

console.log('\n── 字段探针 / 字段普查（页面 console）──────');
console.log(consoleInfo.length === 0 ? '(没有输出)' : consoleInfo.join('\n'));

console.log('\n── 交互 ────────────────────────────────────');
console.log('折叠面板：', JSON.stringify(fold));
console.log('换一个：', JSON.stringify(reroll));
console.log('纯随机：', JSON.stringify(random));
console.log('深链按钮：', JSON.stringify(detail));

const problems = [];
const gaps = [];
if (!rendered) problems.push('超时：结果区和错误区都没有出现');

// 最重要的一条：用户实际看到的区块必须**只有一个**。
// 只检查 hidden 属性会漏掉「display:flex 盖掉 [hidden]」这类 bug，必须看实际渲染。
const shown = Object.entries(snapshot?.visibleSections ?? {})
  .filter(([, isVisible]) => isVisible === true)
  .map(([name]) => name);
if (shown.length === 0) problems.push('三个区块（加载中/错误/结果）一个都没显示，页面是空白的');
else if (shown.length > 1) {
  problems.push(`同时显示了 ${shown.length} 个区块：${shown.join(' + ')}（hidden 属性被 CSS 覆盖了）`);
}
if (snapshot?.error?.hidden === false) problems.push(`页面进入错误分支：${snapshot.error.text}`);

if (rendered && snapshot.result?.hidden === false) {
  if (!snapshot.name) problems.push('结果区出现了，但没有推荐游戏');
  if (!snapshot.reasons || snapshot.reasons.length === 0) problems.push('没有渲染推荐理由');
  if (!snapshot.profileHint) problems.push('没有渲染画像说明');
  if (!snapshot.badge) problems.push('没有渲染数据来源标识');

  // 类型标签：必须有，且不超过 5 个（多了会换行成两排、显得吵）。
  if (!snapshot.tags || snapshot.tags.length === 0) {
    problems.push('没有展示游戏类型标签');
  } else if (snapshot.tags.length > 5) {
    problems.push(`类型标签有 ${snapshot.tags.length} 个，超过上限 5 个`);
  } else if (snapshot.tagsVisible !== true) {
    problems.push('类型标签渲染了但不可见');
  }
  if (snapshot.alternativesGone !== true) problems.push('备选列表没有被移除');
  if (snapshot.resetGone !== true) problems.push('「回到首选」按钮没有被移除');
  if (snapshot.rankNoteGone !== true) problems.push('排名提示没有被移除');

  // 扫描成功时右侧必须显示读到的游戏数。
  if (/扫描成功/.test(snapshot.badge ?? '')) {
    if (snapshot.sourceDetailVisible !== true) problems.push('扫描成功时没有显示「已读取 N 款游戏」');
    else if (!/已读取\s*\d+\s*款/.test(snapshot.detail ?? '')) {
      problems.push(`右侧数字文案不对：「${snapshot.detail}」`);
    }
  }
}

if (fold) {
  if (fold.initialScoreOpen !== true) problems.push('打分构成面板默认没有展开');
  if (fold.initialProfileOpen !== true) problems.push('口味画像面板默认没有展开');
  if (fold.afterCollapseScoreOpen !== false) problems.push('打分构成面板无法收起');
  if (fold.profileStaysOpen !== true) problems.push('收起打分构成会影响口味画像（应互不影响）');
  if (fold.afterReExpandScoreOpen !== true) problems.push('打分构成收起后无法再展开');
  if (fold.afterCollapseProfileOpen !== false) problems.push('口味画像面板无法收起');

  // 布局稳定性：默认（最长）状态下，视口宽度与 .app 的位置/宽度都不能变。
  const before = fold.layoutBefore;
  const after = fold.layoutBothOpen;
  if (before && after) {
    if (after.scrollHeight <= after.clientHeight) {
      gaps.push('展开面板后内容仍未超出屏幕，本次没测到滚动条场景');
    }
    if (after.clientWidth !== before.clientWidth) {
      problems.push(
        `展开后视口宽度从 ${before.clientWidth} 变成 ${after.clientWidth}：滚动条挤压了视口`,
      );
    }
    if (after.appWidth !== before.appWidth || after.appLeft !== before.appLeft) {
      problems.push(
        `展开后 .app 发生位移：${before.appLeft}px/${before.appWidth}px → ${after.appLeft}px/${after.appWidth}px`,
      );
    }
    if (after.bodyScrollWidth > after.clientWidth + 1) {
      problems.push(`出现横向溢出：内容宽 ${after.bodyScrollWidth} > 视口 ${after.clientWidth}`);
    }
  }
  const back = fold.layoutAfterCollapse;
  if (before && back && back.appWidth !== before.appWidth) {
    problems.push(`收起后 .app 宽度没回到初始值：${back.appWidth} vs ${before.appWidth}`);
  }

  // 底部操作条必须真的固定：position: fixed，且滚动前后位置完全不变。
  if (fold.dockBeforeScroll?.position !== 'fixed') {
    problems.push(`底部操作条不是固定定位（position=${fold.dockBeforeScroll?.position}）`);
  }
  if (fold.scrollY > 0 && fold.dockAfterScroll) {
    if (
      fold.dockAfterScroll.top !== fold.dockBeforeScroll?.top ||
      fold.dockAfterScroll.bottom !== fold.dockBeforeScroll?.bottom
    ) {
      problems.push(
        `滚动后底部操作条位移了：${fold.dockBeforeScroll?.top}/${fold.dockBeforeScroll?.bottom} → ` +
          `${fold.dockAfterScroll.top}/${fold.dockAfterScroll.bottom}`,
      );
    }
  } else {
    gaps.push('页面没滚动起来，本次没验证到"操作条不随滚动移动"');
  }

  // 「纯随机」按钮必须有可见底色。
  const bg = fold.randomButtonBg ?? '';
  if (/^rgba?\(0, 0, 0, 0\)$/.test(bg) || bg === 'transparent' || !bg) {
    problems.push(`「纯随机」按钮背景是透明的，会和页面背景糊在一起（${bg}）`);
  }
}

if (reroll) {
  if (!reroll.second) problems.push('点了「换一个」但推荐没有变化');
  else if (reroll.second === reroll.first) problems.push('「换一个」换到了同一款游戏');
  if (!reroll.third) problems.push('连续第二次点「换一个」没有继续往下换');
  else if (reroll.third === reroll.second || reroll.third === reroll.first) {
    problems.push('连续换两个时出现了重复的推荐');
  }
}

if (random) {
  if (snapshot.randomVisible !== true) problems.push('「纯随机」按钮没有渲染出来');
  if (random.first.headline !== '随机') {
    problems.push(`随机模式的标题应该就是「随机」，实际是「${random.first.headline}」`);
  }
  if (random.first.scorePanelVisible !== false) {
    problems.push('随机模式下仍显示「打分构成」，会让人以为分数决定了结果');
  }
  if (!random.first.name) problems.push('随机模式没有显示游戏名');
  if (!random.first.tags || random.first.tags.length === 0) {
    problems.push('随机模式没有展示游戏类型标签');
  }
  if (random.first.name && random.first.name === random.second.name) {
    problems.push('连点两次「纯随机」抽到了同一款（应避开当前展示的那款）');
  }
  if (/随机/.test(random.backToRanked.headline ?? '')) {
    problems.push('点「换一个」后仍停留在随机口径');
  }
  if (random.backToRanked.scorePanelVisible !== true) {
    problems.push('回到评分排序后「打分构成」没有恢复显示');
  }
}

if (detail) {
  // 浏览器 Mock 不会真跳转（调试台弹模拟对话框），所以只验证点击后页面依然完好。
  if (detail.resultStillVisible !== true) problems.push('点了「看游戏详情」后结果区消失了');
  if (detail.dockStillFixed !== true) problems.push('点了「看游戏详情」后底部操作条不再固定');
}

if (consoleErrors.length > 0) problems.push(`页面报了 ${consoleErrors.length} 条 console.error`);
if (uncaughtErrors.length > 0) problems.push(`页面有 ${uncaughtErrors.length} 个未捕获异常`);

// 可选：SCREENSHOT=<path> 时截一张图，用来做**视觉**确认（属性检查看不出布局问题）。
const screenshotPath = process.env.SCREENSHOT;
if (screenshotPath) {
  try {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { dirname, resolve } = await import('node:path');
    mkdirSync(dirname(resolve(screenshotPath)), { recursive: true });
    writeFileSync(resolve(screenshotPath), Buffer.from(shot.data, 'base64'));
    console.log(`\n截图已保存 → ${resolve(screenshotPath)}`);
  } catch (error) {
    console.error(`截图失败：${error.message}`);
  }
}

console.log('\n── 结论 ────────────────────────────────────');
if (gaps.length > 0) console.log(`⚠ 能力缺口：\n  - ${gaps.join('\n  - ')}`);
console.log(problems.length === 0 ? '✓ 浏览器中渲染与交互正常' : `✗ ${problems.join('\n✗ ')}`);

ws.close();
process.exit(problems.length === 0 ? 0 : 1);

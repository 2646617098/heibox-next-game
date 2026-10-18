// 数据层：读取用户 Steam 游戏库，并在真实数据不可用时回退到演示数据。
//
// 只用官方已开放的能力：
//   user.getSteamGameList() —— 需要 package.json#heybox.permissions 声明 steamLibrary。
//   它走 Host 受信请求，不需要 network 权限、不需要平台批准、不弹授权 UI、不需要可信用户手势。
//
// 口径选择：统一用 sort: 'all' 拉取。
//   'weeks' 只按近两周排序，拿不到完整的吃灰库；'all' 返回的每个条目同时带
//   playtime2Weeks 和 playtimeForever，一份数据就能同时支撑"风格画像"和"候选池"两个用途，
//   也少一轮请求（Host 对同一查询有 24 小时缓存）。

import hbSDK from '@heybox/hb-sdk';
import { DEMO_LIBRARY } from './demo-library.js';
import { attachMetadata, metadataStats } from './game-metadata.js';

const PAGE_LIMIT = 100;

// 真实库可能有近千款游戏（实测 876 款）。上限按"能覆盖整库"给，同时留一个硬边界防止
// 异常情况下无限翻页：10 页 = 1000 款。Host 对同一查询有 24 小时缓存，重复调用不会重复拉取。
const MAX_PAGES = 10;

// 读库重试策略。
// 这几个错误码代表"现在不行、等下可能就行"，直接降级成演示数据会让用户以为库读不出来：
//   AUTHORIZATION_CONTEXT_CHANGED  宿主正在建立/轮换授权上下文（真机首次打开时最常见）
//   REQUEST_TIMEOUT                宿主忙或开发会话刚建立
//   RATE_LIMITED_BY_RUNTIME        Runtime 侧的短时限流
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 800;
// 冷启动的授权上下文轮换走短退避：它在几十毫秒内就失败，不是网络问题，不该等 800ms。
const CONTEXT_RETRY_DELAY_MS = 250;
// 失败得快还不够 1.5 秒，说明不是超时而是被宿主当场拒绝 —— 同样属于"还没到时候"。
const FAST_FAILURE_MS = 1500;
const RETRYABLE_CODES = new Set([
  'AUTHORIZATION_CONTEXT_CHANGED',
  'REQUEST_TIMEOUT',
  'RATE_LIMITED_BY_RUNTIME',
]);

/**
 * 这个错误码是不是"上下文还没建立好"（预期内的冷启动状态），而不是真正的失败。
 *
 * 线上真机首次打开的固定形态是：第 1 次请求在约 0.2–0.4 秒内被
 * `AUTHORIZATION_CONTEXT_CHANGED` 拒绝，第 2 次成功。既然它必定发生，界面就不该把它
 * 当"重试失败"报给用户（那会让人以为程序在出错），只该显示"正在连接账号"。
 */
function isWarmupError(code) {
  return code === 'AUTHORIZATION_CONTEXT_CHANGED';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 已知的条目字段，来自 SteamGameListItem 的手写契约。 */
const KNOWN_ITEM_KEYS = new Set([
  'appid',
  'steamAppid',
  'name',
  'image',
  'icon',
  'playtimeForever',
  'playtime2Weeks',
  'tags',
  'price',
]);

/**
 * 字段探针。
 *
 * 文档确认 `SteamGameListItem` 只有上面 9 个字段，但 `SteamGameListSort` 支持 `'achieved'`
 * （按成就数排序）而条目里**没有任何成就数字段** —— 曾据此推测 Host 侧可能持有比公开契约
 * 更多的数据（例如通关时间），只是在规范化时裁掉了。
 *
 * 真机实测结论：**没有契约之外的字段**。所以"平均游玩时间"确实拿不到，只能靠估算。
 * 这个探针保留下来，作为"接口变了"的哨兵。
 *
 * 只做**诊断上报**，不参与打分：多出来的字段单位（秒/分/小时）无法确认，猜单位会把推荐算错。
 */
function probeUnknownKeys(games) {
  const found = new Map();
  for (const game of games) {
    for (const key of Object.keys(game)) {
      if (KNOWN_ITEM_KEYS.has(key) || found.has(key)) continue;
      found.set(key, game[key]);
    }
  }
  return found;
}

/**
 * 字段普查：每个已知字段在多少条目里**真的存在且非空**。
 *
 * 这是被真实数据教出来的：契约里 9 个字段全是可选的，`tags` 在文档里写着"没有有效标签时
 * 整个字段省略"，实测真实库**一条标签都没有**。只看类型契约会以为标签一定能拿到，
 * 普查才能暴露"字段在契约里"和"字段在数据里"的区别。
 */
function censusFields(games) {
  const counts = new Map();
  for (const game of games) {
    for (const [key, value] of Object.entries(game)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value) && value.length === 0) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const total = games.length;
  const fields = [...counts.entries()]
    .map(([key, count]) => ({ key, count, known: KNOWN_ITEM_KEYS.has(key) }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  // 给上层用的能力判定：某个字段一款游戏都没有，等于这个能力不可用。
  const has = (key) => (counts.get(key) ?? 0) > 0;
  const coverage = (key) => (total === 0 ? 0 : (counts.get(key) ?? 0) / total);

  return {
    total,
    fields,
    missing: [...KNOWN_ITEM_KEYS].filter((key) => !has(key)).sort(),
    coverage: {
      tags: coverage('tags'),
      playtime2Weeks: coverage('playtime2Weeks'),
      playtimeForever: coverage('playtimeForever'),
      image: coverage('image'),
    },
    // 没有标签 → 风格画像和时长估算都无法工作，界面必须明说而不是静默降级。
    tagsUsable: coverage('tags') >= 0.05,
  };
}

/**
 * @param {{
 *   onProgress?: (info: {pages: number, games: number, total: number|null}) => void,
 * }} [options] `onProgress` 每读完一页回调一次：876 款要发 10 次请求，界面需要让用户
 *   看出"在推进"而不是卡住。
 * @returns {Promise<{
 *   source: 'live'|'demo',
 *   reason: null|'logged-out'|'unbound'|'empty'|'error',
 *   errorCode: string|null,
 *   games: Array,
 *   pages: number,
 *   truncated: boolean,
 *   total: number|null,
 * }>}
 */
export async function loadLibrary(options = {}) {
  // `api` 只为可测试性而存在：默认用真实 SDK，测试里可以注入一个会按剧本失败的假实现，
  // 否则真机上的授权上下文轮换、超时这些分支在本地根本跑不到。
  const { onProgress, api = hbSDK } = options;

  // 每次尝试都留一条记录（错误码 + 耗时）。真机上开发者看不到控制台，这组记录会渲染到
  // 页面的诊断区，也会进 `hb-sdk dev logs` —— 这是区分"账号没绑定""Host 请求没回来"
  // "桥接没建立"的唯一证据，所以不能用一行 warn 带过。
  const attempts = [];
  const startedAt = Date.now();

  // 真机上第一次读库经常撞在"授权上下文正在建立"的瞬间：小程序一打开就开始读，
  // 而宿主这时还在等用户确认权限清单。这类错误是**可恢复**的，不该直接降级成演示数据。
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const attemptStartedAt = Date.now();
    try {
      const outcome = await readAllPages(onProgress);
      const elapsedMs = Date.now() - startedAt;
      if (outcome.kind === 'logged-out') return demoResult({ reason: 'logged-out', attempts, elapsedMs });
      if (outcome.kind === 'unbound') return demoResult({ reason: 'unbound', attempts, elapsedMs });
      if (outcome.games.length === 0) return demoResult({ reason: 'empty', attempts, elapsedMs });
      return buildLiveResult(outcome, { attempts, elapsedMs });
    } catch (error) {
      const code = error?.code ?? null;
      const isLast = attempt === MAX_ATTEMPTS;
      const ms = Date.now() - attemptStartedAt;
      attempts.push({
        attempt,
        code,
        message: error?.message ?? String(error),
        data: error?.data ?? null,
        ms,
      });
      console.warn(
        `[读取游戏库] 第 ${attempt}/${MAX_ATTEMPTS} 次失败 code=${code ?? error?.message} ` +
          `耗时=${ms}ms retryable=${RETRYABLE_CODES.has(code)} ` +
          `message=${error?.message ?? '-'} data=${safeJson(error?.data)}`,
      );
      if (!RETRYABLE_CODES.has(code) || isLast) {
        // 记下握手状态：真机上另一种常见情况不是"网络请求失败"，而是宿主与运行时的桥接
        // 根本没建立 —— 这时任何能力调用都只会自己超时。两者要分开说，否则用户会去找
        // 一个根本不存在的网络请求。
        return demoResult({
          reason: 'error',
          errorCode: code,
          handshakeStatus: hbSDK.getHandshakeState()?.status ?? null,
          attempts,
          elapsedMs: Date.now() - startedAt,
        });
      }
      // 冷启动有两个特征：错误码是 AUTHORIZATION_CONTEXT_CHANGED，或者失败得特别快
      // （几百毫秒内就被拒 = 宿主那边还没准备好，不是网络慢）。两者都不该显示成"重试"。
      const warmup = isWarmupError(code) || ms < FAST_FAILURE_MS;
      onProgress?.({ retrying: true, attempt: attempt + 1, code, warmup });
      // 冷启动的上下文轮换是"还没到时候"，退避要短：它会在几十毫秒内失败，等 800ms 反而让
      // 用户多盯一秒转圈。真正的网络类错误仍走长退避。
      await sleep((warmup ? CONTEXT_RETRY_DELAY_MS : RETRY_DELAY_MS) * attempt);
    }
  }

  // 循环必然在上面返回，这里只是让类型收敛。
  return demoResult({
    reason: 'error',
    errorCode: null,
    handshakeStatus: hbSDK.getHandshakeState()?.status ?? null,
    attempts,
    elapsedMs: Date.now() - startedAt,
  });

  /**
   * 读完整个游戏库的所有分页。
   * 抛错而不是就地降级，交给上面的重试逻辑处理 —— 分页读到一半失败时，
   * 已收集的页来自混合的授权上下文，只能整体重读，不能接着读。
   */
  async function readAllPages(report) {
    const collected = [];
    let offset = 0;
    let pages = 0;
    let truncated = false;
    let total = null;

    while (pages < MAX_PAGES) {
      const result = await api.user.getSteamGameList({
        limit: PAGE_LIMIT,
        offset,
        sort: 'all',
      });

      // 必须先缩窄 isLogin / isBound 再访问 data，这两个状态不是"空的游戏库"。
      if (!result.isLogin) return { kind: 'logged-out' };
      if (!result.isBound) return { kind: 'unbound' };

      const data = result.data;
      pages += 1;
      collected.push(...data.gameList);
      if (typeof data.total === 'number') total = data.total;
      report?.({ pages, games: collected.length, total });

      if (!data.hasMore) break;
      if (pages >= MAX_PAGES) {
        truncated = true;
        break;
      }
      offset = data.nextOffset;
    }

    return { kind: 'ok', games: collected, pages, truncated, total };
  }

  function buildLiveResult(outcome, { attempts = [], elapsedMs = null } = {}) {
    const { games: collected, pages, truncated, total } = outcome;

    // 接口不给标签，用打包的数据集补上。补齐后才做字段普查，这样 tagsUsable 反映的是
    // "算法实际能不能拿到标签"，而不是"接口字段有没有"。
    const enriched = attachMetadata(collected);
  const games = enriched.games;

  const census = censusFields(games);
  const probed = probeUnknownKeys(collected);
  const unknownKeys = [...probed.entries()].map(([key, sample]) => ({
    key,
    sample: typeof sample === 'object' ? JSON.stringify(sample) : String(sample),
  }));

  if (unknownKeys.length > 0) {
    console.info(
      `[字段探针] 真实游戏库条目里出现了 ${unknownKeys.length} 个契约之外的字段，请确认单位后再决定是否接入估算：`,
      unknownKeys,
    );
  } else {
    console.info('[字段探针] 与 SteamGameListItem 契约一致，没有额外字段（通关时间确实拿不到）。');
  }
  console.info(
    `[字段普查] 共 ${census.total} 款；接口字段覆盖：` +
      census.fields.map((f) => `${f.key}=${f.count}`).join('、') +
      (census.missing.length > 0 ? `；接口完全缺失：${census.missing.join('、')}` : ''),
  );
  const stats = metadataStats();
  console.info(
    `[标签数据集] 打包 ${stats.entries} 条（有标签 ${stats.withTags} 条，平均 ${stats.averageTags.toFixed(1)} 个标签）；` +
      `本次 接口提供 ${enriched.fromApi} 款、数据集补上 ${enriched.fromMetadata} 款、仍缺 ${enriched.missing} 款。` +
      `生成于 ${stats.generatedAt ?? '未知'}。`,
  );

  return {
    source: 'live',
    reason: null,
    errorCode: null,
    games,
    pages,
    truncated,
    total,
    unknownKeys,
    census,
    tagSource: {
      fromApi: enriched.fromApi,
      fromMetadata: enriched.fromMetadata,
      missing: enriched.missing,
    },
    metadata: stats,
    // 诊断用：成功路径也保留尝试记录与总耗时，页面才能显示"读了几页、花了多久"。
    attempts,
    elapsedMs,
    };
  }
}

/** 降级成演示数据。集中在一处，保证这条路径永远留痕。 */
function demoResult({ reason, errorCode = null, handshakeStatus = null, attempts = [], elapsedMs = null }) {
  // 降级路径必须留痕：否则真机上只能看到"演示数据"，查不出是被限流、未绑定，
  // 还是桥接没建立。`hb-sdk dev logs` 能直接读到这条。
  console.info(
    `[数据来源] 回退到演示数据：reason=${reason}  errorCode=${errorCode ?? '-'}  ` +
      `handshake=${handshakeStatus ?? '-'}  耗时=${elapsedMs ?? '-'}ms  ` +
      `尝试=${attempts.map((entry) => `${entry.attempt}:${entry.code ?? entry.message}(${entry.ms}ms)`).join('、') || '-'}`,
  );
  return {
    source: 'demo',
    reason,
    errorCode,
    handshakeStatus,
    games: DEMO_LIBRARY,
    pages: 0,
    truncated: false,
    total: DEMO_LIBRARY.length,
    unknownKeys: [],
    // 演示库自带标签，视作标签可用，以便本地能验证完整算法。
    census: { total: DEMO_LIBRARY.length, fields: [], missing: [], coverage: {}, tagsUsable: true },
    tagSource: { fromApi: 0, fromMetadata: 0, missing: 0 },
    metadata: metadataStats(),
    attempts,
    elapsedMs,
  };
}

/** 把错误附加数据转成一行日志文本：`error.data` 可能缺失、可能是对象。 */
function safeJson(value) {
  if (value === undefined || value === null) return '-';
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return '[无法序列化]';
  }
}

/** 常见错误码的直接可行动解释，避免把裸错误码甩给用户。 */
const ERROR_HINTS = {
  INVALID_STATE: '浏览器 Mock 没有 canonical 小程序身份，读不到真实游戏库；真机登录并绑定后才会读到真实数据',
  PERMISSION_NOT_DECLARED: 'package.json#heybox.permissions 里没有声明 steamLibrary，声明后需要重新构建',
  PERMISSION_DENIED: 'steamLibrary 没有获得平台批准',
  METHOD_FORBIDDEN: '当前客户端还没有实现这个能力',
  HEYBOX_APP_LOGIN_REQUIRED: '读取过程中小黑盒登录态失效了',
  AUTHORIZATION_CONTEXT_CHANGED:
    '授权上下文在读取过程中变了（账号切换、重新授权，或开发会话刷新）。已自动重试；如果反复出现，把小程序完全关掉再打开',
  RATE_LIMITED: '被平台限流了，不要立刻重试，等一会儿再来',
  RATE_LIMITED_BY_RUNTIME: '调用太频繁被 Runtime 拦下了，检查一下调用逻辑',
  REQUEST_TIMEOUT: '请求超时了',
  RUNTIME_DESTROYED: '小程序运行环境已经终止',
  SDK_DESTROYED: 'SDK 已经终止',
};

/** 把数据层状态翻译成界面文案。演示数据的原因必须说清楚，不能让人误以为是真实游戏库。 */
export function describeDataSource(result) {
  if (result.source === 'live') {
    const count = result.games.length;
    return {
      tone: 'live',
      label: 'Steam 游戏库扫描成功',
      // 右边显示读到多少款。被分页上限截断时额外说明，因为那会影响推荐范围。
      detail: result.truncated
        ? `已读取 ${count} 款游戏（达到读取上限，可能还有更多）`
        : `已读取 ${count} 款游戏`,
      truncated: result.truncated,
    };
  }

  const reasons = {
    'logged-out': '当前小黑盒账号未登录，读不到真实游戏库',
    unbound: '当前账号还没有绑定 Steam，读不到真实游戏库',
    empty: 'Steam 游戏库是空的，没有可推荐的游戏',
    error: describeError(result.errorCode, result.handshakeStatus),
  };

  return {
    tone: 'demo',
    label: '演示数据',
    detail: `${reasons[result.reason] ?? '真实数据不可用'}。下面全部是内置演示数据，不是你的真实游戏库。`,
    truncated: false,
  };
}

/**
 * 把错误码翻译成可行动的说明。
 *
 * 特别处理"握手没就绪"这一种：此时报 `REQUEST_TIMEOUT` 极具误导性 —— 根本没有网络请求
 * 失败，是运行时的桥接消息没人应答。必须直接说清楚，否则用户会去 Network 面板找一个
 * 不存在的请求。
 */
function describeError(code, handshakeStatus) {
  const bridgeBroken = handshakeStatus && handshakeStatus !== 'ready';
  if (bridgeBroken) {
    const state = handshakeStatus === 'connecting' ? '仍在连接中' : handshakeStatus;
    return (
      `和小黑盒客户端的桥接没有建立（握手状态：${state}），所以任何能力调用都只会超时。` +
      '请在小黑盒 APP 里完全关闭这个小程序再重新打开；如果反复出现，重启 hb-sdk dev 后重新扫码'
    );
  }
  if (!code) return '读取真实游戏库失败';
  const hint = ERROR_HINTS[code];
  return hint ? `${hint}（${code}）` : `读取真实游戏库失败（${code}）`;
}

export { PAGE_LIMIT, MAX_PAGES };

import hbSDK from '@heybox/hb-sdk';
import './styles.css';
import { loadLibrary, describeDataSource } from './library.js';
import {
  recommendNext,
  describeRecommendation,
  AFFINITY_WEIGHT,
  POOL_WEIGHT,
} from './recommend.js';

// Steam 库里的游戏都是 PC 游戏；game_detail 的 gameType 只接受 'pc'|'console'|'mobile'。
const GAME_TYPE = 'pc';

// 卡片上展示几个类型标签。3 个太少（看不出品类层次），6 个以上会换行成两排、显得吵。
const TAG_CHIP_LIMIT = 5;

// 空闲看门狗：多久没有"新数据"就判定卡住。不是整轮加载的总超时，
// 所以大库分页慢不会被误杀。
const IDLE_TIMEOUT_MS = 20000;

// 等 SDK 握手就绪的上限。真机上宿主建立授权上下文通常在数秒内完成；
// 超时后不再干等，直接给出可行动的说明。
const HANDSHAKE_TIMEOUT_MS = 15000;

// 账号上下文"安静窗口"：连续这么久没有再收到 heybox_app_login_change，才认为上下文稳定。
// 真机上冷启动会先派发一次登录状态变化，紧接着的请求会被判为上下文已变化。
const CONTEXT_QUIET_MS = 900;

// 等上下文稳定的硬上限。不设上限时，宿主一直轮换上下文会让页面永远停在加载态。
const CONTEXT_SETTLE_MAX_MS = 6000;

// 账号状态读取的重试次数与退避基数。这一步很便宜（不拉数据），但能提前暴露
// "上下文根本不可用"，避免把 30 秒花在三个 10 秒超时上。
const ACCOUNT_ATTEMPTS = 3;
const ACCOUNT_RETRY_DELAY_MS = 400;
const ACCOUNT_RETRYABLE_CODES = new Set([
  'AUTHORIZATION_CONTEXT_CHANGED',
  'REQUEST_TIMEOUT',
  'RATE_LIMITED_BY_RUNTIME',
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── DOM ────────────────────────────────────────────────────────────────────
const el = (testId) => document.querySelector(`[data-testid="${testId}"]`);

const dom = {
  source: el('data-source'),
  sourceBadge: el('source-badge'),
  sourceDetail: el('source-detail'),
  probe: el('probe-note'),
  loading: el('state-loading'),
  loadingText: el('loading-text'),
  error: el('state-error'),
  errorTitle: el('error-title'),
  errorDetail: el('error-detail'),
  retry: el('retry-button'),
  reload: el('reload-button'),
  result: el('result'),
  cover: el('pick-cover'),
  pickHeadline: el('pick-headline'),
  pickName: el('pick-name'),
  pickTags: el('pick-tags'),
  pickMeta: el('pick-meta'),
  pickReasons: el('pick-reasons'),
  openDetail: el('open-detail-button'),
  scoreBars: el('score-bars'),
  profileHint: el('profile-hint'),
  profileBars: el('profile-bars'),
  scorePanel: el('score-panel'),
  reroll: el('reroll-button'),
  random: el('random-button'),
  diagPanel: el('diag-panel'),
  diagList: el('diag-list'),
  probeButton: el('query-probe-button'),
  probeResults: el('query-probe-results'),
};

// ── 状态 ───────────────────────────────────────────────────────────────────
let libraryResult = null;
let model = null;
let selectedIndex = 0;
let destroyed = false;

/**
 * 诊断信息。
 *
 * 真机上开发者看不到控制台，手机屏幕是唯一能拿到的证据 —— 所以这些值既要打日志
 * （`hb-sdk dev logs` 可读），也要渲染到页面的「诊断信息」里。
 *
 * 四项分别回答四个不同的问题：
 *   env     —— 客户端版本是否达到能力基线（能力缺失时 Host 可能只会超时，不给错误码）
 *   context —— 宿主的账号授权上下文有没有稳定下来（不稳定时任何能力调用都会被判"上下文已变化"）
 *   account —— 当前手机账号有没有登录小黑盒、有没有绑定 Steam（未登录/未绑定不是"空库"）
 *   load    —— 数据层每次请求的耗时与错误码（区分"没权限"和"请求没回来"）
 */
const diagnostics = {
  env: null,
  context: null,
  account: null,
};

// 推荐来源：'ranked' = 按评分排序（换一个），'random' = 纯随机（不用任何口味标签）。
// 「换一个」永远回到 ranked，「纯随机」永远进 random，两者互不干扰彼此的游标。
let pickMode = 'ranked';
let randomItem = null;

const POOL_LABEL = {
  unplayed: '买了没玩',
  backlog: '久未启动',
};

const OPEN_DETAIL_HINTS = {
  REQUEST_UNSUPPORTED: '当前客户端不支持打开游戏详情页（PC 端只支持 game_detail 与 mini_program，移动端支持全部目标）',
  METHOD_FORBIDDEN: '当前客户端没有开放这个跳转',
  METHOD_NOT_FOUND: '当前客户端版本太旧，没有这个跳转能力',
  INVALID_PARAMS: '游戏 ID 不合法，无法跳转',
  REQUEST_TIMEOUT: '跳转请求超时',
  RUNTIME_DESTROYED: '小程序运行环境已经终止',
  SDK_DESTROYED: 'SDK 已经终止',
};

// ── 格式化 ─────────────────────────────────────────────────────────────────
function formatHours(hours) {
  if (!Number.isFinite(hours) || hours <= 0) return '0 小时';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} 分钟`;
  if (hours < 10) return `${hours.toFixed(1)} 小时`;
  return `${Math.round(hours)} 小时`;
}

const percent = (value) => `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;

// 游戏名、标签都来自外部数据，一律走 textContent / createElement，不拼 HTML 字符串。
function createBar(label, ratio, valueText) {
  const li = document.createElement('li');
  const name = document.createElement('span');
  name.className = 'bars__label';
  name.textContent = label;
  name.title = label;

  const track = document.createElement('span');
  track.className = 'bars__track';
  const fill = document.createElement('span');
  fill.className = 'bars__fill';
  fill.style.width = percent(ratio);
  track.append(fill);

  const value = document.createElement('span');
  value.className = 'bars__value';
  value.textContent = valueText;

  li.append(name, track, value);
  return li;
}

function renderList(container, nodes) {
  container.replaceChildren(...nodes);
}

function emptyRow(text) {
  const li = document.createElement('li');
  li.className = 'bars__empty';
  li.textContent = text;
  return li;
}

// ── 渲染 ───────────────────────────────────────────────────────────────────
function showOnly(section) {
  dom.loading.hidden = section !== 'loading';
  dom.error.hidden = section !== 'error';
  dom.result.hidden = section !== 'result';
}

function setLoadingText(text) {
  dom.loadingText.textContent = text;
}

/**
 * 统一的失败/终态渲染。
 * 关键点：**任何**退出加载态的分支都必须走到这里，不能静默 return ——
 * 之前 `if (destroyed) return;` 会让界面永远停在「正在分析你的游戏库」，
 * 而且连重试按钮都渲染不出来。
 */
function showFailure({ title, detail, canRetry = true, canReload = false }) {
  dom.errorTitle.textContent = title;
  dom.errorDetail.textContent = detail;
  dom.retry.hidden = !canRetry;
  dom.retry.disabled = false;
  dom.reload.hidden = !canReload;
  showOnly('error');
}

/**
 * 终点状态：Runtime 已终止。
 * 文档明确「收到 unload 后当前 SDK 上下文不可恢复，未完成请求会失败，不要在同一页面上下文
 * 继续重试能力调用」，所以这里不给"重试"，只给"重新加载页面"。
 */
function showTerminal(detail) {
  destroyed = true;
  showFailure({ title: '运行环境已终止', detail, canRetry: false, canReload: true });
}

/**
 * 空闲看门狗：只在**没有进展**时超时。
 * 876 款要分 10 页请求，只要每页还在回来就一直等；一旦超过 IDLE_TIMEOUT 没有任何新数据
 * （例如 Runtime 被销毁导致 Promise 永不 settle），就抛错让界面离开加载态。
 */
function loadWithWatchdog() {
  return new Promise((resolve, reject) => {
    let timer = null;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => reject(new Error(`已有 ${Math.round(IDLE_TIMEOUT_MS / 1000)} 秒没有收到新数据`)),
        IDLE_TIMEOUT_MS,
      );
    };
    arm();
    loadLibrary({
      onProgress: (progress) => {
        // 重试也要喂看门狗：否则等待重试的这段时间会被当成"卡住"。
        arm();
        if (progress.retrying) {
          // `warmup` = 宿主还在建立账号上下文（冷启动必定发生一次）。它不是故障，
          // 不该显示"第 N 次重试"，否则用户会以为程序在出问题。
          setLoadingText(
            progress.warmup
              ? '正在连接你的小黑盒账号…'
              : `网络有点慢，正在重试（第 ${progress.attempt} 次）…`,
          );
          return;
        }
        const { games, total } = progress;
        setLoadingText(
          `正在读取你的 Steam 游戏库… 已读取 ${games} 款${total ? ` / 共 ${total} 款` : ''}`,
        );
      },
    }).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function renderSource() {
  const info = describeDataSource(libraryResult);
  dom.source.className = `source source--${info.tone}`;
  dom.sourceBadge.textContent = info.label;
  const detail = (info.detail ?? '').trim();
  dom.sourceDetail.textContent = detail;
  // 成功且没有补充说明时整行只留徽标，不留一个空段落占位。
  dom.sourceDetail.hidden = detail === '';
}

function renderProbe() {
  const messages = [];

  const unknown = libraryResult?.unknownKeys ?? [];
  if (unknown.length > 0) {
    messages.push(
      `字段探针：真实数据里出现了契约之外的字段（${unknown
        .map((entry) => entry.key)
        .join('、')}）。确认单位后可以接入时长估算。`,
    );
  }

  const census = libraryResult?.census;
  // 只有"整库都没有标签"这种真正无法工作的降级才提示。
  // 少数几款缺标签属于正常（数据集覆盖不到长尾游戏），不值得占用页面顶部的位置。
  if (libraryResult?.source === 'live' && census && !census.tagsUsable) {
    messages.push(
      '接口和打包数据集都没有这款库的标签，风格画像与时长估算无法工作，当前只能按「买了没玩」排序。',
    );
  }

  // 行为模式：一条风格匹配都没有，排序实际来自候选池与行为信号。
  // 必须明说，否则用户会把一个无依据的顺序当成推荐。
  if (model?.mode === 'behavioral') {
    messages.push(
      '当前没有可用的风格匹配依据，排序由「买了没玩优先 + 累计时长」决定；' +
        '并列项的顺序不代表优劣。',
    );
  }

  if (messages.length === 0) {
    dom.probe.hidden = true;
    return;
  }
  dom.probe.hidden = false;
  dom.probe.textContent = messages.join(' ');
}

// ── 诊断 ───────────────────────────────────────────────────────────────────
/**
 * 环境快照（无需权限）。客户端版本是判断"能力基线不够"的关键：低于基线的 Host
 * 可能连错误码都不给，只会让请求自己超时。
 */
function collectEnvironment() {
  try {
    const info = hbSDK.environment.getInfoSync();
    const env = {
      mode: info?.runtime?.mode ?? 'unknown',
      host: info?.host?.appVersion ?? null,
      os: info?.operatingSystem?.name ?? 'unknown',
      osVersion: info?.operatingSystem?.version ?? null,
      sdk: info?.sdk?.version ?? null,
      miniProgramId: info?.miniProgram?.id ?? null,
    };
    console.info(`[诊断] 运行环境 ${JSON.stringify(env)}`);
    return env;
  } catch (error) {
    const code = error?.code ?? error?.message ?? String(error);
    console.warn(`[诊断] 读不到环境信息 code=${code}`);
    return { error: code };
  }
}

/**
 * 账号状态（需要 userInfo 声明）。
 * 真机上最容易被误判的情况是"这台手机登录的号没有绑 Steam"—— 浏览器调试台用的是
 * CLI 登录态，所以本地永远看不出这个差别。
 */
async function collectAccount() {
  try {
    const result = await hbSDK.user.getInfo();
    const loggedIn = result?.isHeyboxAppLoggedIn === true;
    const steamId = result?.userInfo?.steam_id;
    const account = {
      state: loggedIn ? 'logged-in' : 'logged-out',
      // steam_id 只在"已登录 + 有主绑定 + 平台为当前版本启用 Steam 账号能力"时返回，
      // 所以缺它不能直接断言"没绑 Steam"，页面文案要保留这个不确定性。
      steamBound: loggedIn ? typeof steamId === 'string' && steamId.trim() !== '' : null,
      authorization: result?.authorization ?? null,
    };
    console.info(
      `[诊断] 账号 state=${account.state} steam_id=${account.steamBound ? '有' : '无'} ` +
        `authorization=${JSON.stringify(account.authorization)}`,
    );
    return account;
  } catch (error) {
    const code = error?.code ?? error?.message ?? String(error);
    console.warn(`[诊断] 读取账号状态失败 code=${code}`);
    // 没有声明 userInfo 时这一步必然失败，但读 Steam 库不需要 userInfo ——
    // 不能让"诊断用的权限没申请"看起来像故障。
    const state = code === 'PERMISSION_NOT_IN_SNAPSHOT' || code === 'PERMISSION_DENIED'
      ? 'not-declared'
      : 'unknown';
    return { state, steamBound: null, detail: code };
  }
}

/**
 * 等账号授权上下文稳定下来。
 *
 * 真机实测（小黑盒 1.3.396 / Android）：握手 `ready` 后约 250ms 内就发请求，
 * `user.getInfo()` 和 `user.getSteamGameList()` 会稳定拿到 `AUTHORIZATION_CONTEXT_CHANGED`
 * （"用户请求期间账号上下文已变化"），紧接着的重型请求还会一直挂到 10s 超时。
 * 宿主启动时本来就在建立/轮换账号上下文，所以这里先等一个"安静窗口"：
 * 期间只要还收到 `heybox_app_login_change`，就说明上下文还在变，重新计时。
 */
function waitForAccountContext() {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let quietTimer = null;
    let hardTimer = null;
    let stopWatch = null;
    let settled = false;

    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(quietTimer);
      clearTimeout(hardTimer);
      if (typeof stopWatch === 'function') stopWatch();
      const waitedMs = Date.now() - startedAt;
      console.info(`[上下文] 账号上下文判定 reason=${reason} 等待=${waitedMs}ms`);
      resolve({ reason, waitedMs });
    };

    // 硬上限：上下文一直不安静时也必须继续，否则页面会永远停在加载态。
    hardTimer = setTimeout(() => finish('timeout'), CONTEXT_SETTLE_MAX_MS);

    const armQuiet = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish('quiet'), CONTEXT_QUIET_MS);
    };

    stopWatch = hbSDK.on('heybox_app_login_change', () => {
      console.info('[上下文] 收到 heybox_app_login_change，重置安静窗口');
      armQuiet();
    });

    armQuiet();
  });
}

/**
 * 读账号状态，带退避重试。
 * 上下文刚稳定时读一次也可能撞车，所以先重试再下结论；只有拿到确定状态
 * （已登录 / 未登录）才认为上下文真的可用。
 */
async function collectAccountWithRetry() {
  let last = null;
  for (let attempt = 1; attempt <= ACCOUNT_ATTEMPTS; attempt += 1) {
    const account = await collectAccount();
    if (account.state !== 'unknown') return account;
    last = account;
    const retryable = ACCOUNT_RETRYABLE_CODES.has(account.detail);
    if (!retryable || attempt === ACCOUNT_ATTEMPTS) break;
    const delay = ACCOUNT_RETRY_DELAY_MS * attempt;
    console.info(`[诊断] 账号状态第 ${attempt} 次失败（${account.detail}），${delay}ms 后重试`);
    await sleep(delay);
  }
  return last;
}

function diagRow(label, value) {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  return [dt, dd];
}

// ── 查询变体探针 ───────────────────────────────────────────────────────────
/**
 * `user.getSteamGameList()` 在真机上稳定 10 秒超时，而浏览器 Mock 用同一份构建能读到
 * 876 款。差异要么在查询本身（宿主把 sort 下推给服务端，`all` 可能是重查询），
 * 要么在宿主接口。这里按"从最轻到最重"依次试一遍，用耗时和结果把两者分开。
 *
 * 只在用户点击时执行：每次最坏 10 秒，不能让正常加载承担这个代价。
 */
const QUERY_VARIANTS = [
  { label: '默认查询（weeks / 20）', options: {} },
  { label: 'weeks / 100', options: { limit: 100, offset: 0, sort: 'weeks' } },
  { label: 'all / 20', options: { limit: 20, offset: 0, sort: 'all' } },
  { label: 'all / 100（当前用法）', options: { limit: 100, offset: 0, sort: 'all' } },
];

function renderQueryProbe(rows) {
  if (!dom.probeResults) return;
  dom.probeResults.replaceChildren(
    ...rows.map((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      return li;
    }),
  );
}

async function runQueryProbe() {
  const button = dom.probeButton;
  if (!button) return;
  button.disabled = true;
  const rows = [];
  try {
    for (const variant of QUERY_VARIANTS) {
      rows.push(`${variant.label}：查询中…`);
      renderQueryProbe(rows);
      const startedAt = Date.now();
      let text;
      try {
        const result = await hbSDK.user.getSteamGameList(variant.options);
        const ms = Date.now() - startedAt;
        if (!result.isLogin) {
          text = `${ms} ms · 未登录`;
        } else if (!result.isBound) {
          text = `${ms} ms · 未绑定 Steam`;
        } else {
          const count = result.data?.gameList?.length ?? 0;
          text = `${ms} ms · 成功 ${count} 款（共 ${result.data?.total ?? '?'}）`;
        }
      } catch (error) {
        text = `${Date.now() - startedAt} ms · ${error?.code ?? error?.message ?? String(error)}`;
      }
      console.info(`[查询探针] ${variant.label} → ${text}`);
      rows[rows.length - 1] = `${variant.label}：${text}`;
      renderQueryProbe(rows);
    }
  } finally {
    button.disabled = false;
  }
}

function renderDiagnostics() {
  if (!dom.diagList) return;
  const rows = [];
  const add = (label, value) => rows.push(...diagRow(label, value));

  const env = diagnostics.env;
  if (env && !env.error) {
    add('客户端', `小黑盒 ${env.host ?? '未知版本'} · ${env.os}${env.osVersion ? ` ${env.osVersion}` : ''}`);
    add('运行模式', env.mode);
    add('SDK', env.sdk ?? '未知');
  } else {
    add('客户端', `读不到环境信息（${env?.error ?? '未知'}）`);
  }
  add('握手状态', hbSDK.getHandshakeState()?.status ?? 'unknown');

  const context = diagnostics.context;
  if (context) {
    add(
      '账号上下文',
      context.reason === 'quiet'
        ? `已稳定（等待 ${context.waitedMs} ms）`
        : `等了 ${context.waitedMs} ms 仍不安静（继续尝试）`,
    );
  }

  // 诊断区只在开发运行时出现：正式版对用户只留结论，不留技术细节。
  // 判定用 `runtime.mode`：Browser Mock 与扫码调试都是 `development`，线上是 `production`/`preview`。
  const devMode = Boolean(env) && !env.error && env.mode === 'development';
  if (dom.diagPanel) dom.diagPanel.hidden = !devMode;
  if (dom.probeButton?.parentElement) dom.probeButton.parentElement.hidden = !devMode;
  if (dom.probeResults) dom.probeResults.hidden = !devMode;
  if (!devMode) {
    // 正式版不渲染这张表，省掉一次 DOM 构建。
    dom.diagList?.replaceChildren();
    return;
  }

  const account = diagnostics.account;
  if (!account) {
    add('小黑盒账号', '读取中…');
  } else if (account.state === 'logged-in') {
    add('小黑盒账号', '已登录');
    // steam_id 缺失不能读成"没绑 Steam"：浏览器 Mock 里同一个已绑 Steam 的账号读 876 款
    // 真实数据，也没有返回 steam_id。它只说明平台没为当前版本下发主绑定字段。
    add(
      'Steam 绑定',
      account.steamBound
        ? '返回了 steam_id'
        : '未返回 steam_id（不代表未绑定：浏览器调试台同样如此，该字段取决于平台为当前版本下发）',
    );
  } else if (account.state === 'logged-out') {
    add('小黑盒账号', '未登录 —— 先在小黑盒 APP 里登录，再重新打开小程序');
    add('Steam 绑定', '未知（未登录）');
  } else if (account.state === 'not-declared') {
    add('小黑盒账号', '未申请 userInfo（只影响这行诊断，不影响读 Steam 库）');
  } else {
    add('小黑盒账号', `读取失败（${account.detail}）`);
  }

  if (libraryResult) {
    if (libraryResult.source === 'live') {
      add('Steam 库', `真实数据 · ${libraryResult.games.length} 款 · ${libraryResult.pages} 页`);
    } else {
      add(
        'Steam 库',
        `演示数据 · reason=${libraryResult.reason} · code=${libraryResult.errorCode ?? '-'}`,
      );
    }
    if (Number.isFinite(libraryResult.elapsedMs)) {
      add('读取耗时', `${libraryResult.elapsedMs} ms`);
    }
    (libraryResult.attempts ?? []).forEach((entry) => {
      add(`请求 ${entry.attempt}`, `${entry.ms} ms · ${entry.code ?? entry.message}`);
    });
  } else {
    add('Steam 库', '尚未读取');
  }

  dom.diagList.replaceChildren(...rows);
}

function renderCover(game) {
  dom.cover.replaceChildren();
  const initial = document.createElement('span');
  initial.className = 'pick__initial';
  initial.textContent = (game.name ?? '?').trim().charAt(0) || '?';

  if (typeof game.image === 'string' && game.image.trim()) {
    const img = document.createElement('img');
    img.src = game.image.trim();
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.style.width = '100%';
    img.style.height = '100%';
    img.style.objectFit = 'cover';
    // 外部图片加载失败时退回首字母块，不留白。
    img.addEventListener('error', () => dom.cover.replaceChildren(initial));
    dom.cover.append(img);
    return;
  }
  dom.cover.append(initial);
}

function renderPick() {
  const pickRandom = pickMode === 'random';
  const item = pickRandom ? randomItem : model.ranked[selectedIndex];
  if (!item) return;
  const { game } = item;

  // 随机模式必须换一套说法：这次抽取没有看任何标签，不能沿用"按你的口味挑的"。
  const described = pickRandom
    ? {
        headline: '随机',
        bullets: [
          `从 ${model.ranked.length} 款候选游戏里均匀随机抽出，没有参考口味、标签或评分`,
          item.poolKind === 'unplayed'
            ? '买了之后一次都没启动过'
            : `累计玩过 ${Math.round(item.foreverHours)} 小时，但近两周没碰`,
        ],
      }
    : describeRecommendation(item, model.profile);

  renderCover(game);
  dom.pickHeadline.textContent = described.headline;
  dom.pickName.textContent = game.name;

  // 标签就是"这是什么类型"。Steam 的热门标签本身就按代表性排序，所以直接取前几个，
  // 不再自己筛"哪些算类型" —— 那样只会把「单人」「合作」这类有用信息误删掉。
  const tags = Array.isArray(item.tags) ? item.tags : [];
  renderList(
    dom.pickTags,
    tags.slice(0, TAG_CHIP_LIMIT).map((tag) => {
      const li = document.createElement('li');
      li.textContent = tag;
      return li;
    }),
  );
  dom.pickTags.hidden = tags.length === 0;

  dom.pickMeta.textContent = pickRandom
    ? POOL_LABEL[item.poolKind]
    : `${POOL_LABEL[item.poolKind]} · 候选池加成 ${percent(item.poolBonus)}`;

  renderList(
    dom.pickReasons,
    described.bullets.map((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      return li;
    }),
  );

  // 随机模式下「打分构成」与本次抽取无关，隐藏掉，避免暗示分数决定了结果。
  dom.scorePanel.hidden = pickRandom;

  // 条形图的"值"必须是数字；文字说明放进标签里。
  // 之前把「买了没玩」当成值传进去，条形和数值就对不上了（还会折行）。
  renderList(dom.scoreBars, [
    createBar(`口味契合度（权重 ${AFFINITY_WEIGHT}）`, item.affinity, percent(item.affinity)),
    createBar(
      `候选池加成（${POOL_LABEL[item.poolKind]}，权重 ${POOL_WEIGHT}）`,
      item.poolBonus,
      percent(item.poolBonus),
    ),
    createBar('最终得分', item.score, item.score.toFixed(3)),
  ]);
}

/**
 * 纯随机抽取：在候选池（已排除近两周在玩的游戏）里均匀取一款。
 * 刻意避开当前展示的那款，保证每次点击都有可见变化。
 */
function pickRandomItem() {
  const pool = model?.ranked ?? [];
  if (pool.length === 0) return null;
  if (pool.length === 1) return pool[0];

  const current = randomItem?.game?.appid;
  let candidate = null;
  // 最多试几次就够；池子大于 1 时一定拿得到不同的
  for (let attempt = 0; attempt < 8; attempt += 1) {
    candidate = pool[Math.floor(Math.random() * pool.length)];
    if (candidate.game.appid !== current) return candidate;
  }
  return candidate;
}

function renderProfile() {
  const { profile } = model;
  const basisText =
    profile.basis === 'recent'
      ? `依据最近两周 ${formatHours(profile.totalHours)} 游玩时长，覆盖 ${profile.sourceGames.length} 款游戏`
      : profile.basis === 'lifetime'
        ? `近两周没有游玩记录，画像回退到累计时长（${formatHours(profile.totalHours)}，${profile.sourceGames.length} 款游戏）`
        : '库里没有带标签的游玩记录，无法建立口味画像';

  const confidenceText = {
    high: '画像可信度较高',
    low: '画像可信度偏低（带标签的游玩记录较少）',
    none: '画像可信度：无',
  }[profile.confidence];

  const coverageText = ` · 候选 ${model.coverage.candidates} 款中 ${model.coverage.withTags} 款有标签`;

  dom.profileHint.textContent = `${basisText} · ${confidenceText}${coverageText}`;

  const top = profile.rankedTags.slice(0, 8);
  if (top.length === 0) {
    renderList(dom.profileBars, [emptyRow('没有可用的标签数据。')]);
    return;
  }

  // 条形长度用"最高权重"做满格基准，否则占比都很小、条形看不出差异。
  const max = top[0].weight;
  renderList(
    dom.profileBars,
    top.map((entry) => createBar(entry.tag, entry.weight / max, percent(entry.weight))),
  );
}

function renderResult() {
  renderPick();
  renderProfile();
  dom.reroll.disabled = model.ranked.length < 2;
  dom.random.disabled = model.ranked.length < 1;
  showOnly('result');
}

function setBusy(busy) {
  dom.retry.disabled = busy;
  if (busy) {
    dom.reroll.disabled = true;
    dom.random.disabled = true;
  }
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
// 并发闸：`heybox_app_login_change` 可能在首次加载期间就触发，两个 run 同时跑会互相覆盖
// 状态、把界面刷回加载中，日志里也会出现成对的"第 1/3 次失败"。
let running = false;

// 被并发闸挡下的触发不能直接丢：`heybox_app_login_change` 往往就是"账号上下文刚变好"
// 的信号，丢掉它会让这一轮结果永远建立在旧上下文上。所以改为排队补跑。
// 连续补跑设上限，避免宿主反复派发事件时把请求打成死循环。
let pendingRerun = false;
let rerunStreak = 0;
const MAX_RERUN_STREAK = 3;

// 本轮的结果来源（'live' / 'demo' / null=没走到读库就失败了）。
// 不能用 `libraryResult` 判断：失败路径不会覆盖它，读到的是上一轮的陈旧值。
let lastRunSource = null;

async function run() {
  if (running) {
    pendingRerun = true;
    console.info('[run] 上一次读取还没结束，本轮结束后补跑这次触发');
    return;
  }
  running = true;
  try {
    await runOnce();
  } finally {
    running = false;
    // 所有退出路径（成功、失败、终态）都刷新一次诊断区：
    // 真机上用户只能看到这张表，漏刷新一次就等于没有证据。（正式版这里是空操作）
    renderDiagnostics();
    // 补跑只在上一轮**没拿到真实数据**时才做。
    //
    // 真机冷启动必定先派发一次 `heybox_app_login_change`（账号上下文建立），它正好落在
    // 首轮读取期间。如果这一轮最终成功，数据就是在上下文稳定后取到的，再整页重刷只会让
    // 用户看到"转圈 → 出结果 → 又转圈"。只有失败/降级那轮才值得补跑。
    const shouldRerun = pendingRerun && !destroyed && lastRunSource !== 'live';
    pendingRerun = false;
    if (shouldRerun) {
      rerunStreak += 1;
      if (rerunStreak <= MAX_RERUN_STREAK) {
        console.info(`[run] 上一轮没有拿到真实数据，补跑被忽略的登录变化（第 ${rerunStreak} 次）`);
        void run();
      } else {
        console.warn(`[run] 连续补跑 ${MAX_RERUN_STREAK} 次后停止，避免请求死循环`);
      }
    } else {
      rerunStreak = 0;
    }
  }
}

async function runOnce() {
  if (destroyed) {
    showTerminal('小程序运行环境已终止，需要重新加载页面才能继续。');
    return;
  }

  setBusy(true);
  showOnly('loading');
  setLoadingText('正在连接小黑盒客户端…');
  dom.probe.hidden = true;
  dom.source.className = 'source source--pending';
  dom.sourceBadge.textContent = '读取中';
  dom.sourceDetail.textContent = '正在连接小黑盒客户端…';
  dom.sourceDetail.hidden = false;

  // 先等握手就绪，再碰任何能力。真机上跳过这一步会稳定拿到
  // AUTHORIZATION_CONTEXT_CHANGED（授权上下文还没建立）。
  const handshake = await waitForHandshake();
  if (destroyed) {
    showTerminal('等待客户端连接时小程序运行环境被终止，需要重新加载页面。');
    return;
  }
  if (handshake.status !== 'ready') {
    // 握手没就绪还继续读库只会等到超时，不如直接说清楚。
    setBusy(false);
    showFailure({
      title: handshake.timedOut ? '连接小黑盒客户端超时' : '连接小黑盒客户端失败',
      detail:
        `握手状态：${handshake.status}${handshake.timedOut ? '（等待超时）' : ''}。` +
        '请在小黑盒 APP 里完全关闭这个小程序再重新打开；如果一直这样，重启 hb-sdk dev 后重新扫码。',
      canRetry: true,
      canReload: true,
    });
    return;
  }

  // 握手就绪后再读诊断：环境快照要握手完成后才可用。
  diagnostics.env = collectEnvironment();
  renderDiagnostics();

  // 紧接着先等账号上下文稳定，再读库。
  // 真机上握手 ready ≠ 账号上下文可用：宿主此刻正在建立/轮换授权上下文，
  // 这时候发出去的请求会被判成"账号上下文已变化"。
  setLoadingText('正在连接你的小黑盒账号…');
  dom.sourceDetail.textContent = '正在连接你的小黑盒账号…';
  diagnostics.context = await waitForAccountContext();
  renderDiagnostics();
  if (destroyed) {
    showTerminal('等待账号上下文时小程序运行环境被终止，需要重新加载页面。');
    return;
  }

  // 账号探针是诊断用的，需要 userInfo 权限；正式版不声明它，所以只在开发时跑。
  // 这一步也顺带验证了上下文确实可用（拿不到状态就先别发重型请求）。
  if (diagnostics.env?.mode === 'development') {
    diagnostics.account = await collectAccountWithRetry();
    renderDiagnostics();
    if (destroyed) {
      showTerminal('读取账号状态时小程序运行环境被终止，需要重新加载页面。');
      return;
    }
  }

  // 每轮都重置，避免补跑判断读到上一轮的陈旧来源。
  lastRunSource = null;

  setLoadingText('正在读取你的 Steam 游戏库…');
  dom.sourceDetail.textContent = '正在读取你的 Steam 游戏库…';

  try {
    libraryResult = await loadWithWatchdog();
    lastRunSource = libraryResult.source;
  } catch (error) {
    if (destroyed) {
      showTerminal(
        '读取过程中小程序运行环境被终止（CLI 离线、会话过期或开发服务重启都会触发），需要重新加载页面。',
      );
      return;
    }
    setBusy(false);
    showFailure({
      title: '读取游戏库失败',
      detail: `${error?.message ?? error}。可以点重试；若反复失败，试试重新加载页面。`,
      canRetry: true,
      canReload: true,
    });
    return;
  }

  if (destroyed) {
    showTerminal('读取完成后小程序运行环境已被终止，需要重新加载页面。');
    return;
  }

  try {
    renderSource();
    model = recommendNext(libraryResult.games);
    selectedIndex = 0;
    pickMode = 'ranked';
    randomItem = null;
    // 放在算完之后：提示语需要读 model.mode（风格模式 / 行为模式）。
    renderProbe();

    if (!model.top) {
      setBusy(false);
      showFailure({
        title: '没有可推荐的游戏',
        detail: '这个库里没有可推荐的游戏：要么游戏都正在玩，要么库是空的。',
        canRetry: true,
        canReload: false,
      });
      return;
    }

    renderResult();
    setBusy(false);
  } catch (error) {
    // 渲染出错同样必须离开加载态。
    setBusy(false);
    console.error('渲染推荐时出错', error);
    showFailure({
      title: '渲染推荐时出错',
      detail: `${error?.message ?? error}`,
      canRetry: true,
      canReload: true,
    });
  }
}

// ── 事件 ───────────────────────────────────────────────────────────────────
dom.retry.addEventListener('click', () => {
  void run();
});

// 终点状态的唯一出路：整页重新加载，让 SDK 在新上下文里重新握手。
// 用浏览器原生 reload，不依赖已经失效的 SDK 能力。
dom.reload.addEventListener('click', () => {
  window.location.reload();
});

// 手动探针：只在用户主动点击时跑，用来区分"查询太重"和"宿主接口不响应"。
dom.probeButton?.addEventListener('click', () => {
  void runQueryProbe();
});

dom.reroll.addEventListener('click', () => {
  if (!model || model.ranked.length < 2) return;
  // 「换一个」永远回到评分排序，游标独立于随机模式。
  pickMode = 'ranked';
  selectedIndex = (selectedIndex + 1) % model.ranked.length;
  renderResult();
});

// 纯随机：不使用口味、标签、时长偏好或评分，直接在候选池里均匀抽一款。
dom.random.addEventListener('click', () => {
  if (!model || model.ranked.length === 0) return;
  const picked = pickRandomItem();
  if (!picked) return;
  pickMode = 'random';
  randomItem = picked;
  renderResult();
});

// 深链到小黑盒游戏详情页。那里的「平均游玩时间」是官方数据，但 openAppPage 只负责跳转、
// 返回 void，读不到那个值 —— 所以它只能用来让用户核对我们的估算，不能喂给算法。
//
// 注意：浏览器调试台里点这个按钮**不会真的跳转**，调试台会弹一个「打开页面」模拟对话框，
// 列出它将要发起的路由（protocolType / path / params），并且要等你点「确定」才 resolve。
// 这是 Browser Fake 的实现（见 dist/devtools 里的 openAppPage 桩），不是我们的 bug；
// 真机（手机 / PC 客户端）上由宿主直接路由到游戏详情页，不会出现这个对话框。
// 所以这里不再向界面写任何提示文案 —— 只在失败时留一条 console.warn 供排查。
dom.openDetail.addEventListener('click', async () => {
  const item = pickMode === 'random' ? randomItem : model?.ranked[selectedIndex];
  if (!item) return;
  dom.openDetail.disabled = true;
  try {
    await hbSDK.navigation.openAppPage({
      target: 'game_detail',
      // 必须传小黑盒游戏目录 ID（appid），不是 steamAppid。
      appId: item.game.appid,
      gameType: GAME_TYPE,
      page: 'game',
    });
  } catch (error) {
    const code = error?.code ?? null;
    console.warn(
      `openAppPage(game_detail) 未完成：${code ?? error?.message ?? error}`,
      OPEN_DETAIL_HINTS[code] ?? '',
    );
  } finally {
    dom.openDetail.disabled = false;
  }
});

// ── SDK 生命周期 ───────────────────────────────────────────────────────────
// 握手状态必须用 getHandshakeState()/onHandshakeStateChange() 读取；`ready` 事件是
// 不可重放的边沿通知，不能用它判断当前状态。订阅会立即回放当前值。
const handshakeState = hbSDK.getHandshakeState();
const stopHandshakeState = hbSDK.onHandshakeStateChange((state) => {
  if (destroyed) return;
  if (state.status === 'failed') {
    // 握手失败时能力调用会失败，数据层会回退到演示数据并在来源里标出来。
    console.error('hb-sdk 握手失败', state);
  }
});

// 小黑盒账号切换后游戏库会变，重新拉一次。
const stopLoginChange = hbSDK.on('heybox_app_login_change', () => {
  if (destroyed) return;
  void run();
});

// Runtime 终止后当前上下文不可恢复，能力和重试都不会再成功。
// 必须渲染出明确的终点状态，而不是让界面停在加载中（这曾经是一个真实 bug）。
const stopUnload = hbSDK.on('unload', () => {
  stopHandshakeState();
  stopLoginChange();
  stopUnload();
  showTerminal(
    '小程序运行环境已终止（CLI 离线、会话过期或开发服务重启都会触发）。' +
      '当前页面无法再调用任何能力，需要重新加载页面。',
  );
});

// 跟随系统深浅色同步导航栏。
const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
function syncNavigationBar() {
  hbSDK.viewport
    .setNavigationBarStyle({ foregroundStyle: colorScheme.matches ? 'light' : 'dark' })
    .catch((error) => console.error('无法同步导航栏样式', error));
}

if (typeof colorScheme.addEventListener === 'function') {
  colorScheme.addEventListener('change', syncNavigationBar);
} else if (typeof colorScheme.addListener === 'function') {
  colorScheme.addListener(syncNavigationBar);
}
syncNavigationBar();

console.info('hb-sdk 初始握手状态', handshakeState.status);

/**
 * 等握手进入 ready（或 failed）再调能力。
 *
 * 真机上握手要等宿主建立授权上下文，可能耗时几百毫秒到数秒；而浏览器 Mock 里是毫秒级。
 * 之前页面一加载就直接读库，真机上第一次调用会在握手完成前发出，立刻拿回
 * `AUTHORIZATION_CONTEXT_CHANGED`（实测只隔 94ms）—— 这不是"可重试的错误"，是"还没到时候"。
 * 浏览器 Mock 测不出这个时序，所以本地验证一直是通过的。
 *
 * 超时后仍然返回当前状态，由调用方决定怎么处理，绝不无限等。
 */
function waitForHandshake(timeoutMs = HANDSHAKE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let unsubscribe = null;

    const finish = (state) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (typeof unsubscribe === 'function') unsubscribe();
      const elapsed = Date.now() - startedAt;
      console.info(`[握手] 等待结束 status=${state.status} 用时=${elapsed}ms`);
      resolve(state);
    };

    const timer = setTimeout(() => {
      finish({ ...hbSDK.getHandshakeState(), timedOut: true });
    }, timeoutMs);

    unsubscribe = hbSDK.onHandshakeStateChange((state) => {
      if (state.status === 'ready' || state.status === 'failed') finish(state);
    });

    // 订阅会立即回放当前值；若那一刻就已经是 ready/failed，上面的 finish 已经结算了，
    // 这里补一次退订，避免回调里拿不到 unsubscribe 时留下悬挂订阅。
    if (settled && typeof unsubscribe === 'function') unsubscribe();

    const current = hbSDK.getHandshakeState();
    if (current.status === 'ready' || current.status === 'failed') finish(current);
  });
}

void run();

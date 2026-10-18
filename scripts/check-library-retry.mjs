// 读库重试逻辑的自检（不参与小程序打包）：
//   npm run check:library
//
// 为什么需要它：真机上读库会撞到 AUTHORIZATION_CONTEXT_CHANGED / REQUEST_TIMEOUT，
// 这两个分支在本地浏览器里几乎不可能复现。这里用注入的假 SDK 按剧本失败，验证：
//   - 可恢复错误会重试，并且重试成功后返回真实数据（不再误降级成演示数据）
//   - 不可恢复错误只试一次，立刻降级并保留错误码
//   - 可恢复错误重试用尽后仍然降级，不会无限重试
//   - 未登录 / 未绑定不是错误，不重试

import { loadLibrary } from '../src/library.js';

const failures = [];
const check = (label, condition, extra = '') => {
  if (!condition) failures.push(label);
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`);
};

/** 造一个假的 SDK：按 scripts 依次返回结果或抛错，并记录调用次数。 */
function makeApi(scripts) {
  const calls = [];
  let index = 0;
  return {
    calls,
    user: {
      async getSteamGameList(params) {
        calls.push(params);
        const script = scripts[Math.min(index, scripts.length - 1)];
        index += 1;
        if (typeof script === 'function') return script(params, calls.length);
        if (script instanceof Error) throw script;
        return script;
      },
    },
  };
}

const sdkError = (code) => Object.assign(new Error(code), { code });

const pageOf = (names, { hasMore = false, nextOffset = 0, total = names.length } = {}) => ({
  isLogin: true,
  isBound: true,
  data: {
    gameList: names.map((name, i) => ({
      appid: 1000 + i,
      steamAppid: 1000 + i,
      name,
      image: '',
      icon: '',
      playtime2Weeks: 0,
      playtimeForever: 3600,
      tags: [],
    })),
    hasMore,
    nextOffset,
    total,
  },
});

// ── 1. 可恢复错误 → 重试后成功 ──────────────────────────────────────────────
{
  const api = makeApi([sdkError('AUTHORIZATION_CONTEXT_CHANGED'), pageOf(['A', 'B', 'C'])]);
  const progress = [];
  const result = await loadLibrary({ api, onProgress: (p) => progress.push(p) });
  check('授权上下文变化后重试，最终拿到真实数据', result.source === 'live', `source=${result.source}`);
  check('共调用 2 次（第一次失败 + 第二次成功）', api.calls.length === 2, `calls=${api.calls.length}`);
  check('重试时向界面报告了 retrying', progress.some((p) => p.retrying === true));
  check('最终读到的游戏数是 3', result.games.length === 3, `games=${result.games.length}`);
}

// ── 2. 超时 → 重试后成功 ────────────────────────────────────────────────────
{
  const api = makeApi([sdkError('REQUEST_TIMEOUT'), sdkError('REQUEST_TIMEOUT'), pageOf(['A'])]);
  const result = await loadLibrary({ api });
  check('连续两次超时后第三次成功，仍返回真实数据', result.source === 'live', `source=${result.source}`);
  check('共调用 3 次', api.calls.length === 3, `calls=${api.calls.length}`);
}

// ── 3. 可恢复错误重试用尽 → 降级且保留错误码 ────────────────────────────────
{
  const api = makeApi([sdkError('REQUEST_TIMEOUT')]);
  const result = await loadLibrary({ api });
  check('重试用尽后降级为演示数据', result.source === 'demo', `source=${result.source}`);
  check('降级原因记为 error', result.reason === 'error', `reason=${result.reason}`);
  check('保留错误码 REQUEST_TIMEOUT', result.errorCode === 'REQUEST_TIMEOUT', `code=${result.errorCode}`);
  check('不会无限重试（恰好 3 次）', api.calls.length === 3, `calls=${api.calls.length}`);
}

// ── 4. 不可恢复错误 → 只试一次 ──────────────────────────────────────────────
{
  const api = makeApi([sdkError('PERMISSION_DENIED')]);
  const result = await loadLibrary({ api });
  check('权限被拒立即降级，不重试', api.calls.length === 1, `calls=${api.calls.length}`);
  check('错误码原样透出', result.errorCode === 'PERMISSION_DENIED', `code=${result.errorCode}`);
}

// ── 5. 未绑定 Steam → 不重试 ────────────────────────────────────────────────
{
  const api = makeApi([{ isLogin: true, isBound: false, data: null }]);
  const result = await loadLibrary({ api });
  check('未绑定 Steam 时原因记为 unbound', result.reason === 'unbound', `reason=${result.reason}`);
  check('未绑定不重试', api.calls.length === 1, `calls=${api.calls.length}`);
}

// ── 6. 未登录 → 不重试 ──────────────────────────────────────────────────────
{
  const api = makeApi([{ isLogin: false, isBound: false, data: null }]);
  const result = await loadLibrary({ api });
  check('未登录时原因记为 logged-out', result.reason === 'logged-out', `reason=${result.reason}`);
  check('未登录不重试', api.calls.length === 1, `calls=${api.calls.length}`);
}

// ── 7. 分页失败后必须整体重读，不能接着读 ───────────────────────────────────
{
  let pageCalls = 0;
  const api = {
    calls: [],
    user: {
      async getSteamGameList(params) {
        api.calls.push(params);
        pageCalls += 1;
        // 第一次读：第 1 页成功、第 2 页失败；之后每次都从 offset 0 重新开始并一次读完
        if (pageCalls === 2) throw sdkError('AUTHORIZATION_CONTEXT_CHANGED');
        if (pageCalls <= 2) return pageOf(['A', 'B'], { hasMore: true, nextOffset: 2, total: 3 });
        if (params.offset === 0) return pageOf(['A', 'B'], { hasMore: true, nextOffset: 2, total: 3 });
        return pageOf(['C'], { hasMore: false, total: 3 });
      },
    },
  };
  const result = await loadLibrary({ api });
  const offsets = api.calls.map((c) => c.offset);
  check('分页中途失败后会从 offset 0 整体重读', offsets.includes(0) && offsets.filter((o) => o === 0).length === 2, `offsets=${offsets.join(',')}`);
  check('重读后拿到完整 3 款（没有重复也没有缺失）', result.games.length === 3, `games=${result.games.length}`);
}

console.log(`\n${failures.length === 0 ? '全部通过' : `失败 ${failures.length} 项：\n - ${failures.join('\n - ')}`}`);
process.exitCode = failures.length === 0 ? 0 : 1;

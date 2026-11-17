#!/usr/bin/env node
'use strict';

/**
 * 端到端回归测试：用真浏览器（CDP）跑通 dev-switch 的完整链路
 *   登录 → 拉租户 → 切租户 → 非法租户 → 密码错误 → 锁定熔断
 *
 * 什么都不用准备，直接跑：
 *   node .e2e/e2e.js
 *
 * 它会自己在 8082 起一个「假 tsie 后端」（复刻 HTTP 200 + retCode、
 * Cookie 下发 JWT、切租户失败也回 T200 这几个坑），并在 4600 起一份
 * 使用独立 data/state.json 的面板副本，绝不会碰你真实的配置和账号。
 *
 * 依赖 Node 22 内置 WebSocket，零外部依赖。
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RUN_DIR = path.join(__dirname, 'run');
const MOCK_PORT = 9082;
const PANEL_PORT = 4600;
const PANEL = `http://127.0.0.1:${PANEL_PORT}`;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 递归复制目录。
 *
 * 为什么不用 fs.cpSync：Node 22.22.2 上，只要路径里带中文（比如项目放在
 * 「E:\学习项目\dev-switch」），cpSync 会让整个进程直接崩掉 ——
 * 退出码 0xC0000409（STATUS_STACK_BUFFER_OVERRUN），没有任何 JS 异常、
 * 没有任何输出，表现就是「脚本一声不响地退出了」。
 * 踩过一次就很难查，所以这里自己走 readdir + copyFile，行为可控。
 */
function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDirSync(s, d);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

/** 在 .e2e/run 里搭一份隔离的运行目录（独立配置文件，互不影响） */
function prepareRunDir() {
  fs.rmSync(RUN_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(RUN_DIR, 'data'), { recursive: true });
  copyDirSync(path.join(ROOT, 'public'), path.join(RUN_DIR, 'public'));
  fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(RUN_DIR, 'server.js'));

  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'state.json'), 'utf8'));
  const cfg = {
    ...base,
    target: `http://127.0.0.1:${MOCK_PORT}`,
    requestTimeoutMs: 15000,
    accounts: [{ id: 'acc_e2e', name: '端到端', username: 'e2e', password: 'pass1234', note: '' }],
    tenants: [], combos: [], activeComboId: null,
  };
  fs.writeFileSync(path.join(RUN_DIR, 'data', 'state.json'), JSON.stringify(cfg, null, 2), 'utf8');
}

async function cdpTargets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(3000) });
  return r.json();
}

function rpc(ws) {
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    } else if (m.method) {
      events.push(m);
    }
  });
  return {
    events,
    send(method, params = {}) {
      const mid = ++id;
      ws.send(JSON.stringify({ id: mid, method, params }));
      return new Promise((res, rej) => {
        pending.set(mid, { res, rej });
        setTimeout(() => {
          if (pending.has(mid)) { pending.delete(mid); rej(new Error('CDP 超时: ' + method)); }
        }, 20000);
      });
    },
  };
}

(async () => {
  prepareRunDir();

  const procs = [];
  const start = (args, cwd, env) => {
    const p = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: 'ignore' });
    procs.push(p);
    return p;
  };
  start([path.join(__dirname, 'tsie-mock.js')], ROOT, { MOCK_PORT: String(MOCK_PORT) });
  start(['server.js'], RUN_DIR, { PORT: String(PANEL_PORT) });
  await sleep(900);

  const userDir = path.join(os.tmpdir(), 'ds-e2e-' + Date.now());
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,960',
    PANEL,
  ], { stdio: 'ignore' });
  procs.push(chrome);

  let fail = 0;
  const check = (name, cond, extra = '') => {
    console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  → ' + extra : ''}`);
    if (!cond) fail++;
  };

  try {
    let target = null;
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      try {
        const list = await cdpTargets();
        target = list.find((t) => t.type === 'page' && t.url.includes(String(PANEL_PORT)));
        if (target) break;
      } catch { /* 还没起来 */ }
    }
    if (!target) throw new Error('找不到面板标签页');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('WS 连接失败')));
    });
    const c = rpc(ws);
    await c.send('Runtime.enable');
    await c.send('Page.enable');
    await sleep(1200);

    const evalJs = async (expr) => {
      const r = await c.send('Runtime.evaluate', {
        expression: expr, awaitPromise: true, returnByValue: true,
      });
      if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.text || r.exceptionDetails));
      return r.result.value;
    };

    /* ---------- 1. 面板与后端都在线 ---------- */
    check('面板已加载', await evalJs('document.title.includes("DevSwitch")'));
    const pingText = await evalJs('(document.querySelector("#pingState")||{}).textContent||""');
    check('探测文案显示在线', /在线/.test(pingText), pingText.trim());

    /* ---------- 2. 登录（直接调真实 doLogin） ---------- */
    const loginRes = await evalJs(`(async () => {
      try {
        const r = await doLogin({ id:'acc_e2e', username:'e2e', password:'pass1234' });
        return { err:null, skipped:!!r.skipped, token:session.token,
                 cookies:session.cookies.slice(), accountId:session.accountId };
      } catch (e) { return { err: e.message }; }
    })()`);
    check('登录未报错', !loginRes.err, loginRes.err || '');
    check('登录未被跳过', loginRes.skipped === false);
    check('从 Cookie 里取到了 JWT',
      typeof loginRes.token === 'string' && loginRes.token.split('.').length === 3,
      (loginRes.token || '').slice(0, 22) + '…');
    check('会话里保存了 Authorization Cookie',
      (loginRes.cookies || []).some((x) => String(x).startsWith('Authorization=')),
      (loginRes.cookies || []).join(' | ').slice(0, 60));

    /* ---------- 3. 拉租户列表 ---------- */
    await evalJs('pullTenants()');
    await sleep(700);
    const tenants = await evalJs('state.tenants');
    check('租户列表拿到 7 个', (tenants || []).length === 7,
      JSON.stringify((tenants || []).map((t) => t.name)));
    check('租户 ID 字段解析正确',
      (tenants || []).every((t) => typeof t.id === 'string' && t.id.startsWith('T_')),
      JSON.stringify((tenants || []).map((t) => t.id)));

    /* ---------- 3b. 租户筛选 ---------- */
    const filt = await evalJs(`(async () => {
      const q = (kw) => {
        document.querySelector('#tenantFilter').value = kw;
        renderTenants();
        return {
          rows: document.querySelectorAll('#tenantList [data-ten]').length,
          count: (document.querySelector('#tenantCount').textContent || '').trim(),
          titles: Array.from(document.querySelectorAll('#tenantList .row-title')).map((e) => e.textContent.trim()),
        };
      };
      const base = q('');
      const byName = q('阿尔法');          // 命中 2 个（阿尔法科技 / 阿尔法新能源分公司）
      const byId = q('T_BETA');            // 按 ID 命中 1 个
      const byCode = q('gamma');           // 小写也能命中
      const twoWords = q('阿尔法 分公司');  // 多关键词取交集 → 1 个
      const none = q('不存在的租户xyz');
      // 无匹配时的提示文案必须在这一刻抓，否则后面的 q('') 已经把列表恢复了
      const noneText = (document.querySelector('#tenantList').textContent || '').trim();
      const empty = q('');
      return { base, byName, byId, byCode, twoWords, none, noneText, empty };
    })()`);
    check('未筛选时显示全部 7 个', filt.base.rows === 7, filt.base.count);
    check('按名称筛选命中 2 个', filt.byName.rows === 2, JSON.stringify(filt.byName.titles));
    check('按 ID 筛选命中 1 个', filt.byId.rows === 1, filt.byId.count);
    check('筛选区分大小写不敏感', filt.byCode.rows === 1, JSON.stringify(filt.byCode.titles));
    check('多关键词取交集', filt.twoWords.rows === 1, JSON.stringify(filt.twoWords.titles));
    check('无匹配时计数显示 0', /^0\s*\/\s*7$/.test(filt.none.count), filt.none.count);
    check('无匹配时列表显示提示而非空白', filt.none.rows === 0 && /没有匹配/.test(filt.noneText), filt.noneText.slice(0, 40));
    check('清空关键词恢复全部', filt.empty.rows === 7, filt.empty.count);

    /* ---------- 3c. 输入框焦点不丢（渲染不能重建输入框） ---------- */
    const focusOk = await evalJs(`(async () => {
      const el = document.querySelector('#tenantFilter');
      el.focus();
      el.value = '阿尔';
      el.setSelectionRange(1, 1);
      renderTenants();               // 模拟 input 事件触发的重绘
      const stillFocused = document.activeElement === el;
      const caret = el.selectionStart;
      el.value = ''; renderTenants();
      return { stillFocused, caret };
    })()`);
    check('筛选时输入框保持焦点', focusOk.stillFocused === true);
    check('筛选时光标位置不跳', focusOk.caret === 1, String(focusOk.caret));

    /* ---------- 3c2. 同一帧内连打多个键只重绘一次（rAF 合并） ---------- */
    const coalesce = await evalJs(`(async () => {
      const el = document.querySelector('#tenantFilter');
      const box = document.querySelector('#tenantList');
      el.value = ''; renderTenants();
      let redraws = 0;
      const mo = new MutationObserver(() => { redraws++; });
      mo.observe(box, { childList: true });
      // 模拟连打 4 个字符，全部落在同一帧内
      for (const kw of ['阿', '阿尔', '阿尔法', '阿尔法科']) {
        el.value = kw;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const immediate = redraws;                       // rAF 还没跑，应该 0 次
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const settled = redraws;                         // 合并后只应有 1 次
      mo.disconnect();
      const rows = box.querySelectorAll('[data-ten]').length;
      el.value = ''; renderTenants();
      return { immediate, settled, rows };
    })()`);
    check('连打多键不逐次重绘', coalesce.immediate === 0, '同步期内重绘 ' + coalesce.immediate + ' 次');
    check('同一帧合并为一次重绘', coalesce.settled === 1, coalesce.settled + ' 次');
    check('合并后筛选结果正确', coalesce.rows === 1, coalesce.rows + ' 行');

    /* ---------- 3d. 列表高度受控（不再无限拉长页面） ---------- */
    const scrollOk = await evalJs(`(async () => {
      const box = document.querySelector('#tenantList');
      const cs = getComputedStyle(box);
      return {
        maxH: cs.maxHeight,
        overflowY: cs.overflowY,
        scrollable: box.scrollHeight > box.clientHeight,
        boxH: box.clientHeight,
        contentH: box.scrollHeight,
      };
    })()`);
    check('列表高度被限制', scrollOk.maxH !== 'none' && parseFloat(scrollOk.maxH) > 0, scrollOk.maxH);
    check('列表内部可滚动', scrollOk.overflowY === 'auto', scrollOk.overflowY);

    /* ---------- 3e. 底部渐隐：没到底才提示「下面还有」 ---------- */
    const fade = await evalJs(`(async () => {
      const box = document.querySelector('#tenantList');
      const wrap = box.closest('.list-scroll-wrap');
      // 造一个足够长的列表，确保能滚
      const saved = state.tenants.slice();
      state.tenants = Array.from({ length: 40 }, (_, i) => ({
        id: 'T_LONG_' + i, name: '超长列表租户 ' + i, code: '',
      }));
      document.querySelector('#tenantFilter').value = '';
      renderTenants();
      await new Promise((r) => requestAnimationFrame(r));
      box.scrollTop = 0;
      syncScrollFade(box);
      const atTop = !wrap.classList.contains('at-bottom');
      box.scrollTop = box.scrollHeight;      // 滚到底
      syncScrollFade(box);
      const atBottom = wrap.classList.contains('at-bottom');
      // 恢复
      state.tenants = saved;
      renderTenants();
      return { atTop, atBottom };
    })()`);
    check('列表顶部时显示渐隐提示', fade.atTop === true);
    check('滚到底后渐隐消失', fade.atBottom === true);

    /* ---------- 4. 切租户（正常） ---------- */
    const sw = await evalJs(`(async () => {
      try {
        await doSwitchTenant({ id:'T_ALPHA', name:'阿尔法科技' });
        return { err:null, tenantId: session.tenantId };
      } catch (e) { return { err:e.message, tenantId: session.tenantId }; }
    })()`);
    check('切到 T_ALPHA 成功', !sw.err && sw.tenantId === 'T_ALPHA', sw.err || String(sw.tenantId));

    /* ---------- 5. 关键：切租户失败但 HTTP 200 + retCode T200 ---------- */
    const bad = await evalJs(`(async () => {
      try {
        await doSwitchTenant({ id:'T_NOT_EXIST', name:'不存在' });
        return { threw:false, tenantId: session.tenantId };
      } catch (e) { return { threw:true, msg:e.message, tenantId: session.tenantId }; }
    })()`);
    check('失败被识别出来（没被 T200 骗过去）', bad.threw === true, bad.msg || '');
    check('失败文案带上了服务端原因', /无权限|租户/.test(bad.msg || ''), bad.msg || '');
    check('失败后当前租户没被污染', bad.tenantId === 'T_ALPHA', String(bad.tenantId));

    /* ---------- 6. 未登录时的 T302 识别（HTTP 200 陷阱） ---------- */
    const anon = await evalJs(`(async () => {
      const keep = session.cookies.slice();
      session.cookies = []; session.token = '';
      const res = await proxy('GET', '/pds-std/api/pf/tenant/all', { headers:{} });
      session.cookies = keep;
      return { httpOk: res.ok, status: res.status, retCode: res.json && res.json.retCode,
               bizOk: isBizOk(res, state.tenantList), detail: bizError(res, 'HTTP '+res.status) };
    })()`);
    check('T302 时 HTTP 确实是 200（正是那个坑）',
      anon.httpOk === true && anon.status === 200, 'status=' + anon.status);
    check('isBizOk 正确判定为失败', anon.bizOk === false);
    check('retCode 是 T302', anon.retCode === 'T302', String(anon.retCode));
    check('错误文案可读', /请先登录/.test(anon.detail || ''), anon.detail || '');

    /* ---------- 7. 密码错误：T401 必须被识别 + 记下剩余次数 ---------- */
    const wrong = await evalJs(`(async () => {
      lockGuard.clear('e2e');
      try {
        await doLogin({ id:'acc_e2e', username:'e2e', password:'WRONG_PWD' });
        return { threw:false };
      } catch (e) {
        return {
          threw:true, msg:e.message,
          remaining: lockGuard.remaining['e2e'],
          barVisible: !document.querySelector('#lockGuard').hidden,
          barText: (document.querySelector('#lockGuard').textContent||'').replace(/\\s+/g,' ').trim(),
        };
      }
    })()`);
    check('错误密码被拦下（T401 没被当成功）', wrong.threw === true);
    check('报错里带服务端原文', /密码|输入错误/.test(wrong.msg || ''), (wrong.msg || '').slice(0, 60));
    check('报错里带剩余次数警告', /还剩\s*2\s*次/.test(wrong.msg || ''), (wrong.msg || '').slice(-40));
    check('熔断器记下了剩余 2 次', wrong.remaining === 2, String(wrong.remaining));
    check('页面出现警戒条', wrong.barVisible === true, wrong.barText.slice(0, 70));

    /* ---------- 8. 锁定熔断器逻辑 ---------- */
    const lk = await evalJs(`(async () => {
      lockGuard.clear('e2e');
      const p2 = lockGuard.parse('账户名或者密码输入错误，再尝试错误 2 次用户将被锁定!');
      lockGuard.record('e2e', '账户名或者密码输入错误，再尝试错误 2 次用户将被锁定!');
      const blocked0 = lockGuard.check('e2e');
      lockGuard.record('e2e', '账户名或者密码输入错误，再尝试错误 0 次用户将被锁定!');
      const blocked1 = lockGuard.check('e2e');
      lockGuard.clear('e2e');
      return { p2, blocked0, blocked1, after: lockGuard.check('e2e') };
    })()`);
    check('剩余次数解析正确', lk.p2 === 2, String(lk.p2));
    check('剩 2 次时放行', lk.blocked0 === null);
    check('剩 0 次时硬拦截', typeof lk.blocked1 === 'string' && lk.blocked1.includes('已被后端拒绝登录'), (lk.blocked1 || '').slice(0, 40));
    check('清除后恢复正常', lk.after === null);

    /* ---------- 8b. 锁定态：T401「请联系项目组成员」 ---------- */
    // 真实后端遇到 LockedException 时，retMsg 只有一句「请联系项目组成员」，
    // 真实原因在 data 字段。这组断言保证面板能把原因翻译出来并熔断。
    const locked = await evalJs(`(async () => {
      lockGuard.clear('locked');
      let threw = false, msg = '';
      try {
        await doLogin({ id: 'acc_locked', name: '锁定账号', username: 'locked', password: 'x' });
      } catch (e) { threw = true; msg = e.message; }
      return {
        threw, msg,
        remaining: lockGuard.remaining['locked'],
        reason: lockGuard.reason['locked'] || '',
        blocked: lockGuard.check('locked'),
        barVisible: !document.querySelector('#lockGuard').hidden,
        barText: (document.querySelector('#lockGuard').textContent||'').replace(/\\s+/g,' ').trim(),
      };
    })()`);
    check('锁定账号登录被拦下', locked.threw === true);
    check('把 data 里的异常名透出来了', /LockedException/.test(locked.msg || ''), (locked.msg || '').slice(0, 90));
    check('翻译成人话：账号已被锁定', /锁定/.test(locked.reason), locked.reason);
    check('熔断器记为 0 次', locked.remaining === 0, String(locked.remaining));
    check('锁定态直接熔断后续登录', typeof locked.blocked === 'string' && locked.blocked.includes('已被后端拒绝登录'), (locked.blocked || '').slice(0, 40));
    check('锁定态警戒条出现', locked.barVisible === true, locked.barText.slice(0, 70));
    check('警戒条不再说「还剩 0 次」', !/还剩\s*0\s*次/.test(locked.barText), locked.barText.slice(0, 70));

    /* ---------- 8c. 警告态不能被误判成锁定态 ---------- */
    const notLocked = await evalJs(`(async () => {
      const warn = '账户名或者密码输入错误，再尝试错误 3 次用户将被锁定!';
      return {
        isLocked: lockGuard.isLockedMessage(warn),
        badCred: lockGuard.isLockedMessage('账户名或者密码输入错误!'),
        reallyLocked: lockGuard.isLockedMessage('请联系项目组成员'),
      };
    })()`);
    check('带剩余次数的提示不算锁定', notLocked.isLocked === false);
    check('单纯密码错误不算锁定', notLocked.badCred === false);
    check('笼统文案能识别为锁定态', notLocked.reallyLocked === true);

    /* ---------- 8d. 组合弹窗里的租户可搜索选择 ---------- */
    const combo = await evalJs(`(async () => {
      const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const pick = async (kw) => {
        const inp = document.querySelector('.ss[data-ss="tenantId"] .ss-input');
        const list = document.querySelector('.ss[data-ss="tenantId"] .ss-list');
        inp.focus();
        inp.value = kw;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        await tick();
        return {
          rows: Array.from(list.querySelectorAll('.ss-opt')).map((e) => e.querySelector('.ss-opt-label').textContent.trim()),
          emptyText: (list.querySelector('.ss-empty') || {}).textContent || '',
          moreText: (list.querySelector('.ss-more') || {}).textContent || '',
          hidden: list.hidden,
        };
      };
      const hiddenVal = () => document.querySelector('.ss[data-ss="tenantId"] input[type="hidden"]').value;
      const shownVal = () => document.querySelector('.ss[data-ss="tenantId"] .ss-input').value;

      openComboForm(null);
      await tick();
      const initial = { hidden: hiddenVal(), shown: shownVal(),
                        isSearch: !!document.querySelector('.ss[data-ss="tenantId"]'),
                        wide: document.querySelector('#formModal').classList.contains('modal-wide') };

      const byName = await pick('阿尔法');
      const byId = await pick('T_BETA');
      const multi = await pick('阿尔法 分公司');
      const none = await pick('不存在的租户zzz');

      // 点选「阿尔法新能源分公司」→ 隐藏域要真的写进去
      const list = document.querySelector('.ss[data-ss="tenantId"] .ss-list');
      const inp = document.querySelector('.ss[data-ss="tenantId"] .ss-input');
      inp.focus();
      inp.value = '阿尔法'; inp.dispatchEvent(new Event('input', { bubbles: true }));
      await tick();
      const target = Array.from(list.querySelectorAll('.ss-opt'))
        .find((e) => e.textContent.includes('阿尔法新能源分公司'));
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await tick();
      const afterClick = { hidden: hiddenVal(), shown: shownVal(), listHidden: list.hidden };

      // 键盘：↑↓ 高亮 + Enter 选中
      inp.focus();
      inp.value = '贝塔'; inp.dispatchEvent(new Event('input', { bubbles: true }));
      await tick();
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await tick();
      const afterKey = { hidden: hiddenVal(), shown: shownVal() };

      // Esc 只收下拉，不该把整个弹窗关掉
      inp.focus();
      inp.value = '伽马'; inp.dispatchEvent(new Event('input', { bubbles: true }));
      await tick();
      const openBeforeEsc = !list.hidden;
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await tick();
      const modalStillOpen = !document.querySelector('#formModal').hidden;

      // 未选就失焦 → 显示应还原成上次选中的值，不能留下半截搜索词
      inp.focus();
      inp.value = '随便乱打';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('blur', { bubbles: true }));
      await tick();
      const afterBlur = { shown: shownVal(), hidden: hiddenVal() };

      closeForm();
      return { initial, byName, byId, multi, none, afterClick, afterKey,
               openBeforeEsc, modalStillOpen, afterBlur };
    })()`);
    check('组合弹窗的租户已换成可搜索控件', combo.initial.isSearch === true);
    check('弹窗自动加宽以容纳长租户名', combo.initial.wide === true);
    check('控件初始显示「不指定租户」', /不指定租户/.test(combo.initial.shown || ''), combo.initial.shown);
    check('搜索按名称命中', combo.byName.rows.length === 2, JSON.stringify(combo.byName.rows));
    check('搜索按租户 ID 命中', combo.byId.rows.length === 1, JSON.stringify(combo.byId.rows));
    check('搜索支持多关键词交集', combo.multi.rows.length === 1, JSON.stringify(combo.multi.rows));
    check('无匹配时显示提示而非空白', combo.none.rows.length === 0 && /没有匹配/.test(combo.none.emptyText),
      combo.none.emptyText.slice(0, 40));
    check('点选后写入真实 tenantId', combo.afterClick.hidden === 'T_ALPHA2', combo.afterClick.hidden);
    check('点选后回填显示名并收起列表',
      combo.afterClick.shown === '阿尔法新能源分公司' && combo.afterClick.listHidden === true,
      combo.afterClick.shown);
    check('键盘 ↓ + Enter 也能选中', combo.afterKey.hidden === 'T_BETA', combo.afterKey.hidden + ' / ' + combo.afterKey.shown);
    check('Esc 只收下拉不关弹窗',
      combo.openBeforeEsc === true && combo.modalStillOpen === true);
    check('放弃选择时显示还原为已选值',
      combo.afterBlur.shown === '贝塔新能源有限公司' && combo.afterBlur.hidden === 'T_BETA',
      combo.afterBlur.shown);

    /* ---------- 8e. 下拉里 ID 的显示长度 ---------- */
    // 真实租户 ID 是 32 位哈希、前面二十来位全都一样，整串摆出来既占宽度又没法区分。
    // mock 里的 T_ALPHA/T_BETA 太短，测不到这条规则，所以临时造一个同形容器探一下。
    const idShow = await evalJs(`(async () => {
      const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const probe = async (opts) => {
        const host = document.createElement('div');
        host.className = 'ss';
        host.innerHTML = '<input class="ss-input" type="text">'
          + '<input type="hidden" data-f="__probe" value="">'
          + '<div class="ss-list" hidden></div>';
        document.body.appendChild(host);
        bindSearchSelect(host, { key: '__probe', options: opts });
        const inp = host.querySelector('.ss-input');
        inp.focus();
        inp.value = '';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        await tick();
        const subs = Array.from(host.querySelectorAll('.ss-opt-sub')).map((e) => e.textContent.trim());
        const labels = Array.from(host.querySelectorAll('.ss-opt-label')).map((e) => e.textContent.trim());
        host.remove();
        return { subs, labels };
      };
      const longIds = await probe([
        { value: '4028e52e979c62cc01979c8775520002', label: '南疆分公司' },
        { value: '4028e52e979c62cc01979c8776b00006', label: '清能分公司' },
      ]);
      const shortIds = await probe([
        { value: 'T_ALPHA', label: '阿尔法科技' },
        { value: 'T_BETA', label: '贝塔新能源有限公司' },
      ]);
      return { longIds, shortIds };
    })()`);
    check('长哈希 ID 只显示尾 8 位', idShow.longIds.subs[0] === '…75520002',
      JSON.stringify(idShow.longIds.subs));
    check('尾 8 位足够区分不同租户', idShow.longIds.subs[0] !== idShow.longIds.subs[1],
      JSON.stringify(idShow.longIds.subs));
    check('短 ID 原样显示不硬加省略号', idShow.shortIds.subs.join(',') === 'T_ALPHA,T_BETA',
      JSON.stringify(idShow.shortIds.subs));

    /* ---------- 8f. 把会话写进浏览器 Cookie 罐 ---------- */
    // 这件事只能由服务端做：后端下发的是 HttpOnly Cookie，JS 的 document.cookie
    // 既设不出 HttpOnly 也读不回来。所以真正的断言点在服务端 —— 用 CDP 直接看
    // 浏览器的罐（Network.getAllCookies），那是唯一可信的证据。
    await c.send('Network.enable');
    const beforeJar = (await c.send('Network.getAllCookies')).cookies
      .filter((k) => k.domain.includes('127.0.0.1')).map((k) => k.name);
    check('写入前浏览器罐里没有会话 Cookie',
      !beforeJar.includes('Authorization'), JSON.stringify(beforeJar));

    const wrote = await evalJs(`(async () => {
      // 用真实登录拿到的会话即可（此刻已在组合流程里登录过）
      if (!session.cookies.length) return { skipped: true };
      // 前面的用例都是直接调 doLogin()，绕过了界面 —— 界面还停在初始的「未登录」空壳上，
      // 按钮自然不存在。这正是真实用户点账号登录时 renderAll() 会做的事，这里补上。
      renderAll();

      const hasWriteBtn = !!document.querySelector('#writeBrowserCookieBtn');
      // 先直接打一次 POST，把服务端原始回包留下来 —— 分清到底是
      // 「服务端没下发 Set-Cookie」还是「浏览器拒收」，两者的修法完全不同。
      const raw = await fetch('/api/browser-cookie', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookies: session.cookies }),
      });
      const rawBody = await raw.json();
      if (hasWriteBtn) document.querySelector('#writeBrowserCookieBtn').click();
      await new Promise((r) => setTimeout(r, 700));
      const r = await fetch('/api/browser-cookie');
      const j = await r.json();
      return {
        skipped: false,
        postBody: rawBody,
        cookieSample: session.cookies.map((s) => String(s).split('=')[0]),
        jarNames: j.names,
        jsReadable: document.cookie,
        stateText: document.querySelector('.bc-state')?.textContent.trim() || '',
        // 诊断用：页面内存里的状态到底长什么样，跟服务端回读对不对得上
        mem: {
          jar: browserCookie.jar.map((c) => c.name),
          written: browserCookie.written,
          sessionCookies: session.cookies.map((s) => String(s).split('=')[0]),
        },
        hasClearBtn: !!document.querySelector('#clearBrowserCookieBtn'),
        hasWriteBtn,
      };
    })()`);
    check('会话卡片上有「写入浏览器」按钮', wrote.hasWriteBtn === true,
      'hasWriteBtn=' + wrote.hasWriteBtn);
    check('服务端接收了 Cookie 并回报写了哪些',
      (wrote.postBody?.written || []).length > 0,
      JSON.stringify(wrote.postBody) + ' cookies=' + JSON.stringify(wrote.cookieSample));
    check('写入后服务端确认收到 Cookie',
      (wrote.jarNames || []).includes('Authorization'), JSON.stringify(wrote.jarNames));

    const afterJar = (await c.send('Network.getAllCookies')).cookies
      .filter((k) => k.domain.includes('127.0.0.1'));
    const authCookie = afterJar.find((k) => k.name === 'Authorization');
    check('浏览器罐里真的出现了 Authorization', !!authCookie, JSON.stringify(afterJar.map((k) => k.name)));
    check('写进去的是 HttpOnly（复刻了后端属性）', authCookie?.httpOnly === true,
      String(authCookie?.httpOnly));
    check('JS 读不到 HttpOnly 的项（符合预期，不是失败）',
      !String(wrote.jsReadable || '').includes('Authorization'), String(wrote.jsReadable || ''));
    check('界面显示已写入', /会话 Cookie/.test(wrote.stateText),
      wrote.stateText + ' | ' + JSON.stringify(wrote.mem));

    // Cookie 不区分端口 —— 这是「localhost 直连业务页面即登录态」的基础。
    // 这里不去真发跨源请求：mock 后端没回 CORS 头，带 credentials 的跨源 fetch
    // 会因为读不到响应而抛 TypeError，那是 CORS 的锅、不是 Cookie 没带上，容易误判。
    // 改成问浏览器自己：「发往这个地址时你会带哪些 Cookie」—— 这是 Chrome 按
    // 匹配规则算出来的答案（Cookie 的键是 name+domain+path，压根没有 port 这一维）。
    const forBackend = (await c.send('Network.getCookies', {
      urls: [`http://127.0.0.1:${MOCK_PORT}/pds-std/api/pf/tenant/all`],
    })).cookies.map((k) => k.name);
    check('同主机不同端口：浏览器会把 Cookie 带给后端',
      forBackend.includes('Authorization'), JSON.stringify(forBackend));

    /* ---------- 8g. Cookie 桥：一个动作同时覆盖 localhost 与 127.0.0.1 ---------- */
    // 实测痛点：面板开在 127.0.0.1 上写入后，直接在 localhost 打开业务页面仍是未登录。
    // 浏览器把两个主机名当两个站点，Domain 也跨不过去 —— 唯一解是让浏览器
    // 分别向两个主机名各发一次请求。这里验证桥真的把 Cookie 落到了另一个主机名上。
    // 顺序很重要：先清干净 → 只写本机（证明边界）→ 再桥（证明解决）。
    await evalJs(`(async () => {
      await clearBrowserCookies();
      return true;
    })()`);

    // 只往 /api/browser-cookie 发（不走 writeBrowserCookies，即不桥），
    // 用来证明「不桥就只有本主机名有」—— 这是桥存在的理由。
    const onlyLocal = await evalJs(`(async () => {
      const r = await fetch('/api/browser-cookie', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookies: session.cookies }),
      });
      return (await r.json()).written || [];
    })()`);
    check('直写接口（不桥）也能写入本主机名', onlyLocal.includes('Authorization'),
      JSON.stringify(onlyLocal));
    const forLocalhostOnly = (await c.send('Network.getCookies', {
      urls: [`http://localhost:${MOCK_PORT}/pds-std/api/pf/tenant/all`],
    })).cookies.map((k) => k.name);
    check('只写本主机名时 localhost 带不上 —— 这就是必须桥的原因',
      !forLocalhostOnly.includes('Authorization'), JSON.stringify(forLocalhostOnly));

    const bridged = await evalJs(`(async () => {
      const r = await writeBrowserCookies();
      return { written: r.written, bridged: r.bridged };
    })()`);
    check('写入时把会话桥到了另一个主机名', bridged.bridged?.ok === true,
      JSON.stringify(bridged.bridged));
    check('桥过去的是同一个 Authorization',
      (bridged.bridged?.written || []).includes('Authorization'),
      JSON.stringify(bridged.bridged?.written));

    const allJar = (await c.send('Network.getAllCookies')).cookies;
    const domainsOfAuth = allJar
      .filter((k) => k.name === 'Authorization')
      .map((k) => k.domain);
    check('浏览器罐里 Authorization 同时存在于两个主机名',
      domainsOfAuth.includes('127.0.0.1') && domainsOfAuth.includes('localhost'),
      JSON.stringify(domainsOfAuth));
    const bridgedCookie = allJar.find((k) => k.name === 'Authorization' && k.domain === 'localhost');
    check('桥过去的也是 HttpOnly', bridgedCookie?.httpOnly === true, String(bridgedCookie?.httpOnly));

    // 关键结论：现在直接访问 localhost 上的业务页面，浏览器会带上登录态
    const forLocalhostNow = (await c.send('Network.getCookies', {
      urls: [`http://localhost:${MOCK_PORT}/pds-std/api/pf/tenant/all`],
    })).cookies.map((k) => k.name);
    check('桥接后：localhost 直连业务页面也有登录态',
      forLocalhostNow.includes('Authorization'), JSON.stringify(forLocalhostNow));

    // 清除也要两边一起清，否则 127 那边会残留一段旧会话
    const clearedBoth = await evalJs(`(async () => {
      const r = await clearBrowserCookies();
      return { cleared: r.cleared, bridged: r.bridged };
    })()`);
    check('清除时也桥到了另一个主机名',
      clearedBoth.bridged?.ok === true && (clearedBoth.bridged?.cleared || []).includes('Authorization'),
      JSON.stringify(clearedBoth.bridged));
    const jarAfterBoth = (await c.send('Network.getAllCookies')).cookies
      .filter((k) => k.name === 'Authorization').map((k) => k.domain);
    check('清除后两个主机名上都没有 Authorization 了',
      jarAfterBoth.length === 0, JSON.stringify(jarAfterBoth));

    /* ---------- 8h. 后端硬编码 Domain 时的界面提示 ----------
     * 真实后端（tsie 框架）下发的是 Domain=127.0.0.1，写死在服务端。
     * 浏览器在 http://localhost:8080 页面上会**静默拒收**这条 Cookie，
     * 导致「登录成功但打开系统还是请先登录」。面板改不了服务端，
     * 但必须把原因直白告诉用户，否则用户只会觉得工具坏了。
     */
    const domainHint = await evalJs(`(async () => {
      // 造一条带 Domain 的会话，模拟真实后端下发结果
      session.cookies = ['Authorization=STUB_DOMAIN_PROBE; Path=/; HttpOnly; Domain=127.0.0.1'];
      renderAll();
      const dom = backendCookieDomain();
      const noteText = document.querySelector('.bc-block')?.textContent || '';
      const warned = /Domain=127\\.0\\.0\\.1/.test(noteText);
      return { dom: dom, warned: warned, host: location.hostname };
    })()`);
    check('能识别出后端写死的 Domain', domainHint.dom === '127.0.0.1', domainHint.dom);
    check('面板主机名与后端 Domain 不一致时给出警告',
      domainHint.host === '127.0.0.1' ? domainHint.warned === true : domainHint.warned === true,
      JSON.stringify({ host: domainHint.host, warned: domainHint.warned }));

    await evalJs(`(async () => { await clearBrowserCookies().catch(function(){}); return true; })()`);

    // 边界：页面刷新后内存里的 written 归零，罐里的 Cookie 还在。
    // 注意顺序 —— 必须先写入、再刷新、最后才清，否则刷新时罐本来就是空的，
    // 断言会失去意义（这个坑我第一次就踩了）。
    // 用真实 reload 来验证，这是唯一能证明「不依赖内存状态」的方式。
    await evalJs(`(async () => {
      const has = !!document.querySelector('#writeBrowserCookieBtn');
      if (has) document.querySelector('#writeBrowserCookieBtn').click();
      else await fetch('/api/browser-cookie', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookies: session.cookies }),
      });
      await new Promise((r) => setTimeout(r, 700));
      return true;
    })()`);
    const jarBeforeReload = (await c.send('Network.getAllCookies')).cookies
      .filter((k) => k.domain.includes('127.0.0.1')).map((k) => k.name);
    check('重新写回后罐里有 Authorization', jarBeforeReload.includes('Authorization'),
      JSON.stringify(jarBeforeReload));

    await c.send('Page.reload');
    await sleep(1800);
    const afterReload = await evalJs(`(async () => {
      const j = await (await fetch('/api/browser-cookie')).json();
      return {
        jarNames: j.names,
        memWritten: browserCookie.written,
        hasClearBtn: !!document.querySelector('#clearBrowserCookieBtn'),
        state: document.querySelector('.bc-state')?.textContent.trim() || '',
      };
    })()`);
    check('刷新后罐里 Cookie 仍在（浏览器自己持久化的）',
      (afterReload.jarNames || []).includes('Authorization'), JSON.stringify(afterReload.jarNames));
    check('刷新后内存里的 written 确实丢了（正是要防的场景）',
      Array.isArray(afterReload.memWritten) && afterReload.memWritten.length === 0,
      JSON.stringify(afterReload.memWritten));
    check('刷新后仍然给出清除入口（不会因为会话丢了就消失）',
      afterReload.hasClearBtn === true);
    check('刷新后界面如实显示「罐里有会话 Cookie」',
      /会话 Cookie/.test(afterReload.state), afterReload.state);

    const clearAfterReload = await evalJs(`(async () => {
      document.querySelector('#clearBrowserCookieBtn')?.click();
      await new Promise((r) => setTimeout(r, 800));
      const j = await (await fetch('/api/browser-cookie')).json();
      return j.names;
    })()`);
    check('刷新后点清除仍能清掉（不依赖内存 written）',
      !(clearAfterReload || []).includes('Authorization'), JSON.stringify(clearAfterReload));

    /* ---------- 8i. 回环主机名自动兜底（localhost / 127.0.0.1 混用） ----------
     * 实测矩阵（Node 22，Happy Eyeballs 默认开启）：
     *   localhost → 只绑 IPv4 ✅      localhost → 只绑 IPv6 ✅
     *   127.0.0.1 → 只绑 IPv4 ✅      127.0.0.1 → 只绑 IPv6 ❌ ECONNREFUSED
     * 所以 target 只填一个主机名，就必然有另一半连不上。这里的假后端只监听
     * 127.0.0.1，把 target 写成 [::1] 就等价于「后端只绑 IPv6」那个场景 ——
     * 面板必须自己换名才连得上。
     */
    const directProxy = async (body) => {
      const r = await fetch(`${PANEL}/api/proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeoutMs: 4000, ...body }),
      });
      return r.json();
    };

    // 先确认 IPv6 那条路确实是断的，否则后面「兜底成功」可能只是运气
    const v6Broken = await (async () => {
      try {
        await fetch(`http://[::1]:${MOCK_PORT}/`, { signal: AbortSignal.timeout(1500) });
        return false;
      } catch {
        return true;
      }
    })();
    check('前提成立：[::1] 上的假后端连不上（只有 IPv4 在听）', v6Broken === true);

    const viaV6 = await directProxy({
      method: 'GET', url: '/pds-std/api/pf/tenant/all', base: `http://[::1]:${MOCK_PORT}`,
    });
    check('填 [::1] 但只有 IPv4 在听时，自动换名后连上了', viaV6.ok === true, (viaV6.error || '').slice(0, 70));
    check('回报了「填的」与「实际连的」两个主机名',
      viaV6.askedHost === '[::1]' && viaV6.host === 'localhost',
      JSON.stringify({ askedHost: viaV6.askedHost, host: viaV6.host }));
    check('回报 hostSwitched / loopbackFallback 供界面显示',
      viaV6.hostSwitched === true && viaV6.loopbackFallback === true);
    check('实际基址给的是真正连通的那个', /^http:\/\/localhost:/.test(viaV6.resolvedBase || ''),
      viaV6.resolvedBase);
    check('换名后拿到的是真数据，不是空壳 200',
      Array.isArray(viaV6.json?.data) || typeof viaV6.json?.retCode === 'string',
      JSON.stringify(viaV6.json || {}).slice(0, 80));

    // 关掉开关就该如实失败 —— 用户要精确控制时必须尊重
    const setAuto = async (v) => {
      const cur = await (await fetch(`${PANEL}/api/state`)).json();
      cur.autoLoopback = v;
      await fetch(`${PANEL}/api/state`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cur),
      });
    };
    await setAuto(false);
    const offFail = await directProxy({
      method: 'GET', url: '/pds-std/api/pf/tenant/all', base: `http://[::1]:${MOCK_PORT}`,
    });
    check('关掉 autoLoopback 后如实失败（不偷偷兜底）',
      offFail.ok === false, (offFail.error || '').slice(0, 70));
    check('关掉后只试一个主机名',
      Array.isArray(offFail.attemptedHosts) && offFail.attemptedHosts.length === 1,
      JSON.stringify(offFail.attemptedHosts));
    await setAuto(true);

    // 非回环目标绝不能猜。127.0.0.2 是本机网段但不是我们认定的回环名，
    // 解析不需要 DNS、连接立刻被拒，正好用来看「有没有多试几次」。
    const nonLoop = await directProxy({
      method: 'GET', url: '/x', base: `http://127.0.0.2:${MOCK_PORT}`,
    });
    check('非回环目标不做换名猜测（只试一次）',
      nonLoop.ok === false && (nonLoop.attemptedHosts || []).length === 1,
      JSON.stringify(nonLoop.attemptedHosts || (nonLoop.error || '').slice(0, 50)));

    /* 界面一致性：Cookie 提示必须按「实际连上的主机名」算，而不是配置里填的 */
    const uiAlign = await evalJs(`(async () => {
      backendRoute = { askedHost: '[::1]', host: 'localhost', hostSwitched: true,
                       resolvedBase: 'http://localhost:${MOCK_PORT}', at: new Date().toISOString() };
      state.target = 'http://[::1]:${MOCK_PORT}';
      renderAll();
      const note = cookieHostNote();
      const blockText = document.querySelector('.bc-block')?.textContent || '';
      return {
        hasFn: typeof effectiveBackendHost === 'function',
        eff: effectiveBackendHost(),
        note: note,
        showsSwitched: /后端通道/.test(blockText),
      };
    })()`);
    check('前端有 effectiveBackendHost 可用', uiAlign.hasFn === true);
    check('Cookie 提示跟随「实际连上的」主机名，而不是配置里填的',
      uiAlign.eff === 'localhost' && uiAlign.note?.targetHost === 'localhost',
      JSON.stringify({ eff: uiAlign.eff, targetHost: uiAlign.note?.targetHost }));
    check('提示里点明「填的是 [::1]、改连了 localhost」',
      uiAlign.note?.askedHost === '[::1]' && uiAlign.note?.kind === 'info',
      JSON.stringify(uiAlign.note));
    check('界面上出现「后端通道」区块，兜底不止在日志里',
      uiAlign.showsSwitched === true);

    // 老配置完全没有 autoLoopback 字段时，界面必须显示「已勾选」，
    // 否则会出现「复选框没勾、实际却在兜底」的错位
    const autoDefault = await evalJs(`(async () => {
      const raw = await (await fetch('/api/state')).json();
      delete raw.autoLoopback;                       // 造一份老配置
      await fetch('/api/state', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(raw),
      });
      delete state.autoLoopback;                     // 本地也抹掉
      const missing = state.autoLoopback;
      await loadState();                             // 走一遍真实加载
      const after = state.autoLoopback;
      renderAll();
      const box = document.querySelector('[data-bind="autoLoopback"]');
      return { missing: missing, after: after, checked: box ? box.checked : null };
    })()`);
    check('老配置缺 autoLoopback 字段时不崩', autoDefault.missing === undefined);
    check('加载时补成 true，与后端「缺省即开启」一致', autoDefault.after === true);
    check('复选框如实显示为已勾选',
      autoDefault.checked === true, String(autoDefault.checked));

    // 收尾：把这节的临时改动还原，别影响后面的用例
    await evalJs(`(async () => {
      state.target = 'http://127.0.0.1:${MOCK_PORT}';
      state.autoLoopback = true;
      backendRoute = { askedHost: '', host: '', hostSwitched: false, resolvedBase: '', at: null };
      await saveState();
      renderAll();
      return true;
    })()`);

    /* ---------- 8.5 端口被占用时：认得出是自家面板，就复用而不是报错 ---------- */
    //
    // 用户真实的操作是「我已经开着了，又双击了一次 DevSwitch.bat」。
    // 早先这里会打一段 EADDRINUSE 然后退出，页面根本不跳转 —— 用户以为是启动失败了。
    // 现在的行为：探测 /api/state，认出是自家面板 -> 打开浏览器 -> 用退出码 2 静默退出。
    {
      const runServer = (port, env = {}) =>
        spawn(process.execPath, [path.join(RUN_DIR, 'server.js')], {
          cwd: RUN_DIR,
          env: { ...process.env, PORT: String(port), ...env },
        });

      // 先占住一个端口（用真正在跑的面板）
      const first = runServer(9096);
      const collect = (p, ms) => new Promise((resolve) => {
        let buf = '';
        p.stdout.on('data', (d) => { buf += d; });
        p.stderr.on('data', (d) => { buf += d; });
        // 只等到「输出稳定」为止，不强求进程退出（第一个进程要一直活着占端口）
        const t = setTimeout(() => resolve(buf), ms);
        p.on('exit', () => { clearTimeout(t); resolve(buf); });
      });
      const waitExit = (p, ms) => new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), ms);
        p.on('exit', (code) => { clearTimeout(t); resolve(code); });
      });

      await collect(first, 1200);

      // 再起一次同一端口 —— 模拟重复双击
      const second = runServer(9096);
      const p2 = collect(second, 3000);
      const code2 = await waitExit(second, 3500);
      const out2 = await p2;

      check('重复启动时认得出「面板已在运行」', out2.includes('面板已经在运行了'), out2.trim().split('\n').pop());
      check('重复启动用专用退出码 2（脚本据此静默关窗口）', code2 === 2, String(code2));
      check('重复启动不再喊 EADDRINUSE 致命错误',
        !out2.includes('两个回环地址都监听失败'), out2.includes('两个回环地址都监听失败') ? '仍在喊' : '（没有）');

      // 反例：不是自家服务占着端口时，必须如实报错，不能瞎认。
      // 注意两个回环地址都要占住 —— 只占 127.0.0.1 的话，面板会聪明地改用 ::1 起来，
      // 那是正确行为（不是"被占死"），测不到这条分支。
      const foreignHandler = (q, s) => {
        s.writeHead(200, { 'Content-Type': 'text/html' });
        s.end('<h1>not dev-switch</h1>');
      };
      const foreign4 = http.createServer(foreignHandler);
      const foreign6 = http.createServer(foreignHandler);
      await new Promise((res) => foreign4.listen(9097, '127.0.0.1', res));
      await new Promise((res) => {
        foreign6.on('error', res); // 有的机器禁用 IPv6，占不上也无所谓
        foreign6.listen(9097, '::1', res);
      });

      const third = runServer(9097);
      const p3 = collect(third, 4000);
      const code3 = await waitExit(third, 4500);
      const out3 = await p3;
      foreign4.close();
      foreign6.close();
      try { first.kill(); } catch { /* ignore */ }
      try { second.kill(); } catch { /* ignore */ }
      try { third.kill(); } catch { /* ignore */ }

      check('外部程序占端口时如实报「被别的程序占用」', out3.includes('被别的程序占用'), out3.trim().split('\n').pop());
      check('外部程序占端口时退出码是 1（真失败）', code3 === 1, String(code3));

      // 半占用场景：127.0.0.1 被外人占着、自家面板只起来了 ::1。
      // 这种时候再双击一次，必须认出「::1 上那个就是自己」，而不是因为
      // 只探 127.0.0.1 就误报「被别的程序占用」。地址也要给 [::1]，不能给死链。
      //
      // 前提：这台机器得能用 ::1。有的环境禁用了 IPv6，那就没这个场景可测，
      // 直接跳过断言而不是误报失败。
      const ipv6Usable = await new Promise((res) => {
        const t = http.createServer();
        t.on('error', () => res(false));
        t.listen(0, '::1', () => t.close(() => res(true)));
      });

      if (ipv6Usable) {
        const halfForeign = http.createServer(foreignHandler);
        await new Promise((res) => halfForeign.listen(9098, '127.0.0.1', res));

        const fourth = runServer(9098);
        const out4 = await collect(fourth, 1500); // 它只绑得上 ::1
        const boundV6Only = out4.includes('面板地址') && out4.includes('http://[::1]:9098');

        const fifth = runServer(9098);
        const p5 = collect(fifth, 3000);
        const code5 = await waitExit(fifth, 3500);
        const out5 = await p5;
        halfForeign.close();
        try { fourth.kill(); } catch { /* ignore */ }
        try { fifth.kill(); } catch { /* ignore */ }

        if (boundV6Only) {
          check('自家面板只绑上 ::1 时，重复启动仍认得出（不误判成外人）',
            out5.includes('面板已经在运行了') && !out5.includes('被别的程序占用'),
            out5.trim().split('\n').pop());
          check('认出来时给的地址是 [::1]，不是打不开的死链',
            out5.includes('http://[::1]:9098'),
            (out5.match(/面板地址\s+\S+/) || ['（未找到）'])[0]);
          check('这种场景的退出码同样是 2（静默复用）', code5 === 2, String(code5));
        }
      }
    }

    /* ---------- 9. 无 JS 运行时异常 ---------- */
    const errs = c.events.filter(
      (e) => e.method === 'Runtime.exceptionThrown' &&
        !String(e.params?.exceptionDetails?.text || '').includes('favicon')
    );
    check('无 JS 运行时异常', errs.length === 0, errs.length ? JSON.stringify(errs[0].params).slice(0, 200) : '（无）');

    /* ---------- 10. 可选截图（SHOT=1 时生成，方便肉眼看渲染） ---------- */
    if (process.env.SHOT) {
      // 造一批像真实环境那样的长列表（长 hash ID + 中文公司名），
      // 用来肉眼确认「列表自己滚、页面不被撑长、筛选条位置正常」
      await evalJs(`(() => {
        const names = ['南疆分公司','清能分公司','东疆分公司','阿克陶县华能新能源有限责任公司',
          '哈密欧瑞光伏发电有限公司','哈密耀辉光伏电力有限公司','和田协鑫光伏电力有限公司',
          '华能哈密风力发电有限公司','华能吐鲁番风力发电有限公司','华能托里风力发电有限公司',
          '阿尔法新能源分公司','伽马光伏发电有限公司'];
        state.tenants = names.map((n, i) => ({
          id: '4028e52e979c62cc01979c' + String(8775520002 + i * 7),
          name: n, code: '',
        }));
        // 让其中一个处于「当前租户」高亮态
        session.tenantId = state.tenants[3].id;
        renderAll();
      })()`);
      await sleep(300);
      const shot = await c.send('Page.captureScreenshot', { format: 'png' });
      const out = path.join(ROOT, 'preview-tenants.png');
      fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
      console.log(`\n📸 长列表截图已保存：${out}`);
    }

    console.log(`\n${fail === 0 ? '🎉 全部通过' : `⚠️ ${fail} 项失败`}`);
    ws.close();
  } catch (e) {
    console.error('测试中断：', e.message);
    fail++;
  } finally {
    for (const p of procs) { try { p.kill(); } catch { /* ignore */ } }
    await sleep(500);
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(RUN_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(fail === 0 ? 0 : 1);
  }
})();

/**
 * 主进程 —— 窗口、本地数据存储、下载、运行、数据刷新
 */
import { app, BrowserWindow, ipcMain, shell, dialog, Menu, nativeTheme } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const isDev = process.argv.includes('--dev');
let mainWindow = null;

/* ------------------------------------------------------------------ */
/* 日志与崩溃诊断                                                       */
/* ------------------------------------------------------------------ */

function logLine(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.log(line);
  try {
    const dir = app.getPath('userData');
    fs.appendFileSync(path.join(dir, 'app.log'), line + '\n');
  } catch {
    /* app 尚未 ready 时忽略 */
  }
}

process.on('uncaughtException', (err) => logLine('[fatal] uncaughtException:', err?.stack || String(err)));
process.on('unhandledRejection', (reason) => logLine('[fatal] unhandledRejection:', String(reason)));

app.on('render-process-gone', (_e, _wc, details) =>
  logLine('[crash] render-process-gone:', JSON.stringify(details))
);
app.on('child-process-gone', (_e, details) => logLine('[crash] child-process-gone:', JSON.stringify(details)));
app.on('gpu-process-crashed', (_e, killed) => logLine('[crash] gpu-process-crashed:', String(killed)));


/* ------------------------------------------------------------------ */
/* 路径与状态                                                           */
/* ------------------------------------------------------------------ */

const userData = () => app.getPath('userData');
const dataFile = () => path.join(userData(), 'trainers.json');
const stateFile = () => path.join(userData(), 'state.json');
const coversDir = () => path.join(userData(), 'covers');

/** 打包后 scripts 被解包到 app.asar.unpacked */
function scriptsDir() {
  const appPath = app.getAppPath();
  const unpacked = path.join(appPath.replace(/app\.asar$/, 'app.asar.unpacked'), 'scripts');
  if (fssync.existsSync(unpacked)) return unpacked;
  const inside = path.join(appPath, 'scripts');
  if (fssync.existsSync(inside)) return inside;
  return path.join(ROOT, 'scripts');
}

const DEFAULT_SETTINGS = {
  trainersDir: '', // 本机存放修改器的目录，运行按钮在此查找 exe
  downloadDir: '', // 下载保存目录，留空则用「下载」目录下的 风灵月影修改器/
  coverCache: false, // 是否把封面缓存到本地
  cardSize: 'md', // sm | md | lg
  showHidden: false, // 是否显示被「删除」隐藏的条目
};

const EMPTY_STATE = () => ({
  favorites: [],
  downloads: {}, // slug -> { file, name, size, at, ext }
  recent: [], // slug 数组，最近运行
  hidden: [], // slug 数组，被删除隐藏
  settings: { ...DEFAULT_SETTINGS },
});

let stateCache = null;

function readState() {
  if (stateCache) return stateCache;
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    stateCache = {
      ...EMPTY_STATE(),
      ...raw,
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
    };
  } catch {
    stateCache = EMPTY_STATE();
  }
  return stateCache;
}

let writeTimer = null;

/** 立即把状态落盘（原子写：先写临时文件再 rename，避免中途崩溃留下半截 JSON） */
function persistState() {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  try {
    const target = stateFile();
    fssync.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = target + '.tmp';
    fssync.writeFileSync(tmp, JSON.stringify(stateCache, null, 2), 'utf8');
    fssync.renameSync(tmp, target);
  } catch (e) {
    console.error('[state] 写入失败', e);
  }
}

function writeState() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(persistState, 120);
}

/** 首次启动把内置数据复制到可写目录 */
function ensureDataFile() {
  if (fs.existsSync(dataFile())) return;
  const bundled = path.join(ROOT, 'data', 'trainers.json');
  const candidates = [path.join(app.getAppPath(), 'data', 'trainers.json'), bundled];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      fssync.mkdirSync(path.dirname(dataFile()), { recursive: true });
      fssync.copyFileSync(c, dataFile());
      return;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 840,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#17181c',
    title: '风灵月影修改器合集',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 诊断：把渲染进程的报错与生命周期写进日志
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) =>
    logLine('[renderer] did-fail-load:', code, desc, url)
  );
  mainWindow.webContents.on('preload-error', (_e, file, err) =>
    logLine('[renderer] preload-error:', file, err?.stack || String(err))
  );
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2 || /error|uncaught|failed/i.test(message)) {
      logLine('[renderer:console]', message, `${sourceId}:${line}`);
    }
  });
  mainWindow.on('unresponsive', () => logLine('[window] unresponsive'));
  mainWindow.on('responsive', () => logLine('[window] responsive again'));

  // 显示窗口：ready-to-show 为主，did-finish-load 兜底（个别环境 ready-to-show 不触发会导致窗口一直隐藏）
  let shown = false;
  const showWindow = () => {
    if (shown || !mainWindow || mainWindow.isDestroyed()) return;
    shown = true;
    mainWindow.show();
    mainWindow.focus();
  };
  mainWindow.once('ready-to-show', showWindow);
  mainWindow.webContents.once('did-finish-load', showWindow);
  setTimeout(showWindow, 4000);

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // 自检：--smoke 启动后截图并退出（开发调试用）
  // 压力自检：--soak 反复翻页 + 滚到底，观察是否崩溃/内存暴涨
  if (process.argv.includes('--soak')) {
    mainWindow.webContents.on('did-finish-load', () => {
      let round = 0;
      const timer = setInterval(async () => {
        round++;
        try {
          const info = await mainWindow.webContents.executeJavaScript(
            `(() => {
               const main = document.querySelector('#viewMain');
               const pager = document.querySelector('#pager');
               const btns = [...pager.querySelectorAll('button')];
               const next = btns.find(b => b.textContent.indexOf('下一页') >= 0);
               const first = btns.find(b => b.textContent === '1');
               const curOf = () => { const c = pager.querySelector('button.on'); return c ? c.textContent : null; };
               const pageBefore = curOf();
               const atLast = !next || next.disabled;
               if (atLast) { if (first) first.click(); } else { next.click(); }
               main.scrollTop = main.scrollHeight;
               const m = performance.memory;
               return {
                 round: ${round},
                 action: atLast ? 'reset-to-1' : 'next',
                 pageBefore,
                 pageAfter: curOf(),
                 cards: document.querySelectorAll('.card').length,
                 pagerHidden: pager.hidden,
                 heapMB: m ? Math.round(m.usedJSHeapSize / 1048576) : null,
                 scrollHeight: main.scrollHeight
               };
             })()`
          );
          logLine('[soak]', JSON.stringify(info));
        } catch (e) {
          logLine('[soak] 脚本执行失败：', String(e.message || e));
        }
        if (round >= 30) {
          clearInterval(timer);
          logLine('[soak] 结束，未崩溃');
          app.quit();
        }
      }, 3000);
    });
  }

  // 交互自检：--verify 驱动真实 UI 跑一遍分页用例，报告写到 build/verify-report.json 后退出
  if (process.argv.includes('--verify')) {
    mainWindow.webContents.on('did-finish-load', async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const results = [];
      const checks = [];

      // 读状态片段（page/pageCount 直接读渲染层内部状态，分页条隐藏时也能拿到）
      const S = [
        "const P=document.querySelector('#pager');",
        "const on=P.querySelector('button.on');",
        "const IN=(function(){try{return {page:(typeof page==='number'?page:null), pageCount:(typeof pageCount==='number'?pageCount:null)};}catch(e){return {page:null,pageCount:null};}})();",
        "const R={",
        "  page:IN.page,",
        "  domPage:on?Number(on.textContent):null,",
        "  pageCount:IN.pageCount,",
        "  cards:document.querySelectorAll('.card').length,",
        "  seq:[...P.querySelectorAll('button')].filter(b=>/^[0-9]+$/.test(b.textContent)).map(b=>Number(b.textContent)),",
        "  ellipsis:P.querySelectorAll('button.ellipsis').length,",
        "  pagerHidden:P.hidden,",
        "  jumpValue:(P.querySelector('.jump input')||{}).value||null,",
        "  scrollTop:Math.round(document.querySelector('#viewMain').scrollTop),",
        "  count:document.querySelector('#listCount').textContent,",
        "  hint:document.querySelector('#listHint').textContent,",
        "  emptyShown:!document.querySelector('#empty').hidden,",
        "  favBadge:document.querySelector('#badgeFav').hidden?null:document.querySelector('#badgeFav').textContent,",
        "  cols:getComputedStyle(document.querySelector('#grid')).gridTemplateColumns.split(' ').length",
        "};",
      ].join('\n');

      const run = (code) => mainWindow.webContents.executeJavaScript('(() => {\n' + code + '\n})()');

      const act = async (name, code, ms) => {
        let r;
        try { r = await run(code); } catch (e) { r = { _error: String((e && e.message) || e) }; }
        results.push({ step: name, kind: 'act', ...r });
        await wait(ms == null ? 350 : ms);
        return r;
      };

      const obs = async (name, expect) => {
        let r;
        try { r = await run(S + '\nreturn R;'); } catch (e) { r = { _error: String((e && e.message) || e) }; }
        results.push({ step: name, kind: 'obs', ...r });
        const bad = expect ? Object.keys(expect).filter((k) => JSON.stringify(r[k]) !== JSON.stringify(expect[k])) : [];
        // 附加一致性校验：分页条可见时，高亮页码必须与内部状态一致
        if (expect && r.pagerHidden === false && r.domPage !== r.page) bad.push('domPage');
        if (expect) checks.push({ name, ok: bad.length === 0 && !r._error, mismatch: bad, want: expect, got: r });
        return r;
      };

      const tabClick = (t) => act('点击 Tab「' + t + '」', 'document.querySelector(\'#tabs .tab[data-tab="' + t + '"]\').click(); return {ok:1};', 450);
      const sortClick = (s) => act('点击排序「' + s + '」', 'document.querySelector(\'#chips .chip[data-sort="' + s + '"]\').click(); return {ok:1};', 450);
      const setSearch = (q) => act('搜索「' + q + '」', 'const el=document.querySelector(\'#search\'); el.value=' + JSON.stringify(q) + '; el.dispatchEvent(new Event(\'input\',{bubbles:true})); return {value:el.value};', 700);
      const clearSearch = () => act('点击清空搜索', 'document.querySelector(\'#searchClear\').click(); return {ok:1};', 700);
      const jumpTo = (n) => act('跳转框输入 ' + n + ' + 回车', 'const i=document.querySelector(\'#pager .jump input\'); i.value=\'' + n + '\'; i.dispatchEvent(new KeyboardEvent(\'keydown\',{key:\'Enter\',bubbles:true})); return {ok:1};', 400);
      const nextN = (k) => act('连点「下一页」' + k + ' 次', 'let n=0; for(let j=0;j<' + k + ';j++){ const b=[...document.querySelectorAll(\'#pager button\')].find(x=>x.textContent.indexOf(\'下一页\')>=0); if(!b||b.disabled) break; b.click(); n++; } return {clicked:n};', 450);
      const callGlobal = (expr) => act('调用 ' + expr, expr + '; return {ok:1};', 400);
      const clickSel = (name, sel, ms) => act(name, 'const e=document.querySelector(' + JSON.stringify(sel) + '); if(!e) return {found:false}; e.click(); return {found:true};', ms);

      // ---------- 1. 基础与页码窗口 ----------
      await act('复位：全部 Tab + 清空搜索 + 第 1 页', 'document.querySelector(\'#tabs .tab[data-tab="all"]\').click(); const el=document.querySelector(\'#search\'); if(el.value){el.value=\'\';el.dispatchEvent(new Event(\'input\',{bubbles:true}));} return {ok:1};', 700);
      await obs('① 首页', { cards: 72, page: 1, domPage: 1, pageCount: 11, pagerHidden: false, seq: [1, 2, 3, 4, 5, 11], ellipsis: 1, emptyShown: false, count: '全部修改器 · 共 757 个', hint: '第 1 / 11 页' });

      await jumpTo(6);
      await obs('② 第 6 页 —— 页码窗口居中，两侧省略号', { cards: 72, page: 6, pageCount: 11, seq: [1, 4, 5, 6, 7, 8, 11], ellipsis: 2, hint: '第 6 / 11 页' });

      await jumpTo(11);
      await obs('③ 末页 —— 卡片数与页码窗口贴右', { cards: 37, page: 11, seq: [1, 7, 8, 9, 10, 11], ellipsis: 1, hint: '第 11 / 11 页', jumpValue: '11' });
      await obs('④ 末页「下一页」应禁用', null);
      const lastBtn = await run("const b=[...document.querySelectorAll('#pager button')].find(x=>x.textContent.indexOf('下一页')>=0); const p=[...document.querySelectorAll('#pager button')].find(x=>x.textContent.indexOf('上一页')>=0); return {nextDisabled:b.disabled, prevDisabled:p.disabled};");
      checks.push({ name: '④ 末页「下一页」应禁用 / 「上一页」可用', ok: lastBtn.nextDisabled === true && lastBtn.prevDisabled === false, got: lastBtn });

      // ---------- 2. 越界 clamp ----------
      await callGlobal('gotoPage(9999)');
      await obs('⑤ gotoPage(9999) 应夹到末页', { page: 11, cards: 37 });
      await callGlobal('gotoPage(-5)');
      await obs('⑥ gotoPage(-5) 应夹到第 1 页', { page: 1, cards: 72 });
      await callGlobal('gotoPage(NaN)');
      await obs('⑦ gotoPage(NaN) 应落到第 1 页', { page: 1, cards: 72 });

      // ---------- 3. 跳转框边界 ----------
      await jumpTo(99);
      await obs('⑧ 跳转框输入 99（越上界）应夹到末页', { page: 11, cards: 37, jumpValue: '11' });
      await jumpTo(0);
      await obs('⑨ 跳转框输入 0（越下界）应回到第 1 页', { page: 1, cards: 72, jumpValue: '1' });
      await jumpTo('abc');
      await obs('⑩ 跳转框输入非数字应落到第 1 页', { page: 1, cards: 72 });

      // ---------- 4. 翻页后滚动复位 ----------
      await act('先滚到底再跳到第 3 页', 'const m=document.querySelector(\'#viewMain\'); m.scrollTop=m.scrollHeight; const i=document.querySelector(\'#pager .jump input\'); i.value=\'3\'; i.dispatchEvent(new KeyboardEvent(\'keydown\',{key:\'Enter\',bubbles:true})); return {ok:1};', 400);
      await obs('⑪ 翻页后应自动滚回顶部', { page: 3, scrollTop: 0 });

      // ---------- 5. 排序 / 搜索 / Tab 切换应重置页码 ----------
      await jumpTo(5);
      await sortClick('published');
      await obs('⑫ 切换排序应回到第 1 页', { page: 1, cards: 72 });

      await jumpTo(4);
      await setSearch('b');
      await obs('⑬ 搜索「b」(135 条) 应回到第 1 页', { page: 1, pageCount: 2, cards: 72, pagerHidden: false, seq: [1, 2], ellipsis: 0, hint: '筛选「b」 · 第 1 / 2 页' });

      await nextN(1);
      await obs('⑭ 搜索结果的第 2 页', { page: 2, cards: 63, hint: '筛选「b」 · 第 2 / 2 页' });

      await setSearch('k');
      await obs('⑮ 搜索「k」为 3 页 —— 页码窗口应完整展开、无省略号', { page: 1, pageCount: 3, cards: 72, seq: [1, 2, 3], ellipsis: 0 });

      // ---------- 6. 结果缩小后的页码 clamp ----------
      await setSearch('ba');
      await obs('⑯ 收窄为「ba」(35 条) 页码应 clamp 到第 1 页且分页条隐藏', { page: 1, domPage: null, pageCount: 1, cards: 35, pagerHidden: true, hint: '筛选「ba」' });

      await setSearch('zzzzzz');
      await obs('⑰ 搜不到 —— 空态', { page: 1, pageCount: 1, cards: 0, emptyShown: true, pagerHidden: true });

      await clearSearch();
      await obs('⑱ 清空搜索后恢复全量第 1 页', { page: 1, pageCount: 11, cards: 72, pagerHidden: false, count: '全部修改器 · 共 757 个' });

      // ---------- 7. 收藏 Tab：空态 / 收藏 / 取消 ----------
      await tabClick('fav');
      await obs('⑲ 收藏为空 —— 空态且无分页条', { cards: 0, pageCount: 1, emptyShown: true, pagerHidden: true, count: '我的收藏 · 共 0 个' });

      await tabClick('all');
      await clickSel('收藏第一张卡片', '.card .act.fav', 700);
      await obs('⑳ 收藏后角标应变为 1', { favBadge: '1' });

      await tabClick('fav');
      await obs('㉑ 收藏 Tab 应有 1 张卡片、无分页条', { cards: 1, pageCount: 1, pagerHidden: true, count: '我的收藏 · 共 1 个' });

      await clickSel('在收藏 Tab 取消收藏', '.card .act.fav', 700);
      await obs('㉒ 取消收藏后应为空态、角标归零', { cards: 0, emptyShown: true, pagerHidden: true, favBadge: null });

      // ---------- 8. 连续快速翻页 ----------
      await tabClick('all');
      await jumpTo(1);
      const r1 = await nextN(5);
      await obs('㉓ 从第 1 页连点 5 次「下一页」应到第 6 页', { page: 6, cards: 72 });
      checks.push({ name: '㉓ 5 次点击应全部生效（无吞点击）', ok: r1.clicked === 5, got: r1 });

      const r2 = await nextN(50);
      await obs('㉔ 继续连点 50 次应停在末页', { page: 11, cards: 37 });
      checks.push({ name: '㉔ 连点 50 次只应生效 5 次（6→11）', ok: r2.clicked === 5, got: r2 });

      // ---------- 9. 删除后页码 clamp（el = 73 条 / 2 页 / 末页仅 1 条）----------
      await jumpTo(1);
      await setSearch('el');
      await obs('㉕ 搜索「el」(73 条) 应为 2 页', { page: 1, pageCount: 2, cards: 72, hint: '筛选「el」 · 第 1 / 2 页' });

      await nextN(1);
      await obs('㉖ 「el」末页只有 1 条', { page: 2, domPage: 2, cards: 1 });

      await clickSel('删除末页那唯一一条', '.card .act.del', 500);
      const modal = await run("return {shown:!document.querySelector('#confirm').hidden, title:document.querySelector('#cfTitle').textContent};");
      checks.push({ name: '㉗ 删除应弹出确认框', ok: modal.shown === true, got: modal });

      await clickSel('点击确认删除', '#cfYes', 900);
      await obs('㉘ 删除后剩 72 条 —— 页码应从第 2 页 clamp 回第 1 页', { page: 1, pageCount: 1, cards: 72, pagerHidden: true, count: '全部修改器 · 共 72 个' });

      await clearSearch();
      await obs('㉙ 清空搜索 —— 总量应少 1 条', { page: 1, pageCount: 11, cards: 72, count: '全部修改器 · 共 756 个' });

      // ---------- 10. 窗口尺寸变化 ----------
      mainWindow.setBounds({ width: 720, height: 640 });
      await wait(900);
      const narrow = await obs('㉚ 窄窗口 —— 卡片数不变、列数减少', { cards: 72 });
      checks.push({ name: '㉚ 窄窗口应减少列数', ok: narrow.cols < 4, got: { cols: narrow.cols } });
      mainWindow.setBounds({ width: 1220, height: 812 });
      await wait(900);
      const wide = await obs('㉛ 还原宽窗口', { cards: 72 });
      checks.push({ name: '㉛ 宽窗口应恢复 4 列', ok: wide.cols === 4, got: { cols: wide.cols } });

      // ---------- 汇总 ----------
      const failed = checks.filter((c) => !c.ok);
      const report = {
        ranAt: new Date().toISOString(),
        total: checks.length,
        passed: checks.length - failed.length,
        failed: failed.length,
        checks,
        steps: results,
      };
      try {
        fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
        fs.writeFileSync(path.join(ROOT, 'build', 'verify-report.json'), JSON.stringify(report, null, 2));
      } catch (e) { logLine('[verify] 报告写入失败：', String(e.message || e)); }

      for (const c of checks) {
        logLine('[verify]', (c.ok ? 'PASS' : 'FAIL'), c.name, c.ok ? '' : JSON.stringify({ mismatch: c.mismatch, want: c.want, got: c.got }));
      }
      console.log('VERIFY_DONE', JSON.stringify({ total: report.total, passed: report.passed, failed: report.failed }));
      for (const c of failed) console.log('VERIFY_FAIL', c.name, JSON.stringify({ mismatch: c.mismatch, want: c.want, got: c.got }));
      app.quit();
    });
  }

  if (process.argv.includes('--smoke')) {
    mainWindow.webContents.on('did-finish-load', () => {
      const buildDir = path.join(ROOT, 'build');
      const grab = async (name) => {
        const img = await mainWindow.webContents.capturePage();
        fs.mkdirSync(buildDir, { recursive: true });
        fs.writeFileSync(path.join(buildDir, name), img.toPNG());
      };
      setTimeout(async () => {
        try {
          const probe = await mainWindow.webContents.executeJavaScript(
            `(() => {
               const imgs = [...document.querySelectorAll('.cover img')];
               const pager = document.querySelector('#pager');
               const on = pager.querySelector('button.on');
               return {
                 vw: innerWidth, vh: innerHeight,
                 cards: document.querySelectorAll('.card').length,
                 count: document.querySelector('#listCount').textContent,
                 hint: document.querySelector('#listHint').textContent,
                 brand: document.querySelector('#brandSub').textContent,
                 empty: !document.querySelector('#empty').hidden,
                 modalHidden: document.querySelector('#confirm').hidden,
                 drawerHidden: document.querySelector('#drawer').hidden,
                 favBadgeHidden: document.querySelector('#badgeFav').hidden,
                 imgs: imgs.length, imgsLoaded: imgs.filter(i => i.naturalWidth > 0).length,
                 cols: getComputedStyle(document.querySelector('#grid')).gridTemplateColumns.split(' ').length,
                 pagerHidden: pager.hidden,
                 pagerButtons: pager.querySelectorAll('button').length,
                 pagerPage: on ? Number(on.textContent) : null,
                 pagerInfo: (pager.querySelector('.pager-info') || {}).textContent || '',
                 pagerHasJump: !!pager.querySelector('.jump input')
               };
             })()`
          );
          await grab('smoke.png');

          // 翻到第 2 页，验证分页渲染
          const p2click = await mainWindow.webContents.executeJavaScript(
            `(() => {
               const b = [...document.querySelectorAll('#pager button')].find(x => x.textContent.indexOf('下一页') >= 0);
               if (!b || b.disabled) return { clicked: false };
               b.click();
               const on = document.querySelector('#pager button.on');
               return { clicked: true, page: on ? Number(on.textContent) : null, cards: document.querySelectorAll('.card').length, scrollTop: document.querySelector('#viewMain').scrollTop };
             })()`
          );
          await new Promise((r) => setTimeout(r, 1200));
          await grab('smoke-page2.png');

          // 跳回第 1 页
          const backProbe = await mainWindow.webContents.executeJavaScript(
            `(() => {
               const inp = document.querySelector('#pager .jump input');
               inp.value = '1';
               inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
               const on = document.querySelector('#pager button.on');
               return { page: on ? Number(on.textContent) : null, cards: document.querySelectorAll('.card').length };
             })()`
          );
          // 滚到底，截分页条
          await mainWindow.webContents.executeJavaScript(
            `(() => { const m = document.querySelector('#viewMain'); m.scrollTop = m.scrollHeight; return true; })()`
          );
          await new Promise((r) => setTimeout(r, 900));
          await grab('smoke-pager.png');

          // 窄窗口下再看一眼分页条是否破版
          mainWindow.setBounds({ width: 700, height: 620 });
          await new Promise((r) => setTimeout(r, 900));
          await mainWindow.webContents.executeJavaScript(
            `(() => { const m = document.querySelector('#viewMain'); m.scrollTop = m.scrollHeight; return true; })()`
          );
          await new Promise((r) => setTimeout(r, 700));
          await grab('smoke-pager-narrow.png');
          const narrowProbe = await mainWindow.webContents.executeJavaScript(
            `(() => { const p=document.querySelector('#pager'); const pr=p.getBoundingClientRect(); const mr=document.querySelector('#viewMain').getBoundingClientRect(); return {pagerWidth:Math.round(pr.width), viewWidth:Math.round(mr.width), overflowX: pr.width > mr.width, cols:getComputedStyle(document.querySelector('#grid')).gridTemplateColumns.split(' ').length}; })()`
          );
          mainWindow.setBounds({ width: 1220, height: 812 });
          await new Promise((r) => setTimeout(r, 700));
          await mainWindow.webContents.executeJavaScript(
            `(() => { document.querySelector('#viewMain').scrollTop = 0; return true; })()`
          );
          await new Promise((r) => setTimeout(r, 400));

          // 打开第一张卡片的详情抽屉，再截一张
          await mainWindow.webContents.executeJavaScript(
            `document.querySelector('.card .cover').click(); true`
          );
          await new Promise((r) => setTimeout(r, 1500));
          await grab('smoke-detail.png');
          const probe2 = await mainWindow.webContents.executeJavaScript(
            `({drawerHidden: document.querySelector('#drawer').hidden, files: document.querySelectorAll('.file-list tbody tr').length, opts: document.querySelectorAll('.opt-list span').length})`
          );
          console.log('SMOKE_SHOT_OK', JSON.stringify({ ...probe, page2: p2click, backTo1: backProbe, narrow: narrowProbe, detail: probe2 }));
        } catch (e) {
          console.error('SMOKE_SHOT_FAIL', e);
        }
        app.quit();
      }, 7000);
    });
  }

  // 外部链接一律走系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  mainWindow.on('closed', () => {
    logLine('[window] closed');
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  ensureDataFile();
  readState();
  // macOS 保留最小菜单，确保 ⌘C/⌘V/⌘Q 等快捷键可用；其他平台隐藏菜单栏
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
    );
  } else {
    Menu.setApplicationMenu(null);
  }
  createWindow();
  console.log(`[fling-app] 已启动 · Electron ${process.versions.electron} · ${process.platform} · 数据 ${dataFile()}`);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  logLine('[lifecycle] window-all-closed · platform =', process.platform);
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  logLine('[lifecycle] before-quit');
  // 退出前把防抖中的状态立刻落盘，避免「收藏/改设置后立即退出」丢数据
  if (writeTimer) persistState();
});
app.on('will-quit', () => logLine('[lifecycle] will-quit'));
app.on('quit', (_e, code) => logLine('[lifecycle] quit · exitCode =', code));

// 渲染进程主动上报的错误
ipcMain.handle('log:renderer', async (_e, { level = 'info', message = '', stack = '' } = {}) => {
  logLine(`[renderer:${level}]`, message, stack ? '\n' + stack : '');
  return { ok: true };
});

/* ------------------------------------------------------------------ */
/* IPC：数据                                                            */
/* ------------------------------------------------------------------ */

ipcMain.handle('data:get', async () => {
  try {
    ensureDataFile();
    const raw = JSON.parse(await fsp.readFile(dataFile(), 'utf8'));
    return {
      ok: true,
      meta: raw.meta || {},
      trainers: raw.trainers || [],
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e), trainers: [], meta: {} };
  }
});

ipcMain.handle('data:bootstrapFromSite', async () => {
  // 本地没有数据时，直接从主站抓一份
  return runRefresh({ force: false });
});

let refreshing = false;
async function runRefresh({ force = false } = {}) {
  if (refreshing) return { ok: false, error: '正在刷新中' };
  refreshing = true;
  const send = (p) => mainWindow && mainWindow.webContents.send('data:progress', p);
  try {
    const mod = await import(pathToFileURL(path.join(scriptsDir(), 'build-data.mjs')).href);
    let previous = null;
    try {
      previous = JSON.parse(await fsp.readFile(dataFile(), 'utf8'));
    } catch {}
    const payload = await mod.buildData({
      force,
      previous,
      outFile: dataFile(),
      onProgress: (p) => send(p),
    });
    send({ phase: 'done', message: `已更新 ${payload.meta.count} 条`, count: payload.meta.count });
    return { ok: true, meta: payload.meta, trainers: payload.trainers };
  } catch (e) {
    send({ phase: 'error', message: '刷新失败：' + String(e.message || e) });
    return { ok: false, error: String(e.message || e) };
  } finally {
    refreshing = false;
  }
}

ipcMain.handle('data:refresh', async (_e, { force = false } = {}) => runRefresh({ force }));

/* ------------------------------------------------------------------ */
/* IPC：状态（收藏 / 下载 / 最近 / 隐藏 / 设置）                          */
/* ------------------------------------------------------------------ */

ipcMain.handle('state:get', async () => ({ ok: true, state: readState() }));

ipcMain.handle('state:set', async (_e, patch = {}) => {
  const s = readState();
  if (patch.settings) s.settings = { ...s.settings, ...patch.settings };
  if (patch.favorites) s.favorites = patch.favorites;
  if (patch.downloads) s.downloads = patch.downloads;
  if (patch.recent) s.recent = patch.recent;
  if (patch.hidden) s.hidden = patch.hidden;
  writeState();
  return { ok: true, state: s };
});

/* ------------------------------------------------------------------ */
/* IPC：下载                                                            */
/* ------------------------------------------------------------------ */

const activeDownloads = new Map(); // slug -> AbortController

function sanitize(name) {
  return String(name || 'trainer')
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function defaultDownloadDir() {
  const s = readState().settings;
  if (s.downloadDir) return s.downloadDir;
  return path.join(app.getPath('downloads'), '风灵月影修改器');
}

ipcMain.handle('download:start', async (_e, { slug, dlUrl, referer, fallbackName }) => {
  if (activeDownloads.has(slug)) return { ok: false, error: '该修改器正在下载中' };
  const controller = new AbortController();
  activeDownloads.set(slug, controller);

  const send = (p) => mainWindow && mainWindow.webContents.send('download:progress', { slug, ...p });
  let target = null;

  try {
    const dir = defaultDownloadDir();
    await fsp.mkdir(dir, { recursive: true });

    // 连接超时：30s 拿不到响应头就放弃；拿到后流式下载不限时（大文件慢网不受影响）
    const connCtrl = new AbortController();
    const connTimer = setTimeout(() => connCtrl.abort(), 30_000);
    let res;
    try {
      res = await fetch(dlUrl, {
        headers: { 'User-Agent': UA, Referer: referer || 'https://flingtrainer.com/' },
        redirect: 'follow',
        signal: AbortSignal.any([controller.signal, connCtrl.signal]),
      });
    } finally {
      clearTimeout(connTimer);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const cd = res.headers.get('content-disposition') || '';
    let filename = '';
    const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    const plain = /filename="?([^";]+)"?/i.exec(cd);
    if (star) filename = decodeURIComponent(star[1]);
    else if (plain) filename = plain[1];
    if (!filename) {
      try {
        filename = decodeURIComponent(new URL(res.url).pathname.split('/').filter(Boolean).pop() || '');
      } catch {}
    }
    if (!filename) filename = `${fallbackName || slug}.zip`;
    filename = sanitize(filename);
    if (!/\.[a-z0-9]{2,5}$/i.test(filename)) filename += '.zip';

    target = path.join(dir, filename);
    let n = 1;
    while (fs.existsSync(target) && n < 500) {
      const ext = path.extname(filename);
      target = path.join(dir, `${path.basename(filename, ext)} (${n++})${ext}`);
    }

    const total = Number(res.headers.get('content-length')) || 0;
    let received = 0;
    const started = Date.now();
    const nodeStream = Readable.fromWeb(res.body);
    nodeStream.on('data', (chunk) => {
      received += chunk.length;
      const pct = total ? Math.min(100, (received / total) * 100) : 0;
      const speed = received / Math.max(0.001, (Date.now() - started) / 1000);
      send({ state: 'downloading', received, total, percent: pct, speed });
    });
    await pipeline(nodeStream, fssync.createWriteStream(target));

    const stat = await fsp.stat(target);
    const s = readState();
    s.downloads[slug] = {
      file: target,
      name: path.basename(target),
      size: stat.size,
      at: new Date().toISOString(),
    };
    writeState();
    send({ state: 'done', file: target, size: stat.size });
    return { ok: true, file: target, size: stat.size, name: path.basename(target) };
  } catch (e) {
    const aborted = controller.signal.aborted;
    // 取消时清理已写入的半截文件，避免下载目录堆满 xxx (1).zip 半成品
    if (aborted && target) await fsp.rm(target, { force: true }).catch(() => {});
    send({ state: aborted ? 'canceled' : 'error', message: String(e.message || e) });
    return { ok: false, error: aborted ? '已取消' : String(e.message || e) };
  } finally {
    activeDownloads.delete(slug);
  }
});

ipcMain.handle('download:cancel', async (_e, { slug }) => {
  const c = activeDownloads.get(slug);
  if (c) c.abort();
  return { ok: true };
});

ipcMain.handle('download:delete', async (_e, { slug }) => {
  const s = readState();
  const rec = s.downloads[slug];
  if (!rec) return { ok: false, error: '没有下载记录' };
  try {
    if (rec.file && fs.existsSync(rec.file)) await fsp.rm(rec.file, { force: true });
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  delete s.downloads[slug];
  writeState();
  return { ok: true };
});

/* ------------------------------------------------------------------ */
/* IPC：运行本地修改器                                                   */
/* ------------------------------------------------------------------ */

/** 递归查找目录中与游戏名匹配的可执行文件 */
async function findExecutable(dir, names) {
  if (!dir || !fs.existsSync(dir)) return null;
  const keys = names
    .map((n) =>
      String(n || '')
        .toLowerCase()
        .replace(/trainer|修改器/g, '')
        .replace(/[^a-z0-9\u4e00-\u9fff]/g, ''),
    )
    .filter((k) => k.length >= 3);
  if (!keys.length) return null;

  const skipDir = new Set(['node_modules', '.git', '$RECYCLE.BIN', 'System Volume Information']);
  const exts =
    process.platform === 'win32'
      ? ['.exe', '.bat', '.cmd']
      : process.platform === 'darwin'
        ? ['.app', '.exe', '.command', '.sh']
        : ['.exe', '.sh', '.appimage', '.AppImage'];

  const queue = [{ d: dir, depth: 0 }];
  while (queue.length) {
    const { d, depth } = queue.shift();
    let entries = [];
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (depth < 3 && !skipDir.has(ent.name)) queue.push({ d: full, depth: depth + 1 });
        if (exts.includes(path.extname(ent.name).toLowerCase())) {
          const k = ent.name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
          if (keys.some((key) => k.includes(key) || key.includes(k))) return full;
        }
      } else {
        const ext = path.extname(ent.name).toLowerCase();
        if (!exts.includes(ext)) continue;
        const k = ent.name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
        if (keys.some((key) => k.includes(key) || key.includes(k))) return full;
      }
    }
  }
  return null;
}

function launchFile(file) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    try {
      let child;
      if (process.platform === 'win32') {
        child = spawn(file, [], { detached: true, stdio: 'ignore', cwd: path.dirname(file) });
      } else if (process.platform === 'darwin') {
        // .app 用 open -a；.exe 交给系统关联程序（如已安装 Wine）
        child = file.toLowerCase().endsWith('.app')
          ? spawn('open', ['-a', file], { detached: true, stdio: 'ignore' })
          : spawn('open', [file], { detached: true, stdio: 'ignore' });
      } else {
        child = spawn('xdg-open', [file], { detached: true, stdio: 'ignore' });
      }
      child.on('error', (err) => done({ ok: false, error: String(err.message || err) }));
      // open/xdg-open 对「文件不存在/无法打开」会返回非 0 退出码，但 error 事件不触发，
      // 必须靠 exit 判断，否则会误报「已启动」
      child.on('exit', (code) => {
        if (code !== 0) done({ ok: false, error: `启动失败（退出码 ${code}）` });
      });
      child.unref();
      setTimeout(() => done({ ok: true }), 600);
    } catch (e) {
      done({ ok: false, error: String(e.message || e) });
    }
  });
}

ipcMain.handle('launch:trainer', async (_e, { slug, cn, en }) => {
  const s = readState();
  const dir = s.settings.trainersDir;

  const candidates = [];
  const dl = s.downloads[slug];
  if (dl?.file && fs.existsSync(dl.file)) candidates.push(dl.file);

  let file = null;
  if (!dir) {
    return { ok: false, needDir: true, error: '还没有设置「本地修改器目录」' };
  }
  const found = await findExecutable(dir, [cn, en, slug]);
  if (found) file = found;

  if (!file) {
    return {
      ok: false,
      notFound: true,
      error: `在「${dir}」里没找到与《${cn || en}》匹配的可执行文件`,
      searched: candidates,
    };
  }

  const r = await launchFile(file);
  if (r.ok) {
    s.recent = [slug, ...s.recent.filter((x) => x !== slug)].slice(0, 60);
    writeState();
  }
  return { ...r, file };
});

/** 让用户手动指定要启动的文件 */
ipcMain.handle('launch:pickFile', async (_e, { slug, cn, en }) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: `选择《${cn || en}》的修改器程序`,
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return { ok: false, error: '已取消' };
  const r = await launchFile(filePaths[0]);
  if (r.ok) {
    const s = readState();
    s.recent = [slug, ...s.recent.filter((x) => x !== slug)].slice(0, 60);
    writeState();
  }
  return { ...r, file: filePaths[0] };
});

/* ------------------------------------------------------------------ */
/* IPC：封面缓存 / 系统交互                                              */
/* ------------------------------------------------------------------ */

const coverMem = new Map();

ipcMain.handle('cover:ensure', async (_e, { url }) => {
  if (!url) return { ok: false };
  if (coverMem.has(url)) return { ok: true, path: coverMem.get(url) };
  const hash = crypto.createHash('md5').update(url).digest('hex');
  const ext = (path.extname(new URL(url).pathname) || '.jpg').split('?')[0];
  const file = path.join(coversDir(), hash + ext);
  try {
    if (!fs.existsSync(file)) {
      await fsp.mkdir(coversDir(), { recursive: true });
      const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://flingtrainer.com/' }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      await pipeline(Readable.fromWeb(res.body), fssync.createWriteStream(file));
    }
    const p = pathToFileURL(file).href;
    coverMem.set(url, p);
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('shell:openExternal', async (_e, { url }) => {
  // 只放行 http/https，避免数据文件被篡改后诱导打开 file:// 等危险协议
  try {
    if (url && ['http:', 'https:'].includes(new URL(url).protocol)) shell.openExternal(url);
  } catch {
    /* 非法 URL 忽略 */
  }
  return { ok: true };
});
ipcMain.handle('shell:showItem', async (_e, { file }) => {
  if (file && fs.existsSync(file)) shell.showItemInFolder(file);
  else if (file) shell.openPath(path.dirname(file));
  return { ok: true };
});
ipcMain.handle('dialog:pickDir', async (_e, { title } = {}) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: title || '选择目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths.length) return { ok: false };
  return { ok: true, dir: filePaths[0] };
});
ipcMain.handle('app:info', async () => ({
  ok: true,
  version: app.getVersion(),
  platform: process.platform,
  home: os.homedir(),
  userData: userData(),
  downloadDir: defaultDownloadDir(),
}));
ipcMain.handle('app:openPath', async (_e, { p }) => {
  if (p) {
    if (!fs.existsSync(p)) await fsp.mkdir(p, { recursive: true }).catch(() => {});
    shell.openPath(p);
  }
  return { ok: true };
});
ipcMain.handle('app:resetState', async () => {
  stateCache = EMPTY_STATE();
  writeState();
  return { ok: true, state: stateCache };
});

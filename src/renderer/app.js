/* 风灵月影修改器合集 —— 渲染层 */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// 把渲染进程里的报错回传给主进程日志，便于排查闪退
window.addEventListener('error', (e) => {
  try {
    window.api?.log({ level: 'error', message: `${e.message} @ ${e.filename}:${e.lineno}`, stack: e.error?.stack || '' });
  } catch {}
});
window.addEventListener('unhandledrejection', (e) => {
  try {
    window.api?.log({ level: 'error', message: 'unhandledrejection: ' + (e.reason?.message || e.reason), stack: e.reason?.stack || '' });
  } catch {}
});

const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M6 4l14 8-14 8z"/></svg>',
  playSolid: '<svg viewBox="0 0 24 24"><path d="M6 4l14 8-14 8z"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 11l5 5 5-5M4 21h16"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="M12 3.6l2.6 5.3 5.9.85-4.25 4.14 1 5.86L12 17l-5.25 2.75 1-5.86L3.5 9.75l5.9-.85z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 007 0l2-2a5 5 0 00-7-7l-1 1"/><path d="M14 11a5 5 0 00-7 0l-2 2a5 5 0 007 7l1-1"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
};

let DATA = { meta: {}, trainers: [] };
let APPINFO = null;
let ST = { favorites: [], downloads: {}, activeTrainers: {}, recent: [], hidden: [], settings: {} };
let ui = { tab: 'all', q: '', sort: 'updated' };
let list = [];      // 当前筛选排序后的列表
let page = 1;       // 当前页码（从 1 开始）
let pageCount = 1;  // 总页数
const PAGE = 72;    // 每页条数
let booted = false;

/* ---------------- 工具 ---------------- */

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 2400);
  setTimeout(() => el.remove(), 2800);
}

function ask(title, text, okLabel = '确定') {
  return new Promise((resolve) => {
    $('#cfTitle').textContent = title;
    $('#cfText').textContent = text;
    $('#cfYes').textContent = okLabel;
    $('#confirm').hidden = false;
    const done = (v) => { $('#confirm').hidden = true; $('#cfYes').onclick = $('#cfNo').onclick = null; resolve(v); };
    $('#cfYes').onclick = () => done(true);
    $('#cfNo').onclick = () => done(false);
  });
}

function fmtSize(bytes) {
  if (!bytes) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function fmtDate(v) {
  if (!v) return '—';
  const d = new Date(v.replace(' ', 'T'));
  if (isNaN(d)) return v;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function status(left, right) {
  if (left !== undefined) $('#statusText').textContent = left;
  if (right !== undefined) $('#statusRight').textContent = right;
}

function setProgress(pct) {
  const w = $('#progressWrap');
  if (pct === null) { w.hidden = true; return; }
  w.hidden = false;
  $('#progressBar').style.width = Math.max(0, Math.min(100, pct)) + '%';
}

async function saveState(patch) {
  const r = await window.api.setState(patch);
  if (r?.ok) ST = r.state;
  updateBadges();
}

/* ---------------- 启动 ---------------- */

async function init() {
  const [d, s, info] = await Promise.all([window.api.getData(), window.api.getState(), window.api.appInfo()]);
  ST = s?.state || ST;
  APPINFO = info;
  DATA = { meta: d?.meta || {}, trainers: d?.trainers || [] };

  applyAppearance();
  renderSettingsStatic(info);
  bindEvents();
  updateBadges();
  $$('#chips .chip[data-sort]').forEach((x) => x.classList.toggle('active', x.dataset.sort === ui.sort));

  if (!DATA.trainers.length) {
    renderEmpty(
      '还没有修改器数据',
      '点下面的按钮从风灵月影官网抓取一次（首次约 1–3 分钟）',
      '从主站抓取数据',
      async () => { await doRefresh(false); }
    );
    $('#brandSub').textContent = '暂无数据';
  } else {
    $('#brandSub').textContent = `${DATA.meta.count || DATA.trainers.length} 个修改器 · 更新于 ${fmtDate(DATA.meta.generatedAt)}`;
    applyFilter();
  }
  status('就绪', info?.platform || '');
  booted = true;
}

function renderEmpty(title, hint, btnLabel, onClick) {
  const e = $('#empty');
  e.hidden = false;
  e.innerHTML = '';
  const strong = document.createElement('strong');
  strong.textContent = title;
  const p = document.createElement('div');
  p.textContent = hint;
  e.append(strong, p);
  if (btnLabel) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.style.marginTop = '16px';
    b.textContent = btnLabel;
    b.onclick = onClick;
    e.appendChild(b);
  }
}

function applyAppearance() {
  document.body.classList.remove('size-sm', 'size-md', 'size-lg');
  document.body.classList.add('size-' + (ST.settings.cardSize || 'md'));
  $$('#segSize button').forEach((b) => b.classList.toggle('on', b.dataset.size === (ST.settings.cardSize || 'md')));
  $$('#segCover button').forEach((b) => b.classList.toggle('on', (b.dataset.cover === '1') === !!ST.settings.coverCache));
  $$('#segHidden button').forEach((b) => b.classList.toggle('on', (b.dataset.hidden === '1') === !!ST.settings.showHidden));
  $('#setTrainersDir').value = ST.settings.trainersDir || '';
  $('#setDownloadDir').value = ST.settings.downloadDir || '';
}

function renderSettingsStatic(info = APPINFO) {
  $('#dataMeta').textContent = DATA.trainers.length
    ? `${DATA.trainers.length} 条 · 生成于 ${fmtDate(DATA.meta.generatedAt)} · 中文名 ${DATA.meta.cnSourceCount ?? '—'} 条来自官方对照`
    : '暂无数据，点右侧从主站刷新';
  $('#about').innerHTML =
    `版本 <code>${escapeHtml(info?.version || '1.0.0')}</code> · 平台 <code>${escapeHtml(info?.platform || '-')}</code><br>` +
    `数据来源：<code>flingtrainer.com</code>（仅作个人下载索引，修改器版权归原作者 FLiNG 所有）<br>` +
    `本地数据目录：<code>${escapeHtml(info?.userData || '')}</code><br>` +
    `下载目录：<code>${escapeHtml(info?.downloadDir || '')}</code>`;
}

function updateBadges() {
  const f = $('#badgeFav'), d = $('#badgeDl');
  f.hidden = !ST.favorites.length; f.textContent = ST.favorites.length;
  const n = Object.keys(ST.downloads || {}).length;
  d.hidden = !n; d.textContent = n;
}

/* ---------------- 筛选与排序 ---------------- */

// keepPage=true 时保持当前页码（用于收藏/删除等局部变更），否则回到第 1 页
function applyFilter(keepPage = false) {
  const q = ui.q.trim().toLowerCase();
  let arr = DATA.trainers.slice();

  if (ui.tab === 'fav') {
    const set = new Set(ST.favorites);
    arr = arr.filter((t) => set.has(slugOf(t)));
  } else if (ui.tab === 'dl') {
    arr = arr.filter((t) => ST.downloads[slugOf(t)]);
  }

  if (!ST.settings.showHidden) {
    const h = new Set(ST.hidden);
    arr = arr.filter((t) => !h.has(slugOf(t)));
  }

  if (q) {
    arr = arr.filter((t) => (t.cn || '').toLowerCase().includes(q) || (t.en || '').toLowerCase().includes(q));
  }

  if (ui.sort === 'updated') {
    arr.sort((a, b) => (b.lastUpdated || b.published || '').localeCompare(a.lastUpdated || a.published || ''));
  } else if (ui.sort === 'published') {
    arr.sort((a, b) => (b.published || '').localeCompare(a.published || ''));
  } else if (ui.sort === 'recent') {
    const idx = new Map(ST.recent.map((s, i) => [s, i]));
    arr.sort((a, b) => (idx.has(slugOf(a)) ? idx.get(slugOf(a)) : 1e9) - (idx.has(slugOf(b)) ? idx.get(slugOf(b)) : 1e9));
  }

  list = arr;
  pageCount = Math.max(1, Math.ceil(list.length / PAGE));
  if (!keepPage) page = 1;
  if (page > pageCount) page = pageCount;   // 删除后当前页可能越界
  if (page < 1) page = 1;

  renderGrid();
  updateListHead();
  renderPager();
  if (!keepPage) $('#viewMain').scrollTop = 0;
}

function slugOf(t) {
  return t.slug || (t.url || '').replace(/\/$/, '').split('/').pop();
}

function updateListHead() {
  const names = { all: '全部修改器', fav: '我的收藏', dl: '我的下载' };
  $('#listCount').textContent = `${names[ui.tab] || ''} · 共 ${list.length} 个`;
  const head = ui.q ? `筛选「${ui.q}」` : '';
  const pager = pageCount > 1 ? `第 ${page} / ${pageCount} 页` : '';
  $('#listHint').textContent = [head, pager].filter(Boolean).join(' · ');
}

/* ---------------- 网格渲染 ---------------- */

const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) {
      const img = e.target;
      io.unobserve(img);
      loadCover(img);
    }
  }
}, { root: $('#viewMain'), rootMargin: '320px' });

async function loadCover(img) {
  const remote = img.dataset.src;
  if (!remote) return;
  if (ST.settings.coverCache) {
    const r = await window.api.coverEnsure({ url: remote });
    img.src = r?.ok ? r.path : remote;
  } else {
    img.src = remote;
  }
  img.onerror = () => { img.remove(); };
}

// 按当前页码整页重绘
function renderGrid() {
  const grid = $('#grid');
  grid.innerHTML = '';
  const start = (page - 1) * PAGE;
  const next = list.slice(start, start + PAGE);
  const frag = document.createDocumentFragment();
  for (const t of next) frag.appendChild(cardEl(t));
  grid.appendChild(frag);

  $('#empty').hidden = list.length > 0;
  if (list.length === 0) {
    const msg = ui.tab === 'fav' ? ['还没有收藏', '在卡片上点「收藏」即可加入这里']
      : ui.tab === 'dl' ? ['还没有下载', '在卡片上点「下载」，完成后会出现在这里']
      : ['没有找到匹配的修改器', '换个关键词试试'];
    renderEmpty(msg[0], msg[1]);
  }
}

// 生成要显示的页码序列：[1, '...', 6,7,8, '...', 20]
function pageSeq(cur, total) {
  const set = new Set([1, total]);
  let start = Math.max(1, cur - 2);
  let end = Math.min(total, cur + 2);
  if (end - start < 4) {                 // 页码窗口恒为 5 页，贴边时向外补足
    if (start === 1) end = Math.min(total, start + 4);
    else start = Math.max(1, end - 4);
  }
  for (let i = start; i <= end; i++) set.add(i);
  const nums = [...set].sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const v of nums) {
    if (prev && v - prev > 1) out.push('...');
    out.push(v);
    prev = v;
  }
  return out;
}

// 跳转到指定页
function gotoPage(n) {
  const target = Math.min(pageCount, Math.max(1, Math.trunc(n) || 1));
  // 提前返回时也要把跳转框拉回真实页码，否则输入 99 / 0 / 非数字会留下非法值
  if (target === page) {
    const box = document.querySelector('#pager .jump input');
    if (box) box.value = String(page);
    return;
  }
  page = target;
  renderGrid();
  updateListHead();
  renderPager();
  $('#viewMain').scrollTop = 0;
}

function renderPager() {
  const el = $('#pager');
  el.innerHTML = '';
  if (pageCount <= 1) { el.hidden = true; return; }
  el.hidden = false;

  const mkBtn = (label, target, cls = '', disabled = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (cls) b.className = cls;
    b.disabled = disabled;
    if (typeof target === 'number') b.onclick = () => gotoPage(target);
    return b;
  };

  el.appendChild(mkBtn('‹ 上一页', page - 1, '', page === 1));

  for (const v of pageSeq(page, pageCount)) {
    if (v === '...') {
      const e = document.createElement('button');
      e.type = 'button';
      e.className = 'ellipsis';
      e.textContent = '…';
      e.disabled = true;
      e.tabIndex = -1;
      el.appendChild(e);
    } else {
      el.appendChild(mkBtn(String(v), v, v === page ? 'on' : '', false));
    }
  }

  el.appendChild(mkBtn('下一页 ›', page + 1, '', page === pageCount));

  const info = document.createElement('span');
  info.className = 'pager-info';
  info.textContent = `第 ${page} / ${pageCount} 页 · 共 ${list.length} 条`;
  el.appendChild(info);

  const jump = document.createElement('label');
  jump.className = 'jump';
  jump.appendChild(document.createTextNode('跳至'));
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '1';
  input.max = String(pageCount);
  input.value = String(page);
  input.setAttribute('aria-label', '跳转到第几页');
  const go = () => gotoPage(parseInt(input.value, 10));
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
  const goBtn = mkBtn('GO', null, '', false);
  goBtn.onclick = go;
  jump.appendChild(input);
  jump.appendChild(document.createTextNode('页'));
  jump.appendChild(goBtn);
  el.appendChild(jump);
}

function cardEl(t) {
  const slug = slugOf(t);
  const dl = ST.downloads[slug];
  const active = ST.activeTrainers?.[slug];
  const fav = ST.favorites.includes(slug);

  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.slug = slug;

  const cover = document.createElement('div');
  cover.className = 'cover';
  const img = document.createElement('img');
  img.alt = t.cn || t.en;
  if (t.cover) {
    img.dataset.src = t.cover;
    io.observe(img); // 进入可视区域时才真正拉取封面
  }
  cover.appendChild(img);
  const ph = document.createElement('div');
  ph.className = 'ph';
  ph.textContent = (t.cn || t.en || '?').slice(0, 1);
  cover.appendChild(ph);
  if (fav) { const b = document.createElement('span'); b.className = 'badge-corner fav'; b.textContent = '已收藏'; cover.appendChild(b); }
  if (active) { const b = document.createElement('span'); b.className = 'badge-corner started'; b.textContent = '已启动'; cover.appendChild(b); }
  else if (dl) { const b = document.createElement('span'); b.className = 'badge-corner ok'; b.textContent = '已下载'; cover.appendChild(b); }

  const ov = document.createElement('div');
  ov.className = 'ov';
  const pv = document.createElement('button');
  pv.className = 'pv'; pv.title = '查看详情'; pv.innerHTML = ICON.playSolid;
  pv.style.fill = 'currentColor';
  ov.appendChild(pv);
  cover.appendChild(ov);
  pv.onclick = (e) => { e.stopPropagation(); openDrawer(t); };
  cover.onclick = () => openDrawer(t);
  card.appendChild(cover);

  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = t.cn || t.en.replace(/\s*Trainer$/i, '');
  title.title = `${t.cn}\n${t.en}`;
  card.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  const parts = [];
  if (t.options) parts.push(`${t.options} 项`);
  if (t.lastUpdated) parts.push(`更新 ${t.lastUpdated}`);
  if (active) parts.push('已启动');
  meta.textContent = parts.join(' · ') || '—';
  card.appendChild(meta);

  const acts = document.createElement('div');
  acts.className = 'actions';

  const primary = document.createElement('button');
  primary.className = 'act ' + (active ? 'stop' : dl ? 'run' : 'dl');
  primary.title = active ? '关闭修改器' : dl ? '运行修改器' : '下载修改器';
  primary.innerHTML = (active ? ICON.stop : dl ? ICON.play : ICON.down) + `<span>${active ? '关闭' : dl ? '运行' : '下载'}</span>`;
  primary.onclick = (e) => { e.stopPropagation(); active ? doStop(t) : dl ? doRun(t) : doDownload(t); };
  acts.appendChild(primary);

  const favBtn = document.createElement('button');
  favBtn.className = 'act fav' + (fav ? ' on' : '');
  favBtn.innerHTML = ICON.star + `<span>${fav ? '已收藏' : '收藏'}</span>`;
  favBtn.onclick = (e) => { e.stopPropagation(); doFav(t); };
  acts.appendChild(favBtn);

  const delBtn = document.createElement('button');
  delBtn.className = 'act del';
  delBtn.innerHTML = ICON.trash + '<span>删除</span>';
  delBtn.onclick = (e) => { e.stopPropagation(); doDelete(t); };
  acts.appendChild(delBtn);

  card.appendChild(acts);
  return card;
}

/* ---------------- 操作 ---------------- */

async function doFav(t) {
  const slug = slugOf(t);
  const i = ST.favorites.indexOf(slug);
  if (i >= 0) ST.favorites.splice(i, 1); else ST.favorites.unshift(slug);
  await saveState({ favorites: ST.favorites });
  if (i >= 0) {
    document.querySelector(`.card[data-slug="${CSS.escape(slug)}"]`)?.remove();
  } else {
    const card = document.querySelector(`.card[data-slug="${CSS.escape(slug)}"]`);
    if (card) card.replaceWith(cardEl(t));
  }
  if (ui.tab === 'fav') applyFilter(true);
  toast(i >= 0 ? '已取消收藏' : '已收藏');
}

async function doDelete(t) {
  const slug = slugOf(t);
  const dl = ST.downloads[slug];
  if (dl) {
    const ok = await ask('删除已下载的修改器', `将删除本地文件：\n${dl.name}\n\n此操作不可撤销。`, '删除');
    if (!ok) return;
    const r = await window.api.downloadDelete({ slug });
    if (!r.ok) return toast('删除失败：' + (r.error || ''), 'err');
    await refreshStateAndView();
    toast('已删除本地文件', 'ok');
    return;
  }
  if (ST.favorites.includes(slug)) {
    const ok = await ask('移除收藏', '该条目已收藏，是否一并移除？', '移除');
    if (ok) { ST.favorites = ST.favorites.filter((s) => s !== slug); }
  } else {
    const ok = await ask('从列表移除', '将从当前列表隐藏该条目（可在「设置 → 显示已删除的条目」中恢复）。', '移除');
    if (!ok) return;
  }
  ST.hidden = [...new Set([...ST.hidden, slug])];
  await saveState({ hidden: ST.hidden, favorites: ST.favorites });
  toast('已从列表移除');
  applyFilter(true);
}

async function doDownload(t, dlUrl) {
  const slug = slugOf(t);
  const files = t.downloads || [];
  const pick = dlUrl ? files.find((f) => f.url === dlUrl) : files[0];
  if (!pick) {
    toast('该修改器暂无下载地址，已为你打开官网页面', 'err');
    window.api.openExternal({ url: t.url });
    return;
  }
  status(`正在下载《${t.cn}》…`, '0%');
  setProgress(0);
  const r = await window.api.downloadStart({
    slug,
    dlUrl: pick.url,
    referer: t.url,
    fallbackName: t.cn || slug,
  });
  if (!r.ok && r.error !== '已取消') toast('下载失败：' + r.error, 'err');
}

async function doStop(t) {
  const r = await window.api.stopTrainer({ slug: slugOf(t) });
  if (!r.ok) {
    if (r.notRunning) await refreshStateAndView();
    else toast('关闭修改器失败：' + (r.error || ''), 'err');
    return;
  }
  await refreshStateAndView();
  toast(`已关闭《${t.cn}》修改器`);
}

async function doRun(t) {
  const slug = slugOf(t);
  if (ST.downloads[slug]) status(`正在启动《${t.cn}》…`);
  const r = await window.api.launch({ slug, cn: t.cn, en: t.en });

  if (r.alreadyRunning) {
    await refreshStateAndView();
    toast(`《${t.cn}》修改器已经在运行，只能保留一个实例。`);
    return;
  }
  if (r.launching) {
    toast(`《${t.cn}》修改器正在启动，请稍候。`);
    return;
  }
  if (r.pending) {
    status('等待系统启动确认', '');
    toast('已请求系统启动，请确认弹出的系统提示。');
    return;
  }
  if (r.ok) {
    toast(`已启动《${t.cn}》`, 'ok');
    status('就绪', '');
    ST.recent = [slug, ...ST.recent.filter((x) => x !== slug)].slice(0, 60);
    await refreshStateAndView();
    if (ui.tab === 'recent' || ui.sort === 'recent') applyFilter(true);
    return;
  }
  if (r.needsExtraction) {
    if (r.archive) window.api.showItem({ file: r.archive });
    toast(`${r.error} 已打开压缩包所在位置。`, 'err');
    return;
  }
  if (r.needDir) {
    const go = await ask('还没有设置修改器目录', '点「运行」时需要在本地目录里查找对应的修改器程序。\n现在去设置？', '去设置');
    if (go) switchTab('settings');
    return;
  }
  if (r.notFound) {
    const go = await ask('没找到修改器程序', `${r.error}\n\n可以手动指定要启动的程序，或先去下载。`, '手动选择');
    if (go) {
      const r2 = await window.api.launchPickFile({ slug, cn: t.cn, en: t.en });
      if (r2.ok) toast(`已启动《${t.cn}》`, 'ok');
      else if (r2.error !== '已取消') toast('启动失败：' + r2.error, 'err');
    }
    return;
  }
  toast('启动失败：' + (r.error || ''), 'err');
}

/* ---------------- 详情抽屉 ---------------- */

function openDrawer(t) {
  const slug = slugOf(t);
  const dl = ST.downloads[slug];
  const active = ST.activeTrainers?.[slug];
  const files = t.downloads || [];

  $('#dTitle').textContent = t.cn || t.en;
  const body = $('#dBody');
  body.innerHTML = '';

  if (t.cover) {
    const img = document.createElement('img');
    img.className = 'd-cover'; img.src = t.cover; img.onerror = () => img.remove();
    body.appendChild(img);
  }
  const en = document.createElement('div');
  en.className = 'd-en'; en.textContent = t.en;
  body.appendChild(en);

  const grid = document.createElement('dl');
  grid.className = 'd-grid';
  const rows = [
    ['修改项', t.options ? `${t.options} 项` : '—'],
    ['支持版本', t.gameVersion || '—'],
    ['最后更新', t.lastUpdated || '—'],
    ['发布时间', fmtDate(t.published)],
    ['本地状态', [active ? '已启动' : '', dl ? `已下载 · ${dl.name}` : ''].filter(Boolean).join(' · ') || '未下载'],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    grid.append(dt, dd);
  }
  body.appendChild(grid);

  const acts = document.createElement('div');
  acts.className = 'd-actions';
  const mk = (label, cls, fn) => {
    const b = document.createElement('button');
    b.className = 'btn ' + cls; b.textContent = label; b.onclick = fn;
    return b;
  };
  acts.appendChild(mk(active ? '关闭' : dl ? '运行' : '下载', active ? 'danger' : '', () => (active ? doStop(t) : dl ? doRun(t) : doDownload(t))));
  acts.appendChild(mk(ST.favorites.includes(slug) ? '取消收藏' : '收藏', 'ghost', () => doFav(t)));
  if (dl) acts.appendChild(mk('打开所在目录', 'ghost', () => window.api.showItem({ file: dl.file })));
  acts.appendChild(mk('访问官网页面', 'ghost', () => window.api.openExternal({ url: t.url })));
  body.appendChild(acts);

  if (t.optionList?.length) {
    const h = document.createElement('div'); h.className = 'd-sec'; h.textContent = `修改项列表（${t.optionList.length}）`;
    const wrap = document.createElement('div'); wrap.className = 'opt-list';
    t.optionList.forEach((o, i) => {
      const s = document.createElement('span');
      s.textContent = `${i + 1}. ${o}`;
      wrap.appendChild(s);
    });
    body.append(h, wrap);
  }

  if (files.length) {
    const h = document.createElement('div'); h.className = 'd-sec'; h.textContent = `下载文件（${files.length}）`;
    const tb = document.createElement('table'); tb.className = 'file-list';
    tb.innerHTML = '<thead><tr><th>文件</th><th>日期</th><th>大小</th><th></th></tr></thead>';
    const tbody = document.createElement('tbody');
    files.forEach((f) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="name">${escapeHtml(f.name || '(未命名)')}</td><td>${f.date || '—'}</td><td>${f.size || '—'}</td>`;
      const td = document.createElement('td');
      const b = document.createElement('button');
      b.className = 'btn mini'; b.textContent = '下载';
      b.onclick = () => doDownload(t, f.url);
      td.appendChild(b); tr.appendChild(td);
      tbody.appendChild(tr);
    });
    tb.appendChild(tbody);
    body.append(h, tb);
  }

  $('#drawer').hidden = false;
  $('#scrim').hidden = false;
}

function closeDrawer() { $('#drawer').hidden = true; $('#scrim').hidden = true; }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- Tab / 事件 ---------------- */

function switchTab(tab) {
  ui.tab = tab;
  $$('#tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('#viewMain').hidden = tab === 'settings';
  $('#viewSettings').hidden = tab !== 'settings';
  if (tab !== 'settings') {
    applyFilter();
    refreshStateAndView();
  }
  else renderSettingsStatic();
  $('#viewMain').scrollTop = 0;
}

function bindEvents() {
  $$('#tabs .tab').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));

  const search = $('#search');
  let timer;
  search.oninput = () => {
    $('#searchClear').hidden = !search.value;
    clearTimeout(timer);
    timer = setTimeout(() => { ui.q = search.value; applyFilter(); }, 120);
  };
  $('#searchClear').onclick = () => { search.value = ''; ui.q = ''; $('#searchClear').hidden = true; applyFilter(); };

  $$('#chips .chip[data-sort]').forEach((b) => {
    b.onclick = () => {
      ui.sort = b.dataset.sort;
      $$('#chips .chip[data-sort]').forEach((x) => x.classList.toggle('active', x === b));
      applyFilter();
    };
  });
  $('#btnRefresh').onclick = () => doRefresh(false);
  $('#btnRefreshFull').onclick = () => doRefresh(true);
  $('#btnRefreshQuick').onclick = () => doRefresh(false);

  $('#pickTrainersDir').onclick = async () => {
    const r = await window.api.pickDir({ title: '选择本地修改器目录' });
    if (r.ok) { ST.settings.trainersDir = r.dir; await saveState({ settings: ST.settings }); applyAppearance(); }
  };
  $('#pickDownloadDir').onclick = async () => {
    const r = await window.api.pickDir({ title: '选择下载目录' });
    if (r.ok) { ST.settings.downloadDir = r.dir; await saveState({ settings: ST.settings }); applyAppearance(); renderSettingsStatic(); }
  };
  $('#openTrainersDir').onclick = () => {
    if (!ST.settings.trainersDir) return toast('还没有设置目录');
    window.api.openPath({ p: ST.settings.trainersDir });
  };
  $('#openDownloadDir').onclick = () => window.api.openPath({ p: ST.settings.downloadDir || '' });

  $$('#segSize button').forEach((b) => (b.onclick = async () => {
    ST.settings.cardSize = b.dataset.size; await saveState({ settings: ST.settings }); applyAppearance();
  }));
  $$('#segCover button').forEach((b) => (b.onclick = async () => {
    ST.settings.coverCache = b.dataset.cover === '1'; await saveState({ settings: ST.settings }); applyAppearance(); applyFilter();
  }));
  $$('#segHidden button').forEach((b) => (b.onclick = async () => {
    ST.settings.showHidden = b.dataset.hidden === '1'; await saveState({ settings: ST.settings }); applyAppearance(); applyFilter();
  }));

  $('#btnReset').onclick = async () => {
    const ok = await ask('重置本地记录', '将清空收藏、下载记录、最近使用与全部设置。\n已下载到硬盘的文件不会被删除。', '重置');
    if (!ok) return;
    const r = await window.api.resetState();
    ST = r.state;
    applyAppearance(); updateBadges(); applyFilter();
    toast('已重置', 'ok');
  };

  $('#dClose').onclick = closeDrawer;
  $('#scrim').onclick = closeDrawer;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeDrawer(); $('#confirm').hidden = true; }
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); $('#search').focus(); }
  });

  // 主进程进度
  window.api.onDownloadProgress((p) => {
    if (p.state === 'downloading') {
      const pct = p.total ? p.percent : 0;
      setProgress(p.total ? pct : null);
      status(`下载中… ${fmtSize(p.received)}${p.total ? ' / ' + fmtSize(p.total) : ''} · ${fmtSize(p.speed)}/s`, p.total ? pct.toFixed(0) + '%' : '');
    } else if (p.state === 'done') {
      setProgress(null); status('就绪', '');
      if (p.executable) {
        toast('下载并解压完成，现可点击「运行」', 'ok');
      } else {
        toast(`下载完成，但未能自动解压：${p.extractionError || '未识别到修改器程序'}`, 'err');
        if (p.file) window.api.showItem({ file: p.file });
      }
      refreshStateAndView();
    } else if (p.state === 'error') {
      setProgress(null); status('就绪', ''); toast('下载失败：' + p.message, 'err');
    } else if (p.state === 'canceled') {
      setProgress(null); status('就绪', ''); toast('已取消下载');
    }
  });

  window.api.onDataProgress((p) => {
    if (p.phase === 'done') { setProgress(100); setTimeout(() => setProgress(null), 600); }
    const pct = p.total ? (p.done || 0) / p.total * 100 : null;
    if (pct !== null) setProgress(pct);
    status(p.message || '正在刷新…', pct !== null ? pct.toFixed(0) + '%' : '');
  });
}

async function refreshStateAndView() {
  const s = await window.api.getState();
  ST = s.state;
  updateBadges();
  applyFilter(true);
}

async function doRefresh(force) {
  if (!force) {
    const ok = await ask('从主站刷新数据', '将重新访问 flingtrainer.com 获取最新修改器列表与中文名。\n增量更新只抓取新增条目，速度更快。', '开始');
    if (!ok) return;
  }
  const btn = force ? $('#btnRefreshFull') : $('#btnRefresh');
  btn.disabled = true;
  status('正在刷新数据…');
  setProgress(0);
  const r = await window.api.refreshData({ force });
  btn.disabled = false;
  setProgress(null);
  if (!r.ok) { status('就绪', ''); return toast('刷新失败：' + r.error, 'err'); }
  DATA = { meta: r.meta, trainers: r.trainers };
  $('#brandSub').textContent = `${DATA.meta.count} 个修改器 · 更新于 ${fmtDate(DATA.meta.generatedAt)}`;
  renderSettingsStatic();
  applyFilter();
  toast(`已更新，共 ${DATA.meta.count} 个修改器`, 'ok');
  status('就绪', '');
}

window.addEventListener('DOMContentLoaded', init);

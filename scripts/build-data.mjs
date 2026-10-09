/**
 * 数据构建脚本 —— 抓取风灵月影（FLiNG Trainer）主站全量修改器数据
 *
 * 数据来源：
 *   1. https://flingtrainer.com/all-trainers/        主站 A-Z 总表（英文名 + 链接）
 *   2. https://flingtrainer.com/cn/community/forums/trainer-release/  中文论坛帖
 *      → 标题格式《中文名（English Name）》修改器，作为「官方中文名」来源
 *   3. 每个 trainer 详情页 → 封面图、支持版本、最后更新、修改项数量、下载地址
 *
 * 用法：
 *   node scripts/build-data.mjs             # 增量：已有条目不重复抓详情页
 *   node scripts/build-data.mjs --force     # 全量：重新抓取所有详情页
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'data', 'trainers.json');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const SITE = 'https://flingtrainer.com';
const ALL_TRAINERS = `${SITE}/all-trainers/`;
const FORUM = `${SITE}/cn/community/forums/trainer-release/`;

const CONCURRENCY = 4;
const RETRY = 4;

/* ------------------------------------------------------------------ */
/* 基础工具                                                             */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–');
}

/** 归一化英文名，用于中英对照匹配 */
function normKey(s) {
  return decodeEntities(s || '')
    .replace(/\s*Trainer\s*$/i, '')
    .replace(/\s*修改器\s*$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

async function fetchText(url) {
  let lastErr;
  for (let i = 0; i < RETRY; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      await sleep(700 * (i + 1) + Math.random() * 400);
    }
  }
  throw lastErr;
}

/** 并发池 */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  let done = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (e) {
        results[idx] = { __error: String(e && e.message ? e.message : e) };
      }
      done++;
    }
  });
  await Promise.all(runners);
  return { results, done };
}

/* ------------------------------------------------------------------ */
/* 1. 主站总表                                                          */
/* ------------------------------------------------------------------ */

export function parseAllTrainers(html) {
  const out = [];
  const seen = new Set();
  const re = /<a href="(https:\/\/flingtrainer\.com\/trainer\/[^"]+)"\s*>\s*([\s\S]*?)\s*<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const url = m[1];
    const en = decodeEntities(m[2].replace(/\s+/g, ' ').trim());
    if (!en || seen.has(url)) continue;
    seen.add(url);
    out.push({ en, url });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 2. 中文论坛帖 → 官方中文名                                            */
/* ------------------------------------------------------------------ */

export function parseForumPage(html) {
  const rows = [];
  const re = /<div class="structItem-title">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(html))) {
    const a = /<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(m[1]);
    if (!a) continue;
    rows.push(decodeEntities(a[2].replace(/<[^>]+>/g, '').trim()));
  }
  return rows;
}

/** 把《中文名（English Name）》拆成 {key, cn, raw} */
export function splitTitle(raw) {
  const t = raw.replace(/\s*修改器\s*$/, '').trim();
  const mm = /^《([\s\S]+)》\s*([\s\S]*)$/.exec(t);
  const body = mm ? mm[1] : t;
  const brackets = [...body.matchAll(/[（(]([A-Za-z][^（()）]*?)[）)]/g)].map((x) => x[1].trim());
  const head = (/^([^（(]+)/.exec(body) || [, ''])[1].trim();
  if (brackets.length) {
    const en = brackets[brackets.length - 1];
    const cn = /[\u4e00-\u9fff]/.test(head) ? head : '';
    // 括号里的中文也可能才是名字（英文在前的情况）
    return { key: normKey(en), cn: cn || head, raw };
  }
  return { key: normKey(body), cn: body.trim(), raw };
}

export async function fetchForumNames(onProgress) {
  const mapping = new Map();
  let page = 1;
  let lastPage = 1;
  for (; page <= 60; page++) {
    const url = page === 1 ? FORUM : `${FORUM}page-${page}`;
    let html;
    try {
      html = await fetchText(url);
    } catch {
      break;
    }
    const titles = parseForumPage(html);
    if (!titles.length) break;
    for (const raw of titles) {
      const { key, cn } = splitTitle(raw);
      if (key && cn && !mapping.has(key)) mapping.set(key, cn);
    }
    if (page === 1) {
      const nums = [...html.matchAll(/forums\/trainer-release\/page-(\d+)/g)].map((x) => +x[1]);
      if (nums.length) lastPage = Math.max(...nums);
    }
    if (onProgress) onProgress({ phase: 'forum', page, lastPage });
    if (page >= lastPage) break;
    await sleep(150);
  }
  return mapping;
}

/**
 * 论坛帖里没带英文名、或英文写法与主站不一致的游戏，逐一人工校对。
 * 来源同样是风灵月影中文论坛帖标题，键为归一化英文名。
 */
export const MANUAL_CN = {
  ageofwondersplanetfall: '奇迹时代：星陨',
  ancestorsthehumankindodyssey: '先祖：人类奥德赛',
  atelierryzaeverdarknessthesecrethideout: '莱莎的炼金工房 ～常暗女王与秘密藏身处～',
  azurlanecrosswave: '碧蓝航线：Crosswave',
  aplaguetaleinnocence: '瘟疫传说：无罪',
  blasphemous: '渎神',
  bloodstainedritualofthenight: '血污：夜之仪式',
  bloodyspell: '嗜血印',
  bulletgirlsphantasia: '子弹少女：幻想',
  commandos2hdremaster: '盟军敢死队2：高清重置版',
  conanunconquered: '不屈者柯南',
  contraroguecorps: '魂斗罗：RC联盟',
  cryingsuns: '哀恸之日',
  darksidersgenesis: '暗黑血统：创世纪',
  daymare1998: '白日噩梦：1998',
  deadoralive6: '死或生6',
  deathendrequest: '死亡终局：轮回试炼',
  devilshunt: '恶魔狩猎',
  digimonstorycybersleuthcompleteedition: '数码宝贝物语：网路侦探骇客追忆',
  discoelysium: '极乐迪斯科：最终剪辑版',
  divinityoriginalsin2definitiveedition: '神界：原罪2 终极版',
  doraemonstoryofseasons: '哆啦A梦：大雄的牧场物语',
  dragonquestbuilders2: '勇者斗恶龙：创世小玩家2',
  dragonquestxisechoesofanelusiveagedefinitiveedition: '勇者斗恶龙11S：寻觅逝去的时光',
  earthdefenseforce5: '地球防卫军5',
  efootballpes2020: '实况足球2020',
  eldenringshadowoftheerdtree: '艾尔登法环：黄金树幽影',
  finalfantasyiiipixelremaster: '最终幻想3 像素复刻版',
  finalfantasyiipixelremaster: '最终幻想2 像素复刻版',
  finalfantasyivpixelremaster: '最终幻想4 像素复刻版',
  finalfantasyviiiremastered: '最终幻想8：重制版',
  finalfantasyvipixelremaster: '最终幻想6 像素复刻版',
  finalfantasyvpixelremaster: '最终幻想5 像素复刻版',
  finalfantasypixelremaster: '最终幻想 像素复刻版',
  gears5: '战争机器5',
  godeater3: '噬神者3',
  granbluefantasyversus: '碧蓝幻想Versus',
  greedfall: '贪婪之秋',
  greenhell: '绿色地狱',
  haloinfinitecampaign: '光环：无限（战役）',
  halothemasterchiefcollectionhalo2anniversary: '光环：士官长合集 - 光环2：周年版',
  halothemasterchiefcollectionhalo3: '光环：士官长合集 - 光环3',
  halothemasterchiefcollectionhalo3odst: '光环：士官长合集 - 光环3：地狱伞兵',
  halothemasterchiefcollectionhalo4: '光环：士官长合集 - 光环4',
  halothemasterchiefcollectionhaloceanniversary: '光环：士官长合集 - 光环：战斗进化周年版',
  halothemasterchiefcollectionhaloreach: '光环：士官长合集 - 光环：致远星',
  haydee2: 'Haydee 2',
  hitman2: '杀手2',
  horizonzerodawncompleteedition: '地平线：黎明时分',
  indivisible: '密不可分',
  isitwrongtotrytopickupgirlsinadungeoninfinitecombate: '在地下城寻求邂逅是否搞错了什么：无限战斗',
  kingdomcomedeliverance: '天国：拯救',
  masseffectlegendaryeditionmasseffect1: '质量效应：传奇版 - 质量效应1',
  masseffectlegendaryeditionmasseffect2: '质量效应：传奇版 - 质量效应2',
  masseffectlegendaryeditionmasseffect3: '质量效应：传奇版 - 质量效应3',
  mistover: '漩涡迷雾',
  monkeykingheroisback: '西游记：大圣归来',
  myfriendpedro: '我的朋友佩德罗',
  myheroonesjustice2: '我的英雄学院：一人的正义2',
  narcosriseofthecartels: '毒枭：卡特尔崛起',
  needforspeedheat: '极品飞车21：热度',
  ninjagaidenmastercollectionninjagaidensigma2: '忍者龙剑传：大师合集 - 西格玛2',
  ninjagaidenmastercollectionninjagaidensigma: '忍者龙剑传：大师合集 - 西格玛',
  ninjagaidenmastercollectionninjagaiden3razorsedge: '忍者龙剑传：大师合集 - 刀锋边缘',
  ninokuniwrathofthewhitewitchremastered: '二之国：白色圣灰的女王 重制版',
  nobunagasambitionawakening: '信长之野望：新生',
  onepunchmanaheronobodyknows: '一拳超人：无名英雄',
  oninaki: '鬼哭邦',
  oriandthewillofthewisps: '奥日与鬼火意志',
  pathfinderkingmaker: '开拓者：拥王者',
  rage2: '狂怒2',
  residentevil3: '生化危机3：重制版',
  sdgundamggenerationcrossrays: 'SD高达G世纪：火线纵横',
  shenmue3: '莎木3',
  sidmeierscivilizationvi: '文明6',
  spellforce3soulharvest: '咒语力量3：灵魂收割',
  spyroreignitedtrilogy: '斯派罗烈焰重燃三合一',
  starwarsjedifallenorder: '星球大战绝地：陨落的武士团',
  supermonkeyballbananablitzhd: '现尝好滋味！超级猴子球',
  superrobotwarsv: '超级机器人大战V',
  superrobotwarsx: '超级机器人大战X',
  swordsandsoulsneverseen: '剑与魂：未见',
  teamsonicracing: '团队索尼克赛车',
  thelegendofheroestrailsintoreverie: '英雄传说：创之轨迹',
  thelegendofheroestrailsthroughdaybreakii: '英雄传说：黎之轨迹2',
  thelegendofheroestrailsthroughdaybreak: '英雄传说：黎之轨迹',
  theouterworlds: '天外世界',
  thesinkingcity: '沉没之城',
  thesurge2: '迸发2',
  thewalkingdeadsaintsandsinners: '行尸走肉：圣徒与罪人',
  thiswarofmine: '这是我的战争',
  tokyoghoulrecalltoexist: '东京喰种：re CALL to EXIST',
  tormentedsouls: '折磨的灵魂',
  trine4thenightmareprince: '三位一体4：梦魇王子',
  vampiresfallorigins: '吸血鬼之殇：起源',
  warriorsorochi4ultimate: '无双大蛇3：终极版',
  wolfensteinyoungblood: '德军总部：新血液',
  worldwarzworldwarzaftermath: '僵尸世界大战／僵尸世界大战：劫后余生',
  wreckfest: '撞车嘉年华',
  yakuzakiwami2: '如龙：极2',
  yesyourgrace: '遵命，陛下',
  ysviiilacrimosaofdana: '伊苏8：达娜的安魂曲',
  ysmemoriesofcelceta: '伊苏：塞尔塞塔的树海',
  zombiearmy4deadwar: '僵尸部队4：死亡战争',
  '60parsecs': '60秒差距',
};

/* ------------------------------------------------------------------ */
/* 3. 详情页解析                                                        */
/* ------------------------------------------------------------------ */

export function parseTrainerPage(html, url) {
  const meta = (prop) => {
    const m = new RegExp(`<meta[^>]+(?:property|name)="${prop}"[^>]+content="([^"]*)"`).exec(html);
    return m ? decodeEntities(m[1]) : '';
  };

  const cover = meta('og:image');

  const text = html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
  const decoded = decodeEntities(text);

  let options = null;
  let gameVersion = '';
  let lastUpdated = '';
  const infoRe = /(\d+)\s+Options?\s*·\s*Game Version:\s*([^·]*?)\s*·\s*Last Updated:\s*([0-9.\-/]+)/i;
  const info = infoRe.exec(decoded);
  if (info) {
    options = Number(info[1]);
    gameVersion = info[2].trim();
    lastUpdated = info[3].trim();
  } else {
    const o = /(\d+)\s+Options?/i.exec(decoded);
    if (o) options = Number(o[1]);
    const gv = /Game Version:\s*([^·]+)/i.exec(decoded);
    if (gv) gameVersion = gv[1].trim();
    const lu = /Last Updated:\s*([0-9.\-/]+)/i.exec(decoded);
    if (lu) lastUpdated = lu[1].trim();
  }

  // 修改项清单（og:description 里带 "Options Num 1 – ..."）
  const desc = meta('og:description');
  const optionList = desc
    ? desc
        .split(/\s+Num\s+\d+\s*[–—-]\s*/i)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(1, 200)
    : [];

  // 下载文件表：每行 = 文件名 / 日期 / 大小 / 下载次数 / 下载链接（首行为最新版本）
  const downloads = [];
  const dlRe =
    /<tr class="([^"]*)"[^>]*>\s*<td class="attachment-title">[\s\S]*?<a href="(https:\/\/flingtrainer\.com\/downloads\/[^"]+)"\s+title="([^"]*)"[\s\S]*?<\/td>\s*<td class="attachment-date">([^<]*)<\/td>\s*<td class="attachment-size">([^<]*)<\/td>\s*<td class="attachment-downloads">([^<]*)<\/td>/g;
  let dm;
  while ((dm = dlRe.exec(html))) {
    downloads.push({
      url: dm[2],
      name: decodeEntities(dm[3]).trim(),
      date: dm[4].trim(),
      size: dm[5].trim(),
      count: Number((dm[6] || '0').replace(/[^\d]/g, '')) || 0,
    });
  }
  if (!downloads.length) {
    for (const u of new Set([...html.matchAll(/href="(https:\/\/flingtrainer\.com\/downloads\/[^"]+)"/g)].map((m) => m[1]))) {
      downloads.push({ url: u, name: '', date: '', size: '', count: 0 });
    }
  }

  const slug = url.replace(/\/$/, '').split('/').pop();

  return {
    url,
    slug,
    cover,
    options,
    gameVersion,
    lastUpdated,
    optionList,
    downloads,
    published: meta('article:published_time') || '',
    modified: meta('article:modified_time') || '',
  };
}

/* ------------------------------------------------------------------ */
/* 4. 主流程                                                            */
/* ------------------------------------------------------------------ */

export async function buildData({ onProgress, force = false, previous = null, outFile = null } = {}) {
  const report = (p) => onProgress && onProgress(p);

  report({ phase: 'start', message: '读取主站总表…' });
  const allHtml = await fetchText(ALL_TRAINERS);
  const list = parseAllTrainers(allHtml);
  report({ phase: 'list', count: list.length, message: `主站共 ${list.length} 个修改器` });

  report({ phase: 'forum', message: '抓取中文论坛帖以获取官方中文名…' });
  const forumNames = await fetchForumNames((p) => report({ ...p, message: `论坛中文名映射 ${p.page}/${p.lastPage} 页` }));

  const prevByUrl = new Map();
  if (previous && Array.isArray(previous.trainers)) {
    for (const t of previous.trainers) prevByUrl.set(t.url, t);
  }

  const needDetail = force ? list : list.filter((x) => !prevByUrl.get(x.url)?.cover);
  report({
    phase: 'detail',
    total: needDetail.length,
    message: needDetail.length === 0 ? '详情页已是最新，跳过抓取' : `抓取 ${needDetail.length} 个详情页…`,
  });

  let doneCount = 0;
  await pool(needDetail, CONCURRENCY, async (item) => {
    await sleep(90 + Math.random() * 160); // 轻微抖动，避免触发官网限流
    const html = await fetchText(item.url);
    const detail = parseTrainerPage(html, item.url);
    prevByUrl.set(item.url, { ...(prevByUrl.get(item.url) || {}), ...item, ...detail });
    doneCount++;
    if (doneCount % 25 === 0 || doneCount === needDetail.length) {
      report({ phase: 'detail', done: doneCount, total: needDetail.length, message: `详情页 ${doneCount}/${needDetail.length}` });
    }
  });

  const trainers = list.map(({ en, url }, i) => {
    const detail = prevByUrl.get(url) || {};
    const key = normKey(en);
    const cn = forumNames.get(key) || MANUAL_CN[key] || detail.cn || '';
    return {
      id: i + 1,
      cn: cn || en.replace(/\s*Trainer$/i, ''),
      en,
      url,
      cover: detail.cover || '',
      options: detail.options ?? null,
      gameVersion: detail.gameVersion || '',
      lastUpdated: detail.lastUpdated || '',
      published: detail.published || '',
      modified: detail.modified || '',
      optionList: detail.optionList || [],
      downloads: detail.downloads || [],
      cnMatched: Boolean(forumNames.get(key) || MANUAL_CN[key]),
    };
  });

  const payload = {
    meta: {
      generatedAt: new Date().toISOString(),
      count: trainers.length,
      source: SITE,
      cnSourceCount: trainers.filter((t) => t.cnMatched).length,
    },
    trainers,
  };

  const target = outFile || DATA_FILE;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // 原子写：先写临时文件再 rename，避免中途崩溃留下半截 JSON
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 1), 'utf8');
  fs.renameSync(tmp, target);
  report({ phase: 'done', count: trainers.length, file: target, message: `完成，共 ${trainers.length} 条` });
  return payload;
}

/** 读取本地已有数据 */
export function readLocalData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/* CLI */
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const force = process.argv.includes('--force');
  buildData({
    force,
    previous: readLocalData(),
    onProgress: (p) => {
      const line = `[${p.phase}] ${p.message || ''}`;
      if (p.phase !== 'detail' || !globalThis.__last || globalThis.__last !== line) process.stdout.write('\r\x1b[K' + line);
      globalThis.__last = line;
      if (p.phase === 'list' || p.phase === 'done') process.stdout.write('\n');
    },
  })
    .then((d) => {
      process.stdout.write('\n');
      console.log(`✅ 数据已写入 data/trainers.json（${d.meta.count} 条，中文名 ${d.meta.cnSourceCount} 条来自官方对照）`);
    })
    .catch((e) => {
      console.error('\n❌ 抓取失败：', e);
      process.exit(1);
    });
}

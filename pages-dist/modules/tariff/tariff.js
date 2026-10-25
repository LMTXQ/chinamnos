/* ═══════════════════════════════════════════════════════════════
   Tariff 资费监控页（ES Module 重构版）
   ───────────────────────────────────────────────────────────────
   数据访问路径与原版完全一致：
     ./data/stats.json
     ./data/{carrier}/snapshots/snapshot_{code}.json
     ./data/{carrier}/changelogs/changelog_{code}.json
     ./data/{carrier}/_diag.json
   localStorage 键名与原版完全一致：
     default_carrier / {carrier}_v2_prov / shared_cache_stats.json
     {carrier}_cache_{path} / {carrier}_v2_check / chinamnos_v2_theme
   ═══════════════════════════════════════════════════════════════ */
"use strict";

import { Shell, esc, fetchTimeout, theme, ensureStylesheet } from "../../shell/shell.js";
import { icon, mountIcons, Tabs, initFX, toast, PAGE_LOADING_MIN_MS, clampPopToViewport } from "../../shell/ui.js";
import { mountAppsMenu } from "../../shell/apps-menu.js";
import { Auth, mountAuth } from "../../shell/auth.js";
import { api } from "../../shell/api.js";
import { adaptPost, viewFromCardhubRaw, renderListCard, renderDetailBody, relTime } from "../../shell/post-view.js";
import { mdToSafeHtml, mdCreateEditor } from "../../shell/md.js";
import { getPubConfig } from "../../shell/pubcfg.js";
import { loadNotices, loadPlaceholders, applyPlaceholders, maybePromosOnSwitch, scopeMatch } from "../../shell/notice.js";
import { shareLink } from "../../shell/share.js";
import { initCompareBridge, compareOnShow, compareOnHide, favsOnShow } from "./compare.js?v=20261021r";

const $ = (id) => document.getElementById(id);
const cache = {};

/* 前端版本号：与 frontend-config.js 中 tariff 的 ?v= 同步 bump；
   文件内自包含，关于页展示用——显示值即文件真实版本，判断缓存是否更新零歧义 */
const TARIFF_VER = "20261025a";

const AREA_CODE_MAP = {
"0100":"北京","0200":"广州","0210":"上海","0220":"天津",
"0230":"重庆","0240":"沈阳","0241":"铁岭","0242":"抚顺",
"0243":"本溪","0250":"南京","0270":"武汉","0280":"成都",
"0281":"资阳","0282":"眉山","0290":"西安","3100":"邯郸",
"3110":"石家庄","3120":"保定","3130":"张家口","3140":"承德",
"3150":"唐山","3160":"廊坊","3170":"沧州","3180":"衡水",
"3190":"邢台","3350":"秦皇岛","3490":"朔州","3500":"忻州",
"3510":"太原","3520":"大同","3530":"阳泉","3540":"晋中",
"3550":"长治","3560":"晋城","3570":"临汾","3580":"吕梁",
"3590":"运城","3700":"商丘","3710":"郑州","3720":"安阳",
"3730":"新乡","3740":"许昌","3750":"平顶山","3760":"信阳",
"3770":"南阳","3790":"洛阳","3910":"焦作","3911":"济源",
"3920":"鹤壁","3930":"濮阳","3940":"周口","3950":"漯河",
"3960":"驻马店","3980":"三门峡","4100":"铁岭","4110":"大连",
"4120":"鞍山","4130":"抚顺","4140":"本溪","4150":"丹东",
"4160":"锦州","4170":"营口","4180":"阜新","4190":"辽阳",
"4210":"朝阳","4270":"盘锦","4290":"葫芦岛","4310":"长春",
"4320":"吉林","4330":"延边","4340":"四平","4350":"通化",
"4360":"白城","4370":"辽源","4380":"松原","4390":"白山",
"4510":"哈尔滨","4520":"齐齐哈尔","4530":"牡丹江","4540":"佳木斯",
"4550":"绥化","4560":"黑河","4570":"大兴安岭","4580":"伊春",
"4590":"大庆","4640":"七台河","4670":"鸡西","4680":"鹤岗",
"4690":"双鸭山","4700":"呼伦贝尔","4710":"呼和浩特","4720":"包头",
"4730":"乌海","4740":"乌兰察布","4750":"通辽","4760":"赤峰",
"4770":"鄂尔多斯","4780":"巴彦淖尔","4790":"锡林郭勒","4820":"兴安盟",
"4830":"阿拉善","5100":"无锡","5110":"镇江","5120":"苏州",
"5130":"南通","5140":"扬州","5150":"盐城","5160":"徐州",
"5170":"淮安","5180":"连云港","5190":"常州","5230":"泰州",
"5270":"宿迁","5300":"菏泽","5310":"济南","5320":"青岛",
"5330":"淄博","5340":"德州","5350":"烟台","5360":"潍坊",
"5370":"济宁","5380":"泰安","5390":"临沂","5430":"滨州",
"5460":"东营","5500":"滁州","5510":"合肥","5520":"蚌埠",
"5530":"芜湖","5540":"淮南","5550":"马鞍山","5560":"安庆",
"5570":"宿州","5580":"阜阳","5590":"黄山","5610":"淮北",
"5620":"铜陵","5630":"宣城","5640":"六安","5660":"池州",
"5700":"衢州","5710":"杭州","5720":"湖州","5730":"嘉兴",
"5740":"宁波","5750":"绍兴","5760":"台州","5770":"温州",
"5780":"丽水","5790":"金华","5800":"舟山","5910":"福州",
"5920":"厦门","5930":"宁德","5940":"莆田","5950":"泉州",
"5960":"漳州","5970":"龙岩","5980":"三明","5990":"南平",
"6310":"威海","6320":"枣庄","6330":"日照","6350":"聊城",
"6600":"汕尾","6620":"阳江","6630":"揭阳","6680":"茂名",
"6910":"西双版纳","6920":"德宏","7010":"鹰潭","7100":"襄阳",
"7110":"鄂州","7120":"孝感","7130":"黄冈","7140":"黄石",
"7150":"咸宁","7160":"荆州","7170":"宜昌","7180":"恩施",
"7190":"十堰","7220":"随州","7240":"荆门","7300":"岳阳",
"7310":"长沙","7311":"株洲","7312":"湘潭","7340":"衡阳",
"7350":"郴州","7360":"常德","7370":"益阳","7380":"娄底",
"7390":"邵阳","7430":"湘西","7440":"张家界","7450":"怀化",
"7460":"永州","7500":"江门","7510":"韶关","7520":"惠州",
"7530":"梅州","7540":"汕头","7550":"深圳","7560":"珠海",
"7570":"佛山","7580":"肇庆","7590":"湛江","7600":"中山",
"7620":"河源","7630":"清远","7660":"云浮","7680":"潮州",
"7690":"东莞","7700":"防城港","7710":"崇左","7720":"来宾",
"7730":"桂林","7740":"梧州","7750":"贵港","7760":"百色",
"7770":"钦州","7780":"河池","7790":"北海","7900":"新余",
"7910":"南昌","7920":"九江","7930":"上饶","7940":"抚州",
"7950":"宜春","7960":"吉安","7970":"赣州","7980":"景德镇",
"7990":"萍乡","8120":"攀枝花","8130":"自贡","8160":"绵阳",
"8170":"南充","8180":"达州","8250":"遂宁","8260":"广安",
"8270":"巴中","8300":"泸州","8310":"宜宾","8320":"内江",
"8330":"乐山","8340":"凉山","8350":"雅安","8360":"甘孜",
"8370":"阿坝","8380":"德阳","8390":"广元","8510":"贵阳",
"8520":"遵义","8530":"安顺","8540":"黔南","8550":"黔东南",
"8560":"铜仁","8570":"毕节","8580":"六盘水","8590":"黔西南",
"8700":"昭通","8710":"昆明","8720":"大理","8730":"红河",
"8740":"曲靖","8750":"保山","8760":"文山","8770":"玉溪",
"8780":"楚雄","8790":"普洱","8830":"临沧","8860":"怒江",
"8870":"迪庆","8880":"丽江","8910":"拉萨","8920":"日喀则",
"8930":"山南","8940":"林芝","8950":"昌都","8960":"那曲",
"8970":"阿里","8980":"海南","9010":"塔城","9020":"哈密",
"9030":"和田","9060":"阿勒泰","9080":"克孜勒苏","9090":"博尔塔拉",
"9100":"咸阳","9110":"延安","9120":"榆林","9130":"渭南",
"9140":"商洛","9150":"安康","9160":"汉中","9170":"宝鸡",
"9190":"铜川","9300":"临夏","9310":"兰州","9320":"定西",
"9330":"平凉","9340":"庆阳","9350":"金昌","9360":"张掖",
"9370":"嘉峪关","9380":"天水","9390":"陇南","9410":"甘南",
"9430":"白银","9510":"银川","9520":"石嘴山","9530":"吴忠",
"9540":"固原","9550":"中卫","9700":"海北","9710":"西宁",
"9720":"海东","9730":"黄南","9740":"海南","9750":"果洛",
"9760":"玉树","9770":"海西","9900":"克拉玛依","9910":"乌鲁木齐",
"9930":"石河子","9940":"昌吉","9950":"吐鲁番","9960":"巴音郭楞",
"9970":"阿克苏","9980":"喀什","9990":"伊犁",
};
/* 2位字母省码 → 中文（移动全网套餐 applicableArea 直出省码，如 GD,HA,HB；与官方资费公示接口一致） */
const PROV_CODE_MAP = {
"BJ":"北京","TJ":"天津","HE":"河北","SX":"山西","NM":"内蒙古",
"LN":"辽宁","JL":"吉林","HL":"黑龙江","SH":"上海","JS":"江苏",
"ZJ":"浙江","AH":"安徽","FJ":"福建","JX":"江西","SD":"山东",
"HA":"河南","HB":"湖北","HN":"湖南","GD":"广东","GX":"广西",
"HI":"海南","CQ":"重庆","SC":"四川","GZ":"贵州","YN":"云南",
"XZ":"西藏","SN":"陕西","GS":"甘肃","QH":"青海","NX":"宁夏",
"XJ":"新疆",
};
function areaFallback(p) {
  return AREA_CODE_MAP[p] || PROV_CODE_MAP[p] || p;
}
function areaCn(v) {
  if (v == null) return v;
  v = String(v).trim();
  if (!v) return v;
  if (/^0{2,4}$/.test(v)) return "全国";
  /* 纯数字串=4位城市码；2位大写字母串=省码，两种都逐个拆开映射 */
  if (/^[\d,，、\s]+$/.test(v) || /^([A-Z]{2}[,，、\s]*)+$/.test(v)) {
    const parts = v.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) return parts.map(areaFallback).join("、");
  }
  return areaFallback(v);
}

const CARRIER_BRAND = {
  cmcc: { name: "中国移动", shortName: "移动", icon: "移", color: "#1890ff", color2: "#40a9ff", colorDark: "#096dd9" },
  cucc: { name: "中国联通", shortName: "联通", icon: "联", color: "#e4393c", color2: "#ff7875", colorDark: "#c1272d" },
  ctcc: { name: "中国电信", shortName: "电信", icon: "电", color: "#2b85e4", color2: "#5cabf7", colorDark: "#1a6dbb" },
  cbn:  { name: "中国广电", shortName: "广电", icon: "广", color: "#f57525", color2: "#fb9d55", colorDark: "#d4591a" },
};
const CARRIER_ORDER = ["cmcc", "cucc", "ctcc", "cbn"];
const VALID_CARRIERS = Object.keys(CARRIER_BRAND);
const CARRIER_STORAGE_KEY = "default_carrier";
let currentCarrier = "cmcc";
let ACTIVE_CARRIERS = [];

/* 运营商资费公示页面 URL（用户提供的官方公示页） */
const CARRIER_OFFICIAL = {
  cmcc: "https://h.app.coc.10086.cn/cmcc-app/pc-pages/tariffZonePers.html",
  cucc: "https://img.client.10010.com/zifeizhuanquwt/index.html#/",
  ctcc: "https://www.189.cn/tariffZone/",
  cbn:  "https://m.10099.com.cn/expensesNotice/#/home"
};
function getOfficialUrl(carrier) {
  return CARRIER_OFFICIAL[carrier] || "#";
}
function updateOfficialLink() {
  const a = $("officialLink");
  if (!a) return;
  a.href = getOfficialUrl(currentCarrier);
  a.title = `${CARRIER_BRAND[currentCarrier].name} 资费公示`;
}

function applyBrandVars(brand) {
  const r = document.documentElement.style;
  r.setProperty("--acc", brand.color);
  r.setProperty("--acc-2", brand.color2 || brand.color);
  r.setProperty("--acc-deep", brand.colorDark);
}

function renderCarrierSwitch(keys) {
  ACTIVE_CARRIERS = keys.filter(k => CARRIER_BRAND[k])
    .sort((a, b) => CARRIER_ORDER.indexOf(a) - CARRIER_ORDER.indexOf(b));
  const sw = $("carrierSwitch");
  if (!sw) return;
  if (ACTIVE_CARRIERS.length === 0) {
    sw.innerHTML = '<span style="color:var(--sub);font-size:13px">暂无启用的运营商</span>';
    return;
  }
  sw.innerHTML = ACTIVE_CARRIERS.map(k => {
    const b = CARRIER_BRAND[k];
    const active = k === currentCarrier ? " active" : "";
    return `<button type="button" class="seg-btn${active}" data-carrier="${esc(k)}">${esc(b.shortName)}</button>`;
  }).join("");
}

/** 品牌标识套用：顶栏 logo 文案 + 标题栏 title + 品牌色变量（切运营商与页面重入共用） */
function applyBrandIdentity(brand) {
  const logoIcon = $("logoIcon");
  const logoText = $("logoText");
  if (logoIcon) logoIcon.textContent = brand.icon;
  if (logoText) logoText.textContent = brand.name + "资费监控";
  document.title = brand.name + "资费监控 — ChinaMNOs";
  applyBrandVars(brand);
}

function switchCarrier(carrier) {
  if (!ACTIVE_CARRIERS.includes(carrier) || carrier === currentCarrier) return;
  currentCarrier = carrier;
  try { localStorage.setItem(CARRIER_STORAGE_KEY, carrier); } catch {}
  applyBrandIdentity(CARRIER_BRAND[carrier]);

  document.querySelectorAll(".carrier-btn, .carrier-switch .seg-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.carrier === carrier);
  });

  updateOfficialLink();

  // 不再清空 cache：snapshot/changelog 的 key 已带运营商前缀，不会串数据
  // listState 的 key 不带运营商前缀（type1Code 跨运营商可能重复），需清空
  STATS = null;
  Object.keys(listState).forEach(k => delete listState[k]);
  Object.keys(TAB_SHOWN).forEach(k => delete TAB_SHOWN[k]);
  loadFavs();
  ATTR_MAP = {};
  TYPE1_MAP = {};
  TYPE2_MAP = {};

  setStat("stNational", "-");
  setStat("stTodayAdd", "-");
  setStat("stTodayRm", "-");
  $("updateTime").textContent = "-";
  $("healthDot").className = "status-dot";
  $("healthText").textContent = "加载中…";
  $("healthMeta").textContent = "";
  $("heatmap").innerHTML = "";
  $("distBars").innerHTML = "";
  $("distDesc").textContent = "";
  if (navTabs) dynamicType1Keys.forEach(t1 => navTabs.remove(t1ViewId(t1)));
  $("dynamicViews").innerHTML = "";
  dynamicType1Keys = [];
  const provEl = $("gProv");
  if (provEl && provEl.setOptions) provEl.setOptions([]);
  $("changelogBox").innerHTML = '<div class="loading">选择省份后加载变更记录…</div>';
  $("monitorSummary").innerHTML = "";
  $("monitorBody").innerHTML = "";
  $("monitorMeta").textContent = "";
  $("diagnosticsSummary").innerHTML = "";
  $("diagnosticsBody").innerHTML = "";

  annPrefetch(); // 预拉新运营商公告：未读红点 + 进 tab 零等待
  cacheTTL = DEFAULT_TTL;

  goTab("overview");
  maybePromosOnSwitch(); // 切换运营商：重新判定推广弹窗（命中新范围且未读才弹；勾选「今日不再」不弹；站长可在管理后台关闭）
}

let ATTR_MAP = {};
const ATTR_ICONS = {"1":"globe","2":"home"};
const ATTR_SUBS = {"1":"各省通用资费套餐一览","2":"本省专属资费套餐一览"};
let TYPE1_MAP = {};
let TYPE2_MAP = {};
function applyCategoryMaps(cm) {
  if (cm.attr) ATTR_MAP = cm.attr;
  if (cm.t1) TYPE1_MAP = cm.t1;
  if (cm.t2) TYPE2_MAP = cm.t2;
}
function attrLabel(code){ return ATTR_MAP[code] || code; }
function t1Label(code){ return TYPE1_MAP[code] || code; }
function t2Label(code){ return TYPE2_MAP[code] || code; }
let dynamicType1Keys = [];
let pendingTab = null;
function t1Id(code, suffix) { return "t1_" + code + "_" + suffix; }
function t1ViewId(code) { return "t1_" + code; }

let _loadingShownAt = 0;   // 最短显示时长 PAGE_LOADING_MIN_MS 由 ui.js 提供
let _loadingHideTimer = 0;
let deepLinkLoading = false;   // 深链跳转遮罩持有：跳转链（切运营商→切省→切页签→拉快照）中途数据管线的 hideLoading 不释放，由消费完成/超时统一释放
function showLoading(text) {
  const el = $("dataLoading");
  if (!el) return;
  clearTimeout(_loadingHideTimer);
  if (text) { const t = el.querySelector(".loading-text"); if (t) t.textContent = text; }
  if (_loadingShownAt) return; // 已在显示中：仅更新文案，不重置计时
  _loadingShownAt = Date.now();
  el.classList.add("show");
}
function hideLoading() {
  if (deepLinkLoading) return;   // 深链遮罩由 deepLoadingHide 释放（管线的提前 hide 会造成遮罩闪烁）
  const el = $("dataLoading");
  if (!el || !_loadingShownAt) return;
  const wait = Math.max(0, PAGE_LOADING_MIN_MS - (Date.now() - _loadingShownAt));
  _loadingShownAt = 0;
  if (!wait) { el.classList.remove("show"); return; }
  _loadingHideTimer = setTimeout(() => el.classList.remove("show"), wait);
}
function deepLoadingShow() { deepLinkLoading = true; showLoading("正在打开分享内容…"); }
function deepLoadingHide() { deepLinkLoading = false; hideLoading(); }
/* 深链切省（#gProv 是自定义 picker，非 select）：返回 true=已就绪；false=未就绪（picker 未构建/该运营商无此省）。
   设值成功才 dispatch change（联动 saveProvCode + 清 listState + 视图内重载） */
function deepSwitchProv(prov) {
  if (getProvCode() === prov) return true;
  const picker = $("gProv");
  if (!picker || !picker.setOptions) return false;   // picker 未由 fillProvSelects 构建前不动它（裸 div 设值只会污染省份记忆）
  picker.value = prov;
  if (getProvCode() !== prov) return false;   // 该运营商无此省（旧链接）：不 dispatch，避免每 500ms 重渲染风暴
  picker.dispatchEvent(new Event("change"));
  return false;
}

/** 统计数值写入：<num-ticker> 走滚动动画，其余直接写文本 */
function setStat(id, v) {
  const el = $(id);
  if (!el) return;
  if (typeof v === "number" && isFinite(v) && el.tagName === "NUM-TICKER") el.value = v;
  else if (el.tagName === "NUM-TICKER") el.value = v;
  else el.textContent = fmt(v);
}

/** 条形图入场生长动画：先渲染 width:0，双 rAF 后应用到 data-w */
function animateBars(root) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    root.querySelectorAll("[data-w]").forEach(el => { el.style.width = el.dataset.w; });
  }));
}

const PROVINCE_ORDER = [
  {c:"bj",n:"北京"},{c:"tj",n:"天津"},{c:"he",n:"河北"},{c:"sx",n:"山西"},{c:"nmg",n:"内蒙古"},{c:"ln",n:"辽宁"},
  {c:"jl",n:"吉林"},{c:"hlj",n:"黑龙江"},{c:"sh",n:"上海"},{c:"js",n:"江苏"},{c:"zj",n:"浙江"},{c:"ah",n:"安徽"},
  {c:"fj",n:"福建"},{c:"jx",n:"江西"},{c:"sd",n:"山东"},{c:"hn",n:"河南"},{c:"hub",n:"湖北"},{c:"hun",n:"湖南"},
  {c:"gd",n:"广东"},{c:"gx",n:"广西"},{c:"han",n:"海南"},{c:"cq",n:"重庆"},{c:"sc",n:"四川"},{c:"gz",n:"贵州"},
  {c:"yn",n:"云南"},{c:"xz",n:"西藏"},{c:"snx",n:"陕西"},{c:"gs",n:"甘肃"},{c:"qh",n:"青海"},{c:"nx",n:"宁夏"},
  {c:"xj",n:"新疆"}
];
const CARRIER_EXTRA_PROVS = {
  cbn: [{c:"quanguo",n:"全网",pos:0},{c:"sz",n:"深圳",pos:19}]
};
const GRID_COLS = 6;
function buildProvinceGrid(carrier) {
  const list = [...PROVINCE_ORDER];
  const extras = CARRIER_EXTRA_PROVS[carrier];
  if (extras) {
    const sorted = [...extras].sort((a, b) => a.pos - b.pos);
    sorted.forEach(e => { const {pos, ...cell} = e; list.splice(pos, 0, cell); });
  }
  const grid = [];
  for (let i = 0; i < list.length; i += GRID_COLS) {
    const row = list.slice(i, i + GRID_COLS);
    while (row.length < GRID_COLS) row.push(null);
    grid.push(row);
  }
  return grid;
}
const PROVINCE_GRID = () => buildProvinceGrid(currentCarrier);
const ALL_PROVS = (() => {
  const seen = new Set();
  const all = [...PROVINCE_ORDER];
  Object.values(CARRIER_EXTRA_PROVS).flat().forEach(e => { const {pos, ...cell} = e; if (!seen.has(cell.c)) { seen.add(cell.c); all.push(cell); } });
  return all;
})();
const PROV_BY_CODE = {};
ALL_PROVS.forEach(p => { PROV_BY_CODE[p.c] = p.n; });

let STATS = null;
const PROV_KEY = () => `${currentCarrier}_v2_prov`;
const CACHE_PREFIX = () => `${currentCarrier}_cache_`;
const DEFAULT_TTL = 30 * 60 * 1000;
let cacheTTL = DEFAULT_TTL;

// snapshot/changelog 的 cache key 带运营商前缀，避免切换运营商时串数据
// stats.json 是全局数据，所有运营商共享，不加前缀
function cacheKeyFor(path) {
  return path === "stats.json" ? "stats.json" : currentCarrier + ":" + path;
}

// localStorage 只缓存 stats.json：snapshot/changelog 每省数 MB，
// 四运营商 × 31省全存必超 5-10MB 配额（QuotaExceeded 会被静默吞掉）
function loadJson(path) {
  const ck = cacheKeyFor(path);
  if (cache[ck]) return Promise.resolve(cache[ck]);

  const cacheKey = path === "stats.json" ? "shared_cache_stats.json" : CACHE_PREFIX() + path;
  if (path === "stats.json" && cacheTTL > 0) {
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.ts < cacheTTL) {
          cache[ck] = parsed.data;
          if (parsed.data.cache && typeof parsed.data.cache.ttl_minutes === "number") {
            cacheTTL = parsed.data.cache.ttl_minutes * 60 * 1000;
          }
          return Promise.resolve(parsed.data);
        }
      }
    } catch (e) {}
  }

  const url = path === "stats.json" ? "./data/stats.json" : `./data/${currentCarrier}/` + path.replace(/^\//, "");
  return fetchTimeout(url, {cache: "no-store"})
    .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(j => {
      cache[ck] = j;
      if (path === "stats.json" && j.cache && typeof j.cache.ttl_minutes === "number") {
        cacheTTL = j.cache.ttl_minutes * 60 * 1000;
      }
      if (path === "stats.json" && cacheTTL > 0) {
        try { localStorage.setItem(cacheKey, JSON.stringify({data: j, ts: Date.now()})); } catch (e) {}
      }
      return j;
    });
}

// 强制刷新：成功后必须回写缓存，否则 doCheck 拿到最新数据后
// renderOverview → loadStats 会被 TTL 内的旧 localStorage 覆盖
// carrierOverride：检测弹窗跨运营商拉 changelog 用——缓存键必须跟实际数据归属，
// 否则与 cacheKeyFor 的 currentCarrier 前缀互踩（切运营商后 loadJson 命中错误数据）
function fetchNoCache(path, carrierOverride) {
  const effCarrier = carrierOverride || currentCarrier;
  const url = path === "stats.json" ? "./data/stats.json" : `./data/${effCarrier}/` + path.replace(/^\//, "");
  return fetchTimeout(url, {cache: "no-store"})
    .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(j => {
      cache[path === "stats.json" ? "stats.json" : effCarrier + ":" + path] = j;
      if (path === "stats.json") {
        if (j.cache && typeof j.cache.ttl_minutes === "number") {
          cacheTTL = j.cache.ttl_minutes * 60 * 1000;
        }
        if (cacheTTL > 0) {
          try { localStorage.setItem("shared_cache_stats.json", JSON.stringify({data: j, ts: Date.now()})); } catch (e) {}
        }
      }
      return j;
    });
}

function loadStats() {
  return loadJson("stats.json").then(raw => {
    const carrier = (raw.carriers && raw.carriers[currentCarrier]) || {};
    const cm = carrier.category_maps || {};
    applyCategoryMaps(cm);
    return {
      version: raw.version,
      crawl_time: raw.crawl_time,
      next_crawl_time: raw.next_crawl_time,
      status: raw.status,
      last_crawl_duration_ms: raw.last_crawl_duration_ms,
      cache: raw.cache,
      default_carrier: raw.default_carrier,
      default_province: carrier.default_province,
      last_crawl: carrier.last_crawl,
      today: carrier.today,
      provinces: carrier.provinces || [],
      total_unique: carrier.total_unique,
      category_maps: cm,
      all_carriers: raw.carriers ? Object.keys(raw.carriers) : [],
    };
  });
}

function loadSnapshot(code) {
  return loadJson(`snapshots/snapshot_${code}.json`);
}

/* 跨运营商快照加载（资费对比/我的收藏用）：同 cache 层（key=carrier:path），
   当前运营商+省直接命中现有缓存零请求；失败由调用方处理（列显示重试/不标注） */
function loadSnapFor(carrier, provCode) {
  const path = `snapshots/snapshot_${provCode}.json`;
  const ck = carrier + ":" + path;
  if (cache[ck]) return Promise.resolve(cache[ck]);
  return fetchTimeout(`./data/${carrier}/${path}`, { cache: "no-store" })
    .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(j => { cache[ck] = j; return j; });
}

/* 收藏移除（我的收藏页用）：直接删桶内记录并落盘刷新徽章；空桶连带清理（防残留空省桶被误判"有收藏"） */
function removeFavBy(carrier, provCode, id) {
  const cb = RAW_FAVS[carrier];
  if (!cb) return;
  const pb = cb[provCode];
  if (!pb || !Object.prototype.hasOwnProperty.call(pb, String(id))) return;
  delete pb[String(id)];
  if (!Object.keys(pb).length) delete cb[provCode];
  if (!Object.keys(cb).length) delete RAW_FAVS[carrier];
  saveFavs();
  refreshFavBadges();
}

function loadChangelog(code) {
  // 省份无变更日志文件（如广电部分省）时按空记录处理 → 界面显示「暂无变更记录」
  return loadJson(`changelogs/changelog_${code}.json`).catch(() => ({ logs: [] }));
}

function fmt(n) { return (n === undefined || n === null) ? "-" : n.toLocaleString("zh-CN"); }
function fmtTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN");
}
function fmtDur(ms) {
  if (!ms) return "-";
  if (ms < 1000) return ms + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return s ? `${m}分${s}秒` : `${m}分`;
}
function fmtCountdown(iso) {
  if (!iso) return "";
  const diff = new Date(iso) - Date.now();
  if (diff <= 0) return "即将采集";
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.round((diff % 60000) / 1000);
  if (h > 0) return `${h}h${m}m后`;
  if (m > 0) return `${m}分${s > 0 ? s + "秒" : ""}后`;
  return `${s}秒后`;
}

function provName(code) { return PROV_BY_CODE[code] || code; }

function fillProvSelects() {
  const provs = STATS && STATS.provinces ? STATS.provinces : [];
  const defCode = STATS && STATS.default_province ? STATS.default_province : "hun";
  let mem = "";
  try { mem = localStorage.getItem(PROV_KEY()) || ""; } catch {}

  const el = $("gProv");
  if (el) {
    buildProvPicker(el);
    el.setOptions(
      provs,
      provs.some(p => p.code === mem) ? mem : (provs.some(p => p.code === defCode) ? defCode : (provs.length > 0 ? provs[0].code : ""))
    );
    // 省份就绪后补渲染：覆盖直链 #changelog 时 renderChangelog 早于 STATS 就绪的时序
    if (navTabs && navTabs.active === "changelog" && getProvCode()) renderChangelog();
    annRenderIfActive(); // 公告 tab 的本省过滤依赖省名，省份就绪后补渲染
    chatRenderIfActive(); // 唠嗑聚落同理
  }
}

function getProvCode() { const el = $("gProv"); return el ? el.value : "hun"; }

function saveProvCode() { try { localStorage.setItem(PROV_KEY(), getProvCode()); } catch {} }

/* ─────────────── 页签（Tabs 组件驱动） ─────────────── */
const TAB_SHOWN = {};
let navTabs = null;

function goTab(v) {
  try { history.replaceState(null, "", "#" + v); } catch {}
  if (navTabs) navTabs.activate(v);
}

function onTabChange(v) {
  if (v !== "compare") compareOnHide();   // 离开对比视图：关闭残留弹层（fixed 遮罩不随视图 display:none 消失）
  document.querySelectorAll("#tariffRoot .view").forEach(x => x.classList.remove("active"));
  const viewEl = $("view-" + v);
  if (!viewEl) return;
  viewEl.classList.add("active");
  /* compare/favs 豁免 TAB_SHOWN：每次进入都重渲（收藏列表需即时反映新增/删除；
     compare 状态存模块级变量，重渲不丢勾选与省选择） */
  if (TAB_SHOWN[v] && v !== "compare" && v !== "favs") return;
  TAB_SHOWN[v] = true;
  if (v === "overview") renderOverview();
  else if (v.startsWith("t1_")) renderList(v.slice(3));
  else if (v === "changelog") renderChangelog();
  else if (v === "monitor") renderMonitor();
  else if (v === "compare") compareOnShow();
  else if (v === "favs") favsViewOnShow();
  else if (v === "cardhub") { chTabRefresh().then(() => { if (chState.available) chRenderBody(); }); }
  else if (v === "acts") { actTabRefresh(true).then(actRenderBody); }
  else if (v === "announce") { annTabRefresh().then(annRenderBody); }
  else if (v === "chat") { chatTabRefresh().then(chatRenderBody); }
  else if (v === "notices") { renderNoticesView(); }
}

/* ─────────────── 我的收藏页签三分区（资费 | 情报酒馆 | 唠嗑聚落） ───────────────
   资费收藏 = localStorage 本机数据（compare.js favsOnShow 渲染进分区宿主）；
   情报/社群收藏 = D1 act_favorites（与酒馆/聚落同表，mode 区分），每次进入重拉保证新鲜。
   卡片渲染复用列表的 actCardHTML/chatCardHTML（自包含函数，按钮经 document 级点击委托全局可用） */
let favsPartition = "tariff";
try { favsPartition = localStorage.getItem("chinamnos_favs_partition") || "tariff"; } catch { /* */ }
let favsActLoaded = false;
let favsActItems = [];

function favsViewActive() {
  const el = $("view-favs");
  return !!(el && el.classList.contains("active"));
}

function favsViewOnShow() {
  const el = $("view-favs");
  if (!el) return;
  favsActLoaded = false;   // 每次进入重拉：收藏可能在酒馆/聚落内变动
  const tabs = [["tariff", "资费"], ["act", "情报酒馆"], ["chat", "唠嗑聚落"]];
  el.innerHTML = `
    <h1 class="page-title">我的收藏</h1>
    <p class="page-sub">资费收藏仅存本机浏览器（换设备/清缓存不随行） · 情报与社群收藏跟随账号</p>
    <div class="fav-part-tabs">
      ${tabs.map(([v, label]) => `<button type="button" class="fav-part-tab${favsPartition === v ? " active" : ""}" data-favpart="${v}">${label}</button>`).join("")}
    </div>
    <div class="fav-part-section" id="favPartHost"></div>`;
  if (!el.dataset.partBound) {
    el.dataset.partBound = "1";
    el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-favpart]");
      if (!b) return;
      favsPartition = b.dataset.favpart || "tariff";
      try { localStorage.setItem("chinamnos_favs_partition", favsPartition); } catch { /* */ }
      renderFavsPartition();
    });
  }
  renderFavsPartition();
}

function renderFavsPartition() {
  const host = $("favPartHost");
  if (!host) return;
  document.querySelectorAll("#view-favs .fav-part-tab").forEach((b) => b.classList.toggle("active", b.dataset.favpart === favsPartition));
  if (favsPartition === "tariff") {
    /* 资费收藏渲染进分区 section：compare.js renderFavs 识别 #favTariffBody 后以分区模式运行 */
    host.innerHTML = `<div id="favTariffBody"><div class="loading" style="padding:32px 0">加载中…</div></div>`;
    favsOnShow(host);   // compare.js：传入 host（含 #favTariffBody），只替换内容不抹 tab
    return;
  }
  if (!Auth.isLoggedIn()) {
    host.innerHTML = `<div class="empty" style="padding:40px 0">登录后可收藏情报与社群<br><span style="font-size:12px;opacity:.75">在情报/社群卡片上点「收藏」即可加入</span></div>`;
    return;
  }
  if (!favsActLoaded) {
    host.innerHTML = `<div class="loading" style="padding:32px 0">加载中…</div>`;
    api.activityMyFavorites().then((r) => {
      favsActItems = (r.ok && r.data && r.data.items) ? r.data.items : [];
      favsActLoaded = true;
      // 同步收藏态到列表（情报/社群列表卡片的收藏星需用）
      const favIds = new Set(favsActItems.map((x) => x.id));
      actState.items.forEach((x) => { x.favorited = favIds.has(x.id); });
      chatState.items.forEach((x) => { x.favorited = favIds.has(x.id); });
      renderFavsPartition();
    }).catch(() => { favsActLoaded = true; renderFavsPartition(); });
    return;
  }
  const wantMode = favsPartition === "act" ? ["official", "guide"] : ["chat"];
  const items = favsActItems.filter((x) => wantMode.indexOf(x.mode) >= 0);
  host.innerHTML = items.length
    ? `<div class="act-list">${items.map(favsPartition === "act" ? actCardHTML : chatCardHTML).join("")}</div>`
    : `<div class="empty" style="padding:40px 0">${favsPartition === "act" ? "暂无收藏的情报，在情报卡片上点「收藏」即可加入" : "暂无收藏的社群，在社群卡片上点「收藏」即可加入"}</div>`;
  mountIcons(host);
}

/* ── 公告推广页签：只读展示当前生效的公告与推广全文（弹窗内容回看） ──
   数据与弹窗同源同缓存（shell/notice.js loadNotices），生命周期内渲染一次；
   推广区支持筛选 chips（当前范围/全部，样式同情报酒馆 act-filter-chip） */
let _noticesViewRendered = false;
let _ntcPromoFilter = "scope"; // scope=当前范围（默认） | all=全部

/* 与弹窗 judgePromos 同源的范围匹配（scopeMatch 单一事实来源；含站点默认回退）：
   moduleId="tariff" → 当前范围 = 全站条目 + tariff 模块条目，且运营商/省份命中；
   其他模块条目（如跳蚤市集警告）不混入，回看走「全部」 */
function ntcScopeFilter(list) {
  let curCarrier = "", curProv = "";
  try {
    curCarrier = (localStorage.getItem("default_carrier") || "").toLowerCase();
    if (curCarrier) curProv = (localStorage.getItem(curCarrier + "_v2_prov") || "").toLowerCase();
  } catch { /* */ }
  if (!curCarrier) curCarrier = "cmcc";
  if (!curProv) curProv = "hun";
  return list.filter((p) => scopeMatch(p, curCarrier, curProv, "tariff"));
}

function renderPromoList(pBody, list, ph) {
  const shown = _ntcPromoFilter === "scope" ? ntcScopeFilter(list) : list;
  pBody.innerHTML = shown.length
    ? shown.map((p) => `
        <div style="border:1px solid rgba(128,128,128,.25);border-radius:8px;padding:12px;margin-top:10px">
          <h4 style="margin:0 0 8px">${esc(p.title || "推广")}</h4>
          <div class="act-md">${mdToSafeHtml(applyPlaceholders(p.content || "", ph))}</div>
        </div>`).join("")
    : `<div class="empty" style="padding:16px;text-align:center">${_ntcPromoFilter === "scope" ? "当前范围内暂无推广（可切到「全部」查看）" : "暂无推广"}</div>`;
}

async function renderNoticesView() {
  if (_noticesViewRendered) return;
  _noticesViewRendered = true;
  const nBody = $("ntcNoticeBody"), pBody = $("ntcPromosBody");
  if (!nBody || !pBody) return;
  const data = await loadNotices();
  const ph = await loadPlaceholders(); // 占位符取值（不随快照，Worker 实时）
  const n = data && data.site_notice;
  nBody.innerHTML = (n && n.enabled && n.content)
    ? `<h4 style="margin:0 0 8px">${esc(n.title || "站点公告")}</h4><div class="act-md">${mdToSafeHtml(applyPlaceholders(n.content, ph))}</div>`
    : `<div class="empty" style="padding:16px;text-align:center">当前没有公告</div>`;
  /* 推广列表：防御性过滤停用条目（与弹窗一致） */
  const list = ((data && Array.isArray(data.promos)) ? data.promos : []).filter((p) => p && p.enabled !== false);
  const chipBar = $("ntcPromoChips");
  if (chipBar) {
    chipBar.innerHTML = `<button type="button" class="act-filter-chip${_ntcPromoFilter === "scope" ? " active" : ""}" data-ntcf="scope">当前范围</button>`
      + `<button type="button" class="act-filter-chip${_ntcPromoFilter === "all" ? " active" : ""}" data-ntcf="all">全部</button>`;
    chipBar.querySelectorAll("[data-ntcf]").forEach((b) => {
      b.addEventListener("click", () => {
        _ntcPromoFilter = b.dataset.ntcf;
        chipBar.querySelectorAll("[data-ntcf]").forEach((x) => x.classList.toggle("active", x.dataset.ntcf === _ntcPromoFilter));
        renderPromoList(pBody, list, ph);
      });
    });
  }
  renderPromoList(pBody, list, ph);
}

function goProvince(code, targetTab) {
  $("gProv").value = code;
  saveProvCode();
  renderDistBars();
  if (STATS) renderProvStatsRow(STATS);
  dynamicType1Keys.forEach(t1 => { listState[t1 + "_" + code] = null; });
  const target = targetTab || (dynamicType1Keys.includes("2") ? "t1_2" : (dynamicType1Keys[0] ? "t1_" + dynamicType1Keys[0] : "overview"));
  goTab(target);
  chTabRefresh(true); // 省份变化 → 跳蚤市集 tab 重新探测（显隐与内容随省份联动）
  actTabRefreshAndRender(); // 情报酒馆列表随省份联动
  annRenderIfActive(); // 公告列表随省份联动（本省过滤）
  chatTabRefreshAndRender(); // 唠嗑聚落随省份联动（refetch，同上：API 兜底路径 items 为按省子集）
  maybePromosOnSwitch(); // 切换省份：重新判定推广弹窗（命中新范围且未读才弹）
  /* 同 change 路径：非 active 页签的 DOM 靠下次进入重渲染，删除守卫防残留旧省内容 */
  delete TAB_SHOWN["acts"];
  delete TAB_SHOWN["chat"];
  delete TAB_SHOWN["announce"];
}

/* ─────────────── 跳蚤市集 tab（复用 shell/post-view.js 渲染；动态探测显隐） ───────────────
   ▸ 数据：现有公开列表接口（服务端筛选 carrier/province，全部板块混排，置顶优先）
   ▸ 显隐：站长关闭跳蚤市集（/api/meta module_cardhub_enabled）或该运营商+省份无帖 → tab 隐藏
   ▸ 编码统一：全站运营商标识已统一为资费口径 cmcc/cucc/ctcc/cbn（2026-10 迁移，数据库与烘焙文件同步）；
     省份用中文名（号卡库存中文名）
   ▸ 互动边界：详情为只读导流快照——复制/登录可用，在线沟通/收藏等引导去跳蚤市集 */
const chState = {
  enabled: null,        // null=未探测 meta；false=跳蚤市集被站长关闭
  available: false,     // 当前运营商+省份有无可展示帖
  probedSig: "",        // 已探测的 carrier|province 签名（防重复请求）
  schema: null,         // /api/cardhub/schema 的 {boards,carriers}（renderListCard/detail 依赖）
  items: [],            // 列表数据（adaptPost 后）
  detail: null,         // 当前打开的详情（adaptPost 后），null=列表态
};

function chProvName() {
  const code = getProvCode();
  const p = ((STATS && STATS.provinces) || []).find(x => x.code === code);
  const full = (p && (p.name || p.province)) || "";
  /* 号卡库存省份简称（广东），资费 stats 存全称（广东省/广西壮族自治区…）——归一化后查询 */
  return full.replace(/(维吾尔|壮族|回族)?(自治区|省|市|特别行政区)$/g, "");
}

function chEnsureCss() {
  if (!document.querySelector('link[data-module="cardhub"]')) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = Shell.config.base + "modules/cardhub/style.css";
    link.setAttribute("data-module", "cardhub");
    document.head.appendChild(link);
  }
}

async function chEnsureSchema() {
  if (chState.schema) return chState.schema;
  /* schema 快照优先（data/public-config.json，下一轮采集更新）；缺失回落 Worker 接口 */
  const pc = await getPubConfig();
  let d = pc && pc.schema;
  if (!d) {
    const r = await api.getSchema();
    if (!r.ok) return null;
    d = r.data;
  }
  // tradeMethods/tradeMerchants/tradeGuarantorStats：renderTradeBox 交易方式翻译、发帖选担保人候选池与统计依赖
  chState.schema = {
    boards: d.boards || [], carriers: d.carriers || [],
    tradeMethods: d.tradeMethods || [], tradeMerchants: d.tradeMerchants || [],
    tradeGuarantorStats: d.tradeGuarantorStats || {},
  };
  return chState.schema;
}

/* 探测：meta 开关 → 拉一页列表 → 有帖才有 tab。返回 available */
async function chProbe(force) {
  const carrierKey = currentCarrier;
  const provName = chProvName();
  const sig = carrierKey + "|" + provName;
  if (!force && chState.probedSig === sig) return chState.available;
  chState.available = false;
  chState.items = [];
  chState.detail = null;
  if (!carrierKey || !provName) return false; // 注意：失败早退不缓存 sig，条件补齐后会真正探测
  if (chState.enabled === null) {
    try {
      const m = api.fetchMeta ? await Promise.resolve(api.fetchMeta()) : null;
      chState.enabled = !(m && m.cardhub === false); // /api/meta → {modules:{cardhub:true}}
    } catch { chState.enabled = true; } // 探测失败保持可用（后端另有 503 兜底，与 apps-menu 策略一致）
  }
  if (!chState.enabled) return false;
  const schema = await chEnsureSchema();
  if (!schema) return false;
  const r = await api.getPosts({ carrier: carrierKey, province: provName, pageSize: 20 });
  if (!r.ok) return false;
  chState.items = (r.data.items || []).map(adaptPost);
  chState.available = chState.items.length > 0;
  chState.probedSig = sig; // 仅成功决策后缓存签名
  return chState.available;
}

/* 运营商/省份变化或首次进入：重新探测 → 同步 nav 显隐 → 若正停在本 tab 则重渲染（无帖则弹回总览） */
async function chTabRefresh(force) {
  await chProbe(force);
  if (force) delete TAB_SHOWN["cardhub"]; // 数据可能已变：强制下次进入 tab 重渲染（防状态与 DOM 分叉残留旧详情）
  chSyncNav();
  const active = (($("view-cardhub") || {}).classList || { contains() { return false; } }).contains("active");
  if (!chState.available) {
    if (active) goTab("overview");
    return;
  }
  chEnsureCss();
  if (active) chRenderBody();
}

function chSyncNav() {
  const btn = document.querySelector('#mainNav [data-view="cardhub"]');
  if (btn) btn.hidden = !chState.available;
}

function chRenderBody() {
  const el = $("chTabBody");
  if (!el) return;
  if (!chState.available && !chState.items.length) {
    el.innerHTML = `<div class="empty" style="padding:40px;text-align:center">当前运营商/省份暂无号卡信息<button class="btn ghost ch-mt" data-act="chGoOverview"><i data-icon="back"></i>返回总览</button></div>`;
    mountIcons(el);
    return;
  }
  if (chState.detail) {
    const raw = chState.detail;
    const me = Auth.getUser();
    const isSelf = !!(me && raw.author && raw.author.id === me.id);
    /* self 按服务端返回判定（管理员看自己的帖会拿到 self 作用域数据，须按本人视角渲染，
       否则 users 可见性帖会矛盾显示「登录后可见」锁定块） */
    const view = viewFromCardhubRaw(chState.schema, raw, true, isSelf);
    const author = raw.author
      ? { ...raw.author, avatarUrl: raw.author.avatar_v ? api.avatarUrl(raw.author.id, raw.author.avatar_v) : "" }
      : null;
    el.innerHTML = `
      <button class="btn ghost ch-back" data-act="chBack"><i data-icon="back"></i>返回号卡列表</button>
      ${renderDetailBody(chState.schema, view, { author, readonly: false, self: isSelf, isLoggedIn: !!me, proofs: [], proofPublic: raw.proofPublic === 1 })}`;
  } else {
    el.innerHTML = `
      <h1 class="page-title">跳蚤市集</h1>
      <p class="page-sub">${esc(chProvName())} · ${esc((CARRIER_BRAND[currentCarrier] || {}).name || "")} · 来自跳蚤市集的在售信息（先审后发 · 与站长无关的用户撮合）</p>
      <div class="ch-list">${chState.items.map((p, i) => renderListCard(chState.schema, p, { showBoard: true, index: i })).join("")}</div>
      <div class="ch-more"><a class="btn ghost" href="#/cardhub">去跳蚤市集查看全部<i data-icon="arrowRight"></i></a></div>`;
  }
  mountIcons(el);
}

/* tab 内点击路由：列表→详情、复制、登录走 Auth，站内互动一律导流回跳蚤市集 */
function chOnBodyClick(e) {
  const actEl = e.target.closest("[data-act]");
  if (!actEl) return;
  const a = actEl.dataset.act;
  if (a === "openDetail") {
    chOpenDetail(actEl.dataset.id);
  } else if (a === "chBack") {
    chState.detail = null;
    chRenderBody();
  } else if (a === "chGoOverview") {
    goTab("overview");
  } else if (a === "copyVal") {
    const v = actEl.dataset.val || "";
    if (navigator.clipboard) navigator.clipboard.writeText(v).then(() => toast("已复制：" + v)).catch(() => toast("复制失败，请手动选择文本复制"));
  } else if (a === "soonLogin") {
    Auth.openLogin();
  } else if (a === "merchantCard") {
    /* 「站长推荐」绑定站内用户的卡商 chip → 公开资料卡（intro = 站长填写的卡商介绍） */
    Auth.showProfileCard(actEl.dataset.uid, actEl.dataset.intro || "");
  } else if (a === "soonChat" || a === "soonRelay" || a === "favToggle" || a === "staffClose" || a === "pinAdd" || a === "pinRemove" || a === "pinBump") {
    toast("请前往跳蚤市集操作");
  }
}

async function chOpenDetail(id) {
  const el = $("chTabBody");
  if (el) el.innerHTML = `<div class="empty" style="padding:40px;text-align:center">加载中…</div>`;
  const r = await api.getPost(id);
  if (!r.ok) { toast(r.error || "帖子加载失败"); chRenderBody(); return; }
  chState.detail = adaptPost(r.data);
  chRenderBody();
  window.scrollTo(0, 0);
}

/* ─────────────── 情报酒馆 tab（双模式：官方活动推广 / 个人攻略发布） ───────────────
   ▸ 数据：GET /api/activities?carrier&province（官方=本运营商；攻略支持「全运营商通用」carrier=''）
   ▸ 提交：双模式面板（登录用户），待审≤5 + 3/时限流；官方沿用手填二维码，攻略用 Markdown 编辑器
   ▸ 匿名：可选匿名（公众侧显示「匿名」；管理组审核无限制）；非匿名昵称点击 → 个人资料卡
   ▸ 管理中心「审核」Tab 与「情报酒馆」Tab 处理；官方活动到期 Cron 自动下展 */
const ACT_MODE_LABELS = { official: "官方活动", guide: "个人攻略" };
const ACT_MD_MAX = 10000;  // 攻略正文上限（与后端 MD_MAX 对齐）
const ACT_DRAFT_KEYS = { official: "act_official", guide: "act_guide" };
const actState = {
  items: [], mine: [], favItems: [], favLoaded: false, panelOpen: false, mode: "official", filter: "", q: "", scope: "", editor: null, loadFailed: false,
  genAt: 0,   // 静态快照 generated_at（秒）：mine「已展示」判定基准（0=未知，走列表兜底判定）
  form: { title: "", url: "", scope: "prov", descr: "", ends: "", qr: null, allCarriers: false, content: "", anon: false },
};

/* 草稿暂存（localStorage 按模式隔离；二维码 dataURL 体积大不入草稿） */
function actDraftLoad(mode) {
  try {
    const d = JSON.parse(localStorage.getItem("chinamnos_act_draft_" + mode) || "null");
    return d && typeof d === "object" ? d : null;
  } catch { return null; }
}
function actDraftSave() {
  const f = actState.form;
  try {
    localStorage.setItem("chinamnos_act_draft_" + actState.mode, JSON.stringify({
      title: f.title, url: f.url, scope: f.scope, descr: f.descr, ends: f.ends,
      allCarriers: f.allCarriers, anon: f.anon,
      content: actState.editor ? actState.editor.getValue() : f.content,
    }));
  } catch { /* 隐私模式等忽略 */ }
}
function actDraftClear(mode) {
  try { localStorage.removeItem("chinamnos_act_draft_" + mode); } catch { /* */ }
}

let actProvPending = false; // 直链 #acts 时 STATS 未就绪的补加载守卫（同 annProvPending 模式）
async function actTabRefresh() {
  const carrierKey = currentCarrier;
  let provName = chProvName();
  /* 直链 #acts 且 STATS 未就绪：主动拉取 stats 并填充省份后重取省名（否则列表只会命中全国条目） */
  if (!provName && !STATS && !actProvPending) {
    actProvPending = true;
    try {
      STATS = await loadStats();
      fillProvSelects();
    } catch { /* 失败保留原行为，下次进 tab 重试 */ } finally { actProvPending = false; }
    provName = chProvName();
  }
  if (!carrierKey) { actState.items = []; actState.mine = []; actState.favItems = []; return; }
  /* 公开列表静态源优先（data/{carrier}/acts.json，随部署更新；按当前省客户端过滤），
     失败/缺失回落 Worker API（同公告模式）。mine（我的投稿三态）与收藏是登录态私有数据，始终走 Worker。 */
  const [actStatic, actApi, fr] = await Promise.all([
    fetchTimeout(`./data/${carrierKey}/acts.json?v=${Date.now()}`, { cache: "no-store" }).then((x) => x.json()).catch(() => null),
    Auth.isLoggedIn() ? api.activitiesList(carrierKey, provName) : Promise.resolve(null),
    Auth.isLoggedIn() ? api.activityMyFavorites() : Promise.resolve(null),
  ]);
  if (actStatic && Array.isArray(actStatic.items)) {
    actState.items = actStatic.items.filter((x) => !x.province || x.province === provName);
    actState.genAt = Date.parse(actStatic.generated_at) || 0;   // ISO 字符串 → 毫秒，与 D1 reviewed_at 同单位
    actState.mine = (actApi && actApi.ok) ? (actApi.data.mine || []) : [];
    actState.loadFailed = false;
  } else if (actApi && actApi.ok) {
    actState.items = actApi.data.items || [];
    actState.genAt = 0;   // Worker 实时源：列表即已展示全集，判定走列表兜底
    actState.mine = actApi.data.mine || [];
    actState.loadFailed = false;
  } else {
    /* 双源皆败（静态拉取失败且未登录/接口失败）：必须清空陈旧条目——否则切省后
       标题已是新省、列表残留旧省数据，用户看到「标题变了数据没变」的错位 */
    actState.items = [];
    actState.genAt = 0;
    actState.loadFailed = true;
  }
  actState.favItems = (fr && fr.ok) ? (fr.data.items || []) : [];
  actState.favLoaded = Auth.isLoggedIn();
  /* 收藏标记 merge：静态源 favorited 恒 false，按收藏列表回填（API 源自带时幂等） */
  if (actState.items.length && actState.favItems.length) {
    const favIds = new Set(actState.favItems.map((x) => x.id));
    actState.items.forEach((x) => { x.favorited = favIds.has(x.id); });
  }
}

function actTabRefreshAndRender() {
  return actTabRefresh().then(() => {
    const el = $("view-acts");
    if (el && el.classList.contains("active")) actRenderBody();
  });
}

/* 我的投稿编辑：删除原条目（pending=撤回 / rejected=清理）后把内容回填进投稿表单，
   用户修改后走正常提交流程重新审核（查重只挡 pending/open，删除后可原样重提）。
   二维码/凭证为 R2 对象无法回填 dataURL，需重新上传（回填提示中说明）。 */
function mineEndsToDate(endsAt) {
  if (!endsAt) return "";
  const d = new Date(endsAt - 8 * 3600 * 1000); // 提交时存 23:59:59+08:00，平移后取东八区日期
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function actEditMine(id) {
  const m = (actState.mine || []).find((x) => x.id === id);
  if (!m) { toast("未找到该投稿，请刷新后重试"); return; }
  if (!confirm("编辑将撤回当前投稿，内容填入下方表单，修改后重新提交审核。二维码（如有）需重新上传，确定继续？")) return;
  api.activityDelete(id).then((r) => {
    if (!r.ok) { toast(r.error || "撤回原投稿失败，请稍后再试"); return; }
    if (actState.editor) { actState.editor.destroy(); actState.editor = null; } // 防旧编辑器内容写回覆盖回填值
    actState.mode = m.mode === "guide" ? "guide" : "official";
    actState.form = {
      title: m.title || "",
      url: m.url || "",
      scope: m.province ? "prov" : "nat",
      descr: m.descr || "",
      ends: mineEndsToDate(m.ends_at),
      qr: null,
      allCarriers: actState.mode === "guide" && !m.carrier,
      content: m.content_md || "",
      anon: !!m.anon,
    };
    actState.panelOpen = true;
    actTabRefresh().then(actRenderBody); // 刷新三态区（原条目已删）并重建表单
    toast("原投稿已撤回，内容已填入下方表单，修改后点「提交审核」");
  });
}

function actRemaining(endsAt) {
  if (!endsAt) return `<span class="act-chip">长期有效</span>`;
  const days = Math.ceil((endsAt * 1000 - Date.now()) / 86400000);
  if (days <= 0) return `<span class="act-chip warn">今日截止</span>`;
  if (days <= 3) return `<span class="act-chip warn">仅剩 ${days} 天</span>`;
  return `<span class="act-chip">剩 ${days} 天</span>`;
}

function actCardHTML(a) {
  const guide = a.mode === "guide";
  const links = Array.isArray(a.links) ? a.links : [];
  const role = Auth.getUser()?.role;
  const isAdmin = role === "admin" || role === "owner";
  const authorHTML = a.anon
    ? `<span class="act-anon-chip" title="提交者选择匿名展示">匿名</span>`
    : (a.submitted_by
      ? `<button type="button" class="act-author" data-act="actAuthor" data-uid="${esc(a.submitted_by)}" title="查看提交者资料卡">${esc(a.submitter_nickname || "用户")}</button>`
      : `<span>${esc(a.submitter_nickname || "用户")}</span>`);
  const scopeBadge = a.carrier
    ? `<span class="act-badge ${a.province ? "act-prov" : "act-nat"}">${a.province ? esc(a.province) : "全国"}</span>`
    : `<span class="act-badge act-all">通用</span><span class="act-badge ${a.province ? "act-prov" : "act-nat"}">${a.province ? esc(a.province) : "全国"}</span>`;
  const mainAct = guide
    ? `<button type="button" class="btn primary sm" data-act="actDetail" data-id="${esc(a.id)}"><i data-icon="list"></i>查看攻略</button>`
    : `<a class="btn primary sm act-go" href="${esc(a.url || "#")}" target="_blank" rel="noopener noreferrer">参与活动<i data-icon="external"></i></a>
      <button type="button" class="btn ghost sm" data-act="actDetail" data-id="${esc(a.id)}" title="弹窗查看活动详情（描述/全部链接/二维码/分享）"><i data-icon="info"></i>详情</button>`;
  const linkChips = links.slice(0, 3).map((l) =>
    `<a class="act-link-chip" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer nofollow" title="${esc(l.label)}"><i data-icon="external"></i>${esc(l.label)}</a>`).join("");
  const moreChip = links.length > 3
    ? `<button type="button" class="act-link-chip more" data-act="actDetail" data-id="${esc(a.id)}" title="查看全部链接">+${links.length - 3}</button>` : "";
  const summary = guide ? (a.excerpt || a.descr || "") : (a.descr || "");
  return `
  <div class="act-card${guide ? " act-guide" : ""}">
    <div class="act-main">
      <div class="act-title-line">
        ${a.pinned ? `<span class="act-pin-badge" title="管理组置顶">置顶</span>` : ""}
        <span class="act-mode-badge ${guide ? "guide" : "official"}">${guide ? "攻略" : "官方"}</span>
        ${scopeBadge}
        <b class="act-title">${esc(a.title)}</b>
        ${actRemaining(a.ends_at)}
      </div>
      ${summary ? `<div class="act-descr">${esc(summary)}</div>` : ""}
      ${(linkChips || moreChip) ? `<div class="act-links">${linkChips}${moreChip}</div>` : ""}
      <div class="act-meta">${relTime(Math.floor((a.created_at || 0) / 1000))} 收录 · ${authorHTML}</div>
    </div>
    <div class="act-actions">
      ${mainAct}
      ${a.has_qr ? `<button type="button" class="btn ghost sm" data-act="actQr" data-id="${esc(a.id)}" data-title="${esc(a.title)}" title="查看二维码"><i data-icon="qr"></i>二维码</button>` : ""}
      ${!guide && a.url ? `<button type="button" class="btn ghost sm btn-ico-sm" data-act="actCopyLink" data-url="${esc(a.url)}" title="复制活动链接"><i data-icon="copy"></i><span class="btn-txt">复制</span></button>` : ""}
      <button type="button" class="btn ghost sm btn-ico-sm" data-act="actFeedback" data-title="${esc(a.title)}" data-url="${esc(a.url || "")}" title="对该情报反馈或举报（工单中心）"><i data-icon="message"></i><span class="btn-txt">反馈</span></button>
      <button type="button" class="btn ghost sm btn-ico-sm" data-act="actShare" data-id="${esc(a.id || "")}" data-title="${esc(a.title || "")}" title="分享本帖（复制链接或唤起系统分享）"><i data-icon="share"></i><span class="btn-txt">分享</span></button>
      <button type="button" class="btn ghost sm btn-ico-sm act-fav-btn${a.favorited ? " act-faved" : ""}" data-act="actFav" data-id="${esc(a.id)}" title="${a.favorited ? "取消收藏" : "收藏到我的收藏"}"><i data-icon="${a.favorited ? "starFill" : "star"}"></i><span class="btn-txt">${a.favorited ? "已收藏" : "收藏"}</span></button>
      ${isAdmin ? `<button type="button" class="btn ghost sm btn-ico-sm" data-act="actPinToggle" data-id="${esc(a.id)}" data-pinned="${a.pinned ? 1 : 0}" title="${a.pinned ? "取消置顶" : "置顶展示在列表最前（仅管理组可见此按钮）"}"><i data-icon="${a.pinned ? "chevronsDown" : "chevronsUp"}"></i><span class="btn-txt">${a.pinned ? "取消置顶" : "置顶"}</span></button>` : ""}
    </div>
  </div>`;
}

/* 活动二维码弹窗：大图展示 + 底部下载（下载按钮在 modal-foot，走 document 级 actQrDownload）。
   img 带 crossorigin=anonymous：API 对带 Origin 的请求返回 CORS 头，图片进 canvas 不被污染，
   下载可直接从已显示的图本地导出（零二次网络请求）；加载异常时去掉属性重试一次 */
function actQrModal(id, title) {
  openModal(title || "活动二维码", `
    <div class="act-qr-view">
      <img src="${api.base}/api/activities/${encodeURIComponent(id)}/qr" crossorigin="anonymous" alt="${esc(title || "活动")}二维码">
      <div class="act-qr-tip">扫码或长按识别二维码参与活动</div>
    </div>`,
    `<button type="button" class="btn ghost sm" data-act="actQrDownload" data-id="${esc(id)}" data-title="${esc(title || "")}">${icon("download")}下载二维码</button>`);
  const img = $("modalBody")?.querySelector(".act-qr-view img");
  if (img) img.addEventListener("error", function once() {
    if (this.hasAttribute("crossorigin")) { this.removeAttribute("crossorigin"); this.src = this.src; }
  }, { once: true });
}

/* 下载活动二维码：优先从弹窗已显示的 <img> 本地导出（canvas → PNG，零网络请求）；
   canvas 被污染或图片未就绪时回退后端直链（?dl=1 → Content-Disposition: attachment） */
function actQrDownload(id, title) {
  const img = $("modalBody")?.querySelector(".act-qr-view img");
  if (img && img.complete && img.naturalWidth) {
    try {
      const cv = document.createElement("canvas");
      cv.width = img.naturalWidth;
      cv.height = img.naturalHeight;
      cv.getContext("2d").drawImage(img, 0, 0);
      const aEl = document.createElement("a");
      aEl.href = cv.toDataURL("image/png");
      aEl.download = `活动二维码-${title || id}.png`;
      document.body.appendChild(aEl);
      aEl.click();
      aEl.remove();
      return;
    } catch { /* 跨域污染等导出失败 → 走直链兜底 */ }
  }
  const aEl = document.createElement("a");
  aEl.href = `${api.base}/api/activities/${encodeURIComponent(id)}/qr?dl=1`;
  aEl.rel = "noopener";
  document.body.appendChild(aEl);
  aEl.click();
  aEl.remove();
}

/* 活动链接复制（卡片按钮）：复用列表的剪贴板工具 */
function actCopyLink(btn, url) {
  copyToClipboard(url || "").then((ok) => {
    if (!ok) { toast("复制失败"); return; }
    const old = btn.innerHTML;
    btn.innerHTML = icon("check") + "已复制";
    setTimeout(() => { btn.innerHTML = old; }, 1200);
  });
}

/* 情报反馈：确认后 sessionStorage 交接（工单中心读取即清除），分类默认「其他」 */
function actFeedback(title, url) {
  const t = String(title || "");
  const okGo = confirm(`将前往工单中心反馈/举报情报「${t}」，工单分类默认为「其他」。继续？`);
  if (!okGo) return;
  try {
    sessionStorage.setItem("chinamnos_ticket_prefill", JSON.stringify({
      category: "其他",
      source: "tariff",
      title: `情报反馈：${t}`.slice(0, 60),
      content: `情报标题：${t}\n相关链接：${url || ""}\n\n反馈/举报说明：\n`,
      banner: "已带入情报反馈预设信息（来自情报酒馆卡片），请核对补充后提交",
    }));
  } catch { /* sessionStorage 不可用时跳转后手填 */ }
  Shell.navigate("/ticket");
}

/* 模式分段选择器：两张模式卡（官方活动推广 / 个人攻略发布） */
function actModeSeg() {
  return `
  <div class="act-mode-seg">
    <button type="button" class="act-mode-card${actState.mode === "official" ? " active" : ""}" data-act="actMode" data-mode="official">
      <b>官方活动推广</b><span>运营商官方优惠活动，主链接必填，可附二维码与截止时间</span>
    </button>
    <button type="button" class="act-mode-card${actState.mode === "guide" ? " active" : ""}" data-act="actMode" data-mode="guide">
      <b>个人攻略发布</b><span>Markdown 正文攻略，支持多链接、全运营商通用与匿名展示</span>
    </button>
  </div>`;
}

/* 模式筛选 chips + 关键词搜索（客户端过滤列表；「我的收藏」仅登录用户可见） */
function actFilterChips() {
  const chip = (v, label) => `<button type="button" class="act-filter-chip${actState.filter === v ? " active" : ""}" data-act="actFilter" data-mode="${v}">${label}</button>`;
  const favChip = Auth.isLoggedIn() ? chip("fav", "我的收藏") : "";
  /* 手机窄屏：chips 换行占高 → 收进下拉（.act-filter-sel），与 chips 同源同状态，CSS 控制两套显隐（宽屏不变） */
  const favOpt = Auth.isLoggedIn() ? `<option value="fav">我的收藏</option>` : "";
  const sel = `<select class="sel act-scope-sel act-filter-sel" id="actFilterSel" title="按板块筛选">
      <option value=""${actState.filter === "" ? " selected" : ""}>全部</option>
      <option value="official"${actState.filter === "official" ? " selected" : ""}>官方活动</option>
      <option value="guide"${actState.filter === "guide" ? " selected" : ""}>个人攻略</option>
      ${favOpt}
    </select>`;
  return `<div class="act-filter act-filter-tb">${chip("", "全部")}${chip("official", "官方活动")}${chip("guide", "个人攻略")}${favChip}</div>${sel}`;
}

/* 图片引导弹窗：站内不提供图床直传，引导到公益图床上传后粘贴外链（与在线沟通同一引导文案结构） */
function actImgGuide() {
  openModal("插入图片 · 图床外链指引", `
    <div class="act-img-guide">
      <p>攻略正文支持图片：请先在<b>外部免费图床</b>上传图片获取直链，再粘贴进正文（<b>独立成一行</b>，或用 <code>![说明](图片链接)</code> 语法）：</p>
      <ul>
        <li>点击下方按钮，在新标签页打开图床 <b>111666.best</b>（亦支持 telegra.ph / i.ibb.co / catbox 等常见图床）</li>
        <li>上传后复制图片<b>直链</b>（以 .png / .jpg / .webp 等结尾），粘贴到正文独立一行即可自动显示</li>
      </ul>
      <div class="act-img-warn">${icon("shield")} <span>该图床为<b>非官方</b>的第三方公益服务，与本站无关，图片将公开保存在站外。请<b>注意保护个人隐私</b>，勿上传身份证、银行卡、收款码等敏感内容。</span></div>
      <div class="act-img-actions"><a class="btn primary sm" href="https://111666.best" target="_blank" rel="noopener noreferrer nofollow"><i data-icon="external"></i>打开图床</a></div>
    </div>`);
  mountIcons($("modalBody"));
}

/* 模式切换：保留公共字段（标题/范围/截止/匿名），模式私有字段从各自草稿恢复 */
function actSwitchMode(mode) {
  const next = mode === "guide" ? "guide" : "official";
  if (next === actState.mode) return;
  actDraftSave();
  actState.mode = next;
  const f = actState.form;
  const keep = { title: f.title, scope: f.scope, ends: f.ends, anon: f.anon };
  const d = actDraftLoad(next) || {};
  actState.form = {
    title: keep.title, scope: keep.scope, ends: keep.ends, anon: keep.anon,
    url: typeof d.url === "string" ? d.url : "",
    descr: typeof d.descr === "string" ? d.descr : "",
    allCarriers: !!d.allCarriers,
    content: typeof d.content === "string" ? d.content : "",
    qr: null,
  };
  if (actState.editor) { actState.editor.destroy(); actState.editor = null; }
  actRenderBody();
}

/* 详情弹窗：攻略渲染 Markdown 正文 + 全部链接；官方活动同弹窗展示主链接与二维码入口 */
async function actOpenDetail(id) {
  openModal("加载中…", `<div class="empty" style="padding:32px;text-align:center">加载中…</div>`);
  const r = await api.activityDetail(id);
  if (!r.ok) {
    const msg = (r.data && r.data.message) || r.error || "加载失败";
    openModal("详情", `<div class="empty" style="padding:32px;text-align:center">${esc(typeof msg === "string" ? msg : "加载失败")}</div>`);
    return;
  }
  const a = r.data;
  const guide = a.mode === "guide";
  const authorHTML = a.anon
    ? `<span class="act-anon-chip">匿名</span>`
    : (a.submitted_by
      ? `<button type="button" class="act-author" data-act="actAuthor" data-uid="${esc(a.submitted_by)}" title="查看提交者资料卡">${esc(a.submitter_nickname || "用户")}</button>`
      : `<span>${esc(a.submitter_nickname || "用户")}</span>`);
  const scopeBadge = a.carrier
    ? `<span class="act-badge ${a.province ? "act-prov" : "act-nat"}">${a.province ? esc(a.province) : "全国"}</span>`
    : `<span class="act-badge act-all">通用</span><span class="act-badge ${a.province ? "act-prov" : "act-nat"}">${a.province ? esc(a.province) : "全国"}</span>`;
  const linksHTML = (a.links || []).map((l) =>
    `<a class="btn ghost sm" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer nofollow"><i data-icon="external"></i>${esc(l.label)}</a>`).join("");
  const body = `
    <div class="act-detail">
      <div class="act-title-line">
        <span class="act-mode-badge ${guide ? "guide" : "official"}">${guide ? "个人攻略" : "官方活动"}</span>
        ${scopeBadge}
        ${actRemaining(a.ends_at)}
        <button type="button" class="btn ghost sm" data-act="actShare" data-id="${esc(a.id || "")}" data-title="${esc(a.title || "")}" title="分享本帖（复制链接或唤起系统分享）" style="margin-left:auto"><i data-icon="share"></i>分享</button>
      </div>
      <h3 class="act-detail-title">${esc(a.title)}</h3>
      ${a.descr ? `<div class="act-descr">${esc(a.descr)}</div>` : ""}
      ${guide && a.content_md ? `<div class="act-md">${mdToSafeHtml(a.content_md, { nofollow: true })}</div>` : ""}
      ${linksHTML ? `<div class="act-links">${linksHTML}</div>` : ""}
      ${a.url ? `<div class="act-detail-main"><a class="btn primary sm" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer nofollow"><i data-icon="external"></i>${guide ? "打开主链接" : "参与活动"}</a>
      <button type="button" class="btn ghost sm" data-act="actCopyLink" data-url="${esc(a.url)}"><i data-icon="copy"></i>复制链接</button></div>` : ""}
      ${a.has_qr ? `<div class="act-detail-main"><button type="button" class="btn ghost sm" data-act="actQr" data-id="${esc(a.id)}" data-title="${esc(a.title)}"><i data-icon="qr"></i>查看二维码</button></div>` : ""}
      <div class="act-meta">提交于 ${relTime(Math.floor((a.created_at || 0) / 1000))} · ${authorHTML}</div>
    </div>`;
  openModal(guide ? "攻略详情" : "活动详情", body);
  mountIcons($("modalBody"));
}

/* 列表过滤（收藏/模式 chips + 范围/关键词，均客户端执行）：actRenderBody 与搜索局部重绘共用 */
function actFilteredItems() {
  const favView = actState.filter === "fav";
  const listSource = favView ? actState.favItems : actState.items;
  let items = (favView || !actState.filter) ? listSource : listSource.filter((a) => a.mode === actState.filter);
  if (actState.scope === "nat") items = items.filter((a) => !a.province);      // 全国·通用（无省份标记）
  else if (actState.scope === "prov") items = items.filter((a) => !!a.province); // 本省收录
  const q = actState.q.trim().toLowerCase();
  if (q) items = items.filter((a) => `${a.title || ""}\n${a.descr || ""}\n${a.excerpt || ""}`.toLowerCase().includes(q));
  return items;
}

/* 列表区局部重绘（搜索输入时保持输入焦点与滚动位置） */
function actRenderList() {
  const el = $("actListRegion");
  if (!el) return;
  const provName = chProvName();
  const favView = actState.filter === "fav";
  const items = actFilteredItems();
  const emptyTip = favView
    ? (actState.favLoaded ? "暂无收藏，点击情报卡片上的「收藏」按钮即可保存到这里" : "登录后可收藏感兴趣的情报")
    : (actState.loadFailed ? "情报加载失败，请检查网络后下拉刷新或稍后再试" : `暂无${esc(provName)}的情报，欢迎投稿第一条！`);
  const q = actState.q.trim();
  el.innerHTML = items.length
    ? `<div class="act-list">${items.map(actCardHTML).join("")}</div>`
    : `<div class="empty" style="padding:32px;text-align:center">${q ? `没有与「${esc(q)}」匹配的情报` : emptyTip}</div>`;
  mountIcons(el);
}

function actRenderBody() {
  const el = $("actTabBody");
  if (!el) return;
  const provName = chProvName();
  const brand = (CARRIER_BRAND[currentCarrier] || {}).name || "";
  const guide = actState.mode === "guide";
  /* mine「已展示」判定：审核时间 ≤ 快照生成时间 → 该轮烘焙已含此条（服务端只烘焙 open 条目，
     与查看时所在运营商/省无关）；genAt=0（Worker 实时源/未知）回退「当前列表可见」兜底；
     reviewed_at 缺省按已展示（历史 open 条目必然早已烘焙） */
  const mineShown = (m) => {
    if ((m.status || "pending") !== "open") return false;
    const rev = Number(m.reviewed_at) || 0;
    if (actState.genAt && rev <= actState.genAt) return true;
    return (actState.items || []).some((x) => String(x.id) === String(m.id));
  };
  /* 我的投稿三态区：默认折叠，点击折叠头展开（actState.mineOpen 记忆展开态） */
  const mineSt = (st, shown) => st === "open" ? (shown
    ? '<span class="act-mine-st ok" title="该投稿已出现在站点展示列表中">已通过 · 已展示</span>'
    : '<span class="act-mine-st ok" title="已通过，等待随下一轮站点数据更新展示（约 0-8 小时）">已通过 · 待展示</span>')
    : st === "rejected" ? '<span class="act-mine-st no">未通过</span>'
    : '<span class="act-mine-st pend">审核中</span>';
  const mineOpen = !!actState.mineOpen;
  const mineHTML = (actState.mine || []).length ? `
    <div class="act-mine${mineOpen ? " open" : ""}">
      <button type="button" class="act-mine-head" data-act="actMineToggle" aria-expanded="${mineOpen}">
        <span class="act-mine-t">${icon("clock")} 我的投稿（${actState.mine.length}）<i class="act-mine-sub">通过后将随下一轮站点数据更新展示（约 0-8 小时）</i></span>
        <i data-icon="chevronDown" class="act-mine-caret"></i>
      </button>
      ${mineOpen ? `<div class="act-mine-list">${actState.mine.map((m) => {
        const st = m.status || "pending";
        return `
      <div class="act-mine-item">
        <span class="act-mode-badge sm ${m.mode === "guide" ? "guide" : "official"}">${m.mode === "guide" ? "攻略" : "官方"}</span>
        <span class="act-badge ${m.province ? "act-prov" : "act-nat"}">${m.province ? esc(m.province) : "全国"}</span>
        <span class="act-mine-title">${esc(m.title)}</span>
        ${mineSt(st, mineShown(m))}
        ${st === "pending" ? `<button type="button" class="btn ghost sm" data-act="actWithdraw" data-id="${esc(m.id)}">撤回</button>` : ""}
        ${st !== "open" ? `<button type="button" class="btn ghost sm" data-act="actEdit" data-id="${esc(m.id)}">编辑</button>` : ""}
        ${st === "rejected" ? `<button type="button" class="btn ghost sm" data-act="actMineDel" data-id="${esc(m.id)}">删除</button>` : ""}
        ${st === "open" ? `<button type="button" class="btn ghost sm" data-act="actRetireReq" data-id="${esc(m.id)}" data-title="${esc(m.title)}">申请撤回</button>` : ""}
        ${st === "rejected" && m.reject_reason ? `<span class="act-mine-reason">驳回原因：${esc(m.reject_reason)}</span>` : ""}
      </div>`;
      }).join("")}</div>` : ""}
    </div>` : "";
  /* 收藏视图：favItems（收藏时间倒序，服务端已滤 open）；常规视图：按 mode + 关键词客户端过滤 */
  const favView = actState.filter === "fav";
  const items = actFilteredItems();
  const emptyTip = favView
    ? (actState.favLoaded ? "暂无收藏，点击情报卡片上的「收藏」按钮即可保存到这里" : "登录后可收藏感兴趣的情报")
    : `暂无${esc(provName)}的${esc(brand)}情报，欢迎投稿第一条！`;
  const q = actState.q.trim();
  const listHTML = items.length
    ? `<div class="act-list">${items.map(actCardHTML).join("")}</div>`
    : `<div class="empty" style="padding:32px;text-align:center">${q ? `没有与「${esc(q)}」匹配的情报` : emptyTip}</div>`;
  const f = actState.form;
  const commonFields = `
        <label><span class="af-l">标题 <b>*</b></span><input class="inp" id="actFTitle" maxlength="40" value="${esc(f.title)}" placeholder="${guide ? "如：携号转网保号攻略" : "如：移动领 10GB 流量包"}"></label>
        <label><span class="af-l">范围</span>
          <select class="sel" id="actFScope">
            <option value="prov" ${f.scope !== "nat" ? "selected" : ""}>${esc(provName || "本省")}</option>
            <option value="nat" ${f.scope === "nat" ? "selected" : ""}>全国</option>
          </select></label>
        ${guide ? `<label><span class="af-l">适用运营商</span>
          <select class="sel" id="actFCarrier">
            <option value="cur" ${!f.allCarriers ? "selected" : ""}>${esc(brand || "当前运营商")}</option>
            <option value="all" ${f.allCarriers ? "selected" : ""}>全运营商通用</option>
          </select></label>` : ""}
        <label><span class="af-l">截止日期 <i>选填 · ${guide ? "留空长期有效" : "到期自动下展"}</i></span><input class="inp" type="date" id="actFEnds" value="${esc(f.ends)}"></label>`;
  const officialFields = `
      <label class="act-panel-full"><span class="af-l">活动地址 <b>*</b></span><input class="inp" id="actFUrl" maxlength="300" value="${esc(f.url)}" placeholder="https:// 活动页面链接"></label>
      <label class="act-panel-full"><span class="af-l">活动简介 <i>选填 · 200 字内</i></span><textarea class="inp" id="actFDescr" maxlength="200" rows="2" placeholder="一句话介绍活动内容与参与方式">${esc(f.descr)}</textarea></label>`;
  const guideFields = `
      <div class="act-panel-full"><span class="af-l">攻略正文 <b>*</b> <i>Markdown · ≤1 万字 · 链接与图片直接写进正文（图片用图床外链）</i></span><div id="actMdHost"></div></div>
      <label class="act-panel-full"><span class="af-l">摘要 <i>选填 · 200 字内，列表卡片展示</i></span><textarea class="inp" id="actFDescr" maxlength="200" rows="2" placeholder="一句话概括攻略要点（留空自动取正文开头）">${esc(f.descr)}</textarea></label>`;
  const qrField = `
      <div class="act-panel-full"><span class="af-l">二维码 <i>选填 · PNG / JPG / WebP，自动压缩</i></span>
        <span class="act-qr-row">
          ${f.qr ? `<span class="act-qr-thumb"><img src="${esc(f.qr.data)}" alt="二维码预览"><button type="button" class="act-qr-del" data-act="actQrClear" title="移除二维码">${icon("x")}</button></span>`
                : `<button type="button" class="btn ghost sm" data-act="actQrPick">${icon("image")}选择图片</button>`}
          <input type="file" id="actFQr" accept="image/png,image/jpeg,image/webp" hidden>
        </span>
      </div>`;
  const anonField = `
      <label class="act-anon-row"><input type="checkbox" id="actFAnon" ${f.anon ? "checked" : ""}><span>匿名展示 <i>公众侧不显示我的昵称与资料卡（管理组审核可见）</i></span></label>`;
  const panel = actState.panelOpen ? `
    <div class="act-panel">
      <div class="act-panel-t">投稿情报（提交后由管理组审核，通过后公开展示；待审上限 5 条）</div>
      ${actModeSeg()}
      <div class="act-panel-grid">${commonFields}</div>
      <div class="act-panel-grid">${guide ? guideFields : officialFields}</div>
      ${guide ? "" : qrField}
      ${anonField}
      <div class="act-panel-actions">
        <button type="button" class="btn ghost" data-act="actCancel">取消</button>
        <button type="button" class="btn primary" data-act="actSubmit"><i data-icon="send"></i>提交审核</button>
      </div>
    </div>` : "";
  el.innerHTML = `
    <h1 class="page-title">情报酒馆</h1>
    <p class="page-sub">${esc(provName)} · ${esc(brand)} · 官方活动推广与个人攻略发布聚合（投稿后经管理组审核展示）</p>
    ${mineHTML}
    <div class="act-toolbar">
      <div class="act-tb-left">
        <input type="search" class="inp act-search" id="actSearch" placeholder="搜索标题 / 简介…" value="${esc(actState.q)}">
        <select class="sel act-scope-sel" id="actScopeSel" title="按范围筛选">
          <option value="">全部范围</option>
          <option value="nat" ${actState.scope === "nat" ? "selected" : ""}>全国·通用</option>
          <option value="prov" ${actState.scope === "prov" ? "selected" : ""}>本省${provName ? `（${esc(provName)}）` : ""}</option>
        </select>
        ${actFilterChips()}
        <!-- 投稿按钮置于左组末尾：宽屏 margin-left:auto 顶到最右（原 space-between 视觉）；
             窄屏 margin-left 归零 + 搜索框独占一行 → 按钮与范围/板块两个下拉同行 -->
        <button type="button" class="btn primary" data-act="actTogglePanel"><i data-icon="plus"></i><span class="act-tb-txt">${actState.panelOpen ? "收起投稿面板" : "投稿情报"}</span></button>
      </div>
    </div>
    ${panel}
    <div id="actListRegion">${listHTML}</div>`;
  mountIcons(el);
  /* 搜索框：输入防抖后仅重绘列表区（不整页重绘，保持输入焦点） */
  const sInp = $("actSearch");
  if (sInp) {
    let sT = 0;
    sInp.addEventListener("input", () => {
      clearTimeout(sT);
      sT = setTimeout(() => { actState.q = sInp.value; actRenderList(); }, 200);
    });
  }
  const scopeSel = $("actScopeSel");
  if (scopeSel) scopeSel.addEventListener("change", () => { actState.scope = scopeSel.value; actRenderList(); });
  /* 板块筛选下拉（手机端替代 chips，见 actFilterChips） */
  const filterSel = $("actFilterSel");
  if (filterSel) filterSel.addEventListener("change", () => { actState.filter = filterSel.value; actRenderList(); });
  /* 行内面板输入同步草稿（innerHTML 重建后重绑） */
  const bind = (id, key) => { const n = $(id); if (n) n.addEventListener("input", () => { actState.form[key] = n.value; actDraftSave(); }); };
  bind("actFTitle", "title"); bind("actFUrl", "url"); bind("actFDescr", "descr"); bind("actFEnds", "ends");
  const sc = $("actFScope");
  if (sc) sc.addEventListener("change", () => { actState.form.scope = sc.value; actDraftSave(); });
  const csel = $("actFCarrier");
  if (csel) csel.addEventListener("change", () => { actState.form.allCarriers = csel.value === "all"; actDraftSave(); });
  const anonCb = $("actFAnon");
  if (anonCb) anonCb.addEventListener("change", () => { actState.form.anon = anonCb.checked; actDraftSave(); });
  /* 攻略正文编辑器：innerHTML 重建后重新挂载（正文先回存 form，草稿从 localStorage 恢复） */
  if (guide && actState.panelOpen) {
    const host = $("actMdHost");
    if (host) {
      if (actState.editor) { actState.form.content = actState.editor.getValue(); actState.editor.destroy(); }
      actState.editor = mdCreateEditor(host, {
        maxlength: ACT_MD_MAX,
        rows: 12,
        draftKey: ACT_DRAFT_KEYS.guide,
        initial: actState.form.content || "",
        placeholder: "用 Markdown 写攻略：## 步骤标题、**重点**、[链接文字](https://…)、> 提示、列表；图片粘贴图床外链（独立成一行）",
        nofollow: true,
        onImage: actImgGuide,
      });
    }
  } else if (actState.editor) {
    actState.form.content = actState.editor.getValue();
    actState.editor.destroy();
    actState.editor = null;
  }
  const qrInput = $("actFQr");
  if (qrInput) qrInput.addEventListener("change", async () => {
    const file = qrInput.files && qrInput.files[0];
    if (!file) return;
    try {
      actState.form.qr = await readQrFile(file);
      actRenderBody();
    } catch (err) {
      toast(typeof err === "string" ? err : "图片处理失败");
    }
    qrInput.value = "";
  });
}

async function actSubmit() {
  if (!Auth.isLoggedIn()) { toast("请先登录后再投稿"); Auth.openLogin(); return; }
  const f = actState.form;
  const guide = actState.mode === "guide";
  const title = (f.title || "").trim();
  const url = (f.url || "").trim();
  if (title.length < 2 || title.length > 40) { toast("标题需 2~40 字"); return; }
  if (!guide && !/^https:\/\/.+/i.test(url)) { toast("活动地址必须为 https:// 链接"); return; }
  if (url && !/^https:\/\/.+/i.test(url)) { toast("链接必须为 https:// 地址"); return; }
  const provName = chProvName();
  if (f.scope !== "nat" && !provName) { toast("省份未就绪，请稍后再试"); return; }
  const ends = f.ends ? new Date(f.ends + "T23:59:59+08:00").getTime() : null;
  if (f.ends && (!Number.isFinite(ends) || ends <= Date.now())) { toast("截止日期必须是未来日期"); return; }
  const content = guide && actState.editor ? actState.editor.getValue().trim() : "";
  if (guide) {
    if (!content) { toast("攻略正文不能为空"); return; }
    if (content.length > ACT_MD_MAX) { toast(`攻略正文不超过 ${ACT_MD_MAX} 字`); return; }
  }
  const r = await api.activityCreate({
    mode: actState.mode,
    carrier: guide && f.allCarriers ? "" : currentCarrier,
    province: f.scope === "nat" ? "" : provName,
    title,
    url: url || undefined,
    descr: (f.descr || "").trim(),
    ends_at: ends,
    content_md: guide ? content : undefined,
    anon: f.anon ? 1 : 0,
    qr: guide ? undefined : (f.qr || undefined),
  });
  if (!r.ok) {
    const cn = {
      ACTIVITY_EXISTS: "已有相同提交（待审或展示中）",
      ACTIVITY_QUOTA_EXCEEDED: "你的待审提交已达 5 条上限，请等审核或先撤回",
      RATE_LIMITED: "提交太频繁，请一小时后再试",
      UNAUTHORIZED: "请先登录",
    };
    // 字段校验错误（后端 data 带 field/message，如二维码无效）优先透出中文 message
    const fieldMsg = r.data && r.data.message ? r.data.message : "";
    toast(cn[r.error] || fieldMsg || r.error || "提交失败");
    return;
  }
  toast("已提交，进入审核；通过后将随下一轮站点数据更新展示（约 0-8 小时）");
  actDraftClear(actState.mode);
  actState.form = { title: "", url: "", scope: f.scope, descr: "", ends: "", qr: null, allCarriers: false, content: "", anon: false };
  actState.panelOpen = false;
  if (actState.editor) { actState.editor.destroy(); actState.editor = null; }
  await actTabRefresh();
  actRenderBody();
}

function actOnBodyClick(e) {
  const actEl = e.target.closest("[data-act]");
  if (!actEl) return;
  const a = actEl.dataset.act;
  if (a === "actTogglePanel") {
    if (!Auth.isLoggedIn()) { toast("请先登录后再投稿"); Auth.openLogin(); return; }
    actState.panelOpen = !actState.panelOpen;
    actRenderBody();
  } else if (a === "actCancel") {
    actState.panelOpen = false;
    actRenderBody();
  } else if (a === "actMode") {
    actSwitchMode(actEl.dataset.mode);
  } else if (a === "actFilter") {
    actState.filter = actEl.dataset.mode || "";
    actRenderBody();
  } else if (a === "actDetail") {
    actOpenDetail(actEl.dataset.id);
  } else if (a === "actAuthor") {
    Auth.showProfileCard(actEl.dataset.uid);
  } else if (a === "actSubmit") {
    actSubmit();
  } else if (a === "actWithdraw") {
    const id = actEl.dataset.id;
    const okGo = confirm("撤回后该提交将删除，确定撤回？");
    if (!okGo) return;
    api.activityDelete(id).then((r) => {
      toast(r.ok ? "已撤回" : (r.error || "撤回失败"));
      if (r.ok) actTabRefreshAndRender();
    });
  } else if (a === "actRetireReq") {
    actRetireReq(actEl.dataset.id, actEl.dataset.title);
  } else if (a === "actMineDel") {
    const id = actEl.dataset.id;
    if (!confirm("确定删除这条被驳回的投稿？删除后不可恢复。")) return;
    api.activityDelete(id).then((r) => {
      toast(r.ok ? "已删除" : (r.error || "删除失败"));
      if (r.ok) actTabRefreshAndRender();
    });
  } else if (a === "actEdit") {
    actEditMine(actEl.dataset.id);
  } else if (a === "actMineToggle") {
    actState.mineOpen = !actState.mineOpen;
    actRenderBody();
  } else if (a === "actQrPick") {
    const fi = $("actFQr");
    if (fi) fi.click();
  } else if (a === "actQrClear") {
    actState.form.qr = null;
    actRenderBody();
  } else if (a === "actQr") {
    actQrModal(actEl.dataset.id, actEl.dataset.title);
  } else if (a === "actCopyLink") {
    actCopyLink(actEl, actEl.dataset.url);
  } else if (a === "actFeedback") {
    actFeedback(actEl.dataset.title, actEl.dataset.url);
  } else if (a === "actShare") {
    /* 列表卡片分享：官方活动卡直接跳外链不进详情弹窗，必须在此提供分享入口（弹窗内同名按钮走 __MODAL_ACT__） */
    shareLink({ title: actEl.dataset.title || "情报酒馆", text: "来自情报酒馆的一条分享", hash: "act_" + currentCarrier + "_" + getProvCode() + "_" + encodeURIComponent(actEl.dataset.id || "") });
  } else if (a === "actFav") {
    if (!Auth.isLoggedIn()) { toast("请先登录后再收藏"); Auth.openLogin(); return; }
    api.activityFavoriteToggle(actEl.dataset.id).then((r) => {
      if (!r.ok) { toast(typeof r.error === "string" ? r.error : (r.error?.message || "操作失败")); return; }
      toast(r.data?.favorited ? "已收藏，可在「我的收藏」页签查看" : "已取消收藏");
      if (favsViewActive()) { favsActLoaded = false; renderFavsPartition(); }   // 收藏页签内：刷新情报分区
      else actTabRefreshAndRender(); // 同步列表收藏标记与收藏视图
    });
  } else if (a === "actPinToggle") {
    const pinned = actEl.dataset.pinned === "1";
    const id = actEl.dataset.id;
    const req = pinned ? api.activityUnpin(id) : api.activityPin(id);
    req.then((r) => {
      if (!r.ok) { toast(typeof r.error === "string" ? r.error : (r.error?.message || "操作失败")); return; }
      toast(pinned ? "已取消置顶" : "已置顶");
      if (favsViewActive()) { favsActLoaded = false; renderFavsPartition(); }
      else actTabRefreshAndRender();
    });
  }
}

/* ─────────────── 唠嗑聚落 tab（社群收录：论坛/QQ群/微信群/贴吧/纸飞机等；activities mode='chat'） ───────────────
   ▸ 数据：/api/communities?carrier&province（复用 activities 表，范围匹配 本省+本运营商全国+通用）
   ▸ 提交：登录用户先审后发（待审≤5 与情报酒馆共享配额）；种类单选；url/群号至少其一
   ▸ 授权凭证（群主/管理员身份截图）选填强提醒，R2 私有存储仅管理组审核可见；二维码复用活动二维码端点
   ▸ 无截止时间（社群长期有效）；可选匿名展示（公众侧匿名 chip，管理组审核可见）；提交者实名/匿名（点头像看资料卡） */
const CHAT_TYPES = ["论坛", "QQ群", "微信群", "贴吧", "纸飞机", "其他"];
const chatState = {
  items: [], mine: [], panelOpen: false, q: "", typeFilter: "", scope: "", loadFailed: false,
  genAt: 0,   // 静态快照 generated_at（秒）：mine「已展示」判定基准（0=未知，走列表兜底判定）
  form: { type: "QQ群", scope: "prov", title: "", url: "", chatId: "", descr: "", anon: false, qr: null, proof: null },
};

let chatProvPending = false; // 直链 #chat 时 STATS 未就绪的补加载守卫（同 acts/announce 模式）
async function chatTabRefresh() {
  const carrierKey = currentCarrier;
  let provName = chProvName();
  if (!provName && !STATS && !chatProvPending) {
    chatProvPending = true;
    try {
      STATS = await loadStats();
      fillProvSelects();
    } catch { /* 失败保留原行为，下次进 tab 重试 */ } finally { chatProvPending = false; }
    provName = chProvName();
  }
  if (!carrierKey) { chatState.items = []; chatState.mine = []; return; }
  /* 公开列表静态源优先（同情报酒馆），失败/缺失回落 Worker API；mine 始终走 Worker */
  const [chatStatic, chatApi] = await Promise.all([
    fetchTimeout(`./data/${carrierKey}/chats.json?v=${Date.now()}`, { cache: "no-store" }).then((x) => x.json()).catch(() => null),
    Auth.isLoggedIn() ? api.communitiesList(carrierKey, provName) : Promise.resolve(null),
  ]);
  if (chatStatic && Array.isArray(chatStatic.items)) {
    chatState.items = chatStatic.items; // 缓存 carrier 全量，省过滤统一在 chatFilteredItems（切省零网络）
    chatState.genAt = Date.parse(chatStatic.generated_at) || 0;   // ISO 字符串 → 毫秒，与 D1 reviewed_at 同单位
    chatState.mine = (chatApi && chatApi.ok) ? (chatApi.data.mine || []) : [];
    chatState.loadFailed = false;
  } else if (chatApi && chatApi.ok) {
    chatState.items = chatApi.data.items || [];
    chatState.genAt = 0;   // Worker 实时源：判定走列表兜底
    chatState.mine = chatApi.data.mine || [];
    chatState.loadFailed = false;
  } else {
    /* 双源皆败：清空陈旧条目（同情报酒馆，防「标题新省、列表旧省」错位） */
    chatState.items = [];
    chatState.genAt = 0;
    chatState.loadFailed = true;
  }
}
function chatTabRefreshAndRender() {
  return chatTabRefresh().then(() => {
    const el = $("view-chat");
    if (el && el.classList.contains("active")) chatRenderBody();
  });
}

/* 我的收录编辑：删除原条目（pending=撤回 / rejected=清理）后回填收录表单重新提交；
   二维码/授权凭证需重新上传（回填提示中说明）。 */
function chatEditMine(id) {
  const m = (chatState.mine || []).find((x) => x.id === id);
  if (!m) { toast("未找到该收录，请刷新后重试"); return; }
  if (!confirm("编辑将撤回当前收录，内容填入下方表单，修改后重新提交审核。二维码/授权凭证（如有）需重新上传，确定继续？")) return;
  api.communityDelete(id).then((r) => {
    if (!r.ok) { toast(r.error || "撤回原收录失败，请稍后再试"); return; }
    // 范围回填：carrier=''=全站通用；carrier+province=仅本省；仅 carrier=仅本运营商
    const scope = !m.carrier ? "all" : (m.province ? "prov" : "carrier");
    chatState.form = {
      type: m.chat_type || "QQ群",
      scope,
      title: m.title || "",
      url: m.url || "",
      chatId: m.chat_id || "",
      descr: m.descr || "",
      anon: !!m.anon,
      qr: null,
      proof: null,
    };
    chatState.panelOpen = true;
    chatTabRefreshAndRender(); // 刷新三态区（原条目已删）并重建表单
    toast("原收录已撤回，内容已填入下方表单，修改后点「提交审核」");
  });
}
function chatRenderIfActive() {
  const el = $("view-chat");
  if (el && el.classList.contains("active")) chatRenderBody();
}

/* 我的投稿「申请撤回」：已展示（open）的投稿不可自删，走工单系统申请管理组核实下架
   （机制同唠嗑聚落 chatRetireReq：sessionStorage 预填 + 跳工单中心） */
function actRetireReq(id, title) {
  const t = String(title || "");
  const okGo = confirm(`将前往工单中心申请撤回已展示的投稿「${t}」，由管理组核实后下架。继续？`);
  if (!okGo) return;
  try {
    sessionStorage.setItem("chinamnos_ticket_prefill", JSON.stringify({
      category: "其他",
      source: "tariff",
      title: `申请撤回投稿：${t}`.slice(0, 60),
      content: `投稿标题：${t}\n投稿编号：${id}\n申请类型：撤回我在情报酒馆的投稿（已通过展示）\n\n撤回原因：\n`,
      banner: "已带入投稿撤回申请预设信息（来自情报酒馆我的投稿），请核对补充后提交",
    }));
  } catch { /* sessionStorage 不可用时跳转后手填 */ }
  Shell.navigate("/ticket");
}

/* 我的收录「申请撤回」：已展示（open）的收录不可自删，走工单系统申请管理组核实下架
   （分类默认「其他」，机制同情报卡片反馈：sessionStorage 预填 + 跳工单中心） */
function chatRetireReq(id, title) {
  const t = String(title || "");
  const okGo = confirm(`将前往工单中心申请撤回已展示的收录「${t}」，由管理组核实后下架。继续？`);
  if (!okGo) return;
  try {
    sessionStorage.setItem("chinamnos_ticket_prefill", JSON.stringify({
      category: "其他",
      source: "tariff",
      title: `申请撤回收录：${t}`.slice(0, 60),
      content: `收录标题：${t}\n收录编号：${id}\n申请类型：撤回我在唠嗑聚落的收录（已通过展示）\n\n撤回原因：\n`,
      banner: "已带入收录撤回申请预设信息（来自唠嗑聚落我的收录），请核对补充后提交",
    }));
  } catch { /* sessionStorage 不可用时跳转后手填 */ }
  Shell.navigate("/ticket");
}

function chatCardHTML(a) {
  const scopeBadge = a.carrier
    ? `<span class="act-badge ${a.province ? "act-prov" : "act-nat"}">${a.province ? esc(a.province) : "全国"}</span>`
    : `<span class="act-badge act-all">全站</span>`;
  const mainAct = a.url
    ? `<a class="btn primary sm act-go" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer nofollow">加入 / 访问<i data-icon="external"></i></a>`
    : (a.chat_id ? `<button type="button" class="btn primary sm" data-act="chatCopyId" data-id="${esc(a.chat_id)}" title="复制群号/账号"><i data-icon="copy"></i>复制群号</button>` : "");
  const authorHTML = a.anon
    ? `<span class="act-anon-chip" title="收录者选择匿名展示">匿名</span>`
    : (a.submitted_by
      ? `<button type="button" class="act-author" data-act="chatAuthor" data-uid="${esc(a.submitted_by)}" title="查看收录者资料卡">${esc(a.submitter_nickname || "用户")}</button>`
      : `<span>${esc(a.submitter_nickname || "用户")}</span>`);
  return `
  <div class="act-card chat-card" data-chat-id="${esc(a.id || "")}">
    <div class="act-main">
      <div class="act-title-line">
        <span class="act-mode-badge chat">${esc(a.chat_type || "其他")}</span>
        ${scopeBadge}
        <b class="act-title">${esc(a.title)}</b>
      </div>
      ${a.descr ? `<div class="act-descr">${esc(a.descr)}</div>` : ""}
      ${a.chat_id ? `<div class="chat-id-line">${icon("hash")} 群号 / 账号：<b>${esc(a.chat_id)}</b></div>` : ""}
      <div class="act-meta">${relTime(Math.floor((a.created_at || 0) / 1000))} 收录 · ${authorHTML}</div>
    </div>
    <div class="act-actions">
      ${mainAct}
      ${a.chat_id && a.url ? `<button type="button" class="btn ghost sm" data-act="chatCopyId" data-id="${esc(a.chat_id)}" title="复制群号/账号"><i data-icon="copy"></i>复制群号</button>` : ""}
      ${a.has_qr ? `<button type="button" class="btn ghost sm" data-act="chatQr" data-id="${esc(a.id)}" data-title="${esc(a.title)}" title="查看群二维码"><i data-icon="qr"></i>二维码</button>` : ""}
      <button type="button" class="btn ghost sm btn-ico-sm" data-act="chatFeedback" data-title="${esc(a.title)}" data-url="${esc(a.url || "")}" title="对该社群反馈或举报（工单中心）"><i data-icon="message"></i><span class="btn-txt">反馈</span></button>
      <button type="button" class="btn ghost sm btn-ico-sm" data-act="chatShare" data-id="${esc(a.id || "")}" data-title="${esc(a.title || "")}" title="分享本收录（复制链接或唤起系统分享）"><i data-icon="share"></i><span class="btn-txt">分享</span></button>
      <button type="button" class="btn ghost sm btn-ico-sm act-fav-btn${a.favorited ? " act-faved" : ""}" data-act="chatFav" data-id="${esc(a.id)}" title="${a.favorited ? "取消收藏" : "收藏到我的收藏"}"><i data-icon="${a.favorited ? "starFill" : "star"}"></i><span class="btn-txt">${a.favorited ? "已收藏" : "收藏"}</span></button>
    </div>
  </div>`;
}

/* 列表过滤（种类/范围 chips 下拉 + 关键词搜索，均客户端执行）：chatRenderBody 与搜索局部重绘共用 */
function chatFilteredItems() {
  let items = chatState.items;
  /* 省过滤在渲染层（切省零网络）：本省 + 本运营商全国 + 通用（province 空） */
  const provName = chProvName();
  items = items.filter((a) => !a.province || a.province === provName);
  if (chatState.typeFilter) items = items.filter((a) => (a.chat_type || "其他") === chatState.typeFilter);
  if (chatState.scope === "nat") items = items.filter((a) => !a.province);      // 全国·通用
  else if (chatState.scope === "prov") items = items.filter((a) => !!a.province); // 本省收录
  const q = chatState.q.trim().toLowerCase();
  if (q) items = items.filter((a) => `${a.title || ""}\n${a.descr || ""}\n${a.chat_id || ""}`.toLowerCase().includes(q));
  return items;
}

/* 列表区局部重绘（搜索输入时保持输入焦点与滚动位置） */
function chatRenderList() {
  const el = $("chatListRegion");
  if (!el) return;
  const provName = chProvName();
  const items = chatFilteredItems();
  const q = chatState.q.trim();
  el.innerHTML = items.length
    ? `<div class="act-list">${items.map(chatCardHTML).join("")}</div>`
    : `<div class="empty" style="padding:32px;text-align:center">${(q || chatState.typeFilter) ? "没有匹配的社群，试试调整搜索词或种类筛选" : (chatState.loadFailed ? "社群加载失败，请检查网络后稍后再试" : `暂无${esc(provName)}的社群，欢迎收录第一条！`)}</div>`;
  mountIcons(el);
}

function chatRenderBody() {
  const el = $("chatTabBody");
  if (!el) return;
  const provName = chProvName();
  const brand = (CARRIER_BRAND[currentCarrier] || {}).shortName || "";
  /* 我的收录三态区（与情报酒馆同款三态；默认折叠，点击展开） */
  const chatShown = (m) => {
    if ((m.status || "pending") !== "open") return false;
    const rev = Number(m.reviewed_at) || 0;
    if (chatState.genAt && rev <= chatState.genAt) return true;
    return (chatState.items || []).some((x) => String(x.id) === String(m.id));
  };
  const chatMineSt = (st, shown) => st === "open" ? (shown
    ? '<span class="act-mine-st ok" title="该收录已出现在站点展示列表中">已通过 · 已展示</span>'
    : '<span class="act-mine-st ok" title="已通过，等待随下一轮站点数据更新展示（约 0-8 小时）">已通过 · 待展示</span>')
    : st === "rejected" ? '<span class="act-mine-st no">未通过</span>'
    : '<span class="act-mine-st pend">审核中</span>';
  const chatMineOpen = !!chatState.mineOpen;
  const mineHTML = (chatState.mine || []).length ? `
    <div class="act-mine${chatMineOpen ? " open" : ""}">
      <button type="button" class="act-mine-head" data-act="chatMineToggle" aria-expanded="${chatMineOpen}">
        <span class="act-mine-t">我的收录（${chatState.mine.length}）<i class="act-mine-sub">通过后将随下一轮站点数据更新展示（约 0-8 小时）</i></span>
        <i data-icon="chevronDown" class="act-mine-caret"></i>
      </button>
      ${chatMineOpen ? `<div class="act-mine-list">${chatState.mine.map((m) => {
        const st = m.status || "pending";
        return `
      <div class="act-mine-row">
        <span class="act-mine-badge">${esc(m.chat_type || "其他")}</span>
        <span class="act-mine-title">${esc(m.title)}</span>
        ${chatMineSt(st, chatShown(m))}
        ${st === "pending" ? `<button type="button" class="btn ghost sm" data-act="chatWithdraw" data-id="${esc(m.id)}">撤回</button>` : ""}
        ${st !== "open" ? `<button type="button" class="btn ghost sm" data-act="chatEdit" data-id="${esc(m.id)}">编辑</button>` : ""}
        ${st === "rejected" ? `<button type="button" class="btn ghost sm" data-act="chatMineDel" data-id="${esc(m.id)}">删除</button>` : ""}
        ${st === "open" ? `<button type="button" class="btn ghost sm" data-act="chatRetireReq" data-id="${esc(m.id)}" data-title="${esc(m.title)}">申请撤回</button>` : ""}
        ${st === "rejected" && m.reject_reason ? `<span class="act-mine-reason">驳回原因：${esc(m.reject_reason)}</span>` : ""}
      </div>`;
      }).join("")}</div>` : ""}
    </div>` : "";
  /* 种类筛选 chips（从当前数据归纳，保证与列表内容一致）+ 关键词过滤 */
  const types = [...new Set(chatState.items.map((a) => a.chat_type || "其他"))];
  const typeChips = [`<button type="button" class="act-filter-chip${chatState.typeFilter === "" ? " active" : ""}" data-act="chatTypeFilter" data-type="">全部</button>`]
    .concat(types.map((t) => `<button type="button" class="act-filter-chip${chatState.typeFilter === t ? " active" : ""}" data-act="chatTypeFilter" data-type="${esc(t)}">${esc(t)}</button>`)).join("");
  const items = chatFilteredItems();
  const q = chatState.q.trim();
  const listHTML = items.length
    ? `<div class="act-list">${items.map(chatCardHTML).join("")}</div>`
    : `<div class="empty" style="padding:32px;text-align:center">${(q || chatState.typeFilter) ? "没有匹配的社群，试试调整搜索词或种类筛选" : `暂无${esc(provName)}的${esc(brand)}社群，欢迎收录第一条！`}</div>`;
  const f = chatState.form;
  const scopeBtn = (v, label) => `<button type="button" class="act-filter-chip${f.scope === v ? " active" : ""}" data-act="chatScope" data-scope="${v}">${label}</button>`;
  const qrBlock = (pickAct, clearAct, key, label) => `
        <span class="act-qr-row">
          ${f[key] ? `<span class="act-qr-thumb"><img src="${esc(f[key].data)}" alt="${esc(label)}预览"><button type="button" class="act-qr-del" data-act="${clearAct}" title="移除图片">${icon("x")}</button></span>`
                : `<button type="button" class="btn ghost sm" data-act="${pickAct}">${icon("image")}选择图片</button>`}
          <input type="file" id="chatF_${key}" accept="image/png,image/jpeg,image/webp" hidden>
        </span>`;
  const panel = chatState.panelOpen ? `
    <div class="act-panel">
      <div class="act-panel-t">收录社群（提交后由管理组审核，通过后公开展示；待审上限 5 条）</div>
      <div class="act-panel-grid">
        <label><span class="af-l">种类 <b>*</b></span>
          <select class="sel" id="chatFType">${CHAT_TYPES.map((t) => `<option value="${t}" ${f.type === t ? "selected" : ""}>${t}</option>`).join("")}</select></label>
        <label class="act-panel-full"><span class="af-l">范围 <b>*</b> <i>决定社群展示在哪些页签</i></span>
          <div class="act-filter chat-scope">${scopeBtn("all", "通用 · 全站")}${scopeBtn("carrier", `仅 ${esc(brand || "当前运营商")}`)}${scopeBtn("prov", `仅 ${esc(brand || "当前运营商")} ${esc(provName || "…")}`)}</div></label>
        <label><span class="af-l">社群名称 <b>*</b></span><input class="inp" id="chatFTitle" maxlength="40" value="${esc(f.title)}" placeholder="如：湖南移动宽带交流群"></label>
        <label><span class="af-l">加入链接 <i>论坛/贴吧/TG 链接等</i></span><input class="inp" id="chatFUrl" maxlength="300" value="${esc(f.url)}" placeholder="https://…（微信群可留空）"></label>
        <label><span class="af-l">群号 / 账号</span><input class="inp" id="chatFId" maxlength="50" value="${esc(f.chatId)}" placeholder="如 QQ 群号、微信号（链接与群号至少填其一）"></label>
        <label class="act-panel-full"><span class="af-l">说明介绍 <i>选填 · 200 字内</i></span><textarea class="inp" id="chatFDescr" maxlength="200" rows="2" placeholder="群定位、活跃度、入群须知等">${esc(f.descr)}</textarea></label>
        <div class="act-panel-full"><span class="af-l">群二维码 <i>选填 · PNG / JPG / WebP，自动压缩</i></span>${qrBlock("chatQrPick", "chatQrClear", "qr", "二维码")}</div>
        <div class="act-panel-full"><span class="af-l">授权凭证 <i>选填 · 强烈建议上传，可大幅加快审核</i></span>${qrBlock("chatProofPick", "chatProofClear", "proof", "凭证")}</div>
      </div>
      <label class="act-anon-row"><input type="checkbox" id="chatFAnon" ${f.anon ? "checked" : ""}><span>匿名展示 <i>公众侧不显示我的昵称与资料卡（管理组审核可见）</i></span></label>
      <div class="act-form-note">${icon("shield")} 授权凭证（群主/管理员身份截图等）仅用于管理组核验你的收录权限，<b>不会公开展示</b>。</div>
      <div class="act-panel-actions">
        <button type="button" class="btn ghost" data-act="chatCancel">取消</button>
        <button type="button" class="btn primary" data-act="chatSubmit"><i data-icon="send"></i>提交审核</button>
      </div>
    </div>` : "";
  el.innerHTML = `
    <h1 class="page-title">唠嗑聚落</h1>
    <p class="page-sub">${esc(provName)} · ${esc(brand)} · 交流社群聚合（论坛 / QQ 群 / 微信群 / 贴吧 / 纸飞机，投稿后经管理组审核展示）</p>
    ${mineHTML}
    <div class="act-toolbar">
      <div class="act-tb-left">
        <input type="search" class="inp act-search" id="chatSearch" placeholder="搜索社群名称 / 说明 / 群号…" value="${esc(chatState.q)}">
        <select class="sel act-scope-sel" id="chatScopeSel" title="按范围筛选">
          <option value="">全部范围</option>
          <option value="nat" ${chatState.scope === "nat" ? "selected" : ""}>全国·通用</option>
          <option value="prov" ${chatState.scope === "prov" ? "selected" : ""}>本省${provName ? `（${esc(provName)}）` : ""}</option>
        </select>
        <div class="act-filter act-filter-tb">${typeChips}</div>
        <select class="sel act-scope-sel act-filter-sel" id="chatTypeSel" title="按种类筛选">
          <option value=""${chatState.typeFilter === "" ? " selected" : ""}>全部种类</option>
          ${types.map((t) => `<option value="${esc(t)}"${chatState.typeFilter === t ? " selected" : ""}>${esc(t)}</option>`).join("")}
        </select>
        <!-- 收录按钮置于左组末尾：宽屏 margin-left:auto 顶到最右；窄屏与范围/种类下拉同行（同情报酒馆） -->
        <button type="button" class="btn primary" data-act="chatTogglePanel"><i data-icon="plus"></i><span class="act-tb-txt">${chatState.panelOpen ? "收起收录面板" : "收录社群"}</span></button>
      </div>
    </div>
    <div class="chat-tb-note">${icon("info")}<span>欢迎收录你运营或知晓的交流社群，让更多同好找到组织；入群请遵守群规并自行甄别信息，站点仅提供信息展示渠道</span></div>
    ${panel}
    <div id="chatListRegion">${listHTML}</div>`;
  mountIcons(el);
  /* 搜索框：输入防抖后仅重绘列表区（不整页重绘，保持输入焦点） */
  const sInp = $("chatSearch");
  if (sInp) {
    let sT = 0;
    sInp.addEventListener("input", () => {
      clearTimeout(sT);
      sT = setTimeout(() => { chatState.q = sInp.value; chatRenderList(); }, 200);
    });
  }
  const scopeSel = $("chatScopeSel");
  if (scopeSel) scopeSel.addEventListener("change", () => { chatState.scope = scopeSel.value; chatRenderList(); });
  /* 种类筛选下拉（手机端替代 chips，走 chatRenderBody 保持 chips/下拉选中态同步） */
  const typeSel = $("chatTypeSel");
  if (typeSel) typeSel.addEventListener("change", () => { chatState.typeFilter = typeSel.value; chatRenderBody(); });
  /* 表单输入同步内存草稿（innerHTML 重建后重绑；草稿不落 localStorage，切 tab 保留） */
  const bindV = (id, key) => { const n = $(id); if (n) { n.value = chatState.form[key] || ""; n.addEventListener("input", () => { chatState.form[key] = n.value; }); } };
  bindV("chatFTitle", "title"); bindV("chatFUrl", "url"); bindV("chatFId", "chatId"); bindV("chatFDescr", "descr");
  const ts = $("chatFType");
  if (ts) { ts.value = chatState.form.type || "QQ群"; ts.addEventListener("change", () => { chatState.form.type = ts.value; }); }
  const anonCb = $("chatFAnon");
  if (anonCb) anonCb.addEventListener("change", () => { chatState.form.anon = anonCb.checked; });
  const qrInput = $("chatF_qr");
  if (qrInput) qrInput.addEventListener("change", async () => {
    const file = qrInput.files && qrInput.files[0];
    if (!file) return;
    try { chatState.form.qr = await readQrFile(file); chatRenderBody(); } catch (err) { toast(typeof err === "string" ? err : "图片处理失败"); }
    qrInput.value = "";
  });
  const proofInput = $("chatF_proof");
  if (proofInput) proofInput.addEventListener("change", async () => {
    const file = proofInput.files && proofInput.files[0];
    if (!file) return;
    try { chatState.form.proof = await readQrFile(file); chatRenderBody(); } catch (err) { toast(typeof err === "string" ? err : "图片处理失败"); }
    proofInput.value = "";
  });
}

async function chatSubmit() {
  if (!Auth.isLoggedIn()) { toast("请先登录后再收录社群"); Auth.openLogin(); return; }
  const f = chatState.form;
  const title = (f.title || "").trim();
  const url = (f.url || "").trim();
  const chatId = (f.chatId || "").trim();
  if (title.length < 2 || title.length > 40) { toast("名称需 2~40 字"); return; }
  if (url && !/^https:\/\/.+/i.test(url)) { toast("加入链接必须为 https:// 地址"); return; }
  if (!url && !chatId) { toast("加入方式至少提供其一：链接或群号/账号"); return; }
  const provName = chProvName();
  if (f.scope === "prov" && !provName) { toast("省份未就绪，请稍后再试"); return; }
  const body = {
    chat_type: f.type, scope: f.scope,
    carrier: currentCarrier,
    province: provName,
    title, url, chat_id: chatId, descr: (f.descr || "").trim(),
    anon: !!f.anon,
  };
  if (f.qr) body.qr = f.qr;
  if (f.proof) body.proof = f.proof;
  const r = await api.communityCreate(body);
  if (!r.ok) { toast(typeof r.error === "string" ? r.error : (r.error?.message || (r.data && r.data.message) || "提交失败，请稍后再试")); return; }
  chatState.panelOpen = false;
  chatState.form = { type: "QQ群", scope: "prov", title: "", url: "", chatId: "", descr: "", anon: false, qr: null, proof: null };
  toast("已提交，进入审核；通过后将随下一轮站点数据更新展示（约 0-8 小时）");
  chatTabRefreshAndRender();
}

function chatOnBodyClick(e) {
  const actEl = e.target.closest("[data-act]");
  if (!actEl) return;
  const a = actEl.dataset.act;
  if (a === "chatTogglePanel") {
    if (!Auth.isLoggedIn()) { toast("请先登录后再收录社群"); Auth.openLogin(); return; }
    chatState.panelOpen = !chatState.panelOpen;
    chatRenderBody();
  } else if (a === "chatCancel") {
    chatState.panelOpen = false;
    chatRenderBody();
  } else if (a === "chatScope") {
    chatState.form.scope = actEl.dataset.scope || "prov";
    chatRenderBody();
  } else if (a === "chatTypeFilter") {
    chatState.typeFilter = actEl.dataset.type || "";
    chatRenderBody();
  } else if (a === "chatQrPick") {
    const fi = $("chatF_qr");
    if (fi) fi.click();
  } else if (a === "chatQrClear") {
    chatState.form.qr = null;
    chatRenderBody();
  } else if (a === "chatProofPick") {
    const fi = $("chatF_proof");
    if (fi) fi.click();
  } else if (a === "chatProofClear") {
    chatState.form.proof = null;
    chatRenderBody();
  } else if (a === "chatSubmit") {
    chatSubmit();
  } else if (a === "chatWithdraw") {
    const id = actEl.dataset.id;
    const okGo = confirm("撤回后该收录将删除，确定撤回？");
    if (!okGo) return;
    api.communityDelete(id).then((r) => {
      toast(r.ok ? "已撤回" : (r.error || "撤回失败"));
      if (r.ok) chatTabRefreshAndRender();
    });
  } else if (a === "chatMineDel") {
    const id = actEl.dataset.id;
    if (!confirm("确定删除这条被驳回的收录？删除后不可恢复。")) return;
    api.communityDelete(id).then((r) => {
      toast(r.ok ? "已删除" : (r.error || "删除失败"));
      if (r.ok) chatTabRefreshAndRender();
    });
  } else if (a === "chatEdit") {
    chatEditMine(actEl.dataset.id);
  } else if (a === "chatRetireReq") {
    chatRetireReq(actEl.dataset.id, actEl.dataset.title);
  } else if (a === "chatMineToggle") {
    chatState.mineOpen = !chatState.mineOpen;
    chatRenderBody();
  } else if (a === "chatAuthor") {
    Auth.showProfileCard(actEl.dataset.uid);
  } else if (a === "chatQr") {
    actQrModal(actEl.dataset.id, actEl.dataset.title);
  } else if (a === "chatCopyId") {
    actCopyLink(actEl, actEl.dataset.id);
  } else if (a === "chatFeedback") {
    actFeedback(actEl.dataset.title, actEl.dataset.url);
  } else if (a === "chatShare") {
    /* 分享本收录：深链带运营商+省（社群卡片按省过滤，跨范围打开看不到条目） */
    shareLink({ title: actEl.dataset.title || "唠嗑聚落", text: "来自唠嗑聚落的一条社群收录", hash: "chat_" + currentCarrier + "_" + getProvCode() + "_" + encodeURIComponent(actEl.dataset.id || "") });
  } else if (a === "chatFav") {
    if (!Auth.isLoggedIn()) { toast("请先登录后再收藏"); Auth.openLogin(); return; }
    api.activityFavoriteToggle(actEl.dataset.id).then((r) => {
      if (!r.ok) { toast(typeof r.error === "string" ? r.error : (r.error?.message || "操作失败")); return; }
      toast(r.data?.favorited ? "已收藏，可在「我的收藏」页签查看" : "已取消收藏");
      if (favsViewActive()) { favsActLoaded = false; renderFavsPartition(); }
      else chatTabRefreshAndRender();
    });
  }
}

/* 活动二维码文件读取：小图保留原始编码（PNG 防压缩失真），超大/超宽先等比缩到 ≤1500，
   PNG 超限再降级 JPEG 循环降质，最终与后端 300KB 上限对齐 */
function readQrFile(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|jpg|webp)$/i.test(file.type)) { reject("仅支持 PNG / JPG / WebP 图片"); return; }
    if (file.size > 8 * 1024 * 1024) { reject("图片文件过大（>8MB）"); return; }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) { reject("图片读取失败"); return; }
      const MAX = 1500;
      if (w > MAX || h > MAX || file.size > 280 * 1024) {
        if (w > MAX || h > MAX) { const r = Math.min(MAX / w, MAX / h); w = Math.round(w * r); h = Math.round(h * r); }
        const cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        cv.getContext("2d").drawImage(img, 0, 0, w, h);
        let data = cv.toDataURL("image/png");
        if (data.length > 380000) {
          let q = 0.85;
          data = cv.toDataURL("image/jpeg", q);
          while (data.length > 380000 && q > 0.5) { q -= 0.12; data = cv.toDataURL("image/jpeg", q); }
        }
        resolve({ data, w, h });
        return;
      }
      const fr = new FileReader();
      fr.onload = () => resolve({ data: String(fr.result), w, h });
      fr.onerror = () => reject("图片读取失败");
      fr.readAsDataURL(file);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject("图片读取失败"); };
    img.src = url;
  });
}

/* ─────────────── 页面级数据引导 ───────────────
   资费监控下任何子菜单（变更记录/公告/酒馆/唠嗑/监控/关于…）直链进入时，顶栏快照状态、
   运营商切换、省份选择器、动态页签都必须就绪——此前只有 #overview 走 renderOverview 全链路，
   其余直链顶栏永远停在「加载中…」。本函数仅做页面级公共引导（幂等可并发，localStorage 缓存命中时零请求），
   总览面板渲染仍归 renderOverview 自有链路，互不影响 */
let bootstrapPromise = null;
function ensureTariffBootstrapped() {
  if (STATS && ACTIVE_CARRIERS.length) return Promise.resolve(STATS);
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = loadStats().then(s => {
    bootstrapPromise = null;
    renderCarrierSwitch(s.all_carriers);
    if (!ACTIVE_CARRIERS.length) { $("updateTime").textContent = "-"; return s; }   // 全站未启用运营商：保持空态
    if (!ACTIVE_CARRIERS.includes(currentCarrier)) { switchCarrier(ACTIVE_CARRIERS[0]); return s; }   // 当前运营商未启用：switchCarrier 自行引导（回总览）
    applyBrandIdentity(CARRIER_BRAND[currentCarrier]); // 骨架为静态默认值，恢复当前运营商 logo/标题
    fillProvSelects();
    chTabRefresh(true); // 跳蚤市集 tab 显隐探测（须在 fillProvSelects 之后，同 renderOverview）
    annPrefetch();      // 预拉当前运营商公告：未读红点 + 进 tab 零等待
    updateOfficialLink();
    buildDynamicTabs(s);
    const todayAdd = Object.values(s.today || {}).reduce((sum, c) => sum + (c && c.added ? c.added : 0), 0);
    const todayRm = Object.values(s.today || {}).reduce((sum, c) => sum + (c && c.removed ? c.removed : 0), 0);
    setStat("stNational", s.total_unique == null ? "-" : s.total_unique);
    setStat("stTodayAdd", todayAdd);
    setStat("stTodayRm", todayRm);
    $("updateTime").textContent = fmtTime(s.crawl_time);
    renderHealth(s);
    return s;
  }).catch(() => { bootstrapPromise = null; });
  return bootstrapPromise;
}

/* ─────────────── 数据总览 ─────────────── */
function renderOverview() {
  showLoading();
  loadStats().then(s => {
    STATS = s;
    renderCarrierSwitch(s.all_carriers);

    if (ACTIVE_CARRIERS.length === 0) {
      hideLoading();
      const overviewEl = $("view-overview");
      if (overviewEl) {
        overviewEl.innerHTML = '<div class="empty" style="padding:40px;text-align:center">暂无启用的运营商，请先在配置中启用至少一个运营商并运行采集脚本</div>';
      }
      return;
    }

    const savedCarrier = (() => { try { return localStorage.getItem(CARRIER_STORAGE_KEY); } catch { return null; } })();
    let initialCarrier;
    if (savedCarrier && ACTIVE_CARRIERS.includes(savedCarrier)) {
      initialCarrier = savedCarrier;
    } else if (s.default_carrier && ACTIVE_CARRIERS.includes(s.default_carrier)) {
      initialCarrier = s.default_carrier;
    } else {
      initialCarrier = ACTIVE_CARRIERS[0];
    }

    if (initialCarrier !== currentCarrier) {
      switchCarrier(initialCarrier);
      return;
    }

    if (!ACTIVE_CARRIERS.includes(currentCarrier)) {
      hideLoading();
      switchCarrier(ACTIVE_CARRIERS[0]);
      return;
    }

    applyBrandIdentity(CARRIER_BRAND[currentCarrier]); // 页面重入：恢复当前运营商 logo/标题（骨架为静态默认值，shell 已先设通用页标题）
    fillProvSelects();
    chTabRefresh(true); // #gProv 已填充 → 省份中文名可用 → 跳蚤市集 tab 探测（须在 fillProvSelects 之后）
    actTabRefreshAndRender(); // 情报酒馆列表随省份联动
    annPrefetch(); // 预拉当前运营商公告：未读红点 + 进 tab 零等待
    updateOfficialLink();
    buildDynamicTabs(s);
    // 全网资费总量（去重）：采集端跨省按条目名去重（全网+31省专区）；旧 stats 无该字段时显示 "-"
    const natTariffs = s.total_unique;
    const todayAdd = Object.values(s.today || {}).reduce((sum, c) => sum + (c && c.added ? c.added : 0), 0);
    const todayRm = Object.values(s.today || {}).reduce((sum, c) => sum + (c && c.removed ? c.removed : 0), 0);

    setStat("stNational", natTariffs == null ? "-" : natTariffs);
    setStat("stTodayAdd", todayAdd);
    setStat("stTodayRm", todayRm);
    $("updateTime").textContent = fmtTime(s.crawl_time);

    renderHealth(s);
    renderProvStatsRow(s);
    renderHeatmap(s);
    renderDistBars();
    renderRankList(s);
    renderPriceHist();
    hideLoading();
  }).catch(e => {
    hideLoading();
    const brand = CARRIER_BRAND[currentCarrier];
    const overviewEl = $("view-overview");
    if (overviewEl) {
      overviewEl.innerHTML = '<div class="empty" style="padding:40px;text-align:center">' + esc(brand.name) + ' 数据尚未部署，请先运行对应运营商的采集脚本</div>';
    }
  });
}

function renderProvStatsRow(s) {
  const el = $("provStatsRow");
  if (!el) return;
  const code = getProvCode();
  const p = s.provinces ? s.provinces.find(x => x.code === code) : null;
  if (!p) { el.innerHTML = ""; return; }
  const name = provName(code);
  // 「占全国」分母 = 全网资费总量（去重，跨省按方案编号去重、无编号回退名称，含全网+31省专区）
  const allTariffs = s.total_unique || 0;
  const pTariffs = p.total ? p.total.tariffs : 0;
  const pct = allTariffs > 0 ? ((pTariffs / allTariffs) * 100).toFixed(1) : "0";
  const pAdd = Object.values(p.today || {}).reduce((sum, c) => sum + (c && c.added ? c.added : 0), 0);
  const pRm = Object.values(p.today || {}).reduce((sum, c) => sum + (c && c.removed ? c.removed : 0), 0);
  const pChg = Object.values(p.today || {}).reduce((sum, c) => sum + (c && c.changed ? c.changed : 0), 0);
  const bdItems = [];
  Object.keys(p.breakdown || {}).forEach(attr => {
    const v = p.breakdown[attr];
    if (v && v.tariffs) bdItems.push(`<span class="bd-item"><span class="bd-lab">${esc(attrLabel(attr))}</span><span class="bd-num">${fmt(v.tariffs)}</span></span>`);
  });
  const bdHtml = bdItems.length ? bdItems.join("") : `<span class="bd-num">-</span>`;
  el.innerHTML = `
    <div class="stat-card tilt"><div class="stat-info"><div class="stat-label">${esc(name)} 资费总数</div><div class="stat-value accent">${fmt(pTariffs)}<span style="font-size:13px;color:var(--sub);font-weight:400;margin-left:6px">占全国 ${pct}%</span></div></div><div class="stat-icon total">${icon("home")}</div></div>
    <div class="stat-card tilt" style="cursor:pointer" data-act="provStatCl" title="点击查看本省变更日志"><div class="stat-info"><div class="stat-label">今日新增</div><div class="stat-value green">${fmt(pAdd)}</div></div><div class="stat-icon added">${icon("plusCircle")}</div></div>
    <div class="stat-card tilt" style="cursor:pointer" data-act="provStatCl" title="点击查看本省变更日志"><div class="stat-info"><div class="stat-label">今日下架 / 变更</div><div class="stat-value" style="font-size:21px"><span style="color:var(--red)">${fmt(pRm)}</span> / <span style="color:var(--amber)">${fmt(pChg)}</span></div></div><div class="stat-icon removed">${icon("edit")}</div></div>
    <div class="stat-card tilt stat-card-bd"><div class="stat-info"><div class="stat-label">分类资费分布</div><div class="bd-list">${bdHtml}</div></div><div class="stat-icon sum">${icon("chart")}</div></div>
  `;
}

function renderHealth(s) {
  const dot = $("healthDot");
  const txt = $("healthText");
  const meta = $("healthMeta");
  const statusMap = {success: ["ok","正常"], partial_failure: ["warn","部分失败"], total_failure: ["err","全部失败"]};
  const [cls, label] = statusMap[s.status] || ["warn", s.status];
  dot.className = "status-dot " + cls;
  txt.textContent = label;
  const parts = [];
  if (s.last_crawl_duration_ms) parts.push(`耗时 ${fmtDur(s.last_crawl_duration_ms)}`);
  if (s.next_crawl_time) parts.push(`下次 ${fmtCountdown(s.next_crawl_time)}`);
  meta.textContent = parts.join(" · ");
}

function renderHeatmap(s) {
  const box = $("heatmap");
  const provs = s.provinces || [];
  const activeCodes = new Set(provs.map(p => p.code));
  const maxTotal = Math.max(1, ...provs.map(p => (p.total ? p.total.tariffs : 0)));
  let html = "";
  let i = 0;
  PROVINCE_GRID().forEach(row => {
    row.forEach(cell => {
      if (!cell) { html += '<div class="heatmap-tile" style="visibility:hidden"></div>'; return; }
      if (!activeCodes.has(cell.c)) {
        html += `<div class="heatmap-tile inactive" style="--i:${i}" data-code="${cell.c}" data-name="${esc(cell.n)}" title="${esc(cell.n)}：暂未采集">
          <span class="ht-name">${esc(cell.n)}</span>
          <span class="ht-count">未采集</span>
        </div>`;
        i++;
        return;
      }
      const p = provs.find(x => x.code === cell.c);
      const total = p && p.total ? p.total.tariffs : 0;
      const pct = Math.max(2, (total / maxTotal) * 100);
      const statusCls = (p.crawl_status === "success" || p.crawl_status === "degrade_auto_recovered") ? "ok" : p.crawl_status === "failed" ? "err" : "warn";
      html += `<div class="heatmap-tile" style="--i:${i}" data-code="${cell.c}" title="${esc(cell.n)}：${fmt(total)} 个资费">
        <span class="ht-name">${esc(cell.n)}</span>
        <span class="ht-count">${total ? fmt(total) : "-"}</span>
        <div class="ht-bar" data-w="${pct}%" style="width:0;background:linear-gradient(90deg,var(--acc-2),var(--acc-deep))"></div>
        ${statusCls ? `<span class="status-dot-inline ${statusCls}"></span>` : ""}
      </div>`;
      i++;
    });
  });
  box.innerHTML = html;
  animateBars(box);
}

let _tipTimer = null;
function showUncollectedTip(tile, name) {
  let tip = document.getElementById("provTip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "provTip";
    tip.className = "prov-tip";
    document.body.appendChild(tip);
  }
  tip.innerHTML = `<span class="prov-tip-ico">${icon("box")}</span><span>${esc(name)} 数据暂未采集</span>`;
  tip.classList.add("show");
  const rect = tile.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  let left = rect.left + rect.width / 2 - tipRect.width / 2;
  let top = rect.top - tipRect.height - 10;
  if (left < 8) left = 8;
  if (left + tipRect.width > window.innerWidth - 8) left = window.innerWidth - tipRect.width - 8;
  if (top < 8) top = rect.bottom + 10;
  tip.style.left = left + "px";
  tip.style.top = top + "px";
  if (_tipTimer) clearTimeout(_tipTimer);
  _tipTimer = setTimeout(() => tip.classList.remove("show"), 2500);
}

function renderDistBars() {
  const code = getProvCode();
  const p = STATS && STATS.provinces ? STATS.provinces.find(x => x.code === code) : null;
  const name = provName(code);
  $("distDesc").textContent = name + " · 分类分布";

  if (!p || !p.dist) {
    $("distBars").innerHTML = '<div class="empty">暂无该省分类统计</div>';
    return;
  }

  const groups = {};
  const attrKeys = Object.keys(p.dist);
  attrKeys.forEach(attr => {
    const type1Obj = p.dist[attr] || {};
    const type1Keys = Object.keys(type1Obj);
    type1Keys.forEach(t1 => {
      const type2Obj = type1Obj[t1] || {};
      Object.keys(type2Obj).forEach(t2 => {
        const n = type2Obj[t2] || 0;
        if (n > 0) {
          if (!groups[attr]) groups[attr] = [];
          groups[attr].push({label: `${t1Label(t1)} · ${t2Label(t2)}`, n});
        }
      });
    });
  });

  const groupKeys = Object.keys(groups);
  if (groupKeys.length === 0) {
    $("distBars").innerHTML = '<div class="empty">暂无分类统计</div>';
    return;
  }

  const renderGroup = (attr, startIdx) => {
    const rows = groups[attr].slice().sort((a, b) => b.n - a.n);
    const max = Math.max(1, ...rows.map(r => r.n));
    let g = `<div class="dist-group-title">${esc(attrLabel(attr))}</div>`;
    rows.forEach((r, i) => {
      const cls = (startIdx + i) % 3 === 1 ? " alt" : (startIdx + i) % 3 === 2 ? " alt2" : "";
      g += `<div class="bar-row"><span>${esc(r.label)}</span><div class="bar-track"><div class="bar-fill${cls}" data-w="${Math.max((r.n / max) * 100, 2)}%" style="width:0"></div></div><span class="bar-num">${fmt(r.n)}</span></div>`;
    });
    return g;
  };

  let html = '<div class="dist-grid">';
  let idx = 0;
  groupKeys.forEach(attr => {
    html += `<div>${renderGroup(attr, idx)}</div>`;
    idx += groups[attr].length;
  });
  html += '</div>';
  $("distBars").innerHTML = html;
  animateBars($("distBars"));
}

/* ─────────────── 各省排行 Top6 + 价格区间分布 ─────────────── */
function renderRankList(s) {
  const el = $("rankList");
  if (!el) return;
  const rows = (s.provinces || [])
    .map(p => ({ code: p.code, name: p.name, n: (p.total && p.total.tariffs) || 0 }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 6);
  if (!rows.length) { el.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  const max = Math.max(1, rows[0].n);
  const cur = getProvCode();
  el.innerHTML = rows.map((r, i) =>
    `<button type="button" class="rank-row${r.code === cur ? " cur" : ""}" data-prov="${esc(r.code)}" title="查看${esc(r.name)}详情">` +
    `<span class="rank-no${i < 3 ? " n" + (i + 1) : ""}">${i + 1}</span>` +
    `<span class="rank-name">${esc(r.name)}</span>` +
    `<span class="rank-track"><span class="rank-fill" data-w="${Math.max((r.n / max) * 100, 4)}%"></span></span>` +
    `<span class="rank-num">${fmt(r.n)}</span></button>`
  ).join("");
  requestAnimationFrame(() => {
    el.querySelectorAll(".rank-fill").forEach(b => { b.style.width = b.dataset.w; });
  });
}

const PRICE_BUCKETS = [
  { label: "免费/0元", test: p => p <= 0 },
  { label: "1-19元", test: p => p <= 19 },
  { label: "20-39元", test: p => p <= 39 },
  { label: "40-59元", test: p => p <= 59 },
  { label: "60-99元", test: p => p <= 99 },
  { label: "100-199元", test: p => p <= 199 },
  { label: "200元以上", test: () => true },
];
function renderPriceHist() {
  const el = $("priceHist");
  if (!el) return;
  const code = getProvCode();
  const desc = $("priceDesc");
  if (desc) desc.textContent = provName(code) + " · 基于当前快照";
  el.innerHTML = '<div class="loading">加载中…</div>';
  loadSnapshot(code).then(snap => {
    const items = (snap && snap.items) || [];
    const counts = PRICE_BUCKETS.map(() => 0);
    items.forEach(it => {
      const f = repFields(it);
      const raw = String((f && f["资费标准"]) || "");
      if (!raw || !/\d/.test(raw)) return;
      const p = priceOf(it);
      const idx = PRICE_BUCKETS.findIndex(b => b.test(p));
      if (idx >= 0) counts[idx]++;
    });
    const total = counts.reduce((a, b) => a + b, 0);
    if (!total) { el.innerHTML = '<div class="empty">暂无资费数据</div>'; return; }
    const max = Math.max(1, ...counts);
    el.innerHTML = PRICE_BUCKETS.map((b, i) =>
      `<div class="ph-col" title="${esc(b.label)}：${counts[i]} 个套餐（占 ${(counts[i] / total * 100).toFixed(1)}%）">` +
      `<span class="ph-num">${counts[i] ? fmt(counts[i]) : ""}</span>` +
      `<span class="ph-bar" data-h="${Math.max((counts[i] / max) * 100, 2)}%"></span>` +
      `<span class="ph-label">${esc(b.label)}</span></div>`
    ).join("");
    requestAnimationFrame(() => {
      el.querySelectorAll(".ph-bar").forEach(b => { b.style.height = b.dataset.h; });
    });
  }).catch(() => {
    el.innerHTML = '<div class="empty">快照加载失败</div>';
  });
}

/* ─────────────── 动态分类页签 ─────────────── */
function buildDynamicTabs(stats) {
  const codeSet = new Set();
  (stats.provinces || []).forEach(p => {
    if (p.dist) {
      Object.keys(p.dist).forEach(attr => { if (p.dist[attr]) codeSet.add(attr); });
    }
  });

  const codes = Array.from(codeSet).filter(c => c && c !== "0");
  if (codes.length === 0) {
    codes.push(...Object.keys(ATTR_MAP).sort());
  } else {
    codes.sort();
  }

  if (JSON.stringify(codes) === JSON.stringify(dynamicType1Keys)) return;

  if (navTabs) dynamicType1Keys.forEach(code => navTabs.remove(t1ViewId(code)));
  $("dynamicViews").innerHTML = "";
  dynamicType1Keys = codes;

  const dynViews = $("dynamicViews");
  if (!dynViews || !navTabs) return;

  codes.forEach(code => {
    const name = ATTR_MAP[code] || ("分类" + code);
    const ic = ATTR_ICONS[code] || "box";
    const sub = ATTR_SUBS[code] || "资费套餐一览";
    const vid = t1ViewId(code);

    navTabs.add(vid, { label: name, iconHtml: `<div class="nav-icon">${icon(ic)}</div>`, before: "changelog" });

    const section = document.createElement("section");
    section.id = "view-" + vid;
    section.className = "view";
    section.innerHTML = `
      <h1 class="page-title">${icon(ic, "title-ic")} ${esc(name)}</h1>
      <p class="page-sub">${esc(sub)}</p>
      <div class="toolbar">
        <div class="sort-bar" id="${t1Id(code, "sortBar")}">
          <span class="sort-tit">排序</span>
          <button type="button" class="sort-btn" data-sort="time">最新上架</button>
          <button type="button" class="sort-btn" data-sort="price">按价格</button>
          <button type="button" class="sort-btn s-dir" data-sort="dir" hidden>降序 ↓</button>
        </div>
        <div class="view-mode" id="${t1Id(code, "cardMode")}" title="卡片形态切换">
          <button type="button" class="vm-btn${cardMode === "list" ? " on" : ""}" data-mode="list">列表</button>
          <button type="button" class="vm-btn${cardMode === "card" ? " on" : ""}" data-mode="card">卡片</button>
        </div>
        <div class="filter-bar" id="${t1Id(code, "filterBar")}">
          <span class="filter-tit">筛选</span>
          <button type="button" class="filter-btn toggle-btn" id="${t1Id(code, "zeroBtn")}">零元</button>
          <button type="button" class="filter-btn toggle-btn" id="${t1Id(code, "favBtn")}">${icon("star")} 只看收藏<span class="fav-badge"${favCount() ? "" : " hidden"}>${favCount()}</span></button>
          <span class="filter-group"><span class="filter-label">价格</span>
          <input type="number" id="${t1Id(code, "priceMin")}" class="filter-input" placeholder="最低" min="0">
          <span class="filter-sep">~</span>
          <input type="number" id="${t1Id(code, "priceMax")}" class="filter-input" placeholder="最高" min="0"></span>
          <span class="filter-group"><span class="filter-label">上线</span>
          <input type="date" id="${t1Id(code, "dateFrom")}" class="filter-input date-input">
          <span class="filter-sep">~</span>
          <input type="date" id="${t1Id(code, "dateTo")}" class="filter-input date-input"></span>
          <span class="filter-group"><span class="filter-label">下线</span>
          <input type="date" id="${t1Id(code, "offFrom")}" class="filter-input date-input">
          <span class="filter-sep">~</span>
          <input type="date" id="${t1Id(code, "offTo")}" class="filter-input date-input"></span>
          <button type="button" class="filter-btn clear-btn" id="${t1Id(code, "clearFilter")}">清除</button>
        </div>
        <div class="search-wrap"><button type="button" class="search-mode-btn" id="${t1Id(code, "qmode")}" title="切换搜索范围：全部内容（名称+字段） / 仅名称">全部</button><input type="search" id="${t1Id(code, "search")}" class="search-box" placeholder="搜索名称/资费标准/说明…"><kbd class="search-kbd" title="按 / 快速聚焦">/</kbd></div>
        <select id="${t1Id(code, "attr")}" class="sel" style="width:auto"><option value="">全部归属</option></select>
        <select id="${t1Id(code, "type2")}" class="sel" style="width:auto"><option value="">全部类型</option></select>
        <button class="btn ghost btn-ico-sm" id="${t1Id(code, "exportCsv")}" title="导出当前筛选结果为 CSV">${icon("download")}<span class="btn-txt">导出</span></button>
        <button class="btn ghost btn-ico-sm" id="${t1Id(code, "reload")}" title="重新加载当前列表（按当前筛选重新拉取快照）">${icon("refresh")}<span class="btn-txt">重新加载</span></button>
        <span class="count-hint" id="${t1Id(code, "count")}"></span>
      </div>
      <div class="list" id="${t1Id(code, "list")}"><div class="loading">选择省份后加载${esc(name)}数据…</div></div>
      <div class="pager" id="${t1Id(code, "pager")}"></div>
    `;
    dynViews.appendChild(section);
    bindListSection(code);
  });

  if (pendingTab) {
    const viewEl = $("view-" + pendingTab);
    if (viewEl) {
      goTab(pendingTab);
      pendingTab = null;
    }
  }
}

/* ─────────────── 资费列表 ─────────────── */
const PAGE_SIZE = 20;
const listState = {};

/* 卡片形态：list（列表，默认） / card（浮动卡） */
const CARD_MODE_KEY = "chinamnos_v2_cardmode";
let cardMode = (() => { try { return localStorage.getItem(CARD_MODE_KEY) === "card" ? "card" : "list"; } catch { return "list"; } })();
function setCardMode(mode) {
  cardMode = mode === "card" ? "card" : "list";
  try { localStorage.setItem(CARD_MODE_KEY, cardMode); } catch {}
  const root = document.getElementById("tariffRoot") || document;
  root.querySelectorAll(".view-mode .vm-btn").forEach(b => b.classList.toggle("on", b.dataset.mode === cardMode));
  root.querySelectorAll(".list").forEach(l => l.classList.toggle("mode-card", cardMode === "card"));
}

function updateAttrOptions(selId, items) {
  const sel = $(selId);
  if (!sel) return;
  const prev = sel.value;
  const present = new Set((items || []).map(it => it.type1));
  const opts = Object.keys(TYPE1_MAP).filter(k => present.has(k)).map(k => [k, t1Label(k)]);
  sel.innerHTML = '<option value="">全部归属</option>' + opts.map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
  sel.value = present.has(prev) ? prev : "";
}

function updateType2Options(selId, items) {
  const sel = $(selId);
  if (!sel) return;
  const prev = sel.value;
  const present = new Set((items || []).map(it => it.type2));
  const opts = Object.keys(TYPE2_MAP).filter(k => present.has(k)).map(k => [k, t2Label(k)]);
  sel.innerHTML = '<option value="">全部类型</option>' + opts.map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
  sel.value = present.has(prev) ? prev : "";
}

function getListState(key) {
  /* 默认「最新上架」降序：原始顺序是采集落库序（按分类抓取顺序拼接），无时间/价格语义，
     不排序会让用户无从判断条目次序；清除筛选/重新加载也回到该默认值 */
  if (!listState[key]) listState[key] = {items: null, page: 1, q: "", qMode: "all", attr: "", type2: "", sort: "time", order: -1, zeroOnly: false, favOnly: false, priceMin: null, priceMax: null, dateFrom: null, dateTo: null, offFrom: null, offTo: null, changeMap: null};
  return listState[key];
}

function renderList(type1Code) {
  const code = getProvCode();
  const st = getListState(type1Code + "_" + code);
  const listEl = $(t1Id(type1Code, "list"));

  if (!st.items) {
    listEl.innerHTML = '<div class="loading">加载资费数据…</div>';
    loadSnapshot(code).then(snap => {
      st.items = (snap.items || []).filter(it => it.tariff_attr === type1Code);
      updateAttrOptions(t1Id(type1Code, "attr"), st.items);
      updateType2Options(t1Id(type1Code, "type2"), st.items);
      syncSortUI($(t1Id(type1Code, "sortBar")), st); // 首屏同步默认排序高亮（默认「最新上架」降序）
      loadChangelog(code).then(cl => {
        st.changeMap = {};
        (cl.logs || []).forEach(log => { if (log.id) st.changeMap[log.id] = log.type; });
        drawList(type1Code, code);
      }).catch(() => { st.changeMap = {}; drawList(type1Code, code); });
    }).catch(e => {
      listEl.innerHTML = '<div class="empty">数据加载失败：' + esc(e.message) + ' <button data-act="retryList" data-arg="' + esc(type1Code) + '" class="btn sm soft">重试</button></div>';
    });
  } else {
    updateAttrOptions(t1Id(type1Code, "attr"), st.items);
    updateType2Options(t1Id(type1Code, "type2"), st.items);
    drawList(type1Code, code);
  }
}

/** 每个动态分类 section 的事件绑定（创建时绑定一次，事件委托） */
function bindListSection(type1Code) {
  const section = $("view-" + t1ViewId(type1Code));
  if (!section || section.dataset.bound) return;
  section.dataset.bound = "1";

  const searchId = t1Id(type1Code, "search");
  const attrId = t1Id(type1Code, "attr");
  const type2Id = t1Id(type1Code, "type2");
  const searchEl = $(searchId);
  if (!searchEl) return;

  searchEl.addEventListener("input", () => {
    const s = getListState(type1Code + "_" + getProvCode());
    s.q = searchEl.value.trim().toLowerCase();
    s.page = 1;
    drawList(type1Code, getProvCode());
  });

  /* 搜索范围切换：all=全部内容（名称+字段） / name=仅名称。
     绑定时先按既有状态同步按钮与 placeholder（页面重入后骨架重建，避免按钮显示与实际模式脱节） */
  const qmodeEl = $(t1Id(type1Code, "qmode"));
  if (qmodeEl) {
    const syncSearchMode = () => {
      const sm = getListState(type1Code + "_" + getProvCode()).qMode;
      qmodeEl.textContent = sm === "name" ? "仅名称" : "全部";
      qmodeEl.classList.toggle("name-mode", sm === "name");
      searchEl.placeholder = sm === "name" ? "搜索资费名称…" : "搜索名称/资费标准/说明…";
    };
    syncSearchMode();
    qmodeEl.addEventListener("click", () => {
      const s = getListState(type1Code + "_" + getProvCode());
      s.qMode = s.qMode === "name" ? "all" : "name";
      syncSearchMode();
      if (s.q) { s.page = 1; drawList(type1Code, getProvCode()); } // 有关键词才需重筛，无则仅切模式
    });
  }

  $(attrId).addEventListener("change", () => {
    const s = getListState(type1Code + "_" + getProvCode());
    s.attr = $(attrId).value;
    s.page = 1;
    drawList(type1Code, getProvCode());
  });

  $(type2Id).addEventListener("change", () => {
    const s = getListState(type1Code + "_" + getProvCode());
    s.type2 = $(type2Id).value;
    s.page = 1;
    drawList(type1Code, getProvCode());
  });

  const zeroBtn = $(t1Id(type1Code, "zeroBtn"));
  const favBtnEl = $(t1Id(type1Code, "favBtn"));
  const priceMinEl = $(t1Id(type1Code, "priceMin"));
  const priceMaxEl = $(t1Id(type1Code, "priceMax"));
  const dateFromEl = $(t1Id(type1Code, "dateFrom"));
  const dateToEl = $(t1Id(type1Code, "dateTo"));
  const offFromEl = $(t1Id(type1Code, "offFrom"));
  const offToEl = $(t1Id(type1Code, "offTo"));
  const clearBtn = $(t1Id(type1Code, "clearFilter"));

  const syncFilters = () => {
    const s = getListState(type1Code + "_" + getProvCode());
    s.priceMin = priceMinEl.value !== "" ? parseFloat(priceMinEl.value) : null;
    s.priceMax = priceMaxEl.value !== "" ? parseFloat(priceMaxEl.value) : null;
    s.dateFrom = dateFromEl.value || null;
    s.dateTo = dateToEl.value || null;
    s.offFrom = offFromEl.value || null;
    s.offTo = offToEl.value || null;
    s.page = 1;
    drawList(type1Code, getProvCode());
  };
  [priceMinEl, priceMaxEl, dateFromEl, dateToEl, offFromEl, offToEl].forEach(el => el.addEventListener("change", syncFilters));

  section.addEventListener("click", (e) => {
    const t = e.target;

    // 排序
    const sortBtn = t.closest(".sort-btn");
    if (sortBtn) {
      const c = getProvCode();
      const s = getListState(type1Code + "_" + c);
      const sort = sortBtn.dataset.sort;
      if (sort === "dir") { s.order = (s.order == null ? -1 : s.order) * -1; }
      else if (s.sort === sort) { s.sort = null; s.order = null; } // 再次点击已激活键 → 取消排序回到默认
      else { s.sort = sort; s.order = sort === "price" ? 1 : -1; }
      s.page = 1;
      syncSortUI(sortBtn.closest(".sort-bar"), s);
      drawList(type1Code, c);
      return;
    }

    // 卡片形态切换（列表 / 浮动卡）
    const modeBtn = t.closest(".view-mode .vm-btn");
    if (modeBtn && section.contains(modeBtn)) {
      setCardMode(modeBtn.dataset.mode);
      drawList(type1Code, getProvCode());
      return;
    }

    // 零元筛选
    if (t.closest("#" + t1Id(type1Code, "zeroBtn"))) {
      const s = getListState(type1Code + "_" + getProvCode());
      s.zeroOnly = !s.zeroOnly;
      s.page = 1;
      zeroBtn.classList.toggle("active", s.zeroOnly);
      drawList(type1Code, getProvCode());
      return;
    }

    // 只看收藏
    if (t.closest("#" + t1Id(type1Code, "favBtn"))) {
      const s = getListState(type1Code + "_" + getProvCode());
      s.favOnly = !s.favOnly;
      s.page = 1;
      if (favBtnEl) favBtnEl.classList.toggle("active", s.favOnly);
      drawList(type1Code, getProvCode());
      return;
    }

    // 收藏星标
    const favBtn = t.closest(".fav-btn");
    if (favBtn && section.contains(favBtn)) {
      e.stopPropagation();
      const fid = favBtn.dataset.favId;
      const s0 = getListState(type1Code + "_" + getProvCode());
      const item = (s0.items || []).find(x => String(x.id) === String(fid)) || null;
      toggleFavById(fid, item);
      const on = isFav(fid);
      favBtn.classList.toggle("on", on);
      favBtn.title = on ? "取消收藏" : "收藏";
      favBtn.innerHTML = icon(on ? "starFill" : "star");
      if (s0.favOnly) drawList(type1Code, getProvCode());
      return;
    }

    // 复制资费名称 / 概要
    const copyBtn = t.closest(".copy-btn");
    if (copyBtn && section.contains(copyBtn)) {
      e.stopPropagation();
      /* 分享本条资费：深链 plan_<运营商>_<省>_<页签code>_<方案编号（回退名称）>。
         页签维度 = 条目的 tariff_attr（1=各省通用 / 2=本省专属），与所在 section 的 type1Code 一致——
         注意不要取 it.type1（那是资费大类 个人/政企，另一个维度，取错会导致深链打开错误页签） */
      if (copyBtn.dataset.planShare) {
        const s1 = getListState(type1Code + "_" + getProvCode());
        const it1 = (s1.items || []).find(x => String(x.id) === String(copyBtn.dataset.planShare));
        const key = it1 ? ((it1.fields && it1.fields["方案编号"]) || it1.name || "") : (copyBtn.dataset.shareKey || "");
        shareLink({ title: (it1 && it1.name) || "资费条目", text: "一条资费详情", hash: "plan_" + currentCarrier + "_" + getProvCode() + "_" + type1Code + "_" + encodeURIComponent(key) });
        return;
      }
      const cid = copyBtn.dataset.copyId;
      const s0 = getListState(type1Code + "_" + getProvCode());
      const item = (s0.items || []).find(x => String(x.id) === String(cid));
      if (item) {
        const mode = copyBtn.dataset.copy;
        const text = mode === "name" ? String(item.name || "") : summaryOf(item);
        copyToClipboard(text).then(ok => {
          if (!ok) return;
          const old = copyBtn.innerHTML;
          copyBtn.innerHTML = icon("check");
          copyBtn.classList.add("ok");
          setTimeout(() => { copyBtn.innerHTML = old; copyBtn.classList.remove("ok"); }, 1200);
        });
      }
      return;
    }

    // 导出 CSV
    if (t.closest("#" + t1Id(type1Code, "exportCsv"))) {
      exportListCsv(type1Code, getProvCode());
      return;
    }

    // 清除筛选
    if (t.closest("#" + t1Id(type1Code, "clearFilter"))) {
      const s = getListState(type1Code + "_" + getProvCode());
      s.q = ""; s.attr = ""; s.type2 = "";
      s.zeroOnly = false; s.favOnly = false; s.priceMin = null; s.priceMax = null; s.dateFrom = null; s.dateTo = null; s.offFrom = null; s.offTo = null;
      s.sort = "time"; s.order = -1; // 清除筛选也回到默认「最新上架」降序（与 getListState 初始值一致）
      zeroBtn.classList.remove("active");
      if (favBtnEl) favBtnEl.classList.remove("active");
      searchEl.value = "";
      $(attrId).value = "";
      $(type2Id).value = "";
      priceMinEl.value = ""; priceMaxEl.value = ""; dateFromEl.value = ""; dateToEl.value = ""; offFromEl.value = ""; offToEl.value = "";
      syncSortUI($(t1Id(type1Code, "sortBar")), s);
      s.page = 1;
      drawList(type1Code, getProvCode());
      return;
    }

    // 重新加载
    if (t.closest("#" + t1Id(type1Code, "reload"))) {
      const c = getProvCode();
      listState[type1Code + "_" + c] = null;
      $(searchId).value = "";
      zeroBtn.classList.remove("active");
      if (favBtnEl) favBtnEl.classList.remove("active");
      priceMinEl.value = ""; priceMaxEl.value = "";
      dateFromEl.value = ""; dateToEl.value = ""; offFromEl.value = ""; offToEl.value = "";
      $(attrId).value = "";
      $(type2Id).value = "";
      renderList(type1Code);
      return;
    }

    // 分页：上一页 / 下一页
    const pageBtn = t.closest('.pager button[data-p]');
    if (pageBtn && section.contains(pageBtn)) {
      const s = getListState(type1Code + "_" + getProvCode());
      s.page += Number(pageBtn.dataset.p);
      drawList(type1Code, getProvCode());
      window.scrollTo({top: 0, behavior: "smooth"});
      return;
    }

    // 分页：跳转到指定页
    const pgBtn = t.closest('.pager button[data-pg]');
    if (pgBtn && section.contains(pgBtn)) {
      const s = getListState(type1Code + "_" + getProvCode());
      s.page = Number(pgBtn.dataset.pg);
      drawList(type1Code, getProvCode());
      window.scrollTo({top: 0, behavior: "smooth"});
      return;
    }

    // 其他说明折叠
    const notesToggle = t.closest(".notes-toggle");
    if (notesToggle) {
      e.stopPropagation();
      notesToggle.closest(".notes-block").classList.toggle("open");
      return;
    }

    // 条目展开/收起：卡片形态整卡可点；列表形态整行可点（点击详情内容区不触发展收起）
    const card = t.closest(".item, .tcard");
    if (card && section.contains(card)) {
      if (card.classList.contains("tcard")) {
        toggleCardDetail(card);
      } else {
        // 列表形态：点击详情内容区（fields-table / notes-block）时不触发展收起
        if (t.closest(".detail")) return;
        const d = card.querySelector(".detail");
        if (d) d.classList.toggle("open");
      }
    }
  });
}

/* ─────────────── 卡片模式：全宽详情面板 ───────────────
   点击卡片后，在该卡片所在行的末尾插入一个占满整行的详情面板，
   避免同行其他卡片被拉高。再次点击同一卡片则收起。 */
function toggleCardDetail(card) {
  const list = card.parentElement;
  if (!list) return;

  // 已存在的全宽详情面板
  const existing = list.querySelector(".card-detail-panel");
  const existingFor = existing ? existing.dataset.forCard : null;
  const cardId = card.dataset.cardId || (card.dataset.cardId = "c_" + Math.random().toString(36).slice(2, 9));

  // 若当前卡片已是展开状态 → 收起
  if (existing && existingFor === cardId) {
    closeCardDetail(list);
    return;
  }

  // 先移除已有面板（切换到其他卡片时）
  if (existing) existing.remove();

  // 计算当前列数，找到被点击卡片所在行的末尾卡片
  const cols = getComputedStyle(list).gridTemplateColumns.split(" ").filter(Boolean).length || 1;
  const cards = Array.from(list.children).filter(el => el.classList.contains("tcard"));
  const idx = cards.indexOf(card);
  const rowStart = Math.floor(idx / cols) * cols;
  const rowEnd = Math.min(rowStart + cols - 1, cards.length - 1);
  const anchor = cards[rowEnd];

  // 从卡片内取出详情 HTML（卡片内 .detail 被 CSS 隐藏，仅作内容源）
  const innerDetail = card.querySelector(".detail");
  const html = innerDetail ? innerDetail.innerHTML : "";

  const panel = document.createElement("div");
  panel.className = "card-detail-panel";
  panel.dataset.forCard = cardId;
  panel.innerHTML = html; // 包含 .detail-inner > .detail-inner-pad

  // 面板头部：名称 + 价格 + 关闭按钮，明确面板对应的卡片
  const pad = panel.querySelector(".detail-inner-pad");
  if (pad) {
    const name = (card.querySelector(".tc-name") || {}).textContent || "";
    const price = (card.querySelector(".tc-price") || {}).textContent || "";
    const head = document.createElement("div");
    head.className = "cdp-head";
    head.innerHTML =
      `<span class="cdp-badge">资费详情</span>` +
      `<div class="cdp-name">${esc(name)}</div>` +
      (price ? `<span class="cdp-price">${esc(price)}</span>` : "") +
      `<button class="cdp-close" type="button" title="收起">` +
      `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>` +
      `</button>`;
    head.querySelector(".cdp-close").addEventListener("click", (e) => {
      e.stopPropagation();
      closeCardDetail(list);
    });
    pad.prepend(head);
  }

  // 插入到行末卡片之后
  anchor.after(panel);

  // 指示箭头：指向源卡片中心，直观关联面板与卡片
  const arrow = document.createElement("div");
  arrow.className = "cdp-arrow";
  panel.prepend(arrow);

  // 高亮当前卡片
  list.querySelectorAll(".tcard.detail-active").forEach(c => c.classList.remove("detail-active"));
  card.classList.add("detail-active");

  // 触发展开动画
  requestAnimationFrame(() => {
    panel.classList.add("open");
    const pr = panel.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    const x = Math.max(16, Math.min(cr.left + cr.width / 2 - pr.left, pr.width - 16));
    arrow.style.setProperty("--ax", x + "px");
    panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}
function closeCardDetail(list) {
  const panel = list.querySelector(".card-detail-panel");
  if (!panel) return;
  panel.classList.remove("open");
  const onEnd = () => {
    panel.remove();
    list.querySelectorAll(".tcard.detail-active").forEach(c => c.classList.remove("detail-active"));
  };
  panel.addEventListener("transitionend", onEnd, { once: true });
  // 兜底：过渡结束事件可能不触发
  setTimeout(() => { if (panel.parentElement) onEnd(); }, 400);
}

/* ─────────────── 收藏 v2（localStorage: chinamnos_v2_favs_v2）+ 导出 CSV ───────────────
   结构：{ [carrier]: { [prov]: { [id]: { n:名称, p:收藏时价格, t:收藏时间 } } } }
   - 按运营商+省份隔离（用户需求）；id 内含 carrier_prov 前缀
   - 附快照：条目下架后可在"只看收藏"视图中以快照呈现并标记"已下架"；
     价格与快照不一致时标记"价格已变"
   - 旧键 chinamnos_v2_favs（{carrier:[id]}）首次自动迁移：按 id 前缀归省，
     无法解析的归 "*" 通配桶；旧键保留不删 */
const FAV_KEY_V2 = "chinamnos_v2_favs_v2";
const OLD_FAV_KEY = "chinamnos_v2_favs";
const FAV_LEGACY = "*";
let RAW_FAVS = {};

function loadFavs() {
  migrateFavs();
  try { RAW_FAVS = JSON.parse(localStorage.getItem(FAV_KEY_V2) || "{}") || {}; } catch { RAW_FAVS = {}; }
  if (typeof RAW_FAVS !== "object") RAW_FAVS = {};
}
function migrateFavs() {
  try {
    if (localStorage.getItem(FAV_KEY_V2)) return;
    const raw = JSON.parse(localStorage.getItem(OLD_FAV_KEY) || "null");
    if (!raw || typeof raw !== "object") return;
    const out = {};
    Object.keys(raw).forEach(carrier => {
      const arr = raw[carrier];
      if (!Array.isArray(arr)) return;
      const cb = out[carrier] = out[carrier] || {};
      arr.forEach(id => {
        const s = String(id);
        const parts = s.split("_");
        const prov = parts.length > 2 && /^[a-z]{2,3}$/.test(parts[1]) ? parts[1] : FAV_LEGACY;
        (cb[prov] = cb[prov] || {})[s] = { t: Date.now() };
      });
    });
    localStorage.setItem(FAV_KEY_V2, JSON.stringify(out));
  } catch {}
}
function favBuckets() {
  // 当前运营商：当前省份桶 + 旧迁移的通配桶
  const cb = RAW_FAVS[currentCarrier] || {};
  return [cb[getProvCode()] || {}, cb[FAV_LEGACY] || {}];
}
function isFav(id) { const k = String(id); return favBuckets().some(b => Object.prototype.hasOwnProperty.call(b, k)); }
function favSnap(id) {
  const k = String(id);
  const b = favBuckets().find(x => Object.prototype.hasOwnProperty.call(x, k));
  return b ? b[k] : null;
}
function favCount() { return favBuckets().reduce((n, b) => n + Object.keys(b).length, 0); }
function toggleFavById(id, it) {
  const k = String(id);
  const cb = RAW_FAVS[currentCarrier] = RAW_FAVS[currentCarrier] || {};
  const prov = getProvCode();
  const pb = cb[prov] = cb[prov] || {};
  const lb = cb[FAV_LEGACY] = cb[FAV_LEGACY] || {};
  if (Object.prototype.hasOwnProperty.call(pb, k)) {
    delete pb[k];
  } else if (Object.prototype.hasOwnProperty.call(lb, k)) {
    // 通配桶中取消 → 落到当前省份为未收藏，同时移除通配记录
    delete lb[k];
  } else {
    let p = "";
    try { p = it ? (repFields(it)["资费标准"] || "") : ""; } catch {}
    /* f = 完整字段快照：收藏的下架条目日后可全字段参与资费对比（旧记录无 f 自动降级）。
       分类名（type1/type2 → 归属/资费类型，如"个人资费·加装包"）不在 fields 里，
       源站用编码表达——收藏时补全进 f，否则收藏详情会缺分类信息 */
    let f = it ? Object.assign({}, repFields(it) || {}) : undefined;
    if (f && it && !f["资费类型"]) {
      const catName = [TYPE1_MAP[it.type1], TYPE2_MAP[it.type2]].filter(Boolean).join("·");
      if (catName) f["资费类型"] = catName;
    }
    /* a = 页签码（tariff_attr）：收藏卡片分享深链 plan_ 需要（缺省回退 "1"） */
    pb[k] = { n: it ? it.name : "", p, t: Date.now(), f, a: it ? (it.tariff_attr || "1") : undefined };
  }
  saveFavs();
  refreshFavBadges();
}
function saveFavs() {
  try { localStorage.setItem(FAV_KEY_V2, JSON.stringify(RAW_FAVS)); } catch {}
}
function refreshFavBadges() {
  const n = favCount();
  document.querySelectorAll(".fav-badge").forEach(b => { b.hidden = !n; b.textContent = n; });
}

function exportListCsv(type1Code, code) {
  const st = getListState(type1Code + "_" + code);
  const filtered = filterItems(st);
  if (st.zeroOnly) filtered.sort((a, b) => zeroRank(a) - zeroRank(b));
  else if (st.sort) sortFiltered(filtered, st);
  if (!filtered.length) return;
  const COLS = ["方案编号","资费标准","资费类型","归属","适用范围","适用地区","上线日期","下线日期","有效期限","国内通用流量","定向流量","国内通话","宽带","权益","销售渠道"];
  const q = v => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  const rows = [["名称","分类","类型","ID"].concat(COLS).map(q).join(",")];
  filtered.forEach(it => {
    const f = it.fields || {};
    rows.push([q(it.name), q(attrLabel(it.tariff_attr)), q(t1Label(it.type1) + (it.type2 ? "/" + t2Label(it.type2) : "")), q(it.id)]
      .concat(COLS.map(c => q(f[c]))).join(","));
  });
  const blob = new Blob(["\ufeff" + rows.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = currentCarrier + "_" + code + "_" + type1Code + "_tariffs_" + new Date().toISOString().slice(0, 10) + ".csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function filterItems(st) {
  const src = st.items || [];
  return src.filter(it => {
    if (st.attr && it.type1 !== st.attr) return false;
    if (st.type2 && it.type2 !== st.type2) return false;
    if (st.zeroOnly && !isZeroFee(it)) return false;
    if (st.favOnly && !isFav(it.id)) return false;
    if (st.priceMin != null || st.priceMax != null) {
      const p = priceOf(it);
      if (isNaN(p)) return false; // 无价格信息的条目不参与价格区间筛选
      if (st.priceMin != null && p < st.priceMin) return false;
      if (st.priceMax != null && p > st.priceMax) return false;
    }
    if (st.dateFrom || st.dateTo) {
      const d = dateOf(repFields(it)["上线日期"]);
      if (st.dateFrom && d < st.dateFrom) return false;
      if (st.dateTo && d > st.dateTo) return false;
    }
    if (st.offFrom || st.offTo) {
      const d = dateOf(repFields(it)["下线日期"]);
      if (!d) return false; // 无下线日期（仍在售）不参与下线范围筛选
      if (st.offFrom && d < st.offFrom) return false;
      if (st.offTo && d > st.offTo) return false;
    }
    if (st.q) {
      if (st.qMode === "name") {
        // 仅名称模式：只匹配资费名称
        if (!String(it.name || "").toLowerCase().includes(st.q)) return false;
      } else {
        // 全部内容模式（默认）：名称 + 全部字段值
        const f = it.fields || {};
        const hay = (it.name + " " + Object.values(f).filter(v => v != null && v !== "").join(" ")).toLowerCase();
        if (!hay.includes(st.q)) return false;
      }
    }
    return true;
  });
}

function repFields(it) {
  return it.fields || {};
}
function timeOf(it) {
  /* 完整解析「2026年9月30日」等格式到日粒度（复用 dateOf，与日期筛选一致）。
     旧实现只抓年份（new Date(年,0,1)），同年内全部同键，降序退化成数组原始顺序，
     导致「最新上架」排序错乱（如 9-30 上架排不过 8 月的老条目） */
  const d = dateOf(repFields(it)["上线日期"]);
  return d ? new Date(d + "T00:00:00+08:00").getTime() : 0;
}
function dateOf(raw) {
  if (!raw) return "";
  const m = String(raw).match(/(\d{4})[年/\-.](\d{1,2})[月/\-.](\d{1,2})/);
  if (m) return m[1] + "-" + m[2].padStart(2, "0") + "-" + m[3].padStart(2, "0");
  const ym = String(raw).match(/(\d{4})[年/\-.](\d{1,2})/);
  if (ym) return ym[1] + "-" + ym[2].padStart(2, "0") + "-01";
  const y = String(raw).match(/(20\d{2})/);
  if (y) return y[1] + "-01-01";
  return "";
}
function priceOf(it) {
  const raw = String(repFields(it)["资费标准"] || "");
  const m = raw.match(/\d+(?:\.\d+)?/);
  if (!m) return /免费/.test(raw) ? 0 : NaN; // "免费"视为 0 元，其余无数字视为未知价格
  return parseFloat(m[0]);
}
function isZeroFee(it) {
  const raw = String(repFields(it)["资费标准"] || "");
  const m = raw.match(/\d+(?:\.\d+)?/);
  // 有明确正价格（如"300元/月（首月免费）"）不算零元
  if (m && parseFloat(m[0]) >= 0.01) return false;
  // 其余：含"免费" 或 首数字≈0 视为零元
  return /免费/.test(raw) || (!!m && parseFloat(m[0]) < 1e-9);
}
function zeroRank(it) {
  const f = repFields(it);
  const raw = String(f["资费标准"] || "");
  if (/次/.test(raw)) return 2;
  if (/月/.test(raw) || /免费/.test(raw)) return 0;
  return 1;
}

function sortFiltered(arr, st) {
  if (!st.sort) return;
  const dir = (st.order == null ? -1 : st.order) < 0 ? -1 : 1;
  arr.sort((a, b) => {
    if (st.sort === "price") {
      const av = priceOf(a);
      const bv = priceOf(b);
      // 无价格信息（NaN）永远沉底；0 元按真实价格参与排序（升序时 0 元开头）
      const aNaN = isNaN(av), bNaN = isNaN(bv);
      if (aNaN && bNaN) return 0;
      if (aNaN) return 1;
      if (bNaN) return -1;
      return (av > bv ? 1 : av < bv ? -1 : 0) * dir;
    }
    const av = timeOf(a);
    const bv = timeOf(b);
    if (av === 0 && bv !== 0) return 1;
    if (bv === 0 && av !== 0) return -1;
    return (av > bv ? 1 : av < bv ? -1 : 0) * dir;
  });
}

function syncSortUI(bar, st) {
  if (!bar) return;
  bar.querySelectorAll(".sort-btn[data-sort]").forEach(b => {
    const s = b.dataset.sort;
    if (s !== "dir") b.classList.toggle("active", !!st.sort && st.sort === s);
  });
  const d = bar.querySelector('.sort-btn[data-sort="dir"]');
  if (d) {
    d.hidden = !st.sort; // 未选择排序方式时隐藏升/降序按钮
    d.textContent = (st.order == null ? -1 : st.order) < 0 ? "降序 ↓" : "升序 ↑";
  }
}

/* ── 复制资费名称 / 概要 ── */
function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(() => true, () => legacyCopy(text));
  }
  return Promise.resolve(legacyCopy(text));
}
function legacyCopy(text) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch (e) { return false; }
}
function summaryOf(it) {
  const f = it.fields || {};
  const lines = [];
  if (it.name) lines.push("名称：" + it.name);
  const mainKeys = ["资费标准","方案编号","资费类型","归属","适用范围","适用地区","上线日期","下线日期","有效期限"];
  const noteKeys = ["权益","其他说明","超出资费说明","其他服务内容","在网要求","退订方式","违约责任","销售渠道"];
  const seen = new Set(mainKeys.concat(noteKeys));
  const push = (k) => {
    const v = f[k];
    if (v == null || String(v).trim() === "") return;
    lines.push(k + "：" + (k === "适用地区" ? areaCn(v) : String(v)));
  };
  mainKeys.forEach(push);
  Object.keys(f).filter(k => !seen.has(k)).forEach(push);
  noteKeys.forEach(push);
  return lines.join("\n");
}

function pgSeq(page, pages) {
  if (pages <= 9) { const a = []; for (let i = 1; i <= pages; i++) a.push(i); return a; }
  const seq = [1];
  if (page > 4) seq.push("…");
  const st = Math.max(2, page - 2);
  const en = Math.min(pages - 1, page + 2);
  for (let i = st; i <= en; i++) seq.push(i);
  if (page < pages - 3) seq.push("…");
  seq.push(pages);
  return seq;
}

function drawList(type1Code, code) {
  const st = getListState(type1Code + "_" + code);
  const listEl = $(t1Id(type1Code, "list"));
  const pagerEl = $(t1Id(type1Code, "pager"));
  const cntEl = $(t1Id(type1Code, "count"));
  // 运营商切换后异步回调可能晚于视图重建，分类 DOM 不存在时静默跳过
  if (!listEl || !pagerEl || !cntEl) return;
  const filtered = filterItems(st);
  if (st.zeroOnly) { filtered.sort((a, b) => zeroRank(a) - zeroRank(b)); }
  else if (st.sort) { sortFiltered(filtered, st); }
  // 只看收藏：把已下架的收藏条目（快照中存在、当前数据中不存在）追加到结果尾部
  if (st.favOnly) {
    const present = new Set(filtered.map(it => String(it.id)));
    favBuckets().forEach(b => {
      Object.keys(b).forEach(id => {
        if (!present.has(id)) {
          const snap = b[id] || {};
          filtered.push({ __removed: true, id, name: snap.n || id, snap });
          present.add(id);
        }
      });
    });
  }
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  if (st.page > totalPages) st.page = totalPages;
  const start = (st.page - 1) * PAGE_SIZE;
  const pageItems = filtered.slice(start, start + PAGE_SIZE);
  listEl.classList.toggle("mode-card", cardMode === "card");
  cntEl.textContent = "共 " + fmt(filtered.length) + " 条 · 第 " + st.page + "/" + totalPages + " 页";

  if (!pageItems.length) {
    listEl.innerHTML = '<div class="empty">没有匹配的资费条目</div>';
  } else {
    listEl.innerHTML = pageItems.map((it, i) => itemHtml(it, st.changeMap, i)).join("");
  }

  const seq = pgSeq(st.page, totalPages);
  pagerEl.innerHTML =
    `<button ${st.page <= 1 ? "disabled" : ""} data-p="-1">上一页</button>` +
    seq.map(k => k === "…"
      ? `<span class="pg-dots">…</span>`
      : `<button class="pg${k === st.page ? " on" : ""}" data-pg="${k}">${k}</button>`).join("") +
    `<button ${st.page >= totalPages ? "disabled" : ""} data-p="1">下一页</button>`;
}

function favBtnHtml(it, fav) {
  return `<button type="button" class="fav-btn${fav ? " on" : ""}" data-fav-id="${esc(it.id)}" title="${fav ? "取消收藏" : "收藏"}" aria-label="收藏">${icon(fav ? "starFill" : "star")}</button>`;
}
function copyBtnsHtml(it) {
  return `<button type="button" class="copy-btn" data-copy="name" data-copy-id="${esc(it.id)}" title="复制资费名称" aria-label="复制资费名称">${icon("copy")}</button><button type="button" class="copy-btn" data-copy="summary" data-copy-id="${esc(it.id)}" title="复制资费概要" aria-label="复制资费概要">${icon("list")}</button><button type="button" class="copy-btn" data-plan-share="${esc(it.id)}" data-share-key="${esc((it.fields && it.fields["方案编号"]) || it.name || "")}" title="分享本条资费（复制链接或唤起系统分享）" aria-label="分享">${icon("share")}</button>`;
}
/* 规格标签：流量/宽带/通话/短信（存在才显示；短信从其他服务内容/权益正则提取） */
function specBrief(it) {
  const f = it.fields || {};
  const out = [];
  const add = (k, v, n) => {
    let x = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
    if (!x || /^(无|-|—|\/|暂无|不含)$/.test(x)) return;
    if (x.length > (n || 14)) x = x.slice(0, n || 14) + "…";
    out.push({ k, v: x });
  };
  add("流量", f["国内通用流量"]);
  add("宽带", f["宽带"]);
  add("通话", f["国内通话"]);
  add("短信", f["短信"]);
  // 无直接"短信"字段时，从其他服务内容/权益正则提取
  if (!out.some(x => x.k === "短信")) {
    const sm = (f["其他服务内容"] || "") + " " + (f["权益"] || "");
    const m = sm.match(/(\d[\d,]*)\s*条(?:国内)?短信|(?:国内)?短信\s*(\d[\d,]*)\s*条/);
    if (m) out.push({ k: "短信", v: (m[1] || m[2]) + "条" });
  }
  return out;
}
function specsHtml(it) {
  const b = specBrief(it);
  if (!b.length) return "";
  return `<div class="specs">${b.map(x => `<span class="spec"><b>${esc(x.k)}</b>${esc(x.v)}</span>`).join("")}</div>`;
}
function removedItemHtml(it, idx) {
  const snap = it.snap || {};
  const ts = snap.t ? new Date(snap.t).toLocaleDateString() : "";
  const favBtn = `<button type="button" class="fav-btn on" data-fav-id="${esc(it.id)}" title="移出收藏" aria-label="移出收藏">${icon("starFill")}</button>`;
  if (cardMode === "card") {
    let h = `<article class="tcard fav-removed-item" style="--i:${idx}"><div class="tc-head"><div class="tc-name">${esc(it.name)}</div><span class="tag chg-removed">已下架</span></div>`;
    if (snap.p) h += `<div class="tc-price">${esc(snap.p)}</div>`;
    if (ts) h += `<div class="tc-date">收藏于 ${esc(ts)}</div>`;
    h += `<div class="tc-foot"><span></span>${favBtn}</div></article>`;
    return h;
  }
  let h = `<div class="item fav-removed-item" style="--i:${idx}"><div class="item-head"><span class="item-name">${esc(it.name)}</span><span class="item-extras"><span class="tag chg-removed">已下架</span>${ts ? `<span class="fav-ts">收藏于 ${esc(ts)}</span>` : ""}${favBtn}</span></div>`;
  if (snap.p) h += `<div class="item-facts"><span>收藏时价格 <b>${esc(snap.p)}</b></span></div>`;
  h += "</div>";
  return h;
}
function itemHtml(it, changeMap, idx) {
  if (it.__removed) return removedItemHtml(it, idx);

  const f = it.fields || {};
  const rf = repFields(it);
  const type1 = t1Label(it.type1);
  const type2 = t2Label(it.type2);
  const price = rf["资费标准"] || "";
  const fav = isFav(it.id);

  const tags = [];
  const chType = changeMap && it.id ? changeMap[it.id] : null;
  if (chType === "added") tags.push(`<span class="tag chg-added">新增</span>`);
  else if (chType === "removed") tags.push(`<span class="tag chg-removed">下架</span>`);
  else if (chType === "changed") tags.push(`<span class="tag chg-changed">修改</span>`);
  if (type1) tags.push(`<span class="tag attr-${it.type1}">${esc(type1)}</span>`);
  if (type2) tags.push(`<span class="tag type-${it.type2}">${esc(type2)}</span>`);
  if (price) tags.push(`<span class="tag tag-price">${esc(price)}</span>`);
  if (fav) {
    const snap = favSnap(it.id);
    if (snap && snap.p && price && snap.p !== price) tags.push(`<span class="tag chg-changed" title="收藏时：${esc(snap.p)}">价格已变</span>`);
  }

  const specs = specsHtml(it);
  const hasFields = Object.keys(f).some(k => f[k]);
  const detail = hasFields ? `<div class="detail"><div class="detail-inner"><div class="detail-inner-pad">${fieldsTable(f)}</div></div></div>` : "";

  if (cardMode === "card") {
    return cardHtml(it, tags, specs, detail, idx, fav);
  }
  return listHtml(it, tags, specs, detail, idx, fav);
}
function listHtml(it, tags, specs, detail, idx, fav) {
  const rf = repFields(it);
  const scope = rf["适用范围"] || "";
  let html = `<div class="item" style="--i:${idx}"><div class="item-head"><span class="item-name">${esc(it.name)}</span><span class="item-extras">${tags.join("")}${favBtnHtml(it, fav)}${copyBtnsHtml(it)}</span></div>`;
  if (specs) html += specs;
  if (scope) html += `<div class="item-facts"><span>适用：${esc(scope)}</span></div>`;
  html += detail + "</div>";
  return html;
}
function cardHtml(it, tags, specs, detail, idx, fav) {
  const rf = repFields(it);
  const price = rf["资费标准"] || "";
  const scope = rf["适用范围"] || "";
  const belong = rf["归属"] || "";
  const online = rf["上线日期"] || "";
  let html = `<article class="tcard" style="--i:${idx}"><div class="tc-head"><div class="tc-name">${esc(it.name)}</div><div class="tc-actions">${favBtnHtml(it, fav)}${copyBtnsHtml(it)}</div></div>`;
  if (tags.length) html += `<div class="tc-tags">${tags.join("")}</div>`;
  if (price) html += `<div class="tc-price">${esc(price)}</div>`;
  if (specs) html += specs;
  if (scope) html += `<div class="tc-scope">${esc(scope)}</div>`;
  if (belong || online) html += `<div class="tc-foot"><span class="tc-bo">${esc(belong || "—")}</span>${online ? `<span class="tc-date">上线 ${esc(online)}</span>` : ""}</div>`;
  html += detail + "</article>";
  return html;
}

/* 字段语义分区：流量绿 / 通话蓝 / 宽带紫 / 上线绿 / 下线红 */
const FIELD_SEMANTIC = [
  [/流量/, "sem-data"],
  [/通话|语音/, "sem-call"],
  [/宽带/, "sem-broadband"],
  [/上线|生效/, "sem-online"],
  [/下线|失效|停售/, "sem-offline"],
];
function fieldClass(k) {
  for (const pair of FIELD_SEMANTIC) if (pair[0].test(k)) return pair[1];
  return "";
}

function fieldsTable(f) {
  f = f || {};
  const keys = Object.keys(f);
  const mainKeys = ["资费标准","方案编号","资费类型","归属","适用范围","适用地区","上线日期","下线日期","有效期限"];
  const noteKeys = ["其他说明","超出资费说明","其他服务内容","在网要求","退订方式","违约责任","权益","销售渠道"];
  const detailRows = mainKeys.filter(k => f[k]).map(k => `<tr class="${fieldClass(k)}"><th>${esc(k)}</th><td>${esc(k === "适用地区" ? areaCn(f[k]) : f[k])}</td></tr>`).join("");
  const otherRows = keys.filter(k => !mainKeys.includes(k) && !noteKeys.includes(k) && f[k]).map(k => `<tr class="${fieldClass(k)}"><th>${esc(k)}</th><td>${esc(k === "适用地区" ? areaCn(f[k]) : f[k])}</td></tr>`).join("");
  let html = `<table class="fields-table">${detailRows}${otherRows}</table>`;
  const noteHtml = noteKeys.filter(k => f[k]).map(k => `<div class="note-item"><div class="note-label">${esc(k)}</div><div>${esc(f[k])}</div></div>`).join("");
  if (noteHtml) {
    html += `<div class="notes-block"><div class="notes-toggle">其他说明 <span class="sub-arrow"></span></div><div class="notes-body"><div><div class="notes-body-pad">${noteHtml}</div></div></div></div>`;
  }
  return html;
}

/* ─────────────── 变更日志 ─────────────── */
const clPageState = {};   // clKey(code+筛选) → 已显示批次数
let clProvPending = false; // 直链 #changelog 时省份未就绪的补加载守卫
let clView = null;        // 变更日志视图数据：{ logs, itemMap, groups, clKey }
const clOpenOverride = new Map();  // 批次 ts → bool（展开记忆，重渲染不弹回）
const clSecOverride = new Map();   // ts|type → bool（类型子卡片展开记忆）
let clForceCollapse = false;       // 「全部收起」后新批次也默认收起
let clQ = "";                      // 变更记录搜索关键词（小写，输入即时筛选）
let clQMode = "all";               // all=名称+快照全部字段 / name=仅名称（会话内记忆，与资费同机制）
let clAttr = "";                   // 范围筛选 code（""=全部），code 来自当前运营商 ATTR_MAP
let clAttrPresence = [];           // 当前省变更记录中实际出现的 attr code——tabs 按此动态生成（同侧边栏 buildDynamicTabs 按数据过滤机制，而非全量 ATTR_MAP）
let clExpandAll = false;           // 「全部展开」模式（显式开关：开启时批次+类型子卡片默认全开；标签显示下一步动作）
let clCollapseArmed = false;       // 搜索进行中点「全部收起」时置位：收起优先于当前搜索词，搜索词一变即失效
let clObserver = null;             // 上滑自动加载哨兵 observer

/* 变更详情弹窗字段模式：false=全部字段+变化标注（默认） / true=仅看变化字段；
   localStorage 跨会话记忆，弹窗内切换按钮实时生效 */
let clDiffOnly = false;
try { clDiffOnly = localStorage.getItem("chinamnos_cl_diff_mode") === "1"; } catch {}

/** 打开变更详情弹窗（胶囊点击 / 弹窗内切换模式共用；模式切换零重拉） */
function openClModal(log) {
  clModalLog = log;
  const diffN = log.type === "changed" && log.diff ? Object.keys(log.diff).length : 0;
  openModal(log.name || "变更详情",
    '<div class="res-row sub">变更时间：' + esc(fmtTime(log.ts)) + "</div>" +
    clDetailHTML(log, clView ? clView.itemMap : {}),
    `<button type="button" class="btn ghost sm btn-ico-sm" data-act="clShare" title="复制本条变更链接或唤起系统分享">${icon("share")}<span class="btn-txt">分享</span></button>` +
    `<button type="button" class="btn ghost sm btn-ico-sm" data-act="clModalCopy" data-mode="name" title="复制资费名称">${icon("copy")}<span class="btn-txt">名称</span></button>` +
    `<button type="button" class="btn ghost sm btn-ico-sm" data-act="clModalCopy" data-mode="summary" title="复制资费概要">${icon("list")}<span class="btn-txt">概要</span></button>` +
    (diffN ? `<button type="button" class="btn ghost sm" data-act="clModalDiff" title="在「全部字段」与「仅看变化」两种显示模式间切换">${clDiffOnly ? icon("list") + "全部字段" : icon("filter") + "仅看变化"}</button>` : ""));
}

/** 批次时间标签：相对日（今天/昨天）+ 时分；更早为 月-日 时分 */
function clBatchLabel(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  const now = new Date();
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  const md = (d.getMonth() + 1) + "-" + String(d.getDate()).padStart(2, "0");
  if (sameDay(d, now)) return "今天 " + hm;
  if (sameDay(d, new Date(now.getTime() - 86400000))) return "昨天 " + hm;
  return md + " " + hm;
}

/* 变更详情弹窗复制：记录当前弹窗对应日志，名称/概要两种文本（概要复用 summaryOf 的字段铺法） */
let clModalLog = null;
function clModalCopyText(mode) {
  const log = clModalLog;
  if (!log) return "";
  if (mode === "name") return String(log.name || "");
  const typeLabel = log.type === "added" ? "新增" : log.type === "removed" ? "下架" : "变更";
  const lines = [`名称：${log.name || ""}`, `类型：${typeLabel}`, `变更时间：${fmtTime(log.ts)}`];
  const path = [attrLabel(log.attr), t1Label(log.t1), t2Label(log.t2)].filter(Boolean).join(" · ");
  if (path) lines.push(`分类：${path}`);
  const snapItem = clView && clView.itemMap ? clView.itemMap[log.id] : null;
  const fields = (log.type !== "removed" && snapItem && snapItem.fields) ? snapItem.fields : (log.snapshot || null);
  if (fields) {
    // summaryOf 首行即名称，去掉避免重复
    const body = summaryOf({ name: log.name, fields }).split("\n").slice(1).join("\n");
    if (body) lines.push(body);
  } else if (log.diff) {
    Object.entries(log.diff).forEach(([field, vals]) => {
      const f = field === "适用地区" ? areaCn(vals[0]) : vals[0];
      const t = field === "适用地区" ? areaCn(vals[1]) : vals[1];
      lines.push(`${field}：${f} → ${t}`);
    });
  }
  return lines.join("\n");
}
function clModalCopyClick(btn) {
  const text = clModalCopyText(btn.dataset.mode);
  if (!text) return;
  copyToClipboard(text).then((ok) => {
    if (!ok) return;
    const old = btn.innerHTML;
    btn.innerHTML = icon("check");
    btn.classList.add("ok");
    setTimeout(() => { btn.innerHTML = old; btn.classList.remove("ok"); }, 1200);
  });
}

/** 详情 HTML（弹窗用）：从旧版全量渲染逻辑原样抽出 */
function clDetailHTML(log, itemMap) {
  let html = '<div class="tl-body-pad">';
  const typeLabel = log.type === "added" ? "新增" : log.type === "removed" ? "下架" : "变更";
  const chipCls = log.type === "added" ? "add" : log.type === "removed" ? "del" : "mod";
  const aLbl = attrLabel(log.attr);
  const t1Lbl = t1Label(log.t1);
  const t2Lbl = t2Label(log.t2);
  const path = [aLbl, t1Lbl, t2Lbl].filter(Boolean).join(" · ");
  html += `<div class="tl-chips"><span class="chip ${chipCls}">${typeLabel}</span></div>`;
  html += `<div class="tl-title">${esc(log.name || "")}</div>`;
  if (path) html += `<div class="tl-path">${esc(path)}</div>`;
  html += `<div class="tl-id">ID: ${esc(log.id)}</div>`;

  const snapItem = itemMap[log.id];
  const diffN = log.diff ? Object.keys(log.diff).length : 0;
  if (log.type === "added" && snapItem && snapItem.fields) {
    html += '<div class="tl-detail-title" style="color:var(--green)">新增业务详情：</div>';
    const flds = snapItem.fields;
    const fldKeys = Object.keys(flds).filter(k => flds[k]);
    if (fldKeys.length) {
      html += '<table class="sub-table">' + fldKeys.map(k => `<tr><th>${esc(k)}</th><td>${esc(k === "适用地区" ? areaCn(flds[k]) : flds[k])}</td></tr>`).join("") + "</table>";
    }
  } else if (log.type === "changed" && snapItem && snapItem.fields) {
    html += `<div class="tl-detail-title" style="color:var(--acc)">字段详情${diffN ? `（变更 ${diffN} 项）` : ""}${clDiffOnly ? " · 仅看变化" : ""}：</div>`;
    const flds = snapItem.fields;
    const diffFields = log.diff ? Object.keys(log.diff) : [];
    let fldKeys = Object.keys(flds).filter(k => flds[k]);
    if (clDiffOnly) fldKeys = fldKeys.filter(k => diffFields.includes(k));
    if (fldKeys.length) {
      html += '<table class="sub-table">' + fldKeys.map(k => {
        const isDiff = diffFields.includes(k);
        if (isDiff && log.diff[k]) {
          const norm = (v) => k === "适用地区" ? areaCn(v) : v;
          return `<tr><th>${esc(k)}</th><td><span class="diff-old">${esc(norm(log.diff[k][0]))}</span> <span class="diff-arrow">→</span> <span class="diff-new">${esc(norm(log.diff[k][1]))}</span></td></tr>`;
        }
        return `<tr><th>${esc(k)}</th><td>${esc(k === "适用地区" ? areaCn(flds[k]) : flds[k])}</td></tr>`;
      }).join("") + "</table>";
    }
  } else if (log.diff) {
    html += '<div class="tl-detail-title" style="color:var(--acc)">字段变更：</div>';
    Object.entries(log.diff).forEach(([field, vals]) => {
      const norm = (v) => field === "适用地区" ? areaCn(v) : v;
      html += `<div class="diff-row"><span class="diff-field">${esc(field)}</span><span class="diff-old">${esc(norm(vals[0]))}</span> <span class="diff-arrow">→</span> <span class="diff-new">${esc(norm(vals[1]))}</span></div>`;
    });
  }

  if (log.snapshot) {
    html += '<div class="tl-detail-title" style="color:var(--red)">下架前快照：</div>';
    const snap2 = log.snapshot || {};
    const snapKeys = Object.keys(snap2).filter(k => snap2[k]);
    if (snapKeys.length) {
      html += '<table class="sub-table">' + snapKeys.map(k => `<tr><th>${esc(k)}</th><td>${esc(k === "适用地区" ? areaCn(snap2[k]) : snap2[k])}</td></tr>`).join("") + "</table>";
    }
  }
  return html + "</div>";
}

/** 加载更多批次（追加 6 个，重渲染不重新拉数据） */
function clMoreBatch() {
  if (!clView || !clView.groups || !clView.clKey) return;
  const total = clView.groups.length;
  clPageState[clView.clKey] = Math.min((clPageState[clView.clKey] || 6) + 6, total);
  clDraw();
}

/** 「全部展开/收起」按钮文案随生效状态同步：搜索自动全开时也显示「全部收起」（clDraw 每次渲染调用） */
function clSyncToggleBtn() {
  const btn = $("clToggleAll");
  if (!btn) return;
  const open = clExpandAll || (!!clQ && !clCollapseArmed);
  btn.innerHTML = icon(open ? "chevronsUp" : "chevronsDown") + "<span>全部" + (open ? "收起" : "展开") + "</span>";
}

/** 全部收起/展开（显式模式开关互换：展开=批次+类型子卡片默认全开；切换时清空单条记忆让模式接管） */
function clToggleAll() {
  const box = $("changelogBox");
  if (!box) return;
  if (clExpandAll || (!!clQ && !clCollapseArmed)) { // 搜索自动全开也视为"当前全开" → 点击执行收起
    clExpandAll = false;
    clForceCollapse = true;   // 收起后新批次也保持收起
    clCollapseArmed = !!clQ;  // 搜索进行中收起：压过当前搜索词，词一变即失效
  } else {
    clExpandAll = true;
    clForceCollapse = false;
    clCollapseArmed = false;
  }
  clOpenOverride.clear();
  clSecOverride.clear();
  clSyncToggleBtn();
  clDraw();
}

/** 上滑自动加载：哨兵进入视口即追加下一批，无需点按钮（不支持时降级为按钮） */
function setupClAutoLoad(totalGroups) {
  if (clObserver) { try { clObserver.disconnect(); } catch {} clObserver = null; }
  const sentinel = document.getElementById("clSentinel");
  if (!sentinel || !clView) return;
  const shownN = clPageState[clView.clKey] || 6;
  if (shownN >= totalGroups) return;
  if (typeof IntersectionObserver === "undefined") {
    sentinel.innerHTML = '<button type="button" class="load-more-btn cl-more-btn">加载更多批次（剩余 ' + (totalGroups - shownN) + ' 个）</button>';
    return;
  }
  clObserver = new IntersectionObserver((entries) => {
    if (entries[0] && entries[0].isIntersecting) clMoreBatch();
  }, { rootMargin: "300px" });
  clObserver.observe(sentinel);
}

/** 归属/资费类型下拉选项：按当前运营商 category_maps 动态生成（切运营商后旧选中值自动重置） */
function fillClFilters() {
  const sel1 = $("cT1"), sel2 = $("cT2");
  if (!sel1 || !sel2) return;
  const keep1 = sel1.value, keep2 = sel2.value;
  sel1.innerHTML = '<option value="">全部归属</option>' + Object.keys(TYPE1_MAP).map(k => `<option value="${esc(k)}">${esc(TYPE1_MAP[k] || k)}</option>`).join("");
  sel2.innerHTML = '<option value="">全部类型</option>' + Object.keys(TYPE2_MAP).map(k => `<option value="${esc(k)}">${esc(TYPE2_MAP[k] || k)}</option>`).join("");
  if (keep1 && TYPE1_MAP[keep1]) sel1.value = keep1;
  if (keep2 && TYPE2_MAP[keep2]) sel2.value = keep2;
}

/** 变更记录搜索匹配：all=名称+快照全部字段值（与资费「搜索全部内容」同规则）/ name=仅名称 */
function matchClSearch(l) {
  if (String(l.name || "").toLowerCase().includes(clQ)) return true;
  if (clQMode === "name") return false;
  const snap = l.snapshot;
  if (snap && typeof snap === "object") {
    for (const k in snap) {
      const v = snap[k];
      if (v != null && String(v).toLowerCase().includes(clQ)) return true;
    }
  }
  return false;
}

/** 范围筛选 tabs：按当前省变更记录实际出现的 attr code 动态生成（同侧边栏 buildDynamicTabs
    的按数据过滤机制，而非全量 ATTR_MAP——联通只有全网/本省数据时不会出现家庭资费 tab），
    文案走 ATTR_MAP（缺失兜底「分类N」与导航同规则）；切省份/运营商后旧选中 code 不在集合中自动重置回「全部」 */
function renderClAttrTabs() {
  const row = $("clAttrTabs");
  if (!row) return;
  const codes = clAttrPresence.slice().sort();
  if (!codes.length) { row.hidden = true; row.innerHTML = ""; return; }
  if (clAttr && !codes.includes(clAttr)) clAttr = "";
  const tab = (codeVal) => {
    const label = codeVal ? (ATTR_MAP[codeVal] || ("分类" + codeVal)) : "全部";
    const on = codeVal ? clAttr === codeVal : !clAttr;
    return `<button type="button" class="cl-attr-tab${on ? " on" : ""}" data-attr="${esc(codeVal)}"${on ? ' aria-pressed="true"' : ""}>${esc(label)}</button>`;
  };
  row.hidden = false;
  row.innerHTML = tab("") + codes.map(tab).join("");
}

function renderChangelog() {
  const code = getProvCode();
  const typeFilter = $("cType") ? $("cType").value : "";
  const box = $("changelogBox");
  const statsBar0 = $("clStats");
  if (statsBar0) statsBar0.innerHTML = ""; // 重渲染先清统计条：加载态/空态/换省不残留旧数据

  // 省份尚未就绪（直链 #changelog 早于 STATS 加载完成时 value 为空）：
  // 不发无效请求，主动拉取 STATS 并经 fillProvSelects → 补渲染
  if (!code) {
    box.innerHTML = '<div class="loading">正在加载省份列表…</div>';
    if (!clProvPending) {
      clProvPending = true;
      loadStats().then(s => {
        STATS = s;
        clProvPending = false;
        fillProvSelects();
      }).catch(() => {
        clProvPending = false;
        if ($("changelogBox")) $("changelogBox").innerHTML = '<div class="empty">省份列表加载失败，请刷新重试</div>';
      });
    }
    return;
  }
  box.innerHTML = '<div class="loading">加载变更记录…</div>';
  Promise.all([loadChangelog(code), loadSnapshot(code).catch(() => null)]).then(([cl, snap]) => {
    const logs = cl.logs || [];
    const present = new Set();
    logs.forEach(l => { const a = String(l.attr || ""); if (a) present.add(a); });
    clAttrPresence = Array.from(present); // 范围 tabs 的动态数据源（按当前省实际记录）
    const itemMap = {};
    if (snap && snap.items) snap.items.forEach(it => { if (it.id) itemMap[it.id] = it; });

    if (!logs.length) {
      box.innerHTML = '<div class="empty">暂无变更记录</div>';
      clView = null;
      renderClAttrTabs(); // 映射就绪时仍刷新 tabs，避免残留上一省的选中态
      return;
    }

    // 筛选（内存过滤）：变更类型 + 归属 + 资费类型 + 范围 + 搜索词 五条件 AND；不符合的条目不参与分组 → 所在批次无符合项时整组自然隐藏
    fillClFilters();
    renderClAttrTabs();
    const t1Filter = $("cT1") ? $("cT1").value : "";
    const t2Filter = $("cT2") ? $("cT2").value : "";
    const filtered = logs.filter(l =>
      (!typeFilter || l.type === typeFilter) &&
      (!t1Filter || String(l.t1 || "") === t1Filter) &&
      (!t2Filter || String(l.t2 || "") === t2Filter) &&
      (!clAttr || String(l.attr || "") === clAttr) &&
      (!clQ || matchClSearch(l)));
    if (!filtered.length) {
      box.innerHTML = `<div class="empty">当前筛选下没有匹配的变更记录（共 ${logs.length} 条记录被过滤）</div>`;
      clView = null;
      return;
    }
    const cnt = { added: 0, removed: 0, changed: 0 };
    filtered.forEach(l => { cnt[l.type] = (cnt[l.type] || 0) + 1; });

    // 按采集批次分组：同一轮采集的全部 entries 共用 crawl_time（ts 全值相同），零数据改动
    const groups = [];
    const gmap = {};
    filtered.forEach((log, idx) => {
      let g = gmap[log.ts];
      if (!g) { g = { ts: log.ts, items: [] }; gmap[log.ts] = g; groups.push(g); }
      g.items.push(idx);
    });

    const clKey = code + "_" + typeFilter + "_" + t1Filter + "_" + t2Filter + "_" + clAttr + "_" + clQMode + "_" + clQ;
    if (!clPageState[clKey]) clPageState[clKey] = 6;
    clView = { logs: filtered, itemMap, groups, clKey };
    clDraw();
  }).catch(e => {
    box.innerHTML = '<div class="empty">变更记录加载失败：' + esc(e.message) + ' <button data-act="retryChangelog" class="btn sm soft">重试</button></div>';
  });
}

/** 渲染时间轴（数据已就绪；加载更多/收展切换只走这里，不重新拉数据） */
function clDraw() {
  const box = $("changelogBox");
  clSyncToggleBtn(); // 搜索自动展开/清空/收起压制时同步按钮文案
  if (!box || !clView) return;
  const { logs: filtered, groups, clKey } = clView;

  const shownN = Math.min(clPageState[clKey] || 6, groups.length);
  const shown = groups.slice(0, shownN);

  // 统计条：每次渲染都重建（自动加载重渲染不丢）
  const cnt = { added: 0, removed: 0, changed: 0 };
  filtered.forEach(l => { cnt[l.type] = (cnt[l.type] || 0) + 1; });

  const chip = (cls, lbl, n) => `<span class="chip ${cls}">${lbl} ${n}</span>`;
  const statsBar = $("clStats");
  if (statsBar) statsBar.innerHTML = `共 <strong>${filtered.length}</strong> 条变更 · <strong>${groups.length}</strong> 个采集批次
    <span class="cl-stat-chips">${chip("add", "新增", cnt.added || 0)}${chip("del", "下架", cnt.removed || 0)}${chip("mod", "变更", cnt.changed || 0)}</span>`;

  let html = '<div class="tl">';
  shown.forEach((g, gi) => {
    const tsKey = String(g.ts ?? ("#" + gi));
    const gc = { added: 0, removed: 0, changed: 0 };
    g.items.forEach(idx => { const l = filtered[idx]; gc[l.type] = (gc[l.type] || 0) + 1; });

    // 展开状态优先级：用户单批次记忆 > 全部展开模式 > 搜索期收起压制 > 搜索(视为重新展开) > 收起模式 > 默认仅最新批次（fresh）
    const fresh = gi === 0;
    const open = clOpenOverride.has(tsKey) ? clOpenOverride.get(tsKey)
      : clExpandAll ? true
      : (clCollapseArmed ? false : clQ ? true : clForceCollapse ? false : fresh);
    // 折叠态色条：不用数字堆叠，一眼看出本轮变化的类型构成
    const bars =
      (gc.added ? '<i class="b-add" title="有新增"></i>' : "") +
      (gc.changed ? '<i class="b-mod" title="有变更"></i>' : "") +
      (gc.removed ? '<i class="b-del" title="有下架"></i>' : "") +
      (!gc.added && !gc.changed && !gc.removed ? '<i class="b-none" title="无变化"></i>' : "");

    html += `<div class="tl-item${open ? " open" : ""}${fresh ? " fresh" : ""}" data-cts="${esc(tsKey)}" role="button" aria-expanded="${open}">`;
    html += `<div class="tl-head" tabindex="0" role="button"><span class="tl-time">${esc(clBatchLabel(g.ts))} 采集</span>${fresh ? '<span class="tl-fresh">最新</span>' : ""}<span class="tl-bars">${bars}</span><span class="tl-arrow"></span></div>`;

    // 展开后：类型子卡片（新增/下架/变更），卡片体为业务胶囊，点击弹窗看详情
    html += '<div class="tl-sec-list">';
    ["added", "removed", "changed"].forEach(tp => {
      if (!gc[tp]) return;
      const cls = tp === "added" ? "add" : tp === "removed" ? "del" : "mod";
      const lbl = tp === "added" ? "新增" : tp === "removed" ? "下架" : "变更";
      const sk = tsKey + "|" + tp;
      const secOpen = clSecOverride.has(sk) ? clSecOverride.get(sk) : (clExpandAll || (!!clQ && !clCollapseArmed)); // 搜索/全部展开时子卡片默认打开，用户单卡片记忆仍优先
      html += `<div class="tl-sec-entry${secOpen ? " open" : ""}" data-stype="${tp}">`;
      html += `<div class="tl-sec-head" role="button" tabindex="0" aria-expanded="${secOpen}"><b>${lbl}</b><span class="tl-sec-chips"><span class="chip ${cls}">${gc[tp]} 项</span></span><span class="tl-sec-arrow"></span></div>`;
      html += '<div class="tl-sec-body"><div class="tl-chipbox">';
      html += g.items.filter(idx => filtered[idx].type === tp).map(idx => {
        const log = filtered[idx];
        const sym = tp === "added" ? "+" : tp === "removed" ? "-" : "✎";
        const diffN = tp === "changed" && log.diff ? Object.keys(log.diff).length : 0;
        return `<a class="tl-chip-btn c-${cls}" href="javascript:void(0)" data-clidx="${idx}" title="点击查看该业务详情">${sym} <span>${esc(log.name || "")}</span>${diffN ? `<b class="cn">${diffN}项</b>` : ""}</a>`;
      }).join("");
      html += '</div></div></div>';
    });
    html += '</div></div>';
  });
  html += '</div>';

  if (groups.length > shown.length) {
    html += `<div class="cl-more" id="clSentinel"><span class="cl-hint">上滑加载更多（剩余 ${groups.length - shown.length} 个批次）…</span></div>`;
  }
  box.innerHTML = html;
  setupClAutoLoad(groups.length);
}

/* ─────────────── 采集监控 ─────────────── */
function renderMonitor() {
  if (!STATS) {
    $("monitorSummary").innerHTML = '<div class="loading">加载中…</div>';
    loadStats().then(s => { STATS = s; renderMonitor(); }).catch(e => { $("monitorSummary").innerHTML = '<div class="empty">加载失败 <button data-act="retryMonitor" class="btn sm soft">重试</button></div>'; });
    return;
  }

  const s = STATS;
  const provs = s.provinces || [];
  const okCount = provs.filter(p => p.crawl_status === "success" || p.crawl_status === "degrade_auto_recovered").length;
  const failCount = provs.filter(p => p.crawl_status === "failed").length;

  $("monitorMeta").textContent = `更新于 ${fmtTime(s.crawl_time)}`;

  $("monitorSummary").innerHTML = `
    <div class="m-stat" style="--i:0"><div class="m-val">${okCount}</div><div class="m-lab">采集成功</div></div>
    <div class="m-stat${failCount > 0 ? " alert" : ""}" style="--i:1"><div class="m-val">${failCount}</div><div class="m-lab">采集失败</div></div>
    <div class="m-stat" style="--i:2"><div class="m-val">${fmtDur(s.last_crawl_duration_ms)}</div><div class="m-lab">总耗时</div></div>
  `;

  const body = $("monitorBody");
  body.innerHTML = provs.sort((a, b) => {
    const statusOrder = {failed: 0, no_snapshot: 1, sudden_change: 2, surge_duplicate: 2, degrade_auto_recovered: 4, success: 4};
    return (statusOrder[a.crawl_status] || 9) - (statusOrder[b.crawl_status] || 9);
  }).map(p => {
    const statusCls = (p.crawl_status === "success" || p.crawl_status === "degrade_auto_recovered") ? "ok" : p.crawl_status === "failed" ? "err" : "warn";
    const statusText = p.crawl_status === "success" ? "成功" : p.crawl_status === "degrade_auto_recovered" ? "降级恢复" : p.crawl_status === "failed" ? "失败" : p.crawl_status === "no_snapshot" ? "无数据" : p.crawl_status === "sudden_change" ? "骤变跳过" : p.crawl_status === "surge_duplicate" ? "激增重复跳过" : p.crawl_status;
    const degradeCount = p.consecutive_degrade_count || 0;
    const degradeTag = degradeCount > 0 ? ` <span style="color:var(--amber);font-size:0.85em">(${degradeCount})</span>` : "";
    const natTariffs = p.breakdown && p.breakdown["1"] ? p.breakdown["1"].tariffs : 0;
    const otherTariffs = Object.entries(p.breakdown || {}).reduce((sum, [attr, v]) => sum + (attr !== "1" && v && v.tariffs ? v.tariffs : 0), 0);
    const pTariffs = p.total ? p.total.tariffs : 0;
    const todayAdd = Object.values(p.today || {}).reduce((sum, c) => sum + (c && c.added ? c.added : 0), 0);
    const todayRm = Object.values(p.today || {}).reduce((sum, c) => sum + (c && c.removed ? c.removed : 0), 0);
    const todayChg = Object.values(p.today || {}).reduce((sum, c) => sum + (c && c.changed ? c.changed : 0), 0);
    return `<tr>
      <td>${esc(p.name)}</td>
      <td><span class="status-dot-inline ${statusCls}"></span>${esc(statusText)}${degradeTag}</td>
      <td>${fmt(pTariffs)}</td>
      <td>${fmt(natTariffs)}</td>
      <td>${fmt(otherTariffs)}</td>
      <td style="color:var(--green)">${fmt(todayAdd)}</td>
      <td style="color:var(--red)">${fmt(todayRm)}</td>
      <td style="color:var(--amber)">${fmt(todayChg)}</td>
      <td>${fmtTime(p.data_crawl_time)}</td>
    </tr>`;
  }).join("");

  loadDiag().then(renderDiagnostics).catch(() => {
    $("diagnosticsSummary").innerHTML = '<div class="empty">诊断数据暂不可用</div>';
    $("diagnosticsBody").innerHTML = "";
  });
}

function loadDiag() {
  return loadJson("_diag.json");
}

function renderDiagnostics(diag) {
  if (!diag || !diag.provinces) {
    $("diagnosticsSummary").innerHTML = '<div class="empty">暂无诊断数据</div>';
    $("diagnosticsBody").innerHTML = "";
    return;
  }

  const totalCats = diag.provinces.reduce((s, p) => s + (p.categories ? p.categories.length : 0), 0);
  const failCats = diag.provinces.reduce((s, p) => s + (p.categories ? p.categories.filter(c => c.status === 'fail').length : 0), 0);
  const totalRetries = diag.provinces.reduce((s, p) => s + (p.categories ? p.categories.reduce((ss, c) => ss + (c.retries || 0), 0) : 0), 0);

  $("diagnosticsSummary").innerHTML = `
    <div class="d-stat" style="--i:0"><div class="d-val">${fmtDur(diag.total_ms)}</div><div class="d-lab">总耗时</div></div>
    <div class="d-stat" style="--i:1"><div class="d-val">${diag.provinces.length}</div><div class="d-lab">省份数</div></div>
    <div class="d-stat" style="--i:2"><div class="d-val">${totalCats}</div><div class="d-lab">分类总数</div></div>
    <div class="d-stat${failCats > 0 ? " alert" : ""}" style="--i:3"><div class="d-val">${failCats}</div><div class="d-lab">失败分类</div></div>
    <div class="d-stat" style="--i:4"><div class="d-val">${totalRetries}</div><div class="d-lab">总重试</div></div>
  `;

  let bodyHtml = "";
  diag.provinces.forEach(prov => {
    const pname = prov.name || prov.code || "-";
    (prov.categories || []).forEach(cat => {
      const attrL = attrLabel(cat.attr);
      const t1L = t1Label(cat.t1);
      const t2L = t2Label(cat.t2);
      const statusCls = cat.status === 'ok' ? 'ok' : 'err';
      bodyHtml += `<tr>
        <td>${esc(pname)}</td>
        <td>${esc(attrL)}/${esc(t1L)}/${esc(t2L)}</td>
        <td>${cat.pages}</td>
        <td>${fmt(cat.items)}</td>
        <td>${cat.retries}</td>
        <td>${cat.ms}</td>
        <td><span class="status-dot-inline ${statusCls}"></span>${cat.status}</td>
        <td>${cat.reason ? esc(cat.reason) : '-'}</td>
      </tr>`;
    });
  });
  $("diagnosticsBody").innerHTML = bodyHtml || '<tr><td colspan="8" style="text-align:center;color:var(--sub)">暂无分类诊断记录</td></tr>';
}

/* ─────────────── 模态框（<dialog>） ─────────────── */
function openModal(title, html, footExtra, opts) {
  $("modalTitle").textContent = title;
  $("modalBody").innerHTML = html;
  $("modalFootExtra").innerHTML = footExtra || "";
  /* ofv 场景类：放开 modal-body/dialog 两层 overflow 裁剪（弹窗内含下拉浮层时用，如检测弹窗省选择器）；
     每次 open 都先清再按需加，防其他弹窗串用 */
  const ofv = !!(opts && opts.bodyOverflowVisible);
  $("modalBody").classList.toggle("ofv", ofv);
  $("modalDlg").classList.toggle("ofv", ofv);
  $("modalDlg").showModal();
}
function closeModal() {
  const dlg = $("modalDlg");
  if (!dlg || !dlg.open) return;
  dlg.classList.add("modal-closing");
  setTimeout(() => { dlg.close(); dlg.classList.remove("modal-closing"); }, 180);
}

/* 今日新增/下架 · 省份分布弹窗：数据源 s.provinces[].today（每省按归属分组的今日计数）。
   合计口径与顶栏一致：仅计采集成功/自动恢复省——失败省继承的旧 today 不计入，避免把过期数据当今日变化误导 */
function openTodayProvModal(kind) {
  if (!STATS) { ensureTariffBootstrapped().then(() => { if (STATS) openTodayProvModal(kind); }); return; }
  const OK = st => st === "success" || st === "degrade_auto_recovered";
  const rows = [];
  let skipped = 0;
  (STATS.provinces || []).forEach(p => {
    if (!OK(p.crawl_status)) { skipped++; return; }
    let n = 0;
    Object.values(p.today || {}).forEach(c => { n += (c && c[kind]) || 0; });
    if (n > 0) rows.push({ name: p.name, code: p.code, n });
  });
  rows.sort((a, b) => b.n - a.n);
  const total = rows.reduce((sum, r) => sum + r.n, 0);
  const isAdd = kind === "added";
  const color = isAdd ? "var(--green)" : "var(--red)";
  const label = isAdd ? "今日新增" : "今日下架";
  const brand = (CARRIER_BRAND[currentCarrier] || {}).name || "";
  const listHtml = rows.length
    ? rows.map((r, i) => {
        const pct = Math.max(2, Math.round(r.n / total * 100));
        return `<div data-act="todayProvJump" data-code="${esc(r.code)}" data-name="${esc(r.name)}" title="点击查看「${esc(r.name)}」的变更记录" style="display:flex;align-items:center;gap:8px;padding:5px 0;cursor:pointer;border-radius:6px">
          <span style="width:22px;text-align:right;color:var(--sub);font-size:12px;flex:none">${i + 1}</span>
          <span style="width:64px;flex:none">${esc(r.name)}</span>
          <div style="flex:1;height:8px;border-radius:4px;background:var(--line,#e5e7eb);overflow:hidden;min-width:0"><div style="width:${pct}%;height:100%;border-radius:4px;background:${color}"></div></div>
          <b style="color:${color};width:40px;text-align:right;flex:none;font-variant-numeric:tabular-nums">${fmt(r.n)}</b>
        </div>`;
      }).join("")
    : '<div class="empty" style="padding:24px;text-align:center">今日暂无' + esc(label) + '的省份</div>';
  const skipHtml = skipped ? `<p class="hint" style="margin:10px 0 0">另有 ${skipped} 个省份今日未采集成功，未计入统计。</p>` : "";
  openModal(`${label} · 省份分布${brand ? `（${brand}）` : ""}`,
    `<div style="padding:4px 2px">
      <p class="hint" style="margin:0 0 10px">合计 <b style="color:${color}">${fmt(total)}</b> 条 · 按数量降序</p>
      ${listHtml}${skipHtml}
    </div>`);
}

function initModal() {
  $("modalClose").addEventListener("click", closeModal);
  $("modalOk").addEventListener("click", closeModal);
  $("modalDlg").addEventListener("click", e => { if (e.target === $("modalDlg")) closeModal(); });
  $("modalDlg").addEventListener("cancel", e => { e.preventDefault(); closeModal(); });
  /* 弹窗为顶层 <dialog>（骨架外层，不在各 tab 委托容器内）：data-act 按钮经 window.__MODAL_ACT__ 分发
     （actOnBodyClick 等 tab 级委托捕获不到——弹窗内既有按钮同此因，仅接分享类新按钮，不改动既有行为） */
  const modalDispatch = (e) => {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const fn = window.__MODAL_ACT__ && window.__MODAL_ACT__[el.dataset.act];
    if (fn) { e.preventDefault(); fn(el); }
  };
  $("modalBody").addEventListener("click", modalDispatch);
  $("modalFootExtra").addEventListener("click", modalDispatch);
  /* 总览「今日新增/下架」统计卡 → 省份分布弹窗（骨架静态节点，init 期绑一次委托） */
  const ovStatsRow = $("ovStatsRow");
  if (ovStatsRow) ovStatsRow.addEventListener("click", e => {
    if (e.target.closest('[data-act="statTodayAdd"]')) openTodayProvModal("added");
    else if (e.target.closest('[data-act="statTodayRm"]')) openTodayProvModal("removed");
  });
  /* 本省「今日新增/下架/变更」统计卡 → 本省变更日志（省份不变，清守卫后直接切页签） */
  const provStatsRow = $("provStatsRow");
  if (provStatsRow) provStatsRow.addEventListener("click", e => {
    if (!e.target.closest('[data-act="provStatCl"]')) return;
    const code = getProvCode();
    if (!code) { toast("请先选择省份"); return; }
    delete TAB_SHOWN["changelog"];
    goTab("changelog");
  });
}

/* ─────────────── 侧边栏（移动端抽屉） ─────────────── */
function initSidebar() {
  const sidebar = $("sidebar");
  const overlay = $("sidebarOverlay");
  const open = () => { sidebar.classList.add("open"); overlay.classList.add("show"); };
  const close = () => { sidebar.classList.remove("open"); overlay.classList.remove("show"); };
  $("hamburgerBtn").addEventListener("click", open);
  $("sidebarClose").addEventListener("click", close);
  overlay.addEventListener("click", close);
  sidebar.addEventListener("click", e => {
    if (e.target.closest(".nav-item") && window.innerWidth <= 900) close();
  });
}

function initTheme() {
  const btn = $("themeBtn");
  const paint = () => { btn.innerHTML = icon(theme.get() === "dark" ? "sun" : "moon"); btn.title = theme.get() === "dark" ? "切换亮色主题" : "切换暗色主题"; };
  paint();
  btn.addEventListener("click", () => { theme.toggle(); paint(); });
}

/* ─────────────── 省份选择器（带搜索过滤，替代原生 select） ───────────────
   保留 #gProv 的 value 属性读写与 change 事件，与既有调用点兼容
   ▸ 面板内为彩色卡片网格（借鉴 hunan-tariff-site）：大区配色色点 + 该省资费条数，
     选中态渐变底 + ✓；31 省一屏全览，替代纵向长列表 */
const PROV_REGION = {
  北京: "华北", 天津: "华北", 河北: "华北", 山西: "华北", 内蒙古: "华北",
  辽宁: "东北", 吉林: "东北", 黑龙江: "东北",
  上海: "华东", 江苏: "华东", 浙江: "华东", 安徽: "华东", 福建: "华东", 江西: "华东", 山东: "华东",
  河南: "华中", 湖北: "华中", 湖南: "华中",
  广东: "华南", 广西: "华南", 海南: "华南",
  重庆: "西南", 四川: "西南", 贵州: "西南", 云南: "西南", 西藏: "西南",
  陕西: "西北", 甘肃: "西北", 青海: "西北", 宁夏: "西北", 新疆: "西北",
};
const REGION_COLOR = {
  华北: ["#6366f1", "#8b8cf7"], 东北: ["#0ea5e9", "#5cc8ff"], 华东: ["#14b8a6", "#5ee9a4"],
  华中: ["#f59e0b", "#ffcf70"], 华南: ["#ec4899", "#ff8ec4"], 西南: ["#8b5cf6", "#b79cff"],
  西北: ["#ef4444", "#ff8a95"], 其他: ["#64748b", "#94a3b8"], // 全网/深圳等无大区归属的兜底
};

function buildProvPicker(el) {
  if (!el || el.dataset.picker) return;
  el.dataset.picker = "1";
  el.classList.add("prov-picker");
  /* 视图模式：grid=彩色卡片网格 / list=纵向列表（原版样式），搜索框右侧图标切换并记忆 */
  const MODE_KEY = "chinamnos_prov_picker_view";
  let mode = "grid";
  try { mode = localStorage.getItem(MODE_KEY) === "list" ? "list" : "grid"; } catch { /* 隐私模式忽略 */ }
  el.innerHTML =
    `<button type="button" class="prov-toggle" aria-haspopup="listbox" aria-expanded="false"><span class="prov-cur">请选择</span>${icon("chevronDown")}</button>` +
    `<div class="prov-pop" hidden><div class="prov-search-wrap">${icon("search")}<input type="text" class="prov-search" placeholder="搜索省份…" enterkeyhint="search"><button type="button" class="prov-mode" aria-label="切换视图"></button></div><ul class="prov-list" role="listbox"></ul></div>`;
  const toggle = el.querySelector(".prov-toggle");
  const pop = el.querySelector(".prov-pop");
  const search = el.querySelector(".prov-search");
  const list = el.querySelector(".prov-list");
  const cur = el.querySelector(".prov-cur");
  const modeBtn = el.querySelector(".prov-mode");
  let options = [];
  let value = "";
  let open = false;

  const curName = () => { const o = options.find(x => x.code === value); return o ? o.name : (value || "请选择"); };
  function renderList(kw) {
    const k = (kw || "").trim().toLowerCase();
    const shown = k ? options.filter(o => o.name.toLowerCase().includes(k) || o.code.toLowerCase().includes(k)) : options;
    if (!shown.length) { list.innerHTML = `<li class="prov-empty">无匹配省份</li>`; return; }
    if (mode === "list") {
      /* 列表模式 = 原版样式：省名一行一条。
         类名用 pv-mode-* 前缀：曾用 "list" 撞上 .list 资费列表组件的 overflow:hidden
         （同特异性靠后覆盖），导致列表模式无滚动条且不可滚 */
      list.className = "prov-list pv-mode-list";
      list.innerHTML = shown.map(o => `<li role="option" aria-selected="${o.code === value}" class="prov-opt${o.code === value ? " sel" : ""}" data-code="${esc(o.code)}">${esc(o.name)}</li>`).join("");
      return;
    }
    /* 网格模式：省名 + 大区色点 + 该省条数（STATS.provinces 自带 total.tariffs）；
       .prov-opt 类名保留供键盘导航（↑↓/Enter）命中，sel 选中态由样式渲染渐变底 */
    list.className = "prov-list pv-mode-grid";
    list.innerHTML = shown.map(o => {
      const c = REGION_COLOR[PROV_REGION[o.name] || "其他"] || REGION_COLOR["其他"];
      const cnt = o.total && Number.isFinite(o.total.tariffs) ? fmt(o.total.tariffs) : "—";
      return `<li role="option" aria-selected="${o.code === value}" class="prov-opt${o.code === value ? " sel" : ""}" data-code="${esc(o.code)}"` +
        ` style="--ica:${c[0]};--icb:${c[1]}" title="${esc(o.name)} · ${PROV_REGION[o.name] || "其他"} · ${cnt} 条资费">` +
        `<span class="pv-nm">${esc(o.name)}</span>` +
        `<span class="pv-sub"><i class="pv-dot"></i><span class="pv-ct">${cnt}</span></span>` +
        `<span class="pv-ck">✓</span></li>`;
    }).join("");
  }
  const paintMode = () => {
    modeBtn.innerHTML = icon(mode === "grid" ? "list" : "grid"); // 图标=点按后将切到的视图
    modeBtn.title = mode === "grid" ? "切换为列表视图" : "切换为网格视图";
  };
  modeBtn.addEventListener("click", () => {
    mode = mode === "grid" ? "list" : "grid";
    try { localStorage.setItem(MODE_KEY, mode); } catch { /* */ }
    paintMode();
    renderList(search.value);
  });
  paintMode();
  function setOpen(v) {
    open = v;
    pop.hidden = !v;
    el.classList.toggle("open", v);
    toggle.setAttribute("aria-expanded", v ? "true" : "false");
    if (v) {
      search.value = "";
      renderList("");
      clampPopToViewport(el, pop); // 窄屏视口水平居中夹紧，防跑出屏幕
      setTimeout(() => search.focus(), 0);
    }
  }
  toggle.addEventListener("click", e => { e.stopPropagation(); setOpen(!open); });
  search.addEventListener("input", () => renderList(search.value));
  search.addEventListener("keydown", e => {
    const opts = Array.from(list.querySelectorAll(".prov-opt"));
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!opts.length) return;
      const i = opts.findIndex(x => x.classList.contains("hl"));
      const ni = e.key === "ArrowDown" ? (i < 0 ? 0 : Math.min(i + 1, opts.length - 1)) : Math.max(i - 1, 0);
      opts.forEach(x => x.classList.remove("hl"));
      opts[ni].classList.add("hl");
      opts[ni].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      const t = list.querySelector(".prov-opt.hl") || list.querySelector(".prov-opt");
      if (t) t.click();
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  });
  list.addEventListener("click", e => {
    const li = e.target.closest(".prov-opt");
    if (!li) return;
    el.value = li.dataset.code;
    setOpen(false);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  document.addEventListener("click", e => {
    /* composedPath 而非 contains：modeBtn 切换图标会替换自身 innerHTML，原始点击 target
       （旧 svg）被移出 DOM 游离，contains(游离节点)=false 会误判外点导致面板闪关 */
    if (open && !e.composedPath().includes(el)) setOpen(false);
  });

  el.setOptions = (opts, defVal) => {
    options = opts || [];
    if (!options.some(o => o.code === value)) value = defVal || (options[0] ? options[0].code : "");
    cur.textContent = curName();
  };
  Object.defineProperty(el, "value", {
    configurable: true,
    get: () => value,
    set: v => {
      if (options.some(o => o.code === v)) {
        value = v;
        cur.textContent = curName();
        list.querySelectorAll(".prov-opt").forEach(x => x.classList.toggle("sel", x.dataset.code === v));
      }
    }
  });
}

function initProvListeners() {
  const el = $("gProv");
  if (!el) return;
  el.addEventListener("change", () => {
    saveProvCode();
    updateOfficialLink();
    const v = getProvCode();
    renderDistBars();
    if (STATS) renderProvStatsRow(STATS);
    dynamicType1Keys.forEach(t1 => { listState[t1 + "_" + v] = null; });
    const activeView = document.querySelector(".view.active");
    if (activeView) {
      const id = activeView.id;
      if (id === "view-overview") { renderDistBars(); if (STATS) renderProvStatsRow(STATS); if (STATS) renderRankList(STATS); renderPriceHist(); }
      else if (id.startsWith("view-t1_")) renderList(id.slice(8));
      else if (id === "view-changelog") renderChangelog();
    }
    chTabRefresh(true); // 省份变化 → 跳蚤市集 tab 重新探测（显隐与内容随省份联动，与 goProvince 同款）
    actTabRefreshAndRender(); // 情报酒馆列表随省份联动（refetch：静态源按省过滤 + API 源服务端按省过滤，均需重拉）
    annRenderIfActive(); // 公告列表随省份联动（本省过滤）——goProvince 有此三件套，选择器切换路径此前漏挂
    /* 唠嗑聚落必须 refetch 而非纯重渲染：API 兜底路径下 chatState.items 是按省服务端过滤的子集，
       静态路径缺失（如本地无烘焙文件）时切省拿旧省子集过滤 → 恒为空 */
    chatTabRefreshAndRender();
    maybePromosOnSwitch(); // 切换省份：重新判定推广弹窗（命中新范围且未读才弹）
    /* 三页签的联动渲染仅在页签 active 时执行：切省时若停在其他页签，数据已更新但 DOM 残留旧省，
       TAB_SHOWN 守卫会拦截下次进入的重渲染 → 强制删除，进页签必重渲染（同 chTabRefresh 的 cardhub 模式） */
    delete TAB_SHOWN["acts"];
    delete TAB_SHOWN["chat"];
    delete TAB_SHOWN["announce"];
  });
  ["cType", "cT1", "cT2"].forEach(id => { const el = $(id); if (el) el.addEventListener("change", () => renderChangelog()); });

  /* 变更记录搜索：输入即时筛选（数据量小无需防抖）+ 模式切换（与资费列表同款交互） */
  const cSearchEl = $("cSearch");
  if (cSearchEl) cSearchEl.addEventListener("input", () => { clQ = cSearchEl.value.trim().toLowerCase(); clCollapseArmed = false; renderChangelog(); }); // 搜索词变化=新的搜索意图，清除收起压制
  const cQModeEl = $("cQMode");
  if (cQModeEl) {
    const syncClSearchMode = () => {
      cQModeEl.textContent = clQMode === "name" ? "仅名称" : "全部";
      cQModeEl.classList.toggle("name-mode", clQMode === "name");
      if (cSearchEl) cSearchEl.placeholder = clQMode === "name" ? "搜索资费名称…" : "搜索名称/资费标准/说明…";
    };
    syncClSearchMode();
    cQModeEl.addEventListener("click", () => {
      clQMode = clQMode === "name" ? "all" : "name";
      syncClSearchMode();
      if (clQ) renderChangelog(); // 有关键词才需重筛，无则仅切模式（与资费同款）
    });
  }
  /* 范围 tabs：事件委托，点击即筛选（tabs 由 renderClAttrTabs 动态重建） */
  const clAttrTabsEl = $("clAttrTabs");
  if (clAttrTabsEl) clAttrTabsEl.addEventListener("click", e => {
    const btn = e.target.closest(".cl-attr-tab");
    if (!btn) return;
    clAttr = btn.dataset.attr || "";
    renderClAttrTabs();
    renderChangelog();
  });
}

/* ─────────────── 检测资费变化 ─────────────── */
let checking = false;
/* 检测弹窗状态：carriersMap=stats.carriers 全四家；carriers=有变化的运营商（含今日总数）；
   curCarrier=当前查看运营商（弹窗内可切换）；provs/cur=该运营商有变化的省与当前省 */
const chkState = { carriersMap: null, carriers: [], curCarrier: "", provs: [], cur: null };

function chkCarrierName(code) { return (CARRIER_BRAND[code] || {}).shortName || code; }

/* 今日 0 点（北京时间）的 UTC 毫秒——与采集端 changelog「今日」窗口同锚点
   （changelog ts 为 UTC ISO 串，值=北京时间-8h；北京 0 点的 UTC 表示即此式） */
function bjMidnightMs() {
  return Math.floor((Date.now() + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000;
}

function chkTagHTML(type) {
  const cls = type === "added" ? "ok" : type === "removed" ? "del" : "chg";
  const label = type === "added" ? "新增" : type === "removed" ? "下架" : "变更";
  return `<span class="chk-tag ${cls}">${label}</span>`;
}

function chkBuildProvs(carrierCode) {
  const cdata = (chkState.carriersMap || {})[carrierCode] || {};
  return (cdata.provinces || []).map((p) => {
    let added = 0, removed = 0, changed = 0;
    for (const c of Object.values(p.today || {})) { added += c.added || 0; removed += c.removed || 0; changed += c.changed || 0; }
    return { code: p.code, name: p.name, total: added + removed + changed };
  }).filter((x) => x.total > 0).sort((a, b) => b.total - a.total);
}

/* 汇总数字行（随运营商切换更新） */
function chkRenderSummary() {
  const cdata = (chkState.carriersMap || {})[chkState.curCarrier] || {};
  let add = 0, rm = 0, chg = 0;
  for (const c of Object.values(cdata.today || {})) { add += c.added || 0; rm += c.removed || 0; chg += c.changed || 0; }
  const el = $("chkSummary");
  if (el) el.innerHTML = `<b style="color:var(--acc)">${esc(chkCarrierName(chkState.curCarrier))}</b> · 今日新增 <b style="color:var(--green)">${add}</b> 条，下架 <b style="color:var(--red)">${rm}</b> 条，变更 <b style="color:var(--amber)">${chg}</b> 条`;
}

/* 当前省今日变化条目胶囊：懒加载该运营商该省 changelog（no-cache），按北京时间今日 0 点筛 logs */
async function chkRenderItems() {
  const box = $("chkItems");
  if (!box || !chkState.cur) return;
  box.innerHTML = `<div class="chk-loading">加载中…</div>`;
  let logs = [];
  try {
    const raw = await fetchNoCache(`changelogs/changelog_${chkState.cur.code}.json`, chkState.curCarrier);
    logs = (raw && Array.isArray(raw.logs)) ? raw.logs : [];
  } catch { logs = []; }   // 无变更日志文件的省按空处理
  const start = bjMidnightMs();
  const today = logs.filter((l) => { const t = new Date(l.ts).getTime(); return Number.isFinite(t) && t >= start; });
  box.innerHTML = today.length
    ? today.map((l) => `<button type="button" class="chk-item" data-act="chkJump" data-ts="${esc(String(l.ts ?? ""))}" data-name="${esc(l.name || "")}" data-prov="${esc(chkState.cur.code)}">${chkTagHTML(l.type)}<span class="chk-name">${esc(l.name || "（无名称）")}</span>${icon("chevronRight")}</button>`).join("")
    : `<div class="chk-empty">该省今日无变更记录</div>`;
  mountIcons(box);
}

/* 弹窗内切换运营商：重建省选项 + 汇总行 + 条目列表（省选择器组件复用 setOptions，不重建 DOM） */
function chkSetCarrier(code) {
  if (!(chkState.carriersMap || {})[code]) return;
  chkState.curCarrier = code;
  chkState.provs = chkBuildProvs(code);
  chkState.cur = chkState.provs.find((x) => x.code === getProvCode()) || chkState.provs[0] || null;
  chkRenderSummary();
  const row = $("chkCarrierRow");
  if (row) row.querySelectorAll(".chk-carrier").forEach((b) => b.classList.toggle("active", b.dataset.code === code));
  const picker = $("chkProvPicker");
  if (picker && picker.setOptions) picker.setOptions(chkState.provs.map((p) => ({ code: p.code, name: p.name, total: { tariffs: p.total } })), chkState.cur ? chkState.cur.code : "");
  chkRenderItems();
}

/* 「检测到资费变化」弹窗：运营商胶囊（有变化者）+ 汇总数字 + 省选择器（顶栏同款组件，
   仅列有变化的省，网格条数位=该省今日变化数）+ 条目胶囊（点击跳转变更日志详情，跨运营商自动切换） */
function chkOpenChangedModal(carriersMap, fromCarrier, updated) {
  chkState.carriersMap = carriersMap;
  chkState.carriers = Object.keys(carriersMap).map((code) => {
    let total = 0;
    for (const c of Object.values((carriersMap[code] || {}).today || {})) total += (c.added || 0) + (c.removed || 0) + (c.changed || 0);
    return { code, total };
  }).filter((x) => x.total > 0).sort((a, b) => b.total - a.total);
  chkState.curCarrier = chkState.carriers.some((x) => x.code === fromCarrier) ? fromCarrier : (chkState.carriers[0] ? chkState.carriers[0].code : fromCarrier);
  chkState.provs = chkBuildProvs(chkState.curCarrier);
  chkState.cur = chkState.provs.find((x) => x.code === getProvCode()) || chkState.provs[0] || null;
  const hasMulti = chkState.carriers.length > 1;
  openModal("检测到资费变化", `
    <div class="res-row" id="chkSummary"></div>
    ${hasMulti ? `<div class="chk-carrier-row" id="chkCarrierRow">${chkState.carriers.map((c) => `<button type="button" class="chk-carrier" data-act="chkCarrier" data-code="${esc(c.code)}">${esc(chkCarrierName(c.code))}<b>${c.total}</b></button>`).join("")}</div>` : ""}
    <div class="chk-prov-wrap"><span class="chk-prov-label">省份</span><div id="chkProvPicker"></div></div>
    <div class="chk-items" id="chkItems"></div>
    <div class="res-row sub">快照时间：${esc(updated)} · 点条目跳转变更日志查看详情</div>`,
    null, { bodyOverflowVisible: true });
  if (hasMulti) {
    const row = $("chkCarrierRow");
    if (row) row.querySelectorAll(".chk-carrier").forEach((b) => b.classList.toggle("active", b.dataset.code === chkState.curCarrier));
  }
  const picker = $("chkProvPicker");
  if (picker) {
    buildProvPicker(picker);
    picker.setOptions(chkState.provs.map((p) => ({ code: p.code, name: p.name, total: { tariffs: p.total } })), chkState.cur ? chkState.cur.code : "");
    picker.addEventListener("change", () => {
      const p = chkState.provs.find((x) => x.code === picker.value);
      if (!p || (chkState.cur && chkState.cur.code === p.code)) return;
      chkState.cur = p;
      chkRenderItems();
    });
  }
  chkRenderSummary();
  chkRenderItems();
}

function doCheck() {
  if (checking) return;
  checking = true;
  const btn = $("refreshBtn");
  btn.style.opacity = ".55";
  fetchNoCache("stats.json")
    .then(raw => {
      const carrier = (raw.carriers && raw.carriers[currentCarrier]) || {};
      const cm = carrier.category_maps || {};
      applyCategoryMaps(cm);
      const s = {
        version: raw.version,
        crawl_time: raw.crawl_time,
        next_crawl_time: raw.next_crawl_time,
        status: raw.status,
        last_crawl_duration_ms: raw.last_crawl_duration_ms,
        cache: raw.cache,
        default_carrier: raw.default_carrier,
        default_province: carrier.default_province,
        last_crawl: carrier.last_crawl,
        today: carrier.today,
        provinces: carrier.provinces || [],
        all_carriers: raw.carriers ? Object.keys(raw.carriers) : [],
      };
      STATS = s;
      renderCarrierSwitch(s.all_carriers);
      if (!ACTIVE_CARRIERS.includes(currentCarrier)) {
        if (ACTIVE_CARRIERS.length > 0) {
          switchCarrier(ACTIVE_CARRIERS[0]);
          return;
        }
      }
      fillProvSelects();
      const updated = fmtTime(s.crawl_time);
      $("updateTime").textContent = updated;
      // 【检测变化的判断依据】弹窗全部来自服务端统计，前端零对比：
      //   汇总数字 = stats 的 today（分类汇总）；省选择器 = provinces[].today（按省）；
      //   条目明细 = 各省 changelog 文件按"北京时间今日 0 点"筛 logs
      const todayAdd = Object.values(s.today || {}).reduce((sum, c) => sum + (c && c.added ? c.added : 0), 0);
      const todayRm = Object.values(s.today || {}).reduce((sum, c) => sum + (c && c.removed ? c.removed : 0), 0);
      const todayChg = Object.values(s.today || {}).reduce((sum, c) => sum + (c && c.changed ? c.changed : 0), 0);

      const hasChange = todayAdd > 0 || todayRm > 0 || todayChg > 0;
      if (hasChange) {
        chkOpenChangedModal(raw.carriers, currentCarrier, updated);
      } else {
        openModal("无变化", `<div class="res-row ok">暂未检测到资费变化。</div><div class="res-row sub">快照时间：${esc(updated)}</div>`);
      }
      // 用户主动检测变化，清空所有本地缓存，强制从服务器获取最新数据
      Object.keys(cache).forEach(k => delete cache[k]);
      Object.keys(listState).forEach(k => delete listState[k]);
      // stats 的 localStorage 缓存由上面的 fetchNoCache 已重新写入最新值，无需手动清理

      // 根据当前激活的视图重新渲染
      const activeView = document.querySelector(".view.active");
      if (activeView) {
        const id = activeView.id;
        if (id === "view-overview") {
          renderOverview();
        } else if (id.startsWith("view-t1_")) {
          renderList(id.slice(8));
        } else if (id === "view-changelog") {
          renderChangelog();
        } else if (id === "view-monitor") {
          renderMonitor();
        } else {
          renderOverview();
        }
      } else {
        renderOverview();
      }
    })
    .catch(e => { openModal("检测失败", `<div class="res-row">数据获取失败：${esc(e.message)}</div>`); })
    .finally(() => { checking = false; btn.style.opacity = ""; });
}

/* ─────────────── 事件委托（页面级） ─────────────── */
/** 变更日志：批次节点展开/收起（点击与键盘 Enter/Space 共用） */
function clToggleBatch(head) {
  const item = head.closest(".tl-item");
  if (!item) return;
  const open = item.classList.toggle("open");
  item.setAttribute("aria-expanded", open ? "true" : "false");
  if (item.dataset.cts) clOpenOverride.set(item.dataset.cts, open);
}
/** 变更日志：类型子卡片展开/收起（点击与键盘共用） */
function clToggleSec(head) {
  const entry = head.closest(".tl-sec-entry");
  if (!entry) return;
  const item = entry.closest(".tl-item");
  const open = entry.classList.toggle("open");
  head.setAttribute("aria-expanded", open ? "true" : "false");
  if (item && item.dataset.cts) clSecOverride.set(item.dataset.cts + "|" + (entry.dataset.stype || ""), open);
}

function onRootClick(e) {
  // 未采集省份提示自动消隐
  const tip = document.getElementById("provTip");
  if (tip && !e.target.closest(".heatmap-tile.inactive")) {
    tip.classList.remove("show");
  }

  const actEl = e.target.closest("[data-act]");
  if (actEl) {
    const a = actEl.dataset.act;
    if (a === "retryList") { renderList(actEl.dataset.arg); return; }
    if (a === "retryChangelog") { renderChangelog(); return; }
    if (a === "retryMonitor") { renderMonitor(); return; }
    if (a === "clModalCopy") { clModalCopyClick(actEl); return; }
    if (a === "clModalDiff") {
      clDiffOnly = !clDiffOnly;
      try { localStorage.setItem("chinamnos_cl_diff_mode", clDiffOnly ? "1" : "0"); } catch {}
      if (clModalLog) openClModal(clModalLog); // 已存当前日志，重开弹窗即生效，零重拉
      return;
    }
    if (a === "actQrDownload") { actQrDownload(actEl.dataset.id, actEl.dataset.title); return; }
  }

  const carrierBtn = e.target.closest("[data-carrier]");
  if (carrierBtn && carrierSwitchContains(carrierBtn)) {
    switchCarrier(carrierBtn.dataset.carrier);
    return;
  }

  const rankRow = e.target.closest(".rank-row");
  if (rankRow && rankRow.dataset.prov) {
    goProvince(rankRow.dataset.prov);
    return;
  }

  // 变更日志：业务胶囊 → 详情弹窗（先于子卡片头/批次头判定）
  const clChip = e.target.closest(".tl-chip-btn");
  if (clChip && $("tariffRoot") && $("tariffRoot").contains(clChip)) {
    const log = clView && clView.logs ? clView.logs[Number(clChip.dataset.clidx)] : null;
    if (log) openClModal(log);
    return;
  }

  // 变更日志：类型子卡片折叠/展开（记忆用户选择，重渲染不弹回）
  const clSecHead = e.target.closest(".tl-sec-head");
  if (clSecHead && $("tariffRoot") && $("tariffRoot").contains(clSecHead)) {
    clToggleSec(clSecHead);
    return;
  }

  // 变更日志：批次节点展开/收起（记忆用户选择）
  const clHead = e.target.closest(".tl-item .tl-head");
  if (clHead && $("tariffRoot") && $("tariffRoot").contains(clHead)) {
    clToggleBatch(clHead);
    return;
  }

  // 变更日志：加载更多（IntersectionObserver 不可用时的兜底按钮）
  const clMoreBtn = e.target.closest(".cl-more-btn");
  if (clMoreBtn) { clMoreBatch(); return; }

  const tile = e.target.closest(".heatmap-tile");
  if (tile && tile.dataset.code) {
    if (tile.classList.contains("inactive")) showUncollectedTip(tile, tile.dataset.name);
    else goProvince(tile.dataset.code);
  }
}

function carrierSwitchContains(el) {
  const sw = $("carrierSwitch");
  return !!(sw && sw.contains(el));
}

/* ─────────────── 页面初始化 ─────────────── */
let _rootClickHandler = null;
let _rootKeyHandler = null;

/** "/" 快捷键：聚焦当前页签的搜索框；时间轴折叠头 Enter/Space = 点击（role=button 的键盘契约） */
function onRootKeydown(e) {
  if ((e.key === "Enter" || e.key === " ") && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const t = e.target;
    if (t && t.closest) {
      const secHead = t.closest(".tl-sec-head");
      if (secHead) { e.preventDefault(); clToggleSec(secHead); return; }
      const head = t.closest(".tl-item .tl-head");
      if (head) { e.preventDefault(); clToggleBatch(head); return; }
    }
  }
  if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
  const ae = document.activeElement;
  const tag = ae ? ae.tagName : "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (ae && ae.isContentEditable)) return;
  const activeView = document.querySelector("#tariffRoot .view.active");
  const search = activeView && activeView.querySelector(".search-box");
  if (search) {
    e.preventDefault();
    search.focus();
    if (search.select) search.select();
  }
}

function initTariff() {
  initModal();
  initTheme();
  initProvListeners();
  initSidebar();
  loadFavs();
  initCompareBridge({
    provCode: getProvCode,
    provName,
    provList: () => (STATS && STATS.provinces ? STATS.provinces : []),
    carrierName: (c) => (CARRIER_BRAND[c] || {}).name || c,
    currentCarrier: () => currentCarrier,
    provPicker: (container) => {
      /* 顶栏同款省份选择组件（资费对比页接入，与 #gProv 同组件同交互） */
      buildProvPicker(container);
      const provs = STATS && STATS.provinces ? STATS.provinces : [];
      const defCode = STATS && STATS.default_province ? STATS.default_province : "hun";
      container.setOptions(provs, provs.some(p => p.code === getProvCode()) ? getProvCode() : (provs.some(p => p.code === defCode) ? defCode : (provs.length ? provs[0].code : "")));
    },
    loadSnapFor,
    cacheDrop: (ck) => { delete cache[ck]; },   // 对比视图切省时释放旧省快照（23MB 级/省）
    areaCn,
    goTab,
    ensureBoot: ensureTariffBootstrapped,
    favRaw: () => RAW_FAVS,
    removeFav: removeFavBy,
  });
  $("refreshBtn").addEventListener("click", doCheck);

  navTabs = new Tabs($("mainNav"), onTabChange);
  navTabs.add("announce", { label: "运营公告", icon: "bell", before: "monitor" }); // 运营公告 tab（数据总览→变更日志→运营公告→采集监控）
  navTabs.add("chat", { label: "唠嗑聚落", icon: "users", before: "about" }); // 唠嗑聚落 tab（情报酒馆之后、关于之前）
  navTabs.add("notices", { label: "公告推广", icon: "bell", before: "about" }); // 公告推广 tab（唠嗑聚落之后、关于之前）：弹窗内容随时回看
  /* 跳蚤市集 tab 内点击路由（onEnter 每次 innerHTML 重建后重绑，旧节点随之丢弃无泄漏） */
  const chBody = $("chTabBody");
  if (chBody) chBody.addEventListener("click", chOnBodyClick);
  /* 情报酒馆 tab 内点击路由（提交面板/撤回） */
  const actBody = $("actTabBody");
  if (actBody) actBody.addEventListener("click", actOnBodyClick);
  /* 公告 tab 内点击路由（筛选/展开/重试；annTabBody 是固定容器，整块重绘不丢监听） */
  const annBody = $("annTabBody");
  if (annBody) annBody.addEventListener("click", annOnBodyClick);
  /* 唠嗑聚落 tab 内点击路由（收录面板/撤回/复制等；chatTabBody 是固定容器） */
  const chatBody = $("chatTabBody");
  if (chatBody) chatBody.addEventListener("click", chatOnBodyClick);
  /* 路由重入（如从管理后台返回）：DOM 已重建，但模块级缓存 dynamicType1Keys 还留着旧值，
     buildDynamicTabs 的「codes 未变化即 return」守卫会跳过重建，导致侧边栏分类按钮消失。
     故 onEnter 必须清空该缓存键，强制下次 buildDynamicTabs 全量重挂 */
  dynamicType1Keys = [];
  bindTlTip();
  loadAboutTimeline(); // 关于页时间轴：站长配置优先，未配置保留内置默认
  loadAboutThanks();   // 关于页鸣谢名单：站长配置（空组隐藏，全空整块隐藏）
  loadAboutLinks();    // 关于页友情链接：站长配置（空数组整块隐藏；申请走工单预填）

  if ($("clToggleAll")) $("clToggleAll").addEventListener("click", clToggleAll);

  /* 弹窗内分享按钮分发（顶层 dialog，tab 级委托捕获不到） */
  window.__MODAL_ACT__ = {
    actShare: (el) => shareLink({ title: el.dataset.title || "情报酒馆", text: "来自情报酒馆的一条分享", hash: "act_" + currentCarrier + "_" + getProvCode() + "_" + encodeURIComponent(el.dataset.id || "") }),
    clShare: () => {
      const log = clModalLog;
      if (log) shareLink({ title: log.name || "变更记录", text: "一条资费变更记录", hash: "cl_" + currentCarrier + "_" + getProvCode() + "_" + String(log.ts ?? "") + "_" + encodeURIComponent(log.name || "") });
    },
    /* 检测弹窗：切运营商 / 条目胶囊跳转变更日志详情（跨运营商由 consumeClDeep 自动 switchCarrier）；
       切省由 provPicker 的 change 事件驱动，不经 ACT 分发 */
    chkCarrier: (el) => {
      if (!el.dataset.code || el.dataset.code === chkState.curCarrier) return;
      chkSetCarrier(el.dataset.code);
    },
    chkJump: (el) => {
      const ts = el.dataset.ts || "", name = el.dataset.name || "", prov = el.dataset.prov || "";
      if (!ts || !prov) return;
      closeModal();
      consumeClDeep({ kind: "cl", carrier: chkState.curCarrier || currentCarrier, prov, ts, name: name.toLowerCase(), label: name }, false);
    },
    /* 今日新增/下架省份分布弹窗：点省份行 → 切省并打开该省变更记录 */
    todayProvJump: (el) => {
      const code = el.dataset.code || "";
      if (!code) return;
      closeModal();
      delete TAB_SHOWN["changelog"]; // 清一次性渲染守卫：否则 goTab 被拦截不重渲，停留旧省数据
      goProvince(code, "changelog");
    },
  };
  /* 关于页「分享本站」（关于页区域无点击委托，走 window 挂钩） */
  window.__cmnosShareSite = () => shareLink({ title: "ChinaMNOs 讯览台", text: "全网资费实时面板", hash: "" });

  var raw = (location.hash || "").replace("#", "").trim();
  var staticTabs = ["overview","changelog","announce","monitor","compare","favs","cardhub","acts","chat","notices","about"];
  if (staticTabs.includes(raw)) {
    goTab(raw);
    if (raw !== "overview") ensureTariffBootstrapped();   // 子菜单直链：页面级快照引导（顶栏状态/运营商切换/省份选择器/动态页签）
  } else if (raw.startsWith("t1_")) {
    pendingTab = raw;
    goTab("overview");   // renderOverview 自有全链路引导，pendingTab 由 stats 就绪路径消费
  } else if (/^(act|chat|ann|cl|plan)_/.test(raw)) {
    handleDeepLink(raw);   // 条目/页面级深链自带引导（含切运营商/省）
  } else if (/^monitor_/.test(raw) && isScopePair(raw.slice(8), "hun")) {
    consumeScopePage(raw.slice(8), getProvCode(), "monitor");   // 页面级 monitor_<carrier>：切运营商进采集监控（诊断数据无省维度）
  } else if (/^notices_/.test(raw)) {
    /* 页面级 notices_<carrier>_<prov>：公告推广范围过滤（ntcScopeFilter）读 localStorage，
       consumeScopePage 先切运营商/省（写入记忆）再进页签，渲染时即命中目标范围 */
    const np = raw.slice(8).split("_");
    if (np.length === 2 && isScopePair(np[0], np[1])) consumeScopePage(np[0], np[1], "notices");
    else goTab("notices");   // 格式不符回退静态页签
  } else {
    goTab("overview");
  }
}

/* ─────────────── 条目级深链（分享落地） ───────────────
   #act_<carrier>_<prov>_<id>      情报酒馆帖详情弹窗（切运营商/省后打开；旧格式 act_<id> 兼容，落当前运营商/省）
   #chat_<carrier>_<prov>_<id>     唠嗑聚落卡片定位高亮（同上；旧格式 chat_<id> 兼容）
   #ann_<carrier>_<id>             运营公告条目展开定位（自动切运营商）
   #cl_<carrier>_<prov>_<ts>_<name(URI编码)>   变更记录：切运营商/省份 + 按名称过滤 + 弹该条详情
   #plan_<carrier>_<prov>_<方案编号(URI编码)>   资费列表：切运营商/省份 + 全分类搜索过滤该方案
   页面级（去 id 化，见上方「页面级分享/深链」注释）：
   #act|chat|cl_<carrier>_<prov>   切范围后进对应页签；#plan_<carrier>_<prov>[_<t1>] 进资费列表/分类
   解析后置 pendingDeep，由各数据就绪路径消费（轮询兜底，见 pollDeep*） */
let pendingDeep = null;
let pendingAnnId = "";
/* 公告深链目标（ann_<carrier>_<id>）：跨重渲染保持展开态。
   pendingAnnId 消费一次即清空，但进站引导管线会对公告页做多次重渲染（goTab 与 pollDeep 各一次），
   第二次渲染 innerHTML 重建列表会抹掉第一次的展开态——annDeepId 在每次渲染后重新应用展开，
   直到用户手动点按公告行（交还控制权）或目标失配（切运营商/搜索过滤）自动清除 */
let annDeepId = "";
let annDeepScrolled = false;   // 首次命中时滚动+高亮只做一次，后续重渲染仅补展开不滚屏
let annDeepCarrier = "";       // 深链目标运营商：范围自动放宽（外省过滤场景）仅在该运营商内生效，防误伤切运营商后的渲染

/* ─────────────── 页面级分享/深链（条目格式「去 id 化」） ───────────────
   分享按钮按当前页签+运营商（+省份，有省维度者）拼 hash；落地时切范围后进对应页签。
   同前缀下段数递减 = 粒度递粗：
     plan_<carrier>_<prov>_<t1>_<方案编号>  条目级（已有）
     plan_<carrier>_<prov>_<t1>            资费列表 + 指定分类页签
     plan_<carrier>_<prov>                 资费页面（数据总览，范围已切）
     act_/chat_/cl_<carrier>_<prov>        情报酒馆/唠嗑聚落/变更记录页面级
     ann_<carrier>                         运营公告页面级（公告按运营商一份，无省维度；条目格式 ann_<carrier>_<id> 不受影响）
     monitor_<carrier>                     采集监控页面级（诊断 _diag.json 按运营商一份，无省维度）
     notices_<carrier>_<prov>              公告推广页面级（范围过滤读 localStorage，须先切范围再渲染）
     compare/favs/about/cardhub            静态页签裸 hash（onEnter 静态分支直达，无范围维度或个人数据） */

/* 范围段合法性：运营商限定四码，省代码 2-6 位小写（与条目级 hasScope 校验口径一致）。
   不合法的两段式回退旧格式解析，保证旧链接（act_<id> 等）永不误判 */
function isScopePair(c, p) {
  return ["cmcc", "cucc", "ctcc", "cbn"].indexOf(c) >= 0 && /^[a-z]{2,6}$/.test(p);
}

/* 页面级深链消费：引导数据管线 → 切运营商 → 切省 → 进目标页签（幂等，进齐即落地） */
function consumeScopePage(carrier, prov, tab) {
  goTab("overview");
  deepLoadingShow();
  pollDeep(() => {
    if (!ACTIVE_CARRIERS.length) { loadStats().catch(() => {}); return false; }
    if (currentCarrier !== carrier) { switchCarrier(carrier); return false; }
    if (!deepSwitchProv(prov)) return false;
    if (!navTabs) return false;
    if (navTabs.active !== tab) { goTab(tab); return false; }
    return true;
  }, () => deepLoadingHide());
}

/* 顶栏「分享当前页面」：按激活页签映射深链前缀（去 id 化页面级格式，见顶部注释） */
function shareCurrentView() {
  const tab = navTabs ? navTabs.active : "overview";
  const scope = currentCarrier + "_" + getProvCode();
  let hash = tab || "overview";
  let title = "资费监测";
  if (tab === "overview") { hash = "plan_" + scope; title = "资费页面"; }
  else if (tab.startsWith("t1_")) { hash = "plan_" + scope + "_" + tab.slice(3); title = "资费列表"; }
  else if (tab === "changelog") { hash = "cl_" + scope; title = "变更记录"; }
  else if (tab === "acts") { hash = "act_" + scope; title = "情报酒馆"; }
  else if (tab === "chat") { hash = "chat_" + scope; title = "唠嗑聚落"; }
  else if (tab === "compare") { title = "资费对比"; }
  else if (tab === "announce") { hash = "ann_" + currentCarrier; title = "运营公告"; }
  else if (tab === "monitor") { hash = "monitor_" + currentCarrier; title = "采集监控"; }
  else if (tab === "notices") { hash = "notices_" + scope; title = "公告推广"; }
  shareLink({ title, text: "来自 ChinaMNOs 讯览台的分享", hash });
}

/* 变更日志条目定位（cl 深链与检测弹窗「查看变更」跳转共用）：
   等运营商就绪 → 切运营商 → 切省 → 进变更记录 tab → 按 ts+名称匹配条目弹详情。
   boot=true（分享链接全新进站：ACTIVE_CARRIERS=[]、省份选择器未构建）先 goTab("overview") 引导数据管线；
   boot=false（站内跳转）直达变更日志页签。数据未就绪由 pollDeep 轮询兜底（10s 上限） */
function consumeClDeep(deep, boot) {
  pendingDeep = deep;
  goTab(boot ? "overview" : "changelog");
  deepLoadingShow();
  pollDeep(() => {
    if (!ACTIVE_CARRIERS.length) { loadStats().catch(() => {}); return false; }
    if (currentCarrier !== pendingDeep.carrier) { switchCarrier(pendingDeep.carrier); return false; }
    if (!deepSwitchProv(pendingDeep.prov)) return false;
    if (navTabs && navTabs.active !== "changelog") { goTab("changelog"); return false; }
    /* 深链过滤词同步回填搜索框：列表被过滤但搜索框空白会反直觉（用户不知为何只剩一条） */
    const cSearchEl = $("cSearch");
    if (cSearchEl && cSearchEl.value !== pendingDeep.label) cSearchEl.value = pendingDeep.label;
    const logs = (clView && Array.isArray(clView.logs)) ? clView.logs : [];
    const hit = logs.find((l) => String(l.ts) === pendingDeep.ts && String(l.name || "").toLowerCase() === pendingDeep.name);
    if (hit) {
      if (clQ !== pendingDeep.name) { clQ = pendingDeep.name; renderChangelog(); }   // 过滤聚焦该条目所在批次
      openClModal(hit);
      pendingDeep = null;
      return true;
    }
    return false;   // 数据加载中 / 该省快照无此条目（至超时停留）
  }, () => deepLoadingHide());
}

function handleDeepLink(raw) {
  const m = raw.match(/^(act|chat|ann|cl|plan)_(.+)$/);
  if (!m) { goTab("overview"); return; }
  const kind = m[1], rest = m[2];
  /* act_/chat_ 新格式前两段 = 运营商/省代码：条目按运营商+省过滤，不切范围的话跨范围打开看不到条目 */
  const scopeParts = rest.split("_");
  const hasScope = scopeParts.length >= 3 && /^[a-z]{2,4}$/.test(scopeParts[0]) && /^[a-z]{2,6}$/.test(scopeParts[1]);
  /* 带范围深链统一消费：引导数据管线 → 切运营商 → 切省 → consume(id) 返回 true 表示已落地 */
  function consumeWithScope(consume) {
    const carrier = scopeParts[0], prov = scopeParts[1];
    const id = decodeURIComponent(scopeParts.slice(2).join("_"));
    goTab("overview");
    deepLoadingShow();
    pollDeep(() => {
      if (!ACTIVE_CARRIERS.length) { loadStats().catch(() => {}); return false; }
      if (currentCarrier !== carrier) { switchCarrier(carrier); return false; }
      if (!deepSwitchProv(prov)) return false;
      return consume(id);
    }, () => deepLoadingHide());
  }
  if (kind === "act") {
    if (scopeParts.length === 2 && isScopePair(scopeParts[0], scopeParts[1])) { consumeScopePage(scopeParts[0], scopeParts[1], "acts"); return; }   // 页面级：切范围进情报酒馆
    if (hasScope) {
      consumeWithScope((id) => { goTab("acts"); actOpenDetail(id); return true; });   // 详情弹窗独立拉接口，自带加载态
      return;
    }
    goTab("acts");
    actOpenDetail(decodeURIComponent(rest));   // 旧格式：详情弹窗独立拉接口，不依赖列表
    return;
  }
  if (kind === "chat") {
    if (scopeParts.length === 2 && isScopePair(scopeParts[0], scopeParts[1])) { consumeScopePage(scopeParts[0], scopeParts[1], "chat"); return; }   // 页面级：切范围进唠嗑聚落
    if (hasScope) {
      consumeWithScope((id) => {
        goTab("chat");   // 幂等（TAB_SHOWN 拦截重复渲染），列表异步拉取后出现卡片
        const el = document.querySelector(`[data-chat-id="${CSS.escape(id)}"]`);
        if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.classList.add("deep-hit"); return true; }
        return false;   // 列表加载中 / 该范围无此条目（至超时停留）
      });
      return;
    }
    pendingDeep = { kind: "chat", id: decodeURIComponent(rest) };
    pollDeep(() => { const el = document.querySelector(`[data-chat-id="${CSS.escape(pendingDeep.id)}"]`); if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.classList.add("deep-hit"); pendingDeep = null; return true; } return chatState.items.length > 0; });
    return;
  }
  if (kind === "ann") {
    const sep = rest.indexOf("_");
    /* 页面级 ann_<carrier>（rest 无下划线且为合法运营商码）：切运营商进公告页签。
       条目级 ann_<carrier>_<id>（id 数字/ULID，与运营商码无重叠）不受影响；
       旧无下划线格式 ann_<id> 仍按 id 解析落当前运营商 */
    const carrier = sep > 0 ? rest.slice(0, sep) : (isScopePair(rest, "hun") ? rest : "");
    const pageLevel = !sep && !!carrier;
    pendingAnnId = decodeURIComponent(pageLevel ? "" : (sep > 0 ? rest.slice(sep + 1) : rest));
    annDeepId = pendingAnnId;   // 深链目标：渲染后自动展开（跨重渲染保持，见 annDeepId 注释）
    annDeepScrolled = false;
    annDeepCarrier = carrier || currentCarrier;
    if (!carrier) {
      goTab("announce");
      annTabRefresh().then(() => { if (pendingAnnId) annRenderBody(); });
      return;
    }
    /* 全新进站 ACTIVE_CARRIERS=[]，前置 switchCarrier 会被守卫拦截成 no-op：
       先 goTab("overview") 引导数据管线，轮询等运营商就绪后切目标运营商，再进公告 tab */
    goTab("overview");
    deepLoadingShow();
    pollDeep(() => {
      if (!ACTIVE_CARRIERS.length) { loadStats().catch(() => {}); return false; }
      if (currentCarrier !== carrier) { switchCarrier(carrier); return false; }
      goTab("announce");
      annTabRefresh().then(() => { if (pendingAnnId) annRenderBody(); });
      return true;
    }, () => deepLoadingHide());
    return;
  }
  if (kind === "cl") {
    const parts = rest.split("_");
    if (parts.length === 2 && isScopePair(parts[0], parts[1])) { consumeScopePage(parts[0], parts[1], "changelog"); return; }   // 页面级：切范围进变更记录
    if (parts.length < 4) { goTab("changelog"); return; }
    const carrier = parts[0], prov = parts[1];
    const ts = parts[2];   // log.ts 为 ISO 字符串（含冒号），原样字符串比较，禁止 Number()（NaN 必败）
    const name = decodeURIComponent(parts.slice(3).join("_")).toLowerCase();
    if (!/^[a-z]+$/.test(carrier) || !/^[a-z]{2,6}$/.test(prov) || !ts) { goTab("changelog"); return; }
    consumeClDeep({ kind: "cl", carrier, prov, ts, name, label: decodeURIComponent(parts.slice(3).join("_")) }, true);
    return;
  }
  if (kind === "plan") {
    /* plan_<运营商>_<省>_<页签code(tariff_attr)>_<方案编号（回退名称）>：
       页签维度 = 条目 tariff_attr（1=各省通用 / 2=本省专属），快照按省一份、文件内按该字段区分 */
    const parts = rest.split("_");
    /* 页面级：plan_<carrier>_<prov>（数据总览）/ plan_<carrier>_<prov>_<t1>（资费列表+指定分类页签）。
       条目级四段起，两/三段为页面级空档，旧链接不受影响 */
    if (parts.length === 2 && isScopePair(parts[0], parts[1])) { consumeScopePage(parts[0], parts[1], "overview"); return; }
    if (parts.length === 3 && isScopePair(parts[0], parts[1]) && /^[a-z0-9]+$/.test(parts[2])) {
      const carrier = parts[0], prov = parts[1], t1Code = parts[2];
      goTab("overview");
      deepLoadingShow();
      pollDeep(() => {
        if (!ACTIVE_CARRIERS.length) { loadStats().catch(() => {}); return false; }
        if (currentCarrier !== carrier) { switchCarrier(carrier); return false; }
        if (!ATTR_MAP[t1Code]) return false;   // 目标运营商分类映射随 renderOverview→loadStats 异步填充（同条目级）
        if (!deepSwitchProv(prov)) return false;
        if (!navTabs || !$("view-t1_" + t1Code)) return false;   // 动态页签/视图未构建前不激活
        if (navTabs.active !== "t1_" + t1Code) { goTab("t1_" + t1Code); return false; }
        return true;
      }, () => deepLoadingHide());
      return;
    }
    if (parts.length < 4) { goTab("overview"); return; }
    const carrier = parts[0], prov = parts[1], t1Code = parts[2];
    const planNo = decodeURIComponent(parts.slice(3).join("_")).toLowerCase();
    if (!/^[a-z]+$/.test(carrier) || !/^[a-z]{2,6}$/.test(prov) || !/^[a-z0-9]+$/.test(t1Code)) { goTab("overview"); return; }
    pendingDeep = { kind: "plan", carrier, prov, t1: t1Code, plan: planNo, label: decodeURIComponent(parts.slice(3).join("_")) };
    /* 全新进站（分享链接直达）时 ACTIVE_CARRIERS=[]：前置 switchCarrier 是 no-op、省份选择器未构建、
       动态页签不存在、renderOverview 数据管线全程未跑——必须先 goTab("overview") 引导
       （loadStats → renderCarrierSwitch → 默认运营商加载），再分阶段消费：
       等运营商就绪 → 切目标运营商（switchCarrier 内部重载 stats/页签/选择器）→ 等新映射 → 切省 → 进列表页签定位 */
    goTab("overview");
    deepLoadingShow();
    pollDeep(() => {
      if (!ACTIVE_CARRIERS.length) { loadStats().catch(() => {}); return false; }
      if (currentCarrier !== pendingDeep.carrier) { switchCarrier(pendingDeep.carrier); return false; }
      if (!ATTR_MAP[pendingDeep.t1]) return false;   // 目标运营商分类映射随 renderOverview→loadStats 异步填充
      if (!deepSwitchProv(pendingDeep.prov)) return false;
      const s = getListState(pendingDeep.t1 + "_" + getProvCode());
      if (s.q !== pendingDeep.plan) { s.q = pendingDeep.plan; s.qMode = "all"; s.page = 1; }
      goTab("t1_" + pendingDeep.t1);   // 幂等：TAB_SHOWN 拦截重复渲染，首次 renderList 走 loadSnapshot 异步
      /* 深链过滤词同步回填搜索框：列表被过滤但搜索框空白会反直觉（用户不知为何只剩几条）。
         每轮幂等回填（视图/工具栏由 buildDynamicTabs 构建，晚于首帧），程序赋值不触发 input 事件 */
      const qEl = $(t1Id(pendingDeep.t1, "search"));
      if (qEl && qEl.value !== pendingDeep.label) qEl.value = pendingDeep.label;
      const listEl = $(t1Id(pendingDeep.t1, "list"));
      /* 列表形态两种都要认：卡片模式 = article.tcard，列表模式（默认）= div.item */
      const hasItem = listEl && listEl.querySelector(".tcard, .item, article, .res-row");
      if (hasItem) {
        pendingDeep = null;
        setTimeout(() => hasItem.scrollIntoView({ behavior: "smooth", block: "center" }), 150);
        return true;
      }
      return false;   // 快照加载中，下轮再看（10s 上限）
    }, () => deepLoadingHide());
    return;
  }
  goTab("overview");
}

/* 深链轮询兜底：数据未就绪时每 150ms 重试（最多 66 次 ≈ 10s 上限），fn 返回 true 表示已消费。
   间隔取小值：条目渲染完成后最多再等 150ms 才被发现撤遮罩——500ms 粒度下「数据已好、遮罩压着」的空窗体感明显 */
function pollDeep(fn, onEnd) {
  let n = 0;
  const t = setInterval(() => {
    n++;
    let done = false;
    try { done = fn(); } catch { done = false; }
    if (done || n >= 66) {
      clearInterval(t);
      if (onEnd) { try { onEnd(done); } catch { /* 释放失败不影响收尾 */ } }
    }
  }, 150);
}

/* ─────────────── 关于页 · 项目历程时间轴（站长在管理中心 about_timeline 配置；内置节点已 seed 进 settings，清空=隐藏区块）
   ▸ aboutCache 会话级缓存：页面生命周期内只拉一次，之后进关于页零请求即时渲染 ─────────────── */
const aboutCache = { tl: null, th: null, lk: null };
function aboutTimelineNodeHTML(n) {
  return `
  <div class="tl-node" data-desc="${esc(n.desc || "")}">
    <div class="tl-time">${esc(n.t || "")}</div>
    <div class="tl-phase">${esc(n.title || "")}</div>
    <div class="tl-dot"></div>
  </div>`;
}
function loadAboutTimeline() {
  const el = $("aboutTl");
  if (!el) return;
  const render = (list) => {
    if (!list.length) { const p = el.closest(".panel"); if (p) p.hidden = true; return; }
    const panel = el.closest(".panel");
    if (panel) panel.hidden = false; // 解除初始 hidden（有节点才显示区块）
    /* 均匀铺满为默认；仅当每列可用宽度不足 160px（节点多或视口窄）时切换横向滚动 */
    const scroll = list.length > 3 && (el.clientWidth || 0) / list.length < 160;
    el.innerHTML = `<div class="tl-track${scroll ? " tl-many" : ""}">${list.map(aboutTimelineNodeHTML).join("")}</div>`;
  };
  if (aboutCache.tl) { render(aboutCache.tl); return; }
  /* 快照优先（data/public-config.json 的 about.timeline，下一轮采集更新）；缺失回落 Worker 接口 */
  getPubConfig().then((pc) => {
    if (pc && pc.about && pc.about.timeline) { aboutCache.tl = pc.about.timeline; render(aboutCache.tl); return null; }
    return api.request("/api/about/timeline").then((r) => {
      aboutCache.tl = r.ok ? (r.data.timeline || []) : [];
      render(aboutCache.tl);
    }).catch(() => render([]));
  }).catch(() => render([]));
}

/* ─────────────── 关于页 · 鸣谢名单（表格形式 · 类型切换；站长 settings 键 about_thanks 维护；空组隐藏，全空整块隐藏）
   ▸ 槽位语义按类别：打赏 f1=留言 f2=金额 f3=渠道 f4=时间；反馈 f1=摘要 f2=时间；参考 f1=介绍 f2=参考说明 f3=链接 ─────────────── */
const THANKS_CATS = [
  { key: "donor", label: "任意打赏", ic: "coins",
    cols: ["昵称", "打赏留言", "金额", "渠道", "时间"],
    cells: [["name", ""], ["f1", "desc"], ["f2", "amt"], ["f3", "chan"], ["f4", "time"]] },
  { key: "feedback", label: "反馈建议", ic: "message",
    cols: ["昵称", "建议内容", "时间"],
    cells: [["name", ""], ["f1", "desc"], ["f2", "time"]] },
  { key: "ref", label: "参考项目", ic: "box",
    cols: ["项目名称", "项目介绍", "参考说明"],
    cells: [["name", "namelink"], ["f1", "desc"], ["f2", "note"]] },
];
function loadAboutThanks() {
  const el = $("aboutThanks");
  if (!el) return;
  let groups = {};
  let cur = "";
  const render = () => {
    const secs = THANKS_CATS.filter((c) => (groups[c.key] || []).length);
    if (!secs.length) { const p = el.closest(".panel"); if (p) p.hidden = true; return; }
    const panel = el.closest(".panel");
    if (panel) panel.hidden = false; // 解除初始 hidden（有内容才显示区块）
    if (!cur || !secs.some((c) => c.key === cur)) cur = secs[0].key;
    const cat = THANKS_CATS.find((c) => c.key === cur);
    const items = groups[cur] || [];
    const cellHTML = (it, [k, cls]) => {
      const v = String(it[k] || "").trim();
      if (!v) return `<td class="thx-td-empty">—</td>`;
      /* namelink：项目名称整格可点（跳该条 f3 链接；无链接则纯文本）——参考项目的链接列已取消 */
      if (cls === "namelink") {
        const link = String(it.f3 || "").trim();
        const inner = `${esc(v)}${/^https?:\/\//i.test(link) ? icon("external") : ""}`;
        return /^https?:\/\//i.test(link)
          ? `<td><a class="thx-name-cell" href="${esc(link)}" target="_blank" rel="noopener noreferrer" title="打开 ${esc(link)}">${inner}</a></td>`
          : `<td class="thx-name-cell">${inner}</td>`;
      }
      if (cls === "") return `<td class="thx-name-cell">${esc(v)}</td>`;
      return `<td><span class="thx-${cls}">${esc(v)}</span></td>`;
    };
    el.innerHTML = `
      <div class="thx-seg">${secs.map((c) => `
        <button class="seg-btn${c.key === cur ? " active" : ""}" data-thxcat="${c.key}">${icon(c.ic)} ${esc(c.label)}<span class="thx-seg-n">${(groups[c.key] || []).length}</span></button>`).join("")}
      </div>
      <div class="thx-table-wrap">
        <table class="thx-table">
          <thead><tr>${cat.cols.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
          <tbody>${items.map((it) => `<tr>${cat.cells.map((c2) => cellHTML(it, c2)).join("")}</tr>`).join("")}</tbody>
        </table>
      </div>`;
  };
  el.onclick = (e) => { // onclick 赋值天然幂等（直链 #about 时 onEnter 可能多次执行）
    const btn = e.target.closest("[data-thxcat]");
    if (!btn || btn.dataset.thxcat === cur) return;
    cur = btn.dataset.thxcat;
    render();
  };
  if (aboutCache.th) { groups = aboutCache.th; render(); return; }
  /* 快照优先（data/public-config.json 的 about.thanks，下一轮采集更新）；缺失回落 Worker 接口 */
  getPubConfig().then((pc) => {
    if (pc && pc.about && pc.about.thanks) { groups = pc.about.thanks; aboutCache.th = groups; render(); return null; }
    return api.request("/api/about/thanks").then((r) => { groups = r.ok ? (r.data.groups || {}) : {}; aboutCache.th = groups; render(); }).catch(() => { groups = {}; render(); });
  }).catch(() => { groups = {}; render(); });
}

/* ─────────────── 关于页 · 友情链接（站长 settings 键 about_links 维护；空数组整块隐藏）
   ▸ 每条 = 链接名 + 一句话介绍，整条可点跳转（新窗口 nofollow）；「申请友链」走工单通用预填 ─────────────── */
function loadAboutLinks() {
  const el = $("aboutLinks");
  if (!el) return;
  const render = (links) => {
    const panel = el.closest(".panel");
    if (!(links || []).length) { const p = el.closest(".panel"); if (p) p.hidden = true; return; }
    if (panel) panel.hidden = false;
    const applyBtn = Auth.isLoggedIn()
      ? `<button type="button" class="btn ghost sm" data-flink-apply><i data-icon="external"></i>申请友链</button>
         <span class="hint">收录由站长审核后展示，点此通过工单申请</span>`
      : `<span class="hint">登录后可通过工单申请友链</span>`;
    el.innerHTML = `
      <div class="flink-list">
        ${links.map((l) => `
        <a class="flink-row" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer nofollow">
          <span class="flink-name">${esc(l.name)}</span>
          <span class="flink-descr">${esc(l.descr || "")}</span>
          <span class="flink-go">${icon("external")}</span>
        </a>`).join("")}
      </div>
      <div class="flink-apply">${applyBtn}</div>`;
  };
  el.onclick = (e) => { // onclick 赋值天然幂等（同 loadAboutThanks）
    const btn = e.target.closest("[data-flink-apply]");
    if (!btn) return;
    if (!Auth.isLoggedIn()) { toast("请先登录后再申请友链"); Auth.openLogin(); return; }
    const okGo = confirm("将前往工单中心提交友情链接申请，分类默认为「其他」。继续？");
    if (!okGo) return;
    try {
      sessionStorage.setItem("chinamnos_ticket_prefill", JSON.stringify({
        category: "其他",
        source: "tariff",
        title: "友情链接申请",
        content: `站长您好：\n\n我想申请在关于页「友情链接」中收录以下站点：\n\n1. 链接名称：\n2. 一句话介绍：\n3. 链接地址（https:// 开头）：\n\n站点内容简要说明：\n\n期待您的审核，谢谢！`,
        banner: "已带入友情链接申请模板，请补全链接信息后提交",
      }));
    } catch { /* sessionStorage 不可用时跳转后手填 */ }
    Shell.navigate("/ticket");
  };
  if (aboutCache.lk) { render(aboutCache.lk); return; }
  /* 快照优先（data/public-config.json 的 about.links，下一轮采集更新）；缺失回落 Worker 接口 */
  getPubConfig().then((pc) => {
    if (pc && pc.about && pc.about.links) { aboutCache.lk = pc.about.links; render(aboutCache.lk); return null; }
    return api.request("/api/about/links").then((r) => { aboutCache.lk = r.ok ? (r.data.links || []) : []; render(aboutCache.lk); }).catch(() => { render([]); });
  }).catch(() => { render([]); });
}
/* 描述浮窗：body 直下单例（fixed 定位不受滚动容器裁剪；不可放在 .panel 内——
   其 backdrop-filter 与入场动画会建立包含块，使 fixed 相对 panel 而非视口定位） */
let tlTipBound = false;
function bindTlTip() {
  if (tlTipBound) return;
  tlTipBound = true;
  const box = () => {
    let b = document.getElementById("tlTipBox");
    if (!b) {
      b = document.createElement("div");
      b.id = "tlTipBox";
      b.className = "tl-tipbox";
      document.body.appendChild(b); // body 直下，避开 panel 的包含块影响
    }
    return b;
  };
  document.addEventListener("mouseover", (e) => {
    const node = e.target.closest(".tl-node");
    const b = box();
    if (!b) return;
    const desc = node ? (node.dataset.desc || "") : "";
    if (!node || !desc) { b.classList.remove("show"); return; }
    b.textContent = desc;
    const r = node.getBoundingClientRect();
    const half = 130;
    let x = r.left + r.width / 2 - half;
    x = Math.max(10, Math.min(x, window.innerWidth - half * 2 - 10));
    b.style.left = x + "px";
    b.style.top = (r.top + 62) + "px"; // dot 行下方固定偏移（time16 + phase22 + dot 区上 10 ≈ 58）
    b.classList.add("show");
  });
  document.addEventListener("mouseout", (e) => {
    if (e.target.closest && e.target.closest(".tl-node")) { const b = box(); b && b.classList.remove("show"); }
  });
}

/* ─────────────── 公告 tab（运营商官方公告监测展示） ───────────────
   ▸ 数据：./data/{carrier}/announce.json（采集端产出 v=1，规格 docs/announce-monitoring-spec.md §4.3/§五）
   ▸ 过滤：默认「本省·全国」（province === 当前省短名 || 全国）；「全国」「全部」可切换，选择按运营商记忆
   ▸ 红点：最新一条 id ≠ localStorage 已读标记 → 侧边栏红点；进入 tab 即写已读
   ▸ 降级：content 为空的条目（电信瑞数限制等）→ 展开区提示并引导官网外链；正文白名单二次消毒
   ▸ 隔离：全部 ann 前缀 + .ann-* 样式 + 独立 localStorage 键，不触碰 shell/公共模块/Worker */
let annProvPending = false; // 直链 #announce 时 STATS 未就绪的补加载守卫（同 changelog clProvPending 模式）
const annState = {
  data: {},      // carrier → announce.json（仅 v=1 且 ok 的数据进缓存）
  loading: {},   // carrier → 进行中的请求 Promise（防并发重拉）
  scope: "home", // home=本省·全国 | national=全国 | all=全部（渲染时按运营商从 localStorage 恢复）
};
const ANN_SAN_TAGS = new Set(["p", "br", "div", "span", "a", "img", "strong", "b", "em", "i", "u", "ul", "ol", "li", "table", "tr", "td", "th", "tbody", "thead", "h1", "h2", "h3", "h4", "blockquote"]);
const ANN_SAN_STYLE = new Set(["color", "background-color", "text-align", "vertical-align"]);
const ANN_SCOPE_KEY = () => "chinamnos_an_scope_" + currentCarrier;
const ANN_READ_KEY = () => "chinamnos_an_read_" + currentCarrier;

function annLoadScope() {
  try {
    const s = localStorage.getItem(ANN_SCOPE_KEY());
    if (s === "home" || s === "national" || s === "all") return s;
  } catch { /* 隐私模式等忽略 */ }
  return "home";
}

/* ── 公告搜索 / 全部展开 ── 交互与变更记录页同款（模式切换胶囊 + / 聚焦 + 搜索自动全开） */
let annQ = "";                 // 搜索词（小写）
let annQMode = "all";          // all=全文（标题+正文） | name=仅标题（全局记忆，跨运营商共享）
let annExpandAll = false;      // 「全部展开」开关
let annCollapseArmed = false;  // 搜索自动全开后点「全部收起」的压制位，词一变即失效
const ANN_QMODE_KEY = "chinamnos_an_qmode";
try { const _qm = localStorage.getItem(ANN_QMODE_KEY); if (_qm === "name" || _qm === "all") annQMode = _qm; } catch { /* */ }

function annEffOpen() { return annExpandAll || (!!annQ && !annCollapseArmed); }   // 生效展开态：手动全开 或 搜索中自动全开

function annSyncSearchMode() {
  const btn = document.querySelector('#annTabBody [data-ann="annQMode"]');
  if (!btn) return;
  btn.textContent = annQMode === "name" ? "仅标题" : "全文";
  btn.classList.toggle("name-mode", annQMode === "name");
  const inp = $("annSearch");
  if (inp) inp.placeholder = annQMode === "name" ? "搜索公告标题…" : "搜索标题/公告正文…";
  try { localStorage.setItem(ANN_QMODE_KEY, annQMode); } catch { /* */ }
}

function annSyncToggleBtn() {
  const btn = document.querySelector('#annTabBody [data-ann="annToggleAll"]');
  if (!btn) return;
  const open = annEffOpen();
  btn.innerHTML = icon(open ? "chevronsUp" : "chevronsDown") + "<span>全部" + (open ? "收起" : "展开") + "</span>";
}

/* 按当前范围过滤后的公告条目（与 annRenderBody 的 items 过滤同源，供列表局部重渲染复用） */
function annScopedItems() {
  const data = annState.data[currentCarrier];
  if (!data) return [];
  const prov = chProvName();
  const scope = annState.scope;
  return data.items.filter(a => {
    if (scope === "national") return !a.province;
    if (scope === "all") return true;
    return a.province === prov || !a.province; // home：本省 + 全国
  });
}

/* 独立于 loadJson：announce.json 承载红点判定，始终拉最新（loadJson 有会话内存缓存会掩盖更新） */
function annFetch(carrier) {
  return fetchTimeout(`./data/${carrier}/announce.json?v=` + Date.now(), { cache: "no-store" })
    .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(j => {
      if (j && j.v === 1 && j.ok && Array.isArray(j.items)) annState.data[carrier] = j;
      else delete annState.data[carrier];
      return j;
    });
}

function annUnread(carrier) {
  const d = annState.data[carrier];
  if (!d || !d.items.length) return false;
  let read = null;
  try { read = localStorage.getItem(ANN_READ_KEY()); } catch { /* */ }
  return d.items[0].id !== read;
}

function annUpdateDot() {
  const btn = navTabs && navTabs.nav ? navTabs.nav.querySelector('.nav-item[data-view="announce"]') : null;
  if (!btn) return;
  const unread = annUnread(currentCarrier);
  const dot = btn.querySelector(".ann-navdot");
  if (unread && !dot) {
    const el = document.createElement("span");
    el.className = "ann-navdot";
    btn.appendChild(el);
  } else if (!unread && dot) {
    dot.remove();
  }
}

/* 取数入口：有会话缓存直接复用（页面初始化/切运营商时由 annPrefetch 预热），进 tab 零等待 */
function annTabRefresh() {
  const c = currentCarrier;
  if (annState.data[c]) { annUpdateDot(); return Promise.resolve(); }
  if (!annState.loading[c]) {
    annState.loading[c] = annFetch(c)
      .catch(() => { /* 失败与文件缺失同样按「暂无公告源」渲染；此处清态以便下次进 tab 重试 */ })
      .then(() => { delete annState.loading[c]; annUpdateDot(); });
  }
  return annState.loading[c];
}
function annPrefetch() { return annTabRefresh(); }

function annRenderIfActive() {
  const el = $("view-announce");
  if (el && el.classList.contains("active")) annRenderBody();
}

function annSetScope(v) {
  if (v !== "home" && v !== "national" && v !== "all") return;
  annState.scope = v;
  try { localStorage.setItem(ANN_SCOPE_KEY(), v); } catch { /* */ }
  annRenderBody();
}

/* 正文白名单消毒（采集端 clean_html 之后的第二道防线）：
   模板内解析不执行脚本；非白名单标签用子节点原位替换（多层嵌套循环收集直至清完），
   再逐元素清洗属性——a/img 的 URL 校验协议，style 仅保留采集端同款四个属性 */
function annSanUrl(u) {
  const v = String(u || "").trim();
  if (/^https?:/i.test(v) || /^mailto:/i.test(v)) return v;
  if (/^(\/|\.\/|\.\.\/|#)/.test(v)) return v; // 相对路径兜底（采集端已补全官网域名）
  return "";
}
/* 正文内附件链接去重：源站正文常自带「附件名」链接段（与底部附件 chips 重复），
   剔除后统一由底部附件区展示；顺带清理附件行紧邻的纯空段，消除大段留白 */
function annStripAttachments(root, atts) {
  const norm = s => String(s || "").replace(/\s+/g, "").toLowerCase();
  const names = new Set((atts || []).map(t => norm(t.name)).filter(Boolean));
  if (!names.size) return;
  const emptyBlock = (el) => el && /^(p|div)$/i.test(el.tagName)
    && !el.textContent.trim() && !el.querySelector("img") && !el.querySelector("a");
  Array.from(root.querySelectorAll("a")).forEach(a => {
    if (!names.has(norm(a.textContent))) return;
    const block = a.closest("p, div, li, blockquote") || a.parentElement;
    a.remove();
    if (!block || block.textContent.trim() || block.querySelector("img")) return;
    let nxt = block.nextElementSibling, prv = block.previousElementSibling;
    block.remove();
    while (emptyBlock(nxt)) { const n2 = nxt.nextElementSibling; nxt.remove(); nxt = n2; }
    while (emptyBlock(prv)) { const p2 = prv.previousElementSibling; prv.remove(); prv = p2; }
  });
  /* 纯文本形态兜底：a 标签被清洗剥掉后只剩文件名文字的段落 */
  Array.from(root.querySelectorAll("p, div")).forEach(el => {
    if (el.children.length === 0 && names.has(norm(el.textContent))) el.remove();
  });
}

function annSanitize(html, atts) {
  if (!html) return "";
  const tpl = document.createElement("template");
  tpl.innerHTML = String(html);
  for (let guard = 0; guard < 20; guard++) {
    const bad = [];
    (function collect(p) {
      Array.from(p.children).forEach((el) => {
        if (!ANN_SAN_TAGS.has(el.tagName.toLowerCase())) bad.push(el);
        collect(el);
      });
    })(tpl.content);
    if (!bad.length) break;
    bad.forEach((el) => el.replaceWith(...el.childNodes));
  }
  tpl.content.querySelectorAll("*").forEach((el) => {
    const tag = el.tagName.toLowerCase();
    Array.from(el.attributes).forEach((at) => {
      const n = at.name.toLowerCase();
      if ((tag === "a" && n === "href") || (tag === "img" && n === "src")) {
        const u = annSanUrl(at.value);
        if (u) el.setAttribute(n, u); else el.removeAttribute(n);
      } else if (n === "style") {
        const keep = String(at.value).split(";").map(s => s.trim()).filter(s => {
          const i = s.indexOf(":");
          return i > 0 && ANN_SAN_STYLE.has(s.slice(0, i).trim().toLowerCase());
        }).join("; ");
        if (keep) el.setAttribute("style", keep); else el.removeAttribute("style");
      } else if (!((tag === "td" || tag === "th") && (n === "colspan" || n === "rowspan"))) {
        el.removeAttribute(n);
      }
    });
  });
  if (atts) annStripAttachments(tpl.content, atts);
  return tpl.innerHTML;
}

function annItemHTML(a, open) {
  const nat = !a.province;
  const date = String(a.date || ""); // 2026-10-12 完整显示（含年份，跨年公告不歧义）
  const att = (a.attachments || []).length;
  const isOpen = !!open || a.id === annDeepId;   // 搜索自动全开/手动全开/深链目标 → 渲染时直出展开态
  return `
  <div class="ann-item${isOpen ? " open" : ""}${a.id === annDeepId ? " deep-hit" : ""}" data-id="${esc(a.id || "")}">
    <div class="ann-row">
      <span class="ann-date">${esc(date || "--")}</span>
      <span class="ann-badge${nat ? " nat" : ""}">${nat ? "全国" : esc(a.province)}</span>
      <span class="ann-title" title="点击展开/收起正文">${esc(a.title || "（无标题）")}</span>
      ${att ? `<span class="ann-att">附件 ${att}</span>` : ""}
      <button type="button" class="btn ghost sm" data-ann="annShare" data-id="${esc(a.id || "")}" data-title="${esc(a.title || "")}" title="分享本条公告" style="padding:2px 8px">${icon("share")}</button>
      <span class="ann-chev">${icon("chevronDown")}</span>
    </div>
    ${isOpen ? annItemBodyHTML(a.id || "") : ""}
  </div>`;
}

/* 展开正文惰性构建：点开时才从 annState 取数渲染（全量直出数百条正文 DOM 太重）；
   附件 chips 与「官网原文」轻量链接同行（foot），正文内不再重复出现附件链接段 */
function annItemBodyHTML(id) {
  const data = annState.data[currentCarrier];
  const a = data && (data.items || []).find(x => x.id === id);
  if (!a) return "";
  const atts = Array.isArray(a.attachments) ? a.attachments : [];
  const hasContent = a.content && String(a.content).trim();
  const foot = (atts.length || a.pageUrl) ? `
  <div class="ann-foot">
    ${atts.length ? `<div class="ann-atts">${atts.map(t =>
      `<a class="ann-att-chip" href="${esc(t.url || "#")}" target="_blank" rel="noopener noreferrer">${icon("download")}${esc(t.name || "附件")}</a>`).join("")}</div>` : ""}
    ${a.pageUrl ? `<a class="ann-golink" href="${esc(a.pageUrl)}" target="_blank" rel="noopener noreferrer">官网原文 ${icon("external")}</a>` : ""}
  </div>` : "";
  return `
  <div class="ann-body">
    ${hasContent ? `<div class="ann-html">${annSanitize(a.content, atts)}</div>`
                 : `<div class="ann-miss">该公告正文需在官网查看（源站接口未开放正文抓取）${a.pageUrl ? ` · <a class="ann-miss-link" href="${esc(a.pageUrl)}" target="_blank" rel="noopener noreferrer">查看原文 ${icon("external")}</a>` : ""}</div>`}
    ${foot}
  </div>`;
}

function annRenderBody() {
  const body = $("annTabBody");
  if (!body) return;
  const data = annState.data[currentCarrier];
  const prov = chProvName();
  annState.scope = annLoadScope();
  const scope = annState.scope;
  const brand = (CARRIER_BRAND[currentCarrier] || {}).shortName || "";
  const segBtn = (v, label) =>
    `<button type="button" class="ann-seg-btn${scope === v ? " active" : ""}" data-ann="annScope" data-scope="${v}">${label}</button>`;
  const seg = segBtn("home", "本省·全国") + segBtn("national", "全国") + segBtn("all", "全部");
  const sub = scope === "home" ? `${esc(prov || "…")} · 本省与全国` : (scope === "national" ? "全国范围" : "全部省份");

  if (!data) {
    body.innerHTML = `
      <h1 class="page-title">运营公告</h1>
      <p class="page-sub">${esc(brand)}官方公告</p>
      <div class="ann-toolbar"><div class="ann-seg">${seg}</div></div>
      <div class="ann-empty">${icon("bell", "ann-empty-ic")}<div>该运营商暂无公告源</div>
        <button type="button" class="ann-retry" data-ann="annRetry">重新加载</button></div>`;
    return;
  }
  /* 本省过滤依赖 STATS 的省名解析；直链 #announce 时主动拉 STATS 并经 fillProvSelects → 补渲染 */
  if (scope === "home" && !prov) {
    body.innerHTML = `
      <h1 class="page-title">运营公告</h1>
      <p class="page-sub">${esc(brand)}官方公告</p>
      <div class="ann-toolbar"><div class="ann-seg">${seg}</div></div>
      <div class="empty" style="padding:40px;text-align:center">正在加载省份信息…</div>`;
    if (!annProvPending) {
      annProvPending = true;
      loadStats().then(s => {
        STATS = s;
        annProvPending = false;
        fillProvSelects();
      }).catch(() => {
        annProvPending = false;
        const b = $("annTabBody");
        if (b) b.innerHTML = '<div class="empty">省份列表加载失败，请刷新重试</div>';
      });
    }
    return;
  }

  const upd = data.updated
    ? new Date(data.updated).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "";
  annState.upd = upd;   // 供 annRenderList 更新计数行（列表局部重渲染不重建工具栏）

  body.innerHTML = `
    <h1 class="page-title">运营公告</h1>
    <p class="page-sub">${esc(brand)}官方公告 · ${sub}<span class="panel-sub">来自官网公开信息，自动采集整理</span></p>
    <div class="ann-toolbar">
      <div class="ann-seg">${seg}</div>
      <div class="search-wrap"><button type="button" class="search-mode-btn" data-ann="annQMode" title="切换搜索范围：全文（标题+正文） / 仅标题"></button><input type="search" id="annSearch" class="search-box" placeholder="搜索标题/公告正文…"><kbd class="search-kbd" title="按 / 快速聚焦">/</kbd></div>
      <button type="button" class="btn ghost" data-ann="annToggleAll" title="全部收起/展开"></button>
      <span class="ann-meta" id="annMeta"></span>
    </div>
    <div id="annList"></div>`;

  /* 搜索框：输入即时筛选（仅重渲染列表，工具栏不重建保焦点）；"/" 快捷键经 .view.active .search-box 通用生效 */
  const searchEl = $("annSearch");
  if (searchEl) {
    searchEl.value = annQ;
    searchEl.addEventListener("input", () => {
      annQ = searchEl.value.trim().toLowerCase();
      annCollapseArmed = false;   // 搜索词变化=新的搜索意图，自动全开重新生效
      annExpandAll = false;
      annRenderList(annScopedItems());
    });
  }
  annSyncSearchMode();
  annRenderList(annScopedItems());
  pendingAnnId = "";   // 已进入带数据的渲染，引导管线不再需要补渲染触发

  /* 进入 tab 即写已读（按最新一条），红点随之消除 */
  try { if (data.items[0] && data.items[0].id) localStorage.setItem(ANN_READ_KEY(), data.items[0].id); } catch { /* */ }
  annUpdateDot();
}

/* 公告列表局部渲染：scope 过滤 + 搜索筛选（标题/全文） + 展开态直出 + 深链展开应用。
   搜索输入/模式切换/全部展开收起时只重建 #annList，工具栏（含搜索框焦点）保持不动 */
function annRenderList(scopedItems) {
  const list = $("annList");
  if (!list) return;
  const q = annQ;
  const filtered = q ? scopedItems.filter(a => {
    if (annQMode === "name") return String(a.title || "").toLowerCase().includes(q);
    return (String(a.title || "") + "\n" + String(a.content || "")).toLowerCase().includes(q);
  }) : scopedItems;
  const effOpen = annEffOpen();
  list.innerHTML = filtered.length
    ? `<div class="ann-list">${filtered.map(a => annItemHTML(a, effOpen)).join("")}</div>`
    : `<div class="ann-empty">${icon("bell", "ann-empty-ic")}<div>${q
        ? `没有匹配的公告${annQMode === "name" ? "（当前仅搜索标题，可切换全文）" : ""}`
        : (annState.scope === "home" ? "当前省份暂无公告" : "暂无公告")}</div></div>`;
  /* 展开态直出路径（搜索全开/全部展开/深链）的正文图片：与点击路径同样设置懒加载+去referrer+错误移除 */
  list.querySelectorAll(".ann-item.open img").forEach(im => {
    im.loading = "lazy";
    im.referrerPolicy = "no-referrer";
    im.addEventListener("error", () => im.remove(), { once: true });
  });
  const meta = $("annMeta");
  if (meta) {
    meta.textContent = q ? `匹配 ${filtered.length}/${scopedItems.length} 条 · 更新于 ${annState.upd || ""}`
                         : `共 ${scopedItems.length} 条 · 更新于 ${annState.upd || ""}`;
  }
  annSyncToggleBtn();
  annApplyDeepTarget(list);
}

/* 公告深链展开（跨重渲染持久）：
   ▸ 命中：确保展开（搜索/全收起等状态变化后重渲染也保持），首次命中滚动+高亮一次
   ▸ 未命中且目标不在当前范围（如外省公告被「本省·全国」过滤）：自动切「全部」重渲染，深链必达
   ▸ 范围放开仍无此 id（已失效/被搜索过滤/切运营商）：清态交还控制权 */
function annApplyDeepTarget(list) {
  if (!annDeepId) return;
  const el = list.querySelector(`.ann-item[data-id="${annDeepId.replace(/"/g, "")}"]`);
  if (el) {
    if (!el.classList.contains("open")) el.click();   // 整行点击=展开（惰性构建正文）
    if (!annDeepScrolled) {
      setTimeout(() => el.scrollIntoView({ behavior: "smooth", block: "center" }), 120);
      annDeepScrolled = true;
    }
    return;
  }
  if (!annDeepScrolled && annState.scope !== "all" && !annQ && currentCarrier === annDeepCarrier) {
    annState.scope = "all";
    try { localStorage.setItem(ANN_SCOPE_KEY(), "all"); } catch { /* */ }
    document.querySelectorAll('#annTabBody .ann-seg-btn').forEach(b => b.classList.toggle("active", b.dataset.scope === "all"));
    const sub = document.querySelector("#annTabBody .page-sub");
    if (sub) sub.innerHTML = `${esc((CARRIER_BRAND[currentCarrier] || {}).shortName || "")}官方公告 · 全部省份<span class="panel-sub">来自官网公开信息，自动采集整理</span>`;
    annRenderList(annScopedItems());
    return;
  }
  annDeepId = "";
  annDeepScrolled = false;
}

function annOnBodyClick(e) {
  const scopeBtn = e.target.closest('[data-ann="annScope"]');
  if (scopeBtn) { annSetScope(scopeBtn.dataset.scope); return; }
  /* 搜索模式切换：全文 ↔ 仅标题（与变更记录/资费搜索同款交互） */
  const qmodeBtn = e.target.closest('[data-ann="annQMode"]');
  if (qmodeBtn) {
    annQMode = annQMode === "name" ? "all" : "name";
    annSyncSearchMode();
    if (annQ) annRenderList(annScopedItems());   // 有关键词才需重筛，无则仅切模式
    return;
  }
  /* 全部展开/收起：搜索中自动全开视为「当前全开」→ 点击执行收起并压制（词一变即失效） */
  const toggleBtn = e.target.closest('[data-ann="annToggleAll"]');
  if (toggleBtn) {
    if (annEffOpen()) { annExpandAll = false; annCollapseArmed = !!annQ; }
    else { annExpandAll = true; annCollapseArmed = false; }
    annRenderList(annScopedItems());
    return;
  }
  if (e.target.closest('[data-ann="annRetry"]')) {
    delete annState.data[currentCarrier];
    const body = $("annTabBody");
    if (body) body.innerHTML = '<div class="empty" style="padding:40px;text-align:center">加载中…</div>';
    annTabRefresh().then(annRenderBody);
    return;
  }
  /* 附件/官网原文为外链，放行默认行为；分享按钮不触发行展开；标题与整行点击均为展开/收起 */
  const shareBtn = e.target.closest('[data-ann="annShare"]');
  if (shareBtn) {
    shareLink({ title: shareBtn.dataset.title || "运营公告", text: "运营商官方公告", hash: "ann_" + currentCarrier + "_" + encodeURIComponent(shareBtn.dataset.id || "") });
    return;
  }
  if (e.target.closest(".ann-att-chip") || e.target.closest(".ann-golink")) return;
  const row = e.target.closest(".ann-row");
  if (!row) return;
  const item = row.closest(".ann-item");
  if (!item) return;
  /* 用户手动点按公告行 = 接管展开控制权：清深链目标与全开态（搜索中则压制自动全开），
     仅影响后续重渲染，当前 DOM 其他条目的展开状态保持不动 */
  if (annDeepId || annExpandAll || annQ) {
    annDeepId = "";
    annDeepScrolled = false;
    annExpandAll = false;
    annCollapseArmed = !!annQ;
  }
  if (!item.querySelector(".ann-body")) { // 惰性构建一次，反复开合复用（防重复插入多份正文）
    const html = annItemBodyHTML(item.dataset.id || "");
    if (!html) { item.remove(); return; } // 数据已不在（切运营商等）→ 移除空壳
    item.insertAdjacentHTML("beforeend", html);
    item.querySelectorAll("img").forEach(im => {
      im.loading = "lazy";
      im.referrerPolicy = "no-referrer";
      im.addEventListener("error", () => im.remove(), { once: true });
    });
  }
  item.classList.toggle("open");
}

/* ─────────────── 页面注册 ─────────────── */
Shell.registerPage({
  id: "tariff",
  route: "/",
  onEnter: async function(root) {
    await ensureStylesheet(Shell.config.base + "modules/tariff/style.css?v=20261025a");
    root.innerHTML = `
<div id="tariffRoot">
<header class="topbar">
  <div class="topbar-left">
    <button class="icon-btn hamburger" id="hamburgerBtn" aria-label="菜单"><i data-icon="menu"></i></button>
    <div class="brand">
      <div class="brand-logo" id="logoIcon">移</div>
      <div class="brand-text" id="logoText">中国移动资费监控</div>
    </div>
  </div>
  <div class="topbar-mid">
    <div class="seg carrier-switch" id="carrierSwitch">
      <button type="button" class="seg-btn active" data-carrier="cmcc">移动</button>
      <button type="button" class="seg-btn" data-carrier="cucc">联通</button>
      <button type="button" class="seg-btn" data-carrier="ctcc">电信</button>
      <button type="button" class="seg-btn" data-carrier="cbn">广电</button>
    </div>
    <div id="gProv" class="topbar-prov"></div>
    <a class="official-link magnetic" id="officialLink" href="https://www.10086.cn/" target="_blank" rel="noopener noreferrer" title="中国移动 · 湖南 网上营业厅"><i data-icon="external"></i><span>去官网</span></a>
  </div>
  <div class="topbar-status">
    <div class="status-pill"><span class="status-dot" id="healthDot"></span><span id="healthText">加载中…</span></div>
    <div class="status-pill">更新: <strong id="updateTime">-</strong></div>
    <div class="status-pill" id="healthMetaPill"><span id="healthMeta"></span></div>
  </div>
  <div class="topbar-actions">
    <div id="appsMenuSlot"></div>
    <button class="icon-btn magnetic" id="pageShareBtn" title="分享当前页面（复制链接或唤起系统分享）"><i data-icon="share"></i></button>
    <button class="icon-btn magnetic" id="themeBtn" title="切换主题"></button>
    <div id="tariffAuthSlot"></div>
    <button class="btn primary magnetic" id="refreshBtn" title="检测资费变化"><i data-icon="refresh"></i><span class="btn-txt">检测</span></button>
  </div>
</header>

<div class="layout">
  <div class="sidebar-overlay" id="sidebarOverlay"></div>
  <nav class="sidebar" id="sidebar">
    <div class="sidebar-head"><span>导航</span><button class="icon-btn" id="sidebarClose"><i data-icon="x"></i></button></div>
    <div id="mainNav">
      <button type="button" class="nav-item active" data-view="overview"><div class="nav-icon"><i data-icon="chart"></i></div><span>数据总览</span></button>
      <button type="button" class="nav-item" data-view="changelog"><div class="nav-icon"><i data-icon="list"></i></div><span>变更日志</span></button>
      <button type="button" class="nav-item" data-view="monitor"><div class="nav-icon"><i data-icon="radar"></i></div><span>采集监控</span></button>
      <div class="sidebar-divider"></div>
      <button type="button" class="nav-item" data-view="compare"><div class="nav-icon"><i data-icon="scale"></i></div><span>资费对比</span></button>
      <button type="button" class="nav-item" data-view="favs"><div class="nav-icon"><i data-icon="star"></i></div><span>我的收藏</span></button>
      <div class="sidebar-divider"></div>
      <button type="button" class="nav-item" data-view="cardhub" hidden><div class="nav-icon"><i data-icon="box"></i></div><span>跳蚤市集</span></button>
      <button type="button" class="nav-item" data-view="acts"><div class="nav-icon"><i data-icon="trendingUp"></i></div><span>情报酒馆</span></button>
      <button type="button" class="nav-item" data-view="about"><div class="nav-icon"><i data-icon="info"></i></div><span>关于</span></button>
    </div>
  </nav>

  <main class="content">
    <section id="view-overview" class="view active">
      <h1 class="page-title">数据总览</h1>
      <p class="page-sub">实时监控全国及各省资费套餐变化</p>
      <div class="stat-grid" id="ovStatsRow">
        <div class="stat-card tilt rise" style="--i:0" title="跨省按方案编号去重（无编号回退名称）：全国方案跨省同码只计一次；同名不同编码为不同方案分别计数"><div class="stat-info"><div class="stat-label">全网资费总量（去重）</div><div class="stat-value accent"><num-ticker id="stNational">-</num-ticker></div></div><div class="stat-icon total">${icon("package")}</div></div>
        <div class="stat-card tilt rise" style="--i:1;cursor:pointer" data-act="statTodayAdd" title="点击查看各省份新增分布"><div class="stat-info"><div class="stat-label">今日新增</div><div class="stat-value green"><num-ticker id="stTodayAdd">-</num-ticker></div></div><div class="stat-icon added">${icon("plusCircle")}</div></div>
        <div class="stat-card tilt rise" style="--i:2;cursor:pointer" data-act="statTodayRm" title="点击查看各省份下架分布"><div class="stat-info"><div class="stat-label">今日下架</div><div class="stat-value red"><num-ticker id="stTodayRm">-</num-ticker></div></div><div class="stat-icon removed">${icon("minusCircle")}</div></div>
      </div>
      <div class="stat-grid" id="provStatsRow"></div>
      <div class="panel">
        <h2 class="panel-title">省份资费热力图 <span class="panel-sub">点击查看省份详情</span></h2>
        <div class="heatmap" id="heatmap"></div>
        <div class="heatmap-legend">
          <span class="legend-label">少</span>
          <span class="legend-bar"></span>
          <span class="legend-label">多</span>
        </div>
      </div>
      <div class="panel">
        <h2 class="panel-title">分类分布
          <span class="panel-sub" id="distDesc"></span>
        </h2>
        <div class="bars" id="distBars"></div>
      </div>
      <div class="ov-duo">
        <div class="panel">
          <h2 class="panel-title">${icon("trophy", "title-ic")} 各省资费排行 Top6 <span class="panel-sub">点击跳转省份</span></h2>
          <div class="rank-list" id="rankList"><div class="loading">加载中…</div></div>
        </div>
        <div class="panel">
          <h2 class="panel-title">${icon("coins", "title-ic")} 价格区间分布 <span class="panel-sub" id="priceDesc"></span></h2>
          <div class="price-hist" id="priceHist"><div class="loading">加载中…</div></div>
        </div>
      </div>
    </section>

    <div id="dynamicViews"></div>

    <section id="view-changelog" class="view">
      <h1 class="page-title">变更日志</h1>
      <p class="page-sub">资费套餐增删改时间线</p>
      <div class="toolbar htl">
        <div class="search-wrap"><button type="button" class="search-mode-btn" id="cQMode" title="切换搜索范围：全部内容（名称+字段） / 仅名称">全部</button><input type="search" id="cSearch" class="search-box" placeholder="搜索名称/资费标准/说明…"><kbd class="search-kbd" title="按 / 快速聚焦">/</kbd></div>
        <select id="cType" class="sel" style="width:auto"><option value="">全部变更</option><option value="added">新增</option><option value="removed">下架</option><option value="changed">变更</option></select>
        <select id="cT1" class="sel" style="width:auto"><option value="">全部归属</option></select>
        <select id="cT2" class="sel" style="width:auto"><option value="">全部类型</option></select>
        <button type="button" class="btn ghost" id="clToggleAll" title="全部收起/展开">${icon("chevronsDown")}<span>全部展开</span></button>
      </div>
      <div id="clMetaBar" class="cl-meta-bar">
        <div id="clStats" class="cl-stats"></div>
        <div id="clAttrTabs" class="cl-attr-tabs" hidden></div>
      </div>
      <div id="changelogBox"><div class="loading">选择省份后加载变更记录…</div></div>
    </section>

    <section id="view-announce" class="view">
      <div id="annTabBody"><div class="empty" style="padding:40px;text-align:center">加载中…</div></div>
    </section>

    <section id="view-monitor" class="view">
      <h1 class="page-title">采集监控</h1>
      <p class="page-sub">各省数据采集状态与统计 <span class="panel-sub" id="monitorMeta"></span></p>
      <div class="monitor-summary" id="monitorSummary"></div>
      <div class="panel" style="margin-top:16px">
        <h2 class="panel-title">各省采集详情</h2>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>省份</th><th>状态</th><th>资费数</th><th>全网</th><th>其他</th><th>今日增</th><th>今日减</th><th>今日改</th><th>采集时间</th></tr></thead>
            <tbody id="monitorBody"></tbody>
          </table>
        </div>
      </div>
      <div class="panel" style="margin-top:16px">
        <h2 class="panel-title">采集诊断</h2>
        <div class="diagnostics-summary" id="diagnosticsSummary"></div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>省份</th><th>分类</th><th>页数</th><th>实抓条数</th><th>重试次数</th><th>耗时(ms)</th><th>状态</th><th>失败原因</th></tr></thead>
            <tbody id="diagnosticsBody"></tbody>
          </table>
        </div>
      </div>
    </section>

    <section id="view-acts" class="view">
      <div id="actTabBody"><div class="empty" style="padding:40px;text-align:center">加载中…</div></div>
    </section>
    <section id="view-compare" class="view"></section>
    <section id="view-favs" class="view"></section>
    <section id="view-chat" class="view">
      <div id="chatTabBody"><div class="empty" style="padding:40px;text-align:center">加载中…</div></div>
    </section>
    <section id="view-cardhub" class="view">
      <div id="chTabBody"><div class="empty" style="padding:40px;text-align:center">加载中…</div></div>
    </section>
    <section id="view-notices" class="view">
      <h1 class="page-title">公告推广</h1>
      <p class="page-sub">站点公告 · 活动推广（弹窗内容随时可回看）</p>

      <div class="panel">
        <div class="about-text">
          <h3>${icon("bell", "title-ic")} 站点公告</h3>
          <div id="ntcNoticeBody"><div class="empty" style="padding:16px;text-align:center">加载中…</div></div>
        </div>
      </div>

      <div class="panel" style="margin-top:16px">
        <div class="about-text">
          <h3>${icon("info", "title-ic")} 推广</h3>
          <div id="ntcPromoChips" style="margin:6px 0 4px;display:flex;gap:8px"></div>
          <div id="ntcPromosBody"><div class="empty" style="padding:16px;text-align:center">加载中…</div></div>
        </div>
      </div>
    </section>
    <section id="view-about" class="view">
      <h1 class="page-title">关于本站</h1>
      <p class="page-sub">站点简介 · 数据说明 · 项目历程
        <button type="button" class="btn ghost sm" onclick="window.__cmnosShareSite && window.__cmnosShareSite()" title="复制站点链接或唤起系统分享" style="margin-left:10px;vertical-align:middle"><i data-icon="share"></i>分享本站</button>
      </p>

      <div class="panel" id="aboutTlPanel" hidden>
        <div class="about-text">
          <h3>${icon("clock", "title-ic")} 项目历程</h3>
          <div class="tl" id="aboutTl"><div class="tl-track"></div></div>
        </div>
      </div>

      <div class="panel" style="margin-top:16px">
        <div class="about-text">
          <h3>${icon("info", "title-ic")} 站点简介</h3>
          <p class="about-lead">ChinaMNOs 为方便<b>号卡爱好者</b>搭建参考站点，依托自动化程序采集<b>中国移动、中国联通、中国电信、中国广电</b>四大运营商官网公开资费数据，提供全国及分省资费项目的<b>检索、对比与资费变动追踪</b>；平台在此基础上配套<b>号卡信息发布、活动聚合、觅珍集库</b>等基础能力。</p>
          <div class="about-notice">${icon("info")}<span><b>平台定位：</b>ChinaMNOs 定位为资费信息公开平台，无意发展为大型交流论坛，因此将永久不开放论坛社区、用户发帖、交友互动类功能。</span></div>
          <ul>
            <li><b>资费监控：</b>全网及分省套餐的快照展示与变更日志，附采集监控与运行诊断</li>
            <li><b>跳蚤市集：</b>用户发布的求购、出让、出租、求租信息，先审后发，支持站内沟通与联系方式可见性分级</li>
            <li><b>情报酒馆：</b>官方活动推广与个人攻略发布，用户投稿、管理组审核后公开展示</li>
            <li><b>觅珍集库：</b>用户提交、经审核上架的实用工具与好站点导航</li>
            <li><b>工单系统：</b>用户与管理组之间的正式沟通渠道</li>
          </ul>
        </div>
      </div>

      <div class="panel" style="margin-top:16px">
        <div class="about-text">
          <h3>${icon("radar", "title-ic")} 数据说明</h3>
          <ul>
            <li><b>数据来源：</b>各运营商官方网站公开的资费信息，由自动化程序定期采集</li>
            <li><b>变更追踪：</b>记录单条资费粒度的历史变更，涵盖新增、下架与字段修改</li>
            <li><b>采集监控：</b>提供每次采集的覆盖范围、抓取量、耗时与失败原因等诊断信息</li>
          </ul>
          <p class="hint" style="margin-top:10px"><b>免责声明：</b>本站所载数据均来源于公开渠道的自动化采集，仅作整理与展示之用，可能存在延迟、遗漏或偏差，本站不对其准确性、完整性与时效性作出任何保证。跳蚤市集信息由用户自行发布，本站仅提供信息展示与沟通渠道，不参与任何实际交易环节。办理任何业务请以运营商官方渠道（营业厅、客户端、官方网站）公布的信息为准，由此产生的交易行为请用户自行审慎甄别风险。</p>
        </div>
      </div>

      <div class="panel" style="margin-top:16px" id="aboutThanksPanel" hidden>
        <div class="about-text">
          <h3>${icon("coins", "title-ic")} 鸣谢名单</h3>
          <div id="aboutThanks"></div>
        </div>
      </div>

      <div class="panel" style="margin-top:16px" id="aboutLinksPanel" hidden>
        <div class="about-text">
          <h3>${icon("external", "title-ic")} 友情链接</h3>
          <div id="aboutLinks"></div>
        </div>
      </div>

      <p class="hint" style="text-align:right;opacity:.55;font-size:12px;margin:14px 0 0">前端版本 v${TARIFF_VER}</p>
    </section>
  </main>
</div>

<footer class="foot">ChinaMNOs · 数据来自公开渠道自动采集 · 仅供学习参考 · 不为准确性负责 · 办理业务以运营商官方信息为准</footer>

<dialog class="modal" id="modalDlg">
  <div class="modal-head"><span id="modalTitle">提示</span><button class="modal-close" id="modalClose">×</button></div>
  <div class="modal-body" id="modalBody"></div>
  <div class="modal-foot"><span class="modal-foot-extra" id="modalFootExtra"></span><button class="btn primary" id="modalOk">知道了</button></div>
</dialog>

<div class="loading-overlay" id="dataLoading">
  <div class="loading-spinner"><span class="loading-core">资</span></div>
  <div class="loading-text">数据加载中…</div>
  <div class="loading-dots" aria-hidden="true"><span></span><span></span><span></span></div>
</div>
</div>
`;
    mountIcons(document.getElementById("tariffRoot"));
    initFX(document.getElementById("tariffRoot"));
    mountAuth(document.getElementById("tariffAuthSlot"));
    mountAppsMenu($("appsMenuSlot"), "tariff");
    /* 顶栏页面级分享按钮：按当前页签+运营商+省份拼深链（见 shareCurrentView） */
    const psb = $("pageShareBtn");
    if (psb) psb.addEventListener("click", shareCurrentView);

    /* 幂等注册：onEnter 在特定路由时序下可能连续执行，
       先摘除旧监听再挂新监听，确保 document 上始终只有一个 */
    if (_rootClickHandler) document.removeEventListener("click", _rootClickHandler);
    _rootClickHandler = onRootClick;
    document.addEventListener("click", _rootClickHandler);
    if (_rootKeyHandler) document.removeEventListener("keydown", _rootKeyHandler);
    _rootKeyHandler = onRootKeydown;
    document.addEventListener("keydown", _rootKeyHandler);

    initTariff();
  },
  onExit: function(root) {
    if (_rootClickHandler) {
      document.removeEventListener("click", _rootClickHandler);
      _rootClickHandler = null;
    }
    if (_rootKeyHandler) {
      document.removeEventListener("keydown", _rootKeyHandler);
      _rootKeyHandler = null;
    }
    const tip = document.getElementById("provTip");
    if (tip) tip.remove();
    if (navTabs) { navTabs.destroy(); navTabs = null; }
    root.innerHTML = "";
    _noticesViewRendered = false;   // 公告推广一次性渲染守卫随页面销毁复位：否则跨页面再进（含 notices_ 深链）不渲染
    STATS = null;
    Object.keys(TAB_SHOWN).forEach(function(k) { delete TAB_SHOWN[k]; });
    Object.keys(listState).forEach(function(k) { delete listState[k]; });
    Object.keys(clPageState).forEach(function(k) { delete clPageState[k]; });
    clQ = "";
    clQMode = "all";
    clAttr = "";
    clAttrPresence = [];
    clExpandAll = false;
    clCollapseArmed = false;
    clForceCollapse = false;
    ATTR_MAP = {};
    TYPE1_MAP = {};
    TYPE2_MAP = {};
    pendingTab = null;
    deepLinkLoading = false;   // 深链遮罩随页面 DOM 销毁；复位持有标志，防止残留拦截下次进入的 hideLoading
  }
});

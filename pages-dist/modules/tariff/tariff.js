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

import { Shell, esc, fetchTimeout, theme } from "../../shell/shell.js";
import { icon, mountIcons, Tabs, initFX } from "../../shell/ui.js";

const $ = (id) => document.getElementById(id);
const cache = {};

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
function areaFallback(p) {
  return AREA_CODE_MAP[p] || p;
}
function areaCn(v) {
  if (v == null) return v;
  v = String(v).trim();
  if (!v) return v;
  if (/^0{2,4}$/.test(v)) return "全国";
  if (/^[\d,，、\s]+$/.test(v)) {
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

function switchCarrier(carrier) {
  if (!ACTIVE_CARRIERS.includes(carrier) || carrier === currentCarrier) return;
  currentCarrier = carrier;
  try { localStorage.setItem(CARRIER_STORAGE_KEY, carrier); } catch {}
  const brand = CARRIER_BRAND[carrier];

  const logoIcon = $("logoIcon");
  const logoText = $("logoText");
  if (logoIcon) logoIcon.textContent = brand.icon;
  if (logoText) logoText.textContent = brand.name + "资费监控";
  document.title = brand.name + "资费监控 · v4 — ChinaMNOs";

  applyBrandVars(brand);

  document.querySelectorAll(".carrier-btn, .carrier-switch .seg-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.carrier === carrier);
  });

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
  setStat("stTotal", "-");
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
  if (provEl) provEl.innerHTML = "";
  $("changelogBox").innerHTML = '<div class="loading">选择省份后加载变更记录…</div>';
  $("monitorSummary").innerHTML = "";
  $("monitorBody").innerHTML = "";
  $("monitorMeta").textContent = "";
  $("diagnosticsSummary").innerHTML = "";
  $("diagnosticsBody").innerHTML = "";

  cacheTTL = DEFAULT_TTL;

  goTab("overview");
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

function showLoading(text) {
  const el = $("dataLoading");
  if (!el) return;
  if (text) { const t = el.querySelector(".loading-text"); if (t) t.textContent = text; }
  el.classList.add("show");
}
function hideLoading() {
  const el = $("dataLoading");
  if (el) el.classList.remove("show");
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
function fetchNoCache(path) {
  const url = path === "stats.json" ? "./data/stats.json" : `./data/${currentCarrier}/` + path.replace(/^\//, "");
  return fetchTimeout(url, {cache: "no-store"})
    .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(j => {
      cache[cacheKeyFor(path)] = j;
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
      category_maps: cm,
      all_carriers: raw.carriers ? Object.keys(raw.carriers) : [],
    };
  });
}

function loadSnapshot(code) {
  return loadJson(`snapshots/snapshot_${code}.json`);
}

function loadChangelog(code) {
  return loadJson(`changelogs/changelog_${code}.json`);
}

function fmt(n) { return (n === undefined || n === null) ? "-" : n.toLocaleString("zh-CN"); }
function fmtTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN");
}
function fmtDur(ms) { if (!ms) return "-"; if (ms < 1000) return ms + "ms"; return (ms / 1000).toFixed(1) + "s"; }
function fmtCountdown(iso) {
  if (!iso) return "";
  const diff = new Date(iso) - Date.now();
  if (diff <= 0) return "即将采集";
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return h > 0 ? `${h}h${m}m后` : `${m}m后`;
}

function provName(code) { return PROV_BY_CODE[code] || code; }

function fillProvSelects() {
  const provs = STATS && STATS.provinces ? STATS.provinces : [];
  const opts = provs.map(p => `<option value="${esc(p.code)}">${esc(p.name)}</option>`).join("");
  const defCode = STATS && STATS.default_province ? STATS.default_province : "hun";
  let mem = "";
  try { mem = localStorage.getItem(PROV_KEY()) || ""; } catch {}

  const el = $("gProv");
  if (el) {
    el.innerHTML = opts;
    el.value = provs.some(p => p.code === mem) ? mem : (provs.some(p => p.code === defCode) ? defCode : (provs.length > 0 ? provs[0].code : ""));
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
  document.querySelectorAll("#tariffRoot .view").forEach(x => x.classList.remove("active"));
  const viewEl = $("view-" + v);
  if (!viewEl) return;
  viewEl.classList.add("active");
  if (TAB_SHOWN[v]) return;
  TAB_SHOWN[v] = true;
  if (v === "overview") renderOverview();
  else if (v.startsWith("t1_")) renderList(v.slice(3));
  else if (v === "changelog") renderChangelog();
  else if (v === "monitor") renderMonitor();
}

function goProvince(code) {
  $("gProv").value = code;
  saveProvCode();
  renderDistBars();
  if (STATS) renderProvStatsRow(STATS);
  dynamicType1Keys.forEach(t1 => { listState[t1 + "_" + code] = null; });
  const target = dynamicType1Keys.includes("2") ? "t1_2" : (dynamicType1Keys[0] ? "t1_" + dynamicType1Keys[0] : "overview");
  goTab(target);
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

    fillProvSelects();
    buildDynamicTabs(s);
    const natTariffs = s.provinces.reduce((sum, p) => sum + (p.breakdown && p.breakdown["1"] ? p.breakdown["1"].tariffs : 0), 0);
    const allTariffs = s.provinces.reduce((sum, p) => sum + (p.total ? p.total.tariffs : 0), 0);
    const todayAdd = Object.values(s.today || {}).reduce((sum, c) => sum + (c && c.added ? c.added : 0), 0);
    const todayRm = Object.values(s.today || {}).reduce((sum, c) => sum + (c && c.removed ? c.removed : 0), 0);

    setStat("stNational", natTariffs);
    setStat("stTotal", allTariffs);
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
  const allTariffs = s.provinces.reduce((sum, x) => sum + (x.total ? x.total.tariffs : 0), 0);
  const pTariffs = p.total ? p.total.tariffs : 0;
  const pct = allTariffs > 0 ? ((pTariffs / allTariffs) * 100).toFixed(1) : "0";
  const pAdd = Object.values(p.today || {}).reduce((sum, c) => sum + (c && c.added ? c.added : 0), 0);
  const pRm = Object.values(p.today || {}).reduce((sum, c) => sum + (c && c.removed ? c.removed : 0), 0);
  const pChg = Object.values(p.today || {}).reduce((sum, c) => sum + (c && c.changed ? c.changed : 0), 0);
  const bdParts = [];
  Object.keys(p.breakdown || {}).forEach(attr => {
    const v = p.breakdown[attr];
    if (v && v.tariffs) bdParts.push(`${attrLabel(attr)} ${fmt(v.tariffs)}`);
  });
  const bdText = bdParts.length ? bdParts.join(" / ") : "-";
  el.innerHTML = `
    <div class="stat-card tilt"><div class="stat-info"><div class="stat-label">${esc(name)} 资费总数</div><div class="stat-value accent">${fmt(pTariffs)}<span style="font-size:13px;color:var(--sub);font-weight:400;margin-left:6px">占全国 ${pct}%</span></div></div><div class="stat-icon total">${icon("home")}</div></div>
    <div class="stat-card tilt"><div class="stat-info"><div class="stat-label">分类资费分布</div><div class="stat-value" style="font-size:17px">${esc(bdText)}</div></div><div class="stat-icon sum">${icon("chart")}</div></div>
    <div class="stat-card tilt"><div class="stat-info"><div class="stat-label">今日新增</div><div class="stat-value green">${fmt(pAdd)}</div></div><div class="stat-icon added">${icon("plusCircle")}</div></div>
    <div class="stat-card tilt"><div class="stat-info"><div class="stat-label">今日下架 / 变更</div><div class="stat-value" style="font-size:21px"><span style="color:var(--red)">${fmt(pRm)}</span> / <span style="color:var(--amber)">${fmt(pChg)}</span></div></div><div class="stat-icon removed">${icon("edit")}</div></div>
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
    const rows = groups[attr];
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

/* ─────────────── 各省排行 Top12 + 价格区间分布 ─────────────── */
function renderRankList(s) {
  const el = $("rankList");
  if (!el) return;
  const rows = (s.provinces || [])
    .map(p => ({ code: p.code, name: p.name, n: (p.total && p.total.tariffs) || 0 }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 12);
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
          <button type="button" class="sort-btn s-dir" data-sort="dir">降序 ↓</button>
        </div>
        <div class="filter-bar" id="${t1Id(code, "filterBar")}">
          <span class="filter-tit">筛选</span>
          <button type="button" class="filter-btn toggle-btn" id="${t1Id(code, "zeroBtn")}">零元</button>
          <button type="button" class="filter-btn toggle-btn" id="${t1Id(code, "favBtn")}">${icon("star")} 只看收藏</button>
          <span class="filter-label">价格</span>
          <input type="number" id="${t1Id(code, "priceMin")}" class="filter-input" placeholder="最低" min="0">
          <span class="filter-sep">~</span>
          <input type="number" id="${t1Id(code, "priceMax")}" class="filter-input" placeholder="最高" min="0">
          <span class="filter-label">上线</span>
          <input type="date" id="${t1Id(code, "dateFrom")}" class="filter-input date-input">
          <span class="filter-sep">~</span>
          <input type="date" id="${t1Id(code, "dateTo")}" class="filter-input date-input">
          <span class="filter-label">下线</span>
          <input type="date" id="${t1Id(code, "offFrom")}" class="filter-input date-input">
          <span class="filter-sep">~</span>
          <input type="date" id="${t1Id(code, "offTo")}" class="filter-input date-input">
          <button type="button" class="filter-btn clear-btn" id="${t1Id(code, "clearFilter")}">清除</button>
        </div>
        <div class="search-wrap"><input type="search" id="${t1Id(code, "search")}" class="search-box" placeholder="搜索名称/资费标准/说明…"><kbd class="search-kbd" title="按 / 快速聚焦">/</kbd></div>
        <select id="${t1Id(code, "attr")}" class="sel" style="width:auto"><option value="">全部归属</option></select>
        <select id="${t1Id(code, "type2")}" class="sel" style="width:auto"><option value="">全部类型</option></select>
        <button class="btn ghost" id="${t1Id(code, "exportCsv")}" title="导出当前筛选结果为 CSV">${icon("download")} 导出</button>
        <button class="btn ghost" id="${t1Id(code, "reload")}">重新加载</button>
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
  if (!listState[key]) listState[key] = {items: null, page: 1, q: "", attr: "", type2: "", sort: null, order: null, zeroOnly: false, favOnly: false, priceMin: null, priceMax: null, dateFrom: null, dateTo: null, offFrom: null, offTo: null, changeMap: null};
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
      else { s.sort = sort; s.order = sort === "price" ? 1 : -1; }
      s.page = 1;
      syncSortUI(sortBtn.closest(".sort-bar"), s);
      drawList(type1Code, c);
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
      toggleFavById(favBtn.dataset.favId);
      const on = isFav(favBtn.dataset.favId);
      favBtn.classList.toggle("on", on);
      favBtn.title = on ? "取消收藏" : "收藏";
      favBtn.innerHTML = icon(on ? "starFill" : "star");
      const s = getListState(type1Code + "_" + getProvCode());
      if (s.favOnly) drawList(type1Code, getProvCode());
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
      s.zeroOnly = false; s.favOnly = false; s.priceMin = null; s.priceMax = null; s.dateFrom = null; s.dateTo = null; s.offFrom = null; s.offTo = null;
      zeroBtn.classList.remove("active");
      if (favBtnEl) favBtnEl.classList.remove("active");
      priceMinEl.value = ""; priceMaxEl.value = ""; dateFromEl.value = ""; dateToEl.value = ""; offFromEl.value = ""; offToEl.value = "";
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

    // 分页
    const pageBtn = t.closest('.pager button[data-p]');
    if (pageBtn && section.contains(pageBtn)) {
      const s = getListState(type1Code + "_" + getProvCode());
      s.page += Number(pageBtn.dataset.p);
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

    // 条目展开/收起
    const head = t.closest(".item-head");
    if (head && section.contains(head)) {
      const d = head.closest(".item").querySelector(".detail");
      if (d) d.classList.toggle("open");
    }
  });
}

/* ─────────────── 收藏（localStorage: chinamnos_v2_favs）+ 导出 CSV ─────────────── */
const FAV_KEY = "chinamnos_v2_favs";
let FAVS = new Set();
function loadFavs() {
  FAVS = new Set();
  try {
    const raw = JSON.parse(localStorage.getItem(FAV_KEY) || "{}");
    const arr = raw[currentCarrier];
    if (Array.isArray(arr)) arr.forEach(id => FAVS.add(String(id)));
  } catch {}
}
function saveFavs() {
  try {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(FAV_KEY) || "null"); } catch {}
    if (!raw || typeof raw !== "object") raw = {};
    raw[currentCarrier] = Array.from(FAVS);
    localStorage.setItem(FAV_KEY, JSON.stringify(raw));
  } catch {}
}
function isFav(id) { return FAVS.has(String(id)); }
function toggleFavById(id) {
  const k = String(id);
  if (FAVS.has(k)) FAVS.delete(k); else FAVS.add(k);
  saveFavs();
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
    const p = priceOf(it);
    if (st.priceMin != null && p < st.priceMin) return false;
    if (st.priceMax != null && p > st.priceMax) return false;
    if (st.dateFrom || st.dateTo) {
      const d = dateOf(repFields(it)["上线日期"]);
      if (st.dateFrom && d < st.dateFrom) return false;
      if (st.dateTo && d > st.dateTo) return false;
    }
    if (st.offFrom || st.offTo) {
      const d = dateOf(repFields(it)["下线日期"]);
      if (st.offFrom && d < st.offFrom) return false;
      if (st.offTo && d > st.offTo) return false;
    }
    if (st.q) {
      const f = it.fields || {};
      const hay = (it.name + " " + Object.values(f).filter(v => v != null && v !== "").join(" ")).toLowerCase();
      if (!hay.includes(st.q)) return false;
    }
    return true;
  });
}

function repFields(it) {
  return it.fields || {};
}
function timeOf(it) {
  const s = repFields(it)["上线日期"] || "";
  if (s) { const m = s.match(/20\d{2}/); if (m) return new Date(+m[0], 0, 1).getTime(); }
  return 0;
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
  const raw = repFields(it)["资费标准"] || "";
  const m = String(raw).match(/\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : 0;
}
function isZeroFee(it) {
  const f = repFields(it);
  const raw = String(f["资费标准"] || "");
  if (/免费/.test(raw)) return true;
  const m = raw.match(/\d+(?:\.\d+)?/);
  return !!m && Math.abs(parseFloat(m[0])) < 1e-9;
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
    const av = st.sort === "price" ? priceOf(a) : timeOf(a);
    const bv = st.sort === "price" ? priceOf(b) : timeOf(b);
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
  if (d) d.textContent = (st.order == null ? -1 : st.order) < 0 ? "降序 ↓" : "升序 ↑";
}

function drawList(type1Code, code) {
  const st = getListState(type1Code + "_" + code);
  const listEl = $(t1Id(type1Code, "list"));
  const pagerEl = $(t1Id(type1Code, "pager"));
  const cntEl = $(t1Id(type1Code, "count"));
  const filtered = filterItems(st);
  if (st.zeroOnly) { filtered.sort((a, b) => zeroRank(a) - zeroRank(b)); }
  else if (st.sort) { sortFiltered(filtered, st); }
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  if (st.page > totalPages) st.page = totalPages;
  const start = (st.page - 1) * PAGE_SIZE;
  const pageItems = filtered.slice(start, start + PAGE_SIZE);
  cntEl.textContent = "共 " + fmt(filtered.length) + " 条";

  if (!pageItems.length) {
    listEl.innerHTML = '<div class="empty">没有匹配的资费条目</div>';
  } else {
    listEl.innerHTML = pageItems.map((it, i) => itemHtml(it, st.changeMap, i)).join("");
  }

  pagerEl.innerHTML =
    `<button ${st.page <= 1 ? "disabled" : ""} data-p="-1">上一页</button>` +
    `<span class="page-info">第 ${st.page} / ${totalPages} 页</span>` +
    `<button ${st.page >= totalPages ? "disabled" : ""} data-p="1">下一页</button>`;
}

function itemHtml(it, changeMap, idx) {
  const f = it.fields || {};
  const rf = repFields(it);
  const type1 = t1Label(it.type1);
  const attr = attrLabel(it.tariff_attr);
  const type2 = t2Label(it.type2);
  const price = rf["资费标准"] || "";
  const scope = rf["适用范围"] || "";
  const facts = [];
  if (scope) facts.push(`<span>适用：${esc(scope)}</span>`);
  if (rf["国内通话"]) facts.push(`<span>通话 <b>${esc(rf["国内通话"])}</b></span>`);
  if (rf["国内通用流量"]) facts.push(`<span>流量 <b>${esc(rf["国内通用流量"])}</b></span>`);
  if (rf["宽带"] && rf["宽带"] !== "无") facts.push(`<span>宽带 <b>${esc(rf["宽带"])}</b></span>`);

  const tags = [];
  const chType = changeMap && it.id ? changeMap[it.id] : null;
  if (chType === "added") tags.push(`<span class="tag chg-added">新增</span>`);
  else if (chType === "removed") tags.push(`<span class="tag chg-removed">下架</span>`);
  else if (chType === "changed") tags.push(`<span class="tag chg-changed">修改</span>`);
  if (type1) tags.push(`<span class="tag attr-${it.type1}">${esc(type1)}</span>`);
  if (type2) tags.push(`<span class="tag type-${it.type2}">${esc(type2)}</span>`);
  if (price) tags.push(`<span class="tag tag-price">${esc(price)}</span>`);

  const hasFields = Object.keys(f).some(k => f[k]);
  const fav = isFav(it.id);
  let html = `<div class="item" style="--i:${idx}"><div class="item-head"><span class="item-name">${esc(it.name)}</span>${tags.join("")}<button type="button" class="fav-btn${fav ? " on" : ""}" data-fav-id="${esc(it.id)}" title="${fav ? "取消收藏" : "收藏"}" aria-label="收藏">${icon(fav ? "starFill" : "star")}</button></div>`;
  if (facts.length) html += `<div class="item-facts">${facts.join("")}</div>`;
  if (hasFields) html += `<div class="detail"><div class="detail-inner"><div class="detail-inner-pad">${fieldsTable(f)}</div></div></div>`;

  html += "</div>";
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
const clPageState = {};

function renderChangelog() {
  const code = getProvCode();
  const typeFilter = $("cType") ? $("cType").value : "";
  const box = $("changelogBox");

  box.innerHTML = '<div class="loading">加载变更记录…</div>';
  Promise.all([loadChangelog(code), loadSnapshot(code).catch(() => null)]).then(([cl, snap]) => {
    let logs = cl.logs || [];
    if (typeFilter) logs = logs.filter(l => l.type === typeFilter);

    const itemMap = {};
    if (snap && snap.items) snap.items.forEach(it => { if (it.id) itemMap[it.id] = it; });

    if (!logs.length) {
      box.innerHTML = '<div class="empty">暂无变更记录</div>';
      return;
    }

    const CL_PAGE_SIZE = 50;
    const clKey = code + "_" + typeFilter;
    if (!clPageState[clKey]) clPageState[clKey] = 1;
    const clPage = clPageState[clKey];
    const display = logs.slice(0, CL_PAGE_SIZE * clPage);
    let html = '<div class="tl">';
    display.forEach((log, idx) => {
      const typeLabel = log.type === "added" ? "新增" : log.type === "removed" ? "下架" : "变更";
      const chipCls = log.type === "added" ? "add" : log.type === "removed" ? "del" : "mod";
      const aLbl = attrLabel(log.attr);
      const t1Lbl = t1Label(log.t1);
      const t2Lbl = t2Label(log.t2);
      const path = [aLbl, t1Lbl, t2Lbl].filter(Boolean).join(" · ");
      const title = log.name || "";

      html += `<div class="tl-item tl-${esc(log.type)}${idx === 0 ? " open" : ""}">`;
      html += `<div class="tl-head"><span class="tl-type-bar ${chipCls}"></span><div class="tl-time">${fmtTime(log.ts)}</div><span class="tl-arrow"></span></div>`;
      html += `<div class="tl-body"><div>`;
      html += `<div class="tl-body-pad">`;
      html += `<div class="tl-chips"><span class="chip ${chipCls}">${typeLabel}</span></div>`;
      html += `<div class="tl-title">${esc(title)}</div>`;
      if (path) html += `<div class="tl-path">${esc(path)}</div>`;
      html += `<div class="tl-id">ID: ${esc(log.id)}</div>`;

      const snapItem = itemMap[log.id];
      if (log.type === "added" && snapItem && snapItem.fields) {
        html += '<div class="tl-detail-title" style="color:var(--green)">新增业务详情：</div>';
        const flds = snapItem.fields;
        const fldKeys = Object.keys(flds).filter(k => flds[k]);
        if (fldKeys.length) {
          html += '<table class="sub-table">' + fldKeys.map(k => `<tr><th>${esc(k)}</th><td>${esc(k === "适用地区" ? areaCn(flds[k]) : flds[k])}</td></tr>`).join("") + "</table>";
        }
      } else if (log.type === "changed" && snapItem && snapItem.fields) {
        html += '<div class="tl-detail-title" style="color:var(--acc)">字段详情：</div>';
        const flds = snapItem.fields;
        const diffFields = log.diff ? Object.keys(log.diff) : [];
        const fldKeys = Object.keys(flds).filter(k => flds[k]);
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
          html += `<div class="diff-row"><span class="diff-field">${esc(field)}</span><span class="diff-old">${esc(norm(vals[0]))}</span><span class="diff-arrow">→</span><span class="diff-new">${esc(norm(vals[1]))}</span></div>`;
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

      html += "</div></div></div></div>";
    });
    html += "</div>";
    if (logs.length > CL_PAGE_SIZE * clPage) {
      html += '<div style="text-align:center;padding:12px"><button data-clkey="' + esc(clKey) + '" class="load-more-btn">加载更多（已显示 ' + display.length + ' / ' + logs.length + '）</button></div>';
    }
    box.innerHTML = html;
  }).catch(e => {
    box.innerHTML = '<div class="empty">变更记录加载失败：' + esc(e.message) + ' <button data-act="retryChangelog" class="btn sm soft">重试</button></div>';
  });
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
function openModal(title, html) {
  $("modalTitle").textContent = title;
  $("modalBody").innerHTML = html;
  $("modalDlg").showModal();
}
function closeModal() {
  const dlg = $("modalDlg");
  if (!dlg || !dlg.open) return;
  dlg.classList.add("modal-closing");
  setTimeout(() => { dlg.close(); dlg.classList.remove("modal-closing"); }, 180);
}

function initModal() {
  $("modalClose").addEventListener("click", closeModal);
  $("modalOk").addEventListener("click", closeModal);
  $("modalDlg").addEventListener("click", e => { if (e.target === $("modalDlg")) closeModal(); });
  $("modalDlg").addEventListener("cancel", e => { e.preventDefault(); closeModal(); });
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

function initProvListeners() {
  const el = $("gProv");
  if (!el) return;
  el.addEventListener("change", () => {
    saveProvCode();
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
  });
  if ($("cType")) $("cType").addEventListener("change", () => renderChangelog());
}

/* ─────────────── 检测资费变化 ─────────────── */
let checking = false;
const RK = () => `${currentCarrier}_v2_check`;
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
      let prev = null;
      try { prev = JSON.parse(localStorage.getItem(RK()) || "null"); } catch {}
      const snap = {updated: s.crawl_time};

      // 【检测变化的判断依据说明】
      // "检测变化"弹窗的新增/下架/变更数量，直接来自服务端 stats.json 中的 s.today 字段。
      // s.today 是服务端在采集时从 changelog 中筛选"今日 0 点以后"的变更记录，
      // 按分类统计 added/removed/changed 数量后写入 stats 的，属于服务端计算好的"今日累计变化"。
      // 因此此处无需在前端做快照数据对比，直接展示 s.today 即可。
      // 注意：下方 snap 和 prev 仅用于判断是否首次点击（建立基线提示），不参与变化数量对比。
      // 注意：若后续服务端 s.today 的计算逻辑或字段结构发生变化，此处代码需同步调整，注释仅供参考。
      const todayAdd = Object.values(s.today || {}).reduce((sum, c) => sum + (c && c.added ? c.added : 0), 0);
      const todayRm = Object.values(s.today || {}).reduce((sum, c) => sum + (c && c.removed ? c.removed : 0), 0);
      const todayChg = Object.values(s.today || {}).reduce((sum, c) => sum + (c && c.changed ? c.changed : 0), 0);

      if (!prev) {
        localStorage.setItem(RK(), JSON.stringify(snap));
        openModal("检测完成", `<div class="res-row">已建立首次检测基线。</div><div class="res-row sub">数据快照时间：${esc(updated)}</div>`);
      } else {
        const hasChange = todayAdd > 0 || todayRm > 0 || todayChg > 0;
        localStorage.setItem(RK(), JSON.stringify(snap));
        if (hasChange) {
          openModal("检测到资费变化",
            `<div class="res-row">今日新增 <b style="color:var(--green)">${todayAdd}</b> 条，下架 <b style="color:var(--red)">${todayRm}</b> 条，变更 <b style="color:var(--amber)">${todayChg}</b> 条</div>` +
            `<div class="res-row sub">快照时间：${esc(updated)}</div>`);
        } else {
          openModal("无变化", `<div class="res-row ok">暂未检测到资费变化。</div><div class="res-row sub">快照时间：${esc(updated)}</div>`);
        }
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
function onRootClick(e) {
  // 未采集省份提示自动消隐
  const tip = document.getElementById("provTip");
  if (tip && !e.target.closest(".heatmap-tile.inactive")) {
    tip.classList.remove("show");
  }

  const actEl = e.target.closest("[data-act]");
  if (actEl) {
    const a = actEl.dataset.act;
    if (a === "goConfig") { Shell.navigate("/config"); return; }
    if (a === "retryList") { renderList(actEl.dataset.arg); return; }
    if (a === "retryChangelog") { renderChangelog(); return; }
    if (a === "retryMonitor") { renderMonitor(); return; }
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

  // 变更日志：条目展开/收起
  const tlHead = e.target.closest(".tl-head");
  if (tlHead && $("tariffRoot") && $("tariffRoot").contains(tlHead)) {
    const item = tlHead.closest(".tl-item");
    if (item) item.classList.toggle("open");
    return;
  }

  // 变更日志：加载更多
  const clMore = e.target.closest(".load-more-btn");
  if (clMore && clMore.dataset.clkey) {
    clPageState[clMore.dataset.clkey] = (clPageState[clMore.dataset.clkey] || 1) + 1;
    renderChangelog();
    return;
  }

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

/** "/" 快捷键：聚焦当前页签的搜索框 */
function onRootKeydown(e) {
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
  $("refreshBtn").addEventListener("click", doCheck);

  navTabs = new Tabs($("mainNav"), onTabChange);

  if ($("clExpandAll")) $("clExpandAll").addEventListener("click", () => {
    document.querySelectorAll("#changelogBox .tl-item").forEach(el => el.classList.add("open"));
  });
  if ($("clCollapseAll")) $("clCollapseAll").addEventListener("click", () => {
    document.querySelectorAll("#changelogBox .tl-item").forEach(el => el.classList.remove("open"));
  });

  var raw = (location.hash || "").replace("#", "").trim();
  var staticTabs = ["overview","changelog","monitor","about"];
  if (staticTabs.includes(raw)) {
    goTab(raw);
  } else if (raw.startsWith("t1_")) {
    pendingTab = raw;
    goTab("overview");
  } else {
    goTab("overview");
  }
}

/* ─────────────── 页面注册 ─────────────── */
Shell.registerPage({
  id: "tariff",
  route: "/",
  onEnter: function(root) {
    if (!document.querySelector('link[data-module="tariff"]')) {
      var link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = Shell.config.base + "modules/tariff/style.css";
      link.setAttribute("data-module", "tariff");
      document.head.appendChild(link);
    }
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
    <select id="gProv" class="sel topbar-prov"></select>
  </div>
  <div class="topbar-status">
    <div class="status-pill"><span class="status-dot" id="healthDot"></span><span id="healthText">加载中…</span></div>
    <div class="status-pill">更新: <strong id="updateTime">-</strong></div>
    <div class="status-pill" id="healthMetaPill"><span id="healthMeta"></span></div>
  </div>
  <div class="topbar-actions">
    <a class="btn ghost magnetic" data-act="goConfig" href="javascript:void(0)" title="配置生成工具"><i data-icon="sliders"></i>配置</a>
    <button class="icon-btn magnetic" id="themeBtn" title="切换主题"></button>
    <button class="btn primary magnetic" id="refreshBtn" title="检测资费变化"><i data-icon="refresh"></i>检测</button>
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
      <button type="button" class="nav-item" data-view="about"><div class="nav-icon"><i data-icon="info"></i></div><span>关于</span></button>
    </div>
  </nav>

  <main class="content">
    <section id="view-overview" class="view active">
      <h1 class="page-title">数据总览</h1>
      <p class="page-sub">实时监控全国及各省资费套餐变化</p>
      <div class="stat-grid">
        <div class="stat-card tilt rise" style="--i:0"><div class="stat-info"><div class="stat-label">全网通用资费</div><div class="stat-value accent"><num-ticker id="stNational">-</num-ticker></div></div><div class="stat-icon total">${icon("package")}</div></div>
        <div class="stat-card tilt rise" style="--i:1"><div class="stat-info"><div class="stat-label">31省资费合计</div><div class="stat-value"><num-ticker id="stTotal">-</num-ticker></div></div><div class="stat-icon sum">${icon("globe")}</div></div>
        <div class="stat-card tilt rise" style="--i:2"><div class="stat-info"><div class="stat-label">今日新增</div><div class="stat-value green"><num-ticker id="stTodayAdd">-</num-ticker></div></div><div class="stat-icon added">${icon("plusCircle")}</div></div>
        <div class="stat-card tilt rise" style="--i:3"><div class="stat-info"><div class="stat-label">今日下架</div><div class="stat-value red"><num-ticker id="stTodayRm">-</num-ticker></div></div><div class="stat-icon removed">${icon("minusCircle")}</div></div>
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
          <h2 class="panel-title">${icon("trophy", "title-ic")} 各省资费排行 Top12 <span class="panel-sub">点击跳转省份</span></h2>
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
        <select id="cType" class="sel" style="width:auto"><option value="">全部变更</option><option value="added">新增</option><option value="removed">下架</option><option value="changed">变更</option></select>
        <button type="button" class="btn ghost" id="clExpandAll" title="展开全部记录">${icon("chevronsDown")} 全部展开</button>
        <button type="button" class="btn ghost" id="clCollapseAll" title="收起全部记录">${icon("chevronsUp")} 全部收起</button>
      </div>
      <div id="changelogBox"><div class="loading">选择省份后加载变更记录…</div></div>
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

    <section id="view-about" class="view">
      <h1 class="page-title">关于本站</h1>
      <p class="page-sub">数据来源与系统说明</p>
      <div class="panel">
        <div class="about-text">
          <p>本站展示中国移动/联通/电信/广电全网及各省公开资费数据，数据由自动监控程序定期采集官网并存入 Cloudflare R2 存储，通过 Worker API 发布为实时数据面板。</p>
          <ul>
            <li><b>数据版本：</b>v4 schema — 扁平化单条资费结构，39标准字段+extra拓展+extra_other兜底</li>
            <li><b>数据来源：</b>各运营商官网公开资费专区</li>
            <li><b>采集方式：</b>青龙面板定时任务 → 各运营商采集脚本 → R2 存储 → Worker API</li>
            <li><b>更新频率：</b>每日两次（08:00 / 20:00），可在配置中调整</li>
            <li><b>分类体系：</b>归属(个人/政企) × 范围(全网/本省) × 类型(套餐/加装包/营销活动/其他)</li>
            <li><b>变更追踪：</b>单条资费级变更记录，支持新增/下架/字段修改追踪</li>
            <li><b>免责声明：</b>展示内容可能存在延迟或误差，办理业务请以各运营商营业厅 / 官方信息为准</li>
          </ul>
        </div>
      </div>
      <div class="panel" style="margin-top:16px">
        <div class="about-text">
          <h3>${icon("sparkles", "title-ic")} 未来工作计划</h3>
          <ul>
            <li><b>Worker 缓存机制：</b>优化 Worker 响应速度，引入边缘缓存策略，减少 R2 读取频次</li>
            <li><b>官网跳转：</b>为每个资费套餐提供运营商官网办理入口，一键直达业务页面</li>
            <li><b>聚集地：</b>搭建用户社区，汇聚资费讨论、套餐推荐、省钱攻略</li>
            <li><b>资讯瀑布：</b>聚合运营商新闻、资费调整公告、行业动态，瀑布流实时呈现</li>
            <li><b>友情链接：</b>与同类资费监控、通信行业站点互换链接，共建生态</li>
            <li><b>友情站点：</b>推荐优质通信工具、号卡比价、携号转网等实用站点</li>
          </ul>
        </div>
      </div>
    </section>
  </main>
</div>

<footer class="foot">ChinaMNOs 资费监控 · 数据仅供个人学习参考</footer>

<dialog class="modal" id="modalDlg">
  <div class="modal-head"><span id="modalTitle">提示</span><button class="modal-close" id="modalClose">×</button></div>
  <div class="modal-body" id="modalBody"></div>
  <div class="modal-foot"><button class="btn primary" id="modalOk">知道了</button></div>
</dialog>

<div class="loading-overlay" id="dataLoading">
  <div class="loading-spinner"></div>
  <div class="loading-text">数据加载中…</div>
</div>
</div>
`;
    mountIcons(document.getElementById("tariffRoot"));
    initFX(document.getElementById("tariffRoot"));

    _rootClickHandler = onRootClick;
    document.addEventListener("click", _rootClickHandler);
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
    root.innerHTML = "";
    navTabs = null;
    STATS = null;
    Object.keys(TAB_SHOWN).forEach(function(k) { delete TAB_SHOWN[k]; });
    Object.keys(listState).forEach(function(k) { delete listState[k]; });
    Object.keys(clPageState).forEach(function(k) { delete clPageState[k]; });
    ATTR_MAP = {};
    TYPE1_MAP = {};
    TYPE2_MAP = {};
    pendingTab = null;
  }
});

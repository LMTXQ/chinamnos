/* ═══════════════════════════════════════════════════════════════
   资费对比 + 我的收藏 —— 资费监控页双视图（tariff.js 经桥接挂载）
   ───────────────────────────────────────────────────────────────
   ▸ 资费对比：选省 → 四运营商在售资费并排 → 勾选 2-6 条 → 字段明细
     对比表（差异行高亮，借鉴变更记录"仅看变化"模式）+ 粘贴导入
     （严格反向匹配【复制资费概要】summaryOf 格式，localStorage 持久化）
   ▸ 我的收藏：全量收藏（所有运营商×省份，不随顶栏切换），按需拉快照
     标注「在售/已下架」，卡片可加入对比 / 取消收藏
   ▸ 与 tariff.js 通过 initCompareBridge 桥接（当前省/运营商、跨运营商
     快照加载、收藏读写），compare.js 不反向 import tariff，无环依赖
   ═══════════════════════════════════════════════════════════════ */
"use strict";

import { esc, fetchTimeout } from "../../shell/shell.js";
import { icon, mountIcons, toast } from "../../shell/ui.js";
import { shareLink } from "../../shell/share.js";

/* ── 桥（tariff.js 注入） ── */
let CB = null;
export function initCompareBridge(bridge) {
  CB = bridge;
  loadSel();
  loadImports();
}

/* ── 常量 ── */
const CARRIER_ORDER = ["cmcc", "cucc", "ctcc", "cbn"];
const CARRIER_SHORT = { cmcc: "移动", cucc: "联通", ctcc: "电信", cbn: "广电" };   // chips 短名（省"中国"二字）
const MAIN_KEYS = ["资费标准", "方案编号", "资费类型", "归属", "适用范围", "适用地区", "上线日期", "下线日期", "有效期限"];
const NOTE_KEYS = ["其他说明", "超出资费说明", "其他服务内容", "在网要求", "退订方式", "违约责任", "权益", "销售渠道"];
const CMP_IMPORTS_KEY = "chinamnos_v2_compare_imports";
const CMP_SEL_KEY = "chinamnos_v2_compare_sel";
const CMP_CARRIERS_KEY = "chinamnos_v2_compare_carriers";
const CMP_MAX = 12;   // 明细对比列数上限（12 列横向滚动查看；手机端窄屏由明细层横向滚动兜底）

/* ── 状态 ── */
let cmpProv = "";          // 对比省（独立于顶栏；收藏模式下可为 "" = 全部）
let cmpSort = "time";      // 排序方式（time=最新上架 / price=按价格，同资费列表）
let cmpDir = -1;           // 方向（-1 降序 / 1 升序；time 固定降序，price 可切换）
let cmpCarriers = [];      // 用户所选运营商（默认空 = 未加载，手动「加载对比」生效）
let cmpQuery = "";         // 搜索词（在所选快照内过滤）
let cmpLoaded = false;     // 是否已执行过加载（区分"未加载提示"与"加载完成"）
try {
  const saved = JSON.parse(localStorage.getItem(CMP_CARRIERS_KEY) || "[]");
  if (Array.isArray(saved)) cmpCarriers = saved.filter(c => CARRIER_ORDER.includes(c));
} catch { /* */ }
function saveCarriers() { try { localStorage.setItem(CMP_CARRIERS_KEY, JSON.stringify(cmpCarriers)); } catch { /* */ } }
let selected = new Map();  // key → entry（持久化）
let imports = [];          // 导入条目（持久化）
let favStatus = new Map(); // favKey → "live" | "removed"（懒判定，会话级）
let favStatusTried = new Set();   // 已尝试判定的 (carrier|prov)
let cmpLayerOpen = false;  // 对比层展开态
let cmpZero = false;       // 零元业务筛选（仅显示免费/零元条目）
let cmpFavMode = false;    // 收藏虚拟快照模式（数据源=收藏按运营商拆桶；false=正常省快照）
let cmpSelMode = false;    // 已选虚拟快照模式（数据源=对比池已勾选条目按运营商拆桶+导入列；与收藏模式互斥）
let cmpImpMode = false;    // 导入虚拟快照模式（数据源=导入清单全集单列；与收藏/已选模式互斥）
let cmpProvSaved = "";     // 进入收藏模式前记住的省（退出恢复）
let favFilter = { c: "", prov: "", own: "", type: "" };   // 收藏页筛选（运营商/省/归属/资费类型）
let favQ = "";             // 收藏页搜索词（名称+全部字段）

/* entry = { key, kind: "live"|"import"|"fav", carrier, prov, id, name, fields } */

/* ── 持久化 ── */
function loadSel() {
  try {
    const arr = JSON.parse(localStorage.getItem(CMP_SEL_KEY) || "[]");
    if (Array.isArray(arr)) arr.forEach(e => { if (e && e.key) selected.set(e.key, e); });
  } catch { /* */ }
}
function saveSel() {
  try { localStorage.setItem(CMP_SEL_KEY, JSON.stringify([...selected.values()])); } catch { /* */ }
}
function loadImports() {
  try {
    const arr = JSON.parse(localStorage.getItem(CMP_IMPORTS_KEY) || "[]");
    if (Array.isArray(arr)) imports = arr.filter(e => e && e.name);
  } catch { imports = []; }
}
function saveImports() {
  try { localStorage.setItem(CMP_IMPORTS_KEY, JSON.stringify(imports)); } catch { /* */ }
}

/* ── 工具 ── */
const norm = (v) => String(v ?? "").replace(/\s+/g, "").toLowerCase();
function feeText(fields) {
  const raw = String((fields || {})["资费标准"] || "");
  const m = raw.match(/\d+(?:\.\d+)?/);
  return m ? m[0] + " 元/月" : (/免费/.test(raw) ? "免费" : "—");
}
function flowText(fields) {
  const raw = String((fields || {})["国内通用流量"] || "");
  return raw || "—";
}
function callText(fields) {
  const raw = String((fields || {})["国内通话"] || "");
  return raw || "—";
}
function priceNum(fields) {
  const raw = String((fields || {})["资费标准"] || "");
  const m = raw.match(/\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : (/免费/.test(raw) ? 0 : Infinity);
}
/* 零元判定（与资费列表 isZeroFee 同规则）：有明确正价格不算零元 */
function isZeroFeeF(fields) {
  const raw = String((fields || {})["资费标准"] || "");
  const m = raw.match(/\d+(?:\.\d+)?/);
  if (m && parseFloat(m[0]) >= 0.01) return false;
  return /免费/.test(raw) || (!!m && parseFloat(m[0]) < 1e-9);
}
/* 上线日期解析到日粒度（与资费列表 dateOf 同规则），供"最新上架"排序 */
function dateOfC(raw) {
  if (!raw) return "";
  const m = String(raw).match(/(\d{4})[年/\-.](\d{1,2})[月/\-.](\d{1,2})/);
  if (m) return m[1] + "-" + m[2].padStart(2, "0") + "-" + m[3].padStart(2, "0");
  const ym = String(raw).match(/(\d{4})[年/\-.](\d{1,2})/);
  if (ym) return ym[1] + "-" + ym[2].padStart(2, "0") + "-01";
  const y = String(raw).match(/(20\d{2})/);
  return y ? y[1] + "-01-01" : "";
}
function timeOfC(fields) {
  const d = dateOfC((fields || {})["上线日期"]);
  return d ? new Date(d + "T00:00:00+08:00").getTime() : 0;
}
function flowNum(fields) {
  const raw = String((fields || {})["国内通用流量"] || "");
  const m = raw.match(/(\d+(?:\.\d+)?)\s*(G|GB|M|MB)?/i);
  if (!m) return -1;
  let n = parseFloat(m[1]);
  if (/^M/i.test(m[2] || "")) n /= 1024;
  return n;
}
function provLabel(code) { return CB.provName(code) || code; }
function carrierName(c) { return CB.carrierName(c) || c; }
function liveEntry(carrier, prov, it) {
  return { key: `live:${carrier}:${prov}:${it.id}`, kind: "live", carrier, prov, id: String(it.id), name: it.name || "", fields: it.fields || {}, attr: it.tariff_attr || "1" };
}
/* 收藏按运营商拆桶，展平为快照同构条目（f 为收藏时完整字段快照，prov 保留原省） */
function favItemsFor(c) {
  const cb = (CB.favRaw() || {})[c] || {};
  const out = [];
  Object.keys(cb).forEach(prov => {
    Object.keys(cb[prov]).forEach(id => {
      const rec = cb[prov][id] || {};
      out.push({ id, name: rec.n || "", fields: rec.f || {}, prov, isFav: true });
    });
  });
  return out;
}
/* 对比池已勾选条目按运营商拆桶（isSelEntry 保留原始 entry 引用，勾选 key/取消勾选均复用）；
   c="imp" 时返回已选的导入条目（导入无运营商归属，已选模式以独立「导入」列展示） */
function selItemsFor(c) {
  if (c === "imp") {
    return [...selected.values()]
      .filter(e => e && e.kind === "import")
      .map(e => ({ id: e.id, name: e.name || "", fields: e.fields || {}, prov: e.prov || "", isSelEntry: e }));
  }
  return [...selected.values()]
    .filter(e => e && e.carrier === c)
    .map(e => ({ id: e.id, name: e.name || "", fields: e.fields || {}, prov: e.prov || "", isSelEntry: e }));
}
/* 省份下拉选项集（仅作用于对比页自己的 picker 实例，不碰顶栏）：
   正常模式=全量省表；收藏/已选模式=「全部」+ 数据源中出现过的省（跨省虚拟快照）。
   setOptions 后强制回写 pp.value：setOptions 对"旧值恰好存在于新选项集"时会保持旧值而非落到 defVal，
   导致切模式时显示省、内容却是全部（显示与数据态脱钩）——回写保证显示永远跟随 cmpProv */
function syncProvOptions() {
  const pp = document.getElementById("cmpProvPicker");
  if (!pp || !pp.setOptions) return;
  if (cmpFavMode || cmpSelMode) {
    const src = cmpFavMode ? favItemsFor : selItemsFor;
    const provSet = new Set();
    CARRIER_ORDER.forEach(c => src(c).forEach(it => { if (it.prov) provSet.add(it.prov); }));
    pp.setOptions([{ code: "", name: "全部" }, ...[...provSet].sort().map(p => ({ code: p, name: provLabel(p) }))], "");
    pp.value = cmpProv || "";
  } else {
    pp.setOptions((CB.provList() || []).map(p => ({ code: p.code, name: p.name })), cmpProv);
    pp.value = cmpProv;
  }
}
/* 虚拟快照模式进入/退出的公共状态处理：记住省（省为空时保留旧记忆，跨虚拟模式切换不丢）、
   进入时清省=「全部」并释放快照缓存（虚拟快照不占快照内存），退出恢复全量省表 */
function enterVirtMode(on) {
  if (on) {
    cmpProvSaved = cmpProv || cmpProvSaved;
    cmpProv = "";
    if (cmpLastKeys.length) { cmpLastKeys.forEach(ck => CB.cacheDrop(ck)); cmpLastKeys = []; }
  } else {
    cmpProv = cmpProvSaved || CB.provCode();
  }
  syncProvOptions();
  const el = document.getElementById("view-compare");
  if (el) renderCompare(el);
}
/* 「从收藏选择」模式开关（与已选/导入模式互斥） */
function toggleFavMode() {
  cmpFavMode = !cmpFavMode;
  if (cmpFavMode && cmpSelMode) cmpSelMode = false;
  if (cmpFavMode && cmpImpMode) cmpImpMode = false;
  enterVirtMode(cmpFavMode);
}
/* 「从已选选择」模式开关（与收藏/导入模式互斥） */
function toggleSelMode() {
  cmpSelMode = !cmpSelMode;
  if (cmpSelMode && cmpFavMode) cmpFavMode = false;
  if (cmpSelMode && cmpImpMode) cmpImpMode = false;
  enterVirtMode(cmpSelMode);
}
/* 「从导入选择」模式开关（与收藏/已选模式互斥）：导入清单全集单列虚拟快照（导入无运营商/省归属，
   不按运营商分列，省份选择器无意义——renderCompare 中该模式不渲染运营商组与省份选择器） */
function toggleImpMode() {
  cmpImpMode = !cmpImpMode;
  if (cmpImpMode && cmpFavMode) cmpFavMode = false;
  if (cmpImpMode && cmpSelMode) cmpSelMode = false;
  enterVirtMode(cmpImpMode);
}
function selCount() { return selected.size; }

/* ── 勾选 ── */
function toggleSel(entry) {
  if (selected.has(entry.key)) { selected.delete(entry.key); saveSel(); return false; }
  if (selected.size >= CMP_MAX) { toast(`最多同时对比 ${CMP_MAX} 条`); return false; }
  selected.set(entry.key, entry); saveSel(); return true;
}
function syncSelbars(root) {
  const n = selCount();
  root.querySelectorAll(".cmp-selbar").forEach(b => {
    b.querySelector(".cmp-selbar-n").textContent = String(n);
    const go = b.querySelector("[data-act='cmpOpen']");
    if (go) go.disabled = n < 2;
    const clr = b.querySelector("[data-act='cmpClear']");
    if (clr) clr.disabled = n === 0;
  });
  root.querySelectorAll("[data-cmpkey]").forEach(btn => {
    btn.classList.toggle("on", selected.has(btn.dataset.cmpkey));
  });
  if (cmpLayerOpen) renderCmpLayer();
}

/* ═══════════════ 资费对比视图 ═══════════════ */
export async function compareOnShow() {
  const el = document.getElementById("view-compare");
  if (!el) return;
  try { await CB.ensureBoot(); } catch { /* 引导失败仍渲染（省份下拉可能为空，快照加载不依赖） */ }
  /* 默认当前运营商 + 当前省，进视图即自动加载（与资费页行为对齐）；
     收藏/已选/导入虚拟快照模式下 cmpProv 为 ""（全部）是合法态，不回填 */
  if (!cmpCarriers.length) { cmpCarriers = [CB.currentCarrier()]; saveCarriers(); }
  if (!cmpProv && !cmpFavMode && !cmpSelMode && !cmpImpMode) cmpProv = CB.provCode();
  cmpLoaded = true;
  renderCompare(el);
}

/* 离开对比视图：清弹层（fixed 遮罩不随视图 display:none 消失，由 onTabChange 调用） */
export function compareOnHide() {
  cmpLayerOpen = false;
  ["cmpLayerHost", "cmpModalHost"].forEach(id => {
    const h = document.getElementById(id);
    if (h) h.innerHTML = "";
  });
}

function renderCompare(el) {
  const carrierChips = CARRIER_ORDER.map(c =>
    `<button type="button" class="seg-btn${cmpCarriers.includes(c) ? " active" : ""}" data-chip="${esc(c)}" title="${esc(carrierName(c))}">${esc(CARRIER_SHORT[c] || carrierName(c))}</button>`).join("");
  el.innerHTML = `
  <h1 class="page-title">资费对比</h1>
  <p class="page-sub">运营商与省份快照并排 · 「从收藏/已选/导入选择」切换虚拟快照（跨省，省份可选，三模式互斥）· 勾选 2-${CMP_MAX} 条查看字段级差异 · 增减运营商自动加载</p>
  <div class="panel cmp-toolbar">
    <div class="cmp-tb-row">
      <div class="cmp-tb-left">${cmpImpMode
        ? `<span class="cmp-badge c-imp">${icon("download")} 导入清单</span>`
        : `<div class="seg carrier-switch" id="cmpCarrierSeg">${carrierChips}</div>
        <div class="topbar-prov" id="cmpProvPicker"></div>`}</div>
      <input type="search" class="cmp-search" placeholder="在所选快照内搜索名称/字段…" value="${esc(cmpQuery)}">
      <button type="button" class="btn ghost sm" data-act="cmpImport"><i data-icon="plus"></i>导入资费</button>
      ${imports.length ? `<button type="button" class="btn ghost sm" data-act="cmpImports">已导入 ${imports.length} 条</button>` : ""}
    </div>
    <div class="cmp-tb-row">
      <div class="filter-bar">
        <div class="sort-bar">
          <span class="sort-tit">排序</span>
          <button type="button" class="sort-btn${cmpSort === "time" ? " active" : ""}" data-act="cmpSort" data-sort="time">最新上架</button>
          <button type="button" class="sort-btn${cmpSort === "price" ? " active" : ""}" data-act="cmpSort" data-sort="price">按价格</button>
          <button type="button" class="sort-btn s-dir" data-act="cmpSortDir" ${cmpSort === "price" ? "" : "hidden"}>${cmpDir === -1 ? "降序 ↓" : "升序 ↑"}</button>
        </div>
        <span class="cmp-tb-div"></span>
        <span class="filter-tit">筛选</span>
        <button type="button" class="filter-btn toggle-btn${cmpZero ? " active" : ""}" data-act="cmpZero">零元</button>
        <button type="button" class="filter-btn toggle-btn${cmpFavMode ? " active" : ""}" data-act="cmpFavPick">${icon("star")} 从收藏选择</button>
        <button type="button" class="filter-btn toggle-btn${cmpSelMode ? " active" : ""}" data-act="cmpSelPick">${icon("check")} 从已选选择</button>
        <button type="button" class="filter-btn toggle-btn${cmpImpMode ? " active" : ""}" data-act="cmpImpPick">${icon("download")} 从导入选择</button>
      </div>
    </div>
  </div>
  <div class="cmp-grid" id="cmpGrid">${cmpLoaded ? "" : `<div class="loading" style="grid-column:1/-1;padding:48px 0">加载中…</div>`}</div>
  <div class="cmp-selbar">
    <span>已选 <b class="cmp-selbar-n">0</b>/${CMP_MAX}</span>
    <button type="button" class="btn ghost sm" data-act="cmpClear" ${selected.size ? "" : "disabled"}>清空</button>
    <button type="button" class="btn primary" data-act="cmpOpen" ${selected.size >= 2 ? "" : "disabled"}><i data-icon="scale"></i>开始对比</button>
  </div>
  <div id="cmpLayerHost"></div><div id="cmpModalHost"></div>`;
  /* 省份：顶栏同款自定义 picker（桥接入，与资费页选择器同组件同交互）。
     桥初始化默认全量省表，随后按当前模式校正选项集（收藏模式=「全部」+收藏省份）；
     setOptions 只作用于本实例闭包，不影响顶栏 #gProv 等其他选择器 */
  const ppHost = el.querySelector("#cmpProvPicker");
  if (ppHost) {
    CB.provPicker(ppHost);
    syncProvOptions();
    ppHost.addEventListener("change", (e) => {
      cmpProv = e.target.value;
      if (cmpCarriers.length) renderColumns(el);
    });
  }
  /* 搜索：在已加载快照内即时过滤（200ms 防抖，仅重渲列 body，不重新拉数据） */
  const searchEl = el.querySelector(".cmp-search");
  let searchTimer = 0;
  searchEl.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      cmpQuery = searchEl.value.trim();
      if (!cmpLoaded) return;
      CARRIER_ORDER.filter(c => cmpCarriers.includes(c)).forEach(c => {
        cmpColPage[c] = 1;
        const col = el.querySelector(`#cmpGrid .cmp-col[data-c="${c}"]`);
        if (col) renderColBody(col, c);
      });
    }, 200);
  });
  el.addEventListener("click", cmpOnRootClick);
  mountIcons(el);
  if (cmpLoaded && cmpCarriers.length) renderColumns(el);
  syncSelbars(el);
}
renderColumns.stamp = 0;   // 竞态守卫计数（快速切省时旧异步结果作废）

async function renderColumns(el) {
  const grid = el.querySelector("#cmpGrid");
  if (!grid) return;
  const runStamp = ++renderColumns.stamp;   // 快速切省/切运营商竞态守卫：旧异步回来时已不渲染
  /* 已选模式下对比池含导入条目时追加独立「导入」列（导入无运营商归属，不与运营商列混排） */
  const cols = cmpImpMode
    ? ["imp"]
    : CARRIER_ORDER.filter(c => cmpCarriers.includes(c))
      .concat(cmpSelMode && [...selected.values()].some(e => e && e.kind === "import") ? ["imp"] : []);
  if (!cols.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1;padding:48px 0">至少选择一个运营商</div>`;
    return;
  }
  const colLabel = (c) => c === "imp" ? "导入" : carrierName(c);
  grid.style.gridTemplateColumns = `repeat(${cols.length}, minmax(0, 1fr))`;
  grid.innerHTML = cols.map(c => `
    <div class="cmp-col" data-c="${esc(c)}">
      <div class="cmp-col-head"><span class="cmp-badge c-${esc(c)}">${esc(colLabel(c))}</span><span class="cmp-col-n">…</span></div>
      <div class="cmp-col-body"><div class="loading" style="padding:24px 0">加载中…</div></div>
    </div>`).join("");
  if (cmpImpMode) {
    /* 导入虚拟快照：导入清单全集单列（无运营商/省归属，cmpProv 恒为 ""，无省过滤） */
    const col = grid.querySelector('.cmp-col[data-c="imp"]');
    if (col) {
      const its = imports.map(e => ({ id: e.id, name: e.name || "", fields: e.fields || {}, prov: "", isSelEntry: e }));
      if (!its.length) {
        col.querySelector(".cmp-col-n").textContent = "0 条";
        col.querySelector(".cmp-col-body").innerHTML = `<div class="empty" style="padding:20px 8px">暂无导入条目<br><span style="font-size:12px;opacity:.75">点上方「导入资费」粘贴概要添加</span></div>`;
      } else {
        const items = its.map(it => {
          const f = it.fields || {};
          return [it, priceNum(f), flowNum(f), (String(it.name || "") + " 导入 " + JSON.stringify(f)).toLowerCase(), timeOfC(f)];
        });
        if (cmpSort === "time") items.sort((a, b) => b[4] - a[4]);
        else items.sort((a, b) => (a[1] - b[1]) * cmpDir);
        cmpColItems.imp = items;
        cmpColPage.imp = 1;
        renderColBody(col, "imp");
      }
    }
    mountIcons(grid);
    syncSelbars(el);
    return;
  }
  if (cmpFavMode || cmpSelMode) {
    /* 虚拟快照模式（收藏/已选）：数据在本地无需网络加载，同步渲染（保持竞态守卫）。
       数据源 = 该运营商条目（跨省），cmpProv 为 "" 时显示全部、否则按省过滤 */
    const src = cmpFavMode ? favItemsFor : selItemsFor;
    const emptyTip = (c) => c === "imp" ? "已选导入条目" : (cmpFavMode ? "收藏" : "已选条目");
    cols.forEach(c => {
      const col = grid.querySelector(`.cmp-col[data-c="${c}"]`);
      if (!col) return;
      const its = src(c).filter(it => !cmpProv || it.prov === cmpProv);
      if (!its.length) {
        col.querySelector(".cmp-col-n").textContent = "0 条";
        col.querySelector(".cmp-col-body").innerHTML = `<div class="empty" style="padding:20px 8px">${c === "imp" ? "暂无" : "该运营商暂无"}${cmpProv && c !== "imp" ? " " + esc(provLabel(cmpProv)) + " " : ""}${emptyTip(c)}</div>`;
        return;
      }
      const items = its.map(it => {
        const f = it.fields || {};
        const hayProv = it.isSelEntry ? (it.isSelEntry.kind === "import" ? "导入" : provLabel(it.prov)) : (it.isFav ? provLabel(it.prov) : "");
        return [it, priceNum(f), flowNum(f), (String(it.name || "") + " " + hayProv + " " + JSON.stringify(f)).toLowerCase(), timeOfC(f)];
      });
      if (cmpSort === "time") items.sort((a, b) => b[4] - a[4]);
      else items.sort((a, b) => (a[1] - b[1]) * cmpDir);
      cmpColItems[c] = items;
      cmpColPage[c] = 1;
      renderColBody(col, c);
    });
    mountIcons(grid);
    syncSelbars(el);
    return;
  }
  const results = await Promise.allSettled(cols.map(c => CB.loadSnapFor(c, cmpProv)));
  if (runStamp !== renderColumns.stamp || !grid.isConnected) return;
  /* 数据量防护：真实大省单快照上万条（湖南移动 4569 条），全量 DOM 会卡死移动端——
     排序前先预计算价格/流量/搜索 hay（避免排序与过滤中每条重复正则），
     渲染每列只出前 CMP_COL_BATCH 条 + "显示更多"增量 */
  cols.forEach((c, idx) => {
    const col = grid.querySelector(`.cmp-col[data-c="${c}"]`);
    if (!col) return;
    const r = results[idx];
    if (r.status === "rejected") {
      col.querySelector(".cmp-col-n").textContent = "加载失败";
      col.querySelector(".cmp-col-body").innerHTML = `<div class="empty" style="padding:20px 8px">加载失败<button type="button" class="btn ghost sm" data-act="cmpRetry" data-c="${esc(c)}" style="margin-top:8px">重试</button></div>`;
      return;
    }
    const items = ((r.value && r.value.items) || []).map(it => {
      const f = it.fields || {};
      return [it, priceNum(f), flowNum(f), (String(it.name || "") + " " + JSON.stringify(f)).toLowerCase(), timeOfC(f)];
    });
    if (cmpSort === "time") items.sort((a, b) => b[4] - a[4]);                    // 最新上架：降序固定
    else items.sort((a, b) => (a[1] - b[1]) * cmpDir);                            // 按价格：方向可切换
    cmpColItems[c] = items;
    cmpColPage[c] = 1;
    renderColBody(col, c);
  });
  /* 释放上一轮加载的快照缓存（23MB 级/省，多省累积撑爆内存；桥内排除列表当前省防闪拉） */
  if (cmpLastKeys.length) cmpLastKeys.forEach(ck => CB.cacheDrop(ck));
  cmpLastKeys = cols.map(c => `${c}:snapshots/snapshot_${cmpProv}.json`);
  mountIcons(grid);
  syncSelbars(el);
}
const CMP_COL_BATCH = 50;  // 每列每页条数（与资费列表分页粒度一致；真实大省单快照上万条，全量 DOM 卡死移动端）
const cmpColItems = {};    // 排序后各列完整数据（[it, price, flow, hay]），搜索过滤与分页共用
const cmpColPage = {};     // 各列当前页码（1 起，对过滤后列表计数）
let cmpLastKeys = [];      // 上一轮加载的快照缓存键（新一轮加载成功后释放）

/* 单列渲染：出当前页条目 + 底部分页器（与资费列表同款交互：上一页/页码/下一页） */
function renderColBody(col, c) {
  const body = col.querySelector(".cmp-col-body");
  if (!body) return;
  const all = cmpColItems[c] || [];
  const q = norm(cmpQuery);
  let filtered = q ? all.filter(a => a[3].includes(q)) : all.slice();
  if (cmpZero) filtered = filtered.filter(a => isZeroFeeF(a[0].fields));   // 零元业务筛选
  const totalPages = Math.max(1, Math.ceil(filtered.length / CMP_COL_BATCH));
  const page = Math.min(Math.max(cmpColPage[c] || 1, 1), totalPages);
  cmpColPage[c] = page;
  col.querySelector(".cmp-col-n").textContent = q ? `${filtered.length}/${all.length} 条` : `${all.length} 条`;
  if (!filtered.length) {
    body.innerHTML = `<div class="empty" style="padding:20px 8px">${q ? "无匹配结果" : "该省暂无在售资费"}</div>`;
    return;
  }
  const shown = filtered.slice((page - 1) * CMP_COL_BATCH, page * CMP_COL_BATCH);
  body.innerHTML = shown.map(([it]) => {
    const e = it.isSelEntry ? it.isSelEntry
      : (it.isFav
        ? { key: `fav:${c}:${it.prov}:${it.id}`, kind: "fav", carrier: c, prov: it.prov, id: String(it.id), name: it.name || "", fields: it.fields || {} }
        : liveEntry(c, cmpProv, it));
    const on = selected.has(e.key);
    const btag = it.isSelEntry
      ? (it.isSelEntry.kind === "import"
        ? `<span class="fav-prov-tag" style="margin-left:6px">导入</span>`
        : `<span class="fav-prov-tag" style="margin-left:6px">${esc(provLabel(it.isSelEntry.prov) || "—")}</span>`)
      : (it.isFav ? `<span class="fav-prov-tag" style="margin-left:6px">⭐ ${esc(provLabel(it.prov))}</span>` : "");
    const cat = String(e.fields["资费类型"] || "").trim();
    return `
    <div class="cmp-card${on ? " on" : ""}" data-cmpkey="${esc(e.key)}" data-entry="${esc(JSON.stringify(e))}" title="${on ? "点击取消对比" : "点击加入对比"}">
      <div class="cmp-card-top">
        <div class="cmp-card-name" title="${esc(e.name)}">${esc(e.name || "（无名称）")}${btag}</div>
        <button type="button" class="copy-btn" data-cmpdetail="1" title="查看资费详情" aria-label="查看资费详情">${icon("list")}</button>
      </div>
      <div class="cmp-card-vals"><span class="v-fee">${esc(feeText(e.fields))}</span><span>${esc(flowText(e.fields))}</span><span>${esc(callText(e.fields))}</span></div>
      ${cat ? `<div class="cmp-card-tags"><span class="tag type-cmp">${esc(cat)}</span></div>` : ""}
    </div>`;
  }).join("") + `
  <div class="cmp-pager">
    <button type="button" class="cmp-pg" data-act="cmpPg" data-c="${esc(c)}" data-d="-1" ${page <= 1 ? "disabled" : ""}>上一页</button>
    <span class="cmp-pg-n">第 ${page} / ${totalPages} 页</span>
    <button type="button" class="cmp-pg" data-act="cmpPg" data-c="${esc(c)}" data-d="1" ${page >= totalPages ? "disabled" : ""}>下一页</button>
  </div>`;
}

/* ── 对比视图点击路由 ── */
function cmpOnRootClick(e) {
  const actBtn = e.target.closest("[data-act]");
  if (actBtn) {
    const act = actBtn.dataset.act;
    if (act === "cmpSort") {
      /* 与资费列表同款交互：点"最新上架"固定降序；点"按价格"默认升序并显示方向切换 */
      cmpSort = actBtn.dataset.sort;
      if (cmpSort === "time") cmpDir = -1;
      else if (actBtn.dataset.sort && cmpSort === "price" && !actBtn.classList.contains("active")) cmpDir = 1;
      const el = document.getElementById("view-compare");
      if (el) { renderCompare(el); }
      return;
    }
    if (act === "cmpSortDir") {
      cmpDir = cmpDir === -1 ? 1 : -1;
      const el = document.getElementById("view-compare");
      if (el) { renderCompare(el); }
      return;
    }
    if (act === "cmpZero") {
      cmpZero = !cmpZero;
      actBtn.classList.toggle("on", cmpZero);
      const el = document.getElementById("view-compare");
      if (el && cmpLoaded) CARRIER_ORDER.filter(c => cmpCarriers.includes(c)).forEach(c => {
        cmpColPage[c] = 1;
        const col = el.querySelector(`#cmpGrid .cmp-col[data-c="${c}"]`);
        if (col) renderColBody(col, c);
      });
      return;
    }
    if (act === "cmpFavPick") { toggleFavMode(); return; }
    if (act === "cmpSelPick") { toggleSelMode(); return; }
    if (act === "cmpImpPick") { toggleImpMode(); return; }
    if (act === "cmpColDetail") {
      let entry = null;
      try { entry = JSON.parse(actBtn.dataset.detail || ""); } catch { /* */ }
      if (entry) openCmpModal(entry);
      return;
    }
    if (act === "cmpImport") { openImport(); return; }
    if (act === "cmpImports") { openImports(); return; }
    if (act === "cmpOpen") { openCmpLayer(); return; }
    if (act === "cmpClear") { selected.clear(); saveSel(); const el = document.getElementById("view-compare"); if (el) { renderColumns(el); syncSelbars(el); } return; }
    if (act === "cmpRetry") { const el = document.getElementById("view-compare"); if (el) renderColumns(el); return; }
    if (act === "cmpLoad") { cmpLoaded = true; const el = document.getElementById("view-compare"); if (el) renderColumns(el); return; }
    if (act === "cmpPg") {
      const c = actBtn.dataset.c;
      const d = parseInt(actBtn.dataset.d, 10) || 0;
      cmpColPage[c] = Math.max(1, (cmpColPage[c] || 1) + d);
      const col = document.querySelector(`#cmpGrid .cmp-col[data-c="${c}"]`);
      if (col) renderColBody(col, c);
      return;
    }
  }
  const chipBtn = e.target.closest("[data-chip]");
  if (chipBtn) {
    const c = chipBtn.dataset.chip;
    const i = cmpCarriers.indexOf(c);
    if (i >= 0) cmpCarriers.splice(i, 1); else cmpCarriers.push(c);
    saveCarriers();
    chipBtn.classList.toggle("active", cmpCarriers.includes(c));   // seg 按钮高亮类是 active（曾误写 on 导致选中特效不跟手）
    const el = document.getElementById("view-compare");
    if (el && cmpCarriers.length) renderColumns(el);   // 增减运营商自动加载（缓存命中零请求）
    else if (el) {
      const grid = el.querySelector("#cmpGrid");
      if (grid) grid.innerHTML = `<div class="empty" style="grid-column:1/-1;padding:48px 0">至少选择一个运营商</div>`;
    }
    return;
  }
  /* 卡片右上角详情图标：先于卡片勾选分支判断（按钮在卡片内，closest 会同时命中两者），
     entry 从卡片自身的 data-entry 读取，不重复放 JSON */
  const detBtn = e.target.closest("[data-cmpdetail]");
  if (detBtn) {
    const card = detBtn.closest("[data-entry]");
    if (card) {
      try { openCmpModal(JSON.parse(card.dataset.entry)); } catch { /* entry 解析失败静默 */ }
    }
    return;
  }
  const addBtn = e.target.closest("[data-cmpkey]");
  if (addBtn) {
    let entry = null;
    try { entry = JSON.parse(addBtn.dataset.entry); } catch { /* */ }
    if (!entry) return;
    toggleSel(entry);
    const el = document.getElementById("view-compare");
    if (el) {
      syncSelbars(el);
      /* 已选模式：取消勾选的条目从虚拟快照中即时移除（重渲该列，条目减少分页回第 1 页） */
      if (cmpSelMode) {
        const c = entry.carrier;
        cmpColPage[c] = 1;
        const col = el.querySelector(`#cmpGrid .cmp-col[data-c="${CSS.escape(c)}"]`);
        if (col) renderColBody(col, c);
      }
    }
    return;
  }
  /* 点击卡片其余元素：卡片自身携带 data-cmpkey/data-entry，closest 已命中上方分支处理（加入/取消对比） */
}

/* ═══════════════ 明细对比层 ═══════════════ */
let diffOnly = false;

function openCmpLayer() {
  const host = document.getElementById("cmpLayerHost");
  if (!host) return;
  cmpLayerOpen = true;
  renderCmpLayer();
}
function closeCmpLayer() {
  cmpLayerOpen = false;
  const host = document.getElementById("cmpLayerHost");
  if (host) host.innerHTML = "";
  const mh = document.getElementById("cmpModalHost");   // 明细层关闭时顺带清详情弹窗，防残留遮罩
  if (mh) mh.innerHTML = "";
}

function renderCmpLayer() {
  const host = document.getElementById("cmpLayerHost");
  if (!host || !cmpLayerOpen) return;
  const entries = [...selected.values()];
  if (entries.length < 2) { closeCmpLayer(); return; }
  /* 字段行序：MAIN_KEYS → 其余键并集（首次出现序）→ NOTE_KEYS */
  const restSeen = [];
  entries.forEach(en => Object.keys(en.fields || {}).forEach(k => {
    if (!MAIN_KEYS.includes(k) && !NOTE_KEYS.includes(k) && !restSeen.includes(k)) restSeen.push(k);
  }));
  const rowKeys = MAIN_KEYS.filter(k => entries.some(en => (en.fields || {})[k]))
    .concat(restSeen)
    .concat(NOTE_KEYS.filter(k => entries.some(en => (en.fields || {})[k])));
  /* 差异行判定（归一化） */
  const isDiff = (k) => new Set(entries.map(en => norm((en.fields || {})[k]))).size > 1;
  const rows = rowKeys.map(k => {
    const diff = isDiff(k);
    if (diffOnly && !diff) return "";
    const cells = entries.map(en => {
      let v = (en.fields || {})[k];
      if (v == null || String(v).trim() === "") v = "—";
      else if (k === "适用地区") v = CB.areaCn ? CB.areaCn(v) : v;
      return `<td>${esc(String(v))}</td>`;
    }).join("");
    return `<tr class="${diff ? "cmp-diff" : "cmp-same"}"><th>${esc(k)}</th>${cells}</tr>`;
  }).join("");
  const nameRow = `<tr class="cmp-namerow"><th>名称</th>${entries.map(en => `<td>${esc(en.name || "—")}</td>`).join("")}</tr>`;
  const cols = entries.map(en => {
    const tag = en.kind === "import" ? `<span class="cmp-tag imp">导入</span>` : en.kind === "fav" ? `<span class="cmp-tag fav">收藏</span>` : "";
    return `<th><div class="cmp-colth"><span class="cmp-badge c-${esc(en.carrier)}">${esc(carrierName(en.carrier))}</span>${tag}<span class="cmp-colth-p">${esc(en.prov ? provLabel(en.prov) : "")}</span><button type="button" class="btn ghost sm cmp-colth-detail" data-act="cmpColDetail" data-detail="${esc(JSON.stringify(en))}" title="查看该条资费详情">${icon("list")} 详情</button></div></th>`;
  }).join("");
  host.innerHTML = `
  <div class="cmp-mask open" data-act="cmpMaskClose">
    <div class="cmp-layer" role="dialog" aria-modal="true">
      <div class="cmp-layer-head">
        <span class="cmp-layer-title">${icon("scale")} 资费明细对比（${entries.length} 条）</span>
        <span class="cmp-layer-acts">
          <button type="button" class="btn ghost sm${diffOnly ? " primary-soft" : ""}" data-act="cmpDiffOnly">${diffOnly ? icon("check") + "仅看差异" : icon("filter") + "仅看差异"}</button>
          <button type="button" class="cmp-close" data-act="cmpLayerClose" aria-label="关闭">&times;</button>
        </span>
      </div>
      <div class="cmp-layer-body">
        <table class="cmp-table"><thead><tr><th class="cmp-rowhead"></th>${cols}</tr></thead>
        <tbody>${nameRow}${rows || `<tr><td colspan="${entries.length + 1}" class="cmp-nodiff">所选条目字段完全一致</td></tr>`}</tbody></table>
      </div>
    </div>
  </div>`;
  mountIcons(host);
  host.querySelector(".cmp-mask").addEventListener("click", (e) => {
    if (e.target.dataset.act === "cmpMaskClose") closeCmpLayer();
  });
  host.querySelector("[data-act='cmpLayerClose']").addEventListener("click", closeCmpLayer);
  host.querySelector("[data-act='cmpDiffOnly']").addEventListener("click", () => { diffOnly = !diffOnly; renderCmpLayer(); });
}

/* ═══════════════ 导入（严格反向匹配【复制资费概要】格式） ═══════════════ */
function parseSummaries(text) {
  const items = [], errs = [];
  let cur = null;
  String(text || "").split(/\r?\n/).forEach((line, idx) => {
    const s = line.trim();
    if (!s) return;
    const m = s.match(/^([^：]+)：(.*)$/s);
    if (!m) { errs.push({ line: idx + 1, why: "缺「：」分隔" }); return; }
    const k = m[1].trim(), v = m[2].trim();
    if (k === "名称") {
      if (cur) items.push(cur);
      if (!v) { errs.push({ line: idx + 1, why: "名称为空" }); cur = null; return; }
      cur = { name: v, fields: {} };
      return;
    }
    if (!cur) { errs.push({ line: idx + 1, why: "不在条目内（缺少「名称：」起始行）" }); return; }
    if (!k) { errs.push({ line: idx + 1, why: "键为空" }); return; }
    cur.fields[k] = v;   // 字段体系开放：未识别键原样收下（与概要输出任意 fields 键对齐）
  });
  if (cur) items.push(cur);
  return { items, errs };
}

function openImport() {
  const host = document.getElementById("cmpLayerHost");
  if (!host) return;
  host.innerHTML = `
  <div class="cmp-mask open" data-act="cmpMaskClose">
    <div class="cmp-layer cmp-layer-sm" role="dialog" aria-modal="true">
      <div class="cmp-layer-head">
        <span class="cmp-layer-title">${icon("plus")} 导入资费</span>
        <button type="button" class="cmp-close" data-act="cmpImportClose" aria-label="关闭">&times;</button>
      </div>
      <div class="cmp-layer-body">
        <p class="cmp-import-tip">粘贴本项目「复制概要」生成的文本，可一次多条（每条以「名称：」开头）。下架资费导入后可长期参与对比。</p>
        <textarea class="cmp-import-ta" rows="10" placeholder="名称：XXX&#10;资费标准：29元/月&#10;方案编号：XXX&#10;…"></textarea>
        <div class="cmp-import-fb" hidden></div>
        <div class="cmp-import-acts">
          <button type="button" class="btn ghost sm" data-act="cmpImportCancel">取消</button>
          <button type="button" class="btn primary" data-act="cmpImportDo">解析并加入</button>
        </div>
      </div>
    </div>
  </div>`;
  mountIcons(host);
  const mask = host.querySelector(".cmp-mask");
  mask.addEventListener("click", (e) => { if (e.target.dataset.act === "cmpMaskClose") host.innerHTML = ""; });
  host.querySelector("[data-act='cmpImportClose']").addEventListener("click", () => { host.innerHTML = ""; });
  host.querySelector("[data-act='cmpImportCancel']").addEventListener("click", () => { host.innerHTML = ""; });
  host.querySelector("[data-act='cmpImportDo']").addEventListener("click", () => {
    const ta = host.querySelector(".cmp-import-ta");
    const fb = host.querySelector(".cmp-import-fb");
    const { items, errs } = parseSummaries(ta.value);
    if (!items.length) {
      fb.hidden = false;
      fb.innerHTML = `<span class="cmp-fb-bad">未解析到有效条目${errs.length ? `（问题行：${errs.map(x => `第 ${x.line} 行 ${x.why}`).join("；")}）` : ""}</span>`;
      return;
    }
    let joined = 0, overflow = 0;
    items.forEach(it => {
      const entry = { key: `imp:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, kind: "import", carrier: "", prov: "", id: it.name, name: it.name, fields: it.fields };
      imports.push(entry);
      if (selected.size < CMP_MAX) { selected.set(entry.key, entry); joined++; }
      else overflow++;
    });
    saveImports(); saveSel();
    fb.hidden = false;
    fb.innerHTML = `<span class="cmp-fb-ok">成功解析 ${items.length} 条并入库${errs.length ? `；问题行：${errs.map(x => `第 ${x.line} 行 ${x.why}`).join("；")}` : ""}${overflow ? `；对比清单已满（上限 ${CMP_MAX}），${overflow} 条请在「已导入」列表中管理` : ""}</span>`;
    setTimeout(() => {
      host.innerHTML = "";
      const el = document.getElementById("view-compare");
      if (el) renderCompare(el);
      toast(`导入 ${items.length} 条，加入对比 ${joined} 条`);
    }, 900);
  });
}

function openImports() {
  const host = document.getElementById("cmpLayerHost");
  if (!host) return;
  host.innerHTML = `
  <div class="cmp-mask open" data-act="cmpMaskClose">
    <div class="cmp-layer cmp-layer-sm" role="dialog" aria-modal="true">
      <div class="cmp-layer-head">
        <span class="cmp-layer-title">${icon("list")} 已导入资费（${imports.length}）</span>
        <span class="cmp-layer-acts">
          <button type="button" class="btn ghost sm" data-act="cmpImpClear" ${imports.length ? "" : "disabled"} title="清空全部导入条目（已加入对比的同步移出）">${icon("trash")} 一键清空</button>
          <button type="button" class="cmp-close" data-act="cmpImportsClose" aria-label="关闭">&times;</button>
        </span>
      </div>
      <div class="cmp-layer-body">
        ${imports.length ? imports.map((it, i) => `
          <div class="cmp-imp-item">
            <span class="cmp-imp-name">${esc(it.name || "（无名称）")}</span>
            <span class="cmp-imp-fee">${esc(feeText(it.fields))}</span>
            <button type="button" class="btn ghost sm" data-impjoin="${i}" ${selected.has(it.key) ? "disabled" : ""}>${selected.has(it.key) ? "已加入" : (selected.size >= CMP_MAX ? "已满" : "加入对比")}</button>
            <button type="button" class="cmp-imp-del" data-impdel="${i}" title="删除">${icon("x")}</button>
          </div>`).join("") : `<div class="empty" style="padding:20px">暂无导入条目</div>`}
      </div>
    </div>
  </div>`;
  mountIcons(host);
  const mask = host.querySelector(".cmp-mask");
  mask.addEventListener("click", (e) => { if (e.target.dataset.act === "cmpMaskClose") host.innerHTML = ""; });
  host.querySelector("[data-act='cmpImportsClose']").addEventListener("click", () => { host.innerHTML = ""; });
  host.querySelectorAll("[data-impjoin]").forEach(b => b.addEventListener("click", () => {
    const it = imports[parseInt(b.dataset.impjoin, 10)];
    if (!it || selected.has(it.key) || selected.size >= CMP_MAX) { toast(selected.size >= CMP_MAX ? `最多同时对比 ${CMP_MAX} 条` : "已加入"); return; }
    selected.set(it.key, it); saveSel();
    openImports();
  }));
  host.querySelectorAll("[data-impdel]").forEach(b => b.addEventListener("click", () => {
    const i = parseInt(b.dataset.impdel, 10);
    const removed = imports.splice(i, 1)[0];
    if (removed) { selected.delete(removed.key); saveSel(); }
    saveImports();
    const el = document.getElementById("view-compare");
    if (el) renderCompare(el);
    openImports();
  }));
  /* 一键清空：连带移出对比池（已加入对比的导入条目同步消失），刷新视图与弹窗 */
  host.querySelector("[data-act='cmpImpClear']").addEventListener("click", () => {
    if (!imports.length) return;
    const n = imports.length;
    imports.forEach(it => { if (it && it.key) selected.delete(it.key); });
    saveSel();
    imports = [];
    saveImports();
    const el = document.getElementById("view-compare");
    if (el) renderCompare(el);
    openImports();
    toast(`已清空 ${n} 条导入条目`);
  });
}

/* ═══════════════ 我的收藏视图 ═══════════════ */
export async function favsOnShow(targetEl) {
  const el = targetEl || document.getElementById("view-favs");
  if (!el) return;
  try { await CB.ensureBoot(); } catch { /* 同上 */ }
  renderFavs(el);
}

function favAll() { return CB.favRaw() || {}; }

function renderFavs(el) {
  const raw = favAll();
  /* "有收藏"判定必须看桶内条目数——取消收藏会残留空省桶，仅看桶键会误判 */
  const carrierHas = (c) => { const cb = raw[c] || {}; return Object.values(cb).some(pb => Object.keys(pb).length > 0); };
  /* 选项集与全量计数：从全部收藏提取（运营商/省/归属/资费类型） */
  const provSet = new Set(), ownSet = new Set(), typeSet = new Set();
  let total = 0;
  CARRIER_ORDER.forEach(c => {
    if (!carrierHas(c)) return;
    const cb = raw[c] || {};
    Object.keys(cb).forEach(prov => {
      provSet.add(prov);
      Object.values(cb[prov]).forEach(rec => {
        total++;
        const f = rec.f || {};
        if (f["归属"]) ownSet.add(f["归属"]);
        if (f["资费类型"]) typeSet.add(f["资费类型"]);
      });
    });
  });
  const favSel = (fk, label, opts, val) =>
    `<select class="sel" data-fk="${fk}" title="按${label}筛选"><option value="">全部${label}</option>${opts.map(([v, t]) => `<option value="${esc(v)}" ${v === val ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>`;
  const hasFilter = favFilter.c || favFilter.prov || favFilter.own || favFilter.type || favQ;

  /* 分区模式（tariff.js 三分区框架）：已有 #favTariffBody 子容器，只替换内容区，不抹分区 tab */
  const isPartition = !!el.querySelector("#favTariffBody");
  const bodyId = isPartition ? "favTariffBody" : "favBody";
  const content = total
    ? (isPartition
      ? `<div class="fav-toolbar" style="margin-bottom:10px">${favSel("c", "运营商", CARRIER_ORDER.filter(carrierHas).map(c => [c, carrierName(c)]), favFilter.c)}${favSel("prov", "省份", [...provSet].filter(p => p !== "*").sort().map(p => [p, provLabel(p)]), favFilter.prov)}${favSel("own", "归属", [...ownSet].sort().map(v => [v, v]), favFilter.own)}${favSel("type", "资费类型", [...typeSet].sort().map(v => [v, v]), favFilter.type)}${hasFilter ? `<button type="button" class="btn ghost sm" data-act="favFilterClear">清除筛选</button>` : ""}</div><div id="${bodyId}">${favBodyHTML(raw)}</div><div id="favModalHost"></div>`
      : `<div class="fav-toolbar"><input type="search" class="inp act-search" data-favq placeholder="搜索名称 / 字段…" value="${esc(favQ)}">${favSel("c", "运营商", CARRIER_ORDER.filter(carrierHas).map(c => [c, carrierName(c)]), favFilter.c)}${favSel("prov", "省份", [...provSet].filter(p => p !== "*").sort().map(p => [p, provLabel(p)]), favFilter.prov)}${favSel("own", "归属", [...ownSet].sort().map(v => [v, v]), favFilter.own)}${favSel("type", "资费类型", [...typeSet].sort().map(v => [v, v]), favFilter.type)}${hasFilter ? `<button type="button" class="btn ghost sm" data-act="favFilterClear">清除筛选</button>` : ""}</div><div id="${bodyId}">${favBodyHTML(raw)}</div><div id="favModalHost"></div>`)
    : `<div class="empty" style="padding:40px 0">暂无收藏<br><span style="font-size:12px;opacity:.75">在资费列表条目上点「收藏」即可加入</span></div>`;

  if (isPartition) {
    /* 分区模式：只替换内容区，h1/tabs/搜索框/筛选器已在外层 */
    el.querySelector("#favTariffBody") ? el.querySelector("#favTariffBody").closest(".fav-part-section") : el;
    /* 找内容区容器（可能是直接子节点，也可能在 section 内） */
    const section = el.querySelector(".fav-part-section");
    if (section) section.innerHTML = content;
    else el.innerHTML = content;
  } else {
    /* 全页模式：完整重绘（含 h1/说明） */
    el.innerHTML = `
  <h1 class="page-title">我的收藏</h1>
  <p class="page-sub">全部运营商 × 全部省份的收藏 · 仅存本机浏览器（换设备/清缓存不随行） · 共 ${total} 条 · 点击卡片查看资费详情</p>
  ${content}`;
  }
  /* 事件统一委托到视图容器（el 是静态节点不随 innerHTML 重建） */
  if (!el.dataset.favBound) {
    el.dataset.favBound = "1";
    el.addEventListener("click", favsOnRootClick);
    el.addEventListener("change", (e) => {
      const k = e.target && e.target.dataset ? e.target.dataset.fk : null;
      if (!k) return;
      favFilter[k] = e.target.value;
      renderFavs(el);
    });
  }
  /* 搜索：防抖后仅重绘卡片列表区（不整页重绘，保持输入焦点） */
  const searchEl = el.querySelector("[data-favq]");
  if (searchEl && !searchEl.dataset.bound) {
    searchEl.dataset.bound = "1";
    let timer = 0;
    searchEl.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        favQ = searchEl.value.trim();
        const body = el.querySelector("#favBody") || el.querySelector("#favTariffBody");
        if (body) body.innerHTML = favBodyHTML(favAll());
        const hasF = favFilter.c || favFilter.prov || favFilter.own || favFilter.type || favQ;
        const clr = el.querySelector("[data-act='favFilterClear']");
        if (clr) clr.hidden = !hasF;
      }, 200);
    });
  }
  lazyMarkStatus(el);
}

/* 收藏卡片列表（分组渲染，四渠道 + 搜索叠加过滤） */
function favBodyHTML(raw) {
  const matchF = (rec) => {
    const f = rec.f || {};
    if (favFilter.own && (f["归属"] || "") !== favFilter.own) return false;
    if (favFilter.type && (f["资费类型"] || "") !== favFilter.type) return false;
    if (favQ) {
      const hay = (String(rec.n || "") + " " + JSON.stringify(f)).toLowerCase();
      if (!hay.includes(favQ.toLowerCase())) return false;
    }
    return true;
  };
  const html = CARRIER_ORDER.map(c => {
    if (favFilter.c && c !== favFilter.c) return "";
    const cb = raw[c] || {};
    if (!Object.values(cb).some(pb => Object.keys(pb).length > 0)) return "";   // 空桶运营商不渲染分组
    const rows = [];
    Object.keys(cb).forEach(prov => {
      if (favFilter.prov && prov !== favFilter.prov && prov !== "*") return;
      Object.keys(cb[prov]).forEach(id => {
        const rec = cb[prov][id] || {};
        if (!matchF(rec)) return;
        rows.push({ prov, id, rec });
      });
    });
    if (!rows.length) return "";
    rows.sort((a, b) => (b.rec.t || 0) - (a.rec.t || 0));
    return `
    <section class="fav-group">
      <h2 class="fav-group-title"><span class="cmp-badge c-${esc(c)}">${esc(carrierName(c))}</span><span class="fav-group-n">${rows.length} 条</span></h2>
      <div class="fav-cards">${rows.map(r => favCardHTML(c, r)).join("")}</div>
    </section>`;
  }).join("");
  return html || `<div class="empty" style="padding:32px 0">当前筛选条件下无收藏</div>`;
}

function favEntryByKey(key) {
  const parts = String(key).split(":");
  if (parts.length < 4) return null;
  const [, carrier, prov] = parts;
  const id = parts.slice(3).join(":");
  const rec = ((favAll()[carrier] || {})[prov] || {})[id] || {};
  return { key, kind: "fav", carrier, prov, id, name: rec.n || id, fields: rec.f || (rec.p ? { "资费标准": rec.p } : {}), attr: rec.a || "1" };
}

/* 收藏详情（本地 f 字段渲染，与资费详情 fieldsTable 同款键序与样式） */
function favDetailHTML(entry) {
  const f = entry.fields || {};
  const keys = Object.keys(f);
  if (!keys.length) return `<div class="fav-detail-empty">该收藏未包含完整字段（旧版收藏记录），仅名称与月费可显示</div>`;
  const cell = (k, v) => esc(k === "适用地区" && CB.areaCn ? CB.areaCn(v) : v);
  const mainRows = MAIN_KEYS.filter(k => f[k]).map(k => `<tr class="${fieldClassOf(k)}"><th>${esc(k)}</th><td>${cell(k, f[k])}</td></tr>`).join("");
  const restRows = keys.filter(k => !MAIN_KEYS.includes(k) && !NOTE_KEYS.includes(k) && f[k])
    .map(k => `<tr class="${fieldClassOf(k)}"><th>${esc(k)}</th><td>${cell(k, f[k])}</td></tr>`).join("");
  const notes = NOTE_KEYS.filter(k => f[k]).map(k => `<div class="note-item"><div class="note-label">${esc(k)}</div><div>${esc(f[k])}</div></div>`).join("");
  return `<table class="fields-table">${mainRows}${restRows}</table>${notes ? `<div class="notes-block">${notes}</div>` : ""}`;
}
/* 字段语义配色（与资费详情 fieldClass 同规则，compare.js 本地实现避免反向依赖） */
function fieldClassOf(k) {
  if (/流量/.test(k)) return "sem-data";
  if (/通话|语音/.test(k)) return "sem-call";
  if (/宽带/.test(k)) return "sem-broadband";
  if (/上线|生效/.test(k)) return "sem-online";
  if (/下线|失效|停售/.test(k)) return "sem-offline";
  return "";
}

function favCardHTML(carrier, r) {
  const rec = r.rec || {};
  const key = `fav:${carrier}:${r.prov}:${r.id}`;
  const st = favStatus.get(key);   // "live" | "removed" | undefined
  const entry = { key, kind: "fav", carrier, prov: r.prov, id: String(r.id), name: rec.n || String(r.id), fields: rec.f || (rec.p ? { "资费标准": rec.p } : {}) };
  const f = entry.fields || {};
  const fee = String(f["资费标准"] || "").trim();
  const t = rec.t ? new Date(rec.t) : null;
  const tStr = t ? `${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}` : "";
  const cat = String(f["资费类型"] || "").trim();
  /* 与资费列表卡片同构（tcard + tc-tags 语义胶囊），用户视觉零迁移 */
  const tags = [];
  if (st === "removed") tags.push(`<span class="tag chg-removed">已下架</span>`);
  else if (st === "live") tags.push(`<span class="tag chg-added">在售</span>`);
  if (cat) tags.push(`<span class="tag type-cmp">${esc(cat)}</span>`);
  if (f["国内通用流量"]) tags.push(`<span class="tag sem-data">${esc(f["国内通用流量"])}</span>`);
  if (f["国内通话"]) tags.push(`<span class="tag sem-call">${esc(f["国内通话"])}</span>`);
  return `
  <article class="tcard fav-tcard c-${esc(carrier)}${st === "removed" ? " fav-removed-item" : ""}" data-favkey="${esc(key)}" title="点击查看资费详情">
    <div class="tc-head"><div class="tc-name">${esc(entry.name || "（无名称）")}</div><div class="tc-actions"><span class="fav-prov-tag">${esc(provLabel(r.prov))}</span><button type="button" class="fav-del" data-favdel="${esc(key)}" title="取消收藏">${icon("trash")}</button></div></div>
    ${tags.length ? `<div class="tc-tags">${tags.join("")}</div>` : ""}
    ${fee ? `<div class="tc-price">${esc(fee)}</div>` : ""}
    ${f["适用范围"] ? `<div class="tc-scope">适用：${esc(f["适用范围"])}</div>` : ""}
    <div class="tc-foot"><span class="tc-bo">${esc(carrierName(carrier))}</span>${tStr ? `<span class="tc-date">收藏于 ${esc(tStr)}</span>` : ""}</div>
  </article>`;
}

/* 弹窗头部操作按钮组（复制名称/复制概要/分享）：收藏弹窗与对比详情弹窗共用。
   分享走 plan 深链（页签码取条目 attr，缺省回退 "1"）；导入条目无运营商/省归属，不渲染分享 */
function fmActionsHTML(entry) {
  const shareable = !!(entry.carrier && entry.prov);
  return `<span class="fm-acts">
    <button type="button" class="copy-btn" data-fmact="copyname" title="复制资费名称" aria-label="复制资费名称">${icon("copy")}</button>
    <button type="button" class="copy-btn" data-fmact="copysum" title="复制资费概要" aria-label="复制资费概要">${icon("list")}</button>
    ${shareable ? `<button type="button" class="copy-btn" data-fmact="share" title="分享本条资费（复制链接或唤起系统分享）" aria-label="分享">${icon("share")}</button>` : ""}
  </span>`;
}
function bindFmActs(host, entry) {
  host.querySelectorAll("[data-fmact]").forEach(b => b.addEventListener("click", () => {
    const a = b.dataset.fmact;
    if (a === "copyname") {
      navigator.clipboard.writeText(entry.name || "")
        .then(() => toast("已复制名称")).catch(() => toast("复制失败"));
    } else if (a === "copysum") {
      navigator.clipboard.writeText(favSummaryText(entry))
        .then(() => toast("已复制概要")).catch(() => toast("复制失败"));
    } else if (a === "share") {
      const key = (entry.fields || {})["方案编号"] || entry.name || "";
      shareLink({
        title: entry.name || "资费条目",
        text: "一条资费详情",
        hash: `plan_${entry.carrier}_${entry.prov}_${entry.attr || "1"}_${encodeURIComponent(key)}`,
      });
    }
  }));
}

/* 收藏详情弹窗：运营商色顶线 Hero（大字月费）+ 行式规格列表 + 备注卡片 */
function openFavModal(key) {
  const host = document.getElementById("favModalHost");
  if (!host) return;
  const entry = favEntryByKey(key);
  if (!entry) return;
  const st = favStatus.get(key);
  const stBadge = st === "live" ? `<span class="tag chg-added">在售</span>`
    : st === "removed" ? `<span class="tag chg-removed">已下架</span>` : "";
  const rec = ((favAll()[entry.carrier] || {})[entry.prov] || {})[entry.id] || {};
  const t = rec.t ? new Date(rec.t) : null;
  const tStr = t ? `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}` : "";
  const feeRaw = String((entry.fields || {})["资费标准"] || "").trim() || "—";
  const f = entry.fields || {};
  const subParts = ["资费类型", "归属", "适用范围"].map(k => String(f[k] || "").trim()).filter(Boolean);
  host.innerHTML = `
  <div class="cmp-mask open" data-favm="mask">
    <div class="fav-modal fm-${esc(entry.carrier)}" role="dialog" aria-modal="true">
      <div class="fm-head">
        <span class="cmp-badge c-${esc(entry.carrier)}">${esc(carrierName(entry.carrier))}</span>
        <span class="fav-prov-tag">${esc(provLabel(entry.prov) || "外部导入")}</span>
        ${stBadge}
        ${fmActionsHTML(entry)}
        <button type="button" class="cmp-close" data-favm="close" aria-label="关闭">&times;</button>
      </div>
      <div class="fm-titlebar">
        <div class="fm-name">${esc(entry.name || "（无名称）")}</div>
        <div class="fm-price">${esc(feeRaw)}</div>
      </div>
      ${subParts.length ? `<div class="fm-sub">${subParts.map(s => esc(s)).join("<i class='fm-sub-dot'></i>")}</div>` : ""}
      <div class="fm-quick"><span>${esc(flowText(f))}</span><span>${esc(callText(f))}</span>${tStr ? `<span class="fm-t">收藏于 ${esc(tStr)}</span>` : ""}</div>
      <div class="fm-body">${favRowsHTML(entry)}</div>
    </div>
  </div>`;
  mountIcons(host);
  bindFmActs(host, entry);
  const mask = host.querySelector(".cmp-mask");
  mask.addEventListener("click", (e) => { if (e.target.dataset.favm === "mask") host.innerHTML = ""; });
  host.querySelector("[data-favm='close']").addEventListener("click", () => { host.innerHTML = ""; });
}

/* 对比卡片详情弹窗：复用收藏弹窗（fm-*）设计语言，快照/收藏/导入来源条目通用。
   挂载在 cmpModalHost（独立于 cmpLayerHost——明细对比层内点「详情」时需叠在其上；
   compareOnHide 离开视图时统一清空）；
   不做在售/已下架懒判定与收藏时间展示（那是收藏页专属上下文） */
function openCmpModal(entry) {
  if (!entry) return;
  const host = document.getElementById("cmpModalHost");
  if (!host) return;
  const f = entry.fields || {};
  const feeRaw = String(f["资费标准"] || "").trim() || "—";
  const subParts = ["资费类型", "归属", "适用范围"].map(k => String(f[k] || "").trim()).filter(Boolean);
  const isImp = entry.kind === "import";
  host.innerHTML = `
  <div class="cmp-mask open" data-favm="mask">
    <div class="fav-modal ${isImp ? "" : `fm-${esc(entry.carrier)}`}" role="dialog" aria-modal="true">
      <div class="fm-head">
        ${isImp
          ? `<span class="fav-prov-tag">外部导入</span>`
          : `<span class="cmp-badge c-${esc(entry.carrier)}">${esc(carrierName(entry.carrier))}</span><span class="fav-prov-tag">${esc(provLabel(entry.prov) || "—")}</span>`}
        ${fmActionsHTML(entry)}
        <button type="button" class="cmp-close" data-favm="close" aria-label="关闭">&times;</button>
      </div>
      <div class="fm-titlebar">
        <div class="fm-name">${esc(entry.name || "（无名称）")}</div>
        <div class="fm-price">${esc(feeRaw)}</div>
      </div>
      ${subParts.length ? `<div class="fm-sub">${subParts.map(s => esc(s)).join("<i class='fm-sub-dot'></i>")}</div>` : ""}
      <div class="fm-quick"><span>${esc(flowText(f))}</span><span>${esc(callText(f))}</span></div>
      <div class="fm-body">${favRowsHTML(entry)}</div>
    </div>
  </div>`;
  mountIcons(host);
  bindFmActs(host, entry);
  const mask = host.querySelector(".cmp-mask");
  mask.addEventListener("click", (e) => { if (e.target.dataset.favm === "mask") host.innerHTML = ""; });
  host.querySelector("[data-favm='close']").addEventListener("click", () => { host.innerHTML = ""; });
}

/* 行式规格列表：label 左 value 右，虚线分隔（去表格边框），语义色落在 label 上。
   已在弹窗头部直观展示的键（月费/流量/通话 + 副标题的类型/归属/范围）不重复出列 */
function favRowsHTML(entry) {
  const f = entry.fields || {};
  const skip = new Set(["资费标准", "国内通用流量", "国内通话", "资费类型", "归属", "适用范围"]);
  const keys = Object.keys(f).filter(k => f[k] && String(f[k]).trim() && !skip.has(k));
  if (!keys.length) return `<div class="fm-empty">关键信息已全部展示在上方</div>`;
  const cell = (k, v) => esc(k === "适用地区" && CB.areaCn ? CB.areaCn(v) : v);
  const row = (k) => `<div class="fm-row ${fieldClassOf(k)}"><span class="k">${esc(k)}</span><span class="v">${cell(k, f[k])}</span></div>`;
  const main = MAIN_KEYS.filter(k => keys.includes(k)).map(row).join("");
  const rest = keys.filter(k => !MAIN_KEYS.includes(k) && !NOTE_KEYS.includes(k)).map(row).join("");
  const notes = NOTE_KEYS.filter(k => keys.includes(k)).map(k =>
    `<div class="fm-note"><div class="nk">${esc(k)}</div><div class="nv">${cell(k, f[k])}</div></div>`).join("");
  return `${main ? `<div class="fm-rows">${main}</div>` : ""}${rest ? `<div class="fm-rows">${rest}</div>` : ""}${notes ? `<div class="fm-notes">${notes}</div>` : ""}`;
}

function favsOnRootClick(e) {
  const actBtn = e.target.closest("[data-act='favFilterClear']");
  if (actBtn) {
    favFilter = { c: "", prov: "", own: "", type: "" };
    favQ = "";
    const el = document.getElementById("view-favs");
    const searchEl = el && el.querySelector("[data-favq]");
    if (searchEl) searchEl.value = "";
    if (el) renderFavs(el);
    return;
  }
  const delBtn = e.target.closest("[data-favdel]");
  if (delBtn) {
    e.stopPropagation();
    const key = delBtn.dataset.favdel || "";
    const parts = key.split(":");
    if (parts.length >= 4) {
      CB.removeFav(parts[1], parts[2], parts.slice(3).join(":"));
      favStatus.delete(key);   // 清除状态缓存：重新收藏同条目时状态需重新判定
      const el = document.getElementById("view-favs");
      if (el) renderFavs(el);
      toast("已取消收藏");
    }
    return;
  }
  /* 点击卡片 → 弹窗展示资费详情（复制/概要/分享按钮已挪入弹窗头部，见 bindFmActs） */
  const card = e.target.closest("[data-favkey]");
  if (card && card.dataset.favkey) openFavModal(card.dataset.favkey);
}

/* 概要文本（与资费列表 summaryOf 同键序/同格式，供"复制概要"与导入解析闭环） */
function favSummaryText(entry) {
  const f = entry.fields || {};
  const lines = [];
  if (entry.name) lines.push("名称：" + entry.name);
  const push = (k) => {
    const v = f[k];
    if (v == null || String(v).trim() === "") return;
    lines.push(k + "：" + (k === "适用地区" && CB.areaCn ? CB.areaCn(v) : String(v)));
  };
  MAIN_KEYS.forEach(push);
  Object.keys(f).filter(k => !MAIN_KEYS.includes(k) && !NOTE_KEYS.includes(k)).forEach(push);
  NOTE_KEYS.forEach(push);
  return lines.join("\n");
}

/* ── 在售/已下架懒判定：每个收藏桶 (carrier, prov) 用【自己】的快照判定 ──
   ⚠ 严禁串桶：此前版本任一快照回来会给全部条目设状态（先到先得锁死），
   导致 A 省快照把 B 省/他运营商条目误判成"已下架" */
function lazyMarkStatus(el) {
  const raw = favAll();
  const combos = new Set();
  CARRIER_ORDER.forEach(c => {
    const cb = raw[c] || {};
    Object.keys(cb).forEach(prov => { if (prov !== "*") combos.add(c + "|" + prov); });
  });
  combos.forEach(ck => {
    if (favStatusTried.has(ck)) { applyStatus(el, ck); return; }
    favStatusTried.add(ck);
    const [carrier, prov] = ck.split("|");
    CB.loadSnapFor(carrier, prov).then(snap => {
      if (!snap || snap.carrier !== carrier) throw new Error("快照归属不匹配");
      const ids = new Set((snap.items || []).map(it => String(it.id)));
      const pb = (favAll()[carrier] || {})[prov] || {};
      Object.keys(pb).forEach(id => {
        favStatus.set(`fav:${carrier}:${prov}:${id}`, ids.has(String(id)) ? "live" : "removed");
      });
      applyStatus(el, ck);
    }).catch(() => { /* 拉取失败不标注（不误判），favStatusTried 已记录避免重复请求 */ });
  });
}

function applyStatus(el, ck) {
  if (!el || !el.isConnected) return;
  const [carrier, prov] = ck.split("|");
  const cb = favAll()[carrier] || {};
  const pb = cb[prov] || {};
  Object.keys(pb).forEach(id => {
    const k = `fav:${carrier}:${prov}:${id}`;
    const st = favStatus.get(k);
    if (!st) return;
    const card = el.querySelector(`.fav-tcard[data-favkey="${CSS.escape(k)}"]`);
    if (!card || card.querySelector(".fav-st-tag")) return;   // 已标注的跳过
    let tags = card.querySelector(".tc-tags");
    if (!tags) { tags = document.createElement("div"); tags.className = "tc-tags"; card.querySelector(".tc-head").after(tags); }
    tags.insertAdjacentHTML("afterbegin", st === "live"
      ? `<span class="tag chg-added fav-st-tag">在售</span>`
      : `<span class="tag chg-removed fav-st-tag">已下架</span>`);
    if (st === "removed") card.classList.add("fav-removed-item");
  });
  mountIcons(el);
}

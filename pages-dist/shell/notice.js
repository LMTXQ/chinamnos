/* ═══════════════════════════════════════════════════════════════
   NoticeGate — 站长可配的公告/警告弹窗门控（可复用核心）
   ───────────────────────────────────────────────────────────────
   ▸ 数据：GET /api/notices（anon，HTTP 缓存 60s；模块内再缓存 60s）
     { site_notice: {enabled, title, version, content},
       promos: [{id, version, title, content, mode, scope{carriers,provinces,modules}}] }
     version = content 的保存时间（站长改内容自动变，登录用户据此「内容变更重新同意」）
   ▸ 弹窗模式：
     must     强制同意（无×，ESC/遮罩无效）——跳蚤市集警告/强制型推广
     closable 可关闭 + 勾选「今日不再弹出」——全站公告/常规推广
   ▸ 同意记录（设备级 localStorage，chinamnos_ack_* 命名空间，按实例隔离）：
     promo_{id}      推广条目（含跳蚤市集警告，其已迁移为 mode=must、modules=["cardhub"]
                     的推广条目 promo_cardhub_warning，migration 0030）：must=访客每日/
                     登录首次+版本变更重弹；closable=「今日不再」skip 记录
     site_notice_skip   公告勾选「今日不再」的日期字符串（不勾直接关=下次还弹）
   ▸ 模块级弹窗：推广条目 scope.modules 填模块 id（tariff/cardhub/ticket/tools），
     由 shell.js activate → maybePromosOnModuleEnter(页面id) 在进入该模块时判定弹出
   ▸ 新增全站弹窗：后台 settings 加 {ns}_enabled/{ns}_content 键 + notices.ts 暴露 +
     本文件加一个 maybe{Xxx}()（数行），一行接入页面即可
   ═══════════════════════════════════════════════════════════════ */
"use strict";

import { api } from "./api.js";
import { mdToSafeHtml } from "./md.js";
import { getPubConfig } from "./pubcfg.js";

/* ── 工具 ── */
const LS_PREFIX = "chinamnos_ack_";
const today = () => {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
};
/* 同意记录迁父域 cookie（.ftac.dpdns.org）：三线共享，切线后公告/警告不重复弹。
   仅 3 个固定小键（日期/版本字符串），无 cookie 膨胀风险；
   cookie 优先、localStorage 兜底（旧记录惰性迁移），双写一个版本周期后可移除 localStorage 读法 */
const CK_DOMAIN = ".ftac.dpdns.org";
const lsGet = (k) => {
  try {
    const m = document.cookie.match(new RegExp("(?:^|;\\s*)" + k + "=([^;]*)"));
    if (m) return decodeURIComponent(m[1]);
    const ls = localStorage.getItem(k);
    if (ls) { try { document.cookie = k + "=" + encodeURIComponent(ls) + "; Domain=" + CK_DOMAIN + "; Path=/; Secure; SameSite=Lax; Max-Age=" + 400 * 86400; } catch { /* 忽略 */ } }
    return ls;
  } catch { return null; }
};
const lsSet = (k, v) => {
  try { localStorage.setItem(k, v); } catch { /* 隐私模式等忽略 */ }
  try {
    document.cookie = k + "=" + encodeURIComponent(v) + "; Domain=" + CK_DOMAIN +
      "; Path=/; Secure; SameSite=Lax; Max-Age=" + 400 * 86400;   // 登录用户「永不重弹」需长于 token 有效期
  } catch { /* 忽略 */ }
};

/* ── mini Markdown → 安全 HTML：渲染器已下沉至 shell/md.js 共享模块
   （notice / 情报酒馆 / 后台预览共用同一实现；本文件仅保留弹窗门控逻辑） ── */

/* ── 数据（模块级 60s TTL 缓存；快照优先，缺失回落 /api/notices） ──
   export 供「公告推广」页签复用（同一缓存，零额外请求） */
let _cache = null;
let _cacheAt = 0;
export async function loadNotices() {
  if (_cache && Date.now() - _cacheAt < 60000) return _cache;
  const pc = await getPubConfig();
  if (pc && pc.notices) {
    _cache = pc.notices;
    _cacheAt = Date.now();
    return _cache;
  }
  const r = await api.request("/api/notices");
  _cache = r.ok && r.data ? r.data : { site_notice: { enabled: false } };
  _cacheAt = Date.now();
  return _cache;
}

/* ── 串行队列：公告/警告同屏时依次弹，不叠加 ── */
let _queue = Promise.resolve();
const enqueue = (task) => { _queue = _queue.then(task).catch(() => { /* 单个实例失败不阻塞队列 */ }); return _queue; };

/* ── 弹窗（body 直下单例）──
   must：无关闭路径（ESC/遮罩无效），只能点「我已阅读并同意」
   closable：ESC/遮罩/关闭按钮均可关；勾选「今日不再」时写 skip 标记 */
let _active = null; // { mask, resolve, mode, ns }
function closeNoticeModal(result) {
  if (!_active) return;
  const { mask, resolve } = _active;
  _active = null;
  document.removeEventListener("keydown", onNoticeKeydown);
  mask.classList.add("ng-out");
  setTimeout(() => { mask.remove(); }, 180);
  resolve(result);
}
function onNoticeKeydown(e) {
  if (e.key === "Escape" && _active && _active.mode === "closable") closeNoticeModal("close");
}
function openNoticeModal({ ns, title, bodyHtml, mode, checkboxText }) {
  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "ng-mask" + (mode === "must" ? " ng-must" : "");
    mask.innerHTML =
      '<div class="ng-modal" role="dialog" aria-modal="true">' +
      '<div class="ng-head"><span class="ng-head-t"></span></div>' +
      '<div class="ng-body"></div>' +
      '<div class="ng-foot">' +
      (checkboxText ? '<label class="ng-skip"><input type="checkbox" id="ngSkip"><span>' + checkboxText + "</span></label>" : "") +
      '<button type="button" class="btn primary" id="ngAck"></button>' +
      "</div></div>";
    mask.querySelector(".ng-head-t").textContent = title;
    mask.querySelector(".ng-body").innerHTML = bodyHtml;
    const ackBtn = mask.querySelector("#ngAck");
    ackBtn.textContent = mode === "must" ? "我已阅读并同意" : "关闭";
    /* 挂 <html> 而非 <body>：页面切换时 onEnter 会整页重写 body.innerHTML，
       挂 body 直下的弹窗会被连带删除（公告弹出后切页即消失的根因）；
       html 直下免于清空，fixed 定位与 z-index 行为不变（同 .aurora-blob 先例） */
    document.documentElement.appendChild(mask);
    _active = { mask, resolve, mode, ns };
    document.addEventListener("keydown", onNoticeKeydown);

    ackBtn.addEventListener("click", () => {
      const skipEl = mask.querySelector("#ngSkip");
      if (mode === "closable" && skipEl && skipEl.checked) {
        lsSet(LS_PREFIX + ns + "_skip", today());
      }
      closeNoticeModal("ack");
    });
    if (mode === "closable") {
      /* 遮罩点击 = 直接关（不记勾选，下次仍弹） */
      mask.addEventListener("click", (e) => { if (e.target === mask) closeNoticeModal("close"); });
    }
  });
}

/* ── 实例一：全站公告（closable）──
   所有人每日首次进入弹；勾选「今日不再弹出」后当天不再弹（不勾直接关 = 刷新仍弹）。
   本次页面生命周期只处理一次（站内 hash 切换不重复弹；刷新重置） */
let _siteNoticeHandled = false;
export function maybeSiteNotice() {
  if (_siteNoticeHandled) return _queue;
  _siteNoticeHandled = true;
  return enqueue(async () => {
    const notices = await loadNotices();
    const n = notices.site_notice;
    if (!n || !n.enabled || !n.content) return;
    if (lsGet(LS_PREFIX + "site_notice_skip") === today()) return;
    await openNoticeModal({
      ns: "site_notice",
      title: n.title || "站点公告",
      bodyHtml: mdToSafeHtml(n.content),
      mode: "closable",
      checkboxText: "今日不再弹出",
    });
  });
}

/* ── 实例二：推广（可多条，closable|must，范围过滤）──
   范围匹配基准 = 访客当前在站内选择的运营商与省份（tariff 模块的 localStorage 记忆）
                + 当前进入的模块（scope.modules，tariff/cardhub/ticket/tools…页面注册 id）：
   scope.carriers / scope.provinces / scope.modules 为空数组 = 不限；非空 = 当前上下文须在列表内。
   判定归属由 modules 维度决定：modules 空 = 全站条目（进站判定 + 运营商/省份切换触发）；
   modules 非空 = 模块条目（仅进入对应模块时判定，运营商/省份切换不触发）。
   频率延用公告两档：closable = 每日一次（可勾「今日不再」）；must = 访客每日 / 登录首次+版本变更。
   同意记录 chinamnos_ack_promo_{id}（已迁父域 cookie，三线共享）。逐条 await 串行入队——
   公告实例先调用先入队，推广自然排在公告之后。 */
/* 会话内已弹过的推广 id：切换运营商/省份的重复判定不再端出弹过的内容
   （进入站点期间每条只弹一次；刷新重置。跨会话的「今日不再」由 skip 记录与 ack 记录负责） */
const _promotedInSession = new Set();

/* 当前运营商/省份（tariff 的 localStorage 记忆；回退站点默认，与 tariff.js defCode 一致：
   访客未显式选择时页面显示的就是默认值，范围匹配应按「所见即所判」命中，而非视为未知跳过） */
function currentCarrierProv() {
  let curCarrier = "", curProv = "";
  try {
    curCarrier = (localStorage.getItem("default_carrier") || "").toLowerCase();
    if (curCarrier) curProv = (localStorage.getItem(curCarrier + "_v2_prov") || "").toLowerCase();
  } catch { /* 隐私模式等忽略 */ }
  if (!curCarrier) curCarrier = "cmcc";
  if (!curProv) curProv = "hun";
  return { curCarrier, curProv };
}

/* 范围匹配（三维同时配置 = 与关系）：moduleId 传 undefined = 全站判定（模块条目不参与），
   传模块 id = 模块进入判定（仅命中声明了该模块的条目）
   export 供「公告推广」页签「当前范围」过滤复用（单一事实来源） */
export function scopeMatch(p, curCarrier, curProv, moduleId) {
  const sc = p.scope || {};
  const carriers = Array.isArray(sc.carriers) ? sc.carriers : [];
  const provinces = Array.isArray(sc.provinces) ? sc.provinces : [];
  const modules = Array.isArray(sc.modules) ? sc.modules : [];
  if (moduleId === undefined) {
    if (modules.length) return false;   // 模块条目不参与全站判定
  } else {
    if (!modules.length || !modules.includes(moduleId)) return false;   // 全站条目/其他模块条目不参与
  }
  /* 范围过滤：指定了运营商但当前运营商不在列表 → 跳过；省份同理 */
  if (carriers.length && (!curCarrier || !carriers.includes(curCarrier))) return false;
  if (provinces.length && (!curProv || !provinces.includes(curProv))) return false;
  return true;
}

async function maybePromoOne(p) {
  if (_promotedInSession.has(p.id)) return;   // 会话内已弹过 → 不重复
  const ns = "promo_" + p.id;
  const loggedIn = api.isLoggedIn();
  const key = LS_PREFIX + ns + (loggedIn ? "_u" : "");
  let rec = null;
  try { rec = JSON.parse(lsGet(key) || "null"); } catch { rec = null; }
  if (p.mode === "must") {
    if (loggedIn) { if (rec && rec.v === p.version) return; }
    else if (rec && rec.d === today() && rec.v === p.version) return;
  } else if (lsGet(LS_PREFIX + ns + "_skip") === today()) return;
  _promotedInSession.add(p.id);
  await openNoticeModal({
    ns,
    title: p.title || "推广",
    bodyHtml: mdToSafeHtml(p.content),
    mode: p.mode === "must" ? "must" : "closable",
    checkboxText: p.mode === "must" ? undefined : "今日不再弹出",
  });
  lsSet(key, JSON.stringify(loggedIn ? { v: p.version } : { d: today(), v: p.version }));
}

export function maybePromos() {
  return judgePromos();
}

/* 切换运营商/省份入口（tariff.js 调用）：仅当站长开启「切换重弹」时判定（未配置 = 默认开启）。
   同意记录/勾选「今日不再」天然防重——重复切换不会重复弹同一条内容 */
export async function maybePromosOnSwitch() {
  const notices = await loadNotices();
  if (notices && notices.promo_reswitch === false) return _queue;
  return judgePromos();
}

/* 模块进入入口（shell.js activate 传入 page.id）：仅判 modules 命中该模块的条目。
   不受「切换重弹」开关约束——模块进入本身就是模块条目的唯一触发点，
   防重由同意记录/「今日不再」/会话集合负责 */
export function maybePromosOnModuleEnter(moduleId) {
  if (!moduleId) return _queue;
  return judgePromosForModule(String(moduleId));
}

function judgePromos() {
  return enqueue(async () => {
    const notices = await loadNotices();
    /* 防御性过滤 enabled=false（Worker 已过滤，但快照可能被直接注入原始数据） */
    const list = (Array.isArray(notices.promos) ? notices.promos : []).filter((p) => p && p.enabled !== false);
    if (!list.length) return;
    const { curCarrier, curProv } = currentCarrierProv();
    for (const p of list) {
      if (!scopeMatch(p, curCarrier, curProv, undefined)) continue;
      await maybePromoOne(p);
    }
  });
}

function judgePromosForModule(moduleId) {
  return enqueue(async () => {
    const notices = await loadNotices();
    const list = (Array.isArray(notices.promos) ? notices.promos : []).filter((p) => p && p.enabled !== false);
    if (!list.length) return;
    const { curCarrier, curProv } = currentCarrierProv();
    for (const p of list) {
      if (!scopeMatch(p, curCarrier, curProv, moduleId)) continue;
      await maybePromoOne(p);
    }
  });
}

/* ═══════════════════════════════════════════════════════════════
   管理后台 — 仅 owner / admin 可访问
   ───────────────────────────────────────────────────────────────
   ▸ 七个标签页：概览 / 审核 / 帖子 / 中转 / 用户 / 日志 / 设置
   ▸ 统一确认弹窗（admConfirm），危险操作全部二次确认
   ▸ 帖子 / 用户 / 日志均支持筛选、搜索、分页（后端分页）
   ▸ 所有管理写操作由后端自动写入审计日志
   ═══════════════════════════════════════════════════════════════ */
"use strict";

import { Shell, esc, theme } from "../../shell/shell.js";
import { icon, mountIcons, toast, showPageLoading, hidePageLoading } from "../../shell/ui.js";
import { mountAppsMenu } from "../../shell/apps-menu.js";
import { Auth, mountAuth } from "../../shell/auth.js";
import { api } from "../../shell/api.js";
import { NOTIFY_KIND_LABELS } from "../../shell/notify-kinds.js";
import { viewFromProjection, renderListCard, renderDetailBody, BOARD_PRICE } from "../../shell/post-view.js";
import { mdToSafeHtml, mdCreateEditor } from "../../shell/md.js";

const $ = (id) => document.getElementById(id);

/* ── 标签页定义（icon 必须存在于 ui.js ICONS） ── */
const TABS = [
  { id: "stats", label: "概览", icon: "chart" },
  { id: "review", label: "审核", icon: "shield" },
  { id: "posts", label: "帖子", icon: "list" },
  { id: "tickets", label: "工单", icon: "keyboard" },
  { id: "acts", label: "酒馆", icon: "trendingUp" },
  { id: "nav", label: "宝库", icon: "link", ownerOnly: true },
  { id: "relay", label: "中转", icon: "repeat" },
  { id: "users", label: "用户", icon: "user" },
  { id: "logs", label: "日志", icon: "clock" },
  { id: "promos", label: "公告", icon: "bell" },
  { id: "settings", label: "设置", icon: "sliders" },
];

/* ── 显示名映射 ── */
const STATUS_LABELS = { pending: "待审核", open: "在售中", rejected: "已拒绝", closed: "已下架", expired: "已过期" };
const BOARD_LABELS = { lost: "求购", found: "出让", rent_out: "出租", rent_want: "求租" };
const CARRIER_LABELS = { cmcc: "移动", cucc: "联通", ctcc: "电信", cbn: "广电" };
const ROLE_LABELS = { owner: "站长", admin: "管理员", user: "普通用户" };
const ACTION_LABELS = {
  review_post: "审核通过", reject_post: "审核拒绝", close_post: "下架帖子", delete_post: "删除帖子",
  ban_user: "封禁用户", unban_user: "解封用户", set_role: "调整角色",
  update_setting: "修改设置", relay_handle: "处理中转", update_user_profile: "修改用户资料", set_title: "设置头衔",
};

/* ── 模块状态：列表页各自维护筛选与分页游标 ── */
let state = {
  tab: "stats",
  stats: null,
  pending: [],
  pendingNav: [],       // 觅珍集库待审（仅站长拉取）
  pendingActs: [],      // 活动集锦待审（管理员即可审核）
  reviewFilter: { source: "", board: "" }, // 审核 Tab 筛选：来源（跳蚤市集/觅珍集库/活动集锦）+ 板块
  acts: [],             // 活动全量列表（活动 Tab，客户端按状态筛选）
  actStatus: "",        // 活动 Tab 状态筛选
  actMode: "",          // 活动 Tab 板块筛选：''=全部 | official=官方活动 | guide=个人攻略 | chat=唠嗑社群
  actEditId: "",        // 当前编辑中的条目 id（编辑面板展开时非空）
  actEditor: null,      // 攻略正文 mdCreateEditor 实例（guide 编辑面板挂载期存在）
  actQrNew: null,       // 编辑面板中新选的二维码 {data,w,h}（保存时随 PUT 上传替换现图）
  relay: [],
  relayStatus: "open",
  settings: [],
  posts: { items: [], total: 0, page: 1, pageSize: 20, status: "", board: "", q: "" },
  tickets: { items: [], status: "", openId: "", detail: null },
  nav: { items: [], status: "pending", editId: "" },
  users: { items: [], total: 0, page: 1, pageSize: 20, status: "", q: "" },
  logs: { items: [], total: 0, page: 1, action: "" },
  promos: { editId: "" },   // 推广管理：条目数据实时解析自 settings 的 promos 键
};

function fmtTime(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0") + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

/* ═══════════════ 确认弹窗 ═══════════════
   admConfirm({ title, message, input, value, placeholder, okText, danger })
   → 确认返回 true（无输入框）或输入字符串；取消/ESC/点遮罩返回 null。 */
function admConfirm(opts) {
  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "adm-modal-mask";
    const hasInput = !!opts.input;
    mask.innerHTML = `
      <div class="adm-modal" role="dialog" aria-modal="true">
        <div class="adm-modal-title">${esc(opts.title || "确认操作")}</div>
        ${opts.message ? `<div class="adm-modal-msg">${esc(opts.message)}</div>` : ""}
        ${hasInput ? `<input class="inp adm-modal-inp" id="admModalInp" placeholder="${esc(opts.placeholder || "")}" value="${esc(opts.value || "")}">` : ""}
        <div class="adm-modal-btns">
          <button class="btn ghost" data-m="cancel">取消</button>
          <button class="btn ${opts.danger ? "danger" : "primary"}" data-m="ok">${esc(opts.okText || "确定")}</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    const inp = mask.querySelector("#admModalInp");
    if (inp) { inp.focus(); inp.select(); }
    const close = (val) => { mask.remove(); document.removeEventListener("keydown", onKey); resolve(val); };
    const onKey = (e) => { if (e.key === "Escape") close(null); if (e.key === "Enter" && !e.isComposing) mask.querySelector('[data-m="ok"]').click(); };
    document.addEventListener("keydown", onKey);
    mask.addEventListener("mousedown", (e) => { if (e.target === mask) close(null); });
    mask.addEventListener("click", (e) => {
      const b = e.target.closest("[data-m]");
      if (!b) return;
      if (b.dataset.m === "cancel") close(null);
      else close(hasInput ? (inp.value.trim() || "") : true);
    });
  });
}

/* ═══════════════ 分页条 ═══════════════ */
function pager(total, page, pageSize, act) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return `
    <div class="adm-pager">
      <span class="adm-meta">共 ${total} 条 · 第 ${page}/${pages} 页</span>
      <div class="adm-actions">
        <button class="btn ghost sm" ${page <= 1 ? "disabled" : ""} data-act="${act}" data-page="${page - 1}">上一页</button>
        <button class="btn ghost sm" ${page >= pages ? "disabled" : ""} data-act="${act}" data-page="${page + 1}">下一页</button>
      </div>
    </div>`;
}

/* ═══════════════ 骨架 ═══════════════ */
function skeleton() {
  return `
<div id="adminRoot">
<header class="adm-topbar">
  <div class="adm-brand">
    <button class="icon-btn" data-act="goBack" title="返回"><i data-icon="back"></i></button>
    <div class="adm-logo"><i data-icon="shield"></i></div>
    <div class="adm-brand-text">管理后台</div>
  </div>
  <div class="adm-actions">
    <div id="admAppsMenuSlot"></div>
    <div id="adminAuthSlot"></div>
    <button class="icon-btn" data-act="goConfig" title="配置生成工具（运维）"><i data-icon="sliders"></i></button>
    <button class="icon-btn" id="adminThemeBtn" title="切换主题"></button>
  </div>
</header>

<div class="adm-wrap">
  <nav class="adm-tabs-row">
    <div class="adm-tabs" id="admTabs">
      ${TABS.filter((t) => !t.ownerOnly || Auth.isOwner()).map((t) => `<button class="adm-tab${t.id === state.tab ? " active" : ""}" data-tab="${t.id}"><i data-icon="${t.icon}"></i>${t.label}</button>`).join("")}
    </div>
    <button class="icon-btn" data-act="refresh" title="刷新当前页"><i data-icon="refresh"></i></button>
  </nav>
  <main id="admBody"></main>
</div>
</div>`;
}

/* ═══════════════ 渲染 ═══════════════ */
function render() {
  const root = $("adminRoot");
  if (!root) return;
  root.querySelectorAll(".adm-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
  const body = $("admBody");
  if (!body) return;
  body.innerHTML = renderTab();
  mountIcons(body);
  mountSettingMdEditors();
  mountActEditEditor();   // 情报酒馆编辑面板（guide 攻略正文编辑器，面板存在时挂载）
  setTimeout(loadAdminProofs, 0); // 审核队列证明材料缩略图（带鉴权 blob 加载）
}

/* 审核队列证明材料缩略图：<img> 不带 Authorization 头，走 blob 加载 */
function loadAdminProofs() {
  document.querySelectorAll("img[data-adminproof]").forEach((img) => {
    if (img.dataset.loaded) return;
    img.dataset.loaded = "1";
    const [pid, key] = (img.dataset.adminproof || "").split("|");
    if (!pid || !key) return;
    api.proofBlobUrl(pid, key).then((u) => { img.src = u; })
      .catch(() => { img.classList.add("dead"); });
  });
}

function renderTab() {
  switch (state.tab) {
    case "stats": return renderStats();
    case "review": return renderReview();
    case "posts": return renderPosts();
    case "tickets": return renderTickets();
    case "nav": return state.nav ? renderNav() : "";
    case "relay": return renderRelay();
    case "users": return renderUsers();
    case "logs": return renderLogs();
    case "promos": return renderPromos();
    case "acts": return renderActs();
    case "settings": return renderSettings();
    default: return "";
  }
}

function card(label, value, sub) {
  return `<div class="adm-card"><div class="adm-card-val">${esc(value)}</div><div class="adm-card-label">${esc(label)}</div>${sub ? `<div class="adm-card-sub">${esc(sub)}</div>` : ""}</div>`;
}

function renderStats() {
  const s = state.stats;
  if (!s) return `<div class="adm-empty">加载中…</div>`;
  return `
    <div class="adm-grid">
      ${card("用户总数", s.users?.total ?? "-", `封禁 ${s.users?.banned ?? 0} · 管理员 ${s.users?.admins ?? 0}`)}
      ${card("待审核", s.posts?.pending ?? "-")}
      ${card("在售中", s.posts?.open ?? "-")}
      ${card("已拒绝", s.posts?.rejected ?? "-")}
      ${card("已下架", s.posts?.closed ?? "-")}
      ${card("已过期", s.posts?.expired ?? "-")}
      ${card("对话总数", s.conversations?.total ?? "-")}
      ${card("中转待处理", s.relayRequests?.open ?? "-", `已处理 ${s.relayRequests?.handled ?? 0}`)}
      ${card("待处理工单", s.tickets?.open ?? "-", `已回复 ${s.tickets?.replied ?? 0} · 已关闭 ${s.tickets?.closed ?? 0}`)}
    </div>`;
}

/* ── 审核队列 ── */
/* 帖子交易方式摘要（extra_json.trade_methods；旧帖无此字段不显示） */
const TRADE_LABELS = { offline: "线下手拉手", xianyu: "闲鱼等二手平台", merchant: "圈内卡商担保", site: "站点担保" };
function renderTradeMethods(p) {
  const raw = p.extra_json || p.extra;
  let tm = [];
  try { tm = JSON.parse(raw || "{}").trade_methods || []; } catch { /* */ }
  if (!Array.isArray(tm) || !tm.length) return "";
  const names = tm.map((t) => TRADE_LABELS[t] || t).join(" / ");
  return `<div class="adm-trade"><b>交易方式：</b>${esc(names)}${tm.includes("site") ? "" : ' <span style="color:var(--muted)">（未含站点担保）</span>'}</div>`;
}


/* ── 审核中心：跳蚤市集帖子 + 觅珍集库提交（觅珍集库仅站长）统一列表，来源/板块筛选 ── */
/* 筛选选项动态生成：来源/板块 chip 由当前待审数据统计而来——有什么才显示什么（含数量徽章），
   管理员拉不到觅珍集库数据则自然不显示觅珍集库项，无需写死枚举与权限判断 */
function reviewFilterHTML() {
  const f = state.reviewFilter;
  const chip = (act, v, label, count, active) => `<button type="button" class="rv-chip${active ? " active" : ""}" data-act="${act}" data-v="${v}">${label}${count ? ` <span class="rv-chip-n">${count}</span>` : ""}</button>`;
  const navCount = (state.pendingNav || []).length;
  const actCount = (state.pendingActs || []).length;
  const postTotal = state.pending.length;
  const sourceRow = `
    <div class="rv-filter-row">
      <span class="rv-filter-label">来源</span>
      ${chip("reviewSrc", "", "全部", postTotal + navCount + actCount, !f.source)}
      ${postTotal ? chip("reviewSrc", "cardhub", "跳蚤市集", postTotal, f.source === "cardhub") : ""}
      ${navCount ? chip("reviewSrc", "nav", "觅珍集库", navCount, f.source === "nav") : ""}
      ${actCount ? chip("reviewSrc", "acts", "情报酒馆", actCount, f.source === "acts") : ""}
    </div>`;
  if (f.source === "nav" || f.source === "acts") return `<div class="rv-filters">${sourceRow}</div>`;
  const boardCount = {};
  for (const p of state.pending) boardCount[p.board] = (boardCount[p.board] || 0) + 1;
  const boards = ["found", "lost", "rent_out", "rent_want"].filter((b) => boardCount[b]);
  const boardRow = boards.length ? `
    <div class="rv-filter-row">
      <span class="rv-filter-label">板块</span>
      ${chip("reviewBoard", "", "全部", postTotal, !f.board)}
      ${boards.map((b) => chip("reviewBoard", b, BOARD_LABELS[b] || b, boardCount[b], f.board === b)).join("")}
    </div>` : "";
  return `<div class="rv-filters">${sourceRow}${boardRow}</div>`;
}

/* 跳蚤市集帖子待审卡：来源/板块彩色标签 + 规格 chips + 描述两行 + 证明材料缩略图 */
function reviewPostCard(p) {
  let extra = {};
  try { extra = JSON.parse(p.extra_json || "{}"); } catch { /* */ }
  const specChips = [];
  if (extra.package_name) specChips.push(`<span class="rv-spec">${esc(extra.package_name)}</span>`);
  /* 价格摘要：按板块价格定义取值（出让=预期交易金额/求购=预算/出租求租=月租），multi 多段取首段 */
  const priceDef = BOARD_PRICE[p.board] || {};
  const priceRaw = p.extra ? p.extra[priceDef.key] : null;
  const priceText = Array.isArray(priceRaw) ? (priceRaw.length ? String(priceRaw[0].v ?? "") : "") : (priceRaw == null ? "" : String(priceRaw));
  if (priceText !== "") specChips.push(`<span class="rv-spec rv-spec-price">${esc(priceDef.label)} ¥${esc(priceText)}</span>`);
  return `
  <div class="adm-item rv-card">
    <div class="rv-head">
      <span class="rv-src">跳蚤市集</span>
      <span class="rv-board rv-b-${p.board}">${esc(BOARD_LABELS[p.board] || p.board || "")}</span>
      <span class="rv-title">${esc(p.title || "(无标题)")}</span>
      ${p.post_no ? `<span class="rv-no">#${p.post_no}</span>` : ""}
    </div>
    <div class="rv-body">
      ${specChips.length ? `<div class="rv-specs">${specChips.join("")}</div>` : ""}
      <div class="rv-descr">${esc(p.descr || "")}</div>
      ${p.review_admin_id ? `<div class="adm-alert">⚠ 指定管理员实名审核：请确认发布者身份是否已通过其他渠道核实。</div>` : ""}
      ${(p.proofs || []).length ? `<div class="adm-proofs">${p.proofs.map((pr) => `<img data-adminproof="${esc(p.id)}|${esc(pr.id)}" alt="证明材料" loading="lazy">`).join("")}</div>` : ""}
    </div>
    <div class="rv-foot">
      <span class="rv-meta">${esc(CARRIER_LABELS[p.carrier] || p.carrier || "")} · ${esc(p.province || "")}${p.city ? " " + esc(p.city) : ""} · ${esc(p.user_email || "")} · ${fmtTime(p.created_at)}</span>
      <div class="adm-actions">
        <button class="btn ghost sm" data-act="reviewDetail" data-id="${p.id}">详情</button>
        <button class="btn primary sm" data-act="review" data-id="${p.id}" data-approve="1">通过</button>
        <button class="btn ghost sm" data-act="review" data-id="${p.id}" data-approve="0">拒绝</button>
      </div>
    </div>
  </div>`;
}

/* 觅珍集库提交待审卡（仅站长）：标题/链接/分组 + 打开/通过/驳回 */
function reviewNavCard(n) {
  return `
  <div class="adm-item rv-card">
    <div class="rv-head">
      <span class="rv-src rv-src-nav">觅珍集库</span>
      <span class="rv-board rv-b-nav">${esc(n.group_name || "未分组")}</span>
      <span class="rv-title">${esc(n.title || "(无标题)")}</span>
    </div>
    <div class="rv-body">
      <div class="rv-url">${icon("link")} <a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">${esc(n.url)}</a></div>
      ${n.descr ? `<div class="rv-descr">${esc(n.descr)}</div>` : ""}
    </div>
    <div class="rv-foot">
      <span class="rv-meta">提交者：${esc(n.submitter_nickname || "用户")} · ${fmtTime(n.created_at)}</span>
      <div class="adm-actions">
        <a class="btn ghost sm" href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">打开</a>
        <button class="btn primary sm" data-act="navReview" data-id="${n.id}" data-approve="1">通过</button>
        <button class="btn ghost sm" data-act="navReview" data-id="${n.id}" data-approve="0">驳回</button>
      </div>
    </div>
  </div>`;
}

/* 情报酒馆投稿待审卡（管理员即可审核）：模式徽章/范围/标题/链接/简介/截止 + 攻略 MD 预览 + 通过/拒绝
   唠嗑聚落（mode=chat）共用此卡：种类/群号/凭证查看分支 */
function reviewActCard(a) {
  const guide = a.mode === "guide";
  const chat = a.mode === "chat";
  const links = Array.isArray(a.links) ? a.links : [];
  return `
  <div class="adm-item rv-card">
    <div class="rv-head">
      <span class="rv-src rv-src-act">${chat ? "唠嗑聚落" : "情报酒馆"}</span>
      <span class="rv-board rv-b-act">${a.province ? esc(a.province) : (chat && !a.carrier ? "全站通用" : "全国")}</span>
      <span class="rv-title">${esc(a.title || "(无标题)")}</span>
    </div>
    <div class="rv-body">
      <div class="rv-specs">
        <span class="rv-spec">${chat ? `社群 · ${esc(a.chat_type || "其他")}` : guide ? "个人攻略" : "官方活动"}</span>
        ${a.anon ? `<span class="rv-spec">匿名展示</span>` : ""}
        ${a.carrier ? "" : `<span class="rv-spec">${chat ? "全站通用" : "全运营商通用"}</span>`}
        ${a.ends_at ? `<span class="rv-spec">截止 ${fmtTime(a.ends_at)}</span>` : ""}
        ${chat && a.chat_id ? `<span class="rv-spec">群号/账号：${esc(a.chat_id)}</span>` : ""}
      </div>
      ${a.url ? `<div class="rv-url">${icon("link")} <a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.url)}</a></div>` : ""}
      ${links.length ? `<div class="rv-descr">附加链接：${links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a>`).join(" · ")}</div>` : ""}
      ${a.descr ? `<div class="rv-descr">${esc(a.descr)}</div>` : ""}
      ${guide && a.content_md ? `<details class="rv-descr"><summary>攻略正文预览（Markdown ${a.content_md.length} 字，点击展开）</summary><div class="act-md-prev">${mdToSafeHtml(a.content_md, { nofollow: true })}</div></details>` : ""}
    </div>
    <div class="rv-foot">
      <span class="rv-meta">提交者：${esc(a.submitter_nickname || "用户")}${a.anon ? "（匿名展示）" : ""} · ${fmtTime(a.created_at)}</span>
      <div class="adm-actions">
        ${a.url ? `<a class="btn ghost sm" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">打开</a>` : ""}
        <button class="btn ghost sm" data-act="actDetail" data-id="${esc(a.id)}">详情</button>
        ${a.has_qr ? `<button class="btn ghost sm" data-act="actQrPeek" data-id="${esc(a.id)}" title="查看提交的二维码">二维码</button>` : ""}
        ${chat && a.has_proof ? `<button class="btn ghost sm" data-act="chatProof" data-id="${esc(a.id)}" title="查看提交者的授权凭证（群主/管理员身份截图）">查看凭证</button>` : ""}
        <button class="btn primary sm" data-act="actReview" data-id="${esc(a.id)}" data-approve="1">通过</button>
        <button class="btn ghost sm" data-act="actReview" data-id="${esc(a.id)}" data-approve="0">拒绝</button>
      </div>
    </div>
  </div>`;
}

/* 酒馆投稿详情弹窗（审核 + 管理两处共用）：完整元数据 + 攻略正文 MD 渲染（数据已在列表接口返回，无需二次请求） */
function onActDetail(id) {
  const a = (state.pendingActs || []).find((x) => x.id === id) || (state.acts || []).find((x) => x.id === id);
  if (!a) { toast("未找到该投稿数据"); return; }
  const guide = a.mode === "guide";
  const chat = a.mode === "chat";
  const links = Array.isArray(a.links) ? a.links : [];
  const statusText = ACT_STATUS_LABELS[a.status || "pending"] || "待审核";
  const statusCls = a.status === "open" ? "ok" : (a.status === "pending" || !a.status) ? "warn" : "danger";
  const mask = document.createElement("div");
  mask.className = "adm-modal-mask";
  mask.innerHTML = `
    <div class="adm-modal adm-modal-lg" role="dialog" aria-modal="true">
      <div class="adm-modal-title">${chat ? "唠嗑社群" : guide ? "个人攻略" : "官方活动"}详情 <span class="adm-tag ${statusCls}">${statusText}</span></div>
      <div class="adm-review-body">
        <div class="adm-dt-row"><span class="adm-dt-k">标题</span><span class="adm-dt-v"><b>${esc(a.title || "(无标题)")}</b></span></div>
        <div class="adm-dt-row"><span class="adm-dt-k">范围</span><span class="adm-dt-v">${esc(CARRIER_LABELS[a.carrier] || a.carrier || (chat ? "全站通用" : "全运营商通用"))} · ${esc(a.province || (chat ? "通用（含全国）" : "全国"))}</span></div>
        ${a.ends_at ? `<div class="adm-dt-row"><span class="adm-dt-k">截止时间</span><span class="adm-dt-v">${fmtTime(a.ends_at)}</span></div>` : ""}
        ${chat && a.chat_id ? `<div class="adm-dt-row"><span class="adm-dt-k">群号/账号</span><span class="adm-dt-v" style="user-select:all">${esc(a.chat_id)}</span></div>` : ""}
        ${a.url ? `<div class="adm-dt-row"><span class="adm-dt-k">活动链接</span><span class="adm-dt-v"><a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.url)}</a></span></div>` : ""}
        ${links.length ? `<div class="adm-dt-row"><span class="adm-dt-k">附加链接</span><span class="adm-dt-v">${links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a>`).join(" · ")}</span></div>` : ""}
        ${a.descr ? `<div class="adm-dt-row"><span class="adm-dt-k">简介</span><span class="adm-dt-v adm-dt-descr">${esc(a.descr)}</span></div>` : ""}
        ${(guide && a.content_md && a.content_md.trim()) ? `<div class="adm-dt-row"><span class="adm-dt-k">攻略正文</span></div><div class="adm-act-md">${mdToSafeHtml(a.content_md, { nofollow: true })}</div>` : ""}
        ${a.anon ? `<div class="adm-dt-row"><span class="adm-dt-k">展示方式</span><span class="adm-dt-v">匿名展示</span></div>` : ""}
        ${a.status === "rejected" && a.reject_reason ? `<div class="adm-dt-row"><span class="adm-dt-k">拒绝原因</span><span class="adm-dt-v" style="color:var(--red,#c0392b)">${esc(a.reject_reason)}</span></div>` : ""}
        <div class="adm-dt-row"><span class="adm-dt-k">提交者</span><span class="adm-dt-v">${esc(a.submitter_nickname || "用户")}${a.anon ? "（匿名展示）" : ""}</span></div>
        <div class="adm-dt-row"><span class="adm-dt-k">提交时间</span><span class="adm-dt-v">${fmtTime(a.created_at)}${a.reviewed_at ? " · 审核于 " + fmtTime(a.reviewed_at) : ""}</span></div>
      </div>
      <div class="adm-modal-btns"><button class="btn ghost" data-m="close">关闭</button></div>
    </div>`;
  document.body.appendChild(mask);
  mask.addEventListener("click", (e) => { if (e.target === mask || e.target.closest('[data-m="close"]')) mask.remove(); });
}

function renderReview() {
  const f = state.reviewFilter;
  const posts = state.pending.filter((p) => !f.board || p.board === f.board);
  const navs = f.source === "cardhub" || f.source === "acts" ? [] : (state.pendingNav || []);
  const acts = f.source === "cardhub" || f.source === "nav" ? [] : (state.pendingActs || []);
  const showPosts = f.source !== "nav" && f.source !== "acts";
  const postCards = showPosts ? posts.map(reviewPostCard).join("") : "";
  const navCards = navs.map(reviewNavCard).join("");
  const actCards = acts.map(reviewActCard).join("");
  if (!postCards && !navCards && !actCards) return reviewFilterHTML() + `<div class="adm-empty">当前筛选下没有待审核内容</div>`;
  return reviewFilterHTML() + postCards + navCards + actCards;
}

/* ── 工单处理（收件箱：状态筛选 + 展开对话 + 回复 + 关闭） ── */
const TICKET_STATUS_LABELS = { open: "待处理", replied: "已回复", closed: "已关闭" };
const TICKET_SOURCE_LABELS = { tariff: "资费监测", cardhub: "跳蚤市集", ticket: "工单中心", config: "配置工具", admin: "管理后台", other: "其他" };

function renderTickets() {
  const ts = state.tickets;
  const st = (s) => `<span class="adm-tag ${s === "open" ? "warn" : s === "replied" ? "ok" : ""}">${TICKET_STATUS_LABELS[s] || esc(s)}</span>`;
  return `
    <div class="adm-filter">
      <select class="inp" id="admTkStatus">
        <option value=""${!ts.status ? " selected" : ""}>未关闭（待处理 + 已回复）</option>
        <option value="all"${ts.status === "all" ? " selected" : ""}>全部</option>
        <option value="open"${ts.status === "open" ? " selected" : ""}>待处理</option>
        <option value="replied"${ts.status === "replied" ? " selected" : ""}>已回复</option>
        <option value="closed"${ts.status === "closed" ? " selected" : ""}>已关闭</option>
      </select>
    </div>
    ${ts.items.length ? ts.items.map((t) => {
      const expanded = ts.openId === t.id && ts.detail;
      return `
    <div class="adm-item">
      <div class="adm-item-head" data-act="tkExpand" data-id="${esc(t.id)}" style="cursor:pointer">
        <span class="adm-tag">${esc(TICKET_SOURCE_LABELS[t.source] || "工单")}</span>
        <span class="adm-title">#${t.ticket_no} ${esc(t.title)}</span>
        <span class="adm-meta">${esc(t.category)}${t.ref_no ? " · 关联帖子 #" + t.ref_no : ""}${t.scope === "admin" ? " · 指定成员" : ""}</span>
      </div>
      <div class="adm-item-foot">
        <span class="adm-meta">${st(t.status)} · 最后动态 ${fmtTime(t.last_reply_at)} · ${t.last_reply_by === "user" ? "等待处理" : "等待用户回应"}</span>
        ${t.status !== "closed" ? `<div class="adm-actions"><button class="btn ghost sm" data-act="tkClose" data-id="${esc(t.id)}">关闭工单</button></div>` : ""}
      </div>
      ${expanded ? `
      <div class="adm-tk-msgs">
        ${(ts.detail.messages || []).map((m) => `
        <div class="adm-tk-msg ${m.sender === "admin" ? "staff" : "user"}">
          <div class="adm-tk-msg-head">${esc(m.nickname)} · ${fmtTime(m.createdAt)}</div>
          <div class="adm-tk-msg-body">${esc(m.body)}</div>
        </div>`).join("")}
        ${t.status !== "closed" ? `
        <div class="adm-tk-reply">
          <textarea class="inp" id="admTkReply" rows="3" placeholder="以管理组身份回复（≤500 字）"></textarea>
          <button class="btn primary sm" data-act="tkReply" data-id="${esc(t.id)}" style="margin-top:6px">发送回复</button>
        </div>` : ""}
      </div>` : ""}
    </div>`;
    }).join("") : `<div class="adm-empty">暂无工单</div>`}`;
}

/* ═══════════════ 觅珍集库（导航链接，仅站长） ═══════════════ */
const NAV_STATUS_LABELS = { pending: "待审核", open: "已上架", rejected: "已驳回", retired: "已下架" };

function renderNav() {
  const nv = state.nav;
  return `
    <div class="adm-filter">
      <select class="inp" id="admNavStatus">
        <option value="pending"${nv.status === "pending" ? " selected" : ""}>待审核</option>
        <option value="open"${nv.status === "open" ? " selected" : ""}>已上架</option>
        <option value="rejected"${nv.status === "rejected" ? " selected" : ""}>已驳回</option>
        <option value="retired"${nv.status === "retired" ? " selected" : ""}>已下架</option>
        <option value=""${!nv.status ? " selected" : ""}>全部</option>
      </select>
    </div>
    ${nv.items.length ? nv.items.map((it) => {
      const editing = nv.editId === it.id;
      const stTag = `<span class="adm-tag ${it.status === "pending" ? "warn" : it.status === "open" ? "ok" : ""}">${NAV_STATUS_LABELS[it.status] || esc(it.status)}</span>`;
      return `
    <div class="adm-item">
      <div class="adm-item-head">
        <span class="adm-title">${esc(it.title)}${it.featured ? `<span class="adm-tag ok" title="觅珍集库顶部精选区高亮展示">精选</span>` : ""}</span>
        <span class="adm-meta">${esc(it.group_name || "其他")} · ${esc(it.url.length > 46 ? it.url.slice(0, 46) + "…" : it.url)}</span>
      </div>
      <div class="adm-item-foot">
        <span class="adm-meta">${stTag} · 提交者 ${esc(it.submitter_nickname || it.submitted_by)} · ${fmtTime(it.created_at)}${it.status === "rejected" && it.reject_reason ? " · 驳回原因：" + esc(it.reject_reason) : ""}</span>
        <div class="adm-actions">
          ${it.status === "pending" ? `
          <button class="btn primary sm" data-act="navReview" data-id="${esc(it.id)}" data-approve="1">通过</button>
          <button class="btn ghost sm" data-act="navReview" data-id="${esc(it.id)}" data-approve="0">驳回</button>` : ""}
          ${it.status === "open" ? `<button class="btn ghost sm" data-act="navRetire" data-id="${esc(it.id)}">下架</button>` : ""}
          ${it.status === "retired" ? `<button class="btn primary sm" data-act="navRestore" data-id="${esc(it.id)}">重新上架</button>` : ""}
          ${it.status !== "pending" ? `<button class="btn ghost sm" data-act="navEdit" data-id="${esc(it.id)}">编辑</button>` : ""}
          <button class="btn ghost sm" data-act="navDelete" data-id="${esc(it.id)}" style="color:var(--red)">删除</button>
        </div>
      </div>
      ${editing ? `
      <div class="adm-nav-edit">
        <div class="adm-nav-edit-grid">
          <label>名称<input class="inp" id="navETitle" maxlength="30" value="${esc(it.title)}"></label>
          <label>链接<input class="inp" id="navEUrl" maxlength="500" value="${esc(it.url)}"></label>
          <label>图标 URL<input class="inp" id="navEIcon" maxlength="500" value="${esc(it.icon_url || "")}"></label>
          <label>简介<input class="inp" id="navEDescr" maxlength="80" value="${esc(it.descr || "")}"></label>
          <label>分组<input class="inp" id="navEGroup" maxlength="20" value="${esc(it.group_name || "")}"></label>
          <label>排序（小在前）<input class="inp" id="navESort" type="number" step="1" value="${Number(it.sort) || 100}"></label>
          <label style="flex-direction:row;align-items:center;gap:8px">特殊站点<input type="checkbox" id="navEFeatured" ${it.featured ? "checked" : ""} style="width:16px;height:16px"><span class="opt" style="font-weight:400">勾选后在觅珍集库顶部「精选推荐」区高亮展示</span></label>
        </div>
        <div class="adm-actions" style="margin-top:8px">
          <button class="btn primary sm" data-act="navSave" data-id="${esc(it.id)}">保存</button>
          <button class="btn ghost sm" data-act="navCancelEdit">取消</button>
        </div>
      </div>` : ""}
    </div>`;
    }).join("") : `<div class="adm-empty">该状态下暂无链接</div>`}`;
}

/* ═══════════════ 公告页签（原「推广」，owner+admin：2026-10-20 起公告/推广管理对管理员开放）：全站公告 + 推广列表 ═══════════════
   ▸ 全站公告（site_notice_*）为 NoticeGate 专用键，渲染/保存复用设置页同款 data-act
     （toggleSetting / inputSetting + saveSetting），零新增事件
   ▸ 跳蚤市集用户警告已并入推广体系（migration 0030）：mode=must、modules=["cardhub"]
     的推广条目 promo_cardhub_warning，在下方推广列表中与其他条目统一管理
   ▸ 推广（promos 键整存整取）复用公告弹窗体系；
     scope 新增 modules 维度：非空 = 仅进入对应模块时判定弹出，空 = 全站任意页面（现状兼容）
   ▸ 生效链路与公告一致：保存 → D1 → Worker 即时 → 采集端快照 → 随前端部署（最长一个采集周期）
   ▸ 范围匹配基准 = 生效模块 + 访客当前在资费页选择的运营商/省份（省 code 与资费页 PROVINCE_ORDER 一致） */
const PROMO_PROV_LIST = [
  { c: "bj", n: "北京" }, { c: "tj", n: "天津" }, { c: "he", n: "河北" }, { c: "sx", n: "山西" }, { c: "nmg", n: "内蒙古" }, { c: "ln", n: "辽宁" },
  { c: "jl", n: "吉林" }, { c: "hlj", n: "黑龙江" }, { c: "sh", n: "上海" }, { c: "js", n: "江苏" }, { c: "zj", n: "浙江" }, { c: "ah", n: "安徽" },
  { c: "fj", n: "福建" }, { c: "jx", n: "江西" }, { c: "sd", n: "山东" }, { c: "hn", n: "河南" }, { c: "hub", n: "湖北" }, { c: "hun", n: "湖南" },
  { c: "gd", n: "广东" }, { c: "gx", n: "广西" }, { c: "han", n: "海南" }, { c: "cq", n: "重庆" }, { c: "sc", n: "四川" }, { c: "gz", n: "贵州" },
  { c: "yn", n: "云南" }, { c: "xz", n: "西藏" }, { c: "snx", n: "陕西" }, { c: "gs", n: "甘肃" }, { c: "qh", n: "青海" }, { c: "nx", n: "宁夏" },
  { c: "xj", n: "新疆" },
];
/* 生效模块可选项 = 前端页面注册 id（shell.js Shell.registerPage）；新增面向用户的功能模块时需同步维护此表 */
const PROMO_MODULE_LABELS = { tariff: "资费中心", cardhub: "跳蚤市集", ticket: "工单中心", tools: "觅珍集库" };
const PROMO_MODE_LABELS = { closable: "可关闭 · 每日一次", must: "强制同意" };

/* ── 弹出日期门槛控件（公告 + 推广条目共用）：三类任一命中当天即弹（OR），全空 = 不限日期走现有逻辑 ── */
const WEEKDAY_LABELS = [["1", "周一"], ["2", "周二"], ["3", "周三"], ["4", "周四"], ["5", "周五"], ["6", "周六"], ["7", "周日"]];
function scheduleControlsHTML(sc, idPrefix) {
  const weekly = (sc && Array.isArray(sc.weekly)) ? sc.weekly : [];
  const monthly = (sc && Array.isArray(sc.monthly)) ? sc.monthly : [];
  const yearly = (sc && Array.isArray(sc.yearly)) ? sc.yearly : [];
  return `
    <div class="adm-meta">每周固定日（可多选）</div>
    <div id="${idPrefix}Weekly">${WEEKDAY_LABELS.map(([v, n]) => `<button type="button" class="rv-chip${weekly.includes(Number(v)) ? " active" : ""}" data-act="promoChip" data-v="${v}">${n}</button>`).join("")}</div>
    <div class="adm-meta" style="margin-top:6px">每月固定日（1-31 逗号分隔；填 last = 每月最后一天）</div>
    <input class="inp" id="${idPrefix}Monthly" placeholder="如：16,26,last" value="${esc(monthly.join(","))}">
    <div class="adm-meta" style="margin-top:6px">每年固定日（MM-DD 逗号分隔）</div>
    <input class="inp" id="${idPrefix}Yearly" placeholder="如：10-01,05-01" value="${esc(yearly.join(","))}">
    <div class="adm-meta" style="margin-top:6px">三类任一命中当天即弹（OR）；全部留空 = 不限日期，走现有弹窗逻辑（防重照旧）。按北京时间判定。</div>`;
}
function readScheduleControls(idPrefix) {
  const weekly = [...document.querySelectorAll(`#${idPrefix}Weekly .rv-chip.active`)].map((b) => Number(b.dataset.v));
  const monthlyRaw = (($("#" + idPrefix + "Monthly") || {}).value || "").split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
  const yearlyRaw = (($("#" + idPrefix + "Yearly") || {}).value || "").split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
  const sched = {};
  if (weekly.length) sched.weekly = [...new Set(weekly)];
  const mList = monthlyRaw.map((x) => (x.toLowerCase() === "last" || x === "末" ? "last" : Number(x))).filter((n) => n === "last" || (Number.isInteger(n) && n >= 1 && n <= 31));
  if (mList.length) sched.monthly = [...new Set(mList)];
  const yList = yearlyRaw.filter((x) => /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(x));
  if (yList.length) sched.yearly = [...new Set(yList)];
  return Object.keys(sched).length ? sched : null;
}

function getPromos() {
  const row = (state.settings || []).find((s) => s.key === "promos");
  try { const v = JSON.parse(row ? row.value_json : "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
/* 占位符行文本（公告页签编辑块）：[{key,value}] → 「键名 | 值」行 */
function getPlaceholderRows() {
  const row = (state.settings || []).find((s) => s.key === "promo_placeholders");
  try {
    const v = JSON.parse(row ? row.value_json : "[]");
    return Array.isArray(v) ? v.map((n) => `${n.key || ""} | ${n.value || ""}`).join("\n") : "";
  } catch { return "";
  }
}
function promoScopeText(sc) {
  const carriers = sc && Array.isArray(sc.carriers) ? sc.carriers : [];
  const provinces = sc && Array.isArray(sc.provinces) ? sc.provinces : [];
  const modules = sc && Array.isArray(sc.modules) ? sc.modules : [];
  const mTxt = modules.length ? modules.map((m) => PROMO_MODULE_LABELS[m] || m).join("+") : "";
  const cTxt = carriers.length ? carriers.map((c) => CARRIER_LABELS[c] || c).join("+") : "";
  const pTxt = provinces.length ? provinces.map((p) => (PROMO_PROV_LIST.find((x) => x.c === p) || {}).n || p).join("+") : "";
  if (!cTxt && !pTxt && !mTxt) return "全站";
  const parts = [];
  if (mTxt) parts.push("仅 " + mTxt);
  parts.push(cTxt || "全部运营商");
  if (pTxt) parts.push(pTxt);
  return parts.join(" · ");
}

/* 公告/警告设置行渲染：与设置页同款标记（data-act=toggleSetting / inputSetting+saveSetting），
   保存与开关复用现有事件处理，零新增动作。键在 DB 尚无行时合成空行，保证首次可配置 */
function noticeSettingRow(key) {
  let row = (state.settings || []).find((s) => s.key === key);
  if (!row) row = { key, value_json: "", updated_at: null };
  const val = parseSettingVal(row);
  const desc = SETTING_DESC[key] ? `<span class="help" data-tip="${esc(SETTING_DESC[key])}">?</span>` : "";
  const upd = row.updated_at ? ` · 更新于 ${fmtTime(row.updated_at)}` : "";
  if (typeof val === "boolean") {
    return `
    <div class="adm-setting">
      <div class="adm-setting-info">
        <div class="adm-setting-key">${esc(key)}${desc}</div>
        <div class="adm-setting-meta">${upd}</div>
      </div>
      <div class="adm-setting-ctrl">
        <button class="btn ${val ? "primary" : "ghost"} sm" data-act="toggleSetting" data-key="${key}">${val ? "已开启" : "已关闭"}</button>
      </div>
    </div>`;
  }
  const meta = SETTING_BLOCK_META[key];
  if (meta) {
    const text = String(val);
    /* MD 编辑器键（公告正文）：挂载点 + 渲染后 mountSettingMdEditors 统一挂载，保存经 onSaveSetting 特判取值 */
    const bodyHtml = SETTING_MD_KEYS.has(key)
      ? mdMountHTML(key, text, meta.placeholder, 8000)
      : `<textarea class="inp adm-setting-ta" rows="7" data-act="inputSetting" data-key="${key}" placeholder="${meta.placeholder}">${esc(text)}</textarea>`;
    return `
    <div class="adm-setting adm-setting-block">
      <div class="adm-setting-info">
        <div class="adm-setting-key">${esc(key)}${desc}</div>
        <div class="adm-setting-meta">${meta.counter(text)}${upd}</div>
      </div>
      ${bodyHtml}
      <div class="adm-setting-actions">
        <span class="adm-setting-hint">${meta.hint}</span>
        <button class="btn primary sm" data-act="saveSetting" data-key="${key}"><i data-icon="check"></i>${meta.saveText}</button>
      </div>
    </div>`;
  }
  /* 短文本键（如 site_notice_title）：单行输入 */
  return `
    <div class="adm-setting">
      <div class="adm-setting-info">
        <div class="adm-setting-key">${esc(key)}${desc}</div>
        <div class="adm-setting-meta">${upd}</div>
      </div>
      <div class="adm-setting-ctrl">
        <input class="inp" style="width:220px" data-act="inputSetting" data-key="${key}" value="${esc(String(val))}">
        <button class="btn primary sm" data-act="saveSetting" data-key="${key}">保存</button>
      </div>
    </div>`;
}

function renderPromos() {
  const pr = state.promos;
  const items = getPromos();
  /* 切换重弹开关：settings 键 promo_reswitch_enabled（未保存过 = 默认开启） */
  let reswitchOn = true;
  try {
    const rowR = (state.settings || []).find((s) => s.key === "promo_reswitch_enabled");
    reswitchOn = JSON.parse(rowR ? rowR.value_json : "true") !== false;
  } catch { reswitchOn = true; }
  const chip = (box, v, label, active) => `<button type="button" class="rv-chip${active ? " active" : ""}" data-act="promoChip" data-box="${box}" data-v="${esc(v)}">${esc(label)}</button>`;
  const editor = (p) => {
    const isNew = !p;
    const sc = (p && p.scope) || { carriers: [], provinces: [], modules: [] };
    return `
    <div class="adm-nav-edit">
      <div class="adm-nav-edit-grid">
        <label>标题<input class="inp" id="promoETitle" maxlength="60" value="${esc(p ? p.title : "")}" placeholder="推广标题（60 字内）"></label>
        <label>弹出模式<select class="inp" id="promoEMode">
          <option value="closable"${!p || p.mode !== "must" ? " selected" : ""}>可关闭（每日一次）</option>
          <option value="must"${p && p.mode === "must" ? " selected" : ""}>强制同意（无关闭按钮）</option>
        </select></label>
      </div>
      <label style="display:block;margin-top:8px">内容（Markdown，8000 字内）${mdMountHTML("__promo__", p ? p.content : "", "支持 Markdown：**加粗**、[链接](https://…)、- 列表、# 标题", 8000)}</label>
      <div style="margin-top:8px">
        <div class="adm-meta">弹出日期（可选；支持 {{key}} 占位符，取值在「设置」页「公告推广占位符」配置，保存即生效不随部署）</div>
        ${scheduleControlsHTML(p && p.schedule, "promoESched")}
      </div>
      <div style="margin-top:8px">
        <div class="adm-meta">生效模块（不选 = 全站任意页面弹出；选择后仅在进入对应模块时判定弹出，与下方运营商/省份为与关系）</div>
        <div id="promoEModules">${Object.entries(PROMO_MODULE_LABELS).map(([m, n]) => chip("modules", m, n, !isNew && (sc.modules || []).includes(m))).join("")}</div>
      </div>
      <div style="margin-top:8px">
        <div class="adm-meta">运营商范围（不选 = 全部运营商）</div>
        <div id="promoECarriers">${Object.entries(CARRIER_LABELS).map(([c, n]) => chip("carriers", c, n, !isNew && sc.carriers.includes(c))).join("")}</div>
      </div>
      <div style="margin-top:8px">
        <div class="adm-meta">省份范围（不选 = 全部省份；与资费页省份联动匹配）</div>
        <div id="promoEProvinces">${PROMO_PROV_LIST.map((x) => chip("provinces", x.c, x.n, !isNew && sc.provinces.includes(x.c))).join("")}</div>
      </div>
      <div style="margin-top:8px;display:flex;align-items:center;gap:8px"><input type="checkbox" id="promoEEnabled" ${!p || p.enabled !== false ? "checked" : ""}><span class="adm-meta">启用（关闭后不弹窗、不出现在公告页签）</span></div>
      <div class="adm-actions" style="margin-top:8px">
        <button class="btn primary sm" data-act="promoSave" data-id="${isNew ? "new" : esc(p.id)}">保存</button>
        <button class="btn ghost sm" data-act="promoCancelEdit">取消</button>
      </div>
      <div class="adm-meta" style="margin-top:6px">生效链路：保存 → 下一轮采集部署到前端（最长一个采集周期 ≈ 8 小时）</div>
    </div>`;
  };
  const row = (p) => {
    const editing = pr.editId === p.id;
    const scopeTxt = promoScopeText(p.scope);
    const modeTxt = PROMO_MODE_LABELS[p.mode] || "可关闭 · 每日一次";
    return `
    <div class="adm-item">
      <div class="adm-item-head">
        <span class="adm-title">${esc(p.title)}</span>
        <span class="adm-meta">${esc(scopeTxt)} · ${esc(modeTxt)}</span>
      </div>
      <div class="adm-item-foot">
        <span class="adm-meta"><span class="adm-tag ${p.enabled ? "ok" : ""}">${p.enabled ? "启用中" : "已停用"}</span> · 版本 ${fmtTime(p.version)}</span>
        <div class="adm-actions">
          <button class="btn ghost sm" data-act="promoEdit" data-id="${esc(p.id)}">编辑</button>
          <button class="btn ghost sm" data-act="promoToggle" data-id="${esc(p.id)}">${p.enabled ? "停用" : "启用"}</button>
          <button class="btn ghost sm" data-act="promoDelete" data-id="${esc(p.id)}" style="color:var(--red)">删除</button>
        </div>
      </div>
      ${editing ? editor(p) : ""}
    </div>`;
  };
  return `
    <div class="adm-set-group">
      <div class="adm-set-group-title">全站公告</div>
      ${noticeSettingRow("site_notice_enabled")}
      ${noticeSettingRow("site_notice_title")}
      ${noticeSettingRow("site_notice_content")}
    </div>
    <div class="adm-set-group">
      <div class="adm-set-group-title">公告弹出日期（可选）</div>
      <div class="adm-filter" style="margin-bottom:8px"><span class="adm-meta">仅命中日期当天按「每日首次进站」弹公告（防重规则不变，勾选「今日不再」照常生效）；全部留空 = 每天弹（现有逻辑）。三类任一命中即弹（OR），按北京时间判定。</span></div>
      ${scheduleControlsHTML(state.noticeSchedule || {}, "noticeSched")}
      <div class="adm-actions" style="margin-top:8px"><button class="btn primary sm" data-act="saveNoticeSchedule"><i data-icon="check"></i>保存日期</button></div>
    </div>
    <div class="adm-set-group">
      <div class="adm-set-group-title">推广</div>
      <div class="adm-filter" style="justify-content:space-between;align-items:center">
        <span class="adm-meta">弹窗顺序：先公告后推广（串行队列）；范围匹配 = 生效模块 + 访客当前选择的运营商/省份（同时配置时需全部命中）。生效链路：保存 → 下一轮采集部署（最长 ≈ 8 小时）</span>
        <button class="btn primary sm" data-act="promoNew"${pr.editId ? " disabled" : ""}>新建推广</button>
      </div>
      <div class="adm-filter" style="justify-content:space-between;align-items:center">
        <span class="adm-meta">切换运营商/省份时：重新弹出命中新范围且未读的全站推广（模块条目不参与；访客勾选「今日不再弹出」的不会弹）</span>
        <button class="btn ${reswitchOn ? "" : "ghost"} sm" data-act="promoReswitchToggle">${reswitchOn ? "切换重弹：已开启" : "切换重弹：已关闭"}</button>
      </div>
      ${pr.editId === "new" ? editor(null) : ""}
      ${items.length ? items.map(row).join("") : `<div class="adm-empty">暂无推广，点击「新建推广」创建第一条</div>`}
    </div>
    <div class="adm-set-group">
      <div class="adm-set-group-title">占位符取值（{{key}}）</div>
      <div class="adm-filter" style="margin-bottom:8px"><span class="adm-meta">公告/推广正文里写 {{键名}}，展示时替换为对应值（仅公告/推广渲染生效，其他 Markdown 不替换）；值不随部署——保存即生效，前端访客下次进站拉到新值。</span></div>
      <textarea class="inp adm-setting-ta" rows="6" data-act="inputSetting" data-key="promo_placeholders" placeholder="每行一条，格式：键名 | 值&#10;如：quota | 128&#10;如：deadline | 10 月 31 日&#10;键名小写字母/数字/下划线 1~20 位且不可重复，值 ≤200 字">${esc(getPlaceholderRows())}</textarea>
      <div class="adm-actions" style="margin-top:8px"><button class="btn primary sm" data-act="saveSetting" data-key="promo_placeholders"><i data-icon="check"></i>保存占位符</button></div>
    </div>`;
}

async function onPromoReswitchToggle() {
  let cur = true;
  try {
    const rowR = (state.settings || []).find((s) => s.key === "promo_reswitch_enabled");
    cur = JSON.parse(rowR ? rowR.value_json : "true") !== false;
  } catch { cur = true; }
  const r = await api.adminUpdateSetting("promo_reswitch_enabled", !cur);
  toast(r.ok ? (!cur ? "已开启：切换运营商/省份时重新判定推广弹窗" : "已关闭：仅进入页面时判定") : (r.error || "操作失败"));
  if (r.ok) loadTab();
}

async function onPromoSave(id) {
  const title = ($("promoETitle") || {}).value || "";
  const content = settingMdEds && settingMdEds.__promo__ ? settingMdEds.__promo__.getValue() : "";
  const mode = ($("promoEMode") || {}).value || "closable";
  const enabled = !$("promoEEnabled") || $("promoEEnabled").checked;
  const pickChips = (boxId) => [...document.querySelectorAll(`#${boxId} .rv-chip.active`)].map((b) => b.dataset.v);
  if (!title.trim()) { toast("标题不能为空"); return; }
  if (!content.trim()) { toast("内容不能为空"); return; }
  const items = getPromos();
  const entry = {
    id: id === "new" ? "promo_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) : id,
    enabled,
    title: title.trim(),
    content,
    version: Date.now(),   // 保存时间 = 版本（变更自动重弹）
    mode,
    scope: { carriers: pickChips("promoECarriers"), provinces: pickChips("promoEProvinces"), modules: pickChips("promoEModules") },
  };
  const sched = readScheduleControls("promoESched");
  if (sched) entry.schedule = sched; // 全空 = 不限日期，不写该字段（走现有逻辑）
  const idx = items.findIndex((x) => x.id === entry.id);
  if (idx >= 0) items[idx] = entry; else items.push(entry);
  const r = await api.adminUpdateSetting("promos", items);
  toast(r.ok ? "已保存（随下一轮采集部署生效）" : (r.error || "保存失败"));
  if (r.ok) { state.promos.editId = ""; loadTab(); }
}

/* 保存公告弹出日期门槛（独立键 site_notice_schedule，管理员可写） */
async function onSaveNoticeSchedule() {
  const sched = readScheduleControls("noticeSched");
  const r = await api.adminUpdateSetting("site_notice_schedule", sched || {});
  toast(r.ok ? "公告弹出日期已保存（快照随下一轮采集部署生效）" : (r.error || "保存失败"));
  if (r.ok) loadTab();
}

async function onPromoToggle(id) {
  const items = getPromos();
  const it = items.find((x) => x.id === id);
  if (!it) return;
  it.enabled = it.enabled === false;
  const r = await api.adminUpdateSetting("promos", items);
  toast(r.ok ? (it.enabled ? "已启用" : "已停用") : (r.error || "操作失败"));
  if (r.ok) loadTab();
}

async function onPromoDelete(id) {
  const ok = await admConfirm({ title: "删除推广", message: "删除后前端弹窗与公告页签将不再显示该内容（随下一轮采集部署生效）。", okText: "删除", danger: true });
  if (!ok) return;
  const items = getPromos().filter((x) => x.id !== id);
  const r = await api.adminUpdateSetting("promos", items);
  toast(r.ok ? "已删除" : (r.error || "操作失败"));
  if (r.ok) { state.promos.editId = ""; loadTab(); }
}

/* ── 情报酒馆管理（admin+）：状态筛选 chips（客户端过滤）+ 通过/拒绝/下架/删除 ── */
const ACT_STATUS_LABELS = { pending: "待审核", open: "展示中", rejected: "已拒绝", retired: "已下架", expired: "已过期" };
const ACT_MODE_LABELS = { official: "官方活动", guide: "个人攻略", chat: "唠嗑社群" };

function renderActs() {
  const all = state.acts || [];
  const counts = {};
  for (const a of all) { counts[a.status] = (counts[a.status] || 0) + 1; counts["m_" + (a.mode || "official")] = (counts["m_" + (a.mode || "official")] || 0) + 1; }
  const chip = (v, label, n) => `<button type="button" class="rv-chip${state.actStatus === v ? " active" : ""}" data-act="actFilter" data-v="${v}">${label} <span class="rv-chip-n">${n}</span></button>`;
  const mchip = (v, label, n) => `<button type="button" class="rv-chip${state.actMode === v ? " active" : ""}" data-act="actModeFilter" data-v="${v}">${label} <span class="rv-chip-n">${n}</span></button>`;
  const filters = `
    <div class="rv-filters"><div class="rv-filter-row">
      <span class="rv-filter-label">状态</span>
      ${chip("", "全部", all.length)}
      ${["pending", "open", "rejected", "retired", "expired"].filter((s) => counts[s]).map((s) => chip(s, ACT_STATUS_LABELS[s], counts[s])).join("")}
    </div><div class="rv-filter-row">
      <span class="rv-filter-label">板块</span>
      ${mchip("", "全部", all.length)}
      ${["official", "guide", "chat"].filter((m) => counts["m_" + m]).map((m) => mchip(m, ACT_MODE_LABELS[m], counts["m_" + m])).join("")}
    </div></div>`;
  const items = all.filter((a) => (!state.actStatus || a.status === state.actStatus) && (!state.actMode || (a.mode || "official") === state.actMode));
  const cards = items.map((a) => {
    const mode = a.mode || "official";
    const chat = mode === "chat";
    const guide = mode === "guide";
    const actBtns = a.status === "pending"
      ? `<button class="btn primary sm" data-act="actReview" data-id="${esc(a.id)}" data-approve="1">通过</button>
         <button class="btn ghost sm" data-act="actReview" data-id="${esc(a.id)}" data-approve="0">拒绝</button>`
      : a.status === "open" || a.status === "retired"
        ? `<button class="btn ghost sm" data-act="actEdit" data-id="${esc(a.id)}">编辑</button>
           ${a.status === "open" ? `<button class="btn ghost sm" data-act="actRetire" data-id="${esc(a.id)}">下架</button>` : ""}
           <button class="btn ghost sm" data-act="actDel" data-id="${esc(a.id)}" style="color:var(--red)">删除</button>`
        : `<button class="btn ghost sm" data-act="actDel" data-id="${esc(a.id)}" style="color:var(--red)">删除</button>`;
    const links = Array.isArray(a.links) ? a.links : [];
    return `
    <div class="adm-item rv-card${state.actEditId === a.id ? " act-editing" : ""}">
      <div class="rv-head">
        <span class="rv-board rv-b-act">${a.province ? esc(a.province) : (chat && !a.carrier ? "全站通用" : "全国")}</span>
        <span class="rv-title">${esc(a.title || "(无标题)")}</span>
        <span class="rv-no">${ACT_STATUS_LABELS[a.status] || esc(a.status)}</span>
      </div>
      <div class="rv-body">
        <div class="rv-specs">
          <span class="rv-spec">${chat ? `唠嗑社群 · ${esc(a.chat_type || "其他")}` : ACT_MODE_LABELS[mode] || esc(mode)}</span>
          ${a.anon ? `<span class="rv-spec">匿名展示</span>` : ""}
          ${a.carrier ? `<span class="rv-spec">${esc(CARRIER_LABELS[a.carrier] || a.carrier)}</span>` : `<span class="rv-spec">${chat ? "全站通用" : "全运营商通用"}</span>`}
          ${a.ends_at ? `<span class="rv-spec">截止 ${fmtTime(a.ends_at)}</span>` : ""}
          ${chat && a.chat_id ? `<span class="rv-spec">群号/账号：${esc(a.chat_id)}</span>` : ""}
        </div>
        ${a.url ? `<div class="rv-url">${icon("link")} <a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.url)}</a></div>` : ""}
        ${links.length ? `<div class="rv-descr">附加链接：${links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a>`).join(" · ")}</div>` : ""}
        ${a.descr ? `<div class="rv-descr">${esc(a.descr)}</div>` : ""}
        ${guide && a.content_md ? `<details class="rv-descr"><summary>攻略正文预览（Markdown ${a.content_md.length} 字，点击展开）</summary><div class="act-md-prev">${mdToSafeHtml(a.content_md, { nofollow: true })}</div></details>` : ""}
        ${a.status === "rejected" && a.reject_reason ? `<div class="adm-alert">拒绝原因：${esc(a.reject_reason)}</div>` : ""}
      </div>
      <div class="rv-foot">
        <span class="rv-meta">提交者：${esc(a.submitter_nickname || "用户")}${a.anon ? "（匿名展示）" : ""} · ${fmtTime(a.created_at)}${a.reviewed_at ? " · 审核于 " + fmtTime(a.reviewed_at) : ""}</span>
        <div class="adm-actions">
          <button class="btn ghost sm" data-act="actDetail" data-id="${esc(a.id)}">详情</button>
          ${a.url ? `<a class="btn ghost sm" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">打开</a>` : ""}
          ${a.has_qr ? `<button class="btn ghost sm" data-act="actQrPeek" data-id="${esc(a.id)}" title="查看二维码">二维码</button>` : ""}
          ${actBtns}
        </div>
      </div>
      ${state.actEditId === a.id ? actEditPanelHTML(a) : ""}
    </div>`;
  }).join("");
  return filters + (cards || `<div class="adm-empty">没有投稿记录</div>`);
}

/* ── 管理员编辑面板：按条目 mode 渲染对应形态的字段组（与各板块提交 UI 同构）。
   mode 不可改（跨形态走删除重发）；pending/rejected/expired 不开放编辑（列表无编辑按钮）── */
function actEndsToDate(endsAt) {
  if (!endsAt) return "";
  const d = new Date(endsAt - 8 * 3600 * 1000); // 提交时存 23:59:59+08:00，平移后取东八区日期
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function actLinkRowHTML(label = "", url = "") {
  return `<div class="act-link-row"><input class="inp" maxlength="12" placeholder="名称（≤12字）" value="${esc(label)}"><input class="inp" maxlength="300" placeholder="https://…" value="${esc(url)}"><button type="button" class="btn ghost sm act-link-del" data-act="actLinkDel" title="移除该链接">${icon("x")}</button></div>`;
}

function actEditPanelHTML(a) {
  const mode = a.mode || "official";
  const guide = mode === "guide";
  const chat = mode === "chat";
  const links = Array.isArray(a.links) ? a.links : [];
  const carrierSel = (withAll) => `
    <label>运营商<select class="inp" id="actECarrier">
      ${withAll ? `<option value=""${!a.carrier ? " selected" : ""}>通用（不限定运营商）</option>` : ""}
      ${Object.entries(CARRIER_LABELS).map(([c, n]) => `<option value="${c}"${a.carrier === c ? " selected" : ""}>${n}</option>`).join("")}
    </select></label>`;
  const provSel = `
    <label>省份<select class="inp" id="actEProvince">
      <option value=""${!a.province ? " selected" : ""}>全国${chat ? "（通用含全国）" : ""}</option>
      ${PROMO_PROV_LIST.map((x) => `<option value="${esc(x.n)}"${a.province === x.n ? " selected" : ""}>${esc(x.n)}</option>`).join("")}
    </select></label>`;
  const qrBlock = `
    <label style="flex-direction:row;align-items:center;gap:8px;flex-wrap:wrap">二维码
      ${a.has_qr ? `<span class="opt">已上传，不选新图则保留现图</span>` : `<span class="opt">选填</span>`}
      <button type="button" class="btn ghost sm" data-act="actQrPickAdmin">${icon("image")}${a.has_qr ? "替换图片" : "选择图片"}</button>
      ${state.actQrNew ? `<span class="opt">已选新图</span><button type="button" class="btn ghost sm" data-act="actQrPickAdminClear">撤销新图</button>` : ""}
      ${a.has_qr ? `<label style="flex-direction:row;align-items:center;gap:6px;margin-left:6px"><input type="checkbox" id="actEQrRemove" style="width:16px;height:16px"><span class="opt">移除二维码</span></label>` : ""}
      <input type="file" id="actEQr" accept="image/png,image/jpeg,image/webp" hidden>
    </label>`;
  return `
  <div class="act-edit-panel">
    <div class="rv-head"><span class="rv-board rv-b-act">编辑 · ${ACT_MODE_LABELS[mode] || esc(mode)}</span><span class="rv-title">${esc(a.title || "")}</span></div>
    <div class="act-e-form">
      <label>标题<input class="inp" id="actETitle" maxlength="40" value="${esc(a.title || "")}"></label>
      <label>${chat ? "说明介绍" : "简介"}<textarea class="inp" id="actEDescr" maxlength="200" rows="2">${esc(a.descr || "")}</textarea></label>
      <div class="act-e-row">
        ${carrierSel(guide || chat)}
        ${provSel}
        ${chat ? `
          <label>社群种类<select class="inp" id="actEChatType">${["论坛", "QQ群", "微信群", "贴吧", "纸飞机", "其他"].map((t) => `<option${(a.chat_type || "其他") === t ? " selected" : ""}>${t}</option>`).join("")}</select></label>
          <label>群号/账号<input class="inp" id="actEChatId" maxlength="50" value="${esc(a.chat_id || "")}" placeholder="论坛类可留空走链接"></label>` : ""}
        ${!chat ? `<label>截止日期<input class="inp" id="actEEnds" type="date" value="${actEndsToDate(a.ends_at)}" title="留空 = 长期有效"></label>` : ""}
        ${!chat ? `<label style="flex-direction:row;align-items:center;gap:8px">展示状态<select class="inp" id="actEStatus"><option value="open"${a.status === "open" ? " selected" : ""}>展示中</option><option value="retired"${a.status === "retired" ? " selected" : ""}>已下架</option></select></label>` : ""}
      </div>
      ${!chat ? `
      <label>${guide ? "主链接（选填）" : "活动地址"}<input class="inp" id="actEUrl" maxlength="300" value="${esc(a.url || "")}" placeholder="https://…"></label>
      <div class="act-e-links"><span class="opt">附加链接（选填，≤5 条）</span><div id="actELinks">${links.map((l) => actLinkRowHTML(l.label, l.url)).join("")}</div><button type="button" class="btn ghost sm" data-act="actLinkAdd">${icon("plus")}添加链接</button></div>` : `
      <label>加入链接<input class="inp" id="actEUrl" maxlength="300" value="${esc(a.url || "")}" placeholder="https://…（与群号至少其一）"></label>`}
      ${guide ? `<label>攻略正文（Markdown）</label><div id="actEMdHost"></div>` : ""}
      ${guide || chat ? `<label style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="actEAnon" style="width:16px;height:16px"${a.anon ? " checked" : ""}><span class="opt">匿名展示（公众侧不下发提交者信息）</span></label>` : ""}
      ${qrBlock}
      <div class="act-e-foot">
        <span class="opt">保存后前端展示随下一轮站点数据更新生效（约 0-8 小时）</span>
        <span style="flex:1"></span>
        <button type="button" class="btn ghost" data-act="actCancelEdit">取消</button>
        <button type="button" class="btn primary" data-act="actEditSave" data-id="${esc(a.id)}" data-mode="${mode}">${icon("check")}保存修改</button>
      </div>
    </div>
  </div>`;
}

/* ── 管理员直接编辑（PUT /api/admin/activities/:id）：面板展开/编辑器挂载/收集保存 ── */
function destroyActEditor() {
  if (state.actEditor) { try { state.actEditor.destroy(); } catch { /* */ } state.actEditor = null; }
}

function onActEdit(id) {
  destroyActEditor();
  state.actQrNew = null;
  state.actEditId = state.actEditId === id ? "" : id;   // 再点一次收起
  render();
  const card = document.querySelector(`.rv-card.act-editing`);
  if (card && state.actEditId) card.scrollIntoView({ behavior: "smooth", block: "start" });
}

function onActCancelEdit() {
  destroyActEditor();
  state.actQrNew = null;
  state.actEditId = "";
  render();
}

/* guide 编辑面板的 Markdown 编辑器：整页 render() 后挂载（同 mountSettingMdEditors 模式） */
function mountActEditEditor() {
  if (!state.actEditId) return;
  const host = $("actEMdHost");
  if (!host) return;
  const a = (state.acts || []).find((x) => x.id === state.actEditId);
  if (!a) return;
  state.actEditor = mdCreateEditor(host, {
    maxlength: 10000,
    rows: 12,
    initial: a.content_md || "",
    placeholder: "用 Markdown 写攻略：## 步骤标题、**重点**、[链接文字](https://…)、> 提示、列表",
    nofollow: true,
  });
}

/* 编辑面板选二维码：前端校验类型与 dataURL 体量（后端同款 300KB/魔数校验兜底） */
function onActQrPickAdmin() {
  const input = $("actEQr");
  if (!input) return;
  input.onchange = () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (!/^image\/(png|jpeg|jpg|webp)$/i.test(file.type)) { toast("仅支持 PNG / JPG / WebP 图片"); input.value = ""; return; }
    const fr = new FileReader();
    fr.onload = () => {
      const data = String(fr.result);
      if (data.length > 380000) { toast("图片过大（解码后需 ≤300KB），请压缩后再选"); input.value = ""; return; }
      state.actQrNew = { data };
      render();
    };
    fr.onerror = () => toast("图片读取失败");
    fr.readAsDataURL(file);
  };
  input.click();
}

async function onActEditSave(id, mode) {
  const title = ($("actETitle")?.value || "").trim();
  const descr = ($("actEDescr")?.value || "").trim();
  if (title.length < 2 || title.length > 40) { toast("标题需 2~40 字"); return; }
  if (descr.length > 200) { toast("简介/说明不超过 200 字"); return; }

  const body = { title, descr };
  const anonEl = $("actEAnon");
  if (anonEl) body.anon = anonEl.checked ? 1 : 0;

  // 范围：official 运营商必填；guide/chat 可选通用
  const carrier = $("actECarrier")?.value ?? "";
  const province = $("actEProvince")?.value ?? "";
  if (mode === "official" && !carrier) { toast("官方活动必须指定运营商"); return; }
  if (province && !carrier) { toast("指定省份必须同时指定运营商"); return; }
  body.carrier = carrier;
  body.province = province;

  const url = ($("actEUrl")?.value || "").trim();
  if (url && !/^https:\/\/.+/i.test(url)) { toast("链接必须为 https:// 地址"); return; }

  if (mode === "chat") {
    body.chat_type = $("actEChatType")?.value || "其他";
    body.chat_id = ($("actEChatId")?.value || "").trim();
    if (body.chat_id.length > 50) { toast("群号/账号不超过 50 字"); return; }
    if (!url && !body.chat_id) { toast("加入方式至少提供其一：链接或群号/账号"); return; }
    body.url = url;
  } else {
    body.url = url;
    if (mode === "official" && !/^https:\/\/.+/i.test(url)) { toast("活动地址必须为 https:// 链接"); return; }
    // 附加链接：从动态行收集，空行忽略
    const rows = Array.from(document.querySelectorAll("#actELinks .act-link-row"));
    const links = rows.map((r) => {
      const inp = r.querySelectorAll("input");
      return { label: (inp[0]?.value || "").trim(), url: (inp[1]?.value || "").trim() };
    }).filter((l) => l.label && l.url);
    if (links.length > 5) { toast("附加链接最多 5 条"); return; }
    if (links.some((l) => !/^https:\/\/.+/i.test(l.url))) { toast("附加链接必须为 https:// 地址"); return; }
    body.links = links;
    // 截止：空=长期有效；填了须未来
    const endsRaw = $("actEEnds")?.value || "";
    if (endsRaw) {
      const ends = new Date(endsRaw + "T23:59:59+08:00").getTime();
      if (!Number.isFinite(ends) || ends <= Date.now()) { toast("截止日期必须是未来日期"); return; }
      body.ends_at = ends;
    } else {
      body.ends_at = null;
    }
    if (mode === "guide") {
      const content = state.actEditor ? state.actEditor.getValue().trim() : "";
      if (!content) { toast("攻略正文不能为空"); return; }
      if (content.length > 10000) { toast("攻略正文不超过 10000 字"); return; }
      body.content_md = content;
    }
    const stEl = $("actEStatus");
    if (stEl) body.status = stEl.value;
  }

  // 二维码：新图优先，其次移除勾选；都不动 = 保留现图
  if (state.actQrNew) body.qr = state.actQrNew;
  else if ($("actEQrRemove")?.checked) body.qr_remove = true;

  const r = await api.request(`/api/admin/activities/${encodeURIComponent(id)}`, { method: "PUT", body });
  if (r.ok) {
    destroyActEditor();
    state.actQrNew = null;
    state.actEditId = "";
    toast("已保存，前端展示随下一轮站点数据更新生效（约 0-8 小时）");
    loadTab();
  } else {
    toast(r.error?.message || r.error || "保存失败");
  }
}

async function onActReview(id, approve) {
  let reason = "";
  if (!approve) {
    reason = await admConfirm({
      title: "拒绝该活动提交", message: "将拒绝用户提交的活动，公开展示列表不会包含它。", input: true,
      placeholder: "拒绝原因（必填，如：链接失效 / 非官方活动）", okText: "确认拒绝", danger: true,
    });
    if (reason === null) return;
    if (!reason.trim()) { toast("请填写拒绝原因"); return; }
  } else {
    const okGo = await admConfirm({ title: "通过该投稿", message: "通过后将随下一轮站点数据更新公开展示（约 0-8 小时），并会给投稿用户发送站内通知。", okText: "确认通过" });
    if (okGo !== true) return;
  }
  const r = await api.adminActivityReview(id, !!approve, reason.trim());
  toast(r.ok ? (approve ? "已通过上架" : "已拒绝") : (r.error || "操作失败"));
  if (r.ok) loadTab();
}

async function onActRetire(id) {
  const okGo = await admConfirm({ title: "下架该投稿", message: "下架后资费页「情报酒馆」不再展示（保留记录，可删除）。", okText: "确认下架", danger: true });
  if (!okGo) return;
  const r = await api.adminActivityRetire(id);
  toast(r.ok ? "已下架" : (r.error || "操作失败"));
  if (r.ok) loadTab();
}

async function onActDel(id) {
  const okGo = await admConfirm({ title: "删除该活动", message: "将永久删除此活动记录，不可恢复。", okText: "确认删除", danger: true });
  if (!okGo) return;
  const r = await api.adminActivityDelete(id);
  toast(r.ok ? "已删除" : (r.error || "操作失败"));
  if (r.ok) loadTab();
}

async function onNavReview(id, approve) {
  let reason = "";
  if (!approve) {
    reason = await admConfirm({
      title: "驳回该工具提交", message: "将驳回用户提交的导航链接。", input: true,
      placeholder: "驳回原因（必填）", okText: "确认驳回", danger: true,
    });
    if (reason === null) return;
    if (!reason.trim()) { toast("请填写驳回原因"); return; }
  }
  const r = await api.request(`/api/admin/nav/${encodeURIComponent(id)}/review`, { method: "POST", body: { approve: !!approve, reason: reason.trim() } });
  toast(r.ok ? (approve ? "已通过上架" : "已驳回") : (r.error || "操作失败"));
  if (r.ok) loadTab();
}

async function onNavToggle(id, action) {
  const isRetire = action === "retire";
  const okGo = isRetire ? await admConfirm({ title: "下架该链接", message: "下架后用户端不再展示，可随时重新上架。", okText: "确认下架", danger: true }) : true;
  if (!okGo) return;
  const r = await api.request(`/api/admin/nav/${encodeURIComponent(id)}`, { method: "PUT", body: { status: isRetire ? "retired" : "open" } });
  toast(r.ok ? (isRetire ? "已下架" : "已重新上架") : (r.error || "操作失败"));
  if (r.ok) loadTab();
}

async function onNavDelete(id) {
  const okGo = await admConfirm({ title: "删除该链接", message: "将永久删除此导航链接，不可恢复。", okText: "确认删除", danger: true });
  if (!okGo) return;
  const r = await api.request(`/api/admin/nav/${encodeURIComponent(id)}`, { method: "DELETE" });
  toast(r.ok ? "已删除" : (r.error || "操作失败"));
  if (r.ok) loadTab();
}

function onNavEdit(id) { state.nav.editId = id; render(); }

function onNavCancelEdit() { state.nav.editId = ""; render(); }

async function onNavSave(id) {
  const body = {
    title: $("navETitle")?.value?.trim() ?? "",
    url: $("navEUrl")?.value?.trim() ?? "",
    icon_url: $("navEIcon")?.value?.trim() ?? "",
    descr: $("navEDescr")?.value?.trim() ?? "",
    group_name: $("navEGroup")?.value?.trim() ?? "",
    sort: Number($("navESort")?.value ?? 100),
    featured: $("navEFeatured")?.checked ? 1 : 0,
  };
  if (!body.title) { toast("名称不能为空"); return; }
  if (!body.url) { toast("链接不能为空"); return; }
  const r = await api.request(`/api/admin/nav/${encodeURIComponent(id)}`, { method: "PUT", body });
  if (r.ok) { state.nav.editId = ""; toast("已保存"); loadTab(); }
  else toast(r.error || "保存失败");
}

async function onTkExpand(id) {
  if (state.tickets.openId === id) { state.tickets.openId = ""; state.tickets.detail = null; render(); return; }
  state.tickets.openId = id; state.tickets.detail = null; render();
  const r = await api.request(`/api/tickets/${encodeURIComponent(id)}`);
  if (!r.ok) { toast(r.error || "工单加载失败"); return; }
  state.tickets.detail = r.data;
  render();
}

async function onTkReply(id) {
  const el = $("admTkReply");
  const content = el ? el.value.trim() : "";
  if (!content) { toast("请输入回复内容"); return; }
  const r = await api.request(`/api/tickets/${encodeURIComponent(id)}/messages`, { method: "POST", body: { content } });
  if (!r.ok) { toast(r.error || "回复失败"); return; }
  toast("已回复，工单转回用户");
  await onTkExpand(id);
}

async function onTkClose(id) {
  const okc = await admConfirm({ title: "关闭工单", message: "确定关闭该工单？将标记为「已解决」。", okText: "关闭" });
  if (okc === null) return;
  const r = await api.request(`/api/tickets/${encodeURIComponent(id)}/close`, { method: "POST", body: { reason: "resolved" } });
  if (!r.ok) { toast(r.error || "关闭失败"); return; }
  toast("工单已关闭");
  loadTab();
}

/* ── 帖子管理（筛选 + 搜索 + 分页） ── */
function renderPosts() {
  const ps = state.posts;
  const statusTag = (st) => {
    if (st === "open") return `<span class="adm-tag ok">在售中</span>`;
    if (st === "pending") return `<span class="adm-tag warn">待审核</span>`;
    if (st === "rejected" || st === "closed" || st === "expired") return `<span class="adm-tag danger">${STATUS_LABELS[st]}</span>`;
    return `<span class="adm-tag">${esc(st)}</span>`;
  };
  return `
    <div class="adm-filter">
      <select class="inp" id="admPostsStatus">
        <option value="">全部状态</option>
        ${["pending", "open", "rejected", "closed", "expired"].map((s) => `<option value="${s}"${ps.status === s ? " selected" : ""}>${STATUS_LABELS[s]}</option>`).join("")}
      </select>
      <select class="inp" id="admPostsBoard">
        <option value="">全部板块</option>
        ${["found", "lost", "rent_out", "rent_want"].map((b) => `<option value="${b}"${ps.board === b ? " selected" : ""}>${BOARD_LABELS[b]}</option>`).join("")}
      </select>
      <input class="inp" id="admPostsQ" placeholder="搜索标题 / 城市 / 编号，回车确认" value="${esc(ps.q)}">
    </div>
    ${ps.items.length ? `
    <div class="adm-table-wrap"><table class="adm-table">
      <thead><tr><th>标题</th><th>板块</th><th>归属地</th><th>发布者</th><th>状态</th><th>发布时间</th><th>操作</th></tr></thead>
      <tbody>${ps.items.map((p) => `
        <tr>
          <td class="adm-td-title">${p.post_no ? `<span class="adm-tag">#${p.post_no}</span> ` : ""}${esc(p.title || "(无标题)")}</td>
          <td>${esc(BOARD_LABELS[p.board] || p.board || "-")}</td>
          <td>${esc(p.province || "")} ${esc(p.city || "")}</td>
          <td>${esc(p.user_email || "-")}</td>
          <td>${statusTag(p.status)}</td>
          <td>${fmtTime(p.created_at)}</td>
          <td><div class="adm-actions">
            <button class="btn ghost sm" data-act="postDetail" data-id="${p.id}">详情</button>
            ${p.status === "pending" ? `<button class="btn primary sm" data-act="review" data-id="${p.id}" data-approve="1">通过</button>` : ""}
            ${p.status === "pending" ? `<button class="btn ghost sm" data-act="review" data-id="${p.id}" data-approve="0">拒绝</button>` : ""}
            ${p.status === "open" ? `<button class="btn ghost sm" data-act="closePost" data-id="${p.id}" data-title="${esc(p.title)}">下架</button>` : ""}
            ${Auth.isOwner() ? `<button class="btn danger sm" data-act="delPost" data-id="${p.id}" data-title="${esc(p.title)}">删除</button>` : ""}
          </div></td>
        </tr>`).join("")}</tbody>
    </table></div>
    ${pager(ps.total, ps.page, ps.pageSize, "postsPage")}` : `<div class="adm-empty">没有符合条件的帖子</div>`}`;
}

/* ── 中转意向 ── */
function renderRelay() {
  return `
    <div class="adm-filter">
      <select class="inp" id="admRelayStatus">
        ${[["open", "待处理"], ["handled", "已处理"], ["ignored", "已忽略"]].map(([v, l]) => `<option value="${v}"${state.relayStatus === v ? " selected" : ""}>${l}</option>`).join("")}
      </select>
    </div>
    ${state.relay.length ? state.relay.map((r) => `
    <div class="adm-item">
      <div class="adm-item-head">
        <span class="adm-tag">${r.status === "open" ? "待处理" : r.status === "handled" ? "已处理" : "已忽略"}</span>
        <span class="adm-title">${esc(r.post_title || "(帖子已删除)")}</span>
      </div>
      <div class="adm-item-body">
        <div><b>买家：</b>${esc(r.buyer_name || "")} · ${esc(r.buyer_contact || "")}</div>
        ${r.note ? `<div><b>留言：</b>${esc(r.note)}</div>` : ""}
      </div>
      <div class="adm-item-foot">
        <span class="adm-meta">${fmtTime(r.created_at)}${r.status !== "open" ? " · 处理于 " + fmtTime(r.handled_at) : ""}</span>
        <div class="adm-actions">
          ${r.status === "open" ? `<button class="btn primary sm" data-act="relayHandle" data-id="${r.id}" data-action="handled">标记已处理</button>
          <button class="btn ghost sm" data-act="relayHandle" data-id="${r.id}" data-action="ignored">忽略</button>` : ""}
        </div>
      </div>
    </div>`).join("") : `<div class="adm-empty">暂无中转意向</div>`}`;
}

/* ── 用户管理（筛选 + 搜索 + 分页 + 角色） ── */
/* 站长专用：查看指定用户参与的会话（交易+私信）；点击行跳跳蚤市集直接打开该会话（治理视角只读）。
   仅站长可见此按钮与端点（后端 guard 'owner'），管理员不可见且不感知该能力。 */
async function onAdmUserConvs(id, email) {
  const r = await api.adminConversations(id);
  if (!r.ok) { toast(r.error || "会话查询失败"); return; }
  const items = r.data.items || [];
  const mask = document.createElement("div");
  mask.className = "adm-modal-mask";
  mask.innerHTML = `
    <div class="adm-modal" role="dialog" aria-modal="true" style="max-width:600px">
      <div class="adm-modal-title">会话列表 · ${esc(email)}</div>
      ${items.length ? `
      <div style="max-height:50vh;overflow:auto;display:flex;flex-direction:column;gap:8px;margin:10px 0 14px">
        ${items.map((c) => `
        <button class="btn ghost sm" data-conv="${esc(c.id)}" style="text-align:left;justify-content:flex-start;align-items:flex-start">
          <b>${c.kind === "dm" ? "私信" : "帖子"}</b> · ${esc(c.title || (c.kind === "dm" ? `对方 ${c.other_uid || "?"}` : "（帖子已删除）"))}
          <span style="opacity:.75"> · ${c.msg_count || 0} 条 · ${fmtTime(c.updated_at)}</span>
        </button>`).join("")}
      </div>` : `<div class="adm-modal-msg">该用户暂无会话</div>`}
      <div class="adm-modal-btns"><button class="btn ghost" data-m="close">关闭</button></div>
    </div>`;
  document.body.appendChild(mask);
  mask.addEventListener("click", (e) => {
    if (e.target === mask || e.target.closest('[data-m="close"]')) { mask.remove(); return; }
    const conv = e.target.closest("[data-conv]");
    if (conv) {
      mask.remove();
      try { sessionStorage.setItem("ntf_cardhub_conv", conv.dataset.conv); } catch { /* 隐私模式忽略 */ }
      if (window.Shell && window.Shell.navigate) window.Shell.navigate("/cardhub");
      else location.hash = "/cardhub";
    }
  });
}

function renderUsers() {
  const us = state.users;
  return `
    <div class="adm-filter">
      <select class="inp" id="admUsersStatus">
        <option value="">全部状态</option>
        <option value="active"${us.status === "active" ? " selected" : ""}>正常</option>
        <option value="banned"${us.status === "banned" ? " selected" : ""}>已封禁</option>
      </select>
      <input class="inp" id="admUsersQ" placeholder="搜索邮箱 / UID，回车确认" value="${esc(us.q)}">
    </div>
    ${us.items.length ? `
    <div class="adm-table-wrap"><table class="adm-table">
      <thead><tr><th>邮箱</th><th>角色</th><th>状态</th><th>工单 / 完成帖</th><th>注册时间</th><th>最近登录</th><th>操作</th></tr></thead>
      <tbody>${us.items.map((u) => `
        <tr>
          <td>${esc(u.email)}${u.role === "owner" ? ' <span class="adm-tag warn">站长</span>' : ""}</td>
          <td><span class="adm-tag${u.role === "admin" ? " ok" : ""}">${esc(ROLE_LABELS[u.role] || u.role)}</span></td>
          <td>${u.status === "banned" ? `<span class="adm-tag danger">已封禁</span>` : `<span class="adm-tag ok">正常</span>`}</td>
          <td style="font-variant-numeric:tabular-nums">${u.tickets_total ?? 0} 单 / ${u.posts_closed ?? 0} 帖</td>
          <td>${fmtTime(u.created_at)}</td>
          <td>${fmtTime(u.last_login_at)}</td>
          <td><div class="adm-actions">
            <button class="btn ghost sm" data-act="admUserSet" data-id="${u.id}" data-email="${esc(u.email)}">设置</button>
            ${Auth.isOwner() ? `<button class="btn ghost sm" data-act="admUserConvs" data-id="${u.id}" data-email="${esc(u.email)}">会话</button>` : ""}
            <button class="btn ghost sm" data-act="admTitle" data-id="${u.id}" data-email="${esc(u.email)}" data-title="${esc(u.title || "")}">头衔</button>
            <button class="btn ghost sm" data-act="admAvatar" data-id="${u.id}" data-email="${esc(u.email)}">头像</button>
            ${Auth.isOwner() && u.role !== "owner" ? (u.role === "admin"
              ? `<button class="btn ghost sm" data-act="setRole" data-id="${u.id}" data-role="user" data-email="${esc(u.email)}">降为用户</button>`
              : `<button class="btn ghost sm" data-act="setRole" data-id="${u.id}" data-role="admin" data-email="${esc(u.email)}">设为管理员</button>`) : ""}
            ${u.status === "banned"
              ? `<button class="btn ghost sm" data-act="unban" data-id="${u.id}" data-email="${esc(u.email)}">解封</button>`
              : (u.role === "user" ? `<button class="btn danger sm" data-act="ban" data-id="${u.id}" data-email="${esc(u.email)}">封禁</button>` : "")}
          </div></td>
        </tr>`).join("")}</tbody>
    </table></div>
    ${pager(us.total, us.page, us.pageSize, "usersPage")}` : `<div class="adm-empty">没有符合条件的用户</div>`}`;
}

/* ── 审计日志 ── */
function renderLogs() {
  const ls = state.logs;
  return `
    <div class="adm-filter">
      <select class="inp" id="admLogsAction">
        <option value="">全部动作</option>
        ${Object.entries(ACTION_LABELS).map(([v, l]) => `<option value="${v}"${ls.action === v ? " selected" : ""}>${l}</option>`).join("")}
      </select>
    </div>
    ${ls.items.length ? `
    <div class="adm-table-wrap"><table class="adm-table">
      <thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>对象</th><th>详情</th><th>IP</th></tr></thead>
      <tbody>${ls.items.map((l) => {
        let detail = "";
        try {
          const d = JSON.parse(l.detail_json || "{}");
          const fmtVal = (v) => (Array.isArray(v) || (v && typeof v === "object")) ? JSON.stringify(v) : String(v);
          detail = Object.entries(d).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => k + ": " + fmtVal(v)).join(" · ").slice(0, 160);
        } catch { /* 忽略解析失败 */ }
        return `
        <tr>
          <td>${fmtTime(l.created_at)}</td>
          <td>${esc(l.actor_email)}</td>
          <td><span class="adm-tag">${esc(ACTION_LABELS[l.action] || l.action)}</span></td>
          <td class="adm-td-mono">${esc(l.target_type)}${l.target_id ? " · " + esc(l.target_id) : ""}</td>
          <td class="adm-td-detail">${esc(detail || "-")}</td>
          <td class="adm-td-mono">${esc(l.ip || "-")}</td>
        </tr>`;
      }).join("")}</tbody>
    </table></div>
    ${pager(ls.total, ls.page, 30, "logsPage")}` : `<div class="adm-empty">暂无日志</div>`}`;
}

/* ── 系统设置 ── */
function parseSettingVal(s) {
  const raw = s.value_json !== undefined ? s.value_json : s.value;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
}

/* 设置项说明（key → 备注，问号图标悬停展示）；新增设置时在此补充文案 */
const SETTING_DESC = {
  module_cardhub_enabled: "跳蚤市集模块总开关。关闭后 /api/cardhub/* 接口全部返回 503（立即生效），各页面功能菜单中的「跳蚤市集」入口随下一轮采集部署后隐藏（配置走 Pages 静态快照）。仅站长可修改。",
  turnstile_enforced: "人机验证总开关。开启后登录 / 注册 / 发送邮箱验证码必须先通过 Cloudflare Turnstile 校验；需先在 Cloudflare 后台为本站域名配置站点密钥白名单，否则验证组件拿不到 token，所有人无法登录。",
  owner_email: "站长邮箱。注册该邮箱的账号自动获得 owner（站长）角色。",
  mail_daily_cap: "邮件系统每日发送总量上限，超出后当日暂停发送验证类邮件。",
  site_name: "站点名称，用于邮件标题与页面展示。",
  notification_retention_days: "站内通知（铃铛）保留天数：已读通知超过该天数后，在本人下次打开通知面板时自动清除；未读通知不受影响、永久保留。整数 1~365，默认 30。保存后即时生效（无需等前端部署）。",
  mail_post_review_enabled: "跳蚤市集帖子审核结果的邮件通知开关（管理组通过/驳回帖子时邮件通知帖主）。关闭后仅发站内通知（铃铛），不再发邮件。布尔，默认开启。保存后约 30 秒内生效。仅站长可修改。",
  mail_conversation_enabled: "市集在线沟通新消息的邮件通知开关（买家发起沟通、会话中发消息/发图时邮件通知对方）。关闭后仅发站内通知（铃铛），不再发邮件。布尔，默认开启。保存后约 30 秒内生效。仅站长可修改。",
  mail_relay_request_enabled: "站长中转意向的邮件通知开关（买家提交中转表单时邮件通知帖主）。关闭后不再发邮件（中转意向仍在后台保留可查）。布尔，默认开启。保存后约 30 秒内生效。仅站长可修改。",
  mail_post_expiring_enabled: "帖子到期前 3 天的邮件提醒开关（每日定时任务扫描，仅提醒一次）。关闭后不再发邮件（到期自动下架与站内通知不受影响）。布尔，默认开启。保存后约 30 秒内生效。仅站长可修改。",
  notify_ext_enabled: "站外通知推送总开关。开启后，用户在「通知配置」绑定的钉钉/企业微信渠道会实时收到站内通知的同步推送（私信、审核结果、中转意向等）。关闭后仅发站内铃铛与邮件。布尔，默认关闭。保存后约 30 秒内生效。仅站长可修改。",
  notify_throttle_minutes: "同类通知过滤窗口（分钟）。同一用户 + 同一事件类型 + 同一事件对象（如同一私信会话）在该窗口内只写一条站内铃铛且只推送一次外部渠道——防私信刷屏刷爆铃铛与外部机器人；窗口外的正常事件一条不漏。0 = 关闭过滤，上限 1440（24 小时）。注意：私信场景下窗口内同一会话的后续消息不再单独提醒，打开会话即可见全部内容。整数 0~1440，默认 10。保存后约 30 秒内生效。仅站长可修改。",
  notify_ext_kinds: "站外通知推送的站点级事件白名单（全站放行上限）：勾选的事件类型才允许外接推送，未勾选的只进站内铃铛。用户可在其绑定渠道上再自行勾选接收子集（两级过滤取交集）；你后续放开/缩减时，用户的勾选长期有效无需重选。到期帖/临期提醒/活动到期三类由每日定时任务触发，随青龙批量管线上线后开始推送。保存后约 30 秒内生效。仅站长可修改。",
  promos: "推广列表（与全站公告共用弹窗体系，原「推广」页签已并入「公告」页签，此处仅存数据不再展示）。数据结构 [{id,enabled,title,content,version,mode,scope{carriers,provinces,modules}}]：mode=closable 可关闭每日一次 / must 强制同意；scope 三维度全空 = 全站任意页面，modules 非空 = 仅进入对应模块（资费中心/跳蚤市集/工单中心/觅珍集库）时判定弹出。请勿在设置页直接编辑本键（会绕过公告页签编辑器的规范化校验），一律在「公告」页签操作。保存后 Worker 即时生效，弹窗配置随下一轮采集部署。站长与管理员可修改。",
  promo_reswitch_enabled: "推广「切换重弹」开关（编辑入口在「公告」页签推广分组的「切换重弹」按钮，设置页不展示）。开启 = 访客在资费页切换运营商/省份时，重新判定全站推广并弹出命中新范围且未读的条目；关闭 = 切换不打断、不弹。不影响每日首次进站与模块进入两个触发点；同意记录/「今日不再」天然防重。布尔，未保存过默认开启。站长与管理员可修改。",
  cardhub_trade_merchants: "圈内卡商担保的推荐卡商列表——发帖人发布/编辑帖子勾选「圈内卡商担保」时，从此列表搜索并选择担保人（每帖最多 3 位），帖子详情页展示所选担保人及其热度统计。每行一条，格式：卡商名 | 站内用户UID（可留空） | 一句话介绍（可留空）。条数不限；卡商名必填（≤40 字）且同列表内不可重复——名称是担保人关联与统计标识，改名会使旧帖与该条目的统计关联断开（旧帖仍显示发帖时名称）。绑定 UID 后候选与详情显示头像与「站内」标识、点击弹用户资料卡（介绍随卡片展示）；UID 留空即纯文本卡商，同样可被选为担保人。绑定 UID 必须是站内 active 用户，否则拒绝保存。全部清空则发帖时无候选可选。推荐仅作参考，站点不为所推荐人承担保证。热度统计随快照更新（约 0-8 小时），Worker 兜底接口即时；其余展示在下一轮采集部署后生效。仅站长可修改。",
  ticket_apply_guarantor: "「毛遂自荐 · 申请成为卡商担保人」工单的申请模板。跳蚤市集「毛遂自荐」按钮会把此模板预填进工单表单（用户可修改后提交）。留空则使用系统内置的通用申请框架。模板建议控制在 500 字内（工单正文上限）。前端在下一轮采集部署后生效。仅站长可修改。",
  email_domain_whitelist: "注册/登录邮箱域名白名单（前后台双重校验）。逗号分隔域名，如 qq.com,163.com,gmail.com,foxmail.com。留空 = 使用系统内置常见邮箱列表（QQ/163/126/Gmail/Outlook 等约 20 个）。⚠ 后端校验保存后立即生效——请确保你自己的邮箱域名在列表内，否则将无法登录！前端注册预校验提示走 Pages 静态快照，在下一轮采集部署后更新。仅站长可修改。",
  about_timeline: "关于页「项目历程」横向时间轴的节点配置（内置 6 个默认节点已预填，可直接在其基础上增删改）。每行一个节点，格式：时间 | 阶段名称 | 描述（竖线分隔，时间选填，如 2025.Q4 | 项目起点 | 开发自动化采集脚本）。节点顺序即展示顺序，最后一个节点以绿色圆点标识为当前阶段。清空保存 = 关于页隐藏时间轴区块。仅站长可修改。",
  about_thanks: "关于页「鸣谢名单」配置，位于关于页最底部。每行一条，竖线分隔，三类格式各不相同：任意打赏 | 昵称 | 打赏留言 | 打赏金额 | 打赏渠道 | 打赏时间；反馈建议 | 昵称 | 建议内容摘要 | 建议时间；参考项目 | 项目名 | 项目介绍 | 参考说明 | 项目链接。时间为自由文本（如 2026.10），金额如 ¥20，渠道如 微信/支付宝，链接需 https:// 开头；留空的字段直接省略即可（保持竖线位数一致更易读，但允许省略尾部竖线）。行顺序即组内展示顺序；某一类别无条目则该组不显示；全部留空 = 关于页不显示鸣谢区块。仅站长可修改。",
  cardhub_trade_site_guarantee: "跳蚤市集发布表单「交易方式」中「站点担保」选项的显示开关。关闭后：新发布帖子的表单不再显示该选项，互动渠道「站长中转」随之隐藏；已发布帖子不受影响（交易方式标注照常展示，编辑旧帖时保留原勾选）。前端在下一轮采集部署后生效（板块配置快照随 Pages 部署）。仅站长可修改。",
  site_notice_schedule: "公告弹出日期门槛（编辑入口在「公告」页签「公告弹出日期」块，设置页不展示）。三类（每周/每月/每年）任一命中当天即弹（OR，北京时间）；全部留空 = 不限日期走现有每日首访逻辑，防重规则不变。站长与管理员可修改。",
  promo_placeholders: "公告/推广正文的 {{key}} 占位符取值（值不随前端部署：前端每次会话首次访问向 Worker 拉取一次，保存即生效）。编辑入口在「公告」页签「占位符取值」块，每行一条：键名 | 值（如 quota | 128），键名小写字母/数字/下划线 1~20 位且不可重复，值 ≤200 字。正文里写 {{键名}}，展示时替换为值；未定义的 {{xxx}} 原样显示。仅公告/推广渲染生效，其他 Markdown 不替换。站长与管理员可修改。",
  site_notice_enabled: "全站公告总开关。开启后所有访客与登录用户每日首次进入站点任意页面时弹出公告，可勾选「今日不再弹出」（不勾直接关闭则下次进入/刷新仍弹）。标题与正文分别在 site_notice_title / site_notice_content 配置。公告弹窗随下一轮采集部署生效。站长与管理员可修改。",
  site_notice_title: "全站公告弹窗标题，默认「站点公告」。站长与管理员可修改。",
  site_notice_content: "全站公告正文，支持 Markdown（语法同警告内容）。写维护通知、新功能上线、规则变更等。保存后需开启 site_notice_enabled 才会弹出。所有人每日首次进入弹窗，勾选「今日不再弹出」后当天不再显示。站长与管理员可修改。",
  about_links: "关于页「友情链接」配置（鸣谢名单下方展示）。每行一条，格式：链接名 | 一句话介绍 | 链接（竖线分隔，链接必须 https:// 开头）。每行显示为 链接名 + 一句话介绍，点击整行跳转；清空保存 = 关于页隐藏友情链接区块（用户可通过工单申请友链，站长审核后在此录入）。仅站长可修改。",
};

/* 模板类设置：恒按字符串保存（不做数字/布尔强转，防纯数字标题被转 number）；
   site_notice_title 虽为短文本，也纳入字符串保护 */
const SETTING_TEMPLATE_KEYS = new Set(["ticket_apply_guarantor", "site_notice_content", "site_notice_title"]);
/* MD 编辑器键（site_notice_content 公告正文）：textarea → 带预览的 mdCreateEditor（与酒馆同款组件），
   挂载 handle 存 settingMdEds，保存时经 onSaveSetting 特判取值；渲染后由 mountSettingMdEditors 统一挂载 */
const SETTING_MD_KEYS = new Set(["site_notice_content"]);
const mdMountHTML = (key, text, placeholder, maxlen) =>
  `<div class="adm-md-mount" data-mdkey="${esc(key)}" data-mdinitial="${esc(text)}" data-mdmax="${maxlen}" data-mdplaceholder="${esc(placeholder)}"></div>`;
let settingMdEds = {};
function mountSettingMdEditors() {
  settingMdEds = {};
  document.querySelectorAll(".adm-md-mount").forEach((el) => {
    const key = el.dataset.mdkey;
    if (!key || el.dataset.mounted) return;
    el.dataset.mounted = "1";
    settingMdEds[key] = mdCreateEditor(el, {
      initial: el.dataset.mdinitial || "",
      maxlength: Number(el.dataset.mdmax) || 8000,
      placeholder: el.dataset.mdplaceholder || "",
      rows: 8,
    });
  });
}
/* 已迁至「公告」页签 / 已废弃的键：设置页不再展示（否则会掉进「其他」组重复出现）。
   cardhub_warning_* 已废弃：migration 0030 迁为推广条目 promo_cardhub_warning 并删除原键，
   保留在隐藏名单中兜底（迁移未执行前 DB 中仍有旧行）。
   promos / promo_reswitch_enabled / promo_placeholders 已迁「公告」页签（可视化编辑器），
   site_notice_schedule 编辑入口在「公告」页签「公告弹出日期」块——设置页一律隐藏 */
const SETTING_HIDDEN_KEYS = new Set(["site_notice_enabled", "site_notice_title", "site_notice_content", "cardhub_warning_enabled", "cardhub_warning_content", "promos", "promo_reswitch_enabled", "site_notice_schedule", "promo_placeholders"]);
/* 多行编辑块的 per-key 文案（计数说明 / placeholder / 提示 / 保存按钮文字） */
const SETTING_BLOCK_META = {
  ticket_apply_guarantor: {
    counter: (t) => `已配置 <b>${t.length}</b> 字（工单正文上限 500 字）`,
    placeholder: "填写申请模板文本：用户在各功能页点「毛遂自荐」时自动带入工单表单，可修改后提交。留空则使用系统内置的通用申请框架。",
    hint: "用户提交前可自行修改模板内容",
    saveText: "保存模板",
  },
  site_notice_content: {
    counter: (t) => `已配置 <b>${t.length}</b> 字（上限 8000 字）`,
    placeholder: "支持 Markdown：**加粗**、*斜体*、`代码`、[链接](https://…)、- 列表、# 标题、| 表格 |（首行表头可留空，第二行 |---|---|）&#10;&#10;写维护通知、新功能上线、规则变更等。保存后开启 site_notice_enabled 生效。",
    hint: "所有人每日首次进入弹窗，可勾选「今日不再弹出」",
    saveText: "保存公告内容",
  },
};
/* 列表类设置：输入框逗号/空白分隔 → 保存为数组 */
const SETTING_LIST_KEYS = new Set(["email_domain_whitelist"]);
/* 时间轴类设置：多行「时间 | 阶段 | 描述」→ 保存为 [{t,title,desc}] 数组 */
const SETTING_TIMELINE_KEYS = new Set(["about_timeline"]);
/* 友链类设置：多行「链接名 | 一句话介绍 | 链接」→ 保存为 [{name,descr,url}] 数组（url 需 https:// 开头） */
const SETTING_LINKS_KEYS = new Set(["about_links"]);
/* 卡商推荐类设置：多行「卡商名 | 站内用户UID | 一句话介绍」→ 保存为 条目数组（uid/介绍可留空=纯文本推荐；
   后端校验 uid 必须为 active 用户，前端渲染时绑定条目显示头像+「站内」标识、点击弹资料卡） */
const SETTING_MERCHANT_KEYS = new Set(["cardhub_trade_merchants"]);
/* 公告/推广占位符取值：多行「键名 | 值」→ 保存为 [{key,value}] 数组（后端校验键名格式/唯一，值 ≤200 字） */
const SETTING_PLACEHOLDER_KEYS = new Set(["promo_placeholders"]);
/* 鸣谢名单类设置：多行「类别 | 名称 | 说明 | 链接」→ 保存为 [{cat,name,descr,url}] 数组 */
const SETTING_THANKS_KEYS = new Set(["about_thanks"]);
/* 站外通知推送事件白名单：复选框 chip → 保存为 kind 字符串数组（后端过滤未知 kind） */
const SETTING_KINDS_KEYS = new Set(["notify_ext_kinds"]);
/* 事件 kind → 中文标签：唯一副本在 shell/notify-kinds.js（前端 auth.js / admin.js 共用；
   Worker 侧副本在 common/notifications.ts） */
const THANKS_CAT_LABEL = { donor: "任意打赏", feedback: "反馈建议", ref: "参考项目" };
const THANKS_CAT_KEY = { "任意打赏": "donor", "反馈建议": "feedback", "参考项目": "ref" };
/* 设置页分组展示（仅影响展示顺序与分组标题，不改变键名/取值/保存逻辑；未列出的键归入「其他」组）
   注：全站公告 site_notice_* 已迁至「公告」页签编辑；跳蚤市集警告 cardhub_warning_* 已废弃
   （migration 0030 迁为推广条目并删除原键），两者经 SETTING_HIDDEN_KEYS 从设置页隐藏 */
const SETTING_GROUPS = [
  ["基础信息", ["site_name", "owner_email", "notification_retention_days"]],
  ["安全与准入", ["turnstile_enforced", "email_domain_whitelist", "mail_daily_cap"]],
  ["邮件通知", ["mail_post_review_enabled", "mail_conversation_enabled", "mail_relay_request_enabled", "mail_post_expiring_enabled"]],
  ["站外通知推送", ["notify_ext_enabled", "notify_throttle_minutes", "notify_ext_kinds"]],
  ["跳蚤市集", ["module_cardhub_enabled", "cardhub_trade_site_guarantee", "cardhub_trade_merchants"]],
  ["工单系统", ["ticket_apply_guarantor"]],
  ["关于页", ["about_timeline", "about_thanks", "about_links"]],
];

function renderSettings() {
  if (!state.settings.length) return `<div class="adm-empty">加载中…</div>`;
  const renderOne = (s) => {
    const val = parseSettingVal(s);
    /* 模板类设置：上下堆叠布局（键名行 → 全宽多行编辑器 → 右对齐保存），避免长文本挤在横排卡片里 */
    if (SETTING_TEMPLATE_KEYS.has(s.key)) {
      const text = String(val);
      const meta = SETTING_BLOCK_META[s.key] || {
        counter: (t) => `已配置 <b>${t.length}</b> 字`,
        placeholder: "", hint: "", saveText: "保存",
      };
      /* MD 编辑器键（公告正文）：挂载点 + mountSettingMdEditors 统一挂载，保存经 onSaveSetting 特判取值 */
      const bodyHtml = SETTING_MD_KEYS.has(s.key)
        ? mdMountHTML(s.key, text, meta.placeholder, 8000)
        : `<textarea class="inp adm-setting-ta" rows="7" data-act="inputSetting" data-key="${s.key}" placeholder="${meta.placeholder}">${esc(text)}</textarea>`;
      return `
    <div class="adm-setting adm-setting-block">
      <div class="adm-setting-info">
        <div class="adm-setting-key">${esc(s.key)}${SETTING_DESC[s.key] ? `<span class="help" data-tip="${esc(SETTING_DESC[s.key])}">?</span>` : ""}</div>
        <div class="adm-setting-meta">${meta.counter(text)} · 更新于 ${fmtTime(s.updated_at)}</div>
      </div>
      ${bodyHtml}
      <div class="adm-setting-actions">
        <span class="adm-setting-hint">${meta.hint}</span>
        <button class="btn primary sm" data-act="saveSetting" data-key="${s.key}"><i data-icon="check"></i>${meta.saveText}</button>
      </div>
    </div>`;
    }
    /* 时间轴类设置：行式编辑「时间 | 阶段名称 | 描述」，保存解析为节点数组 */
    if (SETTING_TIMELINE_KEYS.has(s.key)) {
      const rows = Array.isArray(val)
        ? val.map((n) => [n.t || "", n.title || "", n.desc || ""].join(" | ")).join("\n")
        : String(val);
      const n = Array.isArray(val) ? val.length : 0;
      return `
    <div class="adm-setting adm-setting-block">
      <div class="adm-setting-info">
        <div class="adm-setting-key">${esc(s.key)}${SETTING_DESC[s.key] ? `<span class="help" data-tip="${esc(SETTING_DESC[s.key])}">?</span>` : ""}</div>
        <div class="adm-setting-meta">已配置 <b>${n}</b> 个节点 · 更新于 ${fmtTime(s.updated_at)}</div>
      </div>
      <textarea class="inp adm-setting-ta" rows="8" data-act="inputSetting" data-key="${s.key}" placeholder="每行一个节点，格式：时间 | 阶段名称 | 描述&#10;如：2025.Q4 | 项目起点 | 开发自动化采集脚本，实现官网公开资费的程序化整理&#10;时间可留空；节点顺序即展示顺序，最后一个节点标识为当前阶段">${esc(rows)}</textarea>
      <div class="adm-setting-actions">
        <span class="adm-setting-hint">保存后前端在下一轮采集部署时生效</span>
        <button class="btn primary sm" data-act="saveSetting" data-key="${s.key}"><i data-icon="check"></i>保存节点</button>
      </div>
    </div>`;
    }
    /* 鸣谢名单类设置：行式编辑「类别 | 名称 | 附加字段…」（三类格式各异，槽位语义由类别决定），保存解析为条目数组 */
    if (SETTING_THANKS_KEYS.has(s.key)) {
      const rows = Array.isArray(val)
        ? val.map((n) => [THANKS_CAT_LABEL[n.cat] || n.cat || "", n.name || "", n.f1 || "", n.f2 || "", n.f3 || "", n.f4 || ""].join(" | ")).join("\n")
        : String(val);
      const n = Array.isArray(val) ? val.length : 0;
      return `
    <div class="adm-setting adm-setting-block">
      <div class="adm-setting-info">
        <div class="adm-setting-key">${esc(s.key)}${SETTING_DESC[s.key] ? `<span class="help" data-tip="${esc(SETTING_DESC[s.key])}">?</span>` : ""}</div>
        <div class="adm-setting-meta">已配置 <b>${n}</b> 条鸣谢 · 更新于 ${fmtTime(s.updated_at)}</div>
      </div>
      <textarea class="inp adm-setting-ta" rows="8" data-act="inputSetting" data-key="${s.key}" placeholder="三类格式（竖线分隔）：&#10;任意打赏 | 昵称 | 打赏留言 | 打赏金额 | 打赏渠道 | 打赏时间&#10;反馈建议 | 昵称 | 建议内容摘要 | 建议时间&#10;参考项目 | 项目名 | 项目介绍 | 参考说明 | 项目链接&#10;如：任意打赏 | 某某 | 支持一下 | ¥20 | 微信 | 2026.10&#10;时间如 2026.10；多余字段留空即可">${esc(rows)}</textarea>
      <div class="adm-setting-actions">
        <span class="adm-setting-hint">保存后前端在下一轮采集部署时生效</span>
        <button class="btn primary sm" data-act="saveSetting" data-key="${s.key}"><i data-icon="check"></i>保存鸣谢</button>
      </div>
    </div>`;
    }
    /* 友链类设置：行式编辑「链接名 | 一句话介绍 | 链接」，保存解析为条目数组（url 需 https:// 开头） */
    if (SETTING_LINKS_KEYS.has(s.key)) {
      const rows = Array.isArray(val)
        ? val.map((n) => [n.name || "", n.descr || "", n.url || ""].join(" | ")).join("\n")
        : String(val);
      const n = Array.isArray(val) ? val.length : 0;
      return `
    <div class="adm-setting adm-setting-block">
      <div class="adm-setting-info">
        <div class="adm-setting-key">${esc(s.key)}${SETTING_DESC[s.key] ? `<span class="help" data-tip="${esc(SETTING_DESC[s.key])}">?</span>` : ""}</div>
        <div class="adm-setting-meta">已配置 <b>${n}</b> 条友链 · 更新于 ${fmtTime(s.updated_at)}</div>
      </div>
      <textarea class="inp adm-setting-ta" rows="7" data-act="inputSetting" data-key="${s.key}" placeholder="每行一条，格式：链接名 | 一句话介绍 | 链接&#10;如：XX工具站 | 免费的资费查询工具 | https://tools.example.com&#10;链接需 https:// 开头；删除某行即删除该条友链">${esc(rows)}</textarea>
      <div class="adm-setting-actions">
        <span class="adm-setting-hint">保存后前端在下一轮采集部署时生效（Worker 接口 60s 缓存）</span>
        <button class="btn primary sm" data-act="saveSetting" data-key="${s.key}"><i data-icon="check"></i>保存友链</button>
      </div>
    </div>`;
    }
    /* 卡商推荐类设置：行式编辑「卡商名 | 站内用户UID | 一句话介绍」（uid/介绍可留空），保存解析为条目数组 */
    if (SETTING_MERCHANT_KEYS.has(s.key)) {
      const rows = Array.isArray(val)
        ? val.map((n) => typeof n === "string" ? n : [n.name || "", n.uid || "", n.intro || ""].join(" | ")).join("\n")
        : String(val);
      const n = Array.isArray(val) ? val.length : 0;
      return `
    <div class="adm-setting adm-setting-block">
      <div class="adm-setting-info">
        <div class="adm-setting-key">${esc(s.key)}${SETTING_DESC[s.key] ? `<span class="help" data-tip="${esc(SETTING_DESC[s.key])}">?</span>` : ""}</div>
        <div class="adm-setting-meta">已配置 <b>${n}</b> 条推荐 · 更新于 ${fmtTime(s.updated_at)}</div>
      </div>
      <textarea class="inp adm-setting-ta" rows="8" data-act="inputSetting" data-key="${s.key}" placeholder="每行一条，格式：卡商名 | 站内用户UID（可留空） | 一句话介绍（可留空）&#10;如：某某卡商 | a1b2c3d4e5f6 | 从业多年，走担保前先看担保记录&#10;如：某某卡商（站外） |  | 微信 xxx（UID 留空 = 纯文本卡商）&#10;条数不限；卡商名不可重复（发帖人从此列表选择担保人，名称即关联标识）；绑定 UID 后显示头像与「站内」标识、点击弹资料卡">${esc(rows)}</textarea>
      <div class="adm-setting-actions">
        <span class="adm-setting-hint">发帖人勾选「圈内卡商担保」后从此列表选担保人（每帖最多 3 位）；快照随下一轮采集部署生效</span>
        <button class="btn primary sm" data-act="saveSetting" data-key="${s.key}"><i data-icon="check"></i>保存推荐</button>
      </div>
    </div>`;
    }
    /* 站外推送事件白名单：15 类事件复选框 chip，勾选即推送、取消即只进铃铛 */
    if (SETTING_KINDS_KEYS.has(s.key)) {
      const cur = Array.isArray(val) ? val : [];
      return `
    <div class="adm-setting adm-setting-block">
      <div class="adm-setting-info">
        <div class="adm-setting-key">${esc(s.key)}${SETTING_DESC[s.key] ? `<span class="help" data-tip="${esc(SETTING_DESC[s.key])}">?</span>` : ""}</div>
        <div class="adm-setting-meta">已勾选 <b>${cur.length}</b> / ${Object.keys(NOTIFY_KIND_LABELS).length} 类事件 · 更新于 ${fmtTime(s.updated_at)}</div>
      </div>
      <div id="settingKindsBox" style="display:flex;flex-wrap:wrap;gap:8px 18px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--surface-2)">
        ${Object.entries(NOTIFY_KIND_LABELS).map(([k, label]) => `
        <label style="display:inline-flex;align-items:center;gap:5px;font-size:12.5px;color:var(--txt);cursor:pointer;user-select:none">
          <input type="checkbox" data-kind="${esc(k)}" ${cur.includes(k) ? "checked" : ""}>${esc(label)}
        </label>`).join("")}
      </div>
      <div class="adm-setting-actions">
        <span class="adm-setting-hint">未勾选的事件只进站内铃铛，不推送到用户绑定的渠道</span>
        <button class="btn primary sm" data-act="saveSetting" data-key="${s.key}"><i data-icon="check"></i>保存白名单</button>
      </div>
    </div>`;
    }
    return `
    <div class="adm-setting">
      <div class="adm-setting-info">
        <div class="adm-setting-key">${esc(s.key)}${SETTING_DESC[s.key] ? `<span class="help" data-tip="${esc(SETTING_DESC[s.key])}">?</span>` : ""}</div>
        <div class="adm-setting-val">当前值：<code>${esc(String(val))}</code></div>
        <div class="adm-setting-meta">更新于 ${fmtTime(s.updated_at)}</div>
      </div>
      <div class="adm-setting-ctrl">
        ${typeof val === "boolean"
          ? `<button class="btn ${val ? "primary" : "ghost"} sm" data-act="toggleSetting" data-key="${s.key}">${val ? "已开启" : "已关闭"}</button>`
          : `<input class="inp" style="width:160px" data-act="inputSetting" data-key="${s.key}" value="${esc(String(val))}">
             <button class="btn primary sm" data-act="saveSetting" data-key="${s.key}">保存</button>`}
      </div>
    </div>`;
  };
  /* 按分组渲染：组内按 SETTING_GROUPS 固定顺序，未列出的键归入「其他」组兜底 */
  const byKey = new Map(state.settings.map((s) => [s.key, s]));
  const used = new Set();
  const sections = SETTING_GROUPS.map(([title, keys]) => {
    const items = keys.map((k) => byKey.get(k)).filter(Boolean);
    items.forEach((s) => used.add(s.key));
    if (!items.length) return "";
    return `<div class="adm-set-group"><div class="adm-set-group-title">${esc(title)}</div>${items.map(renderOne).join("")}</div>`;
  }).join("");
  const rest = state.settings.filter((s) => !used.has(s.key) && !SETTING_HIDDEN_KEYS.has(s.key));
  const restHtml = rest.length ? `<div class="adm-set-group"><div class="adm-set-group-title">其他</div>${rest.map(renderOne).join("")}</div>` : "";
  return sections + restHtml;
}

/* ═══════════════ 数据加载 ═══════════════ */
/* 初次进入：一次性拉取静态概览（列表页按需加载） */
async function loadAll() {
  const [stats, pending, relay, settings] = await Promise.all([
    api.adminStats(),
    api.adminPending(),
    api.adminRelay(state.relayStatus),
    api.adminSettings(),
  ]);
  if (stats.ok) state.stats = stats.data;
  else toast(stats.error === "NOT_FOUND" ? "统计接口异常" : (stats.error || "统计加载失败"));
  if (pending.ok) state.pending = pending.data.items || pending.data || [];
  if (relay.ok) state.relay = relay.data.items || relay.data || [];
  if (settings.ok) state.settings = Array.isArray(settings.data) ? settings.data : (settings.data.items || []);
  await loadTab();
}

/* 切换标签 / 刷新：只拉当前标签的数据（带筛选与分页参数） */
async function loadTab() {
  destroyActEditor();     // Tab 切换/刷新时回收编辑面板状态（编辑器实例 + 未保存的新选二维码）
  state.actQrNew = null;
  const t = state.tab;
  if (t === "stats") { const r = await api.adminStats(); if (r.ok) state.stats = r.data; }
  else if (t === "review") {
    /* 统一审核：跳蚤市集帖子 + 觅珍集库提交（站长）+ 活动集锦提交（管理员即可） */
    const jobs = [api.adminPending(), api.adminActivityList("pending")];
    if (Auth.isOwner()) jobs.push(api.request("/api/admin/nav?status=pending"));
    const [pr, ar, nr] = await Promise.all(jobs);
    if (pr.ok) state.pending = pr.data.items || pr.data || [];
    if (ar && ar.ok) state.pendingActs = ar.data.items || [];
    state.pendingNav = (Auth.isOwner() && nr && nr.ok) ? (nr.data.items || []) : [];
  }
  else if (t === "acts") {
    /* 活动 Tab：一次拉全量（≤200），状态筛选在客户端做（chips 计数免二次请求） */
    const r = await api.adminActivityList();
    if (r.ok) state.acts = r.data.items || [];
  }
  else if (t === "posts") {
    const ps = state.posts;
    const r = await api.adminPosts({ status: ps.status, board: ps.board, q: ps.q, page: ps.page, page_size: ps.pageSize });
    if (r.ok) { ps.items = r.data.items || []; ps.total = r.data.total ?? ps.items.length; }
  }
  else if (t === "relay") { const r = await api.adminRelay(state.relayStatus); if (r.ok) state.relay = r.data.items || r.data || []; }
  else if (t === "tickets") {
    const ts = state.tickets;
    /* status 空 = 未关闭（待处理+已回复）；不可回退成 all（否则已关闭工单混进未关闭筛选） */
    const r = await api.request(`/api/tickets?box=inbox&status=${encodeURIComponent(ts.status || "")}`);
    if (r.ok) ts.items = r.data.items || [];
  }
  else if (t === "nav") {
    const r = await api.request(`/api/admin/nav?collection=toolbox&status=${encodeURIComponent(state.nav.status || "")}`);
    if (r.ok) state.nav.items = r.data.items || [];
  }
  else if (t === "users") {
    const us = state.users;
    const r = await api.adminUsers({ status: us.status, q: us.q, page: us.page, page_size: us.pageSize });
    if (r.ok) { us.items = r.data.items || []; us.total = r.data.total ?? us.items.length; }
  }
  else if (t === "logs") {
    const ls = state.logs;
    const r = await api.adminAudit({ action: ls.action, page: ls.page, page_size: 30 });
    if (r.ok) { ls.items = r.data.items || []; ls.total = r.data.total ?? ls.items.length; }
  }
  else if (t === "settings" || t === "promos") {
    const r = await api.adminSettings(); if (r.ok) state.settings = Array.isArray(r.data) ? r.data : (r.data.items || []);
    const sr = (state.settings || []).find((x) => x.key === "site_notice_schedule");
    try { state.noticeSchedule = sr ? JSON.parse(sr.value_json || "{}") : {}; } catch { state.noticeSchedule = {}; }
  }
  render();
}

/* ═══════════════ 操作（全部经 admConfirm 二次确认或填参） ═══════════════ */
/* 快照类键：随采集端部署为 Pages 静态配置（data/public-config.json），前端展示在下一轮采集后生效；
   后端限制（接口校验/503 兜底）仍立即生效 */
const SETTING_SNAPSHOT_KEYS = new Set([
  "module_cardhub_enabled", "cardhub_trade_site_guarantee", "cardhub_trade_merchants",
  "ticket_apply_guarantor",
  "site_notice_enabled", "site_notice_title", "site_notice_content",
  "about_timeline", "about_thanks", "about_links", "email_domain_whitelist",
]);
const delayToast = (prefix, key) => SETTING_SNAPSHOT_KEYS.has(key) ? prefix + "，前端展示在下一轮采集部署后生效（后端限制立即生效）" : prefix;

/* ── 审核详情弹窗：用待审队列自带数据渲染完整内容（descr / extra_json / 证明材料），
   弹窗内直接通过 / 拒绝 / 删除（删除仅站长）。板块字段 label 由公开 schema 翻译 ── */
let boardSchemaCache = null;
let fullSchemaCache = null; // 公开 schema 全量（tradeMethods 等预览用）
async function ensureBoardSchema() {
  if (boardSchemaCache) return (boardSchemaCache && boardSchemaCache.boards) || [];
  const r = await api.getSchema();
  fullSchemaCache = r.ok ? r.data : null;
  boardSchemaCache = fullSchemaCache;
  return (boardSchemaCache && boardSchemaCache.boards) || [];
}

const REVIEW_POLICY_LABELS = { public: "所有人可见", users: "仅登录可见", relay_online: "站内在线沟通", relay_owner: "站长中转" };
/* 多渠道模型：可见范围 + 互动渠道（allow_chat/allow_relay）；旧 legacy 单选值兜底 */
const VIS_LABELS = { public: "所有人可见", users: "仅登录可见", hidden: "不展示" };
function contactChannelsText(raw) {
  const visLabel = VIS_LABELS[raw.contact_visibility];
  if (!visLabel) return REVIEW_POLICY_LABELS[raw.contact_policy] || raw.contact_policy || "-";
  const chBits = [raw.allow_chat ? "在线沟通" : "", raw.allow_relay ? "站长中转" : ""].filter(Boolean);
  return chBits.length ? `${visLabel} ＋ ${chBits.join(" ＋ ")}` : visLabel;
}

function reviewFieldHTML(fd, v) {
  if (fd.type === "multi") {
    if (!Array.isArray(v) || !v.length) return "";
    const shown = v.map((it) => {
      const tags = Array.isArray(it.t) && it.t.length ? it.t.join("·") : "";
      const exp = it.expire ? (tags ? "·至" : "至") + it.expire : "";
      const pre = (tags || exp) ? tags + exp + " " : "";
      return pre + String(it.v ?? "") + (fd.unit || "");
    }).join(" ／ ");
    return `<div class="adm-dt-row"><span class="adm-dt-k">${esc(fd.label)}</span><span class="adm-dt-v">${esc(shown)}</span></div>`;
  }
  if (fd.type === "tags") {
    if (!Array.isArray(v) || !v.length) return "";
    return `<div class="adm-dt-row"><span class="adm-dt-k">${esc(fd.label)}</span><span class="adm-dt-v">${esc(v.join(" / "))}</span></div>`;
  }
  if (v == null || v === "") return "";
  const s = String(v);
  const shown = fd.unit && /^\d+$/.test(s) ? s + fd.unit : s;
  return `<div class="adm-dt-row"><span class="adm-dt-k">${esc(fd.label)}</span><span class="adm-dt-v">${esc(shown)}</span></div>`;
}

/* ── 帖子详情弹窗（审核队列 + 帖子管理共用）：三视角预览 ──
   完整数据=管理视角（原始号码/帖内联系方式/发布者邮箱）；
   普通用户/访客视角=后端把帖子模拟上架后走与用户端完全相同的 serializePost 投影，预览零漂移 */
const PV_TABS = [["raw", "完整数据"], ["user", "普通用户视角"], ["guest", "访客视角"]];
const CT_CHANNEL_LABELS = { qq: "QQ", wechat: "微信", phone: "手机", email: "邮箱", other: "其他" };

/* 完整数据（管理视角） */
function admRawHTML(d) {
  const raw = d.raw;
  const extra = raw.extra || {};
  const board = (boardSchemaCache && boardSchemaCache.boards || []).find((b) => b.id === raw.board);
  const fields = board ? board.fields.map((fd) => reviewFieldHTML(fd, extra[fd.key])).join("") : "";
  const trades = Array.isArray(extra.trade_methods) && extra.trade_methods.length
    ? `<div class="adm-dt-row"><span class="adm-dt-k">交易方式</span><span class="adm-dt-v">${esc(extra.trade_methods.map((t) => TRADE_LABELS[t] || t).join(" / "))}${extra.trade_methods.includes("site") ? "" : ' <span style="color:var(--muted)">（未含站点担保）</span>'}</span></div>` : "";
  const contacts = (raw.contacts || []).length
    ? `<div class="adm-dt-row"><span class="adm-dt-k">帖内联系方式</span><span class="adm-dt-v" style="user-select:all">${esc(raw.contacts.map((c) => `${CT_CHANNEL_LABELS[c.channel] || c.channel}:${c.value}`).join(" · "))}</span></div>` : "";
  const phone = raw.phone_plain
    ? `<div class="adm-dt-row"><span class="adm-dt-k">原始号码</span><span class="adm-dt-v" style="user-select:all"><b>${esc(raw.phone_plain)}</b> <span style="color:var(--muted)">（完整号码，仅管理可见）</span></span></div>` : "";
  const author = raw.author
    ? `<div class="adm-dt-row"><span class="adm-dt-k">发布者</span><span class="adm-dt-v">${esc(raw.author.nickname || "未设置昵称")}（${esc(raw.author.title || "平平无奇的路人")}） · ${esc(raw.user_email)}</span></div>`
    : `<div class="adm-dt-row"><span class="adm-dt-k">发布者</span><span class="adm-dt-v">${esc(raw.user_email)}</span></div>`;
  return `
    ${phone}
    <div class="adm-dt-row"><span class="adm-dt-k">标题</span><span class="adm-dt-v"><b>${esc(raw.title || "(无标题)")}</b></span></div>
    <div class="adm-dt-row"><span class="adm-dt-k">板块 / 归属</span><span class="adm-dt-v">${esc(BOARD_LABELS[raw.board] || raw.board || "-")} · ${esc(CARRIER_LABELS[raw.carrier] || raw.carrier || "-")} · ${esc(raw.province || "-")}${raw.city ? " " + esc(raw.city) : ""}</span></div>
    <div class="adm-dt-row"><span class="adm-dt-k">联系方式设置</span><span class="adm-dt-v">${esc(contactChannelsText(raw))}</span></div>
    ${trades}${fields}${contacts}
    <div class="adm-dt-row"><span class="adm-dt-k">详细描述</span><span class="adm-dt-v adm-dt-descr">${esc(raw.descr || "(无)")}</span></div>
    ${(typeof extra.market_body === "string" && extra.market_body.trim()) ? `<div class="adm-dt-row"><span class="adm-dt-k">图文正文</span></div><div class="adm-dt-md">${mdToSafeHtml(extra.market_body, { nofollow: true })}</div>` : ""}
    ${raw.reject_reason ? `<div class="adm-dt-row"><span class="adm-dt-k">拒绝原因</span><span class="adm-dt-v" style="color:var(--red,#c0392b)">${esc(raw.reject_reason)}</span></div>` : ""}
    ${raw.review_admin_id ? `<div class="adm-alert">⚠ 该帖未上传证明材料（发布者选择「指定管理员审核」）。请确认发布者身份是否已通过其他渠道核实。</div>` : ""}
    ${(d.proofs || []).length ? `<div class="adm-dt-row"><span class="adm-dt-k">证明材料</span></div><div class="adm-proofs">${d.proofs.map((pr) => `<img data-adminproof="${esc(raw.id)}|${esc(pr.id)}" alt="证明材料" loading="lazy">`).join("")}</div>` : ""}
    ${author}
    <div class="adm-dt-row"><span class="adm-dt-k">提交时间</span><span class="adm-dt-v">${fmtTime(raw.submitted_at || raw.created_at)}</span></div>`;
}

/* ── 真实视觉预览：动态加载跳蚤市集样式表，用 cardhub 真实组件类名渲染投影数据，
   视觉与用户端一致。模板结构与 cardhub.js 列表卡/详情模板保持同步（cardhub 改版需同步此处） ── */
function ensureCardhubCSS() {
  if (document.querySelector('link[data-admin-cardhub-css]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = (window.__FRONTEND_CONFIG__ ? window.__FRONTEND_CONFIG__.base : "./") + "modules/cardhub/style.css";
  link.setAttribute("data-admin-cardhub-css", "");
  document.head.appendChild(link);
}
async function onAdminPostDetail(id) {
  const r = await api.adminPostDetail(id);
  if (!r.ok) { toast(r.error || "加载失败"); return; }
  const d = r.data;
  await ensureBoardSchema();
  const st = d.raw.status;
  let pv = "raw";
  const statusCls = st === "open" ? "ok" : st === "pending" ? "warn" : "danger";
  const mask = document.createElement("div");
  mask.className = "adm-modal-mask";
  let foot = `<button class="btn ghost" data-rd="close">关闭</button>`;
  if (Auth.isOwner()) foot += `<button class="btn danger" data-rd="del">删除</button>`;
  if (st === "pending") foot += `<button class="btn ghost" data-rd="reject">拒绝</button><button class="btn primary" data-rd="approve">通过</button>`;
  if (st === "open") foot += `<button class="btn ghost" data-rd="takedown">下架</button>`;
  mask.innerHTML = `
    <div class="adm-modal adm-modal-lg" role="dialog" aria-modal="true">
      <div class="adm-modal-title">帖子详情 ${d.raw.post_no ? "#" + d.raw.post_no : ""} <span class="adm-tag ${statusCls}">${STATUS_LABELS[st] || esc(st)}</span></div>
      <div class="adm-pv-tabs">${PV_TABS.map(([k, l]) => `<button type="button" class="adm-pv-tab${k === "raw" ? " active" : ""}" data-pv="${k}">${l}</button>`).join("")}</div>
      <div class="adm-review-body" id="admPvBody"></div>
      <div class="adm-modal-btns">${foot}</div>
    </div>`;
  document.body.appendChild(mask);
  const body = mask.querySelector("#admPvBody");
  const renderPv = () => {
    if (pv === "raw") {
      body.innerHTML = admRawHTML(d);
    } else {
      ensureCardhubCSS(); // 加载跳蚤市集真实样式，弹窗内按用户端视觉渲染（与用户端共用 post-view 渲染）
      const view = viewFromProjection(fullSchemaCache, pv === "user" ? d.userView : d.guestView, { author: d.raw.author, contactPolicy: d.raw.contact_policy });
      const author = d.raw.author
        ? { ...d.raw.author, avatarUrl: d.raw.author.avatar_v ? api.avatarUrl(d.raw.author.id, d.raw.author.avatar_v) : "" }
        : null;
      body.innerHTML = `
        <div class="adm-sec-t">公开列表卡片效果（审核通过后 · 真实渲染）</div>
        <div class="adm-realpreview">${renderListCard(fullSchemaCache, view, { readonly: true, author })}</div>
        <div class="adm-sec-t">公开详情页效果（${pv === "user" ? "登录用户看到" : "未登录访客看到"} · 真实渲染）</div>
        <div class="adm-realpreview">${renderDetailBody(fullSchemaCache, view, { readonly: true, author, isLoggedIn: pv === "user", proofs: d.proofs, proofPublic: d.raw.proof_public === 1, blobAttr: "data-adminproof", proofLink: false, rise: false, ownerContact: (fullSchemaCache && fullSchemaCache.ownerContact) || {} })}</div>`;
    }
    mountIcons(body);
    loadAdminProofs(); // 证明材料缩略图（带鉴权 blob 加载，raw 与预览态均可能含）
  };
  renderPv();
  const close = () => mask.remove();
  mask.addEventListener("mousedown", (e) => { if (e.target === mask) close(); });
  mask.addEventListener("click", async (e) => {
    const pvBtn = e.target.closest("[data-pv]");
    if (pvBtn) {
      pv = pvBtn.dataset.pv;
      mask.querySelectorAll("[data-pv]").forEach((b) => b.classList.toggle("active", b === pvBtn));
      renderPv();
      return;
    }
    const b = e.target.closest("[data-rd]");
    if (!b) return;
    const rd = b.dataset.rd;
    if (rd === "close") return close();
    if (rd === "approve") {
      const rr = await api.adminReview(d.raw.id, true, "");
      toast(rr.ok ? "已通过" : (rr.error || "操作失败"));
      if (rr.ok) { close(); loadTab(); }
      return;
    }
    if (rd === "reject") {
      const reason = await admConfirm({
        title: "拒绝该帖子", message: "将通知发布者并附拒绝原因。", input: true,
        placeholder: "拒绝原因（可留空）", okText: "确认拒绝", danger: true,
      });
      if (reason === null) return;
      const rr = await api.adminReview(d.raw.id, false, reason);
      toast(rr.ok ? "已拒绝" : (rr.error || "操作失败"));
      if (rr.ok) { close(); loadTab(); }
      return;
    }
    if (rd === "del") {
      const okGo = await admConfirm({ title: "彻底删除该帖子", message: `「${d.raw.title}」及其全部对话、消息、中转申请将被永久删除，不可恢复！`, okText: "永久删除", danger: true });
      if (!okGo) return;
      const rr = await api.adminDeletePost(d.raw.id);
      toast(rr.ok ? "已删除" : (rr.error || "操作失败"));
      if (rr.ok) { close(); loadTab(); }
      return;
    }
    if (rd === "takedown") {
      const okGo = await admConfirm({ title: "下架该帖子", message: `「${d.raw.title}」将从跳蚤市集下架（管理员下架）。`, okText: "确认下架", danger: true });
      if (!okGo) return;
      const rr = await api.adminClosePost(d.raw.id);
      toast(rr.ok ? "已下架" : (rr.error || "操作失败"));
      if (rr.ok) { close(); loadTab(); }
      return;
    }
  });
}

async function onReview(id, approve) {
  let reason = "";
  if (!approve) {
    reason = await admConfirm({
      title: "拒绝该帖子", message: "将通知发布者并附拒绝原因。", input: true,
      placeholder: "拒绝原因（可留空）", okText: "确认拒绝", danger: true,
    });
    if (reason === null) return;
  }
  const r = await api.adminReview(id, !!approve, reason);
  toast(r.ok ? (approve ? "已通过" : "已拒绝") : (r.error || "操作失败"));
  if (r.ok) loadTab();
}

async function onClosePost(id, title) {
  const okGo = await admConfirm({ title: "下架该帖子", message: `「${title}」将从跳蚤市集下架，用户可联系管理员恢复。`, okText: "确认下架", danger: true });
  if (!okGo) return;
  const r = await api.adminClosePost(id);
  toast(r.ok ? "已下架" : (r.error || "操作失败"));
  if (r.ok) loadTab();
}

async function onDeletePost(id, title) {
  const okGo = await admConfirm({ title: "彻底删除该帖子", message: `「${title}」及其全部对话、消息、中转申请将被永久删除，不可恢复！`, okText: "永久删除", danger: true });
  if (!okGo) return;
  const r = await api.adminDeletePost(id);
  toast(r.ok ? "已删除" : (r.error || "操作失败"));
  if (r.ok) loadTab();
}

async function onRelayHandle(id, action) {
  const r = await api.adminRelayHandle(id, action);
  toast(r.ok ? "已处理" : (r.error || "操作失败"));
  if (r.ok) loadTab();
}

async function onBan(id, email) {
  const reason = await admConfirm({
    title: "封禁用户", message: `将立即踢下线并禁止其登录：${email}。其全部在售帖子会同时自动下架（解封后不自动恢复）。`, input: true,
    value: "违规操作", placeholder: "封禁原因", okText: "确认封禁", danger: true,
  });
  if (reason === null) return;
  const r = await api.adminBan(id, reason || "违规操作");
  const closed = r.ok && r.data?.closed_posts ? `，联动下架 ${r.data.closed_posts} 条在售帖` : "";
  toast(r.ok ? ("已封禁" + closed) : (r.error || "操作失败"));
  if (r.ok) loadTab();
}

async function onUnban(id, email) {
  const okGo = await admConfirm({ title: "解封用户", message: `恢复 ${email} 的登录与使用权限。`, okText: "确认解封" });
  if (!okGo) return;
  const r = await api.adminUnban(id);
  toast(r.ok ? "已解封" : (r.error || "操作失败"));
  if (r.ok) loadTab();
}

/** 设置用户头衔（总长 ≤26 字中英文均可，多个用「｜」分隔前端拆成多枚小徽章；留空恢复默认「平平无奇的路人」；资料卡展示） */
async function onSetTitle(id, email, cur) {
  const title = await admConfirm({
    title: "设置头衔", message: `为 ${email} 设置展示头衔，将显示在其个人资料卡。多个头衔用「｜」分隔（如：元老｜赞助者）。`,
    input: true, value: cur, placeholder: cur ? "留空恢复默认" : "如：资费通 · 卡界老炮（≤26 字）",
    okText: "保存头衔",
  });
  if (title === null) return;
  if (title.length > 26) { toast("头衔总长不能超过 26 个字"); return; }
  const r = await api.adminSetTitle(id, title.trim());
  toast(r.ok ? (title.trim() ? "头衔已设置" : "已恢复默认头衔") : (r.error || "操作失败"));
  if (r.ok) loadTab();
}

async function onSetRole(id, role, email) {
  const toLabel = role === "admin" ? "管理员" : "普通用户";
  const okGo = await admConfirm({ title: "调整用户角色", message: `将 ${email} 的角色改为「${toLabel}」。`, okText: "确认调整" });
  if (!okGo) return;
  const r = await api.adminSetRole(id, role);
  toast(r.ok ? "已调整" : (r.error || "操作失败"));
  if (r.ok) loadTab();
}

/** 管理员设置用户头像：粘贴图床直链（https 图片外链）。
    图片存图床、D1 只记链接，头像读取走 302 跳转——图片字节流不经站点服务器（CPU 优化）。 */
async function onUploadAvatar(id, email) {
  const url = await admConfirm({
    title: `设置头像 · ${email}`,
    message: "粘贴图床图片直链（https://…，以 .png/.jpg/.webp/.gif 结尾，或受信任图床域名）。图片保存在图床，站点服务器只记录链接、不中转图片流量。",
    input: true, placeholder: "https://…/avatar.png", okText: "保存",
  });
  if (url === null) return; // 取消
  if (!url) { toast("未填写链接"); return; }
  const r = await api.setUserAvatar(id, url);
  toast(r.ok ? `已为 ${email} 更新头像` : ((r.data && r.data.message) || r.error || "设置失败"));
  if (r.ok) loadTab();
}

async function onToggleSetting(key) {
  const cur = state.settings.find((s) => s.key === key);
  const val = cur ? parseSettingVal(cur) : false;
  const okGo = await admConfirm({
    title: `确认${val ? "关闭" : "开启"} ${key}`,
    message: SETTING_DESC[key] || "该设置将立即写入数据库。",
    okText: val ? "确认关闭" : "确认开启", danger: val,
  });
  if (!okGo) return;
  const r = await api.adminUpdateSetting(key, !val);
  toast(r.ok ? delayToast("已更新", key) : (r.error || "操作失败"));
  if (r.ok) loadTab();
}

async function onSaveSetting(key) {
  /* MD 编辑器键（公告正文）：值在组件 handle 里，无 data-act="inputSetting" 元素 */
  const mdEd = settingMdEds && settingMdEds[key];
  const input = document.querySelector(`[data-act="inputSetting"][data-key="${key}"]`);
  /* 事件白名单键：无 inputSetting 元素，值来自勾选的复选框 chip */
  if (SETTING_KINDS_KEYS.has(key)) {
    const kinds = [...document.querySelectorAll('#settingKindsBox input[type="checkbox"]:checked')].map((x) => x.dataset.kind);
    const r = await api.adminUpdateSetting(key, kinds);
    toast(r.ok ? delayToast("已保存", key) : (r.error || "操作失败"));
    if (r.ok) loadTab();
    return;
  }
  if (!input && !mdEd) return;
  let val = mdEd ? mdEd.getValue().trim() : input.value.trim();
  // 尝试解析为数字/布尔，其余按字符串保存（后端 JSON.stringify）；模板类恒为字符串、列表类转数组、时间轴类转节点数组
  if (SETTING_TIMELINE_KEYS.has(key)) {
    val = input.value.split("\n")
      .map((line) => {
        const parts = line.split("|").map((x) => x.trim());
        return { t: parts[0] || "", title: parts[1] || "", desc: parts[2] || "" };
      })
      .filter((n) => n.title);
  } else if (SETTING_THANKS_KEYS.has(key)) {
    val = input.value.split("\n")
      .map((line) => {
        const parts = line.split("|").map((x) => x.trim());
        return { cat: THANKS_CAT_KEY[parts[0]] || parts[0] || "", name: parts[1] || "", f1: parts[2] || "", f2: parts[3] || "", f3: parts[4] || "", f4: parts[5] || "" };
      })
      .filter((n) => n.name && (n.cat === "donor" || n.cat === "feedback" || n.cat === "ref"));
  } else if (SETTING_LIST_KEYS.has(key)) {
    val = val.split(/[,，\s]+/).filter(Boolean); // 兼容英文/中文逗号与空白分隔
  } else if (SETTING_LINKS_KEYS.has(key)) {
    val = val.split("\n")
      .map((line) => {
        const parts = line.split("|").map((x) => x.trim());
        return { name: parts[0] || "", descr: parts[1] || "", url: parts[2] || "" };
      })
      .filter((n) => n.name && /^https:\/\//.test(n.url)); // 链接必须 https:// 开头，非法行丢弃
  } else if (SETTING_MERCHANT_KEYS.has(key)) {
    /* 统一传对象 {name, uid, intro}，由后端规范化：uid/intro 全空回落纯字符串条目（与旧格式同形） */
    val = val.split("\n")
      .map((line) => {
        const parts = line.split("|").map((x) => x.trim());
        return { name: parts[0] || "", uid: parts[1] || "", intro: parts[2] || "" };
      })
      .filter((n) => n.name);
  } else if (SETTING_PLACEHOLDER_KEYS.has(key)) {
    /* 「键名 | 值」：首个竖线后全部作为值（值本身可含竖线）；后端校验键名格式/唯一 */
    val = input.value.split("\n")
      .map((line) => {
        const idx = line.indexOf("|");
        return idx < 0
          ? { key: line.trim(), value: "" }
          : { key: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
      })
      .filter((n) => n.key);
  } else if (!SETTING_TEMPLATE_KEYS.has(key)) {
    if (val === "true") val = true;
    else if (val === "false") val = false;
    else if (val !== "" && !isNaN(Number(val))) val = Number(val);
  }
  const r = await api.adminUpdateSetting(key, val);
  toast(r.ok ? delayToast("已保存", key) : (r.error || "操作失败"));
  if (r.ok) loadTab();
}

/* ═══════════════ 事件绑定（document 级委托，onExit 解绑） ═══════════════ */
let clickHandler = null;
let inputHandler = null;
let debounceTimer = 0;

function bindEvents() {
  unbindEvents();
  clickHandler = (e) => {
    const tab = e.target.closest("[data-tab]");
    if (tab) { state.tab = tab.dataset.tab; render(); loadTab(); return; }
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act;
    if (act === "goBack") { Shell.navigate(state.fromRoute || "/"); return; }
    if (act === "goConfig") { Shell.navigate("/config"); return; }
    if (act === "navReview") { onNavReview(el.dataset.id, el.dataset.approve === "1"); return; }
    if (act === "actReview") { onActReview(el.dataset.id, el.dataset.approve === "1"); return; }
    if (act === "actDetail") { onActDetail(el.dataset.id); return; }
    if (act === "actRetire") { onActRetire(el.dataset.id); return; }
    if (act === "actDel") { onActDel(el.dataset.id); return; }
    if (act === "actQrPeek") {
      api.activityQrBlobUrl(el.dataset.id).then((u) => window.open(u, "_blank")).catch(() => toast("二维码加载失败"));
      return;
    }
    if (act === "chatProof") {
      api.communityProofBlobUrl(el.dataset.id).then((u) => window.open(u, "_blank")).catch(() => toast("凭证加载失败"));
      return;
    }
    if (act === "actFilter") { state.actStatus = el.dataset.v || ""; render(); return; }
    if (act === "actModeFilter") { state.actMode = el.dataset.v || ""; render(); return; }
    if (act === "actEdit") { onActEdit(el.dataset.id); return; }
    if (act === "actCancelEdit") { onActCancelEdit(); return; }
    if (act === "actEditSave") { onActEditSave(el.dataset.id, el.dataset.mode || "official"); return; }
    if (act === "actLinkAdd") {
      const box = $("actELinks");
      if (box) {
        if (box.children.length >= 5) { toast("附加链接最多 5 条"); return; }
        box.insertAdjacentHTML("beforeend", actLinkRowHTML());
      }
      return;
    }
    if (act === "actLinkDel") { const row = el.closest(".act-link-row"); if (row) row.remove(); return; }
    if (act === "actQrPickAdmin") { onActQrPickAdmin(); return; }
    if (act === "actQrPickAdminClear") { state.actQrNew = null; render(); return; }
    if (act === "navRetire") { onNavToggle(el.dataset.id, "retire"); return; }
    if (act === "navRestore") { onNavToggle(el.dataset.id, "restore"); return; }
    if (act === "navDelete") { onNavDelete(el.dataset.id); return; }
    if (act === "navEdit") { onNavEdit(el.dataset.id); return; }
    if (act === "navCancelEdit") { onNavCancelEdit(); return; }
    if (act === "navSave") { onNavSave(el.dataset.id); return; }
    if (act === "refresh") { loadTab(); return; }
    if (act === "reviewDetail" || act === "postDetail") { onAdminPostDetail(el.dataset.id); return; }
    if (act === "reviewSrc") { state.reviewFilter.source = el.dataset.v || ""; if (state.reviewFilter.source === "nav") state.reviewFilter.board = ""; render(); return; }
    if (act === "reviewBoard") { state.reviewFilter.board = el.dataset.v || ""; render(); return; }
    if (act === "review") { onReview(el.dataset.id, el.dataset.approve === "1"); return; }
    if (act === "closePost") { onClosePost(el.dataset.id, el.dataset.title); return; }
    if (act === "delPost") { onDeletePost(el.dataset.id, el.dataset.title); return; }
    if (act === "relayHandle") { onRelayHandle(el.dataset.id, el.dataset.action); return; }
    if (act === "ban") { onBan(el.dataset.id, el.dataset.email); return; }
    if (act === "unban") { onUnban(el.dataset.id, el.dataset.email); return; }
    if (act === "setRole") { onSetRole(el.dataset.id, el.dataset.role, el.dataset.email); return; }
    if (act === "admAvatar") { onUploadAvatar(el.dataset.id, el.dataset.email); return; }
    if (act === "admUserSet") { Auth.openSettingsFor(el.dataset.id); return; }
    if (act === "admUserConvs") { onAdmUserConvs(el.dataset.id, el.dataset.email); return; }
    if (act === "admTitle") { onSetTitle(el.dataset.id, el.dataset.email, el.dataset.title || ""); return; }
    if (act === "toggleSetting") { onToggleSetting(el.dataset.key); return; }
    if (act === "saveSetting") { onSaveSetting(el.dataset.key); return; }
    if (act === "promoNew") { state.promos.editId = "new"; render(); return; }
    if (act === "promoReswitchToggle") { onPromoReswitchToggle(); return; }
    if (act === "saveNoticeSchedule") { onSaveNoticeSchedule(); return; }
    if (act === "promoEdit") { state.promos.editId = el.dataset.id; render(); return; }
    if (act === "promoCancelEdit") { state.promos.editId = ""; render(); return; }
    if (act === "promoChip") { el.classList.toggle("active"); return; }
    if (act === "promoSave") { onPromoSave(el.dataset.id); return; }
    if (act === "promoToggle") { onPromoToggle(el.dataset.id); return; }
    if (act === "promoDelete") { onPromoDelete(el.dataset.id); return; }
    if (act === "postsPage") { state.posts.page = Number(el.dataset.page); loadTab(); return; }
    if (act === "tkExpand") { onTkExpand(el.dataset.id); return; }
    if (act === "tkReply") { onTkReply(el.dataset.id); return; }
    if (act === "tkClose") { onTkClose(el.dataset.id); return; }
    if (act === "usersPage") { state.users.page = Number(el.dataset.page); loadTab(); return; }
    if (act === "logsPage") { state.logs.page = Number(el.dataset.page); loadTab(); return; }
  };
  document.addEventListener("click", clickHandler);

  /* 筛选下拉：变更即刷新；搜索输入：300ms 防抖，回车立即 */
  inputHandler = (e) => {
    const t = e.target;
    if (t.id === "admPostsStatus") { state.posts.status = t.value; state.posts.page = 1; loadTab(); }
    else if (t.id === "admPostsBoard") { state.posts.board = t.value; state.posts.page = 1; loadTab(); }
    else if (t.id === "admPostsQ") {
      clearTimeout(debounceTimer);
      const apply = () => { state.posts.q = t.value.trim(); state.posts.page = 1; loadTab(); };
      if (e.type === "keydown" && e.key === "Enter") apply();
      else if (e.type === "input") debounceTimer = setTimeout(apply, 400);
    }
    else if (t.id === "admUsersStatus") { state.users.status = t.value; state.users.page = 1; loadTab(); }
    else if (t.id === "admUsersQ") {
      clearTimeout(debounceTimer);
      const apply = () => { state.users.q = t.value.trim(); state.users.page = 1; loadTab(); };
      if (e.type === "keydown" && e.key === "Enter") apply();
      else if (e.type === "input") debounceTimer = setTimeout(apply, 400);
    }
    else if (t.id === "admLogsAction") { state.logs.action = t.value; state.logs.page = 1; loadTab(); }
    else if (t.id === "admRelayStatus") { state.relayStatus = t.value; loadTab(); }
    else if (t.id === "admTkStatus") { state.tickets.status = t.value; loadTab(); }
    else if (t.id === "admNavStatus") { state.nav.status = t.value; state.nav.editId = ""; loadTab(); }
  };
  document.addEventListener("input", inputHandler);
  document.addEventListener("keydown", inputHandler);
  document.addEventListener("change", inputHandler);
}

function unbindEvents() {
  if (clickHandler) { document.removeEventListener("click", clickHandler); clickHandler = null; }
  if (inputHandler) {
    document.removeEventListener("input", inputHandler);
    document.removeEventListener("keydown", inputHandler);
    document.removeEventListener("change", inputHandler);
    inputHandler = null;
  }
}

/* ═══════════════ 样式注入 ═══════════════ */
const CSS = `
.act-editing{outline:2px solid var(--accent);outline-offset:2px;border-radius:12px}
.act-edit-panel{margin-top:12px;border-top:1px dashed var(--border);padding-top:14px}
.act-e-form{display:flex;flex-direction:column;gap:12px;margin-top:10px}
.act-e-form>label{display:flex;flex-direction:column;gap:6px;font-size:12.5px;font-weight:600;color:var(--text)}
.act-e-form .inp{font-size:13px;padding:8px 10px}
.act-e-row{display:flex;gap:10px;flex-wrap:wrap}
.act-e-row>label{flex:1 1 150px;min-width:140px}
.act-e-links{display:flex;flex-direction:column;gap:6px}
.act-link-row{display:flex;gap:8px;align-items:center}
.act-link-row .inp{flex:1 1 120px;min-width:0}
.act-link-del{flex:none}
.act-e-foot{display:flex;align-items:center;gap:10px;margin-top:2px;flex-wrap:wrap}
.adm-topbar{display:flex;align-items:center;justify-content:space-between;height:56px;padding:0 16px;background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:50}
.adm-brand{display:flex;align-items:center;gap:10px}
.adm-logo{width:32px;height:32px;border-radius:8px;background:var(--accent-bg);color:var(--accent);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.adm-logo svg{width:18px;height:18px}
.adm-brand-text{font-size:15px;font-weight:700;color:var(--text)}
.adm-actions{display:flex;align-items:center;gap:8px}
.adm-wrap{max-width:1200px;margin:0 auto;padding:24px 20px 80px}
.adm-tabs-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:20px;border-bottom:1px solid var(--border)}
.adm-tabs{display:flex;gap:2px;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none}
.adm-tabs::-webkit-scrollbar{display:none}
.adm-tab{display:flex;align-items:center;gap:6px;padding:10px 14px;background:none;border:none;color:var(--muted);font-size:14px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;white-space:nowrap}
.adm-tab:hover{color:var(--text)}
.adm-tab.active{color:var(--accent);border-bottom-color:var(--accent)}
.adm-tab svg{width:16px;height:16px;flex-shrink:0}
.adm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px}
.adm-card{background:var(--surface-2);border:1px solid var(--border);border-radius:12px;padding:18px}
.adm-card-val{font-size:28px;font-weight:700;color:var(--text)}
.adm-card-label{font-size:13px;color:var(--muted);margin-top:4px}
.adm-card-sub{font-size:12px;color:var(--muted);margin-top:2px}
.adm-item{background:var(--surface-2);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:12px}
.adm-item-head{display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap}
.adm-tag{font-size:11px;padding:2px 8px;border-radius:4px;background:var(--accent-bg);color:var(--accent);font-weight:600;white-space:nowrap}
.adm-tag.ok{background:rgba(34,197,94,.12);color:#22c55e}
.adm-tag.warn{background:rgba(245,158,11,.12);color:#f59e0b}
.adm-tag.danger{background:rgba(239,68,68,.12);color:#ef4444}
.adm-title{font-size:15px;font-weight:600;color:var(--text)}
.adm-meta{font-size:12px;color:var(--muted)}
.adm-item-body{font-size:13px;color:var(--text);line-height:1.6;margin-bottom:8px;white-space:pre-wrap;word-break:break-all}
.adm-trade{font-size:12px;color:var(--text)}
.adm-proofs{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.adm-proofs img{width:88px;height:88px;object-fit:cover;border-radius:8px;border:1px solid var(--border);cursor:zoom-in}
.adm-proofs img.dead{display:grid;place-items:center;font-size:11px;color:var(--muted)}
.adm-alert{margin-top:8px;padding:8px 12px;border-radius:8px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.35);color:#ef4444;font-size:12.5px;line-height:1.6}
/* 工单处理 */
.adm-tk-msgs{margin-top:10px;display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:10px;background:var(--surface-2,rgba(0,0,0,.03))}
.adm-tk-msg .adm-tk-msg-head{font-size:11px;color:var(--muted);margin-bottom:2px}
.adm-tk-msg .adm-tk-msg-body{font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-all;padding:8px 12px;border-radius:10px;background:var(--surface);border:1px solid var(--border)}
.adm-tk-msg.staff .adm-tk-msg-body{border-color:rgba(59,130,246,.4);background:rgba(59,130,246,.06)}
.adm-tk-reply{margin-top:4px}
.adm-tk-reply textarea{width:100%}
.adm-item-foot{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
/* 觅珍集库行内编辑 */
.adm-nav-edit{margin-top:10px;padding:10px 12px;border-radius:10px;background:var(--surface-2,rgba(0,0,0,.03));border:1px solid var(--border)}
.adm-nav-edit-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.adm-nav-edit-grid label{display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--muted)}
@media (max-width:640px){.adm-nav-edit-grid{grid-template-columns:1fr}}
.adm-empty{text-align:center;padding:60px 20px;color:var(--muted);font-size:14px}
/* 筛选栏 */
.adm-filter{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}
.adm-filter .inp{width:auto;min-width:130px;flex:1;max-width:280px}
/* 表格：容器横向滚动，避免窄屏挤压 */
.adm-table-wrap{overflow-x:auto;border:1px solid var(--border);border-radius:12px;background:var(--surface-2)}
.adm-table{width:100%;border-collapse:collapse;min-width:640px}
.adm-table th,.adm-table td{padding:12px 14px;text-align:left;font-size:13px;border-bottom:1px solid var(--border);white-space:nowrap}
.adm-table th{background:var(--surface);color:var(--muted);font-weight:600;font-size:12px;position:sticky;top:0}
.adm-table tr:last-child td{border-bottom:none}
.adm-td-title{max-width:220px;overflow:hidden;text-overflow:ellipsis}
.adm-td-mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
.adm-td-detail{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:normal;color:var(--muted)}
/* 分页条 */
.adm-pager{display:flex;justify-content:space-between;align-items:center;margin-top:14px;gap:8px;flex-wrap:wrap}
/* 设置项 */
.adm-setting{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;background:var(--surface-2);border:1px solid var(--border);border-radius:12px;margin-bottom:10px;flex-wrap:wrap;gap:12px}
.adm-setting-key{font-weight:600;color:var(--text)}
/* 问号帮助（与 config 同款：hover 毛玻璃 tooltip） */
.help{display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:50%;border:1px solid var(--line);color:var(--sub);font-size:10px;font-weight:800;cursor:help;position:relative;vertical-align:middle;margin-left:6px;flex:none;background:var(--surface);transition:border-color .2s,color .2s}
.help:hover{border-color:var(--acc);color:var(--acc)}
.help::after{content:attr(data-tip);position:absolute;left:50%;bottom:calc(100% + 9px);transform:translateX(-50%) translateY(5px);width:max-content;max-width:340px;white-space:normal;padding:9px 13px;border-radius:10px;background:var(--glass-strong);backdrop-filter:blur(8px) saturate(1.3);-webkit-backdrop-filter:blur(8px) saturate(1.3);border:1px solid color-mix(in oklab, var(--line) 90%, transparent);box-shadow:var(--shadow-2);font-size:12px;font-weight:400;color:var(--txt);line-height:1.6;text-align:left;opacity:0;pointer-events:none;transition:opacity .22s var(--ease),transform .22s var(--spring);z-index:60}
.help:hover::after{opacity:1;transform:translateX(-50%) translateY(0)}
.adm-setting-val{font-size:13px;color:var(--muted);margin-top:2px}
.adm-setting-meta{font-size:11px;color:var(--muted);margin-top:2px}
.adm-setting-ctrl{display:flex;gap:8px;align-items:center}
/* 模板类设置（上下堆叠布局）：全宽多行编辑器 + 右对齐操作行 */
.adm-setting-block{display:block}
.adm-setting-block .adm-setting-meta b{color:var(--acc)}
.adm-setting-ta{width:100%;margin-top:12px;min-height:150px;line-height:1.7;font-size:13px;font-family:var(--mono,monospace);resize:vertical}
.adm-setting-actions{display:flex;justify-content:flex-end;align-items:center;gap:12px;margin-top:10px}
.adm-setting-hint{font-size:11.5px;color:var(--muted);margin-right:auto}
/* 设置页分组 */
.adm-set-group{margin-bottom:24px}
.adm-set-group-title{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:800;color:var(--text);margin:0 0 10px;padding-bottom:8px;border-bottom:1px solid var(--border)}
.adm-set-group-title::before{content:"";flex:none;width:3px;height:14px;border-radius:2px;background:var(--acc)}
.adm-set-group .adm-setting:last-child{margin-bottom:0}
/* 确认弹窗 */
.btn.danger{background:#ef4444;color:#fff}
.btn.danger:hover{background:#dc2626}
.btn:disabled{opacity:.45;cursor:not-allowed}
.adm-modal-mask{position:fixed;inset:0;background:rgba(0,0,0,.45);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;z-index:1000;padding:20px;animation:admFade .18s ease}
.adm-modal{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:22px;max-width:400px;width:100%;box-shadow:var(--shadow-2,0 20px 50px rgba(0,0,0,.25));animation:admPop .2s cubic-bezier(.2,.9,.3,1.2)}
.adm-modal-title{font-size:16px;font-weight:700;color:var(--text);margin-bottom:8px}
.adm-modal-msg{font-size:13px;color:var(--muted);line-height:1.6;margin-bottom:14px;word-break:break-all}
.adm-modal-inp{width:100%;margin-bottom:14px}
.adm-modal-btns{display:flex;justify-content:flex-end;gap:8px}
.adm-modal-lg{max-width:680px;max-height:82vh;display:flex;flex-direction:column}
.adm-review-body{overflow-y:auto;margin:4px 0 14px;padding-right:6px;display:flex;flex-direction:column;gap:8px}
.adm-dt-row{display:flex;gap:12px;font-size:13px;line-height:1.6}
.adm-dt-k{flex:none;width:88px;color:var(--muted)}
.adm-dt-v{flex:1;min-width:0;color:var(--text);word-break:break-all}
.adm-dt-descr{white-space:pre-wrap;user-select:all}
/* 图文正文（market_body）+ 攻略正文（content_md）渲染排版：与发布端 .act-md 同款数值（表格走 theme.css 全局 .md-tbl） */
.adm-dt-md,.adm-act-md{margin:2px 0 10px;font-size:13.5px;line-height:1.85;color:var(--text);overflow-wrap:anywhere}
.adm-dt-md h3,.adm-dt-md h4,.adm-dt-md h5,.adm-dt-md h6,.adm-act-md h3,.adm-act-md h4,.adm-act-md h5,.adm-act-md h6{margin:14px 0 6px;line-height:1.5;color:var(--text)}
.adm-dt-md h3,.adm-act-md h3{font-size:15.5px}.adm-dt-md h4,.adm-act-md h4{font-size:14.5px}.adm-dt-md h5,.adm-dt-md h6,.adm-act-md h5,.adm-act-md h6{font-size:13.5px}
.adm-dt-md p,.adm-act-md p{margin:0 0 8px}
.adm-dt-md ul,.adm-dt-md ol,.adm-act-md ul,.adm-act-md ol{margin:0 0 8px;padding-left:20px}
.adm-dt-md li,.adm-act-md li{margin:2px 0}
.adm-dt-md blockquote,.adm-act-md blockquote{margin:8px 0;padding:8px 12px;border-left:3px solid color-mix(in oklab,var(--acc) 55%,transparent);background:var(--surface);border-radius:0 8px 8px 0;color:var(--muted)}
.adm-dt-md code,.adm-act-md code{font-family:var(--mono);font-size:12px;padding:1px 5px;border-radius:5px;background:var(--surface)}
.adm-dt-md a,.adm-act-md a{color:var(--acc)}
.adm-dt-md hr,.adm-act-md hr{border:0;border-top:1px solid var(--border);margin:12px 0}
.adm-dt-md .md-img,.adm-act-md .md-img{margin:10px 0;text-align:center}
.adm-dt-md .md-img img,.adm-act-md .md-img img{max-width:100%;max-height:420px;border-radius:10px;border:1px solid var(--border)}
.adm-pv-tabs{display:flex;gap:6px;margin:2px 0 12px;flex-wrap:wrap}
.adm-pv-tab{border:1px solid var(--border);background:var(--surface);color:var(--muted);border-radius:999px;padding:4px 14px;font-size:12.5px;cursor:pointer}
.adm-pv-tab.active{background:var(--acc);border-color:transparent;color:#fff}
.adm-sec-t{font-size:12px;font-weight:700;color:var(--muted);margin:6px 0 2px}
.adm-chip{display:inline-flex;align-items:center;border:1px solid var(--border);border-radius:999px;padding:2px 8px;font-size:11.5px;margin:0 4px 4px 0;color:var(--text)}
.adm-realpreview{border:1px solid var(--border);border-radius:12px;padding:16px;background:var(--surface-2,var(--surface));margin-bottom:2px;flex:none}
/* 预览是只读快照：容器内所有按钮/链接禁止交互（视觉保留） */
.adm-realpreview button,.adm-realpreview a{pointer-events:none;cursor:default}
/* ── 审核中心：筛选 chips + 来源/板块彩色标签 + 卡片呼吸感 ── */
.rv-filters{display:flex;flex-direction:column;gap:8px;margin-bottom:16px;padding:12px 16px;border:1px solid var(--border);border-radius:12px;background:var(--surface-2,var(--surface))}
.rv-filter-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.rv-filter-label{flex:none;font-size:12px;color:var(--muted);width:34px}
.rv-chip{border:1px solid var(--border);background:var(--surface);color:var(--muted);border-radius:999px;padding:3px 13px;font-size:12px;cursor:pointer}
.rv-chip.active{background:var(--acc);border-color:transparent;color:#fff}
.rv-chip-n{display:inline-flex;justify-content:center;min-width:16px;padding:0 5px;margin-left:3px;border-radius:999px;background:color-mix(in oklch,currentColor 15%,transparent);font-size:10.5px;font-weight:600}
.rv-card{padding:16px 18px;display:flex;flex-direction:column;gap:0}
.rv-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rv-src{flex:none;font-size:11px;padding:2px 10px;border-radius:999px;background:color-mix(in oklch,var(--acc) 13%,var(--surface));color:var(--acc);font-weight:600}
.rv-src-nav{background:color-mix(in oklch,#8b5cf6 13%,var(--surface));color:#8b5cf6}
.rv-src-act{background:color-mix(in oklch,#f59e0b 14%,var(--surface));color:#d97706}
.rv-b-act{background:color-mix(in oklch,#f59e0b 10%,var(--surface));color:#d97706}
.rv-board{flex:none;font-size:11px;padding:2px 10px;border-radius:999px;font-weight:600}
.rv-b-found{background:color-mix(in oklch,#22c55e 14%,var(--surface));color:#16a34a}
.rv-b-lost{background:color-mix(in oklch,#3b82f6 14%,var(--surface));color:#2563eb}
.rv-b-rent_out{background:color-mix(in oklch,#f59e0b 15%,var(--surface));color:#d97706}
.rv-b-rent_want{background:color-mix(in oklch,#8b5cf6 14%,var(--surface));color:#7c3aed}
.rv-b-nav{background:var(--surface-3,var(--surface));color:var(--muted)}
.rv-title{font-size:15px;font-weight:700;color:var(--text)}
.rv-no{font-size:12px;color:var(--muted)}
.rv-body{margin:10px 0 12px;display:flex;flex-direction:column;gap:8px}
.rv-specs{display:flex;gap:6px;flex-wrap:wrap}
.rv-spec{font-size:11.5px;border:1px solid var(--border);border-radius:999px;padding:2px 10px;color:var(--text)}
.rv-spec-price{color:var(--red,#c0392b);border-color:color-mix(in oklch,var(--red,#c0392b) 32%,transparent)}
.rv-descr{font-size:13px;line-height:1.65;color:var(--text);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rv-url{font-size:12.5px;display:flex;gap:6px;align-items:center;min-width:0;color:var(--muted)}
.rv-url a{color:var(--acc);text-decoration:none;word-break:break-all}
.rv-foot{display:flex;justify-content:space-between;align-items:center;gap:10px;padding-top:12px;border-top:1px dashed var(--border);flex-wrap:wrap}
.rv-meta{font-size:12px;color:var(--muted)}
@keyframes admFade{from{opacity:0}to{opacity:1}}
@keyframes admPop{from{opacity:0;transform:scale(.94) translateY(8px)}to{opacity:1;transform:none}}
/* 手机窄屏：tab 图标化省空间、卡片单列、设置项纵向 */
@media (max-width:640px){
  .adm-wrap{padding:16px 12px 80px}
  .adm-brand-text{display:none}
  .adm-logo svg{width:22px;height:22px}
  .adm-topbar{gap:10px}
  .adm-tab{padding:10px 10px;font-size:13px}
  .adm-tab svg{display:none}
  .adm-grid{grid-template-columns:repeat(2,1fr);gap:10px}
  .adm-card{padding:14px}
  .adm-card-val{font-size:22px}
  .adm-setting{flex-direction:column;align-items:stretch}
  .adm-setting-ctrl{justify-content:flex-end}
  .adm-modal-btns{flex-direction:column-reverse}
  .adm-modal-btns .btn{width:100%}
}
`;

Shell.registerPage({
  id: "admin",
  route: "/admin",
  async onEnter(root) {
    // 权限校验：仅 owner / admin
    if (!Auth.isAdmin()) {
      root.innerHTML = `<div style="padding:80px 20px;text-align:center"><h2 style="color:var(--red)">无权访问</h2><p style="color:var(--muted);margin:8px 0 24px">仅管理员可进入管理后台</p><button class="btn primary" onclick="Shell.navigate('/')">返回首页</button></div>`;
      return;
    }
    showPageLoading("管理后台加载数据…");
    if (!document.querySelector('style[data-admin-css]')) {
      const s = document.createElement("style");
      s.setAttribute("data-admin-css", "");
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    /* 记录来源功能区：返回按钮回到进后台前的页面。
       从配置工具返回时（config→admin）不算新来源，保持更早的来源 */
    const prevRoute = Shell.prevPage && Shell.prevPage.route;
    if (!state.fromRoute || (prevRoute && prevRoute !== "/config")) {
      state.fromRoute = prevRoute || "/";
    }
    root.innerHTML = skeleton();
    mountIcons($("adminRoot"));
    mountAuth($("adminAuthSlot"));
    mountAppsMenu($("admAppsMenuSlot"), "admin");
    bindEvents();

    // 主题按钮
    const tb = $("adminThemeBtn");
    const paint = () => { tb.innerHTML = icon(theme.get() === "dark" ? "sun" : "moon"); };
    paint();
    tb.addEventListener("click", () => { theme.toggle(); paint(); });

    /* 拉全部后台数据：期间由全局加载遮罩占位（骨架壳只搭了顶栏+tab 行，主体在数据就绪后渲染） */
    try { await loadAll(); } finally { hidePageLoading(); }
  },
  onExit(root) {
    unbindEvents();
    // 清理可能残留的确认弹窗
    document.querySelectorAll(".adm-modal-mask").forEach((m) => m.remove());
    root.innerHTML = "";
  },
});

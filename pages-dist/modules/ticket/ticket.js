/* ═══════════════════════════════════════════════════════════════
   工单中心 · 用户 → 管理组正式沟通通道
   ───────────────────────────────────────────────────────────────
   ▸ 全站基础功能，不受号卡模块开关控制
   ▸ 可见范围二选一：管理组全员 | 指定管理组成员（含站长）；站长始终兜底可见
   ▸ 配额：同一用户 open（球在管理组）工单 ≤3，管理组回复后释放
   ▸ 管理组（admin/owner）额外有「收件箱」视图；消息自己发的靠右
   ═══════════════════════════════════════════════════════════════ */
"use strict";

import { Shell, esc, theme, ensureStylesheet } from "../../shell/shell.js";
import { icon, mountIcons, toast, withPending, showPageLoading, hidePageLoading } from "../../shell/ui.js";
import { mountAppsMenu } from "../../shell/apps-menu.js";
import { Auth, mountAuth } from "../../shell/auth.js";
import { api } from "../../shell/api.js";

const CATEGORIES = ["举报", "申诉", "建议", "咨询", "毛遂自荐", "其他"];
const OPEN_QUOTA = 3;
const SUBMIT_COOLDOWN = 30; // 提交间隔（秒），后端另有 5 次/时限流兜底
const SOURCE_LABEL = { tariff: "资费监测", cardhub: "跳蚤市集", ticket: "工单中心", config: "配置工具", admin: "管理后台", other: "其他" };

/* ─────────────── 状态 ─────────────── */
const S = {
  view: "list",          // list | new | detail
  items: [],
  detailId: null,
  detail: null,          // { ticket, messages }（后端带 is_mine/can_close/消息 mine 标志）
  form: { category: "其他", scope: "all", target: "", title: "", content: "", source: "ticket", refNo: "" },
  admins: [],
  lastSubmitAt: 0,
};

const $ = (id) => document.getElementById(id);

const STATUS_LABEL = { open: "待处理", replied: "已回复", closed: "已关闭" };
const STATUS_CLS = { open: "warn", replied: "ok", closed: "" };
const CLOSE_LABEL = { user: "发布者关闭", resolved: "已解决", invalid: "不予受理" };

function relTime(sec) {
  const ts = sec > 1e12 ? sec : sec * 1000;
  const d = Date.now() - ts;
  if (d < 60000) return "刚刚";
  if (d < 3600000) return Math.floor(d / 60000) + " 分钟前";
  if (d < 86400000) return Math.floor(d / 3600000) + " 小时前";
  return Math.floor(d / 86400000) + " 天前";
}

function statusTag(st) {
  return `<span class="tk-tag ${STATUS_CLS[st] || ""}">${esc(STATUS_LABEL[st] || st)}</span>`;
}

/* ═══════════════ 页面骨架 ═══════════════ */
function skeletonHTML() {
  return `
<div id="ticketRoot">
<header class="tk-topbar">
  <div class="tk-topbar-left">
    <button class="icon-btn" data-act="goTariff" title="返回资费监控"><i data-icon="back"></i></button>
    <div class="tk-brand"><div class="tk-brand-logo"><i data-icon="mail"></i></div><div class="tk-brand-text">工单中心</div></div>
  </div>
  <div class="tk-topbar-actions">
    <div id="tkAppsMenuSlot"></div>
    <div id="tkAuthSlot"></div>
    <button class="icon-btn magnetic" id="tkThemeBtn" title="切换主题"></button>
  </div>
</header>
<main class="tk-content" id="tkContent"><div class="loading" style="padding:60px 0">加载中…</div></main>
<footer class="foot">ChinaMNOs 工单中心 · 与管理组的正式沟通通道</footer>
</div>`;
}

/* ═══════════════ 列表（我的工单，纯用户视角——管理组在管理后台处理工单） ═══════════════ */
function ticketItemHTML(t, i) {
  const waiting = t.last_reply_by === "admin";
  return `
  <article class="tk-item card rise ${t.status !== "closed" && waiting ? "attn" : ""}" style="--i:${Math.min(i, 8)}" data-act="openTicket" data-id="${esc(t.id)}">
    <div class="tk-item-head">
      <span class="tk-no">#${t.ticket_no}</span>
      <span class="tk-cat">${esc(t.category)}</span>
      ${t.source && t.source !== "ticket" ? `<span class="tk-cat src" title="来源">${esc(SOURCE_LABEL[t.source] || t.source)}</span>` : ""}
      ${t.ref_no ? `<span class="tk-ref" title="关联帖子编号">关联帖子 #${t.ref_no}</span>` : ""}
      ${statusTag(t.status)}
      ${t.status !== "closed" && waiting ? `<span class="tk-dot" title="等待管理组处理"></span>` : ""}
    </div>
    <h3 class="tk-item-title">${esc(t.title)}</h3>
    <div class="tk-item-foot">
      <span class="tk-meta">${icon("clock")} 最后动态 ${relTime(t.last_reply_at)}</span>
      <span class="tk-meta dim">${t.status === "closed"
        ? esc(CLOSE_LABEL[t.close_reason] || "已关闭")
        : waiting ? "等待管理组处理" : "等待对方回应"}</span>
    </div>
  </article>`;
}

function listHTML() {
  if (!S.items.length) {
    return `<div class="tk-empty">
      <div class="tk-empty-ic">${icon("mail")}</div>
      <div class="tk-empty-t">还没有发起过工单</div>
      <div class="tk-empty-s">有问题或建议？点右上角「发起工单」</div>
    </div>`;
  }
  return `<div class="tk-list">${S.items.map(ticketItemHTML).join("")}</div>`;
}

/* 顶部统计卡（我的工单视角） */
function statCardsHTML() {
  const total = S.items.length;
  const open = S.items.filter((t) => t.status === "open").length;
  const replied = S.items.filter((t) => t.status === "replied").length;
  const closed = S.items.filter((t) => t.status === "closed").length;
  return `
  <div class="tk-stats">
    <div class="tk-stat"><b>${total}</b><span>全部工单</span></div>
    <div class="tk-stat s-open"><b>${open}</b><span>待处理</span></div>
    <div class="tk-stat s-replied"><b>${replied}</b><span>已回复</span></div>
    <div class="tk-stat s-closed"><b>${closed}</b><span>已关闭</span></div>
  </div>`;
}

function renderListView() {
  const openCount = S.items.filter((t) => t.status === "open").length;
  const unclosed = S.items.filter((t) => t.status !== "closed").length;
  return `
<section class="view active">
  ${statCardsHTML()}
  <div class="panel tk-panel rise">
    <div class="tk-toolbar">
      <div class="tk-list-head" style="margin:0"><span>我的工单</span>
      <span class="tk-meta">共 ${S.items.length} 张 · 未关闭 ${unclosed} 张</span></div>
      <button class="btn primary" data-act="newTicket"><i data-icon="plusCircle"></i>发起工单</button>
    </div>
    <div class="tk-quota">待管理组处理 <strong>${openCount}</strong> / ${OPEN_QUOTA}（满额后需等已有工单被回复或关闭）</div>
    ${listHTML()}
  </div>
  <div class="panel tk-panel tk-help rise">
    <h3 class="tk-help-t">${icon("info")} 工单使用说明</h3>
    <ol>
      <li>工单内尽量描述清楚问题现象、复现步骤以及相关的<strong>帖子编号</strong>（详情页标题旁的 #数字），方便我们快速定位。</li>
      <li>可选择「管理组全员可见」或「仅指定管理组成员可见」；指定后该工单只有对方与站长能查看。</li>
      <li>管理组回复后，工单会在列表中<strong>高亮提醒</strong>；处理完成后你可以自行关闭工单。</li>
      <li>两次提交之间请间隔 ${SUBMIT_COOLDOWN} 秒；待处理工单最多 ${OPEN_QUOTA} 条。</li>
    </ol>
  </div>
</section>`;
}

/* ═══════════════ 发起工单 ═══════════════ */
function renderNewView() {
  const f = S.form;
  const admins = S.admins || [];
  const openCount = S.items.filter((t) => t.status === "open").length;
  const cooldown = Math.max(0, SUBMIT_COOLDOWN - Math.floor((Date.now() - S.lastSubmitAt) / 1000));
  return `
<section class="view active">
  <button class="btn ghost tk-back" data-act="backList"><i data-icon="back"></i>返回列表</button>
  <div class="panel tk-panel rise">
    <h1 class="panel-title"><i data-icon="list"></i>发起工单</h1>
    ${f.applyBanner ? `<div class="tk-apply-banner">${icon("info")} ${esc(f.applyBanner)}</div>` : ""}
    <div class="tk-quota">待管理组处理 <strong>${openCount}</strong> / ${OPEN_QUOTA} · 每小时最多发起 5 条${cooldown > 0 ? ` · 距上次提交 ${cooldown}s` : ""}</div>
    <form id="tkForm" onsubmit="return false">
      <div class="tk-f-row">
        <div class="tk-fg"><label>分类</label>
          <select class="sel" id="tkFCat">${CATEGORIES.map((c) => `<option ${f.category === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></div>
        <div class="tk-fg"><label>相关系统 <span class="hint">问题来自哪个功能</span></label>
          <select class="sel" id="tkFSource">${Object.entries(SOURCE_LABEL).map(([id, name]) => `<option value="${id}" ${f.source === id ? "selected" : ""}>${esc(name)}</option>`).join("")}</select></div>
      </div>
      <div class="tk-f-row">
        <div class="tk-fg"><label>可见范围</label>
          <select class="sel" id="tkFScope">
            <option value="all" ${f.scope === "all" ? "selected" : ""}>管理组全员可见</option>
            <option value="admin" ${f.scope === "admin" ? "selected" : ""}>仅指定管理组成员可见</option>
          </select></div>
        <div class="tk-fg"><label>关联帖子编号 <span class="hint">选填 · 帖子详情页的 #数字</span></label>
          <input type="text" class="inp" id="tkFRefNo" inputmode="numeric" maxlength="7" placeholder="如 1001" value="${esc(f.refNo)}"></div>
      </div>
      <div class="tk-fg" id="tkTargetRow" style="display:${f.scope === "admin" ? "" : "none"}">
        <label>指定管理组成员 <b class="ch-req">*</b> <span class="hint">仅该成员与站长能查看和回复</span></label>
        <select class="sel" id="tkFTarget"><option value="">请选择</option>${admins.map((a) => `<option value="${esc(a.id)}" ${f.target === a.id ? "selected" : ""}>${esc(a.nickname)}</option>`).join("")}</select></div>
      <div class="tk-fg"><label>标题 <b class="ch-req">*</b> <span class="hint">一句话概括问题</span></label>
        <input type="text" class="inp" id="tkFTitle" maxlength="60" placeholder="如：举报某帖虚假信息" value="${esc(f.title)}"></div>
      <div class="tk-fg"><label>详细说明 <b class="ch-req">*</b> <span class="hint"><span id="tkContentCount">${f.content.length}</span>/500 字</span></label>
        <textarea id="tkFContent" maxlength="500" placeholder="请描述具体情况：涉及帖子编号、对方昵称、发生时间、期望的处理结果等">${esc(f.content)}</textarea></div>
      <div class="tk-actions">
        <button class="btn ghost" data-act="backList"><i data-icon="x"></i>取消</button>
        <button class="btn primary" data-act="submitTicket"><i data-icon="check"></i>提交工单</button>
      </div>
    </form>
  </div>
</section>`;
}

/* ═══════════════ 工单对话 ═══════════════ */
function bubbleHTML(m) {
  return `
  <div class="tk-msg ${m.mine ? "mine" : "theirs"}">
    <div class="tk-msg-head">
      <span class="tk-msg-name">${esc(m.nickname)}</span>
      <span class="tk-msg-title">${esc(m.title || "")}</span>
      <span class="tk-msg-time">${relTime(m.createdAt)}</span>
    </div>
    <div class="tk-msg-body ${m.sender === "admin" ? "staff" : ""}">${esc(m.body).replace(/\n/g, "<br>")}</div>
  </div>`;
}

function renderDetailView() {
  const d = S.detail;
  if (!d) return `<section class="view active"><div class="loading" style="padding:60px 0">加载中…</div></section>`;
  const t = d.ticket;
  const closed = t.status === "closed";
  return `
<section class="view active">
  <button class="btn ghost tk-back" data-act="backList"><i data-icon="back"></i>返回列表</button>
  <div class="panel tk-panel rise">
    <div class="tk-detail-head">
      <span class="tk-no">#${t.ticket_no}</span>
      <span class="tk-cat">${esc(t.category)}</span>
      ${t.source && t.source !== "ticket" ? `<span class="tk-cat src" title="来源">${esc(SOURCE_LABEL[t.source] || t.source)}</span>` : ""}
      ${t.ref_no ? `<span class="tk-ref" title="关联帖子编号">关联帖子 #${t.ref_no}</span>` : ""}
      ${statusTag(t.status)}
      <span class="tk-meta">${t.scope === "all" ? "管理组全员可见" : "仅指定成员与站长可见"}</span>
    </div>
    <h1 class="tk-detail-title">${esc(t.title)}</h1>
    ${closed ? `<div class="tk-closed">${icon("check")} 工单已关闭 · ${esc(CLOSE_LABEL[t.close_reason] || "已关闭")}</div>` : ""}
    <div class="tk-msgs">${d.messages.map(bubbleHTML).join("")}</div>
    ${closed ? "" : `
    <div class="tk-reply">
      <textarea id="tkReply" maxlength="500" placeholder="补充说明或回复（≤500 字）"></textarea>
      <div class="tk-reply-actions">
        ${t.can_close ? `<button class="btn ghost" data-act="closeTicket"><i data-icon="x"></i>关闭工单</button>` : ""}
        <button class="btn primary" data-act="replyTicket"><i data-icon="check"></i>发送回复</button>
      </div>
    </div>`}
  </div>
</section>`;
}

/* ═══════════════ 渲染入口 ═══════════════ */
function render() {
  const content = $("tkContent");
  if (!content) return;
  content.innerHTML = S.view === "new" ? renderNewView() : S.view === "detail" ? renderDetailView() : renderListView();
  mountIcons(content);
}

async function loadList() {
  // 纯用户视角：只拉自己发起的工单（管理组处理在管理后台「工单」Tab，box=inbox）
  const r = await api.request("/api/tickets?box=mine");
  if (r.ok) S.items = r.data.items || [];
  else { S.items = []; toast(r.error || "工单加载失败"); }
  render();
}

async function openTicket(id) {
  S.view = "detail"; S.detailId = id; S.detail = null; render();
  const r = await api.request(`/api/tickets/${encodeURIComponent(id)}`);
  if (!r.ok) { toast(r.error || "工单加载失败"); backList(); return; }
  S.detail = { ticket: r.data.ticket, messages: r.data.messages || [] };
  render();
}

function backList() {
  S.view = "list"; S.detail = null;
  render();
}

/* ═══════════════ 提交 ═══════════════ */
/* 毛遂自荐预填：sessionStorage 交接标记仅由各功能页「毛遂自荐」按钮写入（确认弹窗=用户许可），
   本处读取后立即清除 → 自动选分类、带入站长配置的申请模板（未配置时用内置通用框架），其余内容用户可改 */
async function tkApplyPrefill() {
  let raw = null;
  try { raw = sessionStorage.getItem("chinamnos_ticket_apply"); } catch { return; }
  if (!raw) return;
  try { sessionStorage.removeItem("chinamnos_ticket_apply"); } catch { /* */ }
  let type = "";
  try { type = (JSON.parse(raw) || {}).type || ""; } catch { return; }
  if (!type) return;
  const r = await api.request(`/api/tickets/apply-template?type=${encodeURIComponent(type)}`);
  if (!r.ok) { toast(r.error || "申请模板加载失败，请手动选择分类提交"); return; }
  const { category, label, template } = r.data;
  S.view = "new";
  S.form = {
    category: category || "毛遂自荐", scope: "all", target: "",
    title: `毛遂自荐：申请成为${label || "站点职位"}`,
    content: template || `站长您好：\n\n我希望申请成为「${label || "站点职位"}」，自我介绍如下：\n\n1. 我的渠道/资源：\n2. 相关经历与担保能力：\n3. 联系方式：\n\n期待您的审核，谢谢！`,
    source: "ticket", refNo: "",
    applyBanner: `已带入「${label || ""}」申请模板（来自功能页「毛遂自荐」入口），请核对并补充后提交`,
  };
}

/* 通用预填（活动集锦「反馈」等入口）：sessionStorage 交接标记 chinamnos_ticket_prefill，
   各功能页写入（用户确认后），本处读取即清除 → 预填分类/来源/标题/内容，用户可改 */
function tkGenericPrefill() {
  let raw = null;
  try { raw = sessionStorage.getItem("chinamnos_ticket_prefill"); } catch { return; }
  if (!raw) return;
  try { sessionStorage.removeItem("chinamnos_ticket_prefill"); } catch { /* */ }
  let p = null;
  try { p = JSON.parse(raw) || null; } catch { return; }
  if (!p || typeof p !== "object") return;
  S.view = "new";
  S.form = {
    category: CATEGORIES.includes(p.category) ? p.category : "其他",
    scope: "all", target: "",
    title: String(p.title || "").slice(0, 60),
    content: String(p.content || "").slice(0, 500),
    source: SOURCE_LABEL[p.source] ? p.source : "other",
    refNo: "",
    applyBanner: p.banner || "已带入预设信息，请核对补充后提交",
  };
}

async function submitTicket() {
  const f = S.form;
  f.category = $("tkFCat") ? $("tkFCat").value : f.category;
  f.source = $("tkFSource") ? $("tkFSource").value : f.source;
  f.scope = $("tkFScope") ? $("tkFScope").value : f.scope;
  f.target = $("tkFTarget") ? $("tkFTarget").value : "";
  f.title = $("tkFTitle") ? $("tkFTitle").value.trim() : "";
  f.content = $("tkFContent") ? $("tkFContent").value.trim() : "";
  f.refNo = $("tkFRefNo") ? $("tkFRefNo").value.trim() : "";
  if (f.scope === "admin" && !f.target) { toast("请选择可见的管理组成员"); return; }
  if (f.title.length < 2) { toast("请填写标题（至少 2 字）"); return; }
  if (!f.content) { toast("请填写详细说明"); return; }
  const wait = Math.max(0, SUBMIT_COOLDOWN - Math.floor((Date.now() - S.lastSubmitAt) / 1000));
  if (wait > 0) { toast(`提交太频繁，请再等 ${wait} 秒`); return; }
  const r = await api.request("/api/tickets", { method: "POST", body: {
    category: f.category, scope: f.scope, target_id: f.scope === "admin" ? f.target : "",
    title: f.title, content: f.content, source: f.source,
    ref_no: /^\d+$/.test(f.refNo) ? Number(f.refNo) : null,
  } });
  if (!r.ok) {
    toast(r.code === 40901 ? `待处理工单已达 ${OPEN_QUOTA} 条上限，请等已有工单被回复或关闭` : (r.error || "提交失败"));
    return;
  }
  S.lastSubmitAt = Date.now();
  S.form = { category: "其他", scope: "all", target: "", title: "", content: "", source: "ticket", refNo: "" };
  toast("工单已提交，管理组会尽快处理");
  await openTicket(r.data.id); // 提交成功直接进入工单对话
}

async function replyTicket() {
  const el = $("tkReply");
  const content = el ? el.value.trim() : "";
  if (!content) { toast("请输入回复内容"); return; }
  const r = await api.request(`/api/tickets/${encodeURIComponent(S.detailId)}/messages`, { method: "POST", body: { content } });
  if (!r.ok) { toast(r.error || "回复失败"); return; }
  await openTicket(S.detailId);
}

async function closeTicket() {
  const isMineView = S.detail && S.detail.ticket.is_mine;
  if (!confirm(isMineView ? "确定关闭该工单？关闭后不可再回复。" : "确定关闭该工单？将标记为已解决。")) return;
  const body = isMineView ? {} : { reason: "resolved" };
  const r = await api.request(`/api/tickets/${encodeURIComponent(S.detailId)}/close`, { method: "POST", body });
  if (!r.ok) { toast(r.error || "关闭失败"); return; }
  toast("工单已关闭");
  await openTicket(S.detailId);
}

/* ═══════════════ 事件（body 级委托，onEnter 绑定 / onExit 解绑） ═══════════════ */
function onRootClick(e) {
  const actEl = e.target.closest("[data-act]");
  if (!actEl) return;
  const a = actEl.dataset.act;
  if (a === "goTariff") { Shell.navigate("/"); return; } /* 返回资费监控（顶栏返回按钮） */
  if (a === "openLogin") { Auth.openLogin(); return; }
  if (a === "newTicket") { S.view = "new"; render(); return; }
  if (a === "backList") { backList(); return; }
  if (a === "openTicket") { openTicket(actEl.dataset.id); return; }
  if (a === "submitTicket") { withPending(actEl, () => submitTicket()); return; }
  if (a === "replyTicket") { withPending(actEl, () => replyTicket()); return; }
  if (a === "closeTicket") { closeTicket(); return; }
}

function onRootInput(e) {
  if (e.target.id === "tkFContent") {
    const c = $("tkContentCount");
    if (c) c.textContent = String(e.target.value.length);
    S.form.content = e.target.value;
    return;
  }
  if (e.target.id === "tkFTitle") { S.form.title = e.target.value; return; }
  if (e.target.id === "tkReply") { S.detail && (S.detail._reply = e.target.value); return; }
}

function onRootChange(e) {
  if (e.target.id === "tkFScope") {
    S.form.scope = e.target.value;
    const row = $("tkTargetRow");
    if (row) row.style.display = e.target.value === "admin" ? "" : "none";
    return;
  }
  if (e.target.id === "tkFCat") { S.form.category = e.target.value; return; }
  if (e.target.id === "tkFSource") { S.form.source = e.target.value; return; }
  if (e.target.id === "tkFTarget") { S.form.target = e.target.value; return; }
  if (e.target.id === "tkFRefNo") { S.form.refNo = e.target.value.replace(/\D/g, ""); return; }
}

/* ═══════════════ 页面注册 ═══════════════ */
Shell.registerPage({
  id: "ticket",
  route: "/ticket",
  async onEnter(root) {
    showPageLoading("工单中心加载中…");
    await ensureStylesheet(Shell.config.base + "modules/ticket/style.css");
    if (!Auth.isLoggedIn()) {
      hidePageLoading();
      root.innerHTML = `
<div id="ticketRoot">
<header class="tk-topbar">
  <div class="tk-topbar-left">
    <button class="icon-btn" data-act="goTariff" title="返回资费监控"><i data-icon="back"></i></button>
    <div class="tk-brand"><div class="tk-brand-logo"><i data-icon="mail"></i></div><div class="tk-brand-text">工单中心</div></div>
  </div>
  <div class="tk-topbar-actions"><div id="tkAuthSlot"></div></div>
</header>
<main class="tk-content" id="tkContent">
  <div class="tk-empty" style="padding:60px 20px">
    <div class="tk-empty-ic">${icon("user")}</div>
    <div class="tk-empty-t">请先登录</div>
    <div class="tk-empty-s">工单中心需要登录后使用</div>
    <button class="btn primary" data-act="openLogin" style="margin-top:16px">登录 / 注册</button>
  </div>
</main>
</div>`;
      mountIcons(root);
      const slot = document.createElement("div");
      mountAuth(slot);
      bindEvents();
      return;
    }
    root.innerHTML = skeletonHTML();
    mountIcons(root);
    mountAuth($("tkAuthSlot"));
    mountAppsMenu($("tkAppsMenuSlot"), "ticket");
    bindEvents();
    const tb = $("tkThemeBtn");
    if (tb) {
      const paint = () => { tb.innerHTML = icon(theme.get() === "dark" ? "sun" : "moon"); };
      paint();
      tb.addEventListener("click", () => { theme.toggle(); paint(); });
    }
    // 管理组成员列表（「指定成员可见」范围用；公开字段仅 id/昵称）
    const sch = await api.request("/api/cardhub/schema");
    if (sch.ok) S.admins = sch.data.admins || [];
    await tkApplyPrefill(); // 各功能页「毛遂自荐」按钮的预填交接（读取即清除）
    tkGenericPrefill();     // 各功能页「反馈/举报」等入口的通用预填交接（读取即清除）
    try {
      await loadList();
    } finally {
      hidePageLoading();
    }
  },
  onExit(root) {
    unbindEvents();
    root.innerHTML = "";
  },
});

let bound = false;
function bindEvents() {
  if (bound) return;
  bound = true;
  document.body.addEventListener("click", onRootClick);
  document.body.addEventListener("input", onRootInput);
  document.body.addEventListener("change", onRootChange);
}
function unbindEvents() {
  if (!bound) return;
  bound = false;
  document.body.removeEventListener("click", onRootClick);
  document.body.removeEventListener("input", onRootInput);
  document.body.removeEventListener("change", onRootChange);
}

Auth.on("login", () => { if (location.hash.replace(/^#/, "") === "/ticket") location.reload(); });

/* ═══════════════════════════════════════════════════════════════
   站内通知中心 — 顶栏铃铛 + 通知面板
   ───────────────────────────────────────────────────────────────
   ▸ 铃铛由 auth.js 在顶栏 auth 区注入（bellHTML），登录用户专属
   ▸ 未读红点：/api/notifications 的 unread；30s 节流，登录/操作后强制刷
   ▸ 面板：最近 50 条 → 点击条目展开全文 + 「前往查看」（kind→路由映射）
   ▸ 发送者展示「用户管理组」系统身份（单向通知，不可回复，不入交易会话）
   ▸ 跳蚤市集深链经 sessionStorage(ntf_cardhub_view) 交给 cardhub.js 处理
   ═══════════════════════════════════════════════════════════════ */
"use strict";

import { esc } from "./shell.js";
import { icon, mountIcons, toast } from "./ui.js";
import { api } from "./api.js";

/* kind → 图标 / 色系 / 来源标识 / 跳转目标（go 交给 Shell.navigate） */
const KIND_META = {
  act_approved:  { icon: "check",   cls: "ok",   src: "用户管理组", go: "#acts" },
  act_rejected:  { icon: "x",       cls: "no",   src: "用户管理组", go: "#acts" },
  chat_approved: { icon: "check",   cls: "ok",   src: "用户管理组", go: "#chat" },
  chat_rejected: { icon: "x",       cls: "no",   src: "用户管理组", go: "#chat" },
  act_retired:   { icon: "box",     cls: "warn", src: "用户管理组", go: "#acts" },
  act_expired:   { icon: "clock",   cls: "warn", src: "用户管理组", go: "#acts" },
  link_approved: { icon: "check",   cls: "ok",   src: "用户管理组", go: "/tools" },
  link_rejected: { icon: "x",       cls: "no",   src: "用户管理组", go: "/tools" },
  post_approved: { icon: "check",   cls: "ok",   src: "用户管理组", go: "/cardhub", chview: "me" },
  post_rejected: { icon: "x",       cls: "no",   src: "用户管理组", go: "/cardhub", chview: "me" },
  post_closed:   { icon: "box",     cls: "warn", src: "用户管理组", go: "/cardhub", chview: "me" },
  post_expired:  { icon: "clock",   cls: "warn", src: "用户管理组", go: "/cardhub", chview: "me" },
  dm_message:    { icon: "message", cls: "info", src: "会话消息",   go: "/cardhub", chview: "convs" },
};

/* ─────────────── 样式（一次性注入） ─────────────── */
const NTF_CSS = `
.auth-area{display:inline-flex;align-items:center;gap:8px}
.ntf-bell{position:relative;display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:50%;background:var(--surface-2);border:1px solid var(--line);color:var(--sub);cursor:pointer;transition:border-color .15s,color .15s,box-shadow .15s}
.ntf-bell:hover{border-color:var(--acc);color:var(--acc);box-shadow:0 0 0 3px color-mix(in oklab,var(--acc) 12%,transparent)}
.ntf-bell svg{width:17px;height:17px}
.ntf-dot{position:absolute;top:3px;right:4px;width:8px;height:8px;border-radius:50%;background:var(--red);box-shadow:0 0 0 2px var(--surface);display:none}
.ntf-dot.on{display:block}
.ntf-mask{position:fixed;inset:0;background:rgba(0,0,0,.45);backdrop-filter:blur(3px);z-index:9500;display:none;align-items:flex-start;justify-content:center;padding:9vh 16px 16px}
.ntf-mask.open{display:flex;animation:ntf-fade .18s ease}
@keyframes ntf-fade{from{opacity:0}}
.ntf-panel{width:100%;max-width:480px;max-height:76vh;display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.28);overflow:hidden;animation:ntf-pop .2s ease}
@keyframes ntf-pop{from{opacity:0;transform:translateY(-8px) scale(.98)}}
.ntf-head{display:flex;align-items:center;justify-content:space-between;padding:13px 16px;border-bottom:1px solid var(--line);flex:none}
.ntf-h1{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:800;color:var(--txt)}
.ntf-h1 svg{width:16px;height:16px;color:var(--acc)}
.ntf-actions{display:flex;align-items:center;gap:8px}
.ntf-markall{border:1px solid var(--line);background:var(--surface-2);color:var(--sub);font-size:12px;padding:5px 10px;border-radius:8px;cursor:pointer;transition:border-color .15s,color .15s}
.ntf-markall:hover{border-color:var(--acc);color:var(--acc)}
.ntf-clearread{border:1px solid var(--line);background:var(--surface-2);color:var(--sub);font-size:12px;padding:5px 10px;border-radius:8px;cursor:pointer;transition:border-color .15s,color .15s}
.ntf-clearread:hover{border-color:var(--red);color:var(--red)}
.ntf-acts{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ntf-del{border:none;background:none;color:var(--red);font-size:12px;padding:4px 2px;cursor:pointer;opacity:.75;transition:opacity .15s}
.ntf-del:hover{opacity:1;text-decoration:underline}
.ntf-close{background:none;border:none;color:var(--sub);font-size:22px;line-height:1;cursor:pointer;transition:color .15s}
.ntf-close:hover{color:var(--txt)}
.ntf-list{overflow-y:auto;padding:8px 10px 12px}
.ntf-empty{padding:40px 16px;text-align:center;color:var(--sub);font-size:13px;line-height:1.9}
.ntf-empty span{font-size:12px;opacity:.75}
.ntf-item{display:flex;gap:10px;padding:10px;border-radius:12px;cursor:pointer;transition:background .15s;align-items:flex-start}
.ntf-item:hover{background:var(--surface-2)}
.ntf-item + .ntf-item{margin-top:2px}
.ntf-item.unread{background:color-mix(in oklab,var(--acc) 5%,transparent)}
.ntf-ico{flex:none;width:30px;height:30px;border-radius:9px;display:flex;align-items:center;justify-content:center;background:var(--surface-2)}
.ntf-ico svg{width:15px;height:15px}
.ntf-ico.ok{background:color-mix(in oklab,var(--green) 13%,transparent);color:var(--green)}
.ntf-ico.no{background:color-mix(in oklab,var(--red) 13%,transparent);color:var(--red)}
.ntf-ico.warn{background:color-mix(in oklab,var(--amber) 15%,transparent);color:var(--amber)}
.ntf-ico.info{background:color-mix(in oklab,var(--acc) 12%,transparent);color:var(--acc)}
.ntf-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.ntf-row1{display:flex;align-items:center;gap:6px;min-width:0}
.ntf-title{font-size:13px;font-weight:600;color:var(--txt);line-height:1.45;overflow-wrap:anywhere}
.ntf-item.unread .ntf-title{font-weight:800}
.ntf-unread-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--red)}
.ntf-src{font-size:11px;color:var(--sub);opacity:.85}
.ntf-body{font-size:12.5px;color:var(--sub);line-height:1.55;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}
.ntf-item.open .ntf-body{display:block;-webkit-line-clamp:unset}
.ntf-go{align-self:flex-start;margin-top:4px;display:inline-flex;align-items:center;gap:5px;border:1px solid color-mix(in oklab,var(--acc) 35%,transparent);background:color-mix(in oklab,var(--acc) 10%,transparent);color:var(--acc);font-size:12px;font-weight:700;padding:6px 12px;border-radius:9px;cursor:pointer;transition:background .15s}
.ntf-go:hover{background:color-mix(in oklab,var(--acc) 18%,transparent)}
.ntf-go svg{width:12px;height:12px}
`;
let cssInjected = false;
function injectCSS() {
  if (cssInjected) return;
  cssInjected = true;
  const s = document.createElement("style");
  s.textContent = NTF_CSS;
  document.head.appendChild(s);
}

/* ─────────────── 铃铛（auth.js 注入顶栏） ─────────────── */
export function bellHTML() {
  injectCSS();
  return `<button type="button" class="ntf-bell" id="ntfBell" title="通知中心" aria-label="通知中心">${icon("bell")}<span class="ntf-dot" id="ntfDot"></span></button>`;
}

function setDot(on) {
  const d = document.getElementById("ntfDot");
  if (d) d.classList.toggle("on", !!on);
}

let lastUnreadFetch = 0;
let lastUnread = 0;
let items = [];

/** 拉取未读数（30s 节流；force 绕过）并同步铃铛红点与面板数据缓存 */
export async function refreshBell(force) {
  if (!api.isLoggedIn()) { lastUnread = 0; setDot(false); return; }
  const now = Date.now();
  if (!force && now - lastUnreadFetch < 30000) return;
  lastUnreadFetch = now;
  try {
    const r = await api.request("/api/notifications");
    if (r.ok && r.data) {
      lastUnread = r.data.unread || 0;
      items = r.data.items || [];
      setDot(lastUnread > 0);
    }
    /* 401 等错误静默：登录态边界问题由下次登录/刷新兜底 */
  } catch { /* 网络异常静默，不打扰用户 */ }
}

/* ─────────────── 通知面板 ─────────────── */
let panelEl = null;
let openId = null;

function fmtTime(ts) {
  const d = new Date(ts || 0);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function ensurePanel() {
  /* body 被路由重写后缓存节点会游离，命中缓存前必须检测 contains（同 auth.js getModal） */
  if (panelEl && document.body.contains(panelEl)) return panelEl;
  panelEl = document.createElement("div");
  panelEl.className = "ntf-mask";
  panelEl.innerHTML = `<div class="ntf-panel" role="dialog" aria-label="通知中心">
    <div class="ntf-head">
      <span class="ntf-h1">${icon("bell")} 通知中心</span>
      <span class="ntf-actions">
        <button type="button" class="ntf-markall">全部已读</button>
        <button type="button" class="ntf-clearread">清空已读</button>
        <button type="button" class="ntf-close" aria-label="关闭">&times;</button>
      </span>
    </div>
    <div class="ntf-list" id="ntfList"></div>
  </div>`;
  panelEl.addEventListener("click", onPanelClick);
  document.body.appendChild(panelEl);
  return panelEl;
}

function renderList() {
  if (!panelEl) return;
  const el = panelEl.querySelector("#ntfList");
  if (!el) return;
  if (!items.length) {
    el.innerHTML = `<div class="ntf-empty">暂无通知<br><span>投稿审核结果、帖子状态变化、在线沟通新消息都会出现在这里</span></div>`;
    return;
  }
  el.innerHTML = items.map((n) => {
    const meta = KIND_META[n.kind] || { icon: "bell", cls: "info", src: "系统通知", go: null, chview: "" };
    const unread = !n.read_at;
    const open = openId === n.id;
    return `
    <div class="ntf-item${unread ? " unread" : ""}${open ? " open" : ""}" data-id="${esc(n.id)}">
      <span class="ntf-ico ${meta.cls}">${icon(meta.icon)}</span>
      <span class="ntf-main">
        <span class="ntf-row1"><span class="ntf-title">${esc(n.title)}</span>${unread ? '<span class="ntf-unread-dot"></span>' : ""}</span>
        <span class="ntf-src">${esc(meta.src)} · ${fmtTime(n.created_at)}</span>
        ${n.body ? `<span class="ntf-body">${esc(n.body)}</span>` : ""}
        ${open ? `<span class="ntf-acts">
          ${open && meta.go ? `<button type="button" class="ntf-go" data-go="${esc(meta.go)}" data-chview="${esc(meta.chview || "")}">前往查看<i data-icon="arrowRight"></i></button>` : ""}
          <button type="button" class="ntf-del" data-del="${esc(n.id)}">删除</button>
        </span>` : ""}
      </span>
    </div>`;
  }).join("");
  mountIcons(el);
}

async function openPanel() {
  if (!api.isLoggedIn()) return;
  injectCSS();
  ensurePanel();
  panelEl.classList.add("open");
  openId = null;
  const list = panelEl.querySelector("#ntfList");
  if (list) list.innerHTML = `<div class="ntf-empty">加载中…</div>`;
  await refreshBell(true);
  renderList();
}

function closePanel() {
  if (panelEl) panelEl.classList.remove("open");
}

async function onPanelClick(e) {
  if (!panelEl) return;
  const go = e.target.closest(".ntf-go");
  if (go) {
    e.stopPropagation();
    const dest = go.dataset.go || "";
    const chview = go.dataset.chview || "";
    closePanel();
    if (dest === "/cardhub" && chview) {
      goCardhubView(chview);
      return;
    }
    if (window.Shell && window.Shell.navigate) window.Shell.navigate(dest);
    else location.hash = dest;
    return;
  }
  const del = e.target.closest(".ntf-del");
  if (del) {
    e.stopPropagation();
    const id = del.dataset.del;
    const n = items.find((x) => x.id === id);
    const r = await api.request("/api/notifications/delete", { method: "POST", body: { id } });
    if (r.ok) {
      items = items.filter((x) => x.id !== id);
      if (n && !n.read_at) { lastUnread = Math.max(0, lastUnread - 1); setDot(lastUnread > 0); }
      openId = null;
      renderList();
    } else toast(r.error || "删除失败");
    return;
  }
  if (e.target.closest(".ntf-clearread")) {
    const r = await api.request("/api/notifications/clear-read", { method: "POST", body: {} });
    if (r.ok) {
      items = items.filter((n) => !n.read_at);
      openId = null;
      renderList();
    } else toast(r.error || "清空失败");
    return;
  }
  if (e.target.closest(".ntf-markall")) {
    const r = await api.request("/api/notifications/read", { method: "POST", body: { all: true } });
    if (r.ok) {
      const now = Date.now();
      items.forEach((n) => { if (!n.read_at) n.read_at = now; });
      lastUnread = 0;
      setDot(false);
      renderList();
    }
    return;
  }
  if (e.target.closest(".ntf-close") || e.target === panelEl) { closePanel(); return; }
  const item = e.target.closest(".ntf-item");
  if (item) {
    const id = item.dataset.id;
    openId = openId === id ? null : id;
    const n = items.find((x) => x.id === id);
    if (n && !n.read_at) {
      n.read_at = Date.now(); // 乐观更新
      lastUnread = Math.max(0, lastUnread - 1);
      setDot(lastUnread > 0);
      api.request("/api/notifications/read", { method: "POST", body: { id } })
        .then(() => refreshBell(true)).catch(() => {});
    }
    renderList();
  }
}

/* 铃铛点击（全局委托：顶栏由各页面重写，委托到 document 免重挂） */
document.addEventListener("click", (e) => {
  if (e.target.closest("#ntfBell")) openPanel();
});

/* 跳蚤市集视图深链（通知中心与资料卡「在线沟通」共用）：
   页外 → sessionStorage 交接（cardhub onEnter 读取）；已在页内 → navigate 不会重入
   onEnter（hash 未变化），派发自定义事件由 cardhub.js 监听直达对应视图 */
export function goCardhubView(view) {
  try { sessionStorage.setItem("ntf_cardhub_view", view); } catch { /* 隐私模式忽略 */ }
  if (location.hash === "#/cardhub") {
    window.dispatchEvent(new CustomEvent("cmn:cardhub-view", { detail: { view } }));
  } else if (window.Shell && window.Shell.navigate) {
    window.Shell.navigate("/cardhub");
  } else {
    location.hash = "/cardhub";
  }
}

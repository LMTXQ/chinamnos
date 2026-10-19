/* ═══════════════════════════════════════════════════════════════
   全站认证模块 — 登录 / 注册 / 改密 / 用户菜单
   ───────────────────────────────────────────────────────────────
   ▸ 所有页面模块共享同一套登录态与 UI
   ▸ mount(container) 把「登录按钮」或「用户芯片」注入顶栏
   ▸ 登录弹窗 / 改密弹窗独立挂在 body，不随页面切换销毁
   ▸ on("login"|"logout"|"change", cb) 供模块订阅状态变化
   ═══════════════════════════════════════════════════════════════ */
"use strict";

import { esc } from "./shell.js";
import { icon, mountIcons, toast, withPending } from "./ui.js";
import { api, pbkdf2Base64, randomSalt, DEFAULT_ITER } from "./api.js";
import { getPubConfig } from "./pubcfg.js";
import { bellHTML, refreshBell, goCardhubView } from "./notify.js";

const TURNSTILE_SITEKEY = "0x4AAAAAAFFH8cKk2ttfupI-";
/* 本地开发环境跳过 Turnstile（localhost 不在 sitekey 域名白名单，widget 必然失败） */
const IS_LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

/* ─────────────── Turnstile ─────────────── */
let turnstileLoaded = false;
function ensureTurnstile() {
  if (IS_LOCAL) return Promise.resolve();
  return new Promise((resolve) => {
    if (window.turnstile) { resolve(); return; }
    if (turnstileLoaded) {
      const check = setInterval(() => { if (window.turnstile) { clearInterval(check); resolve(); } }, 100);
      return;
    }
    turnstileLoaded = true;
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    s.async = true;
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    s.onload = finish;
    s.onerror = finish; // 脚本加载失败也放行：后端关防护时 token 可为空
    setTimeout(finish, 5000); // 网络异常兜底，绝不无限挂起
    document.head.appendChild(s);
  });
}
function getTurnstileToken() {
  try { return window.turnstile?.getResponse() || ""; } catch { return ""; }
}
function renderTurnstile(containerId) {
  const el = document.getElementById(containerId);
  if (IS_LOCAL) { if (el) el.style.display = "none"; return; }
  if (!el || !window.turnstile) return;
  el.innerHTML = "";
  try { window.turnstile.render(el, { sitekey: TURNSTILE_SITEKEY }); } catch {}
}

/* ─────────────── 样式注入（一次性） ─────────────── */
/* 变量对齐 shell/theme.css 设计系统：--acc/--acc-deep/--surface/--surface-2/--line/--txt/--sub/--red */
const AUTH_CSS = `
.auth-chip{display:flex;align-items:center;gap:8px;padding:5px 10px 5px 5px;border-radius:999px;background:var(--surface-2);border:1px solid var(--line);cursor:pointer;transition:border-color .15s,box-shadow .15s;user-select:none}
.auth-chip:hover{border-color:var(--acc);box-shadow:0 0 0 3px color-mix(in oklab,var(--acc) 14%,transparent)}
.auth-chip svg{width:14px;height:14px;color:var(--sub);flex-shrink:0}
.auth-avatar{width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,var(--acc),var(--acc-deep));color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;flex-shrink:0}
.auth-avatar-img{width:28px;height:28px;border-radius:50%;object-fit:cover;flex-shrink:0;background:var(--surface-2)}
/* ── 资料卡 ── */
.auth-profile-avatar{width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,var(--acc),var(--acc-deep));color:#fff;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;flex-shrink:0}
.auth-profile-avatar img{width:56px;height:56px;border-radius:50%;object-fit:cover}
.auth-profile-head{display:flex;align-items:center;gap:14px;padding:14px;margin-bottom:10px;border-radius:12px;background:color-mix(in oklab,var(--surface-2) 55%,transparent);border:1px solid color-mix(in oklab,var(--line) 70%,transparent)}
.auth-profile-name{font-size:16px;font-weight:700;color:var(--txt)}
.auth-profile-badges{display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px;margin-top:4px;min-width:0}
.auth-profile-title{display:inline-block;font-size:11px;font-weight:600;color:var(--acc);background:color-mix(in oklab,var(--acc) 12%,transparent);padding:2px 8px;border-radius:999px}
.auth-profile-uid{font-size:11px;color:var(--sub);margin-top:2px;word-break:break-all}
.auth-profile-bio{font-size:12.5px;color:var(--sub);margin-top:6px;line-height:1.6}
.auth-profile-ct{display:flex;align-items:center;gap:8px;padding:9px 12px;border:1px solid var(--line);border-radius:10px;background:var(--surface-2);font-size:13px;color:var(--txt);margin-bottom:8px}
.auth-profile-ct code{font-family:ui-monospace,monospace;word-break:break-all;flex:1;min-width:0}
/* 签名卡：复用联系方式卡布局，正文用常规字体（签名非代码，等宽不合适） */
.auth-profile-ct-bio .v{flex:1;min-width:0;font-size:13px;line-height:1.6;color:var(--txt);overflow-wrap:anywhere}
.auth-profile-ct .t{flex:none;font-size:11px;font-weight:700;color:var(--sub);min-width:40px}
.auth-profile-ct .btn{flex:none;padding:5px 10px;border-radius:8px;border:1px solid var(--line);background:var(--surface);color:var(--sub);font-size:12px;cursor:pointer;transition:.15s}
.auth-profile-ct .btn:hover{border-color:var(--acc);color:var(--acc)}
.auth-profile-none{font-size:12px;color:var(--sub);padding:12px;border:1px dashed var(--line);border-radius:10px;text-align:center}
/* 资料卡「在线沟通」按钮行（跳转跳蚤市集会话收件箱） */
.auth-profile-actions{display:flex;margin-top:10px}
.auth-profile-actions .btn{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:9px;border-radius:10px;border:none;font-size:13.5px;font-weight:700;cursor:pointer;background:linear-gradient(135deg,var(--acc),var(--acc-deep));color:#fff;box-shadow:0 4px 14px color-mix(in oklab,var(--acc) 35%,transparent);transition:filter .15s}
.auth-profile-actions .btn:hover{filter:brightness(1.08)}
.auth-profile-actions .btn svg{width:15px;height:15px}
/* ── 账号设置表单 ── */
.auth-ct-list{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:12px;background:color-mix(in oklab,var(--surface-2) 55%,transparent);border:1px solid color-mix(in oklab,var(--line) 70%,transparent)}
.auth-ct-row{display:flex;align-items:center;gap:8px}
.auth-ct-type{flex:none;width:46px;font-size:12px;font-weight:700;color:var(--sub);text-align:center;padding:6px 0;border-radius:8px;background:var(--surface);border:1px solid var(--line)}
.auth-ct-row .inp{flex:1;min-width:0}
.auth-ct-pub{flex:none;display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--sub);cursor:pointer;user-select:none}
.auth-ct-pub input{width:15px;height:15px;accent-color:var(--acc);cursor:pointer}
/* ── 头像设置行（图床直链） ── */
.auth-avatar-row{display:flex;align-items:center;gap:10px}
.auth-avatar-cur{flex:none;width:44px;height:44px;border-radius:50%;object-fit:cover;background:linear-gradient(135deg,var(--acc),var(--acc-deep));color:#fff;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700}
.auth-avatar-row .inp{flex:1;min-width:0}
.auth-ct-pub input:disabled{cursor:not-allowed;opacity:.45}
.auth-bio-count{text-align:right;font-size:11px;color:var(--sub);margin-top:4px}
/* ── 顶栏用户芯片（双行：昵称 / 徽章） ── */
.auth-chip{display:flex;align-items:center;gap:9px;padding:4px 9px 4px 4px;border-radius:999px;background:var(--surface-2);border:1px solid var(--line);cursor:pointer;transition:border-color .15s,box-shadow .15s;user-select:none}
.auth-chip:hover{border-color:var(--acc);box-shadow:0 0 0 3px color-mix(in oklab,var(--acc) 14%,transparent)}
.auth-chip .auth-chip-caret{width:14px;height:14px;color:var(--sub);flex-shrink:0;transition:transform .18s}
.auth-chip .auth-chip-caret svg{width:14px;height:14px}
.auth-avatar{width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,var(--acc),var(--acc-deep));color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;flex-shrink:0;box-shadow:0 0 0 2px color-mix(in oklab,var(--acc) 22%,transparent)}
.auth-avatar-img{width:34px;height:34px;border-radius:50%;object-fit:cover;flex-shrink:0;background:var(--surface-2);box-shadow:0 0 0 2px color-mix(in oklab,var(--acc) 22%,transparent)}
.auth-chip-meta{display:flex;flex-direction:column;align-items:flex-start;gap:2px;min-width:0;max-width:190px}
.auth-chip-name{font-size:13px;font-weight:700;color:var(--txt);line-height:1.15;max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 徽章：inline-flex+line-height:1 保证两字文本严格居中（旧 .auth-role 依赖行高导致偏移） */
.auth-chip-badges{display:flex;align-items:center;gap:4px;min-width:0;max-width:190px}
.auth-badge{display:inline-flex;align-items:center;gap:3px;line-height:1;font-size:10px;font-weight:700;padding:2.5px 7px;border-radius:999px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.auth-badge svg{width:9px;height:9px;flex-shrink:0}
.auth-badge.owner{flex:none;background:linear-gradient(135deg,#f5a623,#e8890c);color:#fff;box-shadow:0 1px 4px color-mix(in oklab,#f5a623 40%,transparent)}
.auth-badge.admin{flex:none;background:color-mix(in oklab,var(--acc) 15%,transparent);color:var(--acc)}
/* 头衔徽章（职位与头衔是两个维度，人人展示；超长让位给省略号） */
.auth-badge.title{flex:1;min-width:0;background:var(--surface);color:var(--sub);border:1px solid var(--line);font-weight:600}
.auth-btn{display:flex;align-items:center;gap:6px;padding:7px 14px;border-radius:9px;background:var(--surface-2);border:1px solid var(--line);color:var(--txt);font-size:13px;cursor:pointer;transition:.15s;white-space:nowrap}
.auth-btn:hover{border-color:var(--acc);color:var(--acc)}
.auth-btn svg{width:16px;height:16px;flex-shrink:0}
/* 手机端：只留头像，昵称/徽章/箭头收进下拉菜单 */
@media (max-width: 640px) {
  .auth-chip{padding:3px;border-radius:50%}
  .auth-chip-meta,.auth-chip .auth-chip-caret{display:none}
  .auth-avatar,.auth-avatar-img{width:34px;height:34px}
  .auth-btn{padding:7px 10px}
  .auth-btn span{display:none}
}
/* ── 下拉菜单 ── */
.auth-drop{position:fixed;z-index:9999;min-width:230px;background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:0 12px 32px rgba(0,0,0,.18);padding:6px;display:none}
.auth-drop.open{display:block;animation:auth-pop .18s ease}
@keyframes auth-pop{from{opacity:0;transform:translateY(-6px) scale(.98)}}
.auth-drop-head{padding:10px 12px;border-bottom:1px solid var(--line);margin-bottom:4px}
.auth-drop-head .ae{font-size:13px;font-weight:700;color:var(--txt);word-break:break-all}
.auth-drop-head .ar{font-size:11px;color:var(--sub);margin-top:2px}
.auth-drop-title{display:inline-block;font-size:10.5px;font-weight:600;color:var(--acc);background:color-mix(in oklab,var(--acc) 12%,transparent);padding:2px 8px;border-radius:999px}
.auth-drop-title + .auth-drop-title{margin-left:6px}
.auth-drop-item{display:flex;align-items:center;gap:10px;width:100%;padding:9px 12px;border:none;background:none;color:var(--txt);font-size:13px;border-radius:9px;cursor:pointer;text-align:left;transition:background .15s}
.auth-drop-item:hover{background:var(--surface-2)}
.auth-drop-item svg{width:16px;height:16px;color:var(--sub);flex-shrink:0}
.auth-drop-item.danger{color:var(--red)}
.auth-drop-item.danger svg{color:var(--red)}
.auth-drop-divider{height:1px;background:var(--line);margin:4px 0}
/* ── 弹窗 ── */
.auth-modal-mask{position:fixed;inset:0;background:rgba(0,0,0,.5);backdrop-filter:blur(4px);z-index:10000;display:none;align-items:center;justify-content:center;padding:20px}
.auth-modal-mask.open{display:flex;animation:auth-fade .2s ease}
@keyframes auth-fade{from{opacity:0}}
.auth-modal{position:relative;background:var(--surface);border:1px solid var(--line);border-radius:18px;width:100%;max-width:420px;padding:24px;box-shadow:0 20px 60px rgba(0,0,0,.3);animation:auth-pop .25s ease}
.auth-modal::before{content:"";position:absolute;top:0;left:24px;right:24px;height:3px;border-radius:0 0 3px 3px;background:linear-gradient(90deg,var(--acc),var(--acc-deep))}
.auth-modal h3{margin:0 0 16px;font-size:17px;font-weight:800;color:var(--txt)}
.auth-modal .fg{margin-bottom:14px}
.auth-modal .fg label{display:flex;align-items:baseline;gap:8px;font-size:12.5px;font-weight:600;color:var(--txt);margin-bottom:6px}
.auth-modal .fg label .hint{font-weight:400;font-size:11px;color:var(--sub)}
.auth-modal .inp{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--surface-2);color:var(--txt);font-size:14px;box-sizing:border-box;transition:border-color .15s,box-shadow .15s}
.auth-modal .inp:focus{outline:none;border-color:var(--acc);box-shadow:0 0 0 3px color-mix(in oklab,var(--acc) 16%,transparent)}
.auth-modal .actions{display:flex;gap:8px;margin-top:18px}
.auth-modal .btn{flex:1;padding:10px;border-radius:10px;border:none;font-size:14px;cursor:pointer;font-weight:700;transition:filter .15s,transform .1s}
.auth-modal .btn.primary{background:linear-gradient(135deg,var(--acc),var(--acc-deep));color:#fff;box-shadow:0 4px 14px color-mix(in oklab,var(--acc) 35%,transparent)}
.auth-modal .btn.primary:hover{filter:brightness(1.08)}
.auth-modal .btn.primary:active{transform:translateY(1px)}
.auth-modal .btn.ghost{background:var(--surface-2);color:var(--txt);border:1px solid var(--line)}
.auth-modal .btn.ghost:hover{border-color:var(--acc);color:var(--acc)}
.auth-modal .hint{font-size:12px;color:var(--sub);margin-top:8px}
.auth-modal .hint a{color:var(--acc);cursor:pointer}
.auth-turnstile{display:flex;justify-content:center;min-height:65px;margin:8px 0}
.auth-close{position:absolute;top:12px;right:14px;background:none;border:none;color:var(--sub);cursor:pointer;font-size:22px;line-height:1;transition:color .15s}
.auth-close:hover{color:var(--txt)}
`;
let cssInjected = false;
function injectCSS() {
  if (cssInjected) return;
  cssInjected = true;
  const s = document.createElement("style");
  s.textContent = AUTH_CSS;
  document.head.appendChild(s);
}

/* ─────────────── 模态框 DOM（懒创建） ─────────────── */
let modalEl = null;
function getModal() {
  /* 同 getDrop：body 被路由重写后缓存节点会游离，需重建 */
  if (modalEl && document.body.contains(modalEl)) return modalEl;
  modalEl = document.createElement("div");
  modalEl.className = "auth-modal-mask";
  modalEl.innerHTML = `<div class="auth-modal" id="authModalBox"></div>`;
  modalEl.addEventListener("click", (e) => { if (e.target === modalEl) closeModal(); });
  document.body.appendChild(modalEl);
  return modalEl;
}
function openModal(html) {
  injectCSS();
  const m = getModal();
  m.querySelector("#authModalBox").innerHTML = html;
  m.classList.add("open");
  mountIcons(m.querySelector("#authModalBox"));
}
function closeModal() { getModal().classList.remove("open"); }

/* ─────────────── 事件系统 ─────────────── */
const listeners = { login: [], logout: [], change: [] };
function emit(evt) { (listeners[evt] || []).forEach((cb) => { try { cb(); } catch {} }); }

/* ─────────────── 主模块 ─────────────── */
export const Auth = {
  getUser() { return api.getUser(); },
  isLoggedIn() { return api.isLoggedIn(); },
  isOwner() { return this.getUser()?.role === "owner"; },
  isAdmin() { const r = this.getUser()?.role; return r === "owner" || r === "admin"; },

  on(evt, cb) { (listeners[evt] = listeners[evt] || []).push(cb); },

  async logout() {
    await api.logoutApi();
    emit("logout");
    emit("change");
    refreshAll();
  },

  /** 在容器中渲染登录按钮或用户芯片 */
  mount(container) {
    injectCSS();
    if (!container) return;
    syncMe(); // 静默刷新本地缓存（节流）：修复老登录缓存缺 id/contacts/bio 等字段
    const user = this.getUser();
    if (user) {
      const disp = user.nickname || user.email || "?"; // 展示名：昵称优先，避免暴露邮箱
      const initial = disp.charAt(0).toUpperCase();
      const avatar = user.avatar_v
        ? `<img class="auth-avatar-img" src="${esc(api.avatarUrl(user.id, user.avatar_v))}" alt="">`
        : `<div class="auth-avatar">${esc(initial)}</div>`;
      // 下行双徽章：职位（站长=金/管理员=蓝，仅 staff）+ 头衔（人人展示，title 或默认头衔）
      const DEFAULT_TITLE = "平平无奇的路人";
      const roleBadge = user.role === "owner"
        ? `<span class="auth-badge owner"><i data-icon="shield"></i>站长</span>`
        : user.role === "admin"
          ? `<span class="auth-badge admin"><i data-icon="shield"></i>管理员</span>`
          : "";
      // 多头衔「｜」分隔（管理端约定）：顶栏空间有限仅显示第一段，资料卡/下拉展示全部
      const t = (user.title || "").trim().split(/[｜|]/).map((s) => s.trim()).filter(Boolean)[0] || DEFAULT_TITLE;
      const titleBadge = `<span class="auth-badge title">${esc(t)}</span>`;
      container.innerHTML = `
        <span class="auth-area">${bellHTML()}
        <div class="auth-chip" id="authChip" tabindex="0" aria-haspopup="true">
          ${avatar}
          <span class="auth-chip-meta">
            <span class="auth-chip-name">${esc(disp)}</span>
            <span class="auth-chip-badges">${roleBadge}${titleBadge}</span>
          </span>
          <i data-icon="chevronDown" class="auth-chip-caret"></i>
        </div></span>`;
    } else {
      container.innerHTML = `<button class="auth-btn" id="authLoginBtn"><i data-icon="user"></i><span>登录</span></button>`;
    }
    mountIcons(container);
    if (user) refreshBell(); // 登录态同步未读红点（30s 节流）
  },

  openLogin() {
    injectCSS();
    ensureEmailPolicy(); // 邮箱域名白名单（前端即时校验用，异步预取不阻塞）
    openModal(`
      <button class="auth-close" data-act="closeAuth">&times;</button>
      <h3>登录 / 注册</h3>
      <p class="hint" style="margin-top:0">已有账号直接登录；首次使用自动注册（需邮箱验证码）。</p>
      <div id="authLoginBody"></div>
    `);
    renderLoginBody("email");
    getModal().querySelector("#authModalBox").addEventListener("click", onModalClick);
  },

  openChangePassword() {
    injectCSS();
    ensureEmailPolicy();
    openModal(`
      <button class="auth-close" data-act="closeAuth">&times;</button>
      <h3>修改密码</h3>
      <div id="authResetBody"></div>
    `);
    renderResetBody();
    getModal().querySelector("#authModalBox").addEventListener("click", onModalClick);
  },

  /** 账号设置（改自己） */
  openSettings() { this._openSettingsBase(null); },

  /** 管理员调出指定用户的账号设置进行代改（资料由后台接口拉取，保存走管理员端点） */
  async openSettingsFor(uid) {
    injectCSS();
    settingsTarget = null;
    openModal(`<button class="auth-close" data-act="closeAuth" aria-label="关闭">&times;</button><h3>加载中…</h3>`);
    getModal().querySelector("#authModalBox").addEventListener("click", onModalClick);
    const r = await api.adminUserProfile(uid);
    if (!r.ok || !r.data) {
      const b = getModal().querySelector("#authModalBox");
      if (b) b.innerHTML = `<p class="hint">资料获取失败${r.error ? "：" + esc(typeof r.error === "string" ? r.error : (r.error.message || "")) : ""}</p>`;
      return;
    }
    this._openSettingsBase(r.data);
  },

  /** 账号设置弹窗本体：target 为 null = 改自己；否则为管理员代改目标（含 role/email）
      注意：此处「公开」只控制他人点头像时的资料卡；发帖时的联系方式可见性在发布页单独设置，两者互不绑定 */
  _openSettingsBase(target) {
    injectCSS();
    settingsTarget = target;
    const user = target || this.getUser();
    const isStaff = user?.role === "admin" || user?.role === "owner";
    const vmax = isStaff ? 50 : 15; // 管理员/站长豁免 15 字限制（代改时按目标用户角色）
    const cur = Array.isArray(user?.contacts) ? user.contacts : [];
    const rows = Object.entries(CT_LABELS).map(([type, label]) => {
      const c = cur.find((x) => x.type === type);
      // 空值行禁用「公开」勾选（后端同样忽略空值的公开标志）
      const pubDis = c?.value ? "" : " disabled";
      return `
      <div class="auth-ct-row">
        <span class="auth-ct-type">${label}</span>
        <input class="inp" data-ct="${type}" maxlength="${vmax}" placeholder="${isStaff ? "不限 15 字 · 禁中文" : "≤15 字 · 禁中文"}" value="${esc(c?.value || "")}">
        <label class="auth-ct-pub" title="勾选后他人点击你的头像可见此条"><input type="checkbox" data-ctpub="${type}" ${c?.pub ? "checked" : ""}${pubDis}>公开</label>
      </div>`;
    }).join("");
    openModal(`
      <button class="auth-close" data-act="closeAuth" aria-label="关闭">&times;</button>
      <h3>${target ? `账号设置 · ${esc(user.email)}` : "账号设置"}</h3>
      ${target ? "" : `
      <div class="fg">
        <div class="auth-avatar-row">
          ${user?.avatar_v
            ? `<img class="auth-avatar-cur" src="${esc(api.avatarUrl(user.id, user.avatar_v))}" alt="">`
            : `<span class="auth-avatar-cur">${esc((user?.nickname || "?").charAt(0).toUpperCase())}</span>`}
          <input class="inp" id="authAvatarInput" placeholder="头像图床直链（https://… 图片地址），留空保持不变">
          ${user?.avatar_v ? `<button type="button" class="btn ghost" data-act="authAvatarClear">恢复默认</button>` : ""}
        </div>
      </div>`}
      <div class="fg">
        <label>昵称<span class="hint">${isStaff ? "2~20 位 · 管理员/站长不受 5 字限制" : "2~5 个字 · 中英文/数字/下划线/连字符"}</span></label>
        <input class="inp" id="authNickInput" maxlength="${isStaff ? 20 : 5}" placeholder="${isStaff ? "如：阿卡林" : "如：山间的风"}" value="${esc(user?.nickname || "")}">
      </div>
      <div class="fg">
        <label>联系方式<span class="hint">禁中文 · 逐条勾选「公开」· 发布帖时默认带入公开项</span></label>
        <div class="auth-ct-list">${rows}</div>
      </div>
      <div class="fg">
        <label>个性签名<span class="hint">≤25 字 · 展示在个人资料卡</span></label>
        <input class="inp" id="authBioInput" maxlength="25" placeholder="一句话介绍自己" value="${esc(user?.bio || "")}">
        <div class="auth-bio-count"><span id="authBioCount">${(user?.bio || "").length}</span>/25</div>
      </div>
      <div class="actions"><button class="btn primary" data-act="authSettingsSave">保存设置</button></div>
    `);
    const box = getModal().querySelector("#authModalBox");
    box.addEventListener("click", onModalClick);
    box.addEventListener("input", onSettingsInput); // 同一函数引用，重复挂载会被浏览器去重
  },

  /** 他人公开资料卡（点头像弹出）：昵称 / UID / 主动公开的联系方式 */
  async showProfileCard(uid) {
    injectCSS();
    openModal(`<button class="auth-close" data-act="closeAuth">&times;</button><h3>用户资料</h3><div id="authCardBody"><p class="hint">加载中…</p></div>`);
    getModal().querySelector("#authModalBox").addEventListener("click", onModalClick);
    const r = await api.getPublicProfile(uid);
    const body = getModal().querySelector("#authCardBody");
    if (!body) return;
    if (!r.ok || !r.data) { body.innerHTML = '<p class="hint">资料获取失败</p>'; return; }
    const p = r.data;
    // 职位徽章（与顶栏同款：站长金/管理员蓝，普通用户不显示），位于 UID 之前
    const roleBadge = p.role === "owner"
      ? `<span class="auth-badge owner"><i data-icon="shield"></i>站长</span>`
      : p.role === "admin"
        ? `<span class="auth-badge admin"><i data-icon="shield"></i>管理员</span>`
        : "";
    // 多头衔「｜」分隔：资料卡全量展示，逐段渲染为独立小徽章
    const titleChips = (p.title || "").trim().split(/[｜|]/).map((s) => s.trim()).filter(Boolean);
    const titleHtml = titleChips.length
      ? titleChips.map((s) => `<span class="auth-profile-title">${esc(s)}</span>`).join("")
      : `<span class="auth-profile-title">平平无奇的路人</span>`;
    const avatar = p.avatar_v
      ? `<div class="auth-profile-avatar"><img src="${esc(api.avatarUrl(p.id, p.avatar_v))}" alt=""></div>`
      : `<div class="auth-profile-avatar">${esc((p.nickname || "?").charAt(0).toUpperCase())}</div>`;
    body.innerHTML = `
      <div class="auth-profile-head">
        ${avatar}
        <div style="min-width:0">
          <div class="auth-profile-name">${esc(p.nickname || "未设置昵称")}</div>
          <div class="auth-profile-badges">${roleBadge}${titleHtml}</div>
          <div class="auth-profile-uid">UID: ${esc(p.id)}</div>
        </div>
      </div>
      ${p.bio ? `<div class="auth-profile-ct auth-profile-ct-bio"><span class="v">${esc(p.bio)}</span></div>` : ""}
      ${(p.contacts || []).map((c) => `
        <div class="auth-profile-ct"><span class="t">${CT_LABELS[c.type] || "其他"}</span><code>${esc(c.value)}</code>
        <button class="btn ghost" data-act="copyUid" data-val="${esc(c.value)}" style="flex:none;padding:6px 10px;margin-left:auto">复制</button></div>`).join("")
        || `<div class="auth-profile-none">该用户未公开联系方式</div>`}
      ${Auth.isLoggedIn() ? `<div class="auth-profile-actions"><button class="btn primary" data-act="profileChat" data-uid="${esc(p.id)}"><i data-icon="message"></i>在线沟通</button></div>` : ""}`;
    mountIcons(body);
  },
};

/* ─────────────── 登录流程 ─────────────── */
let loginState = { email: "", pwd: "", k: "", salt: "", iter: 0 };

async function renderLoginBody(step) {
  const body = getModal().querySelector("#authLoginBody");
  if (!body) return;
  if (step === "email") {
    body.innerHTML = `
      <div class="fg"><label>邮箱</label><input class="inp" id="authEmail" type="email" placeholder="you@example.com"></div>
      <div class="fg"><label>密码</label><input class="inp" id="authPwd" type="password" placeholder="至少 6 位"></div>
      <div class="auth-turnstile" id="authTurnstile"></div>
      <div class="actions">
        <button class="btn primary" data-act="authSubmit">登录 / 注册</button>
      </div>
      <p class="hint">忘记密码？<a data-act="authForgot">找回密码</a></p>`;
    await ensureTurnstile();
    renderTurnstile("authTurnstile");
  } else if (step === "confirm") {
    /* 注册确认步骤（2026-09-29 站长要求）：发码前先征求确认，不打算注册不发码（省邮件额度） */
    body.innerHTML = `
      <div class="fg"><label>邮箱</label><div class="inp" style="background:var(--surface-3)">${esc(loginState.email)}</div></div>
      <p class="hint" style="margin:8px 0 2px">该邮箱尚未注册。将发送验证码到该邮箱，验证通过即完成注册（验证码邮件有每日额度，请确认是本人邮箱再发送）。</p>
      <div class="auth-turnstile" id="authTurnstile"></div>
      <div class="actions">
        <button class="btn ghost" data-act="authBackEmail">返回修改</button>
        <button class="btn primary" data-act="authConfirmSend">发送验证码</button>
      </div>`;
    await ensureTurnstile();
    renderTurnstile("authTurnstile");
  } else {
    body.innerHTML = `
      <div class="fg"><label>邮箱</label><div class="inp" style="background:var(--surface-3)">${esc(loginState.email)}</div></div>
      <div class="fg"><label>6 位验证码</label><input class="inp" id="authCode" type="text" maxlength="6" placeholder="邮箱收到的 6 位数字"></div>
      <div class="auth-turnstile" id="authTurnstile"></div>
      <p class="hint">验证码用于完成注册。没收到？<a data-act="authResend">重新发送</a></p>
      <div class="actions">
        <button class="btn ghost" data-act="authBackEmail">返回</button>
        <button class="btn primary" data-act="authRegister">完成注册</button>
      </div>`;
    await ensureTurnstile();
    renderTurnstile("authTurnstile");
  }
  mountIcons(body);
}

/* 登录域错误码 → 用户可读中文（兜底防英文码直出；未命中原样透出便于排查） */
const AUTH_ERR_CN = {
  EMAIL_NOT_FOUND: "该邮箱尚未注册",
  INVALID_PASSWORD: "邮箱或密码不匹配",
  INVALID_CREDENTIALS: "邮箱或密码不匹配",
  EMAIL_EXISTS: "该邮箱已注册，请直接登录",
  CODE_INVALID: "验证码错误",
  CODE_LOCKED: "验证码错误次数过多，请重新发送",
  LOGIN_LOCKED: "尝试次数过多，请 15 分钟后再试",
  CAPTCHA_FAILED: "人机验证未通过，请重试",
  RATE_LIMITED: "操作过于频繁，请稍后再试",
  EMAIL_DOMAIN_NOT_ALLOWED: "暂不支持该邮箱域名，请使用常见邮箱（QQ/163/Gmail 等）",
};
/* ─────────────── 邮箱域名白名单（前后台双重校验的前台侧） ───────────────
   打开登录/改密弹窗时预取（快照优先，缺失回落 /api/auth/email-policy；站长可配；
   未加载完成时放行，由后端兜底） */
let emailPolicyDomains = null;
let emailPolicyLoaded = false;
function ensureEmailPolicy() {
  if (emailPolicyLoaded) return;
  emailPolicyLoaded = true;
  getPubConfig().then((pc) => {
    if (pc && pc.email_policy && Array.isArray(pc.email_policy.domains)) {
      emailPolicyDomains = pc.email_policy.domains;
      return null;
    }
    return api.request("/api/auth/email-policy").then((r) => {
      if (r.ok && Array.isArray(r.data.domains)) emailPolicyDomains = r.data.domains;
    }).catch(() => { /* 预取失败放行，后端兜底 */ });
  }).catch(() => { /* 快照读取失败放行，后端兜底 */ });
}
function emailDomainOk(email) {
  if (!emailPolicyDomains || !emailPolicyDomains.length) return true;
  const at = email.lastIndexOf("@");
  return at > 0 && emailPolicyDomains.includes(email.slice(at + 1).toLowerCase());
}
const EMAIL_DOMAIN_HINT = "暂不支持该邮箱域名，请使用常见邮箱（QQ/163/Gmail 等）";

function authErr(code) { return code ? (AUTH_ERR_CN[code] || code) : ""; }

async function authSubmit() {
  const email = (getModal().querySelector("#authEmail")?.value || "").trim();
  const pwd = getModal().querySelector("#authPwd")?.value || "";
  const captcha = getTurnstileToken();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast("请输入有效邮箱"); return; }
  if (!emailDomainOk(email)) { toast(EMAIL_DOMAIN_HINT); return; }
  if (!pwd || pwd.length < 6) { toast("密码至少 6 位"); return; }
  loginState.email = email;
  loginState.pwd = pwd;

  const lp = await api.loginParams(email, captcha);
  if (!lp.ok) { toast(authErr(lp.error) || "参数获取失败"); renderTurnstile("authTurnstile"); return; }
  loginState.salt = lp.data.salt;
  loginState.iter = lp.data.iter;
  loginState.k = await pbkdf2Base64(pwd, lp.data.salt, lp.data.iter);

  const lr = await api.login(email, loginState.k, captcha);
  if (lr.ok) {
    closeModal();
    toast("登录成功");
    emit("login"); emit("change");
    refreshAll();
    return;
  }
  /* 错误分流（2026-09-29 站长决策：后端已拆码 EMAIL_NOT_FOUND / INVALID_PASSWORD）：
     未注册→注册确认视图（确认后才发码）；密码错→中性提示停留重试。
     信封业务码勿用数值比较（40001≠HTTP 400），一律按 error 消息匹配；
     INVALID_CREDENTIALS 为旧后端混码兼容分支（新后端全量后可删，兼容期同走确认视图不浪费邮件） */
  if (lr.error === "EMAIL_NOT_FOUND" || lr.error === "INVALID_CREDENTIALS") {
    renderLoginBody("confirm");
    return;
  }
  if (lr.error === "INVALID_PASSWORD") {
    toast("邮箱或密码不匹配，请重试（忘记密码可点下方「找回密码」）");
    renderTurnstile("authTurnstile");
    return;
  }
  toast(authErr(lr.error) || "登录失败");
  renderTurnstile("authTurnstile");
}

/* 注册确认视图点「发送验证码」：此时才派生注册密钥并真正发码 */
async function authConfirmSend() {
  const captcha = getTurnstileToken();
  loginState.salt = randomSalt();
  loginState.k = await pbkdf2Base64(loginState.pwd, loginState.salt, DEFAULT_ITER);
  const sc = await api.sendCode(loginState.email, captcha);
  if (!sc.ok) { toast(authErr(sc.error) || "验证码发送失败"); renderTurnstile("authTurnstile"); return; }
  renderLoginBody("code");
  toast("验证码已发送至邮箱，验证通过即完成注册");
}

async function authRegister() {
  const code = (getModal().querySelector("#authCode")?.value || "").trim();
  const captcha = getTurnstileToken();
  if (code.length !== 6) { toast("请输入 6 位验证码"); return; }
  const r = await api.register(loginState.email, loginState.k, loginState.salt, DEFAULT_ITER, code, captcha);
  if (!r.ok) { toast(authErr(r.error) || "注册失败"); renderTurnstile("authTurnstile"); return; }
  closeModal();
  toast("注册成功，已自动登录");
  emit("login"); emit("change");
  refreshAll();
}

async function authResend() {
  const captcha = getTurnstileToken();
  const sc = await api.sendCode(loginState.email, captcha);
  toast(sc.ok ? "验证码已重新发送" : (authErr(sc.error) || "发送失败"));
  if (!sc.ok) renderTurnstile("authTurnstile");
}

/* ─────────────── 改密流程 ─────────────── */
let resetState = { step: "code", email: "", code: "", salt: "", iter: 0, k: "" };

async function renderResetBody() {
  const body = getModal().querySelector("#authResetBody");
  if (!body) return;
  const user = Auth.getUser();
  if (resetState.step === "code") {
    body.innerHTML = `
      <div class="fg"><label>邮箱</label><input class="inp" id="authResetEmail" type="email" value="${esc(user?.email || "")}" placeholder="注册邮箱"></div>
      <p class="hint">将向该邮箱发送 6 位验证码</p>
      <div class="auth-turnstile" id="authTurnstile"></div>
      <div class="actions"><button class="btn primary" data-act="authSendReset">发送验证码</button></div>`;
  } else {
    body.innerHTML = `
      <div class="fg"><label>6 位验证码</label><input class="inp" id="authResetCode" type="text" maxlength="6" placeholder="邮箱收到的验证码"></div>
      <div class="fg"><label>新密码</label><input class="inp" id="authResetPwd" type="password" placeholder="至少 6 位"></div>
      <div class="fg"><label>确认新密码</label><input class="inp" id="authResetPwd2" type="password" placeholder="再输一次"></div>
      <div class="auth-turnstile" id="authTurnstile"></div>
      <div class="actions">
        <button class="btn ghost" data-act="authResetBack">返回</button>
        <button class="btn primary" data-act="authDoReset">确认修改</button>
      </div>`;
  }
  await ensureTurnstile();
  renderTurnstile("authTurnstile");
  mountIcons(body);
}

async function authSendReset() {
  const email = (getModal().querySelector("#authResetEmail")?.value || "").trim();
  const captcha = getTurnstileToken();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast("请输入有效邮箱"); return; }
  if (!emailDomainOk(email)) { toast(EMAIL_DOMAIN_HINT); return; }
  resetState.email = email;
  const r = await api.sendResetCode(email, captcha);
  if (!r.ok) { toast(r.error || "发送失败"); renderTurnstile("authTurnstile"); return; }
  resetState.step = "reset";
  renderResetBody();
  toast("验证码已发送");
}

async function authDoReset() {
  const code = (getModal().querySelector("#authResetCode")?.value || "").trim();
  const pwd = getModal().querySelector("#authResetPwd")?.value || "";
  const pwd2 = getModal().querySelector("#authResetPwd2")?.value || "";
  const captcha = getTurnstileToken();
  if (code.length !== 6) { toast("请输入 6 位验证码"); return; }
  if (pwd.length < 6) { toast("密码至少 6 位"); return; }
  if (pwd !== pwd2) { toast("两次密码不一致"); return; }

  // 用 login-params 取该用户当前的盐和迭代次数
  const lp = await api.loginParams(resetState.email, captcha);
  if (!lp.ok) { toast(lp.error || "参数获取失败"); renderTurnstile("authTurnstile"); return; }
  const k = await pbkdf2Base64(pwd, lp.data.salt, lp.data.iter);

  const r = await api.resetPassword(resetState.email, k, lp.data.salt, lp.data.iter, code, captcha);
  if (!r.ok) { toast(r.error || "修改失败"); renderTurnstile("authTurnstile"); return; }
  closeModal();
  toast("密码已修改，请重新登录");
  await Auth.logout();
}

/* ─────────────── 用户下拉菜单 ─────────────── */
let dropEl = null;
function getDrop() {
  /* 页面路由 onEnter/onExit 会重写 body.innerHTML，缓存节点可能已游离文档外，
     命中缓存前必须检测 contains，否则加 .open 也是永不可见的死节点 */
  if (dropEl && document.body.contains(dropEl)) return dropEl;
  dropEl = document.createElement("div");
  dropEl.className = "auth-drop";
  document.body.appendChild(dropEl);
  /* 外点关闭只在首次注册一次；闭包读模块级 dropEl，节点重建后自动指向新节点 */
  if (!getDrop._outsideBound) {
    getDrop._outsideBound = true;
    document.addEventListener("click", (e) => {
      if (!dropEl.contains(e.target) && !e.target.closest(".auth-chip")) closeDrop();
    });
  }
  return dropEl;
}
function openDrop(chip) {
  const user = Auth.getUser();
  if (!user) return;
  const d = getDrop();
  const roleLabel = user.role === "owner" ? "站长" : user.role === "admin" ? "管理员" : "普通用户";
  const titleChips = (user.title || "").trim().split(/[｜|]/).map((s) => s.trim()).filter(Boolean)
    .filter((s) => s !== "平平无奇的路人");
  d.innerHTML = `
    <div class="auth-drop-head">
      <div class="ae">${esc(user.nickname || "未设置昵称")}</div>
      ${titleChips.length ? `<div class="ar">${titleChips.map((s) => `<span class="auth-drop-title">${esc(s)}</span>`).join("")}</div>` : ""}
      <div class="ar">${esc(user.email)}</div>
      <div class="ar">${roleLabel} · UID ${esc(user.id || "")}</div>
    </div>
    ${Auth.isAdmin() ? `<button class="auth-drop-item" data-act="authAdmin"><i data-icon="shield"></i>管理后台</button>` : ""}
    <button class="auth-drop-item" data-act="authSettings"><i data-icon="user"></i>账号设置</button>
    <button class="auth-drop-item" data-act="authChangePwd"><i data-icon="key"></i>修改密码</button>
    <div class="auth-drop-divider"></div>
    <button class="auth-drop-item danger" data-act="authLogout"><i data-icon="logout"></i>退出登录</button>`;
  mountIcons(d);
  const rect = chip.getBoundingClientRect();
  d.style.top = (rect.bottom + 6) + "px";
  /* 先加 .open 并把 left 归零再测宽：fixed 无宽元素是 shrink-to-fit，可用宽 = 视口宽 − left，
     若带着旧 left（或尚未校正的错误 left）测宽，宽度会被挤压到 min-width 托底值，
     导致首开宽度 ≠ 自然宽、下次打开时"漂移"。归零后测得自然宽再定位，首开即正确 */
  d.classList.add("open");
  d.style.left = "0px";
  const dw = d.offsetWidth;
  let left = rect.right - dw;
  if (left < 8) left = 8;
  if (left + dw > window.innerWidth - 8) left = window.innerWidth - dw - 8;
  d.style.left = left + "px";
}
function closeDrop() { if (dropEl) dropEl.classList.remove("open"); }

/* ─────────────── 全局点击代理 ─────────────── */
let authBusy = false; // 登录弹窗异步操作互斥（含回车提交路径）；按钮视觉由 withPending 负责
async function authGuarded(btn, fn) {
  if (authBusy) return;
  authBusy = true;
  try { await withPending(btn, fn); } finally { authBusy = false; }
}

function onModalClick(e) {
  const el = e.target.closest("[data-act]");
  const act = el?.dataset.act;
  if (!act) return;
  if (act === "closeAuth") { closeModal(); return; }
  if (act === "authSubmit") { authGuarded(el, authSubmit); return; }
  if (act === "authRegister") { authGuarded(el, authRegister); return; }
  if (act === "authBackEmail") { renderLoginBody("email"); return; }
  if (act === "authConfirmSend") { authGuarded(el, authConfirmSend); return; }
  if (act === "authResend") { authGuarded(el, authResend); return; }
  if (act === "authForgot") { resetState.step = "code"; Auth.openChangePassword(); return; }
  if (act === "authSendReset") { authGuarded(el, authSendReset); return; }
  if (act === "authDoReset") { authGuarded(el, authDoReset); return; }
  if (act === "authResetBack") { resetState.step = "code"; renderResetBody(); return; }
}

document.addEventListener("click", (e) => {
  const chip = e.target.closest(".auth-chip");
  if (chip) { openDrop(chip); return; }
  const loginBtn = e.target.closest("#authLoginBtn");
  if (loginBtn) { Auth.openLogin(); return; }
  const actEl = e.target.closest("[data-act]");
  const act = actEl?.dataset.act;
  if (!act) return;
  if (act === "authLogout") { closeDrop(); Auth.logout(); return; }
  if (act === "authSettings") { closeDrop(); Auth.openSettings(); return; }
  if (act === "authSettingsSave") { withPending(actEl, authSettingsSave); return; }
  if (act === "authAvatarClear") { withPending(actEl, authAvatarClear); return; }
  if (act === "copyUid") {
    const v = e.target.closest("[data-val]")?.dataset.val || "";
    navigator.clipboard?.writeText(v).then(() => toast("已复制"), () => toast("复制失败"));
    return;
  }
  if (act === "authChangePwd") { closeDrop(); resetState.step = "code"; Auth.openChangePassword(); return; }
  if (act === "authAdmin") { closeDrop(); Shell.navigate("/admin"); return; }
  if (act === "profileChat") {
    /* 资料卡「在线沟通」：发起/复用与该用户的私信会话（kind='dm'，不挂帖子），
       成功后深链跳蚤市集会话收件箱并直达该会话 */
    const uid = actEl.dataset.uid;
    if (!uid) return;
    withPending(actEl, async () => {
      const r = await api.dmCreate(uid);
      if (!r.ok) {
        const cn = {
          CONVERSATION_SELF: "不能与自己发起私信",
          RATE_LIMITED: "今天发起的私信会话已达上限（3 个/天），请明天再试",
        };
        toast(cn[r.error] || r.error || "发起失败，请稍后再试");
        return;
      }
      closeModal();
      try { sessionStorage.setItem("ntf_cardhub_conv", r.data.id); } catch { /* 隐私模式忽略 */ }
      goCardhubView("convs");
    });
    return;
  }
});

/* ─────────────── 刷新所有已挂载的 auth 容器 ─────────────── */
const mountedContainers = new Set();
export function mountAuth(container) {
  mountedContainers.add(container);
  Auth.mount(container);
}
/** 联系方式类型 → 展示名（设置表单/资料卡/发布带入共用） */
const CT_LABELS = { qq: "QQ", wechat: "微信", phone: "手机", email: "邮箱", other: "其他" };
/** 联系方式禁止中文：CJK 汉字检测 / 输入时实时剔除 */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const CJK_RE_G = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
/** 非空 = 管理员正在代改该用户的资料（authSettingsSave 据此分流保存端点） */
let settingsTarget = null;

/** 设置弹窗输入联动：联系方式实时剔中文 + 空值禁「公开」；签名计数器 */
function onSettingsInput(e) {
  const t = e.target;
  if (t.matches?.("[data-ct]")) {
    const v = t.value;
    const cleaned = v.replace(CJK_RE_G, "");
    if (cleaned !== v) t.value = cleaned;
    const pub = t.closest(".auth-ct-row")?.querySelector("[data-ctpub]");
    if (pub) pub.disabled = !t.value.trim();
  } else if (t.id === "authBioInput") {
    const c = document.getElementById("authBioCount");
    if (c) c.textContent = String(t.value.length);
  }
}

/** 保存账号设置：昵称 + 多条联系方式（每条独立公开开关）+ 个性签名
    settingsTarget 非空 = 管理员代改，走管理员端点（豁免档位按目标用户角色）；否则改自己
    前端校验与后端同规则：普通用户昵称 ≤5 字、单条联系方式 ≤15 字且禁中文；admin/owner 豁免长度 */
async function authSettingsSave() {
  const m = getModal();
  const target = settingsTarget;
  const u = target || (api.getUser() || {});
  const isStaff = u.role === "admin" || u.role === "owner";
  const avatarUrl = target ? "" : (m.querySelector("#authAvatarInput")?.value || "").trim();
  const nick = (m.querySelector("#authNickInput")?.value || "").trim();
  const bio = (m.querySelector("#authBioInput")?.value || "").trim();
  // 逐行收集联系方式：type → {type,value,pub}；空值行视为未填（连同公开标志一并忽略）
  const contacts = [];
  for (const row of m.querySelectorAll("[data-ct]")) {
    const value = (row.value || "").trim();
    if (!value) continue;
    contacts.push({
      type: row.dataset.ct,
      value,
      pub: !!m.querySelector(`[data-ctpub="${row.dataset.ct}"]`)?.checked,
    });
  }
  // 前端校验（后端仍有同规则兜底）
  if (nick) {
    const max = isStaff ? 20 : 5;
    if (nick.length < 2 || nick.length > max || !/^[\p{L}\p{N}_-]+$/u.test(nick)) {
      toast(isStaff ? "昵称需 2~20 位：中英文、数字、下划线或连字符" : "昵称需 2~5 个字：中英文、数字、下划线或连字符"); return;
    }
  }
  for (const c of contacts) {
    if (CJK_RE.test(c.value)) { toast("联系方式不能包含中文"); return; }
    if (c.value.length > (isStaff ? 50 : 15)) { toast("单条联系方式不能超过 15 个字"); return; }
  }
  if (bio.length > 25) { toast("个性签名不能超过 25 个字"); return; }
  if (avatarUrl && !/^https:\/\//i.test(avatarUrl)) { toast("头像须为 https 图片直链"); return; }
  try {
    let rs;
    if (target) {
      // 管理员代改：全量保存（昵称留空 = 清除该用户昵称）
      rs = [await api.adminSetUserProfile(target.id, { nickname: nick, contacts, bio })];
    } else {
      const jobs = [];
      if (nick && nick !== u.nickname) jobs.push(api.setNickname(nick));
      jobs.push(api.setProfile(contacts, bio));
      if (avatarUrl) jobs.push(api.setMyAvatar(avatarUrl)); // 留空 = 头像保持不变
      rs = await Promise.all(jobs);
    }
    const bad = rs.find((r) => r && !r.ok);
    if (bad) { toast(typeof bad.error === "string" ? bad.error : (bad.error?.message || "保存失败，请稍后再试")); return; }
    closeModal();
    toast(target ? "该用户的设置已保存" : "账号设置已保存");
    settingsTarget = null;
    if (!target) {
      // 头像/资料变更后立即拉最新 me（avatar_v 破缓存），再刷新顶栏与订阅方
      const me = await api.me();
      if (me.ok && me.data) { me.data._synced = Date.now(); api.setUser(me.data); }
      refreshAll(); emit("change");
    }
  } catch (err) {
    toast(err?.message || "保存失败，请稍后再试");
  }
}

/** 清除自己的头像（恢复昵称首字默认圆形） */
async function authAvatarClear() {
  const r = await api.setMyAvatar("");
  if (!r.ok) { toast(typeof r.error === "string" ? r.error : (r.error?.message || "操作失败")); return; }
  const me = await api.me();
  if (me.ok && me.data) { me.data._synced = Date.now(); api.setUser(me.data); }
  closeModal();
  toast("头像已恢复默认");
  refreshAll(); emit("change");
}

/** 静默刷新本地用户缓存（5 分钟节流）：老登录缓存缺 id/contacts/bio 时自动补齐，
    同时把服务端的角色/封禁状态变化同步到本地 */
let syncing = false;
async function syncMe() {
  if (syncing || !api.isLoggedIn()) return;
  const u = api.getUser();
  if (u && Date.now() - (u._synced || 0) < 5 * 60 * 1000) return;
  syncing = true;
  try {
    const r = await api.me();
    if (r.ok && r.data) { r.data._synced = Date.now(); api.setUser(r.data); refreshAll(); emit("change"); }
  } catch { /* 静默失败，下次 mount 再试 */ } finally { syncing = false; }
}

function refreshAll() {
  mountedContainers.forEach((c) => { if (document.body.contains(c)) Auth.mount(c); });
}

/* 兼容全局访问 */
window.Auth = Auth;
window.mountAuth = mountAuth;

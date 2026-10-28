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
import { NOTIFY_KINDS, NOTIFY_KIND_LABELS } from "./notify-kinds.js";
import { PROVINCES } from "./provinces.js";

const TURNSTILE_SITEKEY = "0x4AAAAAAFFH8cKk2ttfupI-";
/* 本地开发环境跳过 Turnstile（localhost 不在 sitekey 域名白名单，widget 必然失败） */
const IS_LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

/* Turnstile 渲染开关：读后端 turnstile_enforced（/api/meta，5 分钟边缘缓存），关闭时不加载/不渲染组件。
   meta 到手前按开启处理（安全侧，行为同旧版）；拉取失败也按开启处理。
   ▸ 后端校验与此开关同源实时生效：关掉 enforced 后空 token 即可登录，前端只是不再显示框
   ▸ noteCaptchaErr：后端拒 CAPTCHA_FAILED = enforced 实际开启（前端 flag 可能被边缘缓存滞后误导），
     立即恢复渲染，防"框被隐藏 + 空 token 被拒"死循环 */
let turnstileOn = true;
if (!IS_LOCAL) {
  api.request("/api/meta")
    .then((r) => (r.ok && r.data && typeof r.data.turnstile === "boolean") ? r.data.turnstile : true)
    .catch(() => true)
    .then((v) => {
      turnstileOn = v;
      if (!v) document.querySelectorAll(".auth-turnstile").forEach((el) => { el.style.display = "none"; el.innerHTML = ""; });
    });
}
function noteCaptchaErr(code) {
  if (code === "CAPTCHA_FAILED") {
    turnstileOn = true;
    document.querySelectorAll(".auth-turnstile").forEach((el) => { el.style.display = ""; });
  }
}

/* ─────────────── Turnstile ─────────────── */
let turnstileLoaded = false;
function ensureTurnstile() {
  if (IS_LOCAL || !turnstileOn) return Promise.resolve();
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
  if (!turnstileOn) return "";
  try { return window.turnstile?.getResponse() || ""; } catch { return ""; }
}
function renderTurnstile(containerId) {
  const el = document.getElementById(containerId);
  if (IS_LOCAL || !turnstileOn) { if (el) el.style.display = "none"; return; }
  if (!el) return;
  if (!window.turnstile) { ensureTurnstile().then(() => renderTurnstile(containerId)); return; }   // 脚本未就绪（flag 后到/竞态）时懒加载重入
  el.style.display = "";
  el.innerHTML = "";
  try { window.turnstile.render(el, { sitekey: TURNSTILE_SITEKEY }); } catch {}
}

/* ─────────────── 样式注入（一次性） ─────────────── */
/* 变量对齐 shell/theme.css 设计系统：--acc/--acc-deep/--surface/--surface-2/--line/--txt/--sub/--red */
const AUTH_CSS = `
#nchBody{max-height:min(72vh,640px);overflow-y:auto}
#nchBody .nch-chip-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px;padding:10px;border:1px solid var(--line);border-radius:10px;background:color-mix(in oklab,var(--surface-2) 55%,transparent)}
#nchBody .nch-chip{display:flex;align-items:center;gap:6px;padding:7px 9px;border:1px solid var(--line);border-radius:8px;cursor:pointer;user-select:none;font-size:12.5px;color:var(--txt);transition:border-color .15s,color .15s,background .15s}
#nchBody .nch-chip:hover{border-color:var(--acc)}
#nchBody .nch-chip:has(input:checked){border-color:var(--acc);color:var(--acc);background:color-mix(in oklab,var(--acc) 8%,transparent)}
#nchBody .nch-chip input{accent-color:var(--acc);margin:0;flex:none}
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
/* 卡商介绍行（站长推荐栏绑定条目传入）：同布局，边框带主题色以示推荐身份 */
.auth-profile-intro{border-color:color-mix(in oklab,var(--acc) 35%,var(--line))}
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
/* ── 通知配置（站外通知渠道绑定） ── */
.nch-list{display:flex;flex-direction:column;gap:8px}
.nch-card{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:color-mix(in oklab,var(--surface-2) 55%,transparent)}
.nch-meta{flex:1;min-width:0}
.nch-meta .t{font-size:13px;font-weight:700;color:var(--txt)}
.nch-meta .h{font-size:11.5px;color:var(--sub);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nch-tag{flex:none;font-size:10.5px;font-weight:700;padding:2.5px 7px;border-radius:999px;line-height:1}
.nch-tag.ok{color:#16a34a;background:color-mix(in oklab,#16a34a 14%,transparent)}
.nch-tag.pending{color:#b45309;background:color-mix(in oklab,#b45309 14%,transparent)}
.nch-del{flex:none;padding:5px 9px;border-radius:8px;border:1px solid var(--line);background:var(--surface);color:var(--sub);font-size:12px;cursor:pointer;transition:.15s}
.nch-del:hover{border-color:var(--red);color:var(--red)}
.nch-card.pick{cursor:pointer;transition:border-color .15s}
.nch-card.pick:hover{border-color:var(--acc)}
.nch-card.soon{opacity:.55;cursor:not-allowed}
.nch-soon{flex:none;font-size:10.5px;font-weight:600;color:var(--sub);border:1px solid var(--line);padding:2.5px 7px;border-radius:999px;line-height:1}
.nch-empty{font-size:12px;color:var(--sub);padding:14px;border:1px dashed var(--line);border-radius:10px;text-align:center}
.nch-toggle{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 12px;border:1px solid var(--line);border-radius:10px;background:color-mix(in oklab,var(--surface-2) 55%,transparent);font-size:12.5px;font-weight:600;color:var(--txt)}
.nch-toggle .hint{font-weight:400;margin-top:2px}
.nch-toggle input{width:16px;height:16px;accent-color:var(--acc);flex-shrink:0}
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
  modalEl.addEventListener("click", (e) => {
    /* 锁定模式（账号设置/通知配置等含表单流程的弹窗）：点弹窗外空白不关闭，
       仅通过关闭/取消按钮收场，防误触丢掉正在填写的表单 */
    if (e.target === modalEl && !modalEl.dataset.lock) closeModal();
  });
  document.body.appendChild(modalEl);
  return modalEl;
}
function openModal(html, opts = {}) {
  injectCSS();
  const m = getModal();
  m.querySelector("#authModalBox").innerHTML = html;
  if (opts.lock) m.dataset.lock = "1"; else delete m.dataset.lock;
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

  /** 通知配置（站外通知渠道绑定）：列表 / 添加 / 验证码回填，流程见 renderNch* 系列 */
  openNotifyChannels() {
    injectCSS();
    openModal(`
      <button class="auth-close" data-act="closeAuth" aria-label="关闭">&times;</button>
      <h3>通知配置</h3>
      <div id="nchBody"><p class="hint">加载中…</p></div>
    `, { lock: true });
    getModal().querySelector("#authModalBox").addEventListener("click", onModalClick);
    renderNchList();
  },

  /** 账号设置（改自己） */
  openSettings() { this._openSettingsBase(null); },

  /** 管理员调出指定用户的账号设置进行代改（资料由后台接口拉取，保存走管理员端点） */
  async openSettingsFor(uid) {
    injectCSS();
    settingsTarget = null;
    openModal(`<button class="auth-close" data-act="closeAuth" aria-label="关闭">&times;</button><h3>加载中…</h3>`, { lock: true });
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
      <div class="actions">${target ? "" : `<button class="btn ghost" data-act="authChangeEmail">修改登录邮箱</button>`}<button class="btn primary" data-act="authSettingsSave">保存设置</button></div>
    `, { lock: true });
    const box = getModal().querySelector("#authModalBox");
    box.addEventListener("click", onModalClick);
    box.addEventListener("input", onSettingsInput); // 同一函数引用，重复挂载会被浏览器去重
  },

  /** 他人公开资料卡（点头像弹出）：昵称 / UID / 主动公开的联系方式
      intro 可选：站长推荐栏绑定卡商 chip 传入的「卡商介绍」，显示在资料卡头部下方 */
  async showProfileCard(uid, intro) {
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
      ${(intro || "").trim() ? `<div class="auth-profile-ct auth-profile-intro"><span class="t">介绍</span><span class="v">${esc(intro.trim())}</span></div>` : ""}
      ${p.bio ? `<div class="auth-profile-ct auth-profile-ct-bio"><span class="v">${esc(p.bio)}</span></div>` : ""}
      ${(p.contacts || []).map((c) => `
        <div class="auth-profile-ct"><span class="t">${CT_LABELS[c.type] || "其他"}</span><code>${esc(c.value)}</code>
        <button class="btn ghost" data-act="copyUid" data-val="${esc(c.value)}" style="flex:none;padding:6px 10px;margin-left:auto">复制</button></div>`).join("")
        || `<div class="auth-profile-none">该用户未公开联系方式</div>`}
      ${Auth.isLoggedIn() ? `<div class="auth-profile-actions"><button class="btn primary" data-act="profileChat" data-uid="${esc(p.id)}"><i data-icon="message"></i>在线沟通</button></div>` : ""}`;
    mountIcons(body);
  },

  /** 修改登录邮箱（当前密码 + 新邮箱验证码；生效后「邮件」通知渠道自动解绑，提示重新绑定） */
  openChangeEmail() {
    injectCSS();
    if (!this.isLoggedIn()) return;
    chgState = { k: "", newEmail: "" };
    openModal(`
      <button class="auth-close" data-act="closeAuth" aria-label="关闭">&times;</button>
      <h3>修改登录邮箱</h3>
      <div id="chgBody"></div>
    `, { lock: true });
    getModal().querySelector("#authModalBox").addEventListener("click", onModalClick);
    renderChgStep1();
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
  if (!lp.ok) { noteCaptchaErr(lp.error); toast(authErr(lp.error) || "参数获取失败"); renderTurnstile("authTurnstile"); return; }
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
  noteCaptchaErr(lr.error);
  toast(authErr(lr.error) || "登录失败");
  renderTurnstile("authTurnstile");
}

/* 注册确认视图点「发送验证码」：此时才派生注册密钥并真正发码 */
async function authConfirmSend() {
  const captcha = getTurnstileToken();
  loginState.salt = randomSalt();
  loginState.k = await pbkdf2Base64(loginState.pwd, loginState.salt, DEFAULT_ITER);
  const sc = await api.sendCode(loginState.email, captcha);
  if (!sc.ok) { noteCaptchaErr(sc.error); toast(authErr(sc.error) || "验证码发送失败"); renderTurnstile("authTurnstile"); return; }
  renderLoginBody("code");
  toast("验证码已发送至邮箱，验证通过即完成注册");
}

async function authRegister() {
  const code = (getModal().querySelector("#authCode")?.value || "").trim();
  const captcha = getTurnstileToken();
  if (code.length !== 6) { toast("请输入 6 位验证码"); return; }
  const r = await api.register(loginState.email, loginState.k, loginState.salt, DEFAULT_ITER, code, captcha);
  if (!r.ok) { noteCaptchaErr(r.error); toast(authErr(r.error) || "注册失败"); renderTurnstile("authTurnstile"); return; }
  closeModal();
  toast("注册成功，已自动登录");
  emit("login"); emit("change");
  refreshAll();
}

async function authResend() {
  const captcha = getTurnstileToken();
  const sc = await api.sendCode(loginState.email, captcha);
  toast(sc.ok ? "验证码已重新发送" : (authErr(sc.error) || "发送失败"));
  if (!sc.ok) { noteCaptchaErr(sc.error); renderTurnstile("authTurnstile"); }
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
  if (!r.ok) { noteCaptchaErr(r.error); toast(r.error || "发送失败"); renderTurnstile("authTurnstile"); return; }
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
  if (!lp.ok) { noteCaptchaErr(lp.error); toast(lp.error || "参数获取失败"); renderTurnstile("authTurnstile"); return; }
  const k = await pbkdf2Base64(pwd, lp.data.salt, lp.data.iter);

  const r = await api.resetPassword(resetState.email, k, lp.data.salt, lp.data.iter, code, captcha);
  if (!r.ok) { noteCaptchaErr(r.error); toast(r.error || "修改失败"); renderTurnstile("authTurnstile"); return; }
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
    <button class="auth-drop-item" data-act="authNotify"><i data-icon="bell"></i>通知配置</button>
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

/* ─────────────── 修改登录邮箱（当前密码 + 新邮箱验证码） ─────────────── */
let chgState = { k: "", newEmail: "" };
const CHG_ERR = {
  SAME_EMAIL: "新邮箱与当前邮箱相同",
  EMAIL_EXISTS: "该邮箱已被注册",
  EMAIL_DOMAIN_NOT_ALLOWED: "该邮箱域名不在允许列表",
  CODE_INVALID: "验证码错误或已过期",
  CODE_LOCKED: "尝试次数过多，请稍后再试",
  INVALID_PASSWORD: "当前密码不正确",
  RATE_LIMITED: "操作过于频繁，请稍后再试",
  BANNED: "账号已被封禁，无法修改邮箱",
};

function renderChgStep1() {
  const body = getModal().querySelector("#chgBody");
  if (!body) return;
  const user = Auth.getUser();
  body.innerHTML = `
    <p class="hint" style="margin-top:0">当前邮箱：${esc(user?.email || "-")}</p>
    <div class="fg"><label>当前密码<span class="hint">验证身份，防会话劫持改邮箱</span></label><input class="inp" id="chgPwd" type="password" autocomplete="current-password"></div>
    <div class="fg"><label>新邮箱<span class="hint">需可收信 · 域名需在允许列表 · 不能与他人重复</span></label><input class="inp" id="chgNewEmail" type="email" placeholder="接收验证码的新邮箱"></div>
    <div class="actions">
      <button class="btn ghost" data-act="chgBack">返回账号设置</button>
      <button class="btn primary" data-act="chgSendCode">发送验证码</button>
    </div>
    <p class="hint">生效前需在新邮箱查收 6 位验证码；生效后旧邮箱会收到变更提醒。已绑定的「邮件」通知渠道将自动解绑，可在通知配置中重新绑定。</p>`;
}

function renderChgStep2() {
  const body = getModal().querySelector("#chgBody");
  if (!body) return;
  body.innerHTML = `
    <p class="hint" style="margin-top:0">验证码已发送至 <b>${esc(chgState.newEmail)}</b>，10 分钟内有效。</p>
    <div class="fg"><label>验证码</label><input class="inp" id="chgCode" maxlength="6" inputmode="numeric" placeholder="6 位数字验证码"></div>
    <div class="actions">
      <button class="btn ghost" data-act="chgBackStep1">返回上一步</button>
      <button class="btn primary" data-act="chgConfirm">确认修改</button>
    </div>`;
}

async function chgSendCode() {
  const pwd = getModal().querySelector("#chgPwd")?.value || "";
  const newEmail = (getModal().querySelector("#chgNewEmail")?.value || "").trim().toLowerCase();
  if (!pwd) { toast("请输入当前密码"); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) { toast("请输入有效的新邮箱"); return; }
  const kp = await api.myKdfParams();
  if (!kp.ok) { toast("身份参数获取失败，请重新登录后再试"); return; }
  chgState.k = await pbkdf2Base64(pwd, kp.data.salt, kp.data.iter);
  const r = await api.changeEmailRequest(chgState.k, newEmail);
  if (!r.ok) { toast(CHG_ERR[r.error] || authErr(r.error) || "验证码发送失败"); return; }
  chgState.newEmail = newEmail;
  renderChgStep2();
  toast("验证码已发送，请到新邮箱查收");
}

async function chgConfirm() {
  const code = (getModal().querySelector("#chgCode")?.value || "").trim();
  if (!/^\d{6}$/.test(code)) { toast("请输入 6 位验证码"); return; }
  const r = await api.changeEmailConfirm(chgState.k, chgState.newEmail, code);
  if (!r.ok) { toast(CHG_ERR[r.error] || authErr(r.error) || "修改失败"); return; }
  const u = api.getUser();
  if (u) { u.email = chgState.newEmail; api.setUser(u); }
  closeModal();
  toast(r.data?.channel_unbound ? "登录邮箱已更新；「邮件」通知渠道已自动解绑，可在通知配置中重新绑定" : "登录邮箱已更新");
  emit("change");
}

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
  if (act === "nchAdd") { nchAddState = null; renderNchSelect(); return; }
  if (act === "nchPick") {
    const t = NCH_TYPES.find((x) => x.type === el.dataset.ctype);
    if (!t || !t.ready) { toast("该渠道即将上线，敬请期待"); return; }
    renderNchForm(t.type);
    return;
  }
  if (act === "nchBack") { renderNchList(); return; }
  if (act === "nchSubmit") { authGuarded(el, nchSubmit); return; }
  if (act === "nchVerify") { authGuarded(el, nchVerify); return; }
  if (act === "nchResend") { authGuarded(el, nchResend); return; }
  if (act === "nchDelete") {
    // withPending 调用 fn() 不带实参，ctype 必须在此闭包捕获
    const ctype = el.dataset.ctype || "";
    withPending(el, () => nchDelete(ctype));
    return;
  }
  if (act === "nchBindCode") {
    const ctype = el.dataset.ctype || "";
    authGuarded(el, () => nchBindCode(ctype));
    return;
  }
  if (act === "nchPrefs") { renderNchPrefs(el.dataset.ctype || ""); return; }
  if (act === "nchPrefsSave") {
    const ptype = el.dataset.ctype || "";
    authGuarded(el, () => nchPrefsSave(ptype));
    return;
  }
  if (act === "nchDigest") { renderNchDigest(el.dataset.ctype || ""); return; }
  if (act === "nchDigestGlobal") { renderNchDigestGlobal(); return; }
  if (act === "nchDigestGlobalSave") { authGuarded(el, nchDigestGlobalSave); return; }
  if (act === "nchKindsGlobal") { renderNchKindsGlobal(); return; }
  if (act === "nchKindsGlobalSave") { authGuarded(el, nchKindsGlobalSave); return; }
  if (act === "nchKindsScope") {
    if (nchKindsEditor) nchKindsEditor.mode = el.dataset.scope === "custom" ? "custom" : "follow";
    getModal().querySelectorAll('#nchBody .seg-btn[data-scope]').forEach((b) => {
      b.classList.toggle("active", b.dataset.scope === nchKindsEditor?.mode);
    });
    renderNchKindsScopeBody();
    return;
  }
  if (act === "nchDigestScope") {
    if (nchProvEditor) nchProvEditor.mode = el.dataset.scope === "custom" ? "custom" : "follow";
    getModal().querySelectorAll('#nchBody .seg-btn[data-scope]').forEach((b) => {
      b.classList.toggle("active", b.dataset.scope === nchProvEditor?.mode);
    });
    renderNchDigestScopeBody();
    return;
  }
  if (act === "nchAnnScope") {
    if (nchProvEditor) nchProvEditor.announce = el.dataset.v === "1" ? 1 : el.dataset.v === "0" ? 0 : null;
    getModal().querySelectorAll('#nchBody .seg-btn[data-act="nchAnnScope"]').forEach((b) => {
      const v = b.dataset.v === "1" ? 1 : b.dataset.v === "0" ? 0 : null;
      b.classList.toggle("active", nchProvEditor?.announce === v);
    });
    return;
  }
  if (act === "nchDigestTab") {
    if (!nchProvEditor) return;
    nchProvEditor.active = el.dataset.carrier || "cmcc";
    getModal().querySelectorAll('#nchDigestCarriers .seg-btn').forEach((b) => {
      b.classList.toggle("active", b.dataset.carrier === nchProvEditor.active);
    });
    renderNchDigestGrid();
    return;
  }
  if (act === "nchDigestAll" || act === "nchDigestNone") {
    if (!nchProvEditor) return;
    const codes = PROVINCES.map((p) => p.code);
    nchProvEditor.carriers[nchProvEditor.active] = new Set(act === "nchDigestAll" ? codes : []);
    renderNchDigestGrid();
    return;
  }
  if (act === "nchDigestSave") {
    const dtype = el.dataset.ctype || "";
    authGuarded(el, () => nchDigestSave(dtype));
    return;
  }
  if (act === "authChangeEmail") { Auth.openChangeEmail(); return; }
  if (act === "chgBack") { Auth.openSettings(); return; }
  if (act === "chgBackStep1") { renderChgStep1(); return; }
  if (act === "chgSendCode") { authGuarded(el, chgSendCode); return; }
  if (act === "chgConfirm") { authGuarded(el, chgConfirm); return; }
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
  if (act === "authNotify") { closeDrop(); Auth.openNotifyChannels(); return; }
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

/* ─────────────── 通知配置（站外通知渠道绑定） ───────────────
   渠道清单在此登记（与 Worker 渠道注册表同源扩展，新增渠道加一项即可）；
   凭证仅在绑定流程中经内存直传，列表展示用服务端返回的脱敏 target_hint */
const NCH_TYPES = [
  {
    type: "wecom",
    label: "企业微信机器人",
    desc: "在企业微信群（建议单人群）设置中添加「群机器人」，复制 Webhook 地址粘贴绑定。验证码与后续通知都会发到该群。",
    ready: true,
    fields: [
      { key: "webhook", label: "Webhook 地址", placeholder: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…" },
    ],
  },
  {
    type: "dingtalk",
    label: "钉钉机器人",
    desc: "在钉钉群设置中添加「自定义机器人」（安全设置建议选「加签」），复制 Webhook 地址；如选了加签请一并填入 SEC 开头的密钥。验证码与后续通知都会发到该群。",
    ready: true,
    fields: [
      { key: "webhook", label: "Webhook 地址", placeholder: "https://oapi.dingtalk.com/robot/send?access_token=…" },
      { key: "secret", label: "加签密钥（可选）", placeholder: "SEC 开头，仅安全设置选「加签」时填写" },
    ],
  },
  { type: "feishu", label: "飞书机器人", desc: "群机器人 Webhook + 加签密钥", soon: true },
  { type: "pushplus", label: "PushPlus", desc: "微信推送，填个人 token", soon: true },
  {
    type: "qmsg",
    label: "Qmsg酱",
    desc: "在 Qmsg 平台获取 Key，并在 Qmsg 平台内绑定推送目标（QQ 号/群）。验证码与后续通知经 Qmsg 中转发往 QQ。",
    ready: true,
    fields: [
      { key: "key", label: "Qmsg Key", placeholder: "Qmsg 平台个人中心获取" },
    ],
  },
  {
    type: "qqbot",
    label: "QQ官方机器人",
    desc: "使用你自己在 QQ 开放平台创建的机器人，通知直连官方接口发到群。",
    ready: true,
    steps: [
      "登录 q.qq.com 创建机器人，在「开发设置」拿到 AppID 与 AppSecret",
      "回到本页填入 AppID / AppSecret 提交（本站会即时校验凭证），获得绑定码",
      "再到平台「开发设置 → 回调配置」填入：https://api.ftac.dpdns.org/api/notify/qqbot/callback（⚠️ 必须先完成上一步，否则验证握手会失败；失败时重试一次）",
      "同页「消息URL配置」添加域名：chinamnos.ftac.dpdns.org（不填则所有通知发送失败）",
      "把机器人拉进目标群，群主在群设置开启「机器人主动在群聊内发言」，然后群内 @机器人 发送绑定码",
    ],
    fields: [
      { key: "appid", label: "AppID", placeholder: "QQ 开放平台机器人的数字 AppID" },
      { key: "secret", label: "AppSecret", placeholder: "QQ 开放平台生成的密钥字符串" },
    ],
  },
  { type: "email", label: "邮件", desc: "一键绑定你的注册邮箱。到期提醒、采集播报等批量通知将发送到该邮箱；私信与审核类通知本就会发送到你的邮箱，不受此绑定影响。", ready: true, fields: [] },
];
let nchAddState = null; // 待验证绑定 { type, cred }（重新发送验证码用）
let nchFormType = null; // 当前表单的渠道类型
let nchItems = []; // 最近一次列表数据（渠道选择视图判断"已绑定/待验证"用）
/* 渠道级事件偏好勾选项：全量清单与中文标签的唯一副本在 shell/notify-kinds.js
   （前端 auth.js / admin.js 共用；Worker 侧副本在 common/notifications.ts）。
   用户在全量里勾选，推送时与站点白名单取交集——站长放开/缩减后勾选长期有效 */

function nchTypeLabel(type) {
  const t = NCH_TYPES.find((x) => x.type === type);
  return t ? t.label : type;
}

async function renderNchList() {
  const body = getModal().querySelector("#nchBody");
  if (!body) return;
  const r = await api.notifyChannels();
  if (!r.ok) {
    // 401 单列：最常见原因是本地登录态失效，直接给出可操作提示而非笼统报错
    const msg = r.code === 40100
      ? "登录状态已失效，请退出后重新登录"
      : (typeof r.error === "string" ? r.error : "加载失败，请稍后重试");
    body.innerHTML = `<p class="hint">${esc(msg)}</p>`;
    return;
  }
  const items = Array.isArray(r.data?.items) ? r.data.items : [];
  // 按 NCH_TYPES 固定顺序展示（接口默认按绑定时间倒序，与添加页顺序不一致）
  const typeOrder = new Map(NCH_TYPES.map((t, i) => [t.type, i]));
  items.sort((a, b) => (typeOrder.get(a.channel_type) ?? 99) - (typeOrder.get(b.channel_type) ?? 99));
  nchItems = items;
  // 账号全局播报范围（拉取失败静默降级：摘要显示"未设置"，不影响渠道操作）
  const gr = await api.digestGlobal();
  nchGlobalPref = gr.ok ? (gr.data ?? null) : null; // { provinces, kinds }
  body.innerHTML = `
    <p class="hint" style="margin-top:0">绑定后，站内通知会同步推送到你的渠道；每个渠道还可订阅「采集播报」（关注范围的资费变更摘要），范围可选跟随账号全局或独立配置。</p>
    <div class="nch-list">
      <div class="nch-card pick" data-act="nchDigestGlobal">
        <div class="nch-meta"><div class="t">账号全局播报范围</div><div class="h">一次配置，跟随它的渠道自动生效 · 当前：${esc(nchDigestSummaryText(nchGlobalPref?.provinces))}</div></div>
        <span class="nch-tag ok">配置</span>
      </div>
      <div class="nch-card pick" data-act="nchKindsGlobal">
        <div class="nch-meta"><div class="t">账号全局接收类型</div><div class="h">站点事件类型偏好 · 当前：${esc(nchGlobalPref?.kinds == null ? "全部类型" : `${nchGlobalPref.kinds.length} 类`)}</div></div>
        <span class="nch-tag ok">配置</span>
      </div>
      ${items.length ? items.map(nchCard).join("") : '<div class="nch-empty">还没有绑定任何通知渠道</div>'}
    </div>
    <div class="actions">
      ${items.length < 3 ? '<button class="btn primary" data-act="nchAdd"><i data-icon="plus"></i>添加渠道</button>' : '<p class="hint" style="text-align:center">最多绑定 3 个通知渠道</p>'}
    </div>`;
  mountIcons(body);
}

function nchCard(it) {
  const label = nchTypeLabel(it.channel_type);
  const tag = it.status === "active"
    ? '<span class="nch-tag ok">已生效</span>'
    : '<span class="nch-tag pending">待验证</span>';
  // 渠道级偏好摘要：null = 未配置（跟随站点白名单默认全收）
  const kindSummary = it.status === "active"
    ? `<div class="h">接收：${Array.isArray(it.kinds) ? `${it.kinds.length} / ${NOTIFY_KINDS.length} 类事件` : "全部类型"}</div>`
    : "";
  // 采集播报摘要：collect_report 布尔 + 范围来源（跟随全局 / 独立配置）+ 公告开关状态
  const annTxt = it.announce_push === 1 ? " · 公告开" : it.announce_push === 0 ? " · 公告关" : "";
  const digestSummary = it.status === "active"
    ? `<div class="h">采集播报：${it.collect_report ? (it.digest_mode === "custom" ? `独立 · ${nchDigestSummaryText(it.provinces)}` : "跟随账号全局") : "未开启"}${it.collect_report ? annTxt : ""}</div>`
    : "";
  // 接收类型摘要：kinds_mode（跟随全局 / 独立配置）
  const kindsSummary = it.status === "active"
    ? `<div class="h">接收类型：${it.kinds_mode === "custom" ? `独立 · ${it.kinds ? `${it.kinds.length} 类` : "全部"}` : "跟随账号全局"}</div>`
    : "";
  const prefsBtn = it.status === "active"
    ? '<button class="nch-del" data-act="nchPrefs" data-ctype="' + esc(it.channel_type) + '">接收类型</button>'
    : "";
  const digestBtn = it.status === "active"
    ? '<button class="nch-del" data-act="nchDigest" data-ctype="' + esc(it.channel_type) + '">采集播报</button>'
    : "";
  // QQ 官方机器人：生效实例提供「添加群」入口（取新绑定码在群内消费）
  const bindGroupBtn = it.status === "active" && Array.isArray(it.targets)
    ? '<button class="nch-del" data-act="nchBindCode" data-ctype="' + esc(it.channel_type) + '">添加群</button>'
    : "";
  return `
    <div class="nch-card">
      <div class="nch-meta"><div class="t">${esc(label)}</div><div class="h">${esc(it.target_hint || "")}</div>${kindSummary}${kindsSummary}${digestSummary}</div>
      ${tag}
      <div style="display:flex;flex-direction:column;gap:6px;flex:none">${bindGroupBtn}${prefsBtn}${digestBtn}
      <button class="nch-del" data-act="nchDelete" data-ctype="${esc(it.channel_type)}">解绑</button></div>
    </div>`;
}

/* ── 接收类型（15 类事件偏好，方案追加）：跟随账号全局 / 独立配置 ── */
let nchKindsEditor = null; // { type, mode }

function renderNchPrefs(type) {
  const it = nchItems.find((x) => x.channel_type === type && x.status === "active");
  const body = getModal().querySelector("#nchBody");
  if (!body || !it) return;
  const mode = it.kinds_mode === "custom" ? "custom" : "follow";
  nchKindsEditor = { type, mode };
  body.innerHTML = `
    <p class="hint" style="margin-top:0">${esc(nchTypeLabel(type))} · 勾选该渠道要接收的事件类型。仅在站长放开对应消息类型时生效；全部取消勾选 = 该渠道静音（不解绑）。保存即时生效。</p>
    <p class="hint" style="margin:0 0 6px">事件偏好来源：</p>
    <div class="seg" style="margin-bottom:10px">
      <button type="button" class="seg-btn${mode === "follow" ? " active" : ""}" data-act="nchKindsScope" data-scope="follow">跟随账号全局</button>
      <button type="button" class="seg-btn${mode === "custom" ? " active" : ""}" data-act="nchKindsScope" data-scope="custom">独立配置</button>
    </div>
    <div id="nchKindsScopeBody"></div>
    <div class="actions">
      <button class="btn ghost" data-act="nchBack">返回</button>
      <button class="btn primary" data-act="nchPrefsSave" data-ctype="${esc(type)}">保存偏好</button>
    </div>`;
  mountIcons(body);
  renderNchKindsScopeBody();
}

function renderNchKindsScopeBody() {
  const body = getModal().querySelector("#nchKindsScopeBody");
  if (!body || !nchKindsEditor) return;
  const it = nchItems.find((x) => x.channel_type === nchKindsEditor.type && x.status === "active");
  if (nchKindsEditor.mode === "follow") {
    const gk = nchGlobalPref?.kinds;
    body.innerHTML = `
      <div style="padding:10px 12px;border:1px dashed var(--line);border-radius:10px">
        <div style="font-size:13px">当前全局事件偏好：<b>${esc(gk == null ? "全部类型" : `${gk.length} 类`)}</b></div>
        <div class="hint" style="margin-top:4px">全局偏好变化时本渠道自动跟随。如需单独调整本渠道，切到「独立配置」。</div>
      </div>`;
    return;
  }
  // null = 未配置，展示为全选（即"跟随站点白名单默认全收"）
  const cur = Array.isArray(it?.kinds) ? it.kinds : NOTIFY_KINDS;
  body.innerHTML = `
    <div id="nchKindsBox" class="nch-chip-grid">
      ${Object.entries(NOTIFY_KIND_LABELS).map(([k, label]) => `
      <label class="nch-chip"><input type="checkbox" data-kind="${esc(k)}" ${cur.includes(k) ? "checked" : ""}>${esc(label)}</label>`).join("")}
    </div>`;
}

async function nchPrefsSave(type) {
  if (!type || !nchKindsEditor) return;
  const mode = nchKindsEditor.mode;
  const kinds = mode === "custom"
    ? [...getModal().querySelectorAll('#nchKindsBox input[type="checkbox"]:checked')].map((x) => x.dataset.kind)
    : [];
  const r = await api.notifyChannelPrefs(type, kinds, mode);
  if (!r.ok) { toast(typeof r.error === "string" ? r.error : "保存失败，请稍后再试"); return; }
  toast("接收偏好已保存");
  await renderNchList();
}

/* ── 采集播报订阅（方案批次四）：渠道级开关 + 按运营商分组的省份选择 ── */
const NCH_DIGEST_CARRIER_LABELS = { cmcc: "移动", cucc: "联通", ctcc: "电信", cbn: "广电" };

function nchDigestSummaryText(p) {
  if (p == null) return "全部省份";
  if (Array.isArray(p)) return p.length ? `${p.length} 省（全运营商）` : "全部省份";
  if (typeof p === "object") {
    const parts = Object.entries(p).map(([c, arr]) =>
      `${NCH_DIGEST_CARRIER_LABELS[c] || c}${Array.isArray(arr) ? arr.length : 0}省`);
    return parts.length ? parts.join(" · ") : "暂停";
  }
  return "全部省份";
}

const NCH_DIGEST_CARRIERS = [["cmcc", "移动"], ["cucc", "联通"], ["ctcc", "电信"], ["cbn", "广电"]];
let nchGlobalPref = null; // 账号全局偏好 { provinces, kinds }（null 字段 = 未设置 = 全收）
let nchProvEditor = null; // 省份编辑器状态 { scope: 'channel'|'global', type?, carriers: {cmcc:Set,...}, active }

function nchDigestLoadPref(raw) {
  const allCodes = PROVINCES.map((p) => p.code);
  const carriers = {};
  for (const [c] of NCH_DIGEST_CARRIERS) carriers[c] = new Set(allCodes); // 默认全收
  if (Array.isArray(raw) && raw.length) {
    // 旧格式：全运营商同一份省份清单
    for (const [c] of NCH_DIGEST_CARRIERS) carriers[c] = new Set(raw);
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [c] of NCH_DIGEST_CARRIERS) carriers[c] = new Set(Array.isArray(raw[c]) ? raw[c] : []);
  }
  return carriers;
}

function renderNchDigestGrid() {
  const body = getModal();
  const grid = body.querySelector("#nchDigestGrid");
  if (!grid || !nchProvEditor) return;
  const cur = nchProvEditor.carriers[nchProvEditor.active] || new Set();
  grid.innerHTML = PROVINCES.map((p) => `
    <label class="nch-prov${cur.has(p.code) ? " on" : ""}">
      <input type="checkbox" data-prov="${esc(p.code)}" ${cur.has(p.code) ? "checked" : ""}>${esc(p.name)}
    </label>`).join("");
  /* 勾选写回状态（此前缺失：勾选只停留在 DOM，保存提交的是旧数据、切运营商页签勾选即丢） */
  grid.onchange = (e) => {
    const cb = e.target.closest("input[data-prov]");
    if (!cb || !nchProvEditor) return;
    const key = nchProvEditor.active;
    const set = nchProvEditor.carriers[key] || (nchProvEditor.carriers[key] = new Set());
    if (cb.checked) set.add(cb.dataset.prov); else set.delete(cb.dataset.prov);
    cb.closest(".nch-prov")?.classList.toggle("on", cb.checked);
  };
}

const NCH_PROV_EDITOR_STYLE = `
    <style>
      #nchDigestGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(84px,1fr));gap:6px;padding:10px;border:1px solid var(--line);border-radius:10px;background:color-mix(in oklab,var(--surface-2) 55%,transparent)}
      .nch-prov{display:flex;align-items:center;justify-content:center;gap:5px;padding:7px 4px;border:1px solid var(--line);border-radius:8px;cursor:pointer;user-select:none;font-size:12.5px;color:var(--txt);transition:border-color .15s,color .15s,background .15s}
      .nch-prov:hover{border-color:var(--acc)}
      .nch-prov.on{border-color:var(--acc);color:var(--acc);background:color-mix(in oklab,var(--acc) 8%,transparent)}
      .nch-prov input{accent-color:var(--acc);margin:0}
    </style>`;

function nchProvEditorTabs() {
  return NCH_DIGEST_CARRIERS.map(([c, l]) => `
    <button type="button" class="seg-btn${c === nchProvEditor.active ? " active" : ""}" data-act="nchDigestTab" data-carrier="${c}">${esc(l)}</button>`).join("");
}

/* 渠道级订阅视图：范围来源（跟随账号全局 / 独立配置）+ 开关；独立配置时展示省份编辑器 */
function renderNchDigest(type) {
  const it = nchItems.find((x) => x.channel_type === type && x.status === "active");
  const body = getModal().querySelector("#nchBody");
  if (!body || !it) return;
  const enabled = it.collect_report === true;
  const mode = it.digest_mode === "custom" ? "custom" : "follow";
  // 载入范围：独立配置用渠道自有省份；跟随全局时预载全局范围（切换到独立的起始值）
  nchProvEditor = { scope: "channel", mode, type, announce: it.announce_push === 1 ? 1 : it.announce_push === 0 ? 0 : null, carriers: nchDigestLoadPref(mode === "custom" ? it.provinces : nchGlobalPref?.provinces), active: "cmcc" };
  body.innerHTML = `
    ${NCH_PROV_EDITOR_STYLE}
    <p class="hint" style="margin-top:0">${esc(nchTypeLabel(type))} · 订阅「采集播报」：每轮采集结束后推送关注范围的资费变更摘要（新增 / 修改 / 下架计数，含当日累计）。随采集轮次推送（当前约每 6 小时一轮），仅当关注范围内有变化时才会推送。保存即时生效。</p>
    <label style="display:flex;align-items:center;gap:8px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;margin-bottom:10px;cursor:pointer">
      <input type="checkbox" id="nchDigestEnabled" ${enabled ? "checked" : ""}>
      <span>采集完成后推送播报</span>
    </label>
    <p class="hint" style="margin:0 0 6px">公告新增：</p>
    <div class="seg" style="margin-bottom:10px">
      <button type="button" class="seg-btn${nchProvEditor.announce === null ? " active" : ""}" data-act="nchAnnScope" data-v="follow">跟随账号全局</button>
      <button type="button" class="seg-btn${nchProvEditor.announce === 1 ? " active" : ""}" data-act="nchAnnScope" data-v="1">开启</button>
      <button type="button" class="seg-btn${nchProvEditor.announce === 0 ? " active" : ""}" data-act="nchAnnScope" data-v="0">关闭</button>
    </div>
    <p class="hint" style="margin:0 0 6px">接收范围：</p>
    <div class="seg" style="margin-bottom:10px">
      <button type="button" class="seg-btn${mode === "follow" ? " active" : ""}" data-act="nchDigestScope" data-scope="follow">跟随账号全局</button>
      <button type="button" class="seg-btn${mode === "custom" ? " active" : ""}" data-act="nchDigestScope" data-scope="custom">独立配置</button>
    </div>
    <div id="nchDigestScopeBody"></div>
    <div class="actions">
      <button class="btn ghost" data-act="nchBack">返回</button>
      <button class="btn primary" data-act="nchDigestSave" data-ctype="${esc(type)}">保存</button>
    </div>`;
  mountIcons(body);
  renderNchDigestScopeBody();
}

/* 渠道订阅视图的范围区：跟随 = 只读展示全局摘要；独立 = 运营商页签 + 省份网格 */
function renderNchDigestScopeBody() {
  const body = getModal().querySelector("#nchDigestScopeBody");
  if (!body || !nchProvEditor) return;
  if (nchProvEditor.mode === "follow") {
    body.innerHTML = `
      <div style="padding:10px 12px;border:1px dashed var(--line);border-radius:10px">
        <div style="font-size:13px">当前全局范围：<b>${esc(nchDigestSummaryText(nchGlobalPref?.provinces))}</b></div>
        <div class="hint" style="margin-top:4px">全局范围变化时本渠道自动跟随，无需逐渠道修改。如需单独调整本渠道，切到「独立配置」。</div>
      </div>`;
    return;
  }
  body.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
      <div class="seg" id="nchDigestCarriers" style="flex:none">
        ${nchProvEditorTabs()}
      </div>
      <button class="btn ghost sm" type="button" data-act="nchDigestAll">全选本运营商</button>
      <button class="btn ghost sm" type="button" data-act="nchDigestNone">清空本运营商</button>
    </div>
    <div id="nchDigestGrid"></div>
    <p class="hint" style="margin:8px 2px 0">某运营商内不勾选任何省份 = 不接收该运营商的播报；四家全部清空 = 本渠道暂停接收（开关仍开启）。</p>`;
  renderNchDigestGrid();
}

/* 账号全局播报范围编辑视图（列表页「账号全局播报范围」入口） */
function renderNchDigestGlobal() {
  const body = getModal().querySelector("#nchBody");
  if (!body) return;
  nchProvEditor = { scope: "global", carriers: nchDigestLoadPref(nchGlobalPref?.provinces), active: "cmcc" };
  body.innerHTML = `
    ${NCH_PROV_EDITOR_STYLE}
    <p class="hint" style="margin-top:0">账号全局采集播报范围：一次配置，所有选择「跟随账号全局」的渠道自动生效。按运营商推送关注省份的资费变更摘要（新增 / 修改 / 下架计数，含当日累计）；仅当关注范围内有变化时才会推送（当前约每 6 小时一轮）。保存即时生效。</p>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
      <div class="seg" id="nchDigestCarriers" style="flex:none">
        ${nchProvEditorTabs()}
      </div>
      <button class="btn ghost sm" type="button" data-act="nchDigestAll">全选本运营商</button>
      <button class="btn ghost sm" type="button" data-act="nchDigestNone">清空本运营商</button>
    </div>
    <div id="nchDigestGrid"></div>
    <p class="hint" style="margin:8px 2px 0">某运营商内不勾选任何省份 = 不接收该运营商的播报；全部不勾 = 未设置（各渠道跟随模式下收全部省份）。</p>
    <label style="display:flex;align-items:center;gap:8px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;margin:10px 0 0;cursor:pointer">
      <input type="checkbox" id="nchGlobalAnnounce" ${nchGlobalPref?.announce_push === 1 ? "checked" : ""}>
      <span>公告新增推送<span class="hint">各运营商官网公告有新增时推送（不含正文，附站点链接与分享深链）</span></span>
    </label>
    <div class="actions">
      <button class="btn ghost" data-act="nchBack">返回</button>
      <button class="btn primary" data-act="nchDigestGlobalSave">保存全局范围</button>
    </div>`;
  mountIcons(body);
  renderNchDigestGrid();
}

async function nchDigestGlobalSave() {
  if (!nchProvEditor) return;
  const provinces = {};
  for (const [c] of NCH_DIGEST_CARRIERS) {
    const codes = [...(nchProvEditor.carriers[c] || new Set())];
    if (codes.length) provinces[c] = codes;
  }
  const announce = getModal().querySelector("#nchGlobalAnnounce")?.checked === true ? 1 : 0;
  const r = await api.digestGlobalSave(provinces, null, announce);
  if (!r.ok) { toast(typeof r.error === "string" ? r.error : "保存失败，请稍后再试"); return; }
  nchGlobalPref = r.data ?? null; // { provinces, kinds }
  toast("账号全局播报范围已保存");
  renderNchDigestGlobal();
}

/* 账号全局接收类型编辑弹窗（与播报范围独立） */
function renderNchKindsGlobal() {
  const body = getModal().querySelector("#nchBody");
  if (!body) return;
  const cur = new Set(nchGlobalPref?.kinds ?? NOTIFY_KINDS);
  body.innerHTML = `
    <p class="hint" style="margin-top:0">账号全局接收类型：勾选「跟随账号全局」的渠道要接收的站点事件类型（共 ${NOTIFY_KINDS.length} 类）。全部勾选/不设置 = 全部类型。保存即时生效。</p>
    <div id="nchGlobalKindsBox" class="nch-chip-grid">
      ${Object.entries(NOTIFY_KIND_LABELS).map(([k, label]) => `
      <label class="nch-chip"><input type="checkbox" data-kind="${esc(k)}" ${cur.has(k) ? "checked" : ""}>${esc(label)}</label>`).join("")}
    </div>
    <div class="actions">
      <button class="btn ghost" data-act="nchBack">返回</button>
      <button class="btn primary" data-act="nchKindsGlobalSave">保存全局类型</button>
    </div>`;
  mountIcons(body);
}

async function nchKindsGlobalSave() {
  const kinds = [...getModal().querySelectorAll('#nchGlobalKindsBox input[type="checkbox"]:checked')].map((x) => x.dataset.kind);
  const r = await api.digestGlobalSave(null, kinds);
  if (!r.ok) { toast(typeof r.error === "string" ? r.error : "保存失败，请稍后再试"); return; }
  nchGlobalPref = r.data ?? null;
  toast("账号全局接收类型已保存");
  renderNchKindsGlobal();
}

async function nchDigestSave(type) {
  if (!type || !nchProvEditor) return;
  const enabled = getModal().querySelector("#nchDigestEnabled")?.checked === true;
  const mode = nchProvEditor.mode;
  const provinces = {};
  if (mode === "custom") {
    for (const [c] of NCH_DIGEST_CARRIERS) {
      const codes = [...(nchProvEditor.carriers[c] || new Set())];
      if (codes.length) provinces[c] = codes;
    }
  }
  const r = await api.notifyDigestPrefs(type, { enabled, mode, provinces, announce_push: nchProvEditor.announce });
  if (!r.ok) { toast(typeof r.error === "string" ? r.error : "保存失败，请稍后再试"); return; }
  toast("采集播报偏好已保存");
  await renderNchList();
}

function renderNchSelect() {
  const body = getModal().querySelector("#nchBody");
  if (!body) return;
  // 已生效渠道不可再走绑定（更换需先解绑）；待验证渠道允许重填（顶替原 pending）
  const activeTypes = new Set(nchItems.filter((x) => x.status === "active").map((x) => x.channel_type));
  const pendingTypes = new Set(nchItems.filter((x) => x.status === "pending").map((x) => x.channel_type));
  body.innerHTML = `
    <p class="hint" style="margin-top:0">选择要添加的通知渠道（最多绑定 3 个）：</p>
    <div class="nch-risk" style="border:1px dashed var(--line,#d0d3da);border-radius:8px;padding:8px 10px;margin:0 0 10px;font-size:12px;line-height:1.7;opacity:.85">
      <b>风险说明：</b>绑定后，你的渠道凭证（如 Webhook 地址、加签密钥）将以 AES-GCM 加密存储于站点数据库，仅用于发送绑定验证码和你勾选的站点通知；任何页面与日志仅显示脱敏尾号，不回显完整凭证，也不会提供给任何第三方。如不接受上述存储与使用方式，请勿绑定。
    </div>
    <div class="nch-list">
      ${NCH_TYPES.map((t) => {
        if (!t.ready) return `
        <div class="nch-card soon">
          <div class="nch-meta"><div class="t">${esc(t.label)}</div><div class="h">${esc(t.desc)}</div></div>
          <span class="nch-soon">即将上线</span>
        </div>`;
        if (activeTypes.has(t.type)) return `
        <div class="nch-card soon">
          <div class="nch-meta"><div class="t">${esc(t.label)}</div><div class="h">${esc(t.desc)}</div></div>
          <span class="nch-tag ok">已绑定</span>
        </div>`;
        const pend = pendingTypes.has(t.type);
        return `
        <div class="nch-card pick" data-act="nchPick" data-ctype="${esc(t.type)}">
          <div class="nch-meta"><div class="t">${esc(t.label)}</div><div class="h">${esc(t.desc)}</div></div>
          <span class="nch-tag${pend ? " pending" : " ok"}">${pend ? "待验证 · 点击重填" : "可选"}</span>
        </div>`;
      }).join("")}
    </div>
    <div class="actions"><button class="btn ghost" data-act="nchBack">返回</button></div>`;
  mountIcons(body);
}

function renderNchForm(type) {
  const t = NCH_TYPES.find((x) => x.type === type);
  const body = getModal().querySelector("#nchBody");
  if (!body || !t || !t.fields) return;
  nchFormType = type;
  const btnText = t.fields.length ? "发送验证码" : "一键绑定"; // 无字段渠道（邮件）：绑定即生效
  body.innerHTML = `
    <p class="hint" style="margin-top:0">${esc(t.desc)}</p>
    ${Array.isArray(t.steps) && t.steps.length ? `
    <div style="border:1px dashed var(--line,#d0d3da);border-radius:8px;padding:10px 12px;margin:0 0 10px">
      <div style="font-size:13px;font-weight:700;margin-bottom:6px">绑定步骤（第 2/3 步在你的机器人后台完成，缺一不可）：</div>
      <ol class="hint" style="margin:0;padding-left:18px;line-height:1.8">${t.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
    </div>` : ""}
    ${t.fields.map((f) => `
    <div class="fg">
      <label>${esc(f.label)}</label>
      <input class="inp" data-nchf="${esc(f.key)}" placeholder="${esc(f.placeholder || "")}">
    </div>`).join("")}
    <div class="actions">
      <p class="hint" style="margin:0 0 8px">凭证将加密存储、仅用于本站通知发送；不接受请勿绑定。</p>
      <button class="btn ghost" data-act="nchAdd">返回</button>
      <button class="btn primary" data-act="nchSubmit">${btnText}</button>
    </div>`;
  mountIcons(body);
}

function renderNchVerify() {
  const body = getModal().querySelector("#nchBody");
  if (!body) return;
  body.innerHTML = `
    <p class="hint" style="margin-top:0">验证码已发送到你绑定的通知渠道，请在对应 App（企业微信 / 钉钉 / QQ）中查看（10 分钟内有效）。</p>
    <div class="fg">
      <label>6 位验证码</label>
      <input class="inp" id="nchCode" type="text" inputmode="numeric" maxlength="6" placeholder="群里收到的 6 位数字">
    </div>
    <div class="actions">
      <button class="btn ghost" data-act="nchResend">重新发送</button>
      <button class="btn primary" data-act="nchVerify">确认绑定</button>
    </div>`;
  mountIcons(body);
}

async function nchSubmit() {
  const t = NCH_TYPES.find((x) => x.type === nchFormType);
  if (!t) return;
  // 按字段清单收集非空值；必填缺失由服务端校验兜底（返回中文原因直接 toast）
  const cred = {};
  for (const inp of getModal().querySelectorAll("[data-nchf]")) {
    const v = (inp.value || "").trim();
    if (v) cred[inp.dataset.nchf] = v;
  }
  const r = await api.notifyChannelCreate(t.type, cred);
  if (!r.ok) { toast(typeof r.error === "string" ? r.error : "发送失败，请稍后再试"); return; }
  // 无字段渠道（邮件）绑定即生效：跳过验证码视图直接回列表
  if (r.data?.activated) {
    nchAddState = null;
    toast("邮件渠道已绑定");
    await renderNchList();
    return;
  }
  // QQ 官方机器人：绑定码不外发，直接展示由用户在群内 @机器人 消费
  if (r.data?.bind_code) {
    nchAddState = null;
    renderNchBindCode(r.data.bind_code);
    return;
  }
  nchAddState = { type: t.type, cred };
  renderNchVerify();
}

/* QQ 官方机器人绑定码视图：展示 6 位码 + 群内 @机器人 发码指引（消费后回调自动激活/追加群） */
function renderNchBindCode(code) {
  const body = getModal().querySelector("#nchBody");
  if (!body) return;
  body.innerHTML = `
    <p class="hint" style="margin-top:0">实例已登记。把机器人拉进目标群，然后在群内 <b>@机器人</b> 发送下面的绑定码（机器人会回复确认）：</p>
    <div style="display:flex;justify-content:center;padding:14px 0"><span style="font-size:32px;font-weight:800;letter-spacing:10px;font-family:ui-monospace,monospace">${esc(code)}</span></div>
    <p class="hint" style="margin:0 0 6px">· 绑定码 24 小时内有效，发送成功立即消费（一个码绑一个群）；<br>· 同一机器人可绑多个群：生效后回渠道列表点「添加群」再取新码；<br>· 需群主在群设置开启「机器人主动在群聊内发言」，否则主动通知发送失败；<br>· 消息含站点网址：需在 q.qq.com 后台「开发设置 → 消息URL配置」登记 chinamnos.ftac.dpdns.org。</p>
    <div class="actions"><button class="btn primary" data-act="nchBack">完成</button></div>`;
  mountIcons(body);
}

/* 「添加群」：为已生效 QQ 机器人实例取新绑定码 */
async function nchBindCode(ctype) {
  if (!ctype) return;
  const r = await api.notifyChannelBindCode(ctype);
  if (!r.ok) { toast(typeof r.error === "string" ? r.error : "获取失败，请稍后再试"); return; }
  if (r.data?.bind_code) renderNchBindCode(r.data.bind_code);
}

async function nchVerify() {
  const inp = getModal().querySelector("#nchCode");
  const code = (inp?.value || "").trim();
  if (!/^\d{6}$/.test(code)) { toast("请输入 6 位数字验证码"); return; }
  const r = await api.notifyChannelVerify(code);
  if (!r.ok) { toast(typeof r.error === "string" ? r.error : "验证失败，请稍后再试"); return; }
  nchAddState = null;
  toast("通知渠道绑定成功");
  await renderNchList();
}

async function nchResend() {
  if (!nchAddState) { renderNchSelect(); return; }
  const r = await api.notifyChannelCreate(nchAddState.type, nchAddState.cred);
  if (!r.ok) { toast(typeof r.error === "string" ? r.error : "发送失败，请稍后再试"); return; }
  toast("验证码已重新发送");
}

async function nchDelete(ctype) {
  if (!ctype) return;
  const r = await api.notifyChannelDelete(ctype);
  if (!r.ok) { toast(typeof r.error === "string" ? r.error : "解绑失败，请稍后再试"); return; }
  toast("已解绑");
  await renderNchList();
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

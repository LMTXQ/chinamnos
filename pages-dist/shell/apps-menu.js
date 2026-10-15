/* ═══════════════════════════════════════════════════════════════
   顶栏【功能】下拉菜单 · 全站唯一数据源（收敛重构 2026-09-29）
   ───────────────────────────────────────────────────────────────
   ▸ 此前六个站各自复制整套菜单 HTML + click handler（新增站/入口
     要同步改 N 个文件），现收敛为本组件：站点清单一处定义，各站
     骨架只留挂载点，onEnter 调 mountAppsMenu(slot, currentId)。
   ▸ 统一规则：排除当前站自己 / staffOnly 管理组可见 / module 开关
     关闭时入口自动隐藏（/api/meta 探测，5min 边缘缓存）。
   ▸ 样式复用 theme.css 的 .apps-menu 系列，无新样式。
   ═══════════════════════════════════════════════════════════════ */
"use strict";

import { Shell } from "./shell.js";
import { icon, mountIcons } from "./ui.js";
import { Auth } from "./auth.js";
import { api } from "./api.js";

/** 站点清单（唯一数据源）：module=依赖的模块开关；staffOnly=仅管理组（站长/管理员）可见 */
const APP_SITES = [
  { id: "tariff", label: "资费监测", icon: "chart", route: "/" },
  { id: "cardhub", label: "跳蚤市集", icon: "box", route: "/cardhub", module: "cardhub", badge: "新" },
  { id: "ticket", label: "工单中心", icon: "list", route: "/ticket" },
  { id: "tools", label: "工具宝库", icon: "link", route: "/tools" },
  { id: "admin", label: "管理后台", icon: "shield", route: "/admin", staffOnly: true },
];

let outsideBound = false;
let authBound = false;

/**
 * 在 slotEl 挂载功能菜单。各站骨架放 <div id="xxAppsMenuSlot"></div>，
 * onEnter 调用 mountAppsMenu($("xxAppsMenuSlot"), "本站 id")。
 * 菜单事件完全组件自治（开合/跳转/外点收起），各站 onRootClick 无需处理。
 */
export function mountAppsMenu(slotEl, currentId) {
  if (!slotEl) return;
  slotEl.dataset.appsMenu = currentId;
  const items = APP_SITES.filter((s) =>
    s.id !== currentId && (!s.staffOnly || Auth.isAdmin()),
  );
  if (!items.length) { slotEl.remove(); return; }

  slotEl.classList.add("apps-menu");
  slotEl.innerHTML = `
    <button type="button" class="btn ghost magnetic" data-am-toggle aria-haspopup="true" aria-expanded="false" title="功能菜单"><i data-icon="layers"></i><span class="apps-label">功能</span><i data-icon="chevronDown" class="apps-caret"></i></button>
    <div class="apps-dropdown">
      ${items.map((s) => `
        <button type="button" class="nav-item" data-am-route="${s.route}"><div class="nav-icon"><i data-icon="${s.icon}"></i></div><span>${s.label}</span>${s.badge ? `<span class="apps-badge">${s.badge}</span>` : ""}</button>`).join("")}
      <div class="apps-coming">更多功能规划中…</div>
    </div>`;
  mountIcons(slotEl);

  const toggle = slotEl.querySelector("[data-am-toggle]");
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = slotEl.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(open));
  });

  slotEl.querySelectorAll("[data-am-route]").forEach((b) => {
    b.addEventListener("click", () => {
      slotEl.classList.remove("open");
      Shell.navigate(b.dataset.amRoute);
    });
  });

  // 外点收起：全局只注册一次，对所有已挂载菜单生效
  if (!outsideBound) {
    outsideBound = true;
    document.addEventListener("click", (e) => {
      document.querySelectorAll(".apps-menu.open").forEach((m) => {
        if (!m.contains(e.target)) {
          m.classList.remove("open");
          m.querySelector("[data-am-toggle]")?.setAttribute("aria-expanded", "false");
        }
      });
    });
  }

  // 登录态变化（登录/退出）时重挂所有菜单，即时反映管理后台入口显隐（全局只订阅一次）
  if (!authBound) {
    authBound = true;
    Auth.on("change", () => {
      document.querySelectorAll("[data-apps-menu]").forEach((el) => {
        if (document.body.contains(el)) mountAppsMenu(el, el.dataset.appsMenu);
      });
    });
  }

  // 模块开关联动：依赖的模块被 owner 关闭时移除入口（meta 5min 边缘缓存）
  const gated = items.find((s) => s.module);
  if (gated && api.fetchMeta) {
    Promise.resolve(api.fetchMeta()).then((m) => {
      if (m && m[gated.module] === false) {
        slotEl.querySelector(`[data-am-route="${gated.route}"]`)?.remove();
      }
    }).catch(() => { /* 探测失败保持入口，后端另有 503 兜底 */ });
  }
}

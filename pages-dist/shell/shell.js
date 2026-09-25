/* ═══════════════════════════════════════════════════════════════
   ChinaMNOs Shell v2 — ES Module 微内核路由
   ───────────────────────────────────────────────────────────────
   架构说明（如何扩展）：

   ▸ 新增完整独立页面（类 config 式）：
     1. frontend-config.js 的 modules 数组追加：
        { "id": "xxx", "src": "modules/xxx/xxx.js", "route": "/xxx" }
     2. 页面模块内调用 Shell.registerPage({
          id, route,
          onEnter(root) { /* 注入样式 + 渲染整页 *\/ },
          onExit(root)  { /* 清理状态 *\/ },
        })
     3. 任意位置 Shell.navigate('/xxx') 或 <a href="#/xxx"> 完成跳转，
        切换自动包裹 View Transition。

   ▸ 页面内部小板块（类 tab 页签式）：
     import { Tabs } from "./ui.js";
     const tabs = new Tabs(navEl, (id) => switchPanel(id));
     tabs.add("tabId", { label, icon, before: "anchorTabId" });
     tabs.activate("tabId");

   ▸ 数据访问路径（务必保持不变）：
     ./data/stats.json
     ./data/{carrier}/snapshots/snapshot_{code}.json
     ./data/{carrier}/changelogs/changelog_{code}.json
     ./data/{carrier}/_diag.json
   ═══════════════════════════════════════════════════════════════ */
"use strict";

import "./ui.js";

/* ─────────────── 共享工具 ─────────────── */
export const esc = (s) =>
  String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

export const FETCH_TIMEOUT = 20000;

export function fetchTimeout(url, init) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  return fetch(url, Object.assign({}, init || {}, { signal: ctrl.signal }))
    .catch((e) => {
      if (e && e.name === "AbortError") throw new Error("加载超时");
      throw e;
    })
    .finally(() => clearTimeout(t));
}

/* ─────────────── 主题服务 ─────────────── */
export const THEME_KEY = "chinamnos_v2_theme";

export const theme = {
  get() {
    try {
      return localStorage.getItem(THEME_KEY) || "light";
    } catch {
      return "light";
    }
  },
  apply(t) {
    if (t === "dark") document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
  },
  toggle() {
    const next = this.get() === "dark" ? "light" : "dark";
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {}
    this.apply(next);
    return next;
  },
  init() {
    this.apply(this.get());
  },
};

/* ─────────────── 页面注册表 ─────────────── */
const pages = new Map();
let active = null;

export const Shell = {
  config: null,
  registerPage(page) {
    pages.set(page.id, page);
  },
  navigate(hash) {
    location.hash = hash;
  },
};

/* 兼容旧式经典脚本模块的全局入口 */
window.Shell = Shell;

/* ─────────────── 启动 ─────────────── */
const rawConfig = window.__FRONTEND_CONFIG__;
const urlBase = new URLSearchParams(location.search).get("frontend_base");
const BASE = ((urlBase || (rawConfig && rawConfig.base) || "./") + "").replace(/\/?$/, "/");
Shell.config = Object.assign({}, rawConfig, { base: BASE });

function fatal(msg) {
  const boot = document.getElementById("boot");
  if (boot) boot.remove();
  document.body.insertAdjacentHTML(
    "beforeend",
    '<div style="padding:48px 20px;text-align:center;color:var(--red);font-size:15px">' +
      msg +
      "</div>"
  );
}

function hideBoot() {
  const boot = document.getElementById("boot");
  if (boot) {
    boot.classList.add("hide");
    setTimeout(() => boot.remove(), 450);
  }
}

/** 页面切换（包裹 View Transition，降级为直接切换） */
async function activate(page) {
  const run = () => {
    if (active && active.onExit) active.onExit(document.body);
    active = page;
    window.scrollTo(0, 0);
    page.onEnter(document.body);
  };
  const canVT =
    document.startViewTransition &&
    !matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (canVT) {
    try {
      await document.startViewTransition(run).updateCallbackDone;
    } catch {
      run();
    }
  } else {
    run();
  }
  hideBoot();
}

function routeOf(hash) {
  const h = hash.replace(/^#/, "") || "/";
  for (const p of pages.values()) if (p.route === h) return p;
  return null;
}

let routing = false;
async function route() {
  if (routing) return;
  routing = true;
  try {
    let page = routeOf(location.hash);
    if (!page) {
      page =
        [...pages.values()].find((p) => p.route === "/") ||
        pages.values().next().value ||
        null;
    }
    if (page) await activate(page);
    else fatal("系统加载失败：未找到任何可用页面模块");
  } finally {
    routing = false;
  }
}

(async function boot() {
  if (!rawConfig) {
    fatal("系统加载失败：未找到 frontend-config.js 配置");
    return;
  }
  theme.init();

  const modules = rawConfig.modules || [];
  try {
    await Promise.all(
      modules.map((m) =>
        import(/* webpackIgnore: true */ new URL(BASE + m.src, document.baseURI).href)
      )
    );
  } catch (e) {
    fatal("模块加载失败：" + esc((e && e.message) || e));
    return;
  }

  window.addEventListener("hashchange", route);
  await route();
})();

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
import { maybeSiteNotice, maybePromos, maybePromosOnModuleEnter } from "./notice.js";

/* ─────────────── 共享工具 ─────────────── */
export const esc = (s) =>
  String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

export const FETCH_TIMEOUT = 20000;

/* ── 模块样式表加载（防 FOUC）──
   首次进入页面时若先渲染 DOM 再等 <link> 加载，会有一瞬间「所有控件挤在一起」的
   无样式闪动。各模块 onEnter 改为 await ensureStylesheet(...) 后再渲染。
   同一 href 只注入一次并复用加载 Promise；加载失败不阻塞页面（降级无样式）。 */
const _stylePromises = new Map();
export function ensureStylesheet(href) {
  let p = _stylePromises.get(href);
  if (!p) {
    p = new Promise((resolve) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.onload = () => resolve();
      link.onerror = () => resolve();
      document.head.appendChild(link);
    });
    _stylePromises.set(href, p);
  }
  return p;
}

export function fetchTimeout(url, init) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  return fetch(url, Object.assign({}, init || {}, { signal: ctrl.signal }))
    .catch((e) => {
      if (e && e.name === "AbortError") {
        /* 数据超时汇报给线路容灾守卫（index.html 内联脚本）：仅相对路径 data 请求会走到这里，
           API 请求走 shell/api.js 原生 fetch 不经此路径，天然满足「API 失败不跳线」 */
        try { window.__CMNOS_ROUTE__ && window.__CMNOS_ROUTE__.onDataTimeout(); } catch {}
        throw new Error("加载超时");
      }
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
/* 条目级深链前缀 → 归属页面路由：post_ 跳蚤市集帖；act_/chat_/ann_/cl_/plan_ 资费页各 tab 条目。
   hash 原样透传，目标页面 onEnter 解析打开；未匹配前缀仍走「回退首页」老逻辑 */
const DEEP_LINK_ROUTES = [
  [/^post_/, "/cardhub"],
  [/^(act|chat|ann|cl|plan)_/, "/"],
];
/* 页面级标题（id → 显示名）：activate 进入页面即切，模块可在 onEnter 内覆盖更具体的标题
   （如资费页带运营商名「XX资费监控」）；名称与 apps-menu.js APP_SITES 保持同源一致 */
const PAGE_TITLES = {
  tariff: "资费监测",
  cardhub: "跳蚤市集",
  ticket: "工单中心",
  tools: "工具宝库",
  admin: "管理后台",
  config: "管理中心",
};
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

/** 极光背景色斑（视觉层见 theme.css .aurora-blob）：
    幂等注入 4 个固定色斑，动画只走 transform，合成器零重绘。
    挂在 <html> 而非 <body>：页面模块 onEnter 会整页重写 body.innerHTML，
    挂在 html 下可免于被清空；fixed 定位与 z-index 行为不受影响 */
function initAurora() {
  if (document.querySelector(".aurora-blob")) return;
  const frag = document.createDocumentFragment();
  for (const c of ["b1", "b2", "b3", "b4"]) {
    const d = document.createElement("div");
    d.className = "aurora-blob " + c;
    d.setAttribute("aria-hidden", "true");
    frag.appendChild(d);
  }
  document.documentElement.appendChild(frag);
}

/** 页面切换（包裹 View Transition，降级为直接切换） */
async function activate(page) {
  /* 标题随页面切换（onEnter 之前设置：模块专属标题可再覆盖） */
  document.title = PAGE_TITLES[page.id]
    ? PAGE_TITLES[page.id] + " — ChinaMNOs"
    : "ChinaMNOs 讯览台";
  const run = () => {
    /* 记录来源页：供管理后台等页面的「返回」按钮回到进入前的功能区 */
    Shell.prevPage = active;
    if (active && active.onExit) active.onExit(document.body);
    active = page;
    window.scrollTo(0, 0);
    page.onEnter(document.body);
    /* 全站公告：页面就绪后检查（异步不阻塞渲染；内部有每日/勾选判定与串行队列） */
    maybeSiteNotice();
    /* 推广弹窗：串行队列中排在公告之后（先公告后推广），按范围过滤逐条弹。
       全站条目（scope.modules 空）在页面切换时判定；模块条目仅在其目标模块进入时判定 */
    maybePromos();
    maybePromosOnModuleEnter(page.id);
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
  /* 首个路由渲染完成 = 应用就绪：容灾守卫据此停止跳线计时（index.html 内联脚本轮询此标志） */
  window.__APP_READY = true;
}

function routeOf(hash) {
  const h = hash.replace(/^#/, "") || "/";
  for (const p of pages.values()) if (p.route === h) return p;
  /* 条目级深链（裸 hash 前缀，未注册为页面）：路由到归属页面，hash 原样保留，
     由页面 onEnter 自行解析并打开对应内容（资费页已有 pendingTab/数据就绪补载机制） */
  for (const [re, route] of DEEP_LINK_ROUTES) {
    if (re.test(h)) return [...pages.values()].find((p) => p.route === route) || null;
  }
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
  initAurora();
  /* 启动屏阶段文案：boot-sub 随加载进程更新（hideBoot 移除节点前一直可写） */
  const bootSub = document.getElementById("bootSub");

  const modules = rawConfig.modules || [];
  try {
    if (bootSub) bootSub.textContent = "装载功能模块…";
    await Promise.all(
      modules.map((m) =>
        import(/* webpackIgnore: true */ new URL(BASE + m.src, document.baseURI).href)
      )
    );
    if (bootSub) bootSub.textContent = "渲染页面…";
  } catch (e) {
    fatal("模块加载失败：" + esc((e && e.message) || e));
    return;
  }

  window.addEventListener("hashchange", route);
  await route();
})();

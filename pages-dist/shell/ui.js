/* ═══════════════════════════════════════════════════════════════
   ChinaMNOs UI Components (shell/ui.js)
   - SVG 图标系统：icon(name) 返回内联 SVG，模板中用 <i data-icon="name"> + mountIcons()
   - <num-ticker>：数字滚动动画自定义元素
   - Tabs：通用页签控制器（页面内部小板块的扩展基建）
   ═══════════════════════════════════════════════════════════════ */
"use strict";

/* ─────────────── SVG 图标系统（24×24, stroke 风格） ─────────────── */
const ICONS = {
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  chart: '<path d="M4 20h16M7 16v-5M12 16V7M17 16v-8"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  home: '<path d="M3 10.5L12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-6h6v6"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  radar: '<path d="M19.07 4.93A10 10 0 1 1 4.93 4.93"/><path d="M16.24 7.76a6 6 0 1 1-8.48 0"/><circle cx="12" cy="12" r="1.6"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  refresh: '<path d="M21 3v6h-6"/><path d="M21 9a9 9 0 1 0 2.4 6"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>',
  box: '<path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  zap: '<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
  filter: '<path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/>',
  code: '<path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  repeat: '<path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  map: '<path d="M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4z"/><path d="M8 2v16M16 6v16"/>',
  tagIcon: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><path d="M7 7h.01"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  terminal: '<path d="M4 17l6-6-6-6M12 19h8"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>',
  package: '<path d="M16.5 9.4L7.5 4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12"/>',
  trendingUp: '<path d="M23 6l-9.5 9.5-5-5L1 18"/><path d="M17 6h6v6"/>',
  trendingDown: '<path d="M23 18l-9.5-9.5-5 5L1 6"/><path d="M17 18h6v-6"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
  key: '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',

  /* ── 第三轮扩充（参考项目打磨） ── */
  star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14l-5-4.87 6.91-1.01L12 2z"/>',
  starFill: '<path fill="currentColor" stroke="none" d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14l-5-4.87 6.91-1.01L12 2z"/>',
  trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2z"/>',
  barChart: '<path d="M5 4h14M5 10h10M5 16h7M5 22h4"/>' ,
  pieChart: '<path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
  plusCircle: '<circle cx="12" cy="12" r="10"/><path d="M12 8v8M8 12h8"/>',
  minusCircle: '<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/>',
  chevronsDown: '<path d="M7 6l5 5 5-5M7 13l5 5 5-5"/>',
  chevronsUp: '<path d="M7 13l5-5 5 5M7 20l5-5 5 5"/>',
  percent: '<path d="M19 5L5 19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
  coins: '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="M16.71 13.88l.7.71-2.82 2.82"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/>',
  wifi: '<path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><path d="M12 20h.01"/>',
  sparkles: '<path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3z"/><path d="M5 3v4M3 5h4M19 17v4M17 19h4"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  arrowRight: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  alertCircle: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  alertTriangle: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  layers: '<path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>',
  keyboard: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 12h.01M6 12h.01M10 12h.01M14 12h.01M18 8h.01M8 16h8"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  send: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><path d="M7 7h.01"/><rect x="14" y="3" width="7" height="7" rx="1"/><path d="M17 7h.01"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M7 17h.01"/><path d="M14 14h1.5v1.5H14zM17.5 14H21M14 17.5v1.5M17.5 17.5h1.5v1.5h-1.5zM20 17.5v3.5M14 21h1.5"/>',
};

export function icon(name, cls = "") {
  const body = ICONS[name] || ICONS.info;
  /* width/height 固有尺寸：CSS 未约束的容器中 svg 不再按默认 object size 爆为 300×150；
     各处 CSS 约束（如 .icon-btn svg{width:15px}）仍优先于属性，不受影响 */
  return (
    '<svg class="' + cls + '" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    body + "</svg>"
  );
}

/** 模板挂载后调用：将 <i data-icon="name"></i> 占位替换为 SVG */
export function mountIcons(root) {
  (root || document).querySelectorAll("i[data-icon]").forEach((el) => {
    el.outerHTML = icon(el.dataset.icon, el.className || "");
  });
}

/* ─────────────── Toast 轻提示 ─────────────── */
let toastEl = null;
let toastTimer = 0;
/* 类型 → 图标/颜色：success 绿 / error 红 / warning 琥珀 / info 蓝。
   未传 type 时按文案关键词自动分级——历史调用点 100+ 处不逐一标注，本站文案措辞
   高度规范化（"失败/异常"=错误、"请/需/不能"=提醒），判定错的代价仅是配色差异 */
const TOAST_TYPES = {
  success: { ic: "check", color: "#22c55e" },
  error: { ic: "alertCircle", color: "var(--red)" },
  warning: { ic: "alertTriangle", color: "var(--amber)" },
  info: { ic: "info", color: "var(--acc)" },
};
const TOAST_ERR_RE = /(失败|异常|错误|不支持|不存在)/;
const TOAST_WARN_RE = /(请|需|须|不能|不匹配|不一致|超过|太频繁|未填写|未就绪|已达上限)/;
export function toast(msg, type) {
  const conf = TOAST_TYPES[type] ||
    (TOAST_ERR_RE.test(String(msg == null ? "" : msg)) ? TOAST_TYPES.error :
      TOAST_WARN_RE.test(String(msg == null ? "" : msg)) ? TOAST_TYPES.warning : TOAST_TYPES.success);
  /* 路由切换会重写 body.innerHTML，缓存节点可能已游离文档外，需重建 */
  if (!toastEl || !document.body.contains(toastEl)) {
    toastEl = document.createElement("div");
    toastEl.id = "uiToast";
    toastEl.style.cssText = "position:fixed;left:50%;top:24px;transform:translateX(-50%) translateY(-20px);background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:10px 18px;box-shadow:0 8px 24px rgba(0,0,0,.18);z-index:99999;display:flex;align-items:center;gap:8px;font-size:13px;opacity:0;transition:.2s;pointer-events:none;max-width:80vw;word-break:break-all";
    document.body.appendChild(toastEl);
  }
  toastEl.innerHTML = icon(conf.ic) + "<span>" + String(msg == null ? "" : msg).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])) + "</span>";
  toastEl.style.borderLeft = "3px solid " + conf.color;
  mountIcons(toastEl);
  const tsvg = toastEl.querySelector("svg");
  if (tsvg) { tsvg.style.width = "16px"; tsvg.style.height = "16px"; tsvg.style.flexShrink = "0"; tsvg.style.color = conf.color; }
  toastEl.style.opacity = "1";
  toastEl.style.transform = "translateX(-50%) translateY(0)";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.style.opacity = "0"; toastEl.style.transform = "translateX(-50%) translateY(-20px)"; }, 2400);
}

/* ─────────────── <num-ticker> 数字滚动动画 ─────────────── */
class NumTicker extends HTMLElement {
  static get observedAttributes() {
    return ["value"];
  }
  constructor() {
    super();
    this._current = 0;
    this._raf = 0;
  }
  attributeChangedCallback(_n, _o, v) {
    this.value = Number(v);
  }
  set value(v) {
    if (typeof v !== "number" || !isFinite(v)) {
      cancelAnimationFrame(this._raf);
      this.textContent = v == null ? "-" : String(v);
      this._current = 0;
      return;
    }
    cancelAnimationFrame(this._raf);
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const from = this._current;
    const to = Math.round(v);
    if (from === to || reduced || Math.abs(to - from) > 500000) {
      this._current = to;
      this.textContent = to.toLocaleString("zh-CN");
      return;
    }
    const t0 = performance.now();
    const dur = 750;
    const step = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3); // easeOutCubic
      this.textContent = Math.round(from + (to - from) * e).toLocaleString("zh-CN");
      if (p < 1) this._raf = requestAnimationFrame(step);
      else this._current = to;
    };
    this._raf = requestAnimationFrame(step);
  }
  get value() {
    return this._current;
  }
  disconnectedCallback() {
    cancelAnimationFrame(this._raf);
  }
}

if (!customElements.get("num-ticker")) {
  customElements.define("num-ticker", NumTicker);
}

/* ─────────────── Tabs 页签控制器 ───────────────
   页面内部小板块的通用基建：管理一组 .nav-item[data-view] 按钮，
   滑动指示器 + 激活态，切换时回调 onChange(id)。
   支持运行时 add() 动态插入新页签（如 tariff 的动态分类 tab）。

   const tabs = new Tabs(navEl, (id) => { ... });
   tabs.add("tabId", { label: "页签名", icon: "chart", before: "anchorId" });
   tabs.activate("tabId");
*/
/* 按钮 pending 态：禁点 + .is-pending 样式（theme.css 转圈）+ 防重复点击，fn 结束自动恢复。
   用法：await withPending(actEl, () => doAsyncThing())；btn 传 null 则只执行不加视觉（如回车提交路径） */
export async function withPending(btn, fn) {
  if (btn && btn.dataset.pending === "1") return null;
  if (btn) {
    btn.dataset.pending = "1";
    btn.classList.add("is-pending");
    if (btn.tagName === "BUTTON") btn.disabled = true;
  }
  try {
    return await fn();
  } finally {
    if (btn) {
      delete btn.dataset.pending;
      btn.classList.remove("is-pending");
      if (btn.tagName === "BUTTON") btn.disabled = false;
    }
  }
}

export class Tabs {
  constructor(nav, onChange) {
    this.nav = nav;
    this.onChange = onChange;
    this.indicator = document.createElement("div");
    this.indicator.className = "nav-indicator";
    nav.appendChild(this.indicator);
    nav.classList.add("app-nav");
    nav.addEventListener("click", (e) => {
      const btn = e.target.closest(".nav-item[data-view]");
      if (!btn || !nav.contains(btn)) return;
      this.activate(btn.dataset.view);
    });
    // resize 监听持有具名引用，destroy() 时解绑；_moveIndicator 内部自带 rAF 节流
    this._onResize = () => this._moveIndicator();
    window.addEventListener("resize", this._onResize);
    this._raf = 0;
  }

  /** 页面卸载时调用：解绑全局 resize 监听并移除指示器，防止跨页面泄漏 */
  destroy() {
    window.removeEventListener("resize", this._onResize);
    this.indicator.remove();
  }

  /** 动态添加页签；before: 插入到该 data-view 之前 */
  add(id, { label, icon: iconName, iconHtml, before } = {}) {
    if (this.nav.querySelector('.nav-item[data-view="' + id + '"]')) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "nav-item";
    btn.dataset.view = id;
    const ico =
      iconHtml !== undefined
        ? iconHtml
        : '<div class="nav-icon">' + icon(iconName || "box") + "</div>";
    btn.innerHTML = ico + "<span>" + label + "</span>";
    const anchor = before
      ? this.nav.querySelector('.nav-item[data-view="' + before + '"], [data-anchor="' + before + '"]')
      : null;
    if (anchor && anchor.parentElement === this.nav) {
      this.nav.insertBefore(btn, anchor);
    } else {
      this.nav.appendChild(btn);
    }
    return btn;
  }

  remove(id) {
    const btn = this.nav.querySelector('.nav-item[data-view="' + id + '"]');
    if (btn) btn.remove();
  }

  activate(id) {
    const btn = this.nav.querySelector('.nav-item[data-view="' + id + '"]');
    if (!btn) return;
    this.nav.querySelectorAll(".nav-item").forEach((b) => {
      b.classList.toggle("active", b === btn);
    });
    this.nav.classList.add("has-active");
    this._moveIndicator();
    // 初始 DOM 中按钮可能已带 active 类（如 tariff 骨架），
    // 若仅在 changed 时回调，首次 goTab 将无法触发 onTabChange，导致首屏永不渲染。
    // 页面层（onTabChange）自带 TAB_SHOWN 幂等保护，此处始终回调。
    if (this.onChange) this.onChange(id);
  }

  get active() {
    const btn = this.nav.querySelector(".nav-item.active");
    return btn ? btn.dataset.view : null;
  }

  _moveIndicator() {
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(() => {
      const btn = this.nav.querySelector(".nav-item.active");
      if (!btn) return;
      const nTop = this.nav.getBoundingClientRect().top;
      const b = btn.getBoundingClientRect();
      this.indicator.style.top = b.top - nTop - 4 + "px";
      this.indicator.style.height = b.height + 8 + "px";
    });
  }
}

/* ─────────────── 指针追踪 3D 倾斜（.tilt） ───────────────
   事件委托绑定在页面根容器：后续动态注入的 .tilt 元素自动生效。
   向元素写入 --rx/--ry（倾斜角）与 --mx/--my（光标位置百分比，
   供 spotlight 边框光定位）。触屏 / reduced-motion 下自动禁用。
   视觉层见 theme.css 的 .tilt 规则。 */
export function initTilt(root) {
  if (!root || root.dataset.tiltBound) return root;
  if (
    matchMedia("(pointer: coarse)").matches ||
    matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    return root;
  }
  root.dataset.tiltBound = "1";
  let current = null;
  let raf = 0;
  let cx = 0;
  let cy = 0;

  const reset = (el) => {
    el.style.removeProperty("--rx");
    el.style.removeProperty("--ry");
  };
  const apply = () => {
    raf = 0;
    if (!current) return;
    const r = current.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const px = Math.min(1, Math.max(0, (cx - r.left) / r.width));
    const py = Math.min(1, Math.max(0, (cy - r.top) / r.height));
    current.style.setProperty("--rx", ((0.5 - py) * 8).toFixed(2) + "deg");
    current.style.setProperty("--ry", ((px - 0.5) * 8).toFixed(2) + "deg");
    current.style.setProperty("--mx", (px * 100).toFixed(1) + "%");
    current.style.setProperty("--my", (py * 100).toFixed(1) + "%");
  };

  root.addEventListener("pointermove", (e) => {
    const el = e.target instanceof Element ? e.target.closest(".tilt") : null;
    if (el && root.contains(el)) {
      if (current && current !== el) reset(current);
      current = el;
      cx = e.clientX;
      cy = e.clientY;
      if (!raf) raf = requestAnimationFrame(apply);
    } else if (current) {
      reset(current);
      current = null;
    }
  });
  root.addEventListener("pointerleave", () => {
    if (current) {
      reset(current);
      current = null;
    }
  });
  return root;
}

/* ─────────────── 磁性按钮（.magnetic） ───────────────
   光标悬停时按钮朝光标方向微移（写入 --mtx/--mty，
   经 CSS 独立 translate 属性应用，不干扰 transform）。
   同样为事件委托，动态注入元素自动生效。 */
export function initMagnetic(root) {
  if (!root || root.dataset.magBound) return root;
  if (
    matchMedia("(pointer: coarse)").matches ||
    matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    return root;
  }
  root.dataset.magBound = "1";
  let cur = null;
  let raf = 0;
  let cx = 0;
  let cy = 0;

  const PULL = 0.24; // 吸附强度：0 = 关闭，0.24 ≈ 微妙跟手
  const reset = (el) => {
    el.style.removeProperty("--mtx");
    el.style.removeProperty("--mty");
  };
  const apply = () => {
    raf = 0;
    if (!cur) return;
    const r = cur.getBoundingClientRect();
    if (!r.width) return;
    const dx = cx - (r.left + r.width / 2);
    const dy = cy - (r.top + r.height / 2);
    cur.style.setProperty("--mtx", (dx * PULL).toFixed(1) + "px");
    cur.style.setProperty("--mty", (dy * PULL).toFixed(1) + "px");
  };

  root.addEventListener("pointermove", (e) => {
    const el = e.target instanceof Element ? e.target.closest(".magnetic") : null;
    if (el && root.contains(el)) {
      if (cur && cur !== el) reset(cur);
      cur = el;
      cx = e.clientX;
      cy = e.clientY;
      if (!raf) raf = requestAnimationFrame(apply);
    } else if (cur) {
      reset(cur);
      cur = null;
    }
  });
  root.addEventListener("pointerleave", () => {
    if (cur) {
      reset(cur);
      cur = null;
    }
  });
  return root;
}

/** 页面级特效一键初始化（tilt + magnetic），幂等可重复调用 */
export function initFX(root) {
  initTilt(root);
  initMagnetic(root);
  return root;
}

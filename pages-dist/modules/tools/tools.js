/* ═══════════════════════════════════════════════════════════════
   觅珍集库 · 通用导航页（collection=toolbox）
   ───────────────────────────────────────────────────────────────
   ▸ 数据模型 nav_links 以 collection 区分集合：将来「各省运营商活动
     汇总」等新导航页只需新集合值 + 复用本模块渲染逻辑
   ▸ 浏览=所有人（仅 open）；提交=登录用户（pending ≤5 + 限流 3/h）
   ▸ 审核/管理=仅站长（管理中心「觅珍集库」Tab）
   ▸ 特殊站点：站长在管理后台标记 featured → 页面顶部「站长精选」
     高亮区独立展示（随导航数据烘焙下发，不与常规分组重复出现）
   ═══════════════════════════════════════════════════════════════ */
"use strict";

import { Shell, esc, fetchTimeout, theme, ensureStylesheet } from "../../shell/shell.js";
import { icon, mountIcons, toast, showPageLoading, hidePageLoading } from "../../shell/ui.js";
import { mountAppsMenu } from "../../shell/apps-menu.js";
import { Auth, mountAuth } from "../../shell/auth.js";
import { api } from "../../shell/api.js";
import { getPubConfig } from "../../shell/pubcfg.js";

const COLLECTION = "toolbox";
const SUBMIT_COOLDOWN = 30; // 提交间隔（秒），后端另有 3/h 限流兜底

/* ─────────────── 状态 ─────────────── */
const FEATURED_PREVIEW = 6; // 精选区默认展示条数（超出折叠进「展开全部精选」，防精选过多头重脚轻）
const S = {
  items: [],
  groups: [],
  lastSubmitAt: 0,
  featuredExpanded: false, // 精选区展开态
};

const $ = (id) => document.getElementById(id);

/* favicon 三级回退：指定 icon → 谷歌 s2 → 站点 favicon.ico → 首字母块 */
function hostOf(u) {
  try { return new URL(u, location.origin).host; } catch { return ""; }
}
function iconChain(url, iconUrl) {
  if (/^\/(?!\/)/.test(url)) return null; // 站内链接：首字母块
  const host = hostOf(url);
  if (!host) return null;
  return iconUrl
    ? [iconUrl, `https://www.google.com/s2/favicons?domain=${host}&sz=64`, `${new URL(url, location.origin).origin}/favicon.ico`]
    : [`https://www.google.com/s2/favicons?domain=${host}&sz=64`, `${new URL(url, location.origin).origin}/favicon.ico`];
}

/* ═══════════════ 页面骨架 ═══════════════ */
function skeletonHTML() {
  return `
<div id="toolsRoot">
<header class="tl-topbar">
  <div class="tl-topbar-left">
    <div class="tl-brand"><div class="tl-brand-logo"><i data-icon="link"></i></div><div class="tl-brand-text">觅珍集库</div></div>
  </div>
  <div class="tl-topbar-actions">
    <div id="toolsAppsMenuSlot"></div>
    <div id="toolsAuthSlot"></div>
    <button class="icon-btn magnetic" id="toolsThemeBtn" title="切换主题"></button>
  </div>
</header>
<main class="tl-content" id="toolsContent">
  <section class="tl-hero">
    <div class="tl-hero-main">
      <h1 class="tl-title">觅珍集库</h1>
      <p class="tl-sub">好站点与实用工具的精选集库 · 由站长整理与审核</p>
      <div class="tl-stats" id="toolsStats" hidden></div>
    </div>
    <div class="tl-hero-actions" id="toolsHeroActions"></div>
  </section>
  <div id="toolsSubmitPanel" class="tl-submit-panel" hidden></div>
  <div id="toolsFeatured"></div>
  <div id="toolsGroupNav"></div>
  <div id="toolsBody"><div class="loading" style="padding:50px 0">加载中…</div></div>
</main>
<footer class="tl-foot">ChinaMNOs 觅珍集库 · 好工具大家一起分享（提交经站长审核后上架）</footer>
</div>`;
}

/* ═══════════════ 渲染 ═══════════════ */
function renderHero() {
  const u = Auth.getUser();
  const el = $("toolsHeroActions");
  if (!el) return;
  el.innerHTML = u
    ? `<button type="button" class="btn primary" data-act="openSubmit"><i data-icon="plus"></i>提交站点</button>`
    : `<button type="button" class="btn ghost" data-act="goLogin"><i data-icon="user"></i>登录后可提交</button>`;
  mountIcons(el);
  /* 统计条：收录总量 / 分组数 / 站长精选数（有精选才显示第三枚） */
  const st = $("toolsStats");
  if (!st) return;
  const featN = S.items.filter((it) => it.featured).length;
  const stat = (n, label) => `<span class="tl-stat"><b>${n}</b>${esc(label)}</span>`;
  st.innerHTML = stat(S.items.length, "个站点") + stat(S.groups.length, "个分组") + (featN ? stat(featN, "个精选") : "");
  st.hidden = !S.items.length;
}

function cardHTML(it, style) {
  const chain = iconChain(it.url, it.icon_url);
  const internal = /^\/(?!\/)/.test(it.url);
  const iconEl = chain
    ? `<img class="tl-card-ico" src="${esc(chain[0])}" alt="" loading="lazy" data-chain="${esc(chain.slice(1).join("|"))}" data-fb="${esc((it.title || "?").charAt(0))}">`
    : `<span class="tl-card-ico tl-ico-txt">${esc((it.title || "?").charAt(0).toUpperCase())}</span>`;
  const href = internal ? `#${it.url}` : it.url;
  const external = internal ? "" : ` target="_blank" rel="noopener noreferrer"`;
  const cls = `tl-card rise${it.featured ? " tl-card-feat" : ""}`;
  return `
  <a class="${cls}"${style ? ` style="${esc(style)}"` : ""} href="${esc(href)}"${external} data-internal="${internal ? 1 : 0}" data-tid="${esc(it.id || "")}">
    ${iconEl}
    <span class="tl-card-main">
      <span class="tl-card-name">${esc(it.title)}${internal ? '<i data-icon="chevronDown" class="tl-in-ico"></i>' : '<i data-icon="external" class="tl-ex-ico"></i>'}</span>
      ${it.descr ? `<span class="tl-card-desc">${esc(it.descr)}</span>` : ""}
    </span>
    ${it.featured ? `<span class="tl-card-feat-tag"><i data-icon="gem"></i>精选</span>` : ""}
  </a>`;
}

/* 特殊站点高亮区（站长标记 featured）：默认展示前 FEATURED_PREVIEW 条，更多时折叠 + 展开按钮；
   独立于常规分组（featured 条目不重复出现），精选再多也不挤占常规内容首屏 */
function renderFeatured() {
  const el = $("toolsFeatured");
  if (!el) return;
  const items = S.items.filter((it) => it.featured);
  if (!items.length) { el.innerHTML = ""; return; }
  const shown = S.featuredExpanded ? items : items.slice(0, FEATURED_PREVIEW);
  const more = items.length - FEATURED_PREVIEW;
  el.innerHTML = `
    <section class="tl-featured">
      <h2 class="tl-sec-title"><i data-icon="gem"></i>站长精选<span class="tl-sec-tag">特殊站点</span><span class="tl-group-n">${items.length}</span></h2>
      <div class="tl-featured-grid">${shown.map((it, i) => cardHTML(it, `--i:${Math.min(i, 10)}`)).join("")}</div>
      ${more > 0 ? `<button type="button" class="tl-featured-more" data-act="toggleFeatured">${S.featuredExpanded ? "收起精选" : `展开全部精选（还有 ${more} 个）`}</button>` : ""}
    </section>`;
  mountIcons(el);
}

/* 分组锚点导航：横向胶囊，点击平滑滚动到对应分组 */
function renderGroupNav() {
  const el = $("toolsGroupNav");
  if (!el) return;
  el.innerHTML = S.groups.length > 1
    ? `<div class="tl-gnav">${S.groups.map((g, gi) => `<button type="button" class="tl-gnav-chip" data-act="jumpGroup" data-gi="${gi}">${esc(g.name)}<b>${g.items.length}</b></button>`).join("")}</div>`
    : "";
}

function renderList() {
  const body = $("toolsBody");
  if (!body) return;
  if (!S.groups.length) {
    body.innerHTML = `
      <div class="tl-empty">
        <div class="tl-empty-ico"><i data-icon="link"></i></div>
        <p>觅珍集库还在整理中，暂无收录内容。</p>
        ${Auth.getUser() ? `<p class="tl-empty-sub">好工具不藏私——点上方「提交站点」分享给大家（经站长审核后上架）。</p>` : `<p class="tl-empty-sub">登录后可提交好站点，经站长审核后上架。</p>`}
      </div>`;
    mountIcons(body);
    return;
  }
  body.innerHTML = S.groups.map((g, gi) => `
    <section class="tl-group" id="tl-group-${gi}">
      <h2 class="tl-group-title"><i data-icon="star"></i>${esc(g.name)}<span class="tl-group-n">${g.items.length}</span></h2>
      <div class="tl-grid">${g.items.map((it, i) => cardHTML(it).replace('class="tl-card rise"', `class="tl-card rise" style="--i:${Math.min(i, 10)}"`)).join("")}</div>
    </section>`).join("");
  mountIcons(body);
}

/* 分组归位：特殊站点（featured）进顶部精选区，不与常规分组重复 */
function regroup() {
  const map = new Map();
  for (const it of S.items) {
    if (it.featured) continue;
    const g = (it.group_name || "其他").trim() || "其他";
    if (!map.has(g)) map.set(g, []);
    map.get(g).push(it);
  }
  S.groups = Array.from(map, ([name, items]) => ({ name, items }));
}

function renderAll() {
  renderFeatured();
  renderGroupNav();
  renderList();
  renderHero();
}

async function loadLinks() {
  const body = $("toolsBody");
  if (body) body.innerHTML = '<div class="loading" style="padding:50px 0">加载中…</div>';
  try {
    /* 静态源优先：data/tools.json（每轮随部署烘焙，全集合含 collection 字段，按当前集合过滤）；
       缺失回落 public-config 快照 nav_links → Worker 接口（三级回退，数据无损） */
    let items = null;
    try {
      const sj = await fetchTimeout(`./data/tools.json?v=${Date.now()}`, { cache: "no-store" }).then((x) => x.json());
      if (sj && Array.isArray(sj.items)) items = sj.items.filter((x) => x.collection === COLLECTION);
    } catch { /* 静态源缺失回落 */ }
    if (!items) {
      const pc = await getPubConfig();
      items = pc && pc.nav_links && pc.nav_links[COLLECTION] && pc.nav_links[COLLECTION].items;
    }
    if (!items) {
      const r = await api.request(`/api/nav/links?collection=${COLLECTION}`, { method: "GET" });
      items = (r.ok && r.data && r.data.items) || [];
    }
    S.items = items;
    regroup();
    renderAll();
  } catch {
    if (body) body.innerHTML = '<div class="tl-empty">加载失败，请刷新重试。</div>';
  }
}

/* ═══════════════ 提交面板（行内展开，无弹窗依赖） ═══════════════ */
const GROUP_PRESETS = ["官方渠道", "实用查询", "社区站点", "其他"];

function toggleSubmitPanel() {
  const u = Auth.getUser();
  if (!u) { Auth.openLogin(); return; }
  const now = Date.now();
  if (now - S.lastSubmitAt < SUBMIT_COOLDOWN * 1000) {
    toast(`提交太频繁，请 ${Math.ceil((SUBMIT_COOLDOWN * 1000 - (now - S.lastSubmitAt)) / 1000)} 秒后再试`);
    return;
  }
  const panel = $("toolsSubmitPanel");
  if (!panel) return;
  if (!panel.hidden) { panel.hidden = true; panel.innerHTML = ""; return; }
  panel.hidden = false;
  panel.innerHTML = `
    <div class="tl-panel-card rise">
      <h3 class="tl-panel-title"><i data-icon="plus"></i>提交站点</h3>
      <p class="tl-panel-sub">提交后由站长审核，通过后随下一轮站点数据更新上架展示（约 0-8 小时）。请确保链接安全可靠。</p>
      <div class="tl-form">
        <label>名称 <span class="req">*</span><input id="navFTitle" maxlength="30" placeholder="如：运营商话费查询"></label>
        <label>链接 <span class="req">*</span><input id="navFUrl" maxlength="500" placeholder="https:// 或站内路径 /config"></label>
        <label>图标 URL <span class="opt">选填，留空自动抓取站点图标</span><input id="navFIcon" maxlength="500" placeholder="https://…/icon.png"></label>
        <label>简介 <span class="opt">选填，≤80 字</span><input id="navFDescr" maxlength="80" placeholder="一句话介绍这个站点 / 工具"></label>
        <label>分组 <span class="opt">选填</span><input id="navFGroup" maxlength="20" list="navGroupList" placeholder="如：官方渠道 / 实用查询">
          <datalist id="navGroupList">${GROUP_PRESETS.map((g) => `<option>${g}</option>`).join("")}</datalist>
        </label>
        <div class="tl-form-actions">
          <button type="button" class="btn primary" data-act="submitTool"><i data-icon="check"></i>提交</button>
          <button type="button" class="btn ghost" data-act="closeSubmit">收起</button>
        </div>
      </div>
    </div>`;
  mountIcons(panel);
  $("navFTitle")?.focus();
}

function closeSubmitPanel() {
  const panel = $("toolsSubmitPanel");
  if (panel) { panel.hidden = true; panel.innerHTML = ""; }
}

async function submitTool() {
  const payload = {
    collection: COLLECTION,
    title: $("navFTitle")?.value?.trim() || "",
    url: $("navFUrl")?.value?.trim() || "",
    icon_url: $("navFIcon")?.value?.trim() || "",
    descr: $("navFDescr")?.value?.trim() || "",
    group_name: $("navFGroup")?.value?.trim() || "",
  };
  if (!payload.title) { toast("请填写名称"); return; }
  if (!payload.url) { toast("请填写链接"); return; }
  const btn = document.querySelector('[data-act="submitTool"]');
  if (btn) { btn.disabled = true; btn.style.opacity = ".6"; }
  try {
    const r = await api.request("/api/nav/links", { method: "POST", body: payload });
    if (r.ok) {
      S.lastSubmitAt = Date.now();
      closeSubmitPanel();
      toast("已提交，等待站长审核通过后上架");
    } else {
      const code = r.error && r.error.code;
      if (code === 40904) toast("待审核的提交已达上限（5 条），请稍后再来");
      else if (r.error && r.error.message === "RATE_LIMITED") toast("提交太频繁，请稍后再试");
      else toast("提交失败：" + (r.error && r.error.message || "未知错误"));
    }
  } catch {
    toast("网络异常，请稍后再试");
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = ""; }
  }
}

/* ═══════════════ 事件 ═══════════════ */
function onRootClick(e) {
  const actEl = e.target.closest("[data-act]");
  if (actEl) {
    const a = actEl.dataset.act;
    if (a === "openSubmit") { toggleSubmitPanel(); return; }
    if (a === "closeSubmit") { closeSubmitPanel(); return; }
    if (a === "submitTool") { submitTool(); return; }
    if (a === "goLogin") { Auth.openLogin(); return; }
    if (a === "toggleFeatured") { S.featuredExpanded = !S.featuredExpanded; renderFeatured(); return; }
    if (a === "jumpGroup") {
      const gi = Number(actEl.dataset.gi);
      const sec = $("tl-group-" + gi);
      if (sec) sec.scrollIntoView({ behavior: "smooth", block: "start" });
      document.querySelectorAll(".tl-gnav-chip.on").forEach((x) => x.classList.remove("on"));
      actEl.classList.add("on");
      return;
    }
  }
  // 卡片点击：站内链接走 SPA 路由；外部站点（精选与常规一致）先弹第三方确认，用户自行选择是否跳转
  const card = e.target.closest("a.tl-card");
  if (card && card.dataset.internal === "1") {
    e.preventDefault();
    const to = card.getAttribute("href") || "";
    if (to.startsWith("#/")) Shell.navigate(to.slice(1));
    return;
  }
  if (card) {
    e.preventDefault();
    openLinkConfirm(card.dataset.tid);
    return;
  }
}

/* 外部站点跳转确认弹窗（精选/常规统一）：展示站点信息 + 第三方免责警告，用户自行选择是否访问；
   精选条目额外带「特殊站点」徽章 */
function openLinkConfirm(tid) {
  const it = S.items.find((x) => String(x.id) === String(tid));
  if (!it || !it.url) return;
  let host = it.url;
  try { host = new URL(it.url, location.origin).host || it.url; } catch { /* 保持原值 */ }
  const chain = iconChain(it.url, it.icon_url);
  const ico = chain
    ? `<img class="tl-cf-ico" src="${esc(chain[0])}" alt="" data-chain="${esc(chain.slice(1).join("|"))}" data-fb="${esc((it.title || "?").charAt(0))}">`
    : `<span class="tl-cf-ico tl-ico-txt">${esc((it.title || "?").charAt(0).toUpperCase())}</span>`;
  const mask = document.createElement("div");
  mask.className = "tl-confirm-mask";
  mask.innerHTML = `
    <div class="tl-confirm" role="dialog" aria-modal="true">
      <div class="tl-cf-head">${ico}
        <div class="tl-cf-headmain">
          <div class="tl-cf-name">${esc(it.title || "站点")}${it.featured ? `<span class="tl-sec-tag">特殊站点</span>` : ""}</div>
          <div class="tl-cf-url"><i data-icon="external"></i>${esc(host)}</div>
        </div>
      </div>
      <div class="tl-cf-grid">
        <div class="tl-cf-desc"><span class="tl-cf-t">站点介绍</span><span>${esc(it.descr || "发布者未填写介绍")}</span></div>
        <div class="tl-cf-warn"><span class="tl-cf-t">访问须知</span><span><b>第三方站点提示：</b>该站点为外部站点，非本站运营内容。跳转后的页面内容、安全性、隐私政策均与本站无关，请自行甄别后再访问。</span></div>
      </div>
      <div class="tl-cf-btns">
        <button type="button" class="btn ghost" data-c="cancel">取消</button>
        <button type="button" class="btn primary" data-c="go"><i data-icon="external"></i>继续访问</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  mountIcons(mask);
  const close = () => { mask.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  mask.addEventListener("mousedown", (e) => { if (e.target === mask) close(); });
  mask.querySelector('[data-c="cancel"]').addEventListener("click", close);
  mask.querySelector('[data-c="go"]').addEventListener("click", () => {
    close();
    window.open(it.url, "_blank", "noopener,noreferrer");
  });
  /* 弹窗内图标加载失败回退到首字母块 */
  const cfImg = mask.querySelector("img.tl-cf-ico");
  if (cfImg) cfImg.addEventListener("error", () => {
    const span = document.createElement("span");
    span.className = "tl-cf-ico tl-ico-txt";
    span.textContent = (cfImg.dataset.fb || "?").charAt(0).toUpperCase();
    cfImg.replaceWith(span);
  }, { once: true });
}

/* 图片加载失败回退链（捕获阶段委托，动态卡片自动生效） */
function onImgError(e) {
  const img = e.target.closest("img.tl-card-ico");
  if (!img) return;
  const chain = (img.dataset.chain || "").split("|").filter(Boolean);
  if (chain.length) {
    img.src = chain.shift();
    img.dataset.chain = chain.join("|");
    return;
  }
  const fb = img.dataset.fb || "?";
  const span = document.createElement("span");
  span.className = "tl-card-ico tl-ico-txt";
  span.textContent = fb.charAt(0).toUpperCase();
  img.replaceWith(span);
}

/* ═══════════════ 页面注册 ═══════════════ */
Shell.registerPage({
  id: "tools",
  route: "/tools",
  onEnter: async function (root) {
    showPageLoading("觅珍集库加载中…");
    await ensureStylesheet(Shell.config.base + "modules/tools/style.css");
    root.innerHTML = skeletonHTML();
    hidePageLoading();
    mountIcons(root);
    mountAppsMenu($("toolsAppsMenuSlot"), "tools");
    mountAuth($("toolsAuthSlot"));
    var tb = $("toolsThemeBtn");
    if (tb) {
      var paint = () => { tb.innerHTML = icon(theme.get() === "dark" ? "sun" : "moon"); };
      tb.addEventListener("click", () => { theme.toggle(); paint(); });
      paint();
    }
    document.addEventListener("click", onRootClick);
    document.addEventListener("error", onImgError, true);
    loadLinks();
  },
  onExit: function () {
    document.removeEventListener("click", onRootClick);
    document.removeEventListener("error", onImgError, true);
  },
});

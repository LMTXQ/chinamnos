/* ═══════════════════════════════════════════════════════════════
   工具宝库 · 通用导航页（collection=toolbox）
   ───────────────────────────────────────────────────────────────
   ▸ 数据模型 nav_links 以 collection 区分集合：将来「各省运营商活动
     汇总」等新导航页只需新集合值 + 复用本模块渲染逻辑
   ▸ 浏览=所有人（仅 open）；提交=登录用户（pending ≤5 + 限流 3/h）
   ▸ 审核/管理=仅站长（管理中心「工具宝库」Tab）
   ═══════════════════════════════════════════════════════════════ */
"use strict";

import { Shell, esc, theme, ensureStylesheet } from "../../shell/shell.js";
import { icon, mountIcons, toast } from "../../shell/ui.js";
import { mountAppsMenu } from "../../shell/apps-menu.js";
import { Auth, mountAuth } from "../../shell/auth.js";
import { api } from "../../shell/api.js";
import { getPubConfig } from "../../shell/pubcfg.js";

const COLLECTION = "toolbox";
const SUBMIT_COOLDOWN = 30; // 提交间隔（秒），后端另有 3/h 限流兜底

/* ─────────────── 状态 ─────────────── */
const S = {
  items: [],
  groups: [],
  lastSubmitAt: 0,
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
    <div class="tl-brand"><div class="tl-brand-logo"><i data-icon="link"></i></div><div class="tl-brand-text">工具宝库</div></div>
  </div>
  <div class="tl-topbar-actions">
    <div id="toolsAppsMenuSlot"></div>
    <div id="toolsAuthSlot"></div>
    <button class="icon-btn magnetic" id="toolsThemeBtn" title="切换主题"></button>
  </div>
</header>
<main class="tl-content" id="toolsContent">
  <section class="tl-hero">
    <h1 class="tl-title">工具宝库</h1>
    <p class="tl-sub">精选工具与站点导航 · 由站长整理与审核</p>
    <div class="tl-hero-actions" id="toolsHeroActions"></div>
  </section>
  <div id="toolsSubmitPanel" class="tl-submit-panel" hidden></div>
  <div id="toolsBody"><div class="loading" style="padding:50px 0">加载中…</div></div>
</main>
<footer class="tl-foot">ChinaMNOs 工具宝库 · 好工具大家一起分享（提交经站长审核后上架）</footer>
</div>`;
}

/* ═══════════════ 渲染 ═══════════════ */
function renderHero() {
  const u = Auth.getUser();
  const el = $("toolsHeroActions");
  if (!el) return;
  el.innerHTML = u
    ? `<button type="button" class="btn primary" data-act="openSubmit"><i data-icon="plus"></i>提交工具</button>`
    : `<button type="button" class="btn ghost" data-act="goLogin"><i data-icon="user"></i>登录后可提交工具</button>`;
  mountIcons(el);
}

function cardHTML(it) {
  const chain = iconChain(it.url, it.icon_url);
  const internal = /^\/(?!\/)/.test(it.url);
  const iconEl = chain
    ? `<img class="tl-card-ico" src="${esc(chain[0])}" alt="" loading="lazy" data-chain="${esc(chain.slice(1).join("|"))}" data-fb="${esc((it.title || "?").charAt(0))}">`
    : `<span class="tl-card-ico tl-ico-txt">${esc((it.title || "?").charAt(0).toUpperCase())}</span>`;
  const href = internal ? `#${it.url}` : it.url;
  const external = internal ? "" : ` target="_blank" rel="noopener noreferrer"`;
  return `
  <a class="tl-card rise" href="${esc(href)}"${external} data-internal="${internal ? 1 : 0}">
    ${iconEl}
    <span class="tl-card-main">
      <span class="tl-card-name">${esc(it.title)}${internal ? '<i data-icon="chevronDown" class="tl-in-ico"></i>' : '<i data-icon="external" class="tl-ex-ico"></i>'}</span>
      ${it.descr ? `<span class="tl-card-desc">${esc(it.descr)}</span>` : ""}
    </span>
  </a>`;
}

function renderList() {
  const body = $("toolsBody");
  if (!body) return;
  if (!S.groups.length) {
    body.innerHTML = `
      <div class="tl-empty">
        <div class="tl-empty-ico"><i data-icon="link"></i></div>
        <p>工具宝库还在整理中，暂无收录内容。</p>
        ${Auth.getUser() ? `<p class="tl-empty-sub">好工具不藏私——点上方「提交工具」分享给大家（经站长审核后上架）。</p>` : `<p class="tl-empty-sub">登录后可提交好工具，经站长审核后上架。</p>`}
      </div>`;
    mountIcons(body);
    return;
  }
  body.innerHTML = S.groups.map((g, gi) => `
    <section class="tl-group">
      <h2 class="tl-group-title"><i data-icon="star"></i>${esc(g.name)}<span class="tl-group-n">${g.items.length}</span></h2>
      <div class="tl-grid">${g.items.map((it, i) => cardHTML(it).replace('class="tl-card rise"', `class="tl-card rise" style="--i:${Math.min(i, 10)}"`)).join("")}</div>
    </section>`).join("");
  mountIcons(body);
}

function regroup() {
  const map = new Map();
  for (const it of S.items) {
    const g = (it.group_name || "其他").trim() || "其他";
    if (!map.has(g)) map.set(g, []);
    map.get(g).push(it);
  }
  S.groups = Array.from(map, ([name, items]) => ({ name, items }));
}

async function loadLinks() {
  const body = $("toolsBody");
  if (body) body.innerHTML = '<div class="loading" style="padding:50px 0">加载中…</div>';
  try {
    /* 快照优先（data/public-config.json 的 nav_links，下一轮采集更新）；缺失回落 Worker 接口 */
    const pc = await getPubConfig();
    let items = pc && pc.nav_links && pc.nav_links[COLLECTION] && pc.nav_links[COLLECTION].items;
    if (!items) {
      const r = await api.request(`/api/nav/links?collection=${COLLECTION}`, { method: "GET" });
      items = (r.ok && r.data && r.data.items) || [];
    }
    S.items = items;
    regroup();
    renderList();
    renderHero();
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
      <h3 class="tl-panel-title"><i data-icon="plus"></i>提交工具</h3>
      <p class="tl-panel-sub">提交后由站长审核，通过后上架展示。请确保链接安全可靠。</p>
      <div class="tl-form">
        <label>名称 <span class="req">*</span><input id="navFTitle" maxlength="30" placeholder="如：运营商话费查询"></label>
        <label>链接 <span class="req">*</span><input id="navFUrl" maxlength="500" placeholder="https:// 或站内路径 /config"></label>
        <label>图标 URL <span class="opt">选填，留空自动抓取站点图标</span><input id="navFIcon" maxlength="500" placeholder="https://…/icon.png"></label>
        <label>简介 <span class="opt">选填，≤80 字</span><input id="navFDescr" maxlength="80" placeholder="一句话介绍这个工具"></label>
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
  if (!payload.title) { toast("请填写工具名称"); return; }
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
  }
  // 卡片：站内链接走 SPA 路由
  const card = e.target.closest("a.tl-card");
  if (card && card.dataset.internal === "1") {
    e.preventDefault();
    const to = card.getAttribute("href") || "";
    if (to.startsWith("#/")) Shell.navigate(to.slice(1));
    return;
  }
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
    await ensureStylesheet(Shell.config.base + "modules/tools/style.css");
    root.innerHTML = skeletonHTML();
    document.title = "工具宝库 · ChinaMNOs";
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

/* ═══════════════════════════════════════════════════════════════
   跳蚤市集 · 精简原型（第 0 期先行版）
   ───────────────────────────────────────────────────────────────
   ▸ 数据：data/cardhub-mock/{schema,posts}.json 预置假数据
     （模拟 /api/cardhub/schema 与 /api/cardhub/posts 下发）；
     页面上新发布 / 审核的帖子仅存内存，刷新即还原。
   ▸ 视图只消费 serializePublic() 投影后的对象（对齐技术方案 §9.3
     投影矩阵；原型视角固定为「未登录访客」）。
   ▸ 模拟审核 / 开发态入口：URL 加 ?dev=1 才显示（对齐 §19）。
   ▸ 原生 JS 无框架；样式见 modules/cardhub/style.css。
   ═══════════════════════════════════════════════════════════════ */
"use strict";

import { Shell, esc, theme, ensureStylesheet } from "../../shell/shell.js";
import { icon, mountIcons, toast, Tabs, initFX, withPending, showPageLoading, hidePageLoading } from "../../shell/ui.js";
import { mountAppsMenu } from "../../shell/apps-menu.js";
import { Auth, mountAuth } from "../../shell/auth.js";
import { api } from "../../shell/api.js";
import { getPubConfig } from "../../shell/pubcfg.js";
import { mdToSafeHtml } from "../../shell/md.js";
import {
  BOARD_LABELS, BOARD_ICONS, BOARD_PRICE, CONTACT_CH_LABEL,
  boardOf as pvBoardOf, carrierLabel as pvCarrierLabel,
  relTime, remainTag, multiItems, policyChip,
  viewFromCardhubRaw, renderListCard, renderDetailBody, adaptPost,
} from "../../shell/post-view.js";

/* ─────────────── 静态省份列表（API 未下发，前端内置） ─────────────── */
const PROVINCES = {
  "北京": ["北京"], "上海": ["上海"], "天津": ["天津"], "重庆": ["重庆"],
  "广东": ["广州", "深圳", "珠海", "佛山", "东莞", "中山", "惠州", "汕头"],
  "江苏": ["南京", "苏州", "无锡", "常州", "南通", "徐州"],
  "浙江": ["杭州", "宁波", "温州", "嘉兴", "绍兴", "金华"],
  "四川": ["成都", "绵阳", "德阳", "南充"],
  "湖北": ["武汉", "宜昌", "襄阳"],
  "湖南": ["长沙", "株洲", "湘潭"],
  "福建": ["福州", "厦门", "泉州"],
  "山东": ["济南", "青岛", "烟台", "潍坊"],
  "河南": ["郑州", "洛阳", "开封"],
  "河北": ["石家庄", "唐山", "保定"],
  "安徽": ["合肥", "芜湖", "蚌埠"],
  "江西": ["南昌", "九江", "赣州"],
  "辽宁": ["沈阳", "大连", "鞍山"],
  "吉林": ["长春", "吉林"],
  "黑龙江": ["哈尔滨", "大庆"],
  "陕西": ["西安", "咸阳", "宝鸡"],
  "山西": ["太原", "大同"],
  "云南": ["昆明", "大理"],
  "贵州": ["贵阳", "遵义"],
  "广西": ["南宁", "柳州", "桂林"],
  "海南": ["海口", "三亚"],
  "甘肃": ["兰州", "天水"],
  "青海": ["西宁"],
  "宁夏": ["银川"],
  "新疆": ["乌鲁木齐", "克拉玛依"],
  "西藏": ["拉萨"],
  "内蒙古": ["呼和浩特", "包头"],
};

/* ─────────────── 状态 ─────────────── */
const S = {
  schema: null,          // 板块元数据（配置驱动）
  posts: [],             // 全部帖子（API 拉取）
  myIds: new Set(),      // 本人帖子 id
  view: "overview",      // overview | board | detail | form | me | review | login
  overview: null,        // 总览数据 { items(最新帖) }，null=加载中
  boardStats: { counts: {}, total: 0, today: 0 }, // board-counts 扩展（总览统计卡）
  board: "found",        // 当前列表板块（默认第一板块「出让」；schema 加载后校验回退）
  detailId: null,        // 详情帖子 id
  formBoard: null,     // 发布表单当前板块（null=未初始化）
  formVis: "public",    // 发布表单：联系方式可见范围（public/users/hidden）
  formAllowChat: false, // 发布表单：在线沟通开关
  formAllowRelay: false, // 发布表单：站长中转开关（依赖交易方式「站点担保」）
  convList: null,        // 卖家会话列表（me/conversations），null=加载中
  favList: null,         // 我的收藏（me/favorites），null=加载中
  listPage: 1,           // 板块列表当前页（服务端分页）
  boardList: { items: [], total: 0, page: 1, pageSize: 20 }, // 服务端筛选+分页结果（当前板块）
  boardCounts: {},       // 各板块 open 帖计数（board-counts 接口，侧栏徽章）
  convId: null,          // 当前打开的会话 id
  convDetail: null,      // 当前会话详情（对话页），null=加载中
  formTrade: [],        // 发布表单当前交易方式多选（["offline","xianyu",…]）
  formTags: {},         // tags 类型字段草稿（号码特征等）：{ [key]: string[] }
  formPhoneMaskDirty: false, // 号码公开显示是否被手动编辑过（编辑后不再自动生成）
  formContacts: [],     // 发布表单联系方式草稿：[{ channel, value }]（进入表单时按种类带入公开联系方式）
  formProofs: [],       // 证明材料草稿（出让/出租）：[{ data(dataURL), w, h }]
  formProofPublic: false, // 证明材料公开开关（默认不公开，仅审核可见）
  formReviewMode: "proof", // 证明材料方式：proof=上传照片 | admin=指定管理员实名审核
  formReviewAdmin: "",  // 管理员审核模式指定的审核人 user_id
  formMulti: {},        // multi 字段（多条规格）草稿：{ [key]: [{v,t}] }
  formEditId: null,     // 编辑模式：被编辑帖子 id（null=新建发布）
  formEditOrig: null,   // 编辑模式锁定骨架：{ board, carrier, province, city }
  filters: { carrier: "", province: "", city: "", q: "" },
  dev: new URLSearchParams(location.search).get("dev") === "1",
  user: Auth.getUser(),   // 当前登录用户（共享 auth）
  myPostsFull: { pending: [], open: [], closed: [], expired: [], rejected: [] },
  detailPost: null,      // 详情页完整帖子（含 descr/extra/contacts）
};

const $ = (id) => document.getElementById(id);

function randId() {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

/* ─────────────── 投影器（§9.3 公开视图模型）：构建/渲染逻辑在 shell/post-view.js 共享模块 ─────────────── */
const boardOf = (id) => pvBoardOf(S.schema, id);
const CARRIER_LABEL = (c) => pvCarrierLabel(S.schema, c);
const serializePublic = (post, detail, self, logged) => viewFromCardhubRaw(S.schema, post, detail, self, { isLoggedIn: logged !== undefined ? logged : !!S.user });

/* ─────────────── 时间工具 ─────────────── */
/* relTime / remainTag 已迁 shell/post-view.js 共享模块 */
/* BOARD_* 常量与 CONTACT_CH_LABEL 已迁 shell/post-view.js 共享模块 */

/* ─────────────── toast（使用 shell/ui.js 共享实现） ─────────────── */

/* ─────────────── 数据加载（真实 API + 格式适配） ─────────────── */
/* BOARD_* 常量与 CONTACT_CH_LABEL 已迁 shell/post-view.js 共享模块 */
const CHAT_CHANNELS = [["qq", "QQ"], ["wechat", "微信"], ["phone", "手机"], ["email", "邮箱"], ["other", "其他"]];
const NOTIFY_CHANNELS = [["email", "邮箱"]];

function adaptSchema(raw) {
  return {
    boards: raw.boards.map((b) => ({
      id: b.id, label: BOARD_LABELS[b.id] || b.name, name: b.name, desc: b.desc,
      icon: BOARD_ICONS[b.id] || "box",
      priceKey: BOARD_PRICE[b.id]?.key || "", priceLabel: BOARD_PRICE[b.id]?.label || "",
      fields: b.fields || [],
    })),
    carriers: raw.carriers.map((c) => [c.id, c.name]),
    ttlOptions: raw.ttlOptions || [7, 15, 30, 60, 90],
    contactPolicies: raw.contactPolicies.map((p) => [p.id, p.name, p.desc]),
    tradeMethods: raw.tradeMethods || [],
    tradeMerchants: raw.tradeMerchants || [],
    admins: raw.admins || [],
    provinces: PROVINCES,
    chatChannels: CHAT_CHANNELS,
    notifyChannels: NOTIFY_CHANNELS,
    ownerContact: {},
  };
}

/* adaptPost 已上移 shell/post-view.js 共享导出（资费页「跳蚤市集」tab 复用），此处直接 import */

async function loadFromApi() {
  /* schema 快照优先（data/public-config.json，下一轮采集更新）；缺失回落 Worker 接口 */
  const pc = await getPubConfig();
  let schemaData = pc && pc.schema;
  if (!schemaData) {
    const schRes = await api.getSchema();
    if (!schRes.ok) throw new Error(schRes.error || "schema 加载失败");
    schemaData = schRes.data;
  }
  S.schema = adaptSchema(schemaData);
  // 当前板块防御：schema 里不存在（改名/顺序调整）时回退到第一板块
  if (!boardOf(S.board)) S.board = (S.schema.boards[0] || {}).id || "found";
  await Promise.all([loadBoardPage(), loadBoardCounts()]);
}

/* 板块列表：服务端筛选+分页（board/carrier/province/city/q 全部下推 SQL；精华置顶优先排序也在 SQL 层）。
   S.posts 仅保留当前页数据（兼容旧消费点），列表筛选不再在本地做 */
async function loadBoardPage() {
  const f = S.filters;
  const r = await api.getPosts({
    board: S.board,
    carrier: f.carrier || undefined,
    province: f.province || undefined,
    city: f.city || undefined,
    q: f.q || undefined,
    page: S.listPage,
    pageSize: 20,
  });
  if (!r.ok) { toast(r.error || "帖子加载失败"); return; }
  S.posts = (r.data.items || []).map(adaptPost);
  S.boardList = { items: S.posts, total: r.data.total || 0, page: r.data.page || 1, pageSize: r.data.pageSize || 20 };
}

/* 各板块 open 帖计数（侧栏徽章）+ 总数/今日新增（总览统计卡），失败时前端以当前页数据兜底估算 */
async function loadBoardCounts() {
  const r = await api.boardCounts();
  const counts = r.ok ? (r.data.counts || {}) : {};
  S.boardCounts = counts;
  S.boardStats = {
    counts,
    total: r.ok ? (r.data.total ?? 0) : 0,
    today: r.ok ? (r.data.today ?? 0) : 0,
  };
}

/* 仅重渲染列表区（筛选/翻页后局部刷新，不动整个视图） */
function renderListRegion() {
  const el = $("chList");
  if (el && S.view === "board") {
    el.innerHTML = listHTML();
    mountIcons(el);
  }
  /* 清除按钮的禁用态跟随筛选条件（局部刷新不重渲筛选栏，需手动同步） */
  const cb = document.querySelector('[data-act="clearFilter"]');
  if (cb) cb.disabled = !(S.filters.carrier || S.filters.province || S.filters.city || S.filters.q);
  renderNav();
}

/* ─────────────── 登录（委托给 shell/auth.js 共享模块） ─────────────── */
function openLogin() { Auth.openLogin(); }

// 登录/登出后刷新本地用户态与"我的发布"
Auth.on("login", async () => { S.user = Auth.getUser(); await loadMyPosts(); render(); });
Auth.on("logout", () => { S.user = null; S.myIds = new Set(); S.myPostsFull = { pending: [], open: [], closed: [], expired: [], rejected: [] }; render(); });

async function loadMyPosts() {
  if (!S.user) return;
  const r = await api.myPosts();
  if (r.ok) {
    S.myPostsFull = {
      pending: (r.data.pending || []).map(adaptPost),
      open: (r.data.open || []).map(adaptPost),
      closed: (r.data.closed || []).map(adaptPost),
      expired: (r.data.expired || []).map(adaptPost),
      rejected: (r.data.rejected || []).map(adaptPost),
    };
    S.myIds = new Set([...S.myPostsFull.pending, ...S.myPostsFull.open, ...S.myPostsFull.closed, ...S.myPostsFull.expired, ...S.myPostsFull.rejected].map((p) => p.id));
  }
}

/* ─────────────── 在线沟通（allow_chat 渠道）：必须登录，邮箱自动取账号邮箱；
   站长中转（allow_relay）保留游客单向通知 ─────────────── */
async function startConversation() {
  const post = S.posts.find((p) => p.id === S.detailId);
  if (!post) return;
  const me = api.getUser();
  if (!me) { toast("发起在线沟通需先登录 / 注册"); openLogin(); return; }
  const vals = await chFormModal("发起在线沟通", [
    { key: "name", label: "你的称呼", placeholder: "怎么称呼你（选填，默认用昵称）", max: 20, value: me.nickname || "" },
    { key: "body", label: "留言内容", type: "textarea", required: true, placeholder: "你好，对这张卡感兴趣…", max: 500 },
  ], "发送留言");
  if (!vals) return;
  const r = await api.createConversation({ postId: post.id, name: vals.name, body: vals.body });
  if (!r.ok) {
    if (r.code === 40902) {
      toast("你已对该帖发起过沟通，已为你打开会话");
      openConv(r.data.id);
    } else if (r.code === 40903) toast("你进行中的沟通已达上限（5 个），请等部分结束后再发起");
    else if (r.code === 40302) toast("不能对自己的帖子发起沟通");
    else toast(r.error || "发起失败");
    return;
  }
  toast("已发起沟通，可以在「会话」中继续沟通");
  openConv(r.data.id); // 发起后直接进入对话页
}

/* ─────────────── 站长中转（allow_relay 渠道） ─────────────── */
async function openRelayForm() {
  const post = S.posts.find((p) => p.id === S.detailId);
  if (!post) return;
  const me = api.getUser();
  const vals = await chFormModal("站长中转意向", [
    { key: "name", label: "你的称呼", required: true, max: 20, value: me ? me.nickname || "" : "" },
    { key: "contact", label: "你的联系方式", required: true, placeholder: "微信 / QQ / 邮箱，站长通过它联系你", max: 60 },
    { key: "note", label: "留言（选填）", type: "textarea", placeholder: "想对站长 / 发布者说的话", max: 300 },
  ], "提交意向");
  if (!vals) return;
  const r = await api.relayRequest({ postId: post.id, name: vals.name, contact: vals.contact, note: vals.note || "" });
  if (!r.ok) { toast(r.error || "提交失败"); return; }
  toast("意向已提交，站长会尽快联系你");
}

/* ═══════════════════════════ 页面骨架 ═══════════════════════════ */
function skeletonHTML() {
  const devPill = S.dev
    ? '<div class="status-pill ch-dev-pill"><span class="status-dot dot-warn"></span>DEV 模拟审核</div>'
    : "";
  return `
<div id="cardhubRoot">
<header class="ch-topbar">
  <div class="ch-topbar-left">
    <button class="icon-btn ch-hamburger" id="chHamburger" aria-label="菜单"><i data-icon="menu"></i></button>
    <div class="ch-brand">
      <div class="ch-brand-logo"><i data-icon="box"></i></div>
      <div class="ch-brand-text">跳蚤市集</div>
    </div>
  </div>
  <div class="ch-topbar-status">
    ${devPill}
    <div class="status-pill"><span class="status-dot dot-ok"></span>已接后端 API</div>
  </div>
  <div class="ch-topbar-actions">
    <div id="chAppsMenuSlot"></div>
    <div id="chAuthSlot"></div>
    <button class="icon-btn magnetic" id="chThemeBtn" title="切换主题"></button>
  </div>
</header>

<div class="ch-layout">
  <div class="ch-sidebar-overlay" id="chSidebarOverlay"></div>
  <nav class="ch-sidebar" id="chSidebar">
    <div class="ch-sidebar-head"><span>板块导航</span><button class="icon-btn" id="chSidebarClose"><i data-icon="x"></i></button></div>
    <div class="app-nav" id="chNav"></div>
    <div class="ch-side-foot">数据互不影响资费监控</div>
  </nav>
  <main class="ch-content" id="chContent"></main>
</div>

<footer class="foot">ChinaMNOs 跳蚤市集 · 交易请注意核实，谨防诈骗</footer>
</div>`;
}

/* ─────────────── 侧边导航（Tabs 组件宿主，对齐 config：滑动指示器 + data-view） ─────────────── */
let chTabs = null;

/* 资料卡/通知中心「在线沟通」深链事件：已在本页时 sessionStorage 路径不会重入 onEnter
   （hash 未变化），notify.js 派发 cmn:cardhub-view 直达对应视图；页外场景 chTabs 为 null 自然忽略 */
window.addEventListener("cmn:cardhub-view", (e) => {
  try {
    const v = e.detail && e.detail.view;
    if ((v === "me" || v === "convs") && chTabs && S.user) chTabs.activate(v);
  } catch { /* 隐私模式忽略 */ }
});

/** 当前视图对应的 nav view id */
function navViewId() {
  if (S.view === "overview") return "overview";
  if (S.view === "board") return "board:" + S.board;
  if (S.view === "me" || S.view === "review" || S.view === "fav") return S.view;
  if (S.view === "convs" || S.view === "conv") return "convs";
  return "";
}

function onNavChange(id) {
  if (id === navViewId()) return; // renderNav 刷新时的回环，忽略
  if (id === "overview") {
    S.view = "overview";
    render();
    loadOverview().then(render);
    return;
  }
  if (id.startsWith("board:")) {
    S.view = "board";
    S.board = id.slice(6);
    S.listPage = 1; // 换板块回到第 1 页
    render();
    loadBoardPage().then(renderListRegion);
    return;
  }
  if (id === "me") {
    if (!S.user) { toast("请先登录"); openLogin(); chTabs.activate(navViewId()); return; }
    S.view = "me"; render(); return;
  }
  if (id === "fav") {
    if (!S.user) { toast("请先登录"); openLogin(); chTabs.activate(navViewId()); return; }
    S.view = "fav"; S.favList = null; render(); loadFavs(); return;
  }
  if (id === "convs") {
    if (!S.user) { toast("请先登录"); openLogin(); chTabs.activate(navViewId()); return; }
    S.view = "convs"; S.convList = null; render(); loadConvs(); return;
  }
  if (id === "review") {
    if (S.dev) { S.view = "review"; render(); return; }
    chTabs.activate(navViewId());
  }
}

function renderNav() {
  const nav = $("chNav");
  if (!nav) return;
  const counts = {};
  for (const b of S.schema.boards) {
    /* 服务端 GROUP BY 计数优先；接口失败时以当前页数据兜底估算 */
    counts[b.id] = S.boardCounts[b.id] ?? S.posts.filter((p) => p.board === b.id && p.status === "open").length;
  }
  const myPending = ((S.myPostsFull && S.myPostsFull.pending) || []).length; // pending 帖不入公开列表，计数走我的发布分桶
  const pendingAll = 0; // dev 审核视图徽章：公开列表由服务端过滤恒无 pending 帖
  const cur = navViewId();
  let html = "";
  /* 总览（默认视图）：始终置顶 */
  html +=
    `<button type="button" class="nav-item ${cur === "overview" ? "active" : ""}" data-view="overview">` +
    `<div class="nav-icon"><i data-icon="home"></i></div><span>总览</span>` +
    `<span class="ch-nav-count">${S.boardStats.total}</span></button>`;
  for (const b of S.schema.boards) {
    html +=
      `<button type="button" class="nav-item ${cur === "board:" + b.id ? "active" : ""}" data-view="board:${b.id}">` +
      `<div class="nav-icon"><i data-icon="${b.icon}"></i></div><span>${esc(b.label)}</span>` +
      `<span class="ch-nav-count">${counts[b.id]}</span></button>`;
  }
  html += `<div class="sidebar-divider"></div>`;
  html +=
    `<button type="button" class="ch-nav-publish btn primary" data-act="newPost"><i data-icon="plus"></i>发布信息</button>`;
  html +=
    `<button type="button" class="btn ghost ch-nav-apply" data-act="selfRecommend" title="申请成为卡商担保人（前往工单中心提交自荐）"><i data-icon="shield"></i>毛遂自荐</button>`;
  html +=
    `<button type="button" class="nav-item ${cur === "me" ? "active" : ""}" data-view="me">` +
    `<div class="nav-icon"><i data-icon="user"></i></div><span>我的发布</span>` +
    (myPending ? `<span class="ch-nav-count warn">${myPending}</span>` : "") + `</button>`;
  if (S.user) {
    html +=
      `<button type="button" class="nav-item ${cur === "fav" ? "active" : ""}" data-view="fav">` +
      `<div class="nav-icon"><i data-icon="star"></i></div><span>我的收藏</span></button>`;
    html +=
      `<button type="button" class="nav-item ${cur === "convs" ? "active" : ""}" data-view="convs">` +
      `<div class="nav-icon"><i data-icon="message"></i></div><span>会话</span></button>`;
  }
  if (S.dev) {
    html +=
      `<button type="button" class="nav-item ${cur === "review" ? "active" : ""}" data-view="review">` +
      `<div class="nav-icon"><i data-icon="shield"></i></div><span>模拟审核</span>` +
      (pendingAll ? `<span class="ch-nav-count warn">${pendingAll}</span>` : "") + `</button>`;
  }
  /* innerHTML 重建后，把 Tabs 的滑动指示器重新挂回并归位 */
  const ind = chTabs ? chTabs.indicator : null;
  nav.innerHTML = html;
  if (ind) nav.appendChild(ind);
  mountIcons(nav);
  if (chTabs && cur) chTabs.activate(cur);
}

/* ═══════════════════════════ 视图：板块列表 ═══════════════════════════ */
function visiblePosts() {
  /* 筛选（运营商/省市/关键词）、板块过滤与置顶优先排序均已下推服务端 SQL；
     此处返回当前页数据（原始 adapt 数据，渲染前经 serializePublic 转视图模型） */
  return S.posts;
}

/* ═══════════════════════════ 视图：总览（默认） ═══════════════════════════ */
/* 全站最新帖（跨板块，置顶优先同列表规则）+ 统计卡（board-counts 扩展返回 total/today） */
async function loadOverview() {
  const r = await api.getPosts({ page: 1, pageSize: 6 });
  S.overview = {
    ok: r.ok,
    items: r.ok ? (r.data.items || []).map(adaptPost) : [],
  };
}

function renderOverviewView() {
  const st = S.boardStats;
  const boards = (S.schema && S.schema.boards) || [];
  const statCard = (num, label, ic, jumpId) =>
    `<button type="button" class="ch-ov-stat" ${jumpId ? `data-act="ovBoard" data-id="${esc(jumpId)}"` : ""}>
      <div class="ch-ov-stat-n">${num}</div>
      <div class="ch-ov-stat-l"><i data-icon="${ic}"></i>${esc(label)}${jumpId ? '<i data-icon="arrowRight" class="ch-ov-stat-go"></i>' : ""}</div>
    </button>`;
  const stats =
    statCard(st.total, "在售信息", "package") +
    statCard(st.today, "今日新增", "sparkles") +
    boards.slice(0, 2).map((b) => statCard(st.counts[b.id] ?? 0, b.label, b.icon, b.id)).join("");

  let latest;
  if (!S.overview) {
    latest = `<div class="ch-empty"><div class="ch-empty-ic">${icon("clock")}</div><div class="ch-empty-t">加载中…</div></div>`;
  } else {
    const list = S.overview.items.map((raw) => {
      const p = serializePublic(raw, false, false);
      p.author = raw.author
        ? { ...raw.author, avatarUrl: raw.author.avatar_v ? api.avatarUrl(raw.author.id, raw.author.avatar_v) : "" }
        : null;
      return p;
    });
    latest = list.length
      ? `<div class="ch-list">${list.map((p, i) => renderListCard(S.schema, p, { tilt: true, index: i })).join("")}</div>`
      : `<div class="ch-empty"><div class="ch-empty-ic">${icon("box")}</div><div class="ch-empty-t">还没有信息</div><div class="ch-empty-s">点「发布信息」发第一条</div></div>`;
  }

  return `
  <div class="ch-ov">
    <div class="ch-ov-hero">
      <div class="ch-ov-hero-t"><i data-icon="box"></i>跳蚤市集</div>
      <div class="ch-ov-hero-s">用户发布的号卡出让 / 求购 / 出闲置信息聚合，站内沟通，交易前请核实对方身份</div>
      <div class="ch-ov-hero-actions">
        <button type="button" class="btn primary" data-act="newPost"><i data-icon="plus"></i>发布信息</button>
        ${boards[0] ? `<button type="button" class="btn ghost" data-act="ovBoard" data-id="${esc(boards[0].id)}"><i data-icon="list"></i>浏览全部</button>` : ""}
      </div>
    </div>
    <div class="ch-ov-stats">${stats}</div>
    <div class="ch-ov-sec"><span class="ch-ov-sec-t"><i data-icon="clock"></i>最新发布</span></div>
    ${latest}
  </div>`;
}

function renderBoardView() {
  const board = boardOf(S.board);
  const provinces = Object.keys(S.schema.provinces || {});
  const cities = (S.schema.provinces || {})[S.filters.province] || [];
  const f = S.filters;
  return `
<section class="view active">
  <h1 class="page-title">${esc(board.label)} <span class="ch-board-sub">${esc(board.sub)}</span></h1>
  <p class="page-sub">用户自由发布 · 先审后公开展示 · 联系方式由发布者设定可见范围</p>

  <div class="panel ch-filter-bar">
    <select class="sel ch-filter-sel" data-filter="carrier" aria-label="运营商">
      <option value="">全部运营商</option>
      ${S.schema.carriers.map((c) => `<option value="${c[0]}" ${f.carrier === c[0] ? "selected" : ""}>${esc(c[1])}</option>`).join("")}
    </select>
    <select class="sel ch-filter-sel" data-filter="province" aria-label="省份">
      <option value="">全部省份</option>
      ${provinces.map((p) => `<option ${f.province === p ? "selected" : ""}>${esc(p)}</option>`).join("")}
    </select>
    <select class="sel ch-filter-sel" data-filter="city" aria-label="城市" ${!f.province ? "disabled" : ""}>
      <option value="">${f.province ? "全部城市" : "先选省份"}</option>
      ${cities.map((c) => `<option ${f.city === c ? "selected" : ""}>${esc(c)}</option>`).join("")}
    </select>
    <div class="search-box ch-search"><input type="search" class="inp" id="chSearch" placeholder="搜索标题 / 描述 / 套餐关键词…" value="${esc(f.q)}"></div>
    <button class="btn ghost" data-act="clearFilter" ${!(f.carrier || f.province || f.city || f.q) ? "disabled" : ""}><i data-icon="x"></i>清除</button>
  </div>

  <div id="chList">${listHTML()}</div>
</section>`;
}

function listHTML() {
  // visiblePosts 返回原始 adapt 数据（含 status 供过滤）；渲染前经 serializePublic
  // 转为视图模型（补齐 carrierLabel/priceLabel/price/policy/specs/createdAt 等展示字段）
  // 卡片结构渲染在 shell/post-view.js 共享模块（与管理中心预览共用）
  const list = visiblePosts().map((raw) => {
    const p = serializePublic(raw, false, false);
    // 发帖人公开信息（列表接口附带）：有图用图，无图用昵称首字
    p.author = raw.author
      ? { ...raw.author, avatarUrl: raw.author.avatar_v ? api.avatarUrl(raw.author.id, raw.author.avatar_v) : "" }
      : null;
    return p;
  });
  if (!list.length) {
    return `
<div class="ch-empty">
  <div class="ch-empty-ic">${icon("search")}</div>
  <div class="ch-empty-t">没有匹配的信息</div>
  <div class="ch-empty-s">换个筛选条件试试，或点「发布信息」发一条</div>
</div>`;
  }
  /* 服务端真分页：total 来自 SQL COUNT，翻页按钮由 data-act="listPage" 驱动 */
  const bl = S.boardList;
  const totalPages = Math.max(1, Math.ceil(bl.total / bl.pageSize));
  const pager = `
    <span class="ch-pager">
      <button type="button" class="btn sm ghost" data-act="listPage" data-pg="${bl.page - 1}" ${bl.page <= 1 ? "disabled" : ""}><i data-icon="back"></i>上一页</button>
      <button type="button" class="btn sm ghost" data-act="listPage" data-pg="${bl.page + 1}" ${bl.page >= totalPages ? "disabled" : ""}>下一页<i data-icon="arrowRight"></i></button>
    </span>`;
  return `
<div class="ch-count">共 <strong>${bl.total}</strong> 条 · 第 ${bl.page}/${totalPages} 页${totalPages > 1 ? pager : ""}</div>
<div class="ch-list">${list.map((p, i) => renderListCard(S.schema, p, { tilt: true, index: i })).join("")}</div>`;
}

/* multiItems / policyChip / remainTag 已迁 shell/post-view.js 共享模块 */

/* ═══════════════════════════ 视图：详情 ═══════════════════════════ */
function renderDetailView() {
  const isSelf = S.myIds.has(S.detailId);
  // 优先用详情接口返回的完整数据，否则用列表里的
  const raw = S.detailPost || S.posts.find((p) => p.id === S.detailId);
  if (!raw || (raw.status !== "open" && !isSelf)) {
    return `<section class="view active"><div class="ch-empty"><div class="ch-empty-t">信息不存在或已下架</div>
      <button class="btn ghost ch-mt" data-act="backBoard"><i data-icon="back"></i>返回列表</button></div></section>`;
  }
  if (!S.detailPost) {
    return `<section class="view active"><div class="ch-empty"><div class="ch-empty-t">加载中…</div></div></section>`;
  }
  const p = serializePublic(raw, true, isSelf);
  const board = boardOf(p.board);
  const selfBar = isSelf
    ? `<div class="ch-self-bar sb-${p.status}">${icon(p.status === "open" ? "check" : "clock")} ${
        p.status === "open" ? "本人视角 · 展示中" : p.status === "pending" ? "本人视角 · 待审核（仅自己和管理员可见）" : p.status === "expired" ? "本人视角 · 已过期" : p.status === "closed" ? "本人视角 · 已下架" : `本人视角 · 已拒绝${p.rejectReason ? "：" + esc(p.rejectReason) : ""}`
      }</div>`
    : "";
  const backBtn = `<button class="btn ghost ch-back" data-act="backBoard"><i data-icon="back"></i>返回${esc(board.label)}</button>`;
  const selfOps = isSelf ? myPostOpsHTML(p) : "";
  /* 管理组工具条（仅管理组可见可操作，后端 guard('admin') 二次校验）：
     管理下架固定在返回旁；置顶帖的「精华置顶」替换为「取消置顶 + 置顶排序」两钮（排序=刷新置顶时间，排到置顶区最前） */
  const isStaff = S.user && (S.user.role === "admin" || S.user.role === "owner");
  let staffBtns = "";
  if (isStaff && p.status === "open") {
    staffBtns += `<button class="btn ghost danger" data-act="staffClose" data-id="${p.id}"><i data-icon="chevronsDown"></i>管理下架</button>`;
    staffBtns += raw.pinnedAt
      ? `<button class="btn ghost danger" data-act="pinRemove" data-id="${p.id}"><i data-icon="x"></i>取消置顶</button>
         <button class="btn ghost" data-act="pinBump" data-id="${p.id}"><i data-icon="chevronsUp"></i>置顶排序</button>`
      : `<button class="btn ghost" data-act="pinAdd" data-id="${p.id}"><i data-icon="star"></i>精华置顶</button>`;
  }
  /* 收藏：登录 + 非本人帖（右端）；toggle 幂等，后端返回最新状态 */
  const favBtn = S.user && !isSelf
    ? `<button class="btn ghost ch-fav${raw.favorited ? " on" : ""}" data-act="favToggle" data-id="${p.id}"><i data-icon="${raw.favorited ? "starFill" : "star"}"></i>${raw.favorited ? "已收藏" : "收藏"}</button>`
    : "";
  const topExtra = staffBtns + favBtn;
  const topRow = topExtra
    ? `<div class="ch-detail-top">${backBtn}${staffBtns}${favBtn}</div>`
    : backBtn;
  const opsRow = selfOps ? `<div class="ch-self-ops">${selfOps}</div>` : "";
  /* 字段网格/作者行/交易方式/证明材料/描述/联系方式渲染已迁 shell/post-view.js 共享模块 */
  const author = S.detailPost.author
    ? { ...S.detailPost.author, avatarUrl: S.detailPost.author.avatar_v ? api.avatarUrl(S.detailPost.author.id, S.detailPost.author.avatar_v) : "" }
    : null;
  const body = renderDetailBody(S.schema, p, {
    self: isSelf,
    author,
    isLoggedIn: !!S.user,
    proofs: raw.proofs || [],
    proofPublic: raw.proofPublic === 1,
    reviewAdminId: raw.reviewAdminId || "",
    readonly: false,
    blobAttr: "data-proofload",
    rise: true,
  });
  setTimeout(loadDetailProofs, 0);
  return `
<section class="view active">
  ${topRow}
  ${selfBar}
  ${opsRow}
  ${body}
</section>`;
}

/* 详情页证明材料/交易方式/联系方式渲染已迁 shell/post-view.js 共享模块 */
function loadDetailProofs() {
  document.querySelectorAll("img[data-proofload]").forEach((img) => {
    if (img.dataset.loaded) return;
    img.dataset.loaded = "1";
    const [pid, key] = (img.dataset.proofload || "").split("|");
    if (!pid || !key) return;
    api.proofBlobUrl(pid, key).then((u) => { img.src = u; })
      .catch(() => { img.closest(".ch-proof-a")?.classList.add("dead"); });
  });
}

/* ── 帖子联系方式渠道标签（5 种，与账号设置一致）已迁 shell/post-view.js 共享模块 ── */

/* ═══════════════════════════ 视图：发布表单 ═══════════════════════════ */
function formBoardSegHTML() {
  const cur = S.formBoard;
  return `<div class="seg ch-form-seg">${S.schema.boards
    .map((b) => `<button type="button" class="seg-btn ${cur === b.id ? "active" : ""}" data-act="formBoard" data-board="${b.id}">${esc(b.label)}</button>`)
    .join("")}</div>`;
}

function formFieldsHTML() {
  const board = boardOf(S.formBoard);
  const editMode = !!S.formEditId;
  const orig = S.formEditOrig || {};
  const prov = editMode ? (orig.province || "") : ($("chFProvince") ? $("chFProvince").value : "");
  const cities = (S.schema.provinces || {})[prov] || [];
  const keep = (id) => ($(id) ? $(id).value : "");
  const vis = S.formVis || "public";
  const notifyVal = keep("chFNotifyValue");
  const lockAttr = editMode ? "disabled" : "";
  const isMarket = board.id === "market";
  return `
  ${editMode
    ? `<div class="ch-fg"><label>板块</label><div class="inp ch-lock">${esc(board ? board.label : "")}（板块不可修改）</div></div>
       <div class="ch-edit-banner">${icon("info")} 编辑模式：保存后帖子将<b>重新进入审核</b>，审核通过前公开列表不可见；${isMarket ? "" : "运营商 / 省份 / 城市与"}证明材料保持原样。</div>`
    : `<div class="ch-fg"><label>板块</label>${formBoardSegHTML()}</div>`}
  ${!isMarket ? `
  <div class="ch-f-row ch-f-3">
    <div class="ch-fg"><label>运营商 <b class="ch-req">*</b></label>
      <select class="sel" id="chFCarrier" ${lockAttr}>${S.schema.carriers.map((c) => `<option value="${c[0]}" ${keep("chFCarrier") === c[0] ? "selected" : ""}>${esc(c[1])}</option>`).join("")}</select></div>
    <div class="ch-fg"><label>省份 <b class="ch-req">*</b></label>
      <select class="sel" id="chFProvince" ${lockAttr}><option value="">请选择</option>${Object.keys(S.schema.provinces).map((p) => `<option ${prov === p ? "selected" : ""}>${esc(p)}</option>`).join("")}</select></div>
    <div class="ch-fg"><label>城市 <b class="ch-req">*</b></label>
      <select class="sel" id="chFCity" ${lockAttr}><option value="">${prov ? "请选择" : "先选省份"}</option>${cities.map((c) => `<option ${keep("chFCity") === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></div>
  </div>` : ""}
  <div class="ch-fg"><label>标题 <b class="ch-req">*</b> <span class="hint">${isMarket ? "一句话介绍你的市集" : "一句话说明你要找 / 要出的卡"}</span></label>
    <input type="text" class="inp" id="chFTitle" maxlength="60" placeholder="${isMarket ? "如：收各种视频会员 · 站长自营权益回收" : "如：求购广东电信长期 19 元星卡"}" value="${esc(keep("chFTitle"))}"></div>
  <div class="ch-fg"><label>详细描述 ${isMarket ? `<span class="hint">(选填，图文介绍在下方)</span>` : `<b class="ch-req">*</b>`}</label>
    <textarea id="chFDescr" maxlength="2000" placeholder="${isMarket ? "选填：一句话补充（详细介绍写在下方「市集介绍」）" : "补充说明：用途、期望、注意事项等（5~2000 字）"}">${esc(keep("chFDescr"))}</textarea></div>

  <div class="ch-form-sep">板块信息（${esc(board.label)}）</div>
  <div id="chFormExtra">${formExtraHTML(board)}</div>

  <div class="ch-f-row ch-f-2">
    <div class="ch-fg"><label>有效期 <b class="ch-req">*</b> <span class="hint">到期自动下架，可重提</span></label>
      <select class="sel" id="chFTtl">${S.schema.ttlOptions.map((t) => `<option value="${t}" ${String(keep("chFTtl") || 30) === String(t) ? "selected" : ""}>${t} 天</option>`).join("")}</select></div>
  </div>

  ${!editMode && (board.id === "found" || board.id === "rent_out") ? `
  <div class="ch-form-sep">证明材料 <b class="ch-req">*</b> <span class="hint">1~3 张（套餐截图 / 实体卡 / 后台记录等），供审核核实</span></div>
  <div class="ch-fg" id="chProofRow">${proofFormHTML()}</div>
  <div class="ch-form-note">${icon("shield")} 证明材料使用本站<b>自建非公开图床</b>存储，不对外公开、不进入公共图床，仅用于审核核验，保障您的个人隐私。</div>` : ""}
  ${editMode && (board.id === "found" || board.id === "rent_out") ? `
  <div class="ch-fg"><label>证明材料</label><div class="inp ch-lock">保持原样（编辑内容不影响已上传的证明材料）</div></div>` : ""}

  <div class="ch-form-sep">交易方式 <span class="hint">允许多选 · 仅供参考</span></div>
  <div class="ch-trade-grid" id="chTradeGrid">${isMarket ? "" : tradeGridHTML()}</div>

  ${isMarket ? "" : `
  <div class="ch-form-sep">联系方式设置 <span class="hint">谁可见 + 互动渠道，可自由组合</span></div>
  <div class="ch-fg"><label>联系方式可见范围 <b class="ch-req">*</b> <span class="hint">决定谁能看到你填写的直接联系方式</span></label>
    <div class="ch-policy-grid" id="chVisGrid">${visGridHTML(vis)}</div></div>
  <div class="ch-fg"><label>互动渠道 <span class="hint">选填 · 可多选；「不展示」时至少开启一项，否则买家无法联系你</span></label>
    <div class="ch-trade-grid" id="chChannelGrid">${channelGridHTML()}</div></div>`}

  ${isMarket ? "" : `
  <div class="ch-fg" id="chChatRow">
    <label>直接联系方式 <span class="hint" id="chChatHint">「所有人可见 / 仅登录可见」时至少填一条 · 默认带入账号设置中勾选公开的联系方式</span></label>
    <div class="ch-contacts-list" id="chContactsList">${contactRowsHTML()}</div>
    <button type="button" class="btn ghost sm" data-act="addContact" style="margin-top:6px">+ 添加一条联系方式</button>
  </div>`}

  <div class="ch-form-sep">通知渠道 <span class="hint">选填 · 只用于接收审核结果与新消息提醒，绝不公开</span></div>
  <div class="ch-f-row ch-f-2">
    <div class="ch-fg"><label>渠道</label>
      <select class="sel" id="chFNotifyChannel"><option value="">不使用（走邮件）</option>${S.schema.notifyChannels.map((c) => `<option value="${c[0]}" ${keep("chFNotifyChannel") === c[0] ? "selected" : ""}>${esc(c[1])}</option>`).join("")}</select></div>
    <div class="ch-fg"><label>接收地址 / Key</label>
      <input type="text" class="inp" id="chFNotifyValue" maxlength="120" placeholder="按所选渠道填写" value="${esc(notifyVal)}" ${keep("chFNotifyChannel") ? "" : "disabled"}></div>
  </div>

  <div class="ch-form-note">${icon("info")} ${editMode ? "编辑保存后帖子转入「待审核」，由管理组重新审核通过后才会重新公开展示。" : "提交后进入「待审核」，审核通过后公开展示；可在「我的发布」跟踪状态。"}</div>
  <div class="ch-form-actions">
    <button class="btn ghost" data-act="backBoard"><i data-icon="x"></i>取消</button>
    <button class="btn primary" data-act="submitPost"><i data-icon="check"></i>${editMode ? "保存并重新审核" : "提交发布"}</button>
  </div>`;
}

/* 条件显示字段显隐：showIf.key 的 tags 草稿与 any 有交集才显示（如车队切类型时月租/流量实时显隐）。
   容器由 formExtraHTML 渲染时打 data-showif-key/any 标记；inner 草稿变化与表单渲染后各调一次 */
function syncShowIf() {
  const host = $("chFormExtra");
  if (!host) return;
  host.querySelectorAll("[data-showif-key]").forEach((el) => {
    const key = el.dataset.showifKey;
    /* 优先读 tags 草稿（车队等多选键）；无草稿时回退读 select/input 当前值（市集交易物范围等单选键） */
    let sel = S.formTags[key];
    if (!sel) {
      const elV = $("chX_" + key);
      sel = elV && elV.value ? [elV.value] : [];
    }
    const any = (el.dataset.showifAny || "").split("|").filter(Boolean);
    el.style.display = any.some((x) => sel.includes(x)) ? "" : "none";
  });
}

function formExtraHTML(board) {
  return board.fields
    .map((fd) => {
      const req = fd.required ? ' <b class="ch-req">*</b>' : "";
      const keep = $("chX_" + fd.key) ? $("chX_" + fd.key).value : "";
      const showAttr = fd.showIf ? ` data-showif-key="${esc(fd.showIf.key)}" data-showif-any="${esc(fd.showIf.any.join("|"))}"` : "";
      if (fd.type === "select") {
        return `<div class="ch-fg"${showAttr}><label>${esc(fd.label)}${req}</label>
          <select class="sel" id="chX_${fd.key}" data-showif="1"><option value="">请选择</option>${(fd.options || []).map((o) => `<option value="${esc(o)}" ${keep === o ? "selected" : ""}>${esc(o)}</option>`).join("")}</select></div>`;
      }
      /* tags 类型：纯标签多选（无数值），如开车类型 [新开/携转/老改/删包/加包]、号码特征 */
      if (fd.type === "tags") {
        if (!Array.isArray(S.formTags[fd.key])) S.formTags[fd.key] = [];
        const cur = S.formTags[fd.key];
        return `<div class="ch-fg"${showAttr}><label>${esc(fd.label)}${req} <span class="hint">可多选</span></label>
          <div class="ch-tags-row" id="chT_${fd.key}">${(fd.options || []).map((o) => `
            <label class="ch-mtag ${cur.includes(o) ? "on" : ""}">
              <input type="checkbox" data-ttag="${esc(o)}" data-tkey="${fd.key}" ${cur.includes(o) ? "checked" : ""}>${esc(o)}
            </label>`).join("")}</div></div>`;
      }
      /* textarea / markdown 类型：多行文本（如车队风险声明）；markdown 详情/弹窗走 md.js 渲染 */
      if (fd.type === "textarea" || fd.type === "markdown") {
        const mdHint = fd.type === "markdown" ? ` <span class="hint">支持 Markdown：**加粗**、[链接](网址)、图片直链</span>` : "";
        return `<div class="ch-fg"${showAttr}><label>${esc(fd.label)}${req}${mdHint}</label>
          <textarea class="inp" id="chX_${fd.key}" data-xkey="${fd.key}" data-required="${fd.required ? 1 : 0}" data-max="${fd.max || 200}" maxlength="${fd.max || 200}" rows="${fd.type === "markdown" ? 8 : 4}" placeholder="${esc(fd.placeholder || "")}">${esc(keep)}</textarea></div>`;
      }
      // multi 字段（通话/流量/宽带）：多条规格，每条 = 可勾选标签组合 + 数值
      if (fd.type === "multi") {
        if (!Array.isArray(S.formMulti[fd.key])) S.formMulti[fd.key] = [{ v: "", t: [] }];
        const rowsHTML = S.formMulti[fd.key].map((r, i) => multiRowHTML(fd, r, i)).join("");
        return `<div class="ch-fg"${showAttr}><label>${esc(fd.label)}${fd.unit ? ` <span class="hint">（${esc(fd.unit)}）</span>` : ""}${req}
            <span class="hint">可添加多条；每组规格选一项（如 通用 + 全国 + 长期），组合自动生成</span></label>
          <div class="ch-multi" id="chM_${fd.key}">${rowsHTML}</div>
          <button type="button" class="btn ghost sm ch-multi-add" data-act="addMulti" data-mkey="${fd.key}" data-max="${fd.maxItems || 4}">+ 添加一条</button></div>`;
      }
      const cls = fd.type === "price" ? "ch-price-input" : "";
      const unitTip = fd.unit ? ` <span class="hint">（${esc(fd.unit)}）</span>` : "";
      return `<div class="ch-fg"${showAttr}><label>${esc(fd.label)}${unitTip}${req}</label>
        <input type="text" class="inp ${cls}" id="chX_${fd.key}" data-xkey="${fd.key}" data-required="${fd.required ? 1 : 0}" data-max="${fd.max || 200}" maxlength="${fd.max || 200}" placeholder="${esc(fd.placeholder || "")}" value="${esc(keep)}"></div>`;
    })
    .join("");
}

/* multi 单行：分组单选规格 chips（组内互斥）+ 数值输入 + 删除按钮 */
function multiRowHTML(fd, row, idx) {
  const groups = (fd.groups || []).map((g) => `
    <span class="ch-mgroup">
      <span class="ch-mgroup-label">${esc(g.label)}</span>
      ${g.options.map((t) => `
      <label class="ch-mtag ${row.t.includes(t) ? "on" : ""}">
        <input type="checkbox" data-mtag="${esc(t)}" data-mgroup="${esc(g.label)}" data-mkey="${fd.key}" data-midx="${idx}" ${row.t.includes(t) ? "checked" : ""}>${esc(t)}
      </label>`).join("")}
    </span>`).join("");
  return `
  <div class="ch-multi-row" data-mkey="${fd.key}" data-midx="${idx}">
    ${groups ? `<div class="ch-multi-tags">${groups}</div>` : ""}
    <input type="text" class="inp ch-multi-val" data-mval="${fd.key}" data-midx="${idx}" inputmode="numeric" maxlength="6" placeholder="如：100" value="${esc(row.v)}">
    ${fd.expire ? `<input type="text" class="inp ch-multi-exp" data-mexp="${fd.key}" data-midx="${idx}" maxlength="7" placeholder="到期 2029-10（短期必填）" value="${esc(row.expire || "")}">` : ""}
    <button type="button" class="ch-multi-del" data-act="delMulti" data-mkey="${fd.key}" data-midx="${idx}" title="删除此条">${icon("x")}</button>
  </div>`;
}

/* 局部重渲染某个 multi 字段的行列表（增删行后调用） */
function renderMultiField(key) {
  const host = $("chM_" + key);
  if (!host) return;
  const board = boardOf(S.formBoard);
  const fd = board && board.fields.find((f) => f.key === key);
  if (!fd) return;
  host.innerHTML = (S.formMulti[key] || []).map((r, i) => multiRowHTML(fd, r, i)).join("");
  mountIcons(host);
}

/* 交易方式多选卡片（选填；互动渠道「站长中转」依赖「站点担保」，见 channelGridHTML / updateChannelGate 联动）
   SITE_METHOD：站长停用「站点担保」后 schema 不再下发，编辑旧帖时以此补回原勾选项（已发布的不受影响） */
const SITE_METHOD = { id: "site", name: "站点担保", desc: "通过站点提供的担保流程交易" };
function tradeGridHTML() {
  const sel = S.formTrade || [];
  let methods = S.schema.tradeMethods || [];
  if (sel.includes("site") && !methods.some((t) => t.id === "site")) methods = methods.concat([SITE_METHOD]);
  return (methods || [])
    .map(
      (t) => `
  <label class="ch-trade-card ${sel.includes(t.id) ? "active" : ""}" data-trade="${t.id}">
    <input type="checkbox" data-trade-id="${t.id}" ${sel.includes(t.id) ? "checked" : ""}>
    <span class="ch-trade-name">${esc(t.name)}</span>
    <span class="ch-trade-desc${t.warn ? " warn" : ""}">${esc(t.desc)}</span>
  </label>`
    )
    .join("") +
    `<div class="ch-trade-note">${icon("info")} 交易方式允许多选，仅供参考，具体交易方式请与交易方实际协商。</div>`;
}

/* 联系方式可见范围（单选三卡，复用 ch-policy-card 样式） */
const VIS_OPTIONS = [
  ["public", "所有人可见", "访客与登录用户都能看到你填的直接联系方式"],
  ["users", "仅登录可见", "登录用户可见，访客会被引导注册后查看"],
  ["hidden", "不展示", "隐藏直接联系方式，买家只能通过下方互动渠道联系你"],
];

function visGridHTML(selected) {
  return VIS_OPTIONS
    .map(
      (p) => `
  <label class="ch-policy-card ${selected === p[0] ? "active" : ""}" data-vis="${p[0]}">
    <input type="radio" name="chVis" value="${p[0]}" ${selected === p[0] ? "checked" : ""}>
    <span class="ch-policy-name">${esc(p[1])}</span>
    <span class="ch-policy-desc">${esc(p[2])}</span>
  </label>`
    )
    .join("");
}

/* 互动渠道开关（多选，复用 ch-trade-card 样式）：
   「在线沟通」= 站内会话；「站长中转」依赖交易方式中的「站点担保」，未勾选时锁定 */
function channelGridHTML() {
  const siteOn = (S.formTrade || []).includes("site");
  /* 「站长中转」依赖「站点担保」：选项被停用且当前未保留原勾选时，整卡隐藏（避免出现无法解锁的死开关） */
  const siteSelectable = siteOn || (S.schema.tradeMethods || []).some((t) => t.id === "site");
  return `
  <label class="ch-trade-card ${S.formAllowChat ? "active" : ""}" data-channel="chat">
    <input type="checkbox" data-channel-id="chat" ${S.formAllowChat ? "checked" : ""}>
    <span class="ch-trade-name">在线沟通</span>
    <span class="ch-trade-desc">站内会话：买家发起沟通，消息直达你的收件箱与邮箱</span>
  </label>
  ${siteSelectable ? `
  <label class="ch-trade-card ${S.formAllowRelay ? "active" : ""}${!siteOn ? " locked" : ""}" data-channel="relay">
    <input type="checkbox" data-channel-id="relay" ${S.formAllowRelay ? "checked" : ""}${!siteOn ? " disabled" : ""}>
    <span class="ch-trade-name">站长中转</span>
    <span class="ch-trade-desc${!siteOn ? " warn" : ""}">${!siteOn ? "需先在交易方式中勾选「站点担保」" : "通过站长转交交易意向，保护双方隐私"}</span>
  </label>` : ""}`;
}

/* 发布表单联系方式多行列表（5 种渠道，与账号设置一致）：
   进入表单时按种类带入账号设置中勾选公开的联系方式，发布者可增删改 */
function seedFormContacts() {
  const mine = (api.getUser() && api.getUser().contacts) || [];
  S.formContacts = mine.filter((c) => c && c.pub && c.value).map((c) => ({ channel: c.type, value: c.value }));
}

function contactRowsHTML() {
  return (S.formContacts || []).map((c, i) => `
  <div class="ch-contact-row" data-cidx="${i}">
    <select class="sel ch-contact-ch" data-cch="${i}">${CHAT_CHANNELS.map(([id, name]) => `<option value="${id}" ${c.channel === id ? "selected" : ""}>${esc(name)}</option>`).join("")}</select>
    <input type="text" class="inp ch-contact-val" data-cval="${i}" maxlength="40" placeholder="内容，如 14288 / wxid_xxx / 138****8000" value="${esc(c.value)}">
    <button type="button" class="ch-multi-del" data-act="delContact" data-cidx="${i}" title="删除此条">${icon("x")}</button>
  </div>`).join("") || `<div class="ch-contacts-empty">暂未添加，点击下方按钮添加；账号设置中勾选公开的联系方式会按种类自动带入</div>`;
}

function renderContactRows() {
  const host = $("chContactsList");
  if (host) { host.innerHTML = contactRowsHTML(); mountIcons(host); }
}

/* ═══════════════ 证明材料（出让/出租必填 1~3 张，默认仅审核可见） ═══════════════ */
/* 前端压缩（双验证的前端层）：长边 ≤1280、JPEG 循环降质至 base64 ≤400K 字符（≈300KB 字节）；
   后端还有魔数/大小/张数二次校验，此处仅为体验与带宽 */
function compressProof(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(jpeg|jpg|png|webp)$/i.test(file.type)) { reject("仅支持 JPG / PNG / WebP 图片"); return; }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const MAX = 1280;
      let w = img.naturalWidth, h = img.naturalHeight;
      if (w > MAX || h > MAX) { const r = Math.min(MAX / w, MAX / h); w = Math.round(w * r); h = Math.round(h * r); }
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      cv.getContext("2d").drawImage(img, 0, 0, w, h);
      let q = 0.82, data = cv.toDataURL("image/jpeg", q);
      while (data.length > 400000 && q > 0.5) { q -= 0.12; data = cv.toDataURL("image/jpeg", q); }
      resolve({ data, w, h });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject("图片读取失败"); };
    img.src = url;
  });
}

function proofThumbsHTML() {
  return (S.formProofs || []).map((p, i) => `
  <div class="ch-proof-thumb">
    <img src="${p.data}" alt="证明材料 ${i + 1}">
    <button type="button" class="ch-proof-del" data-act="delProof" data-pidx="${i}" title="删除">${icon("x")}</button>
  </div>`).join("");
}

function renderProofThumbs() {
  const host = $("chProofList");
  if (host) { host.innerHTML = proofThumbsHTML(); mountIcons(host); }
  const add = $("chProofAddWrap");
  if (add) add.style.display = (S.formProofs || []).length >= 3 ? "none" : "";
}

async function handleProofFiles(files) {
  if (!files || !files.length) return;
  const room = 3 - (S.formProofs || []).length;
  if (room <= 0) { toast("最多 3 张证明材料"); return; }
  const list = Array.from(files).slice(0, room);
  if (list.length < files.length) toast("最多 3 张，已取前 " + list.length + " 张");
  for (const f of list) {
    try { (S.formProofs || (S.formProofs = [])).push(await compressProof(f)); }
    catch (err) { toast(typeof err === "string" ? err : "图片处理失败"); }
  }
  renderProofThumbs();
}

function proofFormHTML() {
  const isAdmin = S.formReviewMode === "admin";
  const admins = S.schema.admins || [];
  return `
  <div class="ch-proof-mode">
    <label class="ch-mtag ${!isAdmin ? "on" : ""}"><input type="radio" name="chProofMode" value="proof" ${!isAdmin ? "checked" : ""}>上传证明材料</label>
    <label class="ch-mtag ${isAdmin ? "on" : ""}"><input type="radio" name="chProofMode" value="admin" ${isAdmin ? "checked" : ""}>指定管理员审核（免上传）</label>
  </div>
  ${!isAdmin ? `
  <div class="ch-proof-list" id="chProofList">${proofThumbsHTML()}</div>
  <div id="chProofAddWrap" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
    <label class="btn ghost sm ch-proof-add">+ 添加照片（1~3 张）
      <input type="file" id="chProofFile" accept="image/jpeg,image/png,image/webp" multiple hidden>
    </label>
    <label class="ch-proof-pub"><input type="checkbox" id="chProofPublic" ${S.formProofPublic ? "checked" : ""}> 公开证明材料（默认仅审核可见，勾选后公众可在详情页查看）</label>
  </div>` : `
  <div class="ch-fg">
    <label>指定审核管理员 <b class="ch-req">*</b></label>
    <select class="sel" id="chReviewAdmin"><option value="">请选择</option>${admins.map((a) => `<option value="${esc(a.id)}" ${S.formReviewAdmin === a.id ? "selected" : ""}>${esc(a.nickname)}</option>`).join("")}</select>
    <p class="hint">该帖将仅由站长或您指定的管理员审核，其他管理员不可见；审核时会特别提醒对方：您未上传证明材料，请确认是否已通过其他渠道核实身份。</p>
  </div>`}`;
}

function renderFormView() {
  if (!S.formBoard) S.formBoard = S.board;
  return `
<section class="view active">
  <button class="btn ghost ch-back" data-act="backBoard"><i data-icon="back"></i>返回列表</button>
  <div class="panel ch-form rise">
    <h1 class="panel-title"><i data-icon="plusCircle"></i>发布信息</h1>
    <form id="chForm" onsubmit="return false">${formFieldsHTML()}</form>
  </div>
</section>`;
}

/* ─────────────── 表单：板块切换只重渲染局部（保留已填内容） ─────────────── */
function switchFormBoard(bid) {
  if (S.formBoard === bid) return;
  S.formBoard = bid;
  S.formMulti = {}; // 板块字段不同，multi 草稿不跨板块保留
  const host = $("chForm");
  if (host) host.innerHTML = formFieldsHTML();
  syncShowIf();
  mountIcons($("cardhubRoot"));
}

/* ─────────────── 提交与校验 ─────────────── */
/* 发布失败提示中文化：后端 fail 携带 data.field（具体字段 key）+ message 错误码，
   映射为「字段 label + 指引」；未知码原样透出便于排查（勿再直出英文 VALIDATION_ERROR） */
const POST_ERR_CN = {
  PROOFS_REQUIRED: "出让/出租需上传 1~3 张证明材料，或改选「指定管理员审核」",
  PROOFS_INVALID: "证明材料无效（图片过大或格式不支持），请重新选择后上传",
  TRADE_SITE_REQUIRED: "选择「站长中转」需同时勾选交易方式「站点担保」",
  PENDING_QUOTA_EXCEEDED: "待审核帖子已达 3 条上限，请等待审核结果后再发布",
};
function postErrCN(r, board) {
  const msg = r && r.error;
  if (msg && POST_ERR_CN[msg]) return POST_ERR_CN[msg];
  const fd = r && r.data && r.data.field;
  if (!fd) return msg || "";
  const common = {
    board: "板块", carrier: "运营商", province: "省份", city: "城市",
    title: "标题", descr: "描述", contact_policy: "联系方式策略", ttl_days: "挂帖时长",
    trade_methods: "交易方式", contacts: "联系方式", proofs: "证明材料",
    phone_num: "号码", phone_masked: "掩码号码", review_admin_id: "指定管理员",
  };
  const own = board && (board.fields || []).find((f) => f.key === fd);
  const label = own ? own.label : common[fd] || fd;
  /* 按字段类型给精准指引（勿把数字提示安在文本字段头上） */
  let hint = "";
  if (fd === "title") hint = "标题需 2~60 字";
  else if (fd === "descr") hint = "描述需 5~2000 字";
  else if (own && (own.type === "multi" || own.int)) hint = "数字需纯整数，无则填 0";
  else if (own && own.type === "select") hint = "请在选项中选择";
  return "「" + label + "」项校验未通过" + (hint ? "：" + hint : "，请检查该栏填写");
}

/* 进入编辑模式：复用发布表单回填帖子内容；板块/运营商/省市锁定（骨架不可编辑）、
   证明材料保持原样；提交走 PUT，保存后帖子转待审。keep 回填是 DOM 驱动的，
   编辑模式渲染后需直接写 DOM 值 */
function enterEditMode(p) {
  S.formEditId = p.id;
  S.formEditOrig = { board: p.board, carrier: p.carrier, province: p.province, city: p.city };
  S.view = "form";
  S.formBoard = p.board;
  /* 多渠道回填：新字段优先，旧 contact_policy 推导兜底（迁移前旧帖） */
  const legacyPolicy = p.contactPolicy || "public";
  S.formVis = p.contactVisibility || (legacyPolicy === "public" || legacyPolicy === "users" ? legacyPolicy : "hidden");
  S.formAllowChat = p.allowChat ? true : legacyPolicy === "relay_online";
  S.formAllowRelay = p.allowRelay ? true : legacyPolicy === "relay_owner";
  S.formTrade = (p.extra && Array.isArray(p.extra.trade_methods)) ? p.extra.trade_methods.slice() : [];
  S.formTags = {};
  S.formMulti = {};
  S.formPhoneMaskDirty = true; // 编辑时不自动覆盖原掩码号码
  S.formProofs = [];
  S.formProofPublic = !!p.proofPublic;
  S.formReviewMode = p.reviewAdminId ? "admin" : "proof";
  S.formReviewAdmin = p.reviewAdminId || "";
  const board = boardOf(p.board);
  for (const fd of (board ? board.fields : [])) {
    const v = p.extra ? p.extra[fd.key] : undefined;
    if (fd.type === "multi") {
      S.formMulti[fd.key] = Array.isArray(v) ? v.map((x) => ({
        v: x && x.v != null ? String(x.v) : "",
        t: Array.isArray(x.t) ? x.t.slice() : [],
        expire: x && x.expire != null ? String(x.expire) : "",
      })) : [];
    } else if (fd.type === "tags") {
      S.formTags[fd.key] = Array.isArray(v) ? v.slice() : [];
    }
  }
  S.formContacts = (p.contacts || []).filter((c) => c && c.channel).map((c) => ({ channel: c.channel, value: c.value || "" }));
  render();
  // DOM 回填（含 locked 控件；城市列表已按原省份渲染）
  const setV = (id, v) => { const el = $(id); if (el) el.value = v == null ? "" : String(v); };
  setV("chFTitle", p.title);
  setV("chFDescr", p.descr);
  setV("chFCarrier", p.carrier);
  setV("chFProvince", p.province);
  setV("chFCity", p.city);
  setV("chFTtl", p.ttlDays || 30);
  for (const fd of (board ? board.fields : [])) {
    if (fd.type === "multi" || fd.type === "tags") continue;
    setV("chX_" + fd.key, p.extra ? p.extra[fd.key] : "");
  }
  renderContactRows();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function collectAndSubmit() {
  const board = boardOf(S.formBoard);
  const isMarket = S.formBoard === "market";
  const val = (id) => ($(id) ? $(id).value.trim() : "");
  const errs = [];
  const mark = (id, bad) => { const el = $(id); if (el) el.classList.toggle("error", !!bad); if (bad) errs.push(1); };

  /* 市集（权益回收）：无运营商/省份维度，直接联系方式与互动渠道区隐藏，一律按「不展示」提交 */
  const carrier = isMarket ? "" : val("chFCarrier");
  const province = isMarket ? "" : val("chFProvince");
  const city = isMarket ? "" : val("chFCity");
  const title = val("chFTitle");
  const descr = val("chFDescr");
  const ttl = Number(val("chFTtl")) || 30;
  mark("chFCarrier", !isMarket && !carrier);
  mark("chFProvince", !isMarket && !province);
  mark("chFCity", !isMarket && !city);
  mark("chFTitle", !title);
  mark("chFDescr", !isMarket && !descr);
  /* 长度预校验（后端同规则：标题 2~60、描述 5~2000 / 市集仅上限），避免打到后端才被拒 */
  let lenBad = false;
  if (title && (title.length < 2 || title.length > 60)) { mark("chFTitle", true); lenBad = true; }
  if (descr && (descr.length < 5 || descr.length > 2000)) { mark("chFDescr", true); lenBad = true; }

  const extra = {};
  let fmtBad = false; // int/multi 数值格式错误（区别于必填缺失）
  for (const fd of board.fields) {
    /* 条件显示字段：showIf 未命中（tags 草稿无交集）时不收集，与后端剔除逻辑对齐 */
    if (fd.showIf) {
      const sel = S.formTags[fd.showIf.key] || [];
      if (!fd.showIf.any.some((x) => sel.includes(x))) continue;
    }
    /* tags 类型：纯标签多选（草稿驱动，无输入框） */
    if (fd.type === "tags") {
      extra[fd.key] = (S.formTags[fd.key] || []).slice();
      continue;
    }
    /* multi 字段：从草稿收集 [{v,t,expire?}]；required 至少一条有值；数值纯整数；短期条目必须填到期时间 */
    if (fd.type === "multi") {
      const rows = S.formMulti[fd.key] || [];
      const filled = rows
        .map((r) => {
          const it = { v: (r.v || "").trim(), t: (r.t || []).slice() };
          const exp = (r.expire || "").trim();
          if (exp) it.expire = exp;
          return it;
        })
        .filter((r) => r.v !== "");
      const host = $("chM_" + fd.key);
      if (host) host.classList.toggle("error", fd.required ? !filled.length : false);
      if (fd.required && !filled.length) errs.push(1);
      for (const r of rows) {
        if (r.v && !/^\d+$/.test(r.v.trim())) { if (host) host.classList.add("error"); fmtBad = true; errs.push(1); break; }
      }
      if (fd.expire) {
        for (const r of rows) {
          const exp = (r.expire || "").trim();
          const hasVal = (r.v || "").trim() !== "";
          // 标了短期：到期时间必填；填了则校验格式 YYYY 或 YYYY-MM
          if (hasVal && r.t.includes("短期") && !exp) { if (host) host.classList.add("error"); errs.push(1); break; }
          if (exp && !/^\d{4}(-([01]\d|1[0-2]))?$/.test(exp)) { if (host) host.classList.add("error"); fmtBad = true; errs.push(1); break; }
        }
      }
      extra[fd.key] = filled;
      continue;
    }
    const v = val("chX_" + fd.key);
    mark("chX_" + fd.key, fd.required && !v);
    if (fd.max && v.length > fd.max) mark("chX_" + fd.key, true);
    if (fd.int && v && !/^\d+$/.test(v)) { mark("chX_" + fd.key, true); fmtBad = true; }
    extra[fd.key] = v;
  }

  /* 多渠道联系方式设置：可见范围（单选）+ 互动渠道（多选开关） */
  const visEl = document.querySelector('input[name="chVis"]:checked');
  const vis = visEl ? visEl.value : "public";
  const allowChat = !!document.querySelector('#chChannelGrid input[data-channel-id="chat"]:checked');
  const allowRelay = !!document.querySelector('#chChannelGrid input[data-channel-id="relay"]:checked');
  const tradeMethods = Array.from(document.querySelectorAll("#chTradeGrid input[data-trade-id]:checked")).map((i) => i.dataset.tradeId);
  if (allowRelay && !tradeMethods.includes("site")) {
    toast("开启「站长中转」需先在交易方式勾选「站点担保」");
    return;
  }
  /* 旧 contact_policy 兼容值（青龙推送窗口期后端推导兜底用） */
  const legacyPolicy = vis === "hidden" ? (allowChat ? "relay_online" : "relay_owner") : vis;

  /* 联系方式多行：过滤空值行。
     「所有人可见 / 仅登录可见」至少一条直接联系方式；「不展示」至少开启一个互动渠道 */
  const contacts = (S.formContacts || [])
    .filter((c) => (c.value || "").trim())
    .map((c) => ({ purpose: "chat", channel: c.channel, value: c.value.trim() }));
  const needChat = !isMarket && (vis === "public" || vis === "users");
  const needChannel = !isMarket && vis === "hidden" && !allowChat && !allowRelay;
  const chatRow = $("chChatRow");
  if (chatRow) chatRow.classList.toggle("error", needChat && !contacts.length);
  if (needChat && !contacts.length) errs.push(1);
  if (needChannel) {
    toast("「不展示」直接联系方式时，需至少开启「在线沟通」或「站长中转」一项，否则买家无法联系你");
    return;
  }

  /* 证明材料：出让/出租二选一——上传照片或指定管理员实名审核（编辑模式材料保持原样，跳过校验） */
  const needProof = S.formBoard === "found" || S.formBoard === "rent_out";
  const proofRow = $("chProofRow");
  const useAdminReview = S.formReviewMode === "admin";
  const reviewAdminId = useAdminReview ? (S.formReviewAdmin || "").trim() : "";
  const hasProofs = (S.formProofs || []).length > 0;
  if (proofRow) proofRow.classList.toggle("error", needProof && !S.formEditId && !hasProofs && !(useAdminReview && reviewAdminId));
  if (needProof && !S.formEditId && !hasProofs && !(useAdminReview && reviewAdminId)) errs.push(1);
  if (useAdminReview && hasProofs) { /* 两种方式互斥，以前端选中模式为准 */ }

  if (errs.length) {
    toast(lenBad ? "标题需 2~60 字，描述需 5~2000 字（标红处请补足字数）"
      : fmtBad ? "标红项格式有误：数字栏需填纯整数（如 100，无则填 0)"
      : needChat && !contacts.length ? "当前联系方式策略需至少填写一条联系方式"
      : needProof && !hasProofs && !(useAdminReview && reviewAdminId) ? "出让/出租需上传证明材料，或改选「指定管理员审核」"
      : "有必填项未完成，已标红");
    const firstErr = document.querySelector("#chForm .error");
    if (firstErr) firstErr.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  const body = {
    board: S.formBoard,
    carrier, province, city, title, descr,
    /* 多渠道：新三字段优先；contact_policy 为兼容冗余（后端新字段存在时忽略） */
    contact_visibility: vis,
    allow_chat: allowChat ? 1 : 0,
    allow_relay: allowRelay ? 1 : 0,
    contact_policy: legacyPolicy,
    trade_methods: tradeMethods,
    contacts,
    extra,
    ttl_days: ttl,
    proofs: useAdminReview ? [] : (S.formProofs || []).map((p) => ({ data: p.data, w: p.w, h: p.h })),
    proof_public: !!S.formProofPublic,
    review_admin_id: useAdminReview ? reviewAdminId : "",
  };
  /* 编辑模式：骨架（板块/运营商/省市）用锁定原值提交，走 PUT → 转待审 */
  const isEdit = !!S.formEditId;
  if (isEdit && S.formEditOrig) {
    body.board = S.formEditOrig.board;
    body.carrier = S.formEditOrig.carrier;
    body.province = S.formEditOrig.province;
    body.city = S.formEditOrig.city;
  }
  const r = isEdit ? await api.updatePost(S.formEditId, body) : await api.createPost(body);
  if (!r.ok) { toast(postErrCN(r, board) || "提交失败"); return; }
  S.myIds.add(isEdit ? S.formEditId : r.data.id);
  S.formEditId = null; S.formEditOrig = null;
  S.formTrade = [];
  S.formTags = {};
  S.formPhoneMaskDirty = false;
  S.formProofs = [];
  S.formProofPublic = false;
  S.formReviewMode = "proof";
  S.formReviewAdmin = "";
  toast(isEdit ? "已保存，帖子进入重新审核" : "已提交，等待审核");
  S.view = "me";
  // 刷新列表和我的发布
  await Promise.all([loadFromApi(), loadMyPosts()]);
  render();
}

/* ═══════════════════════════ 视图：我的发布 ═══════════════════════════ */
/* 帖子动作错误码 → 中文（动作与字段校验无关，不走 postErrCN） */
const ACT_ERR_CN = {
  NOT_OPEN: "帖子已不在展示中，请刷新后重试",
  INVALID_STATUS: "帖子当前状态不支持该操作，请刷新后重试",
  NOT_DELETABLE: "当前状态不可直接删除（展示中请先下架）",
  NOT_FOUND: "帖子不存在或已被删除",
};

/* 轻量确认弹窗（危险动作二次确认）：Promise<boolean> */
function chConfirm(msg, okText) {
  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "ch-confirm-mask";
    mask.innerHTML = `
      <div class="ch-confirm" role="alertdialog" aria-modal="true">
        <div class="ch-confirm-msg">${esc(msg)}</div>
        <div class="ch-confirm-btns">
          <button class="btn ghost" data-c="cancel">取消</button>
          <button class="btn danger" data-c="ok">${esc(okText || "确认")}</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    const done = (v) => { mask.remove(); document.removeEventListener("keydown", onKey); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") done(false); };
    document.addEventListener("keydown", onKey);
    mask.addEventListener("mousedown", (e) => { if (e.target === mask) done(false); });
    mask.addEventListener("click", (e) => { const b = e.target.closest("[data-c]"); if (b) done(b.dataset.c === "ok"); });
    mask.querySelector('[data-c="ok"]').focus();
  });
}

/* 轻量表单弹窗（发起沟通/中转意向等）：Promise<values|null>
   fields: [{ key, label, type:"text"|"textarea", placeholder, required, email, max, value }] */
function chFormModal(title, fields, okText) {
  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "ch-confirm-mask";
    mask.innerHTML = `
      <div class="ch-confirm ch-form-modal" role="dialog" aria-modal="true">
        <div class="ch-confirm-msg ch-fm-title">${esc(title)}</div>
        ${fields.map((f) => `
        <label class="ch-fm-field">
          <span>${esc(f.label)}${f.required ? ' <b class="ch-req">*</b>' : ""}</span>
          ${f.type === "textarea"
            ? `<textarea class="inp" data-fk="${esc(f.key)}" rows="4" maxlength="${f.max || 500}" placeholder="${esc(f.placeholder || "")}">${esc(f.value || "")}</textarea>`
            : `<input class="inp" data-fk="${esc(f.key)}" type="text" maxlength="${f.max || 120}" placeholder="${esc(f.placeholder || "")}" value="${esc(f.value || "")}">`}
        </label>`).join("")}
        <div class="ch-confirm-btns">
          <button class="btn ghost" data-c="cancel">取消</button>
          <button class="btn primary" data-c="ok">${esc(okText || "提交")}</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    const done = (v) => { mask.remove(); document.removeEventListener("keydown", onKey); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") done(null); };
    document.addEventListener("keydown", onKey);
    mask.addEventListener("mousedown", (e) => { if (e.target === mask) done(null); });
    mask.addEventListener("click", (e) => {
      const b = e.target.closest("[data-c]");
      if (!b) return;
      if (b.dataset.c === "cancel") { done(null); return; }
      const vals = {};
      let badLabel = "";
      mask.querySelectorAll("[data-fk]").forEach((el) => {
        const f = fields.find((x) => x.key === el.dataset.fk);
        const v = el.value.trim();
        el.classList.remove("error");
        if ((f.required && !v) || (f.email && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))) {
          el.classList.add("error");
          if (!badLabel) badLabel = f.label;
        }
        vals[f.key] = v;
      });
      if (badLabel) { toast(`请正确填写「${badLabel}」`); return; }
      done(vals);
    });
    const first = mask.querySelector("[data-fk]");
    if (first) first.focus();
  });
}

/* 发送图片引导弹窗：站内不提供聊天图片直传，引导用户到公益图床自行上传后粘贴外链 URL。
   图床为非官方第三方服务，弹窗中明确隐私提醒 */
const IMG_HOST_URL = "https://111666.best";
function openImageHostGuide() {
  const mask = document.createElement("div");
  mask.className = "ch-confirm-mask";
  mask.innerHTML = `
    <div class="ch-confirm ch-form-modal ch-img-guide" role="dialog" aria-modal="true">
      <div class="ch-confirm-msg ch-fm-title">发送图片</div>
      <p class="ch-ig-desc">在线沟通暂不支持站内直接上传图片。请使用外部免费图床获取图片链接后粘贴到消息框发送，系统会自动识别并显示为图片：</p>
      <ol class="ch-ig-steps">
        <li>点击下方按钮，在新标签页打开图床 <b>111666.best</b></li>
        <li>上传图片后，复制图片的<b>外链地址（URL）</b></li>
        <li>回到本页，把 URL 粘贴进消息框发送即可</li>
      </ol>
      <div class="ch-ig-warn">${icon("shield")} <span>该图床为<b>非官方</b>的第三方公益服务，与本站无关，图片将公开保存在站外。请<b>注意保护个人隐私</b>，勿上传身份证、银行卡、收款码等敏感内容。</span></div>
      <div class="ch-confirm-btns">
        <button class="btn ghost" data-c="cancel">取消</button>
        <button class="btn primary" data-c="open">${icon("external")} 打开图床</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  const close = () => { mask.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  mask.addEventListener("mousedown", (e) => { if (e.target === mask) close(); });
  mask.addEventListener("click", (e) => {
    const b = e.target.closest("[data-c]");
    if (!b) return;
    close();
    if (b.dataset.c === "open") window.open(IMG_HOST_URL, "_blank", "noopener");
  });
}

/* 我的帖子操作按钮组（「我的发布」行 + 详情页本人操作条共用）：
   open=已成交/下架/编辑 · pending=撤回 · rejected/expired=编辑重提/删除 · closed=删除 */
function myPostOpsHTML(p) {
  const btn = (act, ic, label, danger) => `<button class="btn sm ghost${danger ? " danger" : ""}" data-act="${act}" data-id="${p.id}"><i data-icon="${ic}"></i>${label}</button>`;
  let ops = `<button class="btn sm ghost" data-act="openDetail" data-id="${p.id}"><i data-icon="eye"></i>查看</button>`;
  if (p.status === "open") ops += btn("postClose", "check", "已成交") + btn("postWithdraw", "chevronsDown", "下架") + btn("postEdit", "edit", "编辑");
  else if (p.status === "pending") ops += btn("postWithdraw", "chevronsDown", "撤回");
  else if (p.status === "rejected" || p.status === "expired") ops += btn("postEdit", "edit", "编辑重提") + btn("postDelete", "trash", "删除", true);
  else if (p.status === "closed") ops += btn("postDelete", "trash", "删除", true);
  return ops;
}

/* ═══════════════════════════ 视图：会话（卖家收件箱） ═══════════════════════════ */
/* 会话列表：GET me/conversations；对话页：GET conversations/:id + POST messages */
const CONV_MSG_CAP = 200; // 单会话双方合计消息上限（与后端 conversation-messages.ts MAX_MSG 保持一致）
async function loadConvs() {
  const r = await api.myConversations();
  if (!r.ok) { S.convList = []; toast(r.error || "会话加载失败"); render(); return; }
  S.convList = r.data.items || [];
  render();
}

function renderConvsView() {
  if (!S.convList) {
    return `<section class="view active"><div class="ch-empty"><div class="ch-empty-t">加载中…</div></div></section>`;
  }
  if (!S.convList.length) {
    return `
<section class="view active">
  <h1 class="page-title">会话</h1>
  <p class="page-sub">买家通过你帖子上的「在线沟通」发起的站内对话</p>
  <div class="ch-empty">
    <div class="ch-empty-ic">${icon("message")}</div>
    <div class="ch-empty-t">暂无会话</div>
    <div class="ch-empty-s">在发布时开启「在线沟通」渠道，买家即可发起对话</div>
  </div>
</section>`;
  }
  return `
<section class="view active">
  <h1 class="page-title">会话 <span class="ch-board-sub">与买家的沟通 · 我发起的咨询</span></h1>
  <div class="ch-conv-list">
    ${S.convList.map((c) => {
      const count = c.msg_count || 0;
      const remain = CONV_MSG_CAP - count;
      const near = c.status === "open" && remain <= 20; // 快到上限：进度条/计数转琥珀色
      const isDm = c.kind === "dm";
      const kindTag = isDm ? `<span class="ch-conv-status st-role">私信</span>` : "";
      const counterpart = isDm ? "私信对方" : (c.my_role === "buyer" ? "发布者" : esc(c.buyer_name || "买家"));
      const roleTag = (!isDm && c.my_role === "buyer") ? `<span class="ch-conv-status st-role">我发起</span>` : "";
      const statusTag = `<span class="ch-conv-status st-${esc(c.status)}">${c.status === "open" ? "进行中" : "已结束"}</span>`;
      const pct = Math.max(4, Math.min(100, Math.round((count / CONV_MSG_CAP) * 100)));
      return `
    <button type="button" class="ch-conv-item${c.status === "closed" ? " is-closed" : ""}" data-act="openConv" data-id="${esc(c.id)}">
      <span class="ch-conv-ava">${icon(isDm ? "user" : "message")}</span>
      <span class="ch-conv-main">
        <span class="ch-conv-title">${esc(c.title || (isDm ? "私信会话" : "帖子"))}${kindTag}${roleTag}${statusTag}</span>
        <span class="ch-conv-sub">与${counterpart}对话 · 最后活跃 ${relTime(Math.floor((c.updated_at || c.created_at || 0) / 1000))}</span>
        <span class="ch-conv-meter"><i class="${near ? "near" : ""}" style="width:${pct}%"></i></span>
      </span>
      <span class="ch-conv-side">
        <b class="ch-conv-count${near ? " near" : ""}">${count}<i>/</i>${CONV_MSG_CAP}</b>
        <span class="ch-conv-side-hint">${c.status === "open" ? (near ? "即将用完" : "条消息额度") : "已关闭"}</span>
        <span class="ch-card-arrow">${icon("arrowRight")}</span>
      </span>
    </button>`;
    }).join("")}
  </div>
</section>`;
}

async function openConv(id) {
  S.view = "conv"; S.convId = id; S.convDetail = null;
  render();
  const r = await api.getConversation(id);
  if (!r.ok) { S.convDetail = { error: r.error || "会话加载失败" }; render(); return; }
  S.convDetail = r.data;
  render();
}

/* ═══════════════════════════ 视图：我的收藏 ═══════════════════════════ */
async function loadFavs() {
  const r = await api.myFavorites();
  if (!r.ok) { S.favList = []; toast(r.error || "收藏加载失败"); render(); return; }
  S.favList = r.data.items || [];
  render();
}

const FAV_STATUS_CN = { pending: "审核中", closed: "已下架", expired: "已过期", rejected: "已拒绝" };

function renderFavView() {
  if (!S.favList) {
    return `<section class="view active"><div class="ch-empty"><div class="ch-empty-t">加载中…</div></div></section>`;
  }
  if (!S.favList.length) {
    return `
<section class="view active">
  <h1 class="page-title">我的收藏</h1>
  <p class="page-sub">收藏感兴趣的帖子，方便回头查看（仅自己可见）</p>
  <div class="ch-empty">
    <div class="ch-empty-ic">${icon("star")}</div>
    <div class="ch-empty-t">暂无收藏</div>
    <div class="ch-empty-s">在帖子详情页点击「收藏」即可加入</div>
  </div>
</section>`;
  }
  return `
<section class="view active">
  <h1 class="page-title">我的收藏</h1>
  <p class="page-sub">共 ${S.favList.length} 条 · 帖子下架/成交后收藏会保留并标记状态</p>
  <div class="ch-conv-list">
    ${S.favList.map((f) => {
      const open = f.status === "open";
      const bd = boardOf(f.board);
      const price = open && f.extra && bd ? f.extra[bd.priceKey] : "";
      const statusChip = open
        ? `<span class="ch-conv-status st-open">展示中</span>`
        : `<span class="ch-conv-status st-closed">${FAV_STATUS_CN[f.status] || esc(f.status)}</span>`;
      /* open 整卡可进详情；失效帖点击仅提示（后端对非本人非 open 详情返回 404） */
      return `
    <div class="ch-conv-item${open ? "" : " is-closed"}" ${open ? `data-act="openDetail" data-id="${esc(f.id)}" role="button" tabindex="0"` : `data-act="favDead"`}>
      <span class="ch-conv-ava">${icon("star")}</span>
      <span class="ch-conv-main">
        <span class="ch-conv-title">${esc(f.title || "帖子")}${statusChip}</span>
        <span class="ch-conv-sub">#${f.post_no ?? "—"} · ${esc(bd ? bd.label : f.board)} · 收藏于 ${relTime(Math.floor((f.favorited_at || 0) / 1000))}</span>
      </span>
      <span class="ch-conv-side">
        <b class="ch-conv-count${open ? "" : " dim"}">${open ? esc(price || "面议") : "已失效"}</b>
        <span class="ch-conv-side-hint">${open ? "点击查看" : "下架/成交保留"}</span>
        <button type="button" class="btn sm ghost danger" data-act="favRemove" data-id="${esc(f.id)}">取消收藏</button>
      </span>
    </div>`;
    }).join("")}
  </div>
</section>`;
}

/* 消息图片（images_json 字符串 → 外链数组；防御解析，兼容历史消息） */
function msgImages(m) {
  try {
    const arr = m.images_json ? JSON.parse(m.images_json) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

/* 图片 URL 行识别：整行仅为 https 图片外链（图片扩展名或已知图床域名）。
   聊天图片方案：用户在 111666.best 等公益图床自行上传后，把外链 URL 粘贴进消息框 */
const IMG_URL_EXT_RE = /^https:\/\/[^\s<>"']+\.(?:png|jpe?g|gif|webp|bmp)(?:\?[^\s<>"']*)?$/i;
const IMG_URL_HOSTS = ["111666.best", "graph.org", "telegra.ph", "i.ibb.co", "files.catbox.moe", "i.imgur.com", "i.loli.net"];
function isImgUrlLine(line) {
  const s = line.trim();
  if (!/^https:\/\//.test(s) || /[\s<>"']/.test(s.slice(8))) return false;
  if (IMG_URL_EXT_RE.test(s)) return true;
  try { return IMG_URL_HOSTS.includes(new URL(s).hostname); } catch { return false; }
}
/* 正文行解析：图片 URL 行 → 缩略图（≤6 张），其余行保留为文本 */
function splitMsgBody(body) {
  const imgs = [];
  const lines = [];
  for (const raw of String(body || "").split("\n")) {
    if (imgs.length < 6 && isImgUrlLine(raw)) imgs.push(raw.trim());
    else lines.push(raw);
  }
  return { text: lines.join("\n").replace(/^\n+|\n+$/g, ""), imgs };
}

function renderConvView() {
  const back = `<button class="btn ghost sm" data-act="backConvs"><i data-icon="back"></i>会话列表</button>`;
  if (!S.convDetail) {
    return `<section class="view active"><div class="ch-conv-head">${back}</div><div class="ch-empty"><div class="ch-empty-t">加载中…</div></div></section>`;
  }
  if (S.convDetail.error) {
    return `<section class="view active"><div class="ch-conv-head">${back}</div>
      <div class="ch-empty"><div class="ch-empty-t">${esc(S.convDetail.error)}</div></div></section>`;
  }
  const cv = S.convDetail.conversation || {};
  const mine = S.convDetail.myRole || "seller";
  const isOwnerWatch = mine === "owner"; // 站长治理视角：只读，不显示输入框，不代读通知
  const msgs = (S.convDetail.messages || []).map((m) => {
    const isMine = !isOwnerWatch && m.sender_role === mine;
    const who = isOwnerWatch
      ? (m.sender_role === "seller" ? "发布者" : esc(cv.buyer_name || "买家"))
      : (m.sender_role === "seller" ? (isMine ? "我（卖家）" : "发布者") : (isMine ? "我（买家）" : esc(cv.buyer_name || "买家")));
    const parsed = splitMsgBody(m.body);
    const imgs = [...new Set([...msgImages(m), ...parsed.imgs])]; // 历史 images_json + 正文图片 URL 行，去重
    return `
    <div class="ch-msg-row ${isMine ? "mine" : ""}">
      <div class="ch-msg-bubble">
        <div class="ch-msg-meta">${who} · ${relTime(Math.floor((m.created_at || 0) / 1000))}</div>
        ${parsed.text ? `<div class="ch-msg-body">${esc(parsed.text).replace(/\n/g, "<br>")}</div>` : ""}
        ${imgs.length ? `<div class="ch-msg-imgs">${imgs.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer" title="查看原图"><img src="${esc(u)}" alt="消息图片" loading="lazy" referrerpolicy="no-referrer"></a>`).join("")}</div>` : ""}
      </div>
    </div>`;
  }).join("");
  const count = (cv.msg_count || 0);
  const remain = CONV_MSG_CAP - count;
  const canReply = !isOwnerWatch && cv.status === "open" && count < CONV_MSG_CAP;
  /* 额度提醒条：常驻显示双方合计上限；剩 20 条起转琥珀高亮并引导线下沟通 */
  const quotaBar = `<div class="ch-conv-quota${remain <= 20 ? " warn" : ""}">${icon("info")} <span>双方合计最多 <b>${CONV_MSG_CAP}</b> 条消息 · 已用 <b>${count}</b> 条${remain <= 20 ? `，仅剩 <b>${remain}</b> 条，请尽快交换联系方式转为线下沟通` : ""}</span></div>`;
  const replyArea = isOwnerWatch
    ? `<div class="ch-conv-closed">${icon("shield")} 站长治理视角（只读）——仅用于核实举报内容，对话双方不可见此提示</div>`
    : cv.status !== "open"
      ? `<div class="ch-conv-closed">${icon("info")} 会话已结束（帖子已关闭或成交下架）</div>`
      : canReply
        ? `${quotaBar}
        <div class="ch-conv-reply">
          <button type="button" class="btn ghost ch-conv-imgbtn" data-act="convImgGuide" title="发送图片：使用外部图床外链（点击查看指引）"><i data-icon="image"></i></button>
          <textarea class="inp" id="chConvInput" rows="2" maxlength="500" placeholder="回复对方…（图片：粘贴图床外链 URL，Enter 发送 / Shift+Enter 换行）"></textarea>
          <button class="btn primary" data-act="convSend"><i data-icon="send"></i>发送</button>
        </div>`
        : `<div class="ch-conv-closed">${icon("info")} 会话已达 ${CONV_MSG_CAP} 条消息上限，无法继续回复</div>`;
  return `
<section class="view active ch-conv-page">
  <div class="ch-conv-head">
    ${back}
    <div class="ch-conv-headinfo">
      <b>${esc(cv.title || "帖子")}</b>
      <span>${isOwnerWatch ? "治理查看" : (mine === "buyer" ? "发布者" : esc(cv.buyer_name || "买家"))} · ${count}/${CONV_MSG_CAP} 条 · ${cv.status === "open" ? "进行中" : "已结束"}</span>
    </div>
    ${!isOwnerWatch ? `<button type="button" class="btn ghost sm" data-act="convReport" data-id="${esc(cv.id)}" data-uid="${esc(cv.other_uid || "")}" data-title="${esc(cv.title || "")}"><i data-icon="alertTriangle"></i>举报</button>` : ""}
  </div>
  <div class="ch-conv-retain">${icon("info")} <span>聊天记录（含图片链接）仅保留 <b>60 天</b>，到期自动清理，请及时保存需要留存的截图</span></div>
  <div class="panel ch-msgs">${msgs || '<div class="ch-empty-s">暂无消息</div>'}</div>
  ${replyArea}
</section>`;
}

async function sendConvMsg() {
  const ta = $("chConvInput");
  const text = ta ? ta.value.trim() : "";
  if (!text) { toast("请输入回复内容（图片请粘贴图床外链 URL）"); return; }
  const r = await api.replyMessage(S.convId, { body: text });
  if (!r.ok) {
    if (r.code === 40902) toast("会话已结束，无法继续回复");
    else if (r.code === 40903) toast(`会话已达 ${CONV_MSG_CAP} 条消息上限`);
    else toast(r.error || "发送失败");
    return;
  }
  toast("已发送");
  await openConv(S.convId); // 重拉消息流
}

function renderMeView() {
  const mp = S.myPostsFull;
  const total = (mp.pending || []).length + (mp.open || []).length + (mp.closed || []).length + (mp.expired || []).length + (mp.rejected || []).length;
  if (!total) {
    return `
<section class="view active">
  <h1 class="page-title">我的发布</h1>
  <p class="page-sub">你在本账号下发布的所有信息</p>
  <div class="ch-empty">
    <div class="ch-empty-ic">${icon("package")}</div>
    <div class="ch-empty-t">还没有发布过信息</div>
    <div class="ch-empty-s">点「发布信息」发一条试试；提交后进入待审核</div>
    <button class="btn primary ch-mt" data-act="newPost"><i data-icon="plus"></i>发布信息</button>
  </div>
</section>`;
  }
  const bucket = (arr, label, desc, cls) => `
  <div class="panel ch-me-bucket">
    <h2 class="panel-title">${label} <span class="ch-nav-count ${cls || ""}">${arr.length}</span> <span class="panel-sub">${desc}</span></h2>
    ${arr.length ? arr.map(meRowHTML).join("") : '<div class="ch-me-empty">暂无</div>'}
  </div>`;
  return `
<section class="view active">
  <h1 class="page-title">我的发布</h1>
  <p class="page-sub">你在本账号下发布的所有信息</p>
  ${bucket(mp.pending || [], "待审核", "最多同时 3 条 · 审核通过后公开展示", "warn")}
  ${bucket(mp.open || [], "展示中", "到期自动下架，可提前标记成交")}
  ${bucket(mp.closed || [], "已成交", "你主动标记为成交")}
  ${bucket(mp.expired || [], "已过期", "到期未续，自动下架")}
  ${bucket(mp.rejected || [], "已拒绝", "修改后可重新提交")}
</section>`;
}

function meRowHTML(p) {
  const board = boardOf(p.board);
  const reason = p.status === "rejected" && p.rejectReason
    ? `<div class="ch-me-reason">${icon("info")} 拒绝原因：${esc(p.rejectReason)}</div>` : "";
  return `
  <div class="ch-me-row">
    <div class="ch-me-main">
      <b>${esc(p.title)}</b>
      <span class="ch-me-meta">${esc(board ? board.label : p.board)} · ${esc(CARRIER_LABEL(p.carrier))} · ${esc(p.province)} ${esc(p.city)} · ${relTime(p.createdAt)}</span>
      ${reason}
    </div>
    <div class="ch-me-ops">${myPostOpsHTML(p)}</div>
  </div>`;
}

/* ═══════════════════════════ 视图：模拟审核（dev） ═══════════════════════════ */
function renderReviewView() {
  const pending = S.posts.filter((p) => p.status === "pending").sort((a, b) => b.createdAt - a.createdAt);
  const rejected = S.posts.filter((p) => p.status === "rejected").sort((a, b) => b.createdAt - a.createdAt);
  return `
<section class="view active">
  <h1 class="page-title">模拟审核 <span class="ch-dev-badge">DEV</span></h1>
  <p class="page-sub">仅开发态显示（?dev=1）· 模拟管理台审核能力：通过即公开展示</p>

  <div class="panel">
    <h2 class="panel-title"><i data-icon="shield"></i>待审核队列 <span class="ch-nav-count warn">${pending.length}</span></h2>
    ${pending.length ? pending.map(reviewRowHTML).join("") : '<div class="ch-me-empty">队列为空</div>'}
  </div>

  <div class="panel">
    <h2 class="panel-title"><i data-icon="x"></i>已拒绝（本会话） <span class="ch-nav-count">${rejected.length}</span></h2>
    ${rejected.length ? rejected.map(reviewRowHTML).join("") : '<div class="ch-me-empty">暂无</div>'}
  </div>
</section>`;
}

function reviewRowHTML(p) {
  const board = boardOf(p.board);
  const isPending = p.status === "pending";
  return `
  <div class="ch-review-row" data-rid="${p.id}">
    <div class="ch-review-info">
      <div class="ch-review-title">
        <span class="ch-chip ch-chip-carrier cc-${p.carrier}">${esc(CARRIER_LABEL(p.carrier))}</span>
        <b>${esc(p.title)}</b>
        <span class="ch-me-meta">${esc(board ? board.label : p.board)} · ${esc(p.province)} ${esc(p.city)} · ${relTime(p.createdAt)} 提交</span>
      </div>
      <div class="ch-review-descr">${esc(p.descr).slice(0, 120)}${p.descr.length > 120 ? "…" : ""}</div>
      ${p.rejectReason ? `<div class="ch-me-reason">${icon("info")} 拒绝原因：${esc(p.rejectReason)}</div>` : ""}
    </div>
    ${isPending
      ? `<div class="ch-review-ops">
          <button class="btn sm success" data-act="approvePost" data-id="${p.id}"><i data-icon="check"></i>通过</button>
          <button class="btn sm ghost" data-act="rejectToggle" data-id="${p.id}"><i data-icon="x"></i>拒绝</button>
         </div>
         <div class="ch-reject-input" hidden>
           <input type="text" class="inp" placeholder="拒绝原因（会通知发布者）" maxlength="120">
           <button class="btn sm primary" data-act="rejectConfirm" data-id="${p.id}">确认拒绝</button>
         </div>`
      : `<div class="ch-review-ops"><span class="ch-chip chip-del">已拒绝</span></div>`}
  </div>`;
}

/* ═══════════════════════════ 渲染入口 ═══════════════════════════ */
function render() {
  const host = $("chContent");
  if (!host) return;
  if (S.view === "overview") host.innerHTML = renderOverviewView();
  else if (S.view === "board") host.innerHTML = renderBoardView();
  else if (S.view === "detail") host.innerHTML = renderDetailView();
  else if (S.view === "form") { host.innerHTML = renderFormView(); syncShowIf(); }
  else if (S.view === "me") host.innerHTML = renderMeView();
  else if (S.view === "convs") host.innerHTML = renderConvsView();
  else if (S.view === "conv") host.innerHTML = renderConvView();
  else if (S.view === "fav") host.innerHTML = renderFavView();
  else if (S.view === "review") host.innerHTML = renderReviewView();
  renderNav();
  renderTopbar();
  mountIcons($("cardhubRoot"));
  initFX($("cardhubRoot"));
  closeSidebar();
  if (S.view === "board" || S.view === "overview") window.scrollTo(0, 0);
}

function renderTopbar() {
  const slot = document.getElementById("chAuthSlot");
  if (slot) mountAuth(slot);
}

function refreshListOnly() {
  /* 兼容入口：触发服务端重载当前页后局部刷新列表区 */
  loadBoardPage().then(renderListRegion);
}

/* ─────────────── 侧边栏抽屉（窄屏） ─────────────── */
function openSidebar() {
  const sb = $("chSidebar"), ov = $("chSidebarOverlay");
  if (sb) sb.classList.add("open");
  if (ov) ov.classList.add("show");
}
function closeSidebar() {
  const sb = $("chSidebar"), ov = $("chSidebarOverlay");
  if (sb) sb.classList.remove("open");
  if (ov) ov.classList.remove("show");
}

/* ─────────────── 事件 ─────────────── */
let searchTimer = 0;

async function onRootClick(e) {
  /* 证明材料原图（无 data-act）：blob 加载后新窗口打开 */
  const proofA = e.target.closest("[data-proofopen]");
  if (proofA) {
    const [pid, key] = (proofA.dataset.proofopen || "").split("|");
    if (pid && key) {
      api.proofBlobUrl(pid, key).then((u) => window.open(u, "_blank")).catch(() => toast("图片加载失败"));
    }
    return;
  }
  /* 可见范围卡片（无 data-act）点击 → 激活 + 联动直接联系方式必填区。
     必须在 data-act 拦截之前处理，否则卡片点击被 return 吞掉 */
  const visCard = e.target.closest(".ch-policy-card[data-vis]");
  if (visCard) {
    const v = visCard.dataset.vis;
    const grid = $("chVisGrid");
    if (grid) grid.querySelectorAll(".ch-policy-card").forEach((c) => c.classList.toggle("active", c === visCard));
    const radio = visCard.querySelector("input[type=" + "radio]");
    if (radio) radio.checked = true;
    S.formVis = v;
    const chatRow = $("chChatRow");
    if (chatRow) chatRow.classList.toggle("dim", v === "hidden");
    if (chatRow) chatRow.classList.remove("error");
    return;
  }
  const actEl = e.target.closest("[data-act]");
  if (!actEl) return;
  const a = actEl.dataset.act;

  if (a === "ovBoard") {
    const id = actEl.dataset.id;
    if (id && chTabs) chTabs.activate("board:" + id);
    return;
  }
  if (a === "openDetail") {
    /* 市集板块：点击卡片开图文弹窗（Markdown 渲染），不走详情页 */
    const clickBoard = actEl.dataset.board || (S.posts.find((p) => p.id === actEl.dataset.id) || {}).board;
    if (clickBoard === "market") { openMarketModal(actEl.dataset.id); return; }
    S.view = "detail"; S.detailId = actEl.dataset.id;
    S.detailPost = null;
    render();
    // 异步拉取详情
    const r = await api.getPost(S.detailId);
    if (r.ok) { S.detailPost = adaptPost(r.data); render(); }
    else toast(r.error || "详情加载失败");
    return;
  }
  if (a === "backBoard") { S.view = "board"; render(); return; }
  /* 会话收件箱：打开对话 / 返回列表 / 发送回复 / 图片引导弹窗（外链图床方案） */
  if (a === "openConv") { openConv(actEl.dataset.id); return; }
  if (a === "backConvs") { S.view = "convs"; S.convDetail = null; S.convList = null; render(); loadConvs(); return; }
  if (a === "convSend") { withPending(actEl, () => sendConvMsg()); return; }
  if (a === "convImgGuide") { openImageHostGuide(); return; }
  if (a === "convReport") {
    /* 会话举报：预填工单（分类其他，机制同情报卡片反馈），管理组凭工单处置 */
    const id = actEl.dataset.id || "";
    const uid = actEl.dataset.uid || "";
    const title = actEl.dataset.title || "";
    if (!confirm(`将前往工单中心举报该会话${title ? `「${title}」` : ""}，由管理组核实处置。继续？`)) return;
    try {
      sessionStorage.setItem("chinamnos_ticket_prefill", JSON.stringify({
        category: "其他",
        source: "cardhub",
        title: `会话举报：${title}`.slice(0, 60),
        content: `会话编号：${id}\n对方用户：${uid || "（见会话内信息）"}\n举报说明：\n`,
        banner: "已带入会话举报预设信息（来自跳蚤市集会话），请补充举报说明后提交",
      }));
    } catch { /* sessionStorage 不可用时跳转后手填 */ }
    Shell.navigate("/ticket");
    return;
  }
  // 点发布者头像/名称 → 公开资料卡（昵称/UID/主动公开的联系方式）
  if (a === "authorCard") { Auth.showProfileCard(actEl.dataset.id); return; }
  if (a === "newPost") {
    if (!S.user) { toast("请先登录"); openLogin(); return; }
    S.view = "form"; S.formBoard = S.board; S.formVis = "public"; S.formAllowChat = false; S.formAllowRelay = false; S.formMulti = {};
    S.formTrade = []; S.formTags = {}; S.formPhoneMaskDirty = false;
    S.formProofs = []; S.formProofPublic = false; S.formReviewMode = "proof"; S.formReviewAdmin = "";
    S.formEditId = null; S.formEditOrig = null;
    seedFormContacts();
    render(); return;
  }

  /* 登录（委托共享 auth 模块） */
  if (a === "openLogin") { Auth.openLogin(); return; }
  if (a === "logout") { Auth.logout(); return; }

  if (a === "formBoard") { switchFormBoard(actEl.dataset.board); return; }
  if (a === "submitPost") { withPending(actEl, () => collectAndSubmit()); return; }
  /* 联系方式多行列表：添加/删除行（5 种渠道，同渠道后端会去重） */
  if (a === "addContact") {
    if ((S.formContacts || []).length >= 5) { toast("最多添加 5 条联系方式"); return; }
    (S.formContacts || (S.formContacts = [])).push({ channel: "qq", value: "" });
    renderContactRows();
    return;
  }
  if (a === "delContact") {
    const idx = Number(actEl.dataset.cidx);
    if (S.formContacts && idx >= 0 && idx < S.formContacts.length) {
      S.formContacts.splice(idx, 1);
      renderContactRows();
    }
    return;
  }
  if (a === "delProof") {
    const idx = Number(actEl.dataset.pidx);
    if (S.formProofs && idx >= 0 && idx < S.formProofs.length) {
      S.formProofs.splice(idx, 1);
      renderProofThumbs();
    }
    return;
  }
  /* multi 字段（多条规格）：添加/删除行 */
  if (a === "addMulti") {
    const key = actEl.dataset.mkey;
    const max = Number(actEl.dataset.max) || 4;
    const rows = S.formMulti[key] || (S.formMulti[key] = []);
    if (rows.length >= max) { toast(`最多 ${max} 条`); return; }
    rows.push({ v: "", t: [] });
    renderMultiField(key);
    return;
  }
  if (a === "delMulti") {
    const key = actEl.dataset.mkey;
    const idx = Number(actEl.dataset.midx);
    const rows = S.formMulti[key] || [];
    if (rows.length <= 1) { toast("至少保留一条"); return; }
    rows.splice(idx, 1);
    renderMultiField(key);
    return;
  }
  if (a === "clearFilter") {
    S.filters = { carrier: "", province: "", city: "", q: "" };
    S.listPage = 1;
    render();
    loadBoardPage().then(renderListRegion);
    return;
  }
  /* 列表翻页（服务端分页） */
  if (a === "listPage") {
    const pg = Number(actEl.dataset.pg);
    if (!pg || pg < 1) return;
    S.listPage = pg;
    const el = $("chList");
    if (el) el.innerHTML = `<div class="ch-empty"><div class="ch-empty-t">加载中…</div></div>`;
    loadBoardPage().then(() => {
      renderListRegion();
      window.scrollTo(0, 0);
    });
    return;
  }
  if (a === "copyVal") {
    const v = actEl.dataset.val || "";
    if (navigator.clipboard) navigator.clipboard.writeText(v).then(() => toast("已复制：" + v));
    return;
  }
  if (a === "soonLogin") { openLogin(); return; }
  if (a === "soonChat") { startConversation(); return; }
  if (a === "soonRelay") { openRelayForm(); return; }

  /* 我的发布 */
  if (a === "delPost") {
    const id = actEl.dataset.id;
    const r = await api.deletePost(id);
    if (!r.ok) { toast(r.error || "删除失败"); return; }
    S.posts = S.posts.filter((p) => p.id !== id);
    S.myIds.delete(id);
    toast("已删除");
    render();
    return;
  }

  /* 我的帖子管理动作：成交 / 下架 / 删除 / 编辑重提（列表行与详情页操作条共用） */
  if (a === "postClose") {
    const id = actEl.dataset.id;
    if (!(await chConfirm("确认该信息已成交？帖子将立即从公开列表下架，并计入你的完成帖数。", "已成交，下架"))) return;
    const r = await api.closePost(id);
    if (!r.ok) { toast(ACT_ERR_CN[r.error] || "操作失败，请刷新后重试"); return; }
    toast("已标记成交");
    await loadMyPosts(); render();
    return;
  }
  if (a === "postWithdraw") {
    const id = actEl.dataset.id;
    if (!(await chConfirm("下架后公开列表将不可见（对话同时关闭），之后可在「我的发布」删除。确定下架？", "确定下架"))) return;
    await withPending(actEl, async () => {
      const r = await api.withdrawPost(id);
      if (!r.ok) { toast(ACT_ERR_CN[r.error] || "操作失败，请刷新后重试"); return; }
      toast("已下架");
      await loadMyPosts(); render();
    });
    return;
  }
  if (a === "postDelete") {
    const id = actEl.dataset.id;
    if (!(await chConfirm("删除后不可恢复，帖子关联的证明材料将一并删除。确定删除？", "确定删除"))) return;
    await withPending(actEl, async () => {
      const r = await api.deletePost(id);
      if (!r.ok) { toast(ACT_ERR_CN[r.error] || "操作失败，请刷新后重试"); return; }
      S.myIds.delete(id);
      toast("已删除");
      await loadMyPosts(); render();
    });
    return;
  }
  if (a === "postEdit") {
    const id = actEl.dataset.id;
    let p = null;
    for (const k of ["pending", "open", "closed", "expired", "rejected"]) {
      p = (S.myPostsFull[k] || []).find((x) => x.id === id);
      if (p) break;
    }
    if (!p) { toast("帖子数据未加载，请刷新后重试"); return; }
    enterEditMode(p);
    return;
  }
  /* 管理员在详情页快速下架违规帖（按钮仅管理组可见；后端 adminClosePost 走 guard('admin') 强校验） */
  if (a === "staffClose") {
    const id = actEl.dataset.id;
    if (!(await chConfirm("以管理组身份下架该帖子？下架后公开列表不可见（管理员下架）。", "确定下架"))) return;
    const r = await api.adminClosePost(id);
    if (!r.ok) { toast(r.error === "NOT_OPEN" ? "帖子已不在展示中" : (r.error || "操作失败")); return; }
    toast("已下架（管理员下架）");
    S.view = "board";
    await loadFromApi();
    render();
    return;
  }

  /* 毛遂自荐（申请成为卡商担保人）：确认=用户许可 → sessionStorage 交接标记 → 工单中心读取并
     预填「毛遂自荐」分类 + 站长配置的申请模板（预填仅由本按钮触发，未来其他职位用其他 type） */
  if (a === "selfRecommend") {
    if (!S.user) { toast("请先登录后再毛遂自荐"); Auth.openLogin(); return; }
    const okGo = await chConfirm("毛遂自荐将前往工单中心：自动选择「毛遂自荐」分类，并带入「卡商担保人」申请模板，你可修改后提交。\n\n确认前往？", "确认前往");
    if (!okGo) return;
    try { sessionStorage.setItem("chinamnos_ticket_apply", JSON.stringify({ type: "cardhub_guarantor" })); } catch { /* */ }
    Shell.navigate("/ticket");
    return;
  }

  /* 精华置顶三操作（按钮仅管理组可见；后端 pin/unpin/bump 走 guard('admin') 强校验） */
  if (a === "pinAdd" || a === "pinRemove" || a === "pinBump") {
    const id = actEl.dataset.id;
    if (a === "pinAdd") {
      if (!(await chConfirm("精华置顶后，该帖将在跳蚤市集列表最前展示；多个置顶帖按最后置顶的排最前。确定置顶？", "确定置顶"))) return;
    } else if (a === "pinRemove") {
      if (!(await chConfirm("取消置顶后，该帖恢复按发布时间排序。确定取消？", "确定取消"))) return;
    }
    const r = a === "pinAdd" ? await api.pinPost(id)
      : a === "pinRemove" ? await api.unpinPost(id)
      : await api.pinBump(id);
    if (!r.ok) {
      const cn = { FORBIDDEN: "需要管理组权限", NOT_OPEN: "帖子已不在展示中", NOT_PINNED: "该帖未置顶" };
      toast(cn[r.error] || r.error || "操作失败");
      return;
    }
    if (S.detailPost && S.detailPost.id === id) S.detailPost.pinnedAt = r.data.pinned_at;
    toast(a === "pinAdd" ? "已精华置顶" : a === "pinRemove" ? "已取消置顶" : "已重排至置顶最前");
    if (S.view === "detail") render();
    loadFromApi(); // 刷新列表置顶排序（后台进行，不阻塞当前页）
    return;
  }

  /* 收藏：详情页 toggle（登录用户；后端幂等返回最新状态） */
  if (a === "favToggle") {
    const id = actEl.dataset.id;
    await withPending(actEl, async () => {
      const r = await api.toggleFavorite(id);
      if (!r.ok) {
        toast(r.error === "NOT_OPEN" ? "帖子已不在展示中，无法收藏" : r.error === "UNAUTHORIZED" ? "请先登录" : (r.error || "操作失败"));
        return;
      }
      if (S.detailPost && S.detailPost.id === id) S.detailPost.favorited = r.data.favorited;
      toast(r.data.favorited ? "已加入收藏" : "已取消收藏");
      render();
    });
    return;
  }
  /* 收藏列表：移除单条（toggle 语义：当前已收藏 → 移除） */
  if (a === "favRemove") {
    const id = actEl.dataset.id;
    const r = await api.toggleFavorite(id);
    if (!r.ok) { toast(r.error || "操作失败"); return; }
    toast("已取消收藏");
    await loadFavs();
    return;
  }
  /* 收藏列表：点击已失效帖（下架/成交/过期）——保留记录但不可进详情 */
  if (a === "favDead") {
    toast("该帖已下架或成交，无法查看详情");
    return;
  }

  /* 模拟审核 */
  if (a === "approvePost") {
    const p = S.posts.find((x) => x.id === actEl.dataset.id);
    if (p) {
      p.status = "open";
      p.expiresAt = Math.floor(Date.now() / 1000) + p.ttlDays * 86400;
      toast("已通过，帖子公开展示");
      render();
    }
    return;
  }
  if (a === "rejectToggle") {
    const row = actEl.closest(".ch-review-row");
    if (row) {
      const box = row.querySelector(".ch-reject-input");
      if (box) box.hidden = !box.hidden;
    }
    return;
  }
  if (a === "rejectConfirm") {
    const row = actEl.closest(".ch-review-row");
    const input = row ? row.querySelector(".ch-reject-input input") : null;
    const reason = input ? input.value.trim() : "";
    if (!reason) { if (input) { input.classList.add("error"); input.focus(); } return; }
    const p = S.posts.find((x) => x.id === actEl.dataset.id);
    if (p) {
      p.status = "rejected";
      p.rejectReason = reason;
      toast("已拒绝并通知发布者（模拟）");
      render();
    }
    return;
  }

  /* 策略卡片点击 → 激活 + 联动聊天必填区（处理逻辑已上移至 data-act 拦截之前，此处仅防重复注册残留） */
  void 0;
}

/* 交易方式勾选联动：更新互动渠道「站长中转」开关锁定态；取消「站点担保」时自动撤销「站长中转」
   （回退判定以 checkbox 实际选中态为准，不依赖 S.formAllowRelay，避免状态漂移漏清理） */
function updateChannelGate() {
  const siteOn = (S.formTrade || []).includes("site");
  const grid = $("chChannelGrid");
  if (!grid) return;
  const relayCard = grid.querySelector('[data-channel="relay"]');
  const relayInput = relayCard ? relayCard.querySelector("input") : null;
  if (relayCard) {
    relayCard.classList.toggle("locked", !siteOn);
    if (relayInput) relayInput.disabled = !siteOn;
    const desc = relayCard.querySelector(".ch-trade-desc");
    if (desc) desc.textContent = siteOn ? "通过站长转交交易意向，保护双方隐私" : "需先在交易方式中勾选「站点担保」";
    if (desc) desc.classList.toggle("warn", !siteOn);
  }
  if (!siteOn && relayInput && relayInput.checked) {
    S.formAllowRelay = false;
    if (relayCard) relayCard.classList.remove("active");
    relayInput.checked = false;
    toast("已取消「站点担保」，互动渠道「站长中转」已一并关闭");
  }
}

/* 市集弹窗：market 板块卡片点击 → 图文弹窗（md.js 渲染 Markdown，链接可点图片直显）。
   数据走 getPost 详情接口；收藏按钮本地直连 toggleFavorite（弹窗不在根委托容器内） */
async function openMarketModal(id) {
  const mask = document.createElement("div");
  mask.className = "ch-confirm-mask mk-mask";
  mask.innerHTML = `
    <div class="ch-confirm mk-modal" role="dialog" aria-modal="true">
      <div class="mk-body"><div class="empty" style="padding:32px;text-align:center">加载中…</div></div>
      <div class="ch-confirm-btns"><button class="btn ghost" data-c="close">关闭</button></div>
    </div>`;
  document.body.appendChild(mask);
  const close = () => { mask.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  mask.addEventListener("mousedown", (e) => { if (e.target === mask) close(); });
  mask.querySelector('[data-c="close"]').addEventListener("click", close);

  const r = await api.getPost(id);
  const bodyEl = mask.querySelector(".mk-body");
  if (!r.ok) {
    bodyEl.innerHTML = `<div class="empty" style="padding:32px;text-align:center">${esc(r.error || "加载失败")}</div>`;
    return;
  }
  const d = r.data;
  const x = d.extra && typeof d.extra === "object" ? d.extra : {};
  const scope = x.market_scope === "综合" ? "综合" : "单一";
  const badges = `<span class="mk-badge${scope === "综合" ? " mk-all" : ""}">${esc(scope)}</span>` +
    (x.market_kind ? `<span class="mk-badge mk-kind">${esc(x.market_kind)}</span>` : "");
  bodyEl.innerHTML = `
    <div class="mk-badges">${badges}</div>
    <h3 class="mk-title">${esc(d.title || "")}</h3>
    <div class="mk-md">${mdToSafeHtml(String(x.market_body || ""), { nofollow: true })}</div>
    <div class="mk-meta">发布于 ${relTime(Math.floor((d.created_at || 0) / 1000))}${d.author ? ` · ${esc(d.author.nickname || "用户")}` : ""}</div>
    ${Auth.isLoggedIn() ? `<div class="mk-actions"><button type="button" class="btn ghost sm mk-fav"><i data-icon="star"></i>收藏</button></div>` : ""}`;
  mountIcons(bodyEl);
  const favEl = mask.querySelector(".mk-fav");
  if (favEl) {
    let favState = !!d.favorited;
    const paint = () => {
      favEl.classList.toggle("on", favState);
      favEl.innerHTML = `<i data-icon="${favState ? "starFill" : "star"}"></i>${favState ? "已收藏" : "收藏"}`;
      mountIcons(favEl);
    };
    if (favState) paint();
    favEl.addEventListener("click", async () => {
      favEl.disabled = true;
      const rr = await api.toggleFavorite(id);
      favEl.disabled = false;
      if (rr.ok && rr.data) { favState = !!rr.data.favorited; paint(); toast(rr.data.favorited ? "已加入收藏" : "已取消收藏"); }
      else toast(rr.error || "操作失败");
    });
  }
}

function onRootChange(e) {
  const t = e.target;
  /* 证明材料方式切换（proof=上传照片 / admin=指定管理员）：重渲染该区 */
  if (t.name === "chProofMode") {
    S.formReviewMode = t.value;
    const row = $("chProofRow");
    if (row) { row.innerHTML = proofFormHTML(); mountIcons(row); }
    return;
  }
  /* 前端文件来源等 select 触发的条件显隐（市集交易物范围 → 品类输入显隐） */
  if (t.dataset && t.dataset.showif !== undefined) {
    syncShowIf();
    return;
  }
  /* 管理员审核模式：指定的审核人 */
  if (t.id === "chReviewAdmin") {
    S.formReviewAdmin = t.value;
    return;
  }
  /* 证明材料：选图（前端压缩入草稿）与公开开关 */
  if (t.id === "chProofFile") {
    handleProofFiles(t.files);
    t.value = "";
    return;
  }
  if (t.id === "chProofPublic") {
    S.formProofPublic = !!t.checked;
    return;
  }
  /* 联系方式行：渠道下拉切换同步草稿 */
  if (t.dataset && t.dataset.cch !== undefined) {
    const idx = Number(t.dataset.cch);
    if (S.formContacts && S.formContacts[idx]) S.formContacts[idx].channel = t.value;
    return;
  }
  /* tags 类型字段（开车类型/号码特征等）多选勾选：同步草稿 + 条件显示字段实时显隐 */
  const ttag = t.dataset ? t.dataset.ttag : undefined;
  if (ttag !== undefined && t.dataset.tkey) {
    const cur = S.formTags[t.dataset.tkey] || [];
    S.formTags[t.dataset.tkey] = t.checked ? Array.from(new Set([...cur, ttag])) : cur.filter((x) => x !== ttag);
    const lab = t.closest(".ch-mtag");
    if (lab) lab.classList.toggle("on", !!t.checked);
    syncShowIf();
    return;
  }
  /* 交易方式多选勾选：同步草稿 + 「站点担保」↔「站长中转」联动 */
  const tradeId = t.dataset ? t.dataset.tradeId : undefined;
  if (tradeId) {
    const on = !!t.checked;
    S.formTrade = on
      ? Array.from(new Set([...(S.formTrade || []), tradeId]))
      : (S.formTrade || []).filter((x) => x !== tradeId);
    const card = t.closest(".ch-trade-card");
    if (card) card.classList.toggle("active", on);
    updateChannelGate();
    return;
  }
  /* 互动渠道开关勾选：同步草稿（在线沟通 / 站长中转） */
  const channelId = t.dataset ? t.dataset.channelId : undefined;
  if (channelId) {
    const on = !!t.checked;
    if (channelId === "chat") S.formAllowChat = on;
    if (channelId === "relay") S.formAllowRelay = on;
    const card = t.closest(".ch-trade-card");
    if (card) card.classList.toggle("active", on);
    return;
  }
  /* multi 字段规格标签（分组单选）：同组互斥——选中本项时清除同组其他选中 */
  const mt = t.dataset ? t.dataset.mtag : undefined;
  if (mt !== undefined && t.dataset.mkey) {
    const rows = S.formMulti[t.dataset.mkey] || [];
    const row = rows[Number(t.dataset.midx)];
    if (row) {
      const gLabel = t.dataset.mgroup;
      const board = boardOf(S.formBoard);
      const fd = board && board.fields.find((f) => f.key === t.dataset.mkey);
      const g = fd && (fd.groups || []).find((gr) => gr.label === gLabel);
      const gOptions = g ? g.options : [mt];
      if (t.checked) {
        // 草稿：移除同组已选，加入本项
        row.t = (row.t || []).filter((x) => !gOptions.includes(x) || x === mt);
        if (!row.t.includes(mt)) row.t.push(mt);
        // DOM：清除同组其他选中态
        const rowEl = t.closest(".ch-multi-row");
        if (rowEl) {
          rowEl.querySelectorAll(`input[data-mgroup="${CSS.escape(gLabel)}"]`).forEach((cb) => {
            if (cb !== t) { cb.checked = false; const l = cb.closest(".ch-mtag"); if (l) l.classList.remove("on"); }
          });
        }
      } else {
        row.t = (row.t || []).filter((x) => x !== mt);
      }
      const label = t.closest(".ch-mtag");
      if (label) label.classList.toggle("on", t.checked);
    }
    return;
  }
  const f = t.dataset.filter;
  if (f) {
    S.filters[f] = t.value;
    S.listPage = 1; // 筛选变化回到第 1 页
    if (f === "province") {
      S.filters.city = "";
      render(); /* 重渲染以更新城市选项 */
    }
    loadBoardPage().then(renderListRegion); // 服务端筛选
    return;
  }
  if (t.id === "chFProvince") {
    const city = $("chFCity");
    if (city) city.innerHTML = `<option value="">请选择</option>` + ((S.schema.provinces || {})[t.value] || []).map((c) => `<option>${esc(c)}</option>`).join("");
    return;
  }
  if (t.id === "chFNotifyChannel") {
    const v = $("chFNotifyValue");
    if (v) v.disabled = !t.value;
    return;
  }
}

function onRootInput(e) {
  const t = e.target;
  /* 联系方式行：值输入实时同步草稿 */
  if (t.dataset && t.dataset.cval !== undefined) {
    const idx = Number(t.dataset.cval);
    if (S.formContacts && S.formContacts[idx]) S.formContacts[idx].value = t.value;
    return;
  }
  /* 号码公开显示联动：完整号码变化时，若掩码未被手动编辑过则自动重新生成（可再手动改） */
  if (t.dataset && t.dataset.xkey === "phone_num") {
    const maskedEl = $("chX_phone_masked");
    if (maskedEl && !S.formPhoneMaskDirty) {
      const num = t.value.trim();
      maskedEl.value = !num ? "" : num.length >= 8
        ? num.slice(0, 3) + "*".repeat(num.length - 7) + num.slice(-4)
        : num.slice(0, 1) + "*".repeat(Math.max(num.length - 2, 1)) + (num.length > 1 ? num.slice(-1) : "");
    }
    return;
  }
  if (t.dataset && t.dataset.xkey === "phone_masked") {
    S.formPhoneMaskDirty = !!t.value.trim();
    return;
  }
  /* multi 字段数值输入实时同步草稿 */
  if (t.dataset && t.dataset.mval !== undefined) {
    const rows = S.formMulti[t.dataset.mval] || [];
    const row = rows[Number(t.dataset.midx)];
    if (row) row.v = t.value;
  }
  /* multi 到期时间输入实时同步草稿（短期条目必填） */
  if (t.dataset && t.dataset.mexp !== undefined) {
    const rows = S.formMulti[t.dataset.mexp] || [];
    const row = rows[Number(t.dataset.midx)];
    if (row) row.expire = t.value;
  }
  if (t.id === "chSearch") {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      S.filters.q = t.value.trim();
      S.listPage = 1;
      loadBoardPage().then(renderListRegion); // 服务端搜索（防抖 300ms）
    }, 300);
  }
  if (t.classList && t.classList.contains("error")) t.classList.remove("error");
}

/* ═══════════════════════════ 页面注册 ═══════════════════════════ */
let _rootClickHandler = null, _rootChangeHandler = null, _rootInputHandler = null, _rootKeydownHandler = null;

Shell.registerPage({
  id: "cardhub",
  route: "/cardhub",
  async onEnter(root) {
    showPageLoading("跳蚤市集加载中…");
    await ensureStylesheet(Shell.config.base + "modules/cardhub/style.css");

    /* 模块开关守卫：关闭时直接显示禁用页 */
    const meta = await api.fetchMeta();
    if (meta.cardhub === false) {
      hidePageLoading();
      root.innerHTML = `<div style="padding:80px 20px;text-align:center"><h2 style="color:var(--muted)">跳蚤市集暂未开放</h2><p style="color:var(--muted);margin:8px 0 24px">该功能已由管理员临时关闭，请稍后再来</p><button class="btn primary" onclick="Shell.navigate('/')">返回资费监测</button></div>`;
      return;
    }

    /* 首次进入：数据请求期间由全局加载遮罩占位（双环转圈+弹跳点），数据就绪后再渲染骨架壳 */
    if (!S.schema) {
      try {
        await loadFromApi();
        if (S.user) await loadMyPosts();
      } catch (err) {
        hidePageLoading();
        root.innerHTML = `<div style="padding:48px 20px;text-align:center;color:var(--red)">跳蚤市集数据加载失败：${esc(err.message)}</div>`;
        return;
      }
    }

    root.innerHTML = skeletonHTML();
    hidePageLoading();
    mountIcons($("cardhubRoot"));
    mountAuth($("chAuthSlot"));
    mountAppsMenu($("chAppsMenuSlot"), "cardhub");

    /* 用户警告门控已并入推广体系（migration 0030）：mode=must、modules=["cardhub"] 的
       推广条目，由 shell.js activate → maybePromosOnModuleEnter('cardhub') 统一判定弹出 */

    /* 总览为默认视图时，chTabs.activate 会被 onNavChange 的回环拦截，
       这里显式触发首次总览数据加载（切走再回的正常路径不受影响） */
    if (S.view === "overview" && !S.overview) loadOverview().then(render);

    /* 侧边导航 Tabs（滑动指示器，对齐 config） */
    chTabs = new Tabs($("chNav"), onNavChange);
    chTabs.activate(navViewId());

    /* 通知中心/资料卡「在线沟通」深链：直达我的发布 / 会话收件箱（notify.js 点击时写入） */
    try {
      const ntfView = sessionStorage.getItem("ntf_cardhub_view");
      if (ntfView === "me" || ntfView === "convs") {
        sessionStorage.removeItem("ntf_cardhub_view");
        if (S.user) chTabs.activate(ntfView);
      }
      /* 私信直达会话：资料卡「在线沟通」创建/复用会话后写入，activate 会话列表后直接打开该会话 */
      const ntfConv = sessionStorage.getItem("ntf_cardhub_conv");
      if (ntfConv && S.user) {
        sessionStorage.removeItem("ntf_cardhub_conv");
        if (S.view === "conv" || S.view === "convs" || !S.view) openConv(ntfConv);
      }
    } catch { /* 隐私模式忽略 */ }

    /* 主题按钮 */
    const themeBtn = $("chThemeBtn");
    const paint = () => {
      themeBtn.innerHTML = icon(theme.get() === "dark" ? "sun" : "moon");
      themeBtn.title = theme.get() === "dark" ? "切换亮色主题" : "切换暗色主题";
    };
    paint();
    themeBtn.addEventListener("click", () => { theme.toggle(); paint(); });

    /* 侧边栏抽屉 */
    $("chHamburger").addEventListener("click", openSidebar);
    $("chSidebarClose").addEventListener("click", closeSidebar);
    $("chSidebarOverlay").addEventListener("click", closeSidebar);
    $("chSidebar").addEventListener("click", (e) => {
      if (e.target.closest(".nav-item") && window.innerWidth <= 900) closeSidebar();
    });

    /* 事件委托 */
    const host = $("cardhubRoot");
    _rootClickHandler = onRootClick;
    _rootChangeHandler = onRootChange;
    _rootInputHandler = onRootInput;
    _rootKeydownHandler = (e) => {
      /* 会话回复框：Enter 发送 / Shift+Enter 换行 */
      if (e.key === "Enter" && !e.shiftKey && e.target && e.target.id === "chConvInput") {
        e.preventDefault();
        sendConvMsg();
      }
    };
    host.addEventListener("click", _rootClickHandler);
    host.addEventListener("change", _rootChangeHandler);
    host.addEventListener("input", _rootInputHandler);
    host.addEventListener("keydown", _rootKeydownHandler);

    render();
  },
  onExit() {
    const host = $("cardhubRoot");
    if (host) {
      if (_rootClickHandler) host.removeEventListener("click", _rootClickHandler);
      if (_rootChangeHandler) host.removeEventListener("change", _rootChangeHandler);
      if (_rootInputHandler) host.removeEventListener("input", _rootInputHandler);
      if (_rootKeydownHandler) host.removeEventListener("keydown", _rootKeydownHandler);
    }
    _rootClickHandler = _rootChangeHandler = _rootInputHandler = _rootKeydownHandler = null;
    if (chTabs) { chTabs.destroy(); chTabs = null; }
    const toastEl = $("chToast");
    if (toastEl) toastEl.remove();
  },
});

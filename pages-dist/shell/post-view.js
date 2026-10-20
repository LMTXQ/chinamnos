/* ═══════════════════════════════════════════════════════════════
   帖子公开视图渲染 · 共享模块
   ───────────────────────────────────────────────────────────────
   ▸ 跳蚤市集真实页面（cardhub.js）与管理中心帖子预览（admin.js）
     共用同一套渲染——单一数据源，改 UI 只改本文件
   ▸ 两个入口构建视图模型：
     viewFromCardhubRaw(schema, raw, detail, self)  cardhub adapt 数据
     viewFromProjection(schema, proj, meta)          后端投影数据（蛇形）
   ▸ 两个渲染出口：
     renderListCard(schema, view, opts)   列表卡片（ch-card）
     renderDetailBody(schema, view, opts) 详情内容体（ch-detail）
   ▸ opts.readonly=true 输出只读快照（按钮禁用/无 data-act），管理预览用
   ═══════════════════════════════════════════════════════════════ */
"use strict";

import { esc } from "./shell.js";
import { icon } from "./ui.js";
import { mdToSafeHtml } from "./md.js";
import { api } from "./api.js";

export const BOARD_LABELS = { found: "出让", lost: "求购", rent_out: "出租", rent_want: "求租", fleet: "车队", market: "市集" };
export const BOARD_ICONS = { found: "tag", lost: "search", rent_out: "key", rent_want: "search", fleet: "users", market: "box" };
export const BOARD_PRICE = {
  lost: { key: "budget", label: "预算" },
  found: { key: "deal_price", label: "交易金额" }, // 出让核心是卖价，月租只是资费规格
  rent_out: { key: "monthly_fee", label: "月租" },
  rent_want: { key: "monthly_fee", label: "月租" },
  fleet: { key: "car_fee", label: "车费" }, // 车队核心是每位上车者支付的车头费用
};
export const CONTACT_CH_LABEL = { qq: "QQ", wechat: "微信", phone: "手机", email: "邮箱", other: "其他" };

export function boardOf(schema, id) {
  return ((schema && schema.boards) || []).find((b) => b.id === id) || null;
}
export function carrierLabel(schema, c) {
  const pair = ((schema && schema.carriers) || []).find((x) => x[0] === c);
  return pair ? pair[1] : c || "-";
}

/* ─────────────── 时间工具（秒制时间戳，与 cardhub 视图模型一致） ─────────────── */
export function relTime(sec) {
  if (!sec) return "-";
  const diff = Math.floor(Date.now() / 1000) - sec;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
  if (diff < 86400) return Math.floor(diff / 3600) + " 小时前";
  if (diff < 30 * 86400) return Math.floor(diff / 86400) + " 天前";
  return new Date(sec * 1000).toLocaleDateString("zh-CN");
}
export function remainTag(expSec) {
  if (!expSec) return "";
  const d = Math.ceil((expSec - Date.now() / 1000) / 86400);
  if (d <= 0) return " · 已到期";
  return ` · 剩 ${d} 天`;
}

/* ─────────────── multi 规格（多条规格）显示归一化：
   新数据 [{v:100,t:["通用","全国"]}]；旧单值 100 / "" 自动兼容；
   标签按 schema.groups 定义顺序输出（存储顺序可能任意） ─────────────── */
export function multiItems(rawV, fd) {
  if (rawV == null || rawV === "") return [];
  const arr = Array.isArray(rawV) ? rawV : [{ v: rawV, t: [] }];
  const order = (fd.groups || []).flatMap((g) => g.options);
  return arr
    .map((it) => {
      const v = it && typeof it === "object" ? it.v : it;
      let t = it && typeof it === "object" && Array.isArray(it.t) ? it.t.map(String) : [];
      t = t.filter((x) => order.includes(x)); // 剔除不在 schema 内的脏标签
      t.sort((a, b) => order.indexOf(a) - order.indexOf(b));
      const s = String(v == null ? "" : v).trim();
      if (!s) return null;
      return {
        text: /^\d+$/.test(s) ? s + (fd.unit || "") : s,
        tags: t,
        expire: it && it.expire ? String(it.expire).trim() : "", // 到期时间（短期条目附带）
      };
    })
    .filter(Boolean);
}

/* ─────────────── 联系方式策略小徽章 ───────────────
   多渠道模型：消费 view.contact（visibility/allowChat/allowRelay），旧数据回退 view.policy（legacy 单选）。
   一个芯片概括联系能力：公开联系方式 / 登录可见 / 在线沟通 / 站长中转 / 不展示 */
export function policyChip(view) {
  const c = (view && view.contact) || {};
  const vis = c.visibility || (view && view.policy) || "public";
  if (vis === "users") return `<span class="ch-policy-chip pc-users" title="登录可见">${icon("user")}登录可见</span>`;
  if (vis === "hidden" || vis === "relay_online" || vis === "relay_owner") {
    if (c.allowChat || vis === "relay_online")
      return `<span class="ch-policy-chip pc-relay_online" title="在线沟通">${icon("phone")}在线沟通</span>`;
    if (c.allowRelay || vis === "relay_owner")
      return `<span class="ch-policy-chip pc-relay_owner" title="站长中转">${icon("shield")}站长中转</span>`;
    return `<span class="ch-policy-chip pc-users" title="不展示直接联系方式">${icon("shield")}不展示</span>`;
  }
  return `<span class="ch-policy-chip pc-public" title="公开联系方式">${icon("eye")}公开联系方式</span>`;
}

/* 标签组合 + 到期时间前缀（如 短期·至2029-10） */
function itemPrefix(it) {
  return [...it.tags, it.expire ? "至" + it.expire : null].filter(Boolean).join("·");
}

/* 规格芯片（列表卡用）：仅带 unit 的字段，multi 每条一个芯片（标签组合前缀） */
function viewSpecs(schema, view) {
  const board = boardOf(schema, view.board);
  const specs = [];
  for (const fd of (board ? board.fields : []).filter((fd) => fd.unit)) {
    for (const it of multiItems(view.extra ? view.extra[fd.key] : null, fd)) {
      const pre = itemPrefix(it);
      specs.push({ label: fd.label, text: (pre ? pre + " " : "") + it.text });
    }
  }
  return specs;
}

/* ─────────────── 视图模型（展示字段齐：carrierLabel/priceLabel/price/policy/contact/specs） ─────────────── */
/* 输入：cardhub adapt 后数据（createdAt 秒、contactVisibility/allowChat/allowRelay、contacts=[{purpose,channel,value}]）
   opts: { isLoggedIn } —— users 可见性下访客/登录差异判定 */
/* 原始投影 → 前端渲染模型（纯函数）。
   供跳蚤市集主模块与资费页「跳蚤市集」tab 共用；原 cardhub.js adaptPost 上移至此（2026-10-01） */
export function adaptPost(p) {
  /* 详情投影（public/detail）无顶层 contact_* 字段，可见性/渠道开关在嵌套 contact 里——
     必须从 contact 回填，否则 hidden 帖会误显示「登录后可见」且互动渠道入口丢失 */
  const ct = p.contact && typeof p.contact === "object" ? p.contact : null;
  let contacts = p.contacts || [];
  if (!contacts.length && ct && Array.isArray(ct.chats)) {
    contacts = ct.chats.map((c) => ({ purpose: "chat", channel: c.channel, value: c.value }));
  }
  return {
    id: p.id, postNo: p.post_no || p.postNo || null, board: p.board, carrier: p.carrier, province: p.province, city: p.city,
    title: p.title, descr: p.descr || "",
    extra: p.extra || {},
    proofPublic: p.proof_public === 1 || p.proofPublic === true ? 1 : 0,
    proofs: Array.isArray(p.proofs) ? p.proofs : [],
    reviewAdminId: p.review_admin_id || p.reviewAdminId || null,
    contactPolicy: p.contact_policy || p.contactPolicy || "public",
    contactVisibility: p.contact_visibility || p.contactVisibility || (ct && ct.visibility) || null,
    allowChat: (p.allow_chat === 1 || p.allowChat === true || !!(ct && ct.allowChat)) ? 1 : 0,
    allowRelay: (p.allow_relay === 1 || p.allowRelay === true || !!(ct && ct.allowRelay)) ? 1 : 0,
    contact: ct,
    contacts,
    pinnedAt: p.pinned_at || p.pinnedAt || null, // 精华置顶时间戳（null=未置顶）
    favorited: p.favorited === 1 || p.favorited === true, // 当前登录用户是否已收藏（详情接口下发）
    // 作者公开资料（仅详情接口返回）：{ id, nickname, contact, avatar_url }
    author: p.author || null,
    status: p.status,
    createdAt: Math.floor((p.created_at || p.createdAt || 0) / 1000),
    expiresAt: p.expires_at ? Math.floor(p.expires_at / 1000) : (p.expiresAt || null),
    ttlDays: p.ttl_days || p.ttlDays || 30,
    rejectReason: p.reject_reason || p.rejectReason || "",
  };
}

export function viewFromCardhubRaw(schema, raw, detail, self, opts = {}) {
  const board = boardOf(schema, raw.board);
  const priceDef = BOARD_PRICE[raw.board] || {};
  const out = {
    id: raw.id,
    postNo: raw.postNo || raw.post_no || null,
    board: raw.board,
    boardLabel: board ? board.label : raw.board,
    carrier: raw.carrier,
    carrierLabel: carrierLabel(schema, raw.carrier),
    province: raw.province,
    city: raw.city,
    title: raw.title,
    priceLabel: board ? board.priceLabel : "",
    price: (raw.extra && raw.extra[board ? board.priceKey : ""]) || "",
    createdAt: raw.createdAt,
    expiresAt: raw.expiresAt || null,
    ttlDays: raw.ttlDays,
    policy: raw.contactPolicy,
  };
  out.extra = raw.extra || {};
  out.specs = viewSpecs(schema, out);
  if (detail) out.descr = raw.descr || "";
  const chats = (raw.contacts || []).filter((c) => c.purpose === "chat");
  /* 多渠道模型：新字段优先，旧 contact_policy 单选推导兜底（迁移前旧数据） */
  const legacy = raw.contactPolicy || "public";
  const vis = raw.contactVisibility || (legacy === "public" || legacy === "users" ? legacy : "hidden");
  const allowChat = !!raw.allowChat || legacy === "relay_online";
  const allowRelay = !!raw.allowRelay || legacy === "relay_owner";
  out.policy = vis; // policyChip 判定基准（新三值；legacy 值由芯片内部兜底）
  out.status = raw.status; // 公开详情恒显式下发 status；管理组「管理下架」等按状态渲染依赖此值
  out.pinnedAt = raw.pinnedAt || null; // 精华置顶时间戳（列表卡「精华」徽章）
  if (self) {
    out.self = true;
    out.rejectReason = raw.rejectReason || "";
    out.contact = { type: "self", chats, visibility: vis, allowChat, allowRelay };
  } else {
    /* chatsVisible：服务端投影值优先（public/detail contact.chatsVisible），否则本地判定 */
    const proj = raw.contact && typeof raw.contact === "object" ? raw.contact : null;
    const chatsVisible = proj && typeof proj.chatsVisible === "boolean"
      ? proj.chatsVisible
      : (vis === "public" || (vis === "users" && !!opts.isLoggedIn));
    out.contact = { visibility: vis, chats: chatsVisible ? chats : [], chatsVisible, allowChat, allowRelay };
  }
  return out;
}

/* 输入：后端投影数据（serializePost public/detail 或 public/list，蛇形命名、毫秒时间）；
   meta: { author, contactPolicy }（投影本体不含发布者资料与联系方式策略，由调用方附带） */
export function viewFromProjection(schema, proj, meta = {}) {
  const board = boardOf(schema, proj.board);
  const priceDef = BOARD_PRICE[proj.board] || {};
  const out = {
    id: proj.id,
    postNo: proj.post_no || null,
    board: proj.board,
    boardLabel: board ? board.label : proj.board,
    carrier: proj.carrier,
    carrierLabel: carrierLabel(schema, proj.carrier),
    province: proj.province,
    city: proj.city,
    title: proj.title,
    descr: proj.descr || "",
    extra: proj.extra || {},
    ttlDays: proj.ttl_days || 30,
    createdAt: proj.created_at ? proj.created_at / 1000 : 0,
    expiresAt: proj.expires_at ? proj.expires_at / 1000 : null,
    priceLabel: board ? board.priceLabel : "",
    price: (proj.extra && proj.extra[priceDef.key]) || "",
    policy: meta.contactPolicy || "",
    contact: proj.contact || null,
    specs: [],
  };
  out.specs = viewSpecs(schema, out);
  return out;
}

/* ─────────────── 列表卡片（ch-card 真实结构） ───────────────
   opts: { author: {nickname,title,avatar_v,avatarUrl} | null, readonly } */
export function renderListCard(schema, view, opts = {}) {
  const ro = !!opts.readonly;
  const author = opts.author;
  const board = view.board;
  // 入场/悬停动效类仅真实列表传（管理预览为静态快照）
  const fx = opts.tilt ? ` tilt rise" style="--i:${Math.min(opts.index ?? 0, 8)}` : "";
  const side = author
    ? `<div class="ch-card-side ch-bc-${board}">${
        author.avatar_v
          ? `<img class="ch-card-avatar" src="${esc(author.avatarUrl || "")}" alt="">`
          : `<span class="ch-card-avatar-txt">${esc((author.nickname || "?").charAt(0).toUpperCase())}</span>`
      }</div>`
    : `<div class="ch-card-side ch-bc-${board}">${icon(BOARD_ICONS[board] || "box")}</div>`;
  const act = ro ? "" : ` data-act="openDetail" data-id="${esc(view.id)}" data-board="${esc(view.board || "")}"`;
  /* 注意：卡片不再自带 .ch-list 包裹层——列表容器由调用方包一次，
     否则每卡各成一个 grid 容器，容器间 gap 永远不生效（卡片曾因此贴死 0px） */
  return `
  <article class="ch-card card${fx}"${act}>
    ${side}
    <div class="ch-card-main">
      <div class="ch-card-head">
        <h3 class="ch-card-title">${esc(view.title || "")}</h3>
        ${opts.showBoard && view.board ? `<span class="ch-chip ch-chip-board">${esc(BOARD_LABELS[view.board] || view.board)}</span>` : ""}${view.pinnedAt ? `<span class="ch-chip ch-chip-pin">${icon("star")}精华</span>` : ""}${policyChip(view)}
      </div>
      <div class="ch-card-meta">
        ${view.carrier ? `<span class="ch-chip ch-chip-carrier cc-${esc(view.carrier)}">${esc(carrierLabel(schema, view.carrier))}</span>` : ""}
        ${(view.province || view.city) ? `<span class="ch-chip">${icon("map")} ${esc(view.province)}${view.city ? " · " + esc(view.city) : ""}</span>` : ""}
      </div>
      ${(view.specs && view.specs.length) ? `<div class="ch-card-specs">${view.specs.map((s) => `<span class="ch-spec"><b>${esc(s.label)}</b>${esc(s.text)}</span>`).join("")}</div>` : ""}
      <div class="ch-card-foot">
        <span class="ch-price">${esc(view.priceLabel)} <b>${esc(view.price || "面议")}</b></span>
        <span class="ch-time">${icon("clock")} ${relTime(view.createdAt)}${remainTag(view.expiresAt)}</span>
      </div>
    </div>
    <div class="ch-card-arrow">${icon("arrowRight")}</div>
  </article>`;
}

/* ─────────────── 详情内容体（ch-detail 真实结构；不含 selfBar/页面导航等页面专属部分） ───────────────
   opts: { author, readonly, self, reviewAdminId, proofs, proofPublic, blobAttr, rise } */
function detailFieldHTML(fd, v) {
  /* markdown 字段（市集图文介绍等）：mdToSafeHtml 渲染（链接可点、图片直显），空值不显示 */
  if (fd.type === "markdown") {
    const md = v == null ? "" : String(v);
    if (!md.trim()) return "";
    return `<div class="ch-dt-md"><div class="ch-md-body">${mdToSafeHtml(md, { nofollow: true })}</div></div>`;
  }
  /* tags 类型（号码特征等）：数组 → 「 / 」连接；空数组不显示 */
  if (fd.type === "tags") {
    if (!Array.isArray(v) || !v.length) return "";
    return `<div class="ch-dt-row"><span class="ch-dt-k">${esc(fd.label)}</span><span class="ch-dt-v">${esc(v.join(" / "))}</span></div>`;
  }
  /* multi 字段：每条「标签组合+到期时间 数值单位」，多条用 ／ 连接 */
  if (fd.type === "multi") {
    const items = multiItems(v, fd);
    if (!items.length) return "";
    const shown = items.map((it) => {
      const pre = itemPrefix(it);
      return (pre ? pre + " " : "") + it.text;
    }).join(" ／ ");
    return `<div class="ch-dt-row"><span class="ch-dt-k">${esc(fd.label)}</span><span class="ch-dt-v">${esc(shown)}</span></div>`;
  }
  if (v == null || v === "") return "";
  // unit 字段（短信等单值）：值为纯整数时前端拼接单位展示；旧数据非纯整数则原样显示
  const s = String(v);
  const shown = fd.unit && /^\d+$/.test(s) ? s + fd.unit : s;
  return `<div class="ch-dt-row"><span class="ch-dt-k">${esc(fd.label)}</span><span class="ch-dt-v">${esc(shown)}</span></div>`;
}

/* 该帖担保人行：view.extra.trade_guarantors = 发帖时从站长推荐列表选择的担保人名称快照（字符串数组）。
   按名称回查 schema.tradeMerchants：绑定站内用户 → 头像 + 「站内」徽章 + 点击弹资料卡；
   未绑定/条目已被站长移除 → 纯文本行（快照名称兜底，永不丢展示）。
   统计来自 schema.tradeGuarantorStats（快照 0-8h 时延）。ro=true（管理预览）输出无交互快照 */
function guarantorRowHTML(name, schema, ro) {
  const merchants = (schema && schema.tradeMerchants) || [];
  const stats = (schema && schema.tradeGuarantorStats) || {};
  const c = merchants.find((m) => String(((m && typeof m === "object") ? m.name : m) || "").trim() === name) || {};
  const bound = !!(c.uid && c.nickname);
  const intro = String(c.intro || "").trim();
  const avatar = bound
    ? (c.avatar_v
        ? `<img class="ch-guar-avatar" src="${esc(api.avatarUrl(c.uid, c.avatar_v))}" alt="" loading="lazy">`
        : `<span class="ch-guar-avatar ch-guar-avatar-txt">${esc((c.nickname || name).charAt(0).toUpperCase())}</span>`)
    : `<span class="ch-guar-avatar ch-guar-avatar-txt dim">${esc(name.charAt(0).toUpperCase())}</span>`;
  const inner = `${avatar}<span class="ch-guar-main"><span class="ch-guar-name">${esc(name)}${bound ? `<span class="ch-merchant-badge">站内</span>` : ""}</span><span class="ch-guar-stat">当前已有 ${stats[name] || 0} 帖子选择他作为担保人</span></span>`;
  const act = (ro || !bound) ? "" : ` data-act="merchantCard" data-uid="${esc(c.uid)}" data-intro="${esc(intro)}"`;
  return `<div class="ch-guar-item${bound ? " bound" : ""}"${act}${intro ? ` title="${esc(intro)}"` : ""}>${inner}</div>`;
}

function renderTradeBox(schema, view, ro) {
  const tm = (view.extra && Array.isArray(view.extra.trade_methods)) ? view.extra.trade_methods : [];
  if (!tm.length) return "";
  const tmap = {};
  ((schema && schema.tradeMethods) || []).forEach((t) => { tmap[t.id] = t; });
  const chips = tm.map((id) => {
    /* 站长停用「站点担保」后 schema 不再下发该选项，存量帖子用内置兜底，避免芯片显示裸 id */
    const t = tmap[id] || (id === "site" ? { name: "站点担保", warn: false } : { name: id, warn: false });
    return `<span class="ch-trade-chip${t.warn ? " warn" : ""}">${esc(t.name)}</span>`;
  }).join("");
  let notes = "";
  if (tm.includes("xianyu")) {
    notes += `<div class="ch-trade-warnline">${icon("info")} 闲鱼等二手平台交易：买方拥有无条件仅退款风险，请务必知悉。</div>`;
  }
  if (tm.includes("merchant")) {
    notes += `<div class="ch-trade-hintline">${icon("shield")} 发帖人已选择由圈内卡商进行担保交易，请确保交易双方均认可该担保人，并通过担保人进行交易，防止上当受骗。站点不为任何交易、担保人作信用背书，请自行甄别卖方、担保人信用资质。</div>`;
    const gnames = (view.extra && Array.isArray(view.extra.trade_guarantors))
      ? view.extra.trade_guarantors.map((n) => String(n || "").trim()).filter(Boolean)
      : [];
    if (gnames.length) {
      notes += `<div class="ch-guar-detail"><span class="ch-guar-t">该帖担保人</span>${gnames.map((n) => guarantorRowHTML(n, schema, ro)).join("")}</div>`;
    }
  }
  return `
  <div class="ch-trade-box">
    <h3 class="ch-sec-t">交易方式 <span class="panel-sub">仅供参考 · 具体交易方式请与交易方实际协商</span></h3>
    <div class="ch-trade-chips">${chips}</div>
    ${notes}
  </div>`;
}

/* 证明材料：self 总可见；公众仅 proofPublic=1 可见。
   blobAttr：cardhub 用 "data-proofload"（配合 <a data-proofopen> 原图打开），
   管理预览传 "data-adminproof" 且 proofLink=false（纯缩略图） */
function renderProofBox(view, opts) {
  const prs = opts.proofs || [];
  if (opts.self && opts.reviewAdminId && !prs.length) {
    return `
  <div class="ch-proof-box">
    <h3 class="ch-sec-t">审核方式</h3>
    <div class="ch-trade-hintline">${icon("shield")} 您选择了「指定管理员实名审核」：该帖仅由站长或您指定的管理员审核，其他管理员不可见。审核时会特别提醒对方您未上传证明材料，请保持联系方式畅通以便配合核实。</div>
  </div>`;
  }
  if (!prs.length) return "";
  const sub = opts.self && opts.proofPublic !== 1 ? `<span class="panel-sub">仅审核与发布者可见</span>` : "";
  const thumbs = prs.map((pr, i) => opts.proofLink === false
    ? `<img alt="证明材料 ${i + 1}" loading="lazy" ${opts.blobAttr}="${esc(view.id)}|${esc(pr.id)}">`
    : `<a class="ch-proof-a" data-proofopen="${esc(view.id)}|${esc(pr.id)}" target="_blank" rel="noopener" title="点击查看原图">
        <img alt="证明材料 ${i + 1}" loading="lazy" ${opts.blobAttr || "data-proofload"}="${esc(view.id)}|${esc(pr.id)}">
      </a>`).join("");
  return `
  <div class="ch-proof-box">
    <h3 class="ch-sec-t">证明材料 ${sub}</h3>
    <div class="ch-proof-thumbs">${thumbs}</div>
  </div>`;
}

/* 联系方式区（多渠道模型）：contact = { type:'self' | {visibility,chats,chatsVisible,allowChat,allowRelay} }；
   区块化渲染：直接联系方式区（按可见性）+ 互动渠道区（在线沟通 / 站长中转，可并存）。
   未填直联但已开启互动渠道时不显示「未填写」占位（下方渠道即联系路径）；
   渠道卡片统一收进 .ch-contact-channels 栅格，多渠道共存时保持呼吸间距；
   readonly 时交互按钮禁用（管理预览只读快照） */
function renderContactBox(view, ro, opts = {}) {
  const c = view.contact || {};
  const logged = !!opts.isLoggedIn; // 访客视角显示注册引导（转化漏斗）
  const chatItems = (chats) => (chats || []).map((ch) => `
    <div class="ch-contact-item">
      <span class="ch-contact-ch">${esc(CONTACT_CH_LABEL[ch.channel] || "其他")}</span>
      <code class="ch-contact-val">${esc(ch.value)}</code>
      <button class="icon-btn" ${ro ? "disabled" : `data-act="copyVal" data-val="${esc(ch.value)}"`} title="复制"><i data-icon="copy"></i></button>
    </div>`).join("");
  /* 互动渠道块：在线沟通 / 站长中转（可同时渲染多个） */
  const onlineBlock = (sub) => `
    <div class="ch-contact-online">
      ${icon("phone")}
      <div><b>在线沟通</b><span>${esc(sub || (logged ? "在网页里给发布者留言，系统将邮件通知对方回复" : "注册登录后可与发布者在线沟通，回复邮件直达你的邮箱"))}</span></div>
      <button class="btn primary" ${ro ? "disabled" : `data-act="soonChat"`}><i data-icon="arrowRight"></i>${logged ? "发起在线沟通" : "登录 / 注册后沟通"}</button>
    </div>`;
  const relayBlock = () => {
    const owner = opts.ownerContact || {};
    return `
    <div class="ch-contact-block">
      <div class="ch-contact-owner">
        ${icon("shield")}
        <div><b>通过站长中转</b><span>填写意向表，由站长转发给发布者；也可直接联系站长</span></div>
        <button class="btn primary" ${ro ? "disabled" : `data-act="soonRelay"`}><i data-icon="arrowRight"></i>填写意向表</button>
      </div>
      ${owner.wechat ? `<div class="ch-contact-owner-alt">站长微信（备选）：<code>${esc(owner.wechat)}</code></div>` : ""}
    </div>`;
  };
  const lockBlock = (ic, t, s, btnHTML) => `
    <div class="ch-contact-lock">
      ${icon(ic)}
      <div><b>${esc(t)}</b><span>${esc(s)}</span></div>
      ${btnHTML || ""}
    </div>`;
  /* 渠道收集 → 统一栅格（有直联内容时上方加小节分隔） */
  const channels = [];
  if (c.allowChat) channels.push(onlineBlock());
  if (c.allowRelay) channels.push(relayBlock());
  const channelsHTML = channels.length ? `<div class="ch-contact-channels">${channels.join("")}</div>` : "";

  /* ── 本人视角：直接联系方式 + 已开启的互动渠道（发布者自检） ── */
  if (c.type === "self") {
    const vis = c.visibility || c.policy || "public";
    const name = { public: "所有人可见", users: "仅登录可见", hidden: "不展示" }[vis] || "";
    const chOn = [c.allowChat ? "在线沟通" : "", c.allowRelay ? "站长中转" : ""].filter(Boolean).join(" + ");
    const parts = [`<h3 class="ch-sec-t">联系方式 <span class="panel-sub">本人视角 · 直接联系方式「${esc(name)}」${chOn ? ` · ${chOn}已开启` : ""}</span></h3>`];
    if ((c.chats || []).length) parts.push(`<div class="ch-contact-direct">${chatItems(c.chats)}</div>`);
    if (channels.length) {
      if ((c.chats || []).length) parts.push(`<div class="ch-contact-channels-head">站内互动渠道</div>`);
      parts.push(channelsHTML);
    } else if (!(c.chats || []).length) {
      parts.push(lockBlock("info", "买家暂时无法联系你", "未填写直接联系方式，也未开启任何互动渠道；编辑帖子可调整"));
    }
    return parts.join("");
  }

  /* ── 公共视角：区块化（可见性决定直接联系方式；渠道开关决定互动入口） ── */
  const vis = c.visibility || "public";
  const parts = [];
  if (vis === "public" || vis === "users") {
    if (c.chatsVisible) {
      if ((c.chats || []).length) {
        parts.push(`<h3 class="ch-sec-t">联系方式 <span class="panel-sub">发布者公开的联系方式</span></h3>`);
        parts.push(`<div class="ch-contact-direct">${chatItems(c.chats)}</div>`);
        if (!logged) {
          parts.push(`<div class="ch-contact-guide">${icon("user")}
            <span>注册登录后可发布信息、查看仅登录可见的联系方式，并可发起站内在线沟通</span>
            <button class="btn soft sm" ${ro ? "disabled" : `data-act="soonLogin"`}>登录 / 注册</button>
          </div>`);
        }
      } else if (!channels.length) {
        /* 未填写且无互动渠道 → 仅此一条兜底提示 */
        parts.push(`<h3 class="ch-sec-t">联系方式</h3>`);
        parts.push(`<div class="ch-contact-direct"><div class="ch-contact-item">发布者暂未填写联系方式</div></div>`);
      }
      /* 未填写但已开启互动渠道 → 仅展示下方渠道，不再显示「暂未填写」 */
    } else {
      parts.push(`<h3 class="ch-sec-t">联系方式 <span class="panel-sub">登录后查看发布者联系方式</span></h3>`);
      parts.push(lockBlock("user", "登录后可见", "发布者设置了仅登录用户可查看联系方式，注册即可查看",
        `<button class="btn soft" ${ro ? "disabled" : `data-act="soonLogin"`}>登录 / 注册</button>`));
    }
  }
  if (channels.length) {
    parts.push(parts.length
      ? `<div class="ch-contact-channels-head">站内互动渠道</div>`
      : `<h3 class="ch-sec-t">联系发布者 <span class="panel-sub">站内渠道 · 不互留联系方式</span></h3>`);
    parts.push(channelsHTML);
  }
  if (!parts.length) {
    parts.push(`<h3 class="ch-sec-t">联系方式</h3>`);
    parts.push(lockBlock("info", "发布者未提供联系方式", "该帖未公开联系方式，也未开启站内沟通渠道"));
  }
  return parts.join("");
}

/* 详情内容体：详情头 + 发布者行 + 字段网格 + 交易方式 + 证明材料 + 描述 + 联系方式
   opts: { author, readonly, self, reviewAdminId, proofs, proofPublic, blobAttr, proofLink, rise } */
export function renderDetailBody(schema, view, opts = {}) {
  const ro = !!opts.readonly;
  const board = boardOf(schema, view.board);
  /* 车队帖：风险声明不走普通字段行，单独琥珀横幅置顶展示（浏览者一眼看到本车风险） */
  const isFleet = view.board === "fleet";
  const fleetRisk = isFleet && view.extra ? String(view.extra.fleet_risk || "").trim() : "";
  const riskBanner = fleetRisk ? `
    <div class="ch-risk-banner">${icon("shield")}<div class="ch-risk-main"><b>车队风险声明</b><span>${esc(fleetRisk)}</span></div></div>` : "";
  const fields = (board ? board.fields : [])
    .filter((fd) => !(isFleet && fd.key === "fleet_risk"))
    .map((fd) => detailFieldHTML(fd, view.extra ? view.extra[fd.key] : undefined)).join("");
  const author = opts.author;
  const authorCt = author ? (author.contacts || []).map((c) => `${CONTACT_CH_LABEL[c.type] || "其他"}:${c.value}`).join(" · ") : "";
  const authorRow = author ? `
    <button type="button" class="ch-author"${ro ? "" : ` data-act="authorCard" data-id="${esc(author.id)}"`} title="查看发布者资料">
      ${author.avatar_v ? `<img class="ch-author-avatar" src="${esc(author.avatarUrl || "")}" alt="">` : `<span class="ch-author-avatar ch-author-txt">${esc((author.nickname || "?").charAt(0).toUpperCase())}</span>`}
      <span class="ch-author-name">${esc(author.nickname || "未设置昵称")}</span>
      <span class="ch-author-title">${esc(author.title || "平平无奇的路人")}</span>
      ${authorCt ? `<span class="ch-author-ct">${icon("user")} ${esc(authorCt)}</span>` : `<span class="ch-author-ct dim">点击查看资料</span>`}
    </button>` : "";
  const proof = renderProofBox(view, {
    self: !!opts.self,
    reviewAdminId: opts.reviewAdminId || "",
    proofs: opts.proofs || [],
    proofPublic: opts.proofPublic,
    blobAttr: opts.blobAttr || "data-proofload",
    proofLink: opts.proofLink !== false,
  });
  const descr = view.descr ? `
    <div class="ch-descr">
      <h3 class="ch-sec-t">详细描述</h3>
      <p>${esc(view.descr).replace(/\n/g, "<br>")}</p>
    </div>` : "";
  return `
  <div class="panel ch-detail${opts.rise ? " rise" : ""}">
    <div class="ch-detail-head">
      <div class="ch-detail-side ch-bc-${view.board}">${icon(BOARD_ICONS[view.board] || "box")}</div>
      <div class="ch-detail-headmain">
        <h1 class="ch-detail-title">${esc(view.title || "")}${view.postNo ? `<button type="button" class="ch-post-no"${ro ? "" : ` data-act="copyVal" data-val="#${esc(view.postNo)}"`} title="点击复制编号">#${esc(view.postNo)}</button>` : ""}</h1>
        <div class="ch-card-meta">
          ${view.carrier ? `<span class="ch-chip ch-chip-carrier cc-${esc(view.carrier)}">${esc(carrierLabel(schema, view.carrier))}</span>` : ""}
          ${(view.province || view.city) ? `<span class="ch-chip">${icon("map")} ${esc(view.province)} · ${esc(view.city)}</span>` : ""}
          <span class="ch-chip">${icon("clock")} ${relTime(view.createdAt)} 发布</span>
          <span class="ch-chip">${icon("calendar")} 有效期 ${view.ttlDays} 天${remainTag(view.expiresAt)}</span>
        </div>
      </div>
      <div class="ch-detail-price">${esc(view.priceLabel || "")}<b>${esc(view.price || "面议")}</b></div>
    </div>
    ${authorRow}
    ${riskBanner}
    ${fields ? `<div class="ch-dt-grid">${fields}</div>` : ""}
    ${renderTradeBox(schema, view, ro)}
    ${proof}
    ${descr}
    <div class="ch-contact" id="chContactZone">${renderContactBox(view, ro, opts)}</div>
  </div>`;
}

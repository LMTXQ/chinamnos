/* ═══════════════════════════════════════════════════════════════
   API 客户端 — 对接 cnm-cardhub Worker
   ───────────────────────────────────────────────────────────────
   ▸ 鉴权：send-code → login-params → PBKDF2 → login → token
   ▸ Token 存 localStorage，Authorization: Bearer 携带
   ▸ 所有请求返回 { ok, data, error } 统一格式
   ═══════════════════════════════════════════════════════════════ */
"use strict";

import { getPubConfig } from "./pubcfg.js";

const API_BASE = "https://api.ftac.dpdns.org";
const TOKEN_KEY = "chinamnos_token";
const USER_KEY = "chinamnos_user";

/* ── 登录态跨线路共享（父域 cookie）──
   ▸ token/user 迁 .ftac.dpdns.org 父域 cookie：EdgeOne/CF/GH 三线共享登录态
   ▸ API 认证仍走 Authorization: Bearer（token 从 cookie 读出塞 header）→ Worker 端零改动；
     跨域 fetch 默认不携带 cookie，无额外请求开销
   ▸ 读取 cookie 优先、localStorage 兜底；读到旧 localStorage 值时惰性回写 cookie（双写一个版本周期后旧读法可移除）
   ▸ 隐私模式/禁 cookie：写失败自动回落 localStorage 单线行为（功能不受损，仅不跨线共享）
   ▸ Max-Age 与 Worker 会话有效期对齐（worker/src/auth SESSION_DAYS = 30 天） */
const COOKIE_DOMAIN = ".ftac.dpdns.org";
const COOKIE_MAX_AGE = 30 * 86400;
function ckGet(k) {
  try {
    const m = document.cookie.match(new RegExp("(?:^|;\\s*)" + k + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : "";
  } catch { return ""; }
}
function ckSet(k, v) {
  try {
    document.cookie = k + "=" + encodeURIComponent(v) + "; Domain=" + COOKIE_DOMAIN +
      "; Path=/; Secure; SameSite=Lax; Max-Age=" + COOKIE_MAX_AGE;
  } catch { /* 禁 cookie 环境忽略 */ }
}
function ckDel(k) {
  try {
    document.cookie = k + "=; Domain=" + COOKIE_DOMAIN + "; Path=/; Secure; SameSite=Lax; Max-Age=0";
  } catch { /* 忽略 */ }
}

export const api = {
  base: API_BASE,

  /* ── 鉴权 ── */
  getToken() {
    try {
      const c = ckGet(TOKEN_KEY);
      if (c) return c;
      const ls = localStorage.getItem(TOKEN_KEY) || "";
      if (ls) ckSet(TOKEN_KEY, ls);   // 惰性迁移：旧 localStorage token → cookie
      return ls;
    } catch { return ""; }
  },
  setToken(t) {
    try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {}
    t ? ckSet(TOKEN_KEY, t) : ckDel(TOKEN_KEY);   // 双写/双清
  },
  getUser() {
    try {
      const c = ckGet(USER_KEY);
      if (c) { try { return JSON.parse(c); } catch { ckDel(USER_KEY); } }
      const u = JSON.parse(localStorage.getItem(USER_KEY) || "null");
      if (u) ckSet(USER_KEY, JSON.stringify(u));   // 惰性迁移
      return u;
    } catch { return null; }
  },
  setUser(u) {
    try { u ? localStorage.setItem(USER_KEY, JSON.stringify(u)) : localStorage.removeItem(USER_KEY); } catch {}
    if (u) {
      const raw = JSON.stringify(u);
      // user 摘要超长（编码后 >3000 字符）不入 cookie（单条 4KB 上限），留 localStorage 本线可用
      if (encodeURIComponent(raw).length <= 3000) ckSet(USER_KEY, raw);
      else ckDel(USER_KEY);
    } else ckDel(USER_KEY);
  },
  isLoggedIn() { return !!this.getToken(); },
  logout() { this.setToken(""); this.setUser(null); },

  /* ── 模块开关（快照优先：data/public-config.json 的 modules 字段；缺失回落 /api/meta） ── */
  _metaPromise: null,
  fetchMeta() {
    if (!this._metaPromise) {
      this._metaPromise = getPubConfig()
        .then((pc) => {
          if (pc && pc.modules) return pc.modules;
          return this.request("/api/meta")
            .then((r) => (r.ok && r.data && r.data.modules) ? r.data.modules : {})
            .catch(() => ({})); // 探测失败按全开处理，避免误藏入口
        });
    }
    return this._metaPromise;
  },

  /* ── 底层请求 ── */
  async request(path, opts = {}) {
    const url = API_BASE + path;
    const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    const token = this.getToken();
    if (token) headers["Authorization"] = "Bearer " + token;
    const init = { method: opts.method || "GET", headers };
    if (opts.body) init.body = JSON.stringify(opts.body);
    // 需求号：NCH-PERF-1
    // 需求内容：通知配置弹窗卡顿优化
    // 改动说明：fetch 增加 AbortController 超时兜底（默认 15s）——实测本地到 API 链路抖动可达 16~30s+，
    // 此前无超时会无限挂起（弹窗"加载中…"卡死无反馈）；超时返回明确错误供上层提示重试
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeout || 15000);
    try {
      init.signal = ctrl.signal;
      const resp = await fetch(url, init);
      const json = await resp.json();
      if (json.code === 0) return { ok: true, data: json.data };
      return { ok: false, error: json.message, code: json.code, data: json.data };
    } catch (e) {
      if (e && e.name === "AbortError") return { ok: false, error: "请求超时，网络波动较大，请重试" };
      return { ok: false, error: (e && e.message) || "网络错误" };
    } finally {
      clearTimeout(timer);
    }
  },

  /* ── 认证接口 ── */
  async sendCode(email, captcha) {
    return this.request("/api/auth/send-code", { method: "POST", body: { email, captcha } });
  },
  async loginParams(email, captcha) {
    return this.request("/api/auth/login-params", { method: "POST", body: { email, captcha } });
  },
  async login(email, k, captcha) {
    const r = await this.request("/api/auth/login", { method: "POST", body: { email, k, captcha } });
    if (r.ok) { this.setToken(r.data.token); const me = await this.me(); if (me.ok) this.setUser(me.data); }
    return r;
  },
  async register(email, k, salt, iter, code, captcha) {
    const r = await this.request("/api/auth/register", { method: "POST", body: { email, k, salt, iter, code, captcha } });
    if (r.ok) { this.setToken(r.data.token); const me = await this.me(); if (me.ok) this.setUser(me.data); }
    return r;
  },
  async me() {
    return this.request("/api/auth/me");
  },
  async logoutApi() {
    await this.request("/api/auth/logout", { method: "POST" });
    this.logout();
  },

  /** 设置/修改昵称（对外展示名）；成功后同步本地缓存用户 */
  async setNickname(nickname) {
    // 注意：request() 内部统一 JSON.stringify，这里必须传对象（传字符串会被二次编码）
    const r = await this.request("/api/auth/nickname", { method: "POST", body: { nickname } });
    const u = this.getUser();
    if (u && r.ok) { u.nickname = r.data.nickname || nickname; this.setUser(u); }
    return r;
  },

  /** 账号资料：多条联系方式（每条 {type,value,pub}）+ 个性签名 bio（≤25 字，资料卡展示） */
  async setProfile(contacts, bio) {
    const r = await this.request("/api/auth/profile", { method: "POST", body: { contacts, bio } });
    if (r.ok) {
      const u = this.getUser();
      if (u) { u.contacts = r.data.contacts; u.bio = r.data.bio; this.setUser(u); }
    }
    return r;
  },

  /** 他人公开资料卡（昵称/UID/主动公开的联系方式/头像版本） */
  getPublicProfile(uid) {
    return this.request("/api/auth/profile/" + encodeURIComponent(uid));
  },

  /* ── 通知渠道绑定（站外通知） ── */
  async notifyChannels() {
    return this.request("/api/me/notify-channels");
  },
  async notifyChannelCreate(channelType, cred) {
    return this.request("/api/me/notify-channels", { method: "POST", body: { channel_type: channelType, cred } });
  },
  /* id = 绑定行 id（增量 3 多实例；不传则服务端回退按渠道类型，单实例语义） */
  async notifyChannelVerify(code, id) {
    return this.request("/api/me/notify-channels/verify", { method: "POST", body: { code, id } });
  },
  async notifyChannelPrefs(channelType, kinds, kindsMode, id) {
    return this.request("/api/me/notify-channels/prefs", { method: "POST", body: { channel_type: channelType, kinds, kinds_mode: kindsMode, id } });
  },
  async notifyDigestPrefs(channelType, opts, id) {
    return this.request("/api/me/notify-channels/digest-prefs", { method: "POST", body: { channel_type: channelType, ...opts, id } });
  },
  async digestGlobal() {
    return this.request("/api/me/digest-prefs");
  },
  async digestGlobalSave(provinces, kinds, announcePush) {
    return this.request("/api/me/digest-prefs", { method: "PUT", body: { provinces, kinds, announce_push: announcePush } });
  },
  async notifyChannelDelete(channelType, id) {
    return this.request("/api/me/notify-channels/delete", { method: "POST", body: { channel_type: channelType, id } });
  },
  async notifyChannelBindCode(channelType, id) {
    return this.request("/api/me/notify-channels/bindcode", { method: "POST", body: { channel_type: channelType, id } });
  },
  async notifyChannelTargets(channelType, op, group, code, id) {
    return this.request("/api/me/notify-channels/targets", { method: "POST", body: { channel_type: channelType, op, group, code, id } });
  },
  // 需求号：NCH-TEST-1
  // 需求内容：已绑定渠道的「测试」按钮
  // 改动说明：新增测试发送接口封装；多群渠道串行发送（Qmsg 5s/群）耗时较长，单独放宽超时到 30s
  async notifyChannelTest(channelType, id) {
    return this.request("/api/me/notify-channels/test", { method: "POST", body: { channel_type: channelType, id }, timeout: 30000 });
  },

  /** 修改登录邮箱（k=当前密码派生密钥；两步：request 发验证码 → confirm 落库；成功后邮件通知渠道自动解绑） */
  async myKdfParams() {
    return this.request("/api/me/kdf-params");
  },
  async changeEmailRequest(k, newEmail) {
    return this.request("/api/me/change-email/request", { method: "POST", body: { k, new_email: newEmail } });
  },
  async changeEmailConfirm(k, newEmail, code) {
    return this.request("/api/me/change-email/confirm", { method: "POST", body: { k, new_email: newEmail, code } });
  },

  /** 管理员：为用户设置图片头像（url = 图床直链 https://…；图片字节流不经 Worker，读取时 302 跳转） */
  async setUserAvatar(userId, url) {
    return this.request(`/api/admin/users/${encodeURIComponent(userId)}/avatar`, { method: "POST", body: { url } });
  },

  /** 登录用户：设置自己的头像（url = 图床直链；空串 = 清除恢复首字默认；5 次/时限流） */
  async setMyAvatar(url) {
    return this.request("/api/auth/avatar", { method: "POST", body: { url } });
  },

  /** 管理员：读取 / 代改指定用户资料（昵称/联系方式/签名；豁免档位按目标用户角色） */
  async adminUserProfile(id) {
    return this.request(`/api/admin/users/${encodeURIComponent(id)}/profile`);
  },
  async adminSetUserProfile(id, payload) {
    return this.request(`/api/admin/users/${encodeURIComponent(id)}/profile`, { method: "POST", body: payload });
  },
  /** 管理员：设置用户头衔（≤12 字，留空恢复默认「平平无奇的路人」） */
  async adminSetTitle(id, title) {
    return this.request(`/api/admin/users/${encodeURIComponent(id)}/title`, { method: "POST", body: { title } });
  },

  /** 头像图片 URL（无图返回 404，前端回退首字圆形）；v 为版本号作缓存破坏 */
  avatarUrl(uid, v) {
    return `${API_BASE}/api/auth/avatar/${encodeURIComponent(uid)}${v ? `?v=${v}` : ""}`;
  },
  /** 证明材料图片（出让/出租审核照片；私密时需登录 Cookie/Token 不可直接 <img>，走 fetch blob） */
  proofUrl(postId, key) {
    return `${API_BASE}/api/cardhub/posts/${encodeURIComponent(postId)}/proof/${encodeURIComponent(key)}`;
  },
  /** 私密证明材料加载：带 Authorization 头 fetch → objectURL（用完需 URL.revokeObjectURL） */
  async proofBlobUrl(postId, key) {
    const headers = {};
    const token = this.getToken();
    if (token) headers["Authorization"] = "Bearer " + token;
    const resp = await fetch(this.proofUrl(postId, key), { headers });
    if (!resp.ok) throw new Error("proof load failed");
    return URL.createObjectURL(await resp.blob());
  },
  async sendResetCode(email, captcha) {
    return this.request("/api/auth/send-code", { method: "POST", body: { email, purpose: "reset", captcha } });
  },
  async resetPassword(email, k, salt, iter, code, captcha) {
    return this.request("/api/auth/reset-password", { method: "POST", body: { email, k, salt, iter, code, captcha } });
  },

  /* ── CardHub 接口 ── */
  async getSchema() { return this.request("/api/cardhub/schema"); },
  async getPosts(params = {}) {
    // 剔除空值：URLSearchParams 会把 undefined 序列化成字面量 "undefined" 传给后端
    const clean = Object.fromEntries(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ""),
    );
    const qs = new URLSearchParams(clean).toString();
    return this.request("/api/cardhub/posts" + (qs ? "?" + qs : ""));
  },
  /** 各板块 open 帖计数（侧栏徽章，服务端 GROUP BY，避免前端基于单页估算） */
  async boardCounts() { return this.request("/api/cardhub/board-counts"); },

  /* ── 活动集锦（资费页 tab） ── */
  /** 公开列表：carrier+province（服务端匹配本省+全国，未到期）；登录时附带 mine_pending */
  async activitiesList(carrier, province) {
    return this.request(`/api/activities?carrier=${encodeURIComponent(carrier || "")}&province=${encodeURIComponent(province || "")}`);
  },
  /* 活动二维码原图（鉴权随 Bearer；下载用 blob → <a download>）。
     ?dl=1 走独立 URL（与 <img> 展示分开的缓存键）并取 attachment 语义 */
  async activityQrBlobUrl(id) {
    const headers = {};
    const token = this.getToken();
    if (token) headers["Authorization"] = "Bearer " + token;
    const resp = await fetch(`${API_BASE}/api/activities/${encodeURIComponent(id)}/qr?dl=1`, { headers });
    if (!resp.ok) throw new Error("qr load failed");
    return URL.createObjectURL(await resp.blob());
  },
  async activityCreate(body) { return this.request("/api/activities", { method: "POST", body }); },
  /** 详情（含攻略 Markdown 正文）：open 公众可读；其余状态仅提交者与 admin */
  async activityDetail(id) { return this.request("/api/activities/" + encodeURIComponent(id)); },
  /** 提交者撤回自己的待审提交 */
  async activityDelete(id) { return this.request(`/api/activities/${encodeURIComponent(id)}`, { method: "DELETE" }); },
  /** 切换收藏（幂等 toggle），返回 { favorited } */
  async activityFavoriteToggle(id) { return this.request(`/api/activities/${encodeURIComponent(id)}/favorite`, { method: "POST" }); },
  /** 我的收藏（仅 open 且未过期，收藏时间倒序） */
  async activityMyFavorites() { return this.request("/api/activities/me/favorites"); },
  /** 管理组：置顶 / 取消置顶 */
  async activityPin(id) { return this.request(`/api/activities/${encodeURIComponent(id)}/pin`, { method: "POST" }); },
  async activityUnpin(id) { return this.request(`/api/activities/${encodeURIComponent(id)}/pin`, { method: "DELETE" }); },
  /** 管理列表（admin）：status 省略=全部状态 */
  async adminActivityList(status) { return this.request("/api/admin/activities" + (status ? `?status=${encodeURIComponent(status)}` : "")); },
  async adminActivityReview(id, approve, reason) { return this.request(`/api/admin/activities/${encodeURIComponent(id)}/review`, { method: "POST", body: { approve, reason: reason || "" } }); },
  async adminActivityRetire(id) { return this.request(`/api/admin/activities/${encodeURIComponent(id)}/retire`, { method: "POST", body: {} }); },
  async adminActivityDelete(id) { return this.request(`/api/admin/activities/${encodeURIComponent(id)}`, { method: "DELETE" }); },
  /* ── 唠嗑聚落（activities mode='chat'：社群收录） ── */
  /** 社群列表：carrier+province（服务端匹配 本运营商本省+本运营商全国+通用） */
  async communitiesList(carrier, province) {
    return this.request(`/api/communities?carrier=${encodeURIComponent(carrier || "")}&province=${encodeURIComponent(province || "")}`);
  },
  /** 提交社群（→ pending，管理组审核）；body 含 scope/carrier/province/qr/proof 等 */
  async communityCreate(body) { return this.request("/api/communities", { method: "POST", body }); },
  /** 提交者撤回自己的待审社群 */
  async communityDelete(id) { return this.request(`/api/communities/${encodeURIComponent(id)}`, { method: "DELETE" }); },
  /** 管理组：查看授权凭证原图（blob url） */
  async communityProofBlobUrl(id) {
    const headers = {};
    const token = this.getToken();
    if (token) headers["Authorization"] = "Bearer " + token;
    const resp = await fetch(`${API_BASE}/api/admin/communities/${encodeURIComponent(id)}/proof`, { headers });
    if (!resp.ok) throw new Error("proof load failed");
    return URL.createObjectURL(await resp.blob());
  },
  async getPost(id) { return this.request("/api/cardhub/posts/" + id); },
  async createPost(body) { return this.request("/api/cardhub/posts", { method: "POST", body }); },
  async myPosts() { return this.request("/api/cardhub/me/posts"); },
  async myDeals() { return this.request("/api/cardhub/me/deals"); },
  async closePost(id) { return this.request("/api/cardhub/posts/" + id + "/close", { method: "POST" }); },
  async withdrawPost(id) { return this.request("/api/cardhub/posts/" + id + "/withdraw", { method: "POST" }); },
  async resubmitPost(id) { return this.request("/api/cardhub/posts/" + id + "/resubmit", { method: "POST" }); },
  /** 编辑自己的帖子（open/rejected/expired 可改）→ 转 pending 重新审核；板块/运营商/省市不可改 */
  async updatePost(id, body) { return this.request("/api/cardhub/posts/" + id, { method: "PUT", body }); },
  async deletePost(id) { return this.request("/api/cardhub/posts/" + id, { method: "DELETE" }); },

  /* ── 对话接口 ── */
  async createConversation(body) { return this.request("/api/cardhub/conversations", { method: "POST", body }); },
  async dmCreate(uid) { return this.request("/api/cardhub/dm/" + encodeURIComponent(uid), { method: "POST", body: {} }); },
  async adminConversations(userId) { return this.request("/api/admin/conversations?user_id=" + encodeURIComponent(userId)); },
  async myConversations() { return this.request("/api/cardhub/me/conversations"); },
  async getConversation(id) { return this.request("/api/cardhub/conversations/" + encodeURIComponent(id)); },
  async convHide(id) { return this.request("/api/cardhub/conversations/" + encodeURIComponent(id) + "/hide", { method: "POST", body: {} }); },
  async replyMessage(convId, body) { return this.request("/api/cardhub/conversations/" + convId + "/messages", { method: "POST", body }); },
  async relayRequest(body) { return this.request("/api/cardhub/relay-requests", { method: "POST", body }); },

  /* ── 收藏与置顶 ── */
  /** 收藏 toggle（幂等）：返回 { favorited: bool } 最新状态；取消收藏不受帖子状态限制 */
  async toggleFavorite(id) { return this.request(`/api/cardhub/posts/${encodeURIComponent(id)}/favorite`, { method: "POST" }); },
  /** 我的收藏：open 帖带完整列表投影，失效帖仅最小字段 + status */
  async myFavorites() { return this.request("/api/cardhub/me/favorites"); },
  /** 精华置顶三操作（仅管理组；后端 guard('admin') 强校验） */
  async pinPost(id) { return this.request(`/api/cardhub/posts/${encodeURIComponent(id)}/pin`, { method: "POST" }); },
  async unpinPost(id) { return this.request(`/api/cardhub/posts/${encodeURIComponent(id)}/pin`, { method: "DELETE" }); },
  async pinBump(id) { return this.request(`/api/cardhub/posts/${encodeURIComponent(id)}/pin/bump`, { method: "POST" }); },

  /* ── Admin 接口 ── */
  async adminStats() { return this.request("/api/admin/stats"); },
  async adminPending() { return this.request("/api/admin/posts/pending"); },
  /** 管理端帖子详情（任意状态）：raw 完整数据 + listView/userView/guestView 三视角公众预览 */
  async adminPostDetail(id) { return this.request("/api/admin/posts/" + encodeURIComponent(id)); },
  async adminReview(id, approve, reason) { return this.request("/api/admin/posts/" + id + "/review", { method: "POST", body: { approve, reason } }); },
  /* 帖子全量管理：status/board 筛选 + q 搜索 + 分页 */
  async adminPosts(params) { const qs = new URLSearchParams(params).toString(); return this.request("/api/admin/posts" + (qs ? "?" + qs : "")); },
  async adminClosePost(id) { return this.request("/api/admin/posts/" + id + "/close", { method: "POST", body: {} }); },
  async adminDeletePost(id) { return this.request("/api/admin/posts/" + id, { method: "DELETE" }); },
  async adminRelay(status) { return this.request("/api/admin/relay-requests" + (status ? "?status=" + status : "")); },
  async adminRelayHandle(id, action) { return this.request("/api/admin/relay-requests/" + id + "/handle", { method: "POST", body: { action } }); },
  async adminUsers(params) { const qs = new URLSearchParams(params).toString(); return this.request("/api/admin/users" + (qs ? "?" + qs : "")); },
  async adminBan(id, reason) { return this.request("/api/admin/users/" + id + "/ban", { method: "POST", body: { reason } }); },
  async adminUnban(id) { return this.request("/api/admin/users/" + id + "/unban", { method: "POST" }); },
  async adminSetRole(id, role) { return this.request("/api/admin/users/" + id + "/role", { method: "POST", body: { role } }); },
  async adminSettings() { return this.request("/api/admin/settings"); },
  async adminUpdateSetting(key, value) { return this.request("/api/admin/settings/" + key, { method: "PUT", body: { value } }); },
  async adminAudit(params) { const qs = new URLSearchParams(params).toString(); return this.request("/api/admin/audit" + (qs ? "?" + qs : "")); },
};

/* ── PBKDF2 辅助（浏览器 Web Crypto） ── */
export async function pbkdf2Base64(password, saltB64, iterations) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, keyMaterial, 256);
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

/** 生成 16 字节随机盐（base64），用于新用户注册 */
export function randomSalt() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export const DEFAULT_ITER = 600000;

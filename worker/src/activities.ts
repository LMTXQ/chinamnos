import type { Env } from './common/env';
import { ERR, fail, ok } from './common/envelope';
import { guard } from './common/auth';
import { hitLimit } from './common/ratelimit';
import { randomBase62 } from './common/crypto';
import { audit } from './common/audit';
import { getPublicProfiles } from './auth/public-profile';
import { decodeDataUrl } from './cardhub/proofs';
import { pushNotification } from './common/notifications';

/* 情报酒馆（原活动集锦）：资费页「情报酒馆」tab 的双模式信息聚合（用户提交 → 管理员审核 → 公开展示）。
   mode=official 官方活动推广：沿用原活动语义（主链接必填、二维码/截止选填、按运营商维度）；
   mode=guide 个人攻略发布：Markdown 正文必填、主链接/二维码选填、附加链接 ≤5、
     支持「全运营商通用」（carrier=''，任意运营商 tab 命中）与长期有效（无截止）。
   与工具箱（nav_links，仅站长审核）的差异：审核/退役/删除均 admin 及以上；
   官方活动有时效（ends_at 选填，到期 Cron 置 expired，读路径同步过滤双保险）。
   维度：carrier + province（省份空串=全国，展示时随资费页当前省份匹配「本省+全国」）。
   附加链接 links=[{label,url}] JSON（两模式共用）；攻略正文 content_md ≤10000 字符。
   匿名 anon=1：公众侧不下发提交者 uid/昵称（管理组无限制，audit 日志照记）。
   二维码：选填，随提交上传，R2 存对象（PROOFS 桶 activities/<id>/qr.<ext>），D1 存对象键；
   open 状态公众可读，其余状态仅提交者与管理组（同 post_proofs 的鉴权思路）。 */

const CARRIERS = new Set(['cmcc', 'cucc', 'ctcc', 'cbn']);
const TITLE_MIN = 2, TITLE_MAX = 40;
const URL_MAX = 300;
const DESCR_MAX = 200;
const LINK_MAX = 5;        // 附加链接上限（主链接之外）
const LABEL_MAX = 12;      // 附加链接文案上限
const MD_MAX = 10000;      // 攻略正文上限（字符）
const EXCERPT_LEN = 120;   // 列表摘要长度
const PENDING_QUOTA = 5;   // 同用户待审上限（与工具箱一致）
const SUBMIT_LIMIT = 3;    // 提交限流：3 次/时（rate_buckets）
const QR_MAX_DIM = 2500;   // 二维码图宽/高上限

interface ActLink { label: string; url: string; }

interface ActRow {
  id: string;
  mode: string;
  carrier: string;
  province: string;
  title: string;
  url: string;
  descr: string;
  links: string | null;
  content_md: string | null;
  ends_at: number | null;
  status: string;
  reject_reason: string | null;
  anon: number;
  submitted_by: string;
  reviewer_id: string | null;
  created_at: number;
  reviewed_at: number | null;
  qr_key?: string | null;
  proof_key?: string | null;
  chat_type?: string | null;
  chat_id?: string | null;
  pinned_at?: number | null;
}

function validActivityUrl(u: string): boolean {
  if (!u || u.length > URL_MAX) return false;
  try { const x = new URL(u); return x.protocol === 'https:' && !!x.hostname; } catch { return false; }
}

/* 查重归一化：协议+主机小写、去 hash、去结尾斜杠（路径保留原大小写） */
function normUrl(u: string): string {
  try {
    const x = new URL(u);
    x.hash = '';
    let s = `${x.protocol}//${x.host.toLowerCase()}${x.pathname}${x.search}`;
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch { return u; }
}

/* 附加链接解析校验：[{label,url}]；≤LINK_MAX 条、label ≤LABEL_MAX、url https ≤URL_MAX、
   归一化去重、不与主链接重复（主链接为空时仅内部去重）。任一非法整体拒绝（返回 'invalid'） */
function parseLinks(v: unknown, mainUrl: string): ActLink[] | 'invalid' {
  if (v === undefined || v === null || v === '') return [];
  if (!Array.isArray(v) || v.length > LINK_MAX) return 'invalid';
  const out: ActLink[] = [];
  const seen = new Set<string>();
  const nMain = mainUrl ? normUrl(mainUrl) : '';
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') return 'invalid';
    const label = typeof (raw as Record<string, unknown>).label === 'string' ? ((raw as Record<string, unknown>).label as string).trim() : '';
    const url = typeof (raw as Record<string, unknown>).url === 'string' ? ((raw as Record<string, unknown>).url as string).trim() : '';
    if (!label || label.length > LABEL_MAX || !validActivityUrl(url)) return 'invalid';
    const n = normUrl(url);
    if (seen.has(n) || (nMain && n === nMain)) return 'invalid';
    seen.add(n);
    out.push({ label, url });
  }
  return out;
}

/* 防御解析落库 links JSON（损坏或结构变化时静默降级为空数组，读路径不因脏数据 500） */
export function safeLinks(s: string | null): ActLink[] {
  if (!s) return [];
  try {
    const arr = JSON.parse(s);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
      .map((x) => ({ label: String(x.label || '链接').slice(0, LABEL_MAX), url: String(x.url || '') }))
      .filter((x) => !!x.url);
  } catch { return []; }
}

/* 列表摘要：剥离 md 语法取前 EXCERPT_LEN 字（代码块/图片剔除，链接保留文字，连续空白归一） */
export function mdExcerpt(md: string): string {
  const text = md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^([-*]|\d+[.．、])\s+/gm, '')
    .replace(/[*`~_]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > EXCERPT_LEN ? text.slice(0, EXCERPT_LEN) + '…' : text;
}

const PROVINCE_RE = /^[\u4e00-\u9fa5]{2,10}$/; // 中文省份简称（广东/内蒙古…）

function parseEndsAt(v: unknown): number | null | 'invalid' {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= Date.now() || n > Date.now() + 400 * 86400 * 1000) return 'invalid';
  return n;
}

// GET /api/activities?carrier=cmcc&province=广东：公开列表（本省+全国，未到期；游客可看）
//   官方活动按运营商过滤；攻略支持「通用」（carrier=''，任意运营商 tab 均命中）
//   登录用户额外返回自己的待审提交（mine_pending，公开列表不含 pending）
//   匿名（anon=1）公众侧不下发提交者 uid/昵称；管理组无限制（走 admin 列表）
export async function handleActivityList(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'anon');
  if (g instanceof Response) return g;

  const url = new URL(request.url);
  const carrier = url.searchParams.get('carrier') || '';
  const province = url.searchParams.get('province') || '';
  if (!CARRIERS.has(carrier)) return ok({ items: [], mine_pending: [] });

  const now = Date.now();
  const rows = await env.DB.prepare(
    `SELECT id, mode, carrier, province, title, url, descr, links, content_md, ends_at, anon, status, submitted_by, created_at, qr_key, pinned_at
     FROM activities
     WHERE mode != 'chat' AND status = 'open' AND (carrier = ?1 OR carrier = '') AND province IN (?2, '') AND (ends_at IS NULL OR ends_at > ?3)
     ORDER BY (pinned_at IS NULL) ASC, pinned_at DESC, (province = '') DESC, created_at DESC LIMIT 50`,
  ).bind(carrier, province, now).all<ActRow>();

  const uids = [...new Set(rows.results.filter((r) => !r.anon).map((r) => r.submitted_by))];
  const authorMap = await getPublicProfiles(env, uids);

  /* 登录用户的收藏集合（列表标记 favorited；游客恒 false） */
  const favSet = new Set<string>();
  if (g.viewer.id && rows.results.length) {
    const placeholders = rows.results.map((_, i) => `?${i + 2}`).join(',');
    const favRows = await env.DB.prepare(
      `SELECT activity_id FROM act_favorites WHERE user_id = ?1 AND activity_id IN (${placeholders})`,
    ).bind(g.viewer.id, ...rows.results.map((r) => r.id)).all<{ activity_id: string }>();
    for (const f of favRows.results || []) favSet.add(f.activity_id);
  }

  const items = rows.results.map((r) => {
    const anon = !!r.anon;
    return {
      id: r.id, mode: r.mode || 'official', carrier: r.carrier, province: r.province, title: r.title,
      url: r.url || null,
      descr: r.descr,
      links: safeLinks(r.links),
      excerpt: r.mode === 'guide' ? mdExcerpt(r.content_md || '') : r.descr,
      ends_at: r.ends_at, created_at: r.created_at,
      has_qr: !!r.qr_key,
      anon,
      // 非匿名下发 uid（个人资料卡入口需要）；匿名公众侧不下发
      submitted_by: anon ? null : r.submitted_by,
      submitter_nickname: anon ? null : (authorMap.get(r.submitted_by)?.nickname ?? null),
      favorited: favSet.has(r.id),
      pinned: !!r.pinned_at,
    };
  });

  /* 我的投稿（三态区数据源）：待审 + 最近 30 天已审结（带 status/reject_reason）；
     mine_pending 保留旧字段仅为部署过渡期旧前端的待审区兼容 */
  let minePending: Array<Record<string, unknown>> = [];
  let mineAll: Array<Record<string, unknown>> = [];
  if (g.viewer.id) {
    const mine = await env.DB.prepare(
      `SELECT id, mode, province, title, url, descr, ends_at, content_md, anon, carrier, status, reject_reason, created_at, reviewed_at FROM activities
       WHERE mode != 'chat' AND submitted_by = ?1 AND (carrier = ?2 OR carrier = '') AND (province = ?3 OR province = '')
         AND (status = 'pending' OR (status IN ('open', 'rejected') AND reviewed_at > ?4))
       ORDER BY created_at DESC LIMIT 50`,
    ).bind(g.viewer.id, carrier, province, Date.now() - 30 * 86400 * 1000).all<ActRow>();
    mineAll = mine.results.map((r) => ({ id: r.id, mode: r.mode || 'official', province: r.province, title: r.title, url: r.url || null, descr: r.descr || null, ends_at: r.ends_at, content_md: r.content_md || null, anon: !!r.anon, carrier: r.carrier, status: r.status, reject_reason: r.reject_reason, created_at: r.created_at, reviewed_at: r.reviewed_at }));
    minePending = mineAll.filter((r) => r.status === 'pending');
  }

  return ok({ items, mine: mineAll, mine_pending: minePending });
}

/* ── 收藏（登录用户私有数据；act_favorites 独立于 posts.favorites） ── */

// POST /api/activities/:id/favorite：切换收藏状态（幂等 toggle），返回最新状态
//   取消收藏任何时候都允许；新增收藏要求情报为 open
export async function handleActivityFavoriteToggle(request: Request, env: Env, id: string): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  const existing = await env.DB.prepare(
    'SELECT 1 AS x FROM act_favorites WHERE user_id = ?1 AND activity_id = ?2',
  ).bind(g.viewer.id, id).first();
  if (existing) {
    await env.DB.prepare('DELETE FROM act_favorites WHERE user_id = ?1 AND activity_id = ?2').bind(g.viewer.id, id).run();
    return ok({ favorited: false });
  }

  const act = await env.DB.prepare(
    'SELECT id, status FROM activities WHERE id = ?1',
  ).bind(id).first<{ id: string; status: string }>();
  if (!act) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
  if (act.status !== 'open') return fail(ERR.VALIDATION_ERROR, 'NOT_OPEN', 400);

  await env.DB.prepare(
    'INSERT INTO act_favorites (user_id, activity_id, created_at) VALUES (?1, ?2, ?3)',
  ).bind(g.viewer.id, id, Date.now()).run();
  return ok({ favorited: true });
}

// GET /api/activities/me/favorites：我的收藏（收藏时间倒序；仅 open 且未过期——
//   情报下架/过期后自动移出收藏展示，与 posts 收藏保留标记的策略不同：活动/攻略时效性强，过期即无价值）
export async function handleMyActivityFavorites(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  const rows = await env.DB.prepare(
    `SELECT a.id, a.mode, a.carrier, a.province, a.title, a.url, a.descr, a.links, a.content_md,
            a.ends_at, a.anon, a.submitted_by, a.created_at, a.qr_key
     FROM act_favorites f JOIN activities a ON a.id = f.activity_id
     WHERE f.user_id = ?1 AND a.status = 'open' AND (a.ends_at IS NULL OR a.ends_at > ?2)
     ORDER BY f.created_at DESC LIMIT 100`,
  ).bind(g.viewer.id, Date.now()).all<ActRow>();

  const uids = [...new Set(rows.results.filter((r) => !r.anon).map((r) => r.submitted_by))];
  const authorMap = await getPublicProfiles(env, uids);
  const items = rows.results.map((r) => {
    const anon = !!r.anon;
    return {
      id: r.id, mode: r.mode || 'official', carrier: r.carrier, province: r.province, title: r.title,
      url: r.url || null,
      descr: r.descr,
      links: safeLinks(r.links),
      excerpt: r.mode === 'guide' ? mdExcerpt(r.content_md || '') : r.descr,
      ends_at: r.ends_at, created_at: r.created_at,
      has_qr: !!r.qr_key,
      anon,
      submitted_by: anon ? null : r.submitted_by,
      submitter_nickname: anon ? null : (authorMap.get(r.submitted_by)?.nickname ?? null),
      favorited: true,
      pinned: false, // 收藏视图按收藏时间排序，不参与置顶
    };
  });
  return ok({ items });
}

/* ── 置顶（管理组专属；activities.pinned_at 与 posts.pinned_at 同语义） ── */

// POST /api/activities/:id/pin：置顶（仅 open；刷新即重排到置顶区最前）
export async function handleActivityPin(request: Request, env: Env, id: string): Promise<Response> {
  const g = await guard(request, env, 'admin');
  if (g instanceof Response) return g;

  const act = await env.DB.prepare(
    'SELECT id, title, status FROM activities WHERE id = ?1',
  ).bind(id).first<{ id: string; title: string; status: string }>();
  if (!act) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
  if (act.status !== 'open') return fail(ERR.VALIDATION_ERROR, 'NOT_OPEN', 400);

  const now = Date.now();
  await env.DB.prepare('UPDATE activities SET pinned_at = ?1 WHERE id = ?2').bind(now, id).run();

  await audit(env, request, g.viewer, {
    action: 'pin_activity',
    targetType: 'activity',
    targetId: id,
    detail: { title: act.title },
  });
  return ok({ pinned_at: now });
}

// DELETE /api/activities/:id/pin：取消置顶（幂等）
export async function handleActivityUnpin(request: Request, env: Env, id: string): Promise<Response> {
  const g = await guard(request, env, 'admin');
  if (g instanceof Response) return g;

  const r = await env.DB.prepare('UPDATE activities SET pinned_at = NULL WHERE id = ?1').bind(id).run();
  if (!r.meta.changes) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);

  await audit(env, request, g.viewer, {
    action: 'unpin_activity',
    targetType: 'activity',
    targetId: id,
  });
  return ok({ pinned_at: null });
}

// POST /api/activities：用户提交（→ pending，管理员审核）
//   mode=official 官方活动推广（沿用原活动语义：主链接必填、二维码/截止选填）
//   mode=guide 个人攻略发布（Markdown 正文必填、主链接/二维码选填、支持通用全运营商、长期有效）
export async function handleActivityCreate(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }

  const mode = body.mode === 'guide' ? 'guide' : 'official';
  const carrier = typeof body.carrier === 'string' ? body.carrier : '';
  const province = typeof body.province === 'string' ? body.province.trim() : '';
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  const descr = typeof body.descr === 'string' ? body.descr.trim() : '';
  const content = typeof body.content_md === 'string' ? body.content_md.trim() : '';
  const anon = body.anon === true || body.anon === 1 ? 1 : 0;
  const ends = parseEndsAt(body.ends_at);

  const fieldErr = (field: string, message: string) => fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field, message });

  // 附加链接（两模式共用，选填）：[{label,url}]，≤LINK_MAX 条、文案 ≤LABEL_MAX 字、https、去重、不与主链接重复
  const links = parseLinks(body.links, url);
  if (links === 'invalid') {
    return fieldErr('links', `附加链接无效（最多 ${LINK_MAX} 条，名称 ≤${LABEL_MAX} 字，须为 https 链接且不重复）`);
  }

  // 二维码（选填）：dataURL 解码 + 魔数嗅探（复用证明材料的 decodeDataUrl，≤300KB）
  const qrObj = (body.qr && typeof body.qr === 'object') ? body.qr as Record<string, unknown> : null;
  let qr: { bytes: Uint8Array; mime: string } | null = null;
  if (qrObj) {
    const dec = decodeDataUrl(typeof qrObj.data === 'string' ? qrObj.data : '');
    const w = Number(qrObj.w), h = Number(qrObj.h);
    if (!dec) return fieldErr('qr', '二维码图片无效（仅支持 PNG / JPG / WebP，≤300KB）');
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 16 || h < 16 || w > QR_MAX_DIM || h > QR_MAX_DIM) {
      return fieldErr('qr', '二维码图片尺寸无效');
    }
    qr = dec;
  }

  // 运营商：official 必填；guide 允许留空 =「全运营商通用」（列表随任意运营商 tab 命中）
  if (mode === 'official' && !CARRIERS.has(carrier)) return fieldErr('carrier', '运营商无效');
  if (carrier && !CARRIERS.has(carrier)) return fieldErr('carrier', '运营商无效');
  if (province && !PROVINCE_RE.test(province)) return fieldErr('province', '省份无效（留空为全国）');
  if (title.length < TITLE_MIN || title.length > TITLE_MAX) return fieldErr('title', `标题需 ${TITLE_MIN}~${TITLE_MAX} 字`);
  // 主链接：official 必填；guide 选填（可只靠正文内链接/附加链接）
  if (mode === 'official' && !validActivityUrl(url)) return fieldErr('url', '活动地址无效（必须为 https 链接）');
  if (url && !validActivityUrl(url)) return fieldErr('url', '活动地址无效（必须为 https 链接）');
  if (descr.length > DESCR_MAX) return fieldErr('descr', `简介不超过 ${DESCR_MAX} 字`);
  // 攻略正文：guide 必填；官方活动一期不启用正文（字段预留）
  if (mode === 'guide') {
    if (!content) return fieldErr('content_md', '攻略正文不能为空');
    if (content.length > MD_MAX) return fieldErr('content_md', `攻略正文不超过 ${MD_MAX} 字`);
  } else if (content) {
    return fieldErr('content_md', '官方活动不支持正文');
  }
  if (ends === 'invalid') return fieldErr('ends_at', '截止时间无效（须为未来时间，最远一年）');

  const rl = await hitLimit(env, `act:submit:${g.viewer.id}`, SUBMIT_LIMIT, 3600);
  if (!rl) return fail(40904, 'RATE_LIMITED', 429);

  const pending = await env.DB.prepare(
    `SELECT COUNT(*) as c FROM activities WHERE submitted_by = ?1 AND status = 'pending'`,
  ).bind(g.viewer.id).first<{ c: number }>();
  if ((pending?.c ?? 0) >= PENDING_QUOTA) return fail(40906, 'ACTIVITY_QUOTA_EXCEEDED', 409);

  if (mode === 'official') {
    // 官方查重：同运营商 + 同地址（归一化）已有待审/展示中 → 拒绝重复提交（归一化比对在应用层）
    const dupRows = await env.DB.prepare(
      `SELECT id, url FROM activities WHERE carrier = ?1 AND status IN ('pending', 'open') AND province IN (?2, '')`,
    ).bind(carrier, province).all<{ id: string; url: string }>();
    const nUrl = normUrl(url);
    if ((dupRows.results || []).some((r) => normUrl(r.url) === nUrl)) {
      return fail(40905, 'ACTIVITY_EXISTS', 409);
    }
  } else {
    // 攻略查重：同提交者 + 同标题已有待审/展示中 → 防刷（不同用户同标题允许，通用攻略常重名）
    const dupGuide = await env.DB.prepare(
      `SELECT id FROM activities WHERE mode = 'guide' AND submitted_by = ?1 AND status IN ('pending', 'open') AND title = ?2 LIMIT 1`,
    ).bind(g.viewer.id, title).first<{ id: string }>();
    if (dupGuide) return fail(40905, 'ACTIVITY_EXISTS', 409);
  }

  const id = randomBase62(8);
  const now = Date.now();

  // 二维码先传 R2 再落库：落库失败时清理已传对象，保证无孤儿/无断链
  let qrKey: string | null = null;
  if (qr) {
    const ext = qr.mime === 'image/png' ? 'png' : qr.mime === 'image/webp' ? 'webp' : 'jpg';
    qrKey = `activities/${id}/qr.${ext}`;
    try {
      await env.PROOFS!.put(qrKey, qr.bytes, {
        httpMetadata: { contentType: qr.mime },
        customMetadata: { activityId: id },
      });
    } catch {
      return fail(ERR.INTERNAL_ERROR, 'QR_UPLOAD_FAILED', 500);
    }
  }

  try {
    await env.DB.prepare(
      `INSERT INTO activities (id, mode, carrier, province, title, url, descr, links, content_md, ends_at, status, anon, submitted_by, created_at, qr_key)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pending', ?11, ?12, ?13, ?14)`,
    ).bind(
      id, mode, carrier, province, title, url, descr,
      links.length ? JSON.stringify(links) : null,
      mode === 'guide' ? content : null,
      ends, anon, g.viewer.id, now, qrKey,
    ).run();
  } catch (e) {
    if (qrKey) { try { await env.PROOFS!.delete(qrKey); } catch { /* */ } }
    throw e;
  }

  return ok({ id, status: 'pending', mode });
}

// DELETE /api/activities/:id：提交者撤回自己的待审提交
export async function handleActivityDelete(request: Request, env: Env, id: string): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  const row = await env.DB.prepare(
    'SELECT id, status, submitted_by, qr_key FROM activities WHERE id = ?1',
  ).bind(id).first<ActRow>();
  if (!row) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
  if (row.submitted_by !== g.viewer.id) return fail(ERR.FORBIDDEN, 'FORBIDDEN', 403);
  // pending=撤回；rejected=清理后重投（编辑=删旧重提的回退路径）；open/expired 不可自删
  if (row.status !== 'pending' && row.status !== 'rejected') return fail(ERR.VALIDATION_ERROR, 'INVALID_STATUS', 400);

  await env.DB.prepare('DELETE FROM activities WHERE id = ?1').bind(id).run();
  await deleteActivityQr(env, row.qr_key ?? null);
  return ok({ deleted: true });
}

/** 级联删除活动二维码对象（撤回/删除时调用；失败不阻塞主流程） */
async function deleteActivityQr(env: Env, qrKey: string | null): Promise<void> {
  if (!qrKey) return;
  try { await env.PROOFS!.delete(qrKey); } catch { /* */ }
}

// GET /api/activities/:id：详情（含攻略 Markdown 正文）。
//   open → 公众可读；其余状态仅提交者与管理组（同 QR 端点鉴权思路）
//   匿名（anon=1）公众侧不下发提交者 uid/昵称；本人与管理组无限制
export async function handleActivityDetail(request: Request, env: Env, id: string): Promise<Response> {
  const g = await guard(request, env, 'anon');
  if (g instanceof Response) return g;

  if (!/^[A-Za-z0-9]{4,16}$/.test(id)) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400);
  const row = await env.DB.prepare(
    `SELECT id, mode, carrier, province, title, url, descr, links, content_md, ends_at, status, reject_reason, anon, submitted_by, created_at, qr_key
     FROM activities WHERE id = ?1`,
  ).bind(id).first<ActRow>();
  if (!row) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);

  const isOwner = !!g.viewer.id && g.viewer.id === row.submitted_by;
  const isAdmin = !!g.viewer.id && (g.viewer.role === 'admin' || g.viewer.role === 'owner');
  if (row.status !== 'open' && !isOwner && !isAdmin) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);

  const anon = !!row.anon;
  const hideAuthor = anon && !isOwner && !isAdmin;
  let nickname: string | null = null;
  if (!hideAuthor) {
    const authorMap = await getPublicProfiles(env, [row.submitted_by]);
    nickname = authorMap.get(row.submitted_by)?.nickname ?? null;
  }
  return ok({
    id: row.id, mode: row.mode || 'official', carrier: row.carrier, province: row.province,
    title: row.title, url: row.url || null, descr: row.descr,
    links: safeLinks(row.links),
    content_md: row.content_md || '',
    ends_at: row.ends_at, status: row.status, created_at: row.created_at,
    has_qr: !!row.qr_key, anon,
    submitted_by: hideAuthor ? null : row.submitted_by,
    submitter_nickname: hideAuthor ? null : nickname,
  });
}

// GET /api/activities/:id/qr[?dl=1]：活动二维码图片
// 鉴权：open 状态公众可读；其余状态仅提交者本人与管理组（同 post_proofs 思路）
export async function handleActivityQr(request: Request, env: Env, id: string): Promise<Response> {
  const g = await guard(request, env, 'anon');
  if (g instanceof Response) return g;

  if (!/^[A-Za-z0-9]{4,16}$/.test(id)) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400);
  const row = await env.DB.prepare(
    'SELECT id, title, status, submitted_by, qr_key FROM activities WHERE id = ?1',
  ).bind(id).first<ActRow>();
  if (!row || !row.qr_key) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);

  const isOwner = !!g.viewer.id && g.viewer.id === row.submitted_by;
  const isAdmin = !!g.viewer.id && (g.viewer.role === 'admin' || g.viewer.role === 'owner');
  if (row.status !== 'open' && !isOwner && !isAdmin) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);

  const obj = await env.PROOFS!.get(row.qr_key);
  if (!obj) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);

  const mime = obj.httpMetadata?.contentType || 'image/png';
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
  // private 而非 public：CDN 不缓存（无 Origin 的 <img> 请求会缓存无 CORS 头的响应，
  // 污染后续同 URL 的 fetch 下载），仅浏览器缓存即可
  const headers = new Headers({
    'Content-Type': mime,
    'Cache-Control': row.status === 'open' ? 'private, max-age=86400' : 'private, no-store',
  });
  // ?dl=1 下载（跨域 <a download> 属性无效，由后端 Content-Disposition 兜底）
  if (new URL(request.url).searchParams.get('dl')) {
    const name = `${(row.title || '活动二维码').replace(/[\r\n"\\]/g, '')}.${ext}`;
    headers.set('Content-Disposition', `attachment; filename="qr.${ext}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  }
  return new Response(obj.body, { headers });
}

/* ── 管理端（guard('admin')，全部写 audit_log） ── */

// GET /api/admin/activities?status=pending|open|rejected|retired|expired|all
// 管理组无限制：匿名提交同样下发真实提交者（昵称 + uid），审核/审计需要
export async function handleAdminActivityList(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'admin');
  if (g instanceof Response) return g;

  const status = new URL(request.url).searchParams.get('status') || 'all';
  const valid = ['pending', 'open', 'rejected', 'retired', 'expired'];
  const where = valid.includes(status) ? 'WHERE status = ?1' : '';
  const binds = valid.includes(status) ? [status] : [];
  const rows = await env.DB.prepare(
    `SELECT id, mode, carrier, province, title, url, descr, links, content_md, ends_at, status, reject_reason, anon, submitted_by, reviewer_id, created_at, reviewed_at, qr_key, chat_type, chat_id, proof_key
     FROM activities ${where} ORDER BY created_at DESC LIMIT 200`,
  ).bind(...binds).all<ActRow>();

  const uids = [...new Set(rows.results.map((r) => r.submitted_by))];
  const authorMap = await getPublicProfiles(env, uids);
  const items = rows.results.map((r) => {
    const { qr_key, links, proof_key, ...rest } = r; // qr_key/proof_key 为 R2 内部键，不下发
    return {
      ...rest,
      links: safeLinks(links),
      has_qr: !!qr_key,
      has_proof: !!proof_key, // 唠嗑聚落授权凭证存在标记（查看走 /api/admin/communities/:id/proof）
      submitter_nickname: authorMap.get(r.submitted_by)?.nickname ?? null,
    };
  });
  return ok({ items });
}

// POST /api/admin/activities/:id/review {approve:boolean, reason?:string}
export async function handleAdminActivityReview(request: Request, env: Env, id: string): Promise<Response> {
  const g = await guard(request, env, 'admin');
  if (g instanceof Response) return g;

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }
  const approve = body.approve === true;
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!approve && !reason) return fail(ERR.VALIDATION_ERROR, 'REASON_REQUIRED', 400, { field: 'reason' });

  const row = await env.DB.prepare(
    'SELECT id, mode, submitted_by, title, status FROM activities WHERE id = ?1',
  ).bind(id).first<ActRow>();
  if (!row) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
  if (row.status !== 'pending') return fail(ERR.VALIDATION_ERROR, 'NOT_PENDING', 400);

  const now = Date.now();
  await env.DB.prepare(
    `UPDATE activities SET status = ?1, reject_reason = ?2, reviewer_id = ?3, reviewed_at = ?4 WHERE id = ?5`,
  ).bind(approve ? 'open' : 'rejected', approve ? null : reason, g.viewer.id, now, id).run();

  // 站内通知提交者（尽力而为；情报与社群共用本端点，按 mode 区分文案与 kind）
  const isChat = (row.mode || 'official') === 'chat';
  const noun = isChat ? '社群' : '情报';
  await pushNotification(env, row.submitted_by,
    approve ? (isChat ? 'chat_approved' : 'act_approved') : (isChat ? 'chat_rejected' : 'act_rejected'),
    id,
    approve ? `你提交的${noun}「${row.title}」已通过审核` : `你提交的${noun}「${row.title}」未通过审核`,
    approve ? '已通过管理组审核，将随下一轮站点数据更新公开展示（约 0-8 小时）。' : `驳回原因：${reason || '未填写'}`);

  await audit(env, request, g.viewer, {
    action: approve ? 'review_activity' : 'reject_activity',
    targetType: 'activity',
    targetId: id,
    detail: { title: row.title, reason: approve ? null : reason },
  });
  return ok({ status: approve ? 'open' : 'rejected' });
}

// POST /api/admin/activities/:id/retire：展示中 → 已下架
export async function handleAdminActivityRetire(request: Request, env: Env, id: string): Promise<Response> {
  const g = await guard(request, env, 'admin');
  if (g instanceof Response) return g;

  const row = await env.DB.prepare(
    'SELECT id, mode, submitted_by, title, status FROM activities WHERE id = ?1',
  ).bind(id).first<ActRow>();
  if (!row) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
  if (row.status !== 'open') return fail(ERR.VALIDATION_ERROR, 'NOT_OPEN', 400);

  const now = Date.now();
  await env.DB.prepare(
    `UPDATE activities SET status = 'retired', reviewer_id = ?1, reviewed_at = ?2 WHERE id = ?3`,
  ).bind(g.viewer.id, now, id).run();

  // 站内通知提交者：已被管理组下架
  const isChat = (row.mode || 'official') === 'chat';
  await pushNotification(env, row.submitted_by, isChat ? 'act_retired' : 'act_retired', id,
    `你提交的${isChat ? '社群' : '情报'}「${row.title}」已被管理组下架`,
    '管理组已将该内容下架（不再公开展示）。如有疑问请通过工单中心联系管理组。');

  await audit(env, request, g.viewer, {
    action: 'retire_activity',
    targetType: 'activity',
    targetId: id,
    detail: { title: row.title },
  });
  return ok({ status: 'retired' });
}

// DELETE /api/admin/activities/:id：硬删除（任意状态）
export async function handleAdminActivityDelete(request: Request, env: Env, id: string): Promise<Response> {
  const g = await guard(request, env, 'admin');
  if (g instanceof Response) return g;

  const row = await env.DB.prepare(
    'SELECT id, title, status, qr_key, proof_key FROM activities WHERE id = ?1',
  ).bind(id).first<ActRow>();
  if (!row) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);

  await env.DB.prepare('DELETE FROM activities WHERE id = ?1').bind(id).run();
  await deleteActivityQr(env, row.qr_key ?? null);
  await deleteActivityQr(env, (row as { proof_key?: string | null }).proof_key ?? null); // 唠嗑聚落授权凭证

  await audit(env, request, g.viewer, {
    action: 'delete_activity',
    targetType: 'activity',
    targetId: id,
    detail: { title: row.title, prev_status: row.status },
  });
  return ok({ deleted: true });
}

// Cron：到期活动 open → expired（读路径已有 ends_at 过滤双保险）；对每条到期内容站内通知提交者
export async function runActivitiesCron(env: Env): Promise<void> {
  const now = Date.now();
  const expired = await env.DB.prepare(
    `SELECT id, mode, submitted_by, title FROM activities
     WHERE status = 'open' AND ends_at IS NOT NULL AND ends_at < ?1 AND submitted_by IS NOT NULL`,
  ).bind(now).all<{ id: string; mode: string | null; submitted_by: string; title: string }>();
  await env.DB.prepare(
    `UPDATE activities SET status = 'expired' WHERE status = 'open' AND ends_at IS NOT NULL AND ends_at < ?1`,
  ).bind(now).run();
  for (const r of expired.results || []) {
    const isChat = (r.mode || 'official') === 'chat';
    await pushNotification(env, r.submitted_by, 'act_expired', r.id,
      `你提交的${isChat ? '社群' : '情报'}「${r.title}」已到期自动下展`,
      '内容已到截止时间自动下展，不再公开展示。如需继续，欢迎重新投稿。');
  }
}

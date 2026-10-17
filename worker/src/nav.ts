import type { Env } from './common/env';
import { ERR, fail, ok } from './common/envelope';
import { guard } from './common/auth';
import { hitLimit } from './common/ratelimit';
import { audit } from './common/audit';
import { randomBase62 } from './common/crypto';
import { pushNotification } from './common/notifications';
// ─────────────────────────────────────────────────────────────
// 导航链接系统（工具箱等通用导航页）
// ─────────────────────────────────────────────────────────────
// collection 集合设计：一个集合 = 一个导航页（toolbox=工具箱），
// 将来「各省运营商活动汇总」等新页面只需在此白名单加集合值 + 前端复用渲染。
// 权限：浏览=所有人（仅 open）；提交=登录用户（pending ≤5 + 限流）；
//       审核/管理=仅站长（管理中心工具箱 Tab 仅站长可见）。

/** 集合白名单：新增导航页在此登记 */
const COLLECTIONS = new Set(['toolbox']);

const TITLE_MAX = 30;
const DESCR_MAX = 80;
const GROUP_MAX = 20;
const PENDING_QUOTA = 5;   // 同用户待审工具上限
const SUBMIT_LIMIT = 3;    // 提交限流：3 次/小时

interface NavRow {
  id: string;
  collection: string;
  group_name: string;
  title: string;
  url: string;
  icon_url: string | null;
  descr: string | null;
  sort: number;
  status: string;
  submitted_by: string;
  reject_reason: string | null;
  reviewer_id: string | null;
  created_at: number;
  reviewed_at: number | null;
}

/** URL 白名单：/ 开头站内路径（禁 // 协议相对）或 http(s) 绝对链接 */
export function validNavUrl(u: string): boolean {
  if (/^\/(?!\/)[A-Za-z0-9\-._~/?=&%#]*$/.test(u)) return true;
  try {
    const p = new URL(u);
    return p.protocol === 'https:' || p.protocol === 'http:';
  } catch {
    return false;
  }
}

function failInvalid(field: string): Response {
  return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field });
}

function cleanStr(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

// GET /api/nav/links?collection=toolbox：公开导航数据（仅 open，分组+排序）
export async function handleNavLinks(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const collection = url.searchParams.get('collection') || '';
  if (!COLLECTIONS.has(collection)) return fail(ERR.VALIDATION_ERROR, 'INVALID_COLLECTION', 400);

  const { results } = await env.DB.prepare(
    `SELECT id, collection, group_name, title, url, icon_url, descr
     FROM nav_links WHERE collection = ?1 AND status = 'open'
     ORDER BY group_name ASC, sort ASC, created_at ASC LIMIT 200`,
  ).bind(collection).all();

  return ok({ items: results || [] });
}

// POST /api/nav/links：用户提交新工具（→ pending，站长审核）
export async function handleNavSubmit(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }

  const collection = cleanStr(body.collection, 30);
  const groupName = cleanStr(body.group_name, GROUP_MAX) || '其他';
  const title = cleanStr(body.title, TITLE_MAX);
  const url = cleanStr(body.url, 500);
  const iconUrl = cleanStr(body.icon_url, 500);
  const descr = cleanStr(body.descr, DESCR_MAX);

  if (!COLLECTIONS.has(collection)) return fail(ERR.VALIDATION_ERROR, 'INVALID_COLLECTION', 400);
  if (title.length < 1) return failInvalid('title');
  if (!url || !validNavUrl(url)) return failInvalid('url');
  if (iconUrl && !validNavUrl(iconUrl)) return failInvalid('icon_url');

  // 提交限流 + 待审配额（防滥用刷链接）
  const rl = await hitLimit(env, `nav:submit:${g.viewer.id}`, SUBMIT_LIMIT, 3600);
  if (rl.limited) return fail(ERR.RATE_LIMITED, 'RATE_LIMITED', 429);
  const pending = await env.DB.prepare(
    `SELECT COUNT(*) as c FROM nav_links WHERE submitted_by = ?1 AND status = 'pending'`,
  ).bind(g.viewer.id).first<{ c: number }>();
  if ((pending?.c ?? 0) >= PENDING_QUOTA) return fail(40904, 'NAV_QUOTA_EXCEEDED', 409);

  const id = randomBase62(12);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO nav_links (id, collection, group_name, title, url, icon_url, descr, sort, status, submitted_by, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 100, 'pending', ?8, ?9)`,
  ).bind(id, collection, groupName, title, url, iconUrl || null, descr || null, g.viewer.id, now).run();

  return ok({ id, status: 'pending' });
}

// GET /api/admin/nav?status=&collection=：站长管理列表（全状态）
export async function handleNavAdminList(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'owner');
  if (g instanceof Response) return g;

  const url = new URL(request.url);
  const status = url.searchParams.get('status') || '';
  const collection = url.searchParams.get('collection') || '';
  if (collection && !COLLECTIONS.has(collection)) return fail(ERR.VALIDATION_ERROR, 'INVALID_COLLECTION', 400);

  const conds: string[] = [];
  const binds: unknown[] = [];
  if (status && ['pending', 'open', 'rejected', 'retired'].includes(status)) {
    conds.push('n.status = ?'); binds.push(status);
  }
  if (collection) { conds.push('n.collection = ?'); binds.push(collection); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const { results } = await env.DB.prepare(
    `SELECT n.*, u.nickname AS submitter_nickname
     FROM nav_links n LEFT JOIN users u ON n.submitted_by = u.id
     ${where}
     ORDER BY n.status ASC, n.collection ASC, n.group_name ASC, n.sort ASC, n.created_at DESC LIMIT 300`,
  ).bind(...binds).all<NavRow & { submitter_nickname: string | null }>();

  return ok({ items: results || [] });
}

// POST /api/admin/nav/:id/review：审核（pending → open | rejected）
export async function handleNavReview(request: Request, env: Env, id: string): Promise<Response> {
  const g = await guard(request, env, 'owner');
  if (g instanceof Response) return g;

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }
  const approve = body.approve === true;
  const reason = cleanStr(body.reason, 200);

  const row = await env.DB.prepare(
    `SELECT id, title, status, submitted_by FROM nav_links WHERE id = ?1`,
  ).bind(id).first<{ id: string; title: string; status: string; submitted_by: string | null }>();
  if (!row) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
  if (row.status !== 'pending') return fail(ERR.VALIDATION_ERROR, 'NOT_PENDING', 400);
  if (!approve && !reason) return fail(ERR.VALIDATION_ERROR, 'REASON_REQUIRED', 400);

  const now = Date.now();
  await env.DB.prepare(
    `UPDATE nav_links SET status = ?1, reject_reason = ?2, reviewer_id = ?3, reviewed_at = ?4 WHERE id = ?5`,
  ).bind(approve ? 'open' : 'rejected', approve ? null : reason, g.viewer.id, now, id).run();
  if (row.submitted_by) {
    await pushNotification(env, row.submitted_by,
      approve ? 'link_approved' : 'link_rejected',
      id,
      approve ? `你提交的工具「${row.title}」已通过审核` : `你提交的工具「${row.title}」未通过审核`,
      approve ? '已通过站长审核，将随下一轮站点数据更新公开展示（约 0-8 小时）。' : `驳回原因：${reason || '未填写'}`);
  }
  void audit(env, request, g.viewer, { action: 'nav_review', targetType: 'nav', targetId: id, detail: { title: row.title, approve, reason: reason || undefined } }).catch(() => {});

  return ok({ status: approve ? 'open' : 'rejected' });
}

// PUT /api/admin/nav/:id：编辑/排序/上下架（站长）
export async function handleNavUpdate(request: Request, env: Env, id: string): Promise<Response> {
  const g = await guard(request, env, 'owner');
  if (g instanceof Response) return g;

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }

  const row = await env.DB.prepare(
    `SELECT id, status FROM nav_links WHERE id = ?1`,
  ).bind(id).first<{ id: string; status: string }>();
  if (!row) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);

  // 可选字段：传了才改
  const sets: string[] = [];
  const binds: unknown[] = [];
  if ('title' in body) {
    const v = cleanStr(body.title, TITLE_MAX);
    if (!v) return failInvalid('title');
    sets.push('title = ?'); binds.push(v);
  }
  if ('url' in body) {
    const v = cleanStr(body.url, 500);
    if (!v || !validNavUrl(v)) return failInvalid('url');
    sets.push('url = ?'); binds.push(v);
  }
  if ('icon_url' in body) {
    const v = cleanStr(body.icon_url, 500);
    if (v && !validNavUrl(v)) return failInvalid('icon_url');
    sets.push('icon_url = ?'); binds.push(v || null);
  }
  if ('descr' in body) { sets.push('descr = ?'); binds.push(cleanStr(body.descr, DESCR_MAX) || null); }
  if ('group_name' in body) { sets.push('group_name = ?'); binds.push(cleanStr(body.group_name, GROUP_MAX) || '其他'); }
  if ('sort' in body) {
    const v = Number(body.sort);
    if (!Number.isInteger(v)) return failInvalid('sort');
    sets.push('sort = ?'); binds.push(v);
  }
  if ('status' in body) {
    const v = String(body.status);
    // 上线仅接受 open/retired（pending 走 review，rejected 走重新提交）
    if (!['open', 'retired'].includes(v)) return fail(ERR.VALIDATION_ERROR, 'INVALID_STATUS', 400);
    if (v === 'open' && !['open', 'retired'].includes(row.status)) {
      return fail(ERR.VALIDATION_ERROR, 'INVALID_STATUS', 400);
    }
    sets.push('status = ?'); binds.push(v);
    if (v === 'open') { sets.push('reviewed_at = ?'); binds.push(Date.now()); }
  }
  if (!sets.length) return fail(ERR.VALIDATION_ERROR, 'EMPTY_UPDATE', 400);

  await env.DB.prepare(`UPDATE nav_links SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, id).run();
  void audit(env, request, g.viewer, { action: 'nav_update', targetType: 'nav', targetId: id, detail: { fields: Object.keys(body) } }).catch(() => {});

  return ok({ updated: true });
}

// DELETE /api/admin/nav/:id：删除（写审计）
export async function handleNavDelete(request: Request, env: Env, id: string): Promise<Response> {
  const g = await guard(request, env, 'owner');
  if (g instanceof Response) return g;

  const row = await env.DB.prepare(
    `SELECT id, title FROM nav_links WHERE id = ?1`,
  ).bind(id).first<{ id: string; title: string }>();
  if (!row) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);

  await env.DB.prepare(`DELETE FROM nav_links WHERE id = ?1`).bind(id).run();
  void audit(env, request, g.viewer, { action: 'nav_delete', targetType: 'nav', targetId: id, detail: { title: row.title } }).catch(() => {});

  return ok({ deleted: true });
}

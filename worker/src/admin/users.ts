// 管理端用户管理：列表（筛选+搜索+分页）/ 封禁 / 解封 / 角色调整
import type { Env } from '../common/env';
import { ERR, fail, ok } from '../common/envelope';
import { guard } from '../common/auth';
import { audit } from '../common/audit';
import { isTrustedImageUrl } from '../common/img-hosts';
import { parseContacts, readContacts, isStaff } from '../auth/profile';

/**
 * GET /api/admin/users?status=&q=&page=1&page_size=20
 * 用户列表：状态筛选（active/banned）+ 邮箱/ID 搜索 + 分页（page_size 上限 100）。
 */
export async function handleListUsers(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'admin');
  if (g instanceof Response) return g;

  const url = new URL(request.url);
  const status = url.searchParams.get('status') ?? '';
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 50);
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(5, parseInt(url.searchParams.get('page_size') ?? '20', 10) || 20));

  let where = 'WHERE 1=1';
  const binds: (string | number)[] = [];
  if (status === 'banned' || status === 'active') { where += ` AND status = ?${binds.length + 1}`; binds.push(status); }
  if (q) {
    // LIKE 通配符转义，防 %/_ 注入
    const esc = q.replace(/([%_\\])/g, '\\$1');
    where += ` AND (email LIKE ?${binds.length + 1} ESCAPE '\\' OR id LIKE ?${binds.length + 2} ESCAPE '\\')`;
    binds.push(`%${esc}%`, `%${esc}%`);
  }

  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM users ${where}`,
  ).bind(...binds).first<{ n: number }>();
  const total = totalRow?.n ?? 0;

  const rows = await env.DB.prepare(
    `SELECT id, email, role, status, ban_reason, title, tickets_total, posts_closed, created_at, last_login_at
     FROM users ${where}
     ORDER BY created_at DESC
     LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`,
  ).bind(...binds, pageSize, (page - 1) * pageSize).all();

  return ok({ items: rows.results, total, page, page_size: pageSize });
}

/**
 * POST /api/admin/users/:id/ban  body: { reason?: string }
 * 封禁用户（admin 及以上）：仅可封禁【普通用户】——管理员/站长账号不可被封
 * （站长要处理管理员时先降为用户）。写入原因、吊销其全部会话立即踢下线，
 * 并联动下架其全部在售帖子（不可自动恢复，解封后需重新上架）。
 */
export async function handleBanUser(request: Request, env: Env, userId: string): Promise<Response> {
  const g = await guard(request, env, 'admin');
  if (g instanceof Response) return g;

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '违规操作';

  const user = await env.DB.prepare('SELECT id, email, role, status FROM users WHERE id = ?1')
    .bind(userId).first<{ id: string; email: string; role: string; status: string }>();
  if (!user) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
  // 权限矩阵：任何管理员/站长账号都不可被封禁（只能封普通用户）
  if (user.role !== 'user') return fail(ERR.FORBIDDEN, 'CANNOT_BAN_STAFF', 403);
  if (user.status === 'banned') return fail(ERR.VALIDATION_ERROR, 'ALREADY_BANNED', 400);

  await env.DB.prepare(
    `UPDATE users SET status = 'banned', ban_reason = ?1 WHERE id = ?2`,
  ).bind(reason, userId).run();
  // 吊销该用户所有 session，立即生效
  await env.DB.prepare(
    `UPDATE sessions SET revoked_at = ?1 WHERE user_id = ?2 AND revoked_at IS NULL`,
  ).bind(Date.now(), userId).run();
  // 联动下架：该用户全部在售帖子转为已下架（pending 待审帖保留在审核队列，由管理员正常拒绝）
  const closed = await env.DB.prepare(
    `UPDATE posts SET status = 'closed' WHERE user_id = ?1 AND status = 'open'`,
  ).bind(userId).run();
  const closedCount = closed.meta.changes ?? 0;

  await audit(env, request, g.viewer, {
    action: 'ban_user',
    targetType: 'user',
    targetId: userId,
    detail: { email: user.email, reason, closed_posts: closedCount },
  });

  return ok({ status: 'banned', closed_posts: closedCount });
}

// POST /api/admin/users/:id/unban：解封用户（admin 及以上；被封的必为普通用户）
export async function handleUnbanUser(request: Request, env: Env, userId: string): Promise<Response> {
  const g = await guard(request, env, 'admin');
  if (g instanceof Response) return g;

  const user = await env.DB.prepare('SELECT id, email, status FROM users WHERE id = ?1')
    .bind(userId).first<{ id: string; email: string; status: string }>();
  if (!user) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
  if (user.status !== 'banned') return fail(ERR.VALIDATION_ERROR, 'NOT_BANNED', 400);

  await env.DB.prepare(
    `UPDATE users SET status = 'active', ban_reason = NULL WHERE id = ?1`,
  ).bind(userId).run();

  await audit(env, request, g.viewer, {
    action: 'unban_user',
    targetType: 'user',
    targetId: userId,
    detail: { email: user.email },
  });

  return ok({ status: 'active' });
}

/**
 * POST /api/admin/users/:id/role  body: { role: 'user' | 'admin' }
 * 角色调整（owner 专属）：只能在 user/admin 之间变更；
 * owner 账号角色不可改，防止自我降级或提权他人为 owner。
 */
export async function handleSetUserRole(request: Request, env: Env, userId: string): Promise<Response> {
  const g = await guard(request, env, 'owner');
  if (g instanceof Response) return g;

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }
  const role = typeof body.role === 'string' ? body.role : '';
  if (role !== 'user' && role !== 'admin') {
    return fail(ERR.VALIDATION_ERROR, 'INVALID_ROLE', 400, { field: 'role' });
  }

  const user = await env.DB.prepare('SELECT id, email, role, status FROM users WHERE id = ?1')
    .bind(userId).first<{ id: string; email: string; role: string; status: string }>();
  if (!user) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
  if (user.role === 'owner') return fail(ERR.FORBIDDEN, 'CANNOT_CHANGE_OWNER', 403);
  if (user.role === role) return fail(ERR.VALIDATION_ERROR, 'ROLE_UNCHANGED', 400);

  await env.DB.prepare(`UPDATE users SET role = ?1 WHERE id = ?2`).bind(role, userId).run();

  await audit(env, request, g.viewer, {
    action: 'set_role',
    targetType: 'user',
    targetId: userId,
    detail: { email: user.email, from: user.role, to: role },
  });

  return ok({ role });
}

/**
 * POST /api/admin/users/:id/avatar  body: { url }（兼容旧 { dataUrl }）
 * 管理员为用户设置图片头像：图床直链 URL（https + 图片扩展名/图床白名单），
 * 图片字节流不经 Worker（读取时 302 跳转，CPU 归零）；旧 dataUrl 分支保留兼容存量流程。
 * 写 audit_log。
 */
const AVATAR_MAX_BYTES = 80 * 1024;
const AVATAR_RE = /^data:(image\/(?:png|jpeg|webp));base64,/;

export async function handleSetAvatar(request: Request, env: Env, userId: string): Promise<Response> {
  const g = await guard(request, env, 'admin');
  if (g instanceof Response) return g;

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }

  const url = typeof body.url === 'string' ? body.url.trim() : '';
  const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl.trim() : '';
  if (!url && !dataUrl) return fail(ERR.VALIDATION_ERROR, 'INVALID_IMAGE', 400, { field: 'url' });

  let avatarValue = '';
  let auditBytes = 0;
  if (url) {
    // 图床直链：https + 可信图片外链（扩展名或图床白名单），Worker 不落图片字节
    if (!isTrustedImageUrl(url)) {
      return fail(ERR.VALIDATION_ERROR, 'INVALID_IMAGE_URL', 400, {
        field: 'url', message: '须为 https 图片直链（.png/.jpg/.webp/.gif 结尾或受信任图床域名）',
      });
    }
    avatarValue = url;
    auditBytes = url.length;
  } else {
    // 旧 dataUrl 流程兼容：base64 体积约为二进制 4/3 倍，按解码后大小校验
    if (!AVATAR_RE.test(dataUrl)) return fail(ERR.VALIDATION_ERROR, 'INVALID_IMAGE', 400, { field: 'dataUrl' });
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const bytes = Math.floor(b64.length * 3 / 4);
    if (bytes > AVATAR_MAX_BYTES) return fail(ERR.VALIDATION_ERROR, 'IMAGE_TOO_LARGE', 400, { field: 'dataUrl' });
    avatarValue = dataUrl;
    auditBytes = bytes;
  }

  const user = await env.DB.prepare('SELECT id, email FROM users WHERE id = ?1')
    .bind(userId).first<{ id: string; email: string }>();
  if (!user) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);

  const now = Date.now();
  await env.DB.prepare('UPDATE users SET avatar = ?1, avatar_updated_at = ?2 WHERE id = ?3')
    .bind(avatarValue, now, userId).run();

  await audit(env, request, g.viewer, {
    action: 'set_avatar',
    targetType: 'user',
    targetId: userId,
    detail: { email: user.email, bytes: auditBytes, kind: url ? 'url' : 'dataurl' },
  });

  return ok({ avatar_v: now });
}

/**
 * GET /api/admin/users/:id/profile
 * 管理员读取指定用户完整资料（昵称 / 联系方式含各条公开标志 / 签名），供后台代改。
 */
export async function handleGetUserProfile(request: Request, env: Env, userId: string): Promise<Response> {
  const g = await guard(request, env, 'admin');
  if (g instanceof Response) return g;

  const u = await env.DB.prepare(
    'SELECT id, email, role, nickname, contacts, bio FROM users WHERE id = ?1',
  ).bind(userId).first<{ id: string; email: string; role: string; nickname: string | null; contacts: string | null; bio: string | null }>();
  if (!u) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);

  return ok({
    id: u.id, email: u.email, role: u.role,
    nickname: u.nickname,
    contacts: readContacts(u.contacts),
    bio: u.bio,
  });
}

/**
 * POST /api/admin/users/:id/profile  body: { nickname?, contacts?, bio? }
 * 管理员代改用户资料：校验规则与用户自查端点相同，但豁免档位按【目标用户】角色判定
 * （代改普通用户仍限昵称 ≤5 字、联系方式 ≤15 字且禁中文；目标为管理员则豁免）。
 * owner 账号资料不可代改（站长用自己的账号设置界面）。写 audit_log。
 */
const NICK_RE_ADMIN = /^[\p{L}\p{N}_-]+$/u;
const BIO_MAX_ADMIN = 25;

export async function handleSetUserProfile(request: Request, env: Env, userId: string): Promise<Response> {
  const g = await guard(request, env, 'admin');
  if (g instanceof Response) return g;

  const user = await env.DB.prepare('SELECT id, email, role, nickname FROM users WHERE id = ?1')
    .bind(userId).first<{ id: string; email: string; role: string; nickname: string | null }>();
  if (!user) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
  if (user.role === 'owner') return fail(ERR.FORBIDDEN, 'CANNOT_EDIT_OWNER', 403);

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }

  // 昵称：与 /api/auth/nickname 同规则（豁免按目标角色）
  const nickname = typeof body.nickname === 'string' ? body.nickname.trim() : (user.nickname ?? '');
  const staff = isStaff(user.role);
  const nickMax = staff ? 20 : 5;
  if (nickname && (nickname.length < 2 || nickname.length > nickMax || !NICK_RE_ADMIN.test(nickname))) {
    return fail(ERR.VALIDATION_ERROR, 'INVALID_NICKNAME', 400, { field: 'nickname' });
  }

  // 联系方式 / 签名：与 /api/auth/profile 同规则
  const parsed = parseContacts(body.contacts, staff);
  if (parsed.error) return fail(ERR.VALIDATION_ERROR, parsed.error, 400, { field: 'contacts' });
  const bio = typeof body.bio === 'string' ? body.bio.trim() : '';
  if (bio.length > BIO_MAX_ADMIN) return fail(ERR.VALIDATION_ERROR, 'BIO_TOO_LONG', 400, { field: 'bio' });

  await env.DB.prepare('UPDATE users SET nickname = ?1, contacts = ?2, bio = ?3 WHERE id = ?4')
    .bind(nickname || null, JSON.stringify(parsed.items), bio || null, userId).run();

  await audit(env, request, g.viewer, {
    action: 'update_user_profile',
    targetType: 'user',
    targetId: userId,
    detail: { email: user.email, nickname, contacts: parsed.items, bio: bio || null },
  });

  return ok({ id: userId, nickname, contacts: parsed.items, bio: bio || null });
}

/**
 * POST /api/admin/users/:id/title  body: { title?: string }
 * 设置用户头衔（admin 及以上）：总长 ≤26 字、中英文均可，多个头衔用「｜」分隔
 * （前端按分隔符拆成多枚小徽章渲染），留空 = 恢复默认（存 null，
 * 前端兜底显示「平平无奇的路人」）。头衔仅管理员/站长可设，展示于个人资料卡。
 * 管理员不可改 owner 的头衔。写 audit_log。
 */
const TITLE_MAX = 26;
// 头衔过滤控制字符/换行，其余（含中文）放行
const TITLE_BAD = /[\u0000-\u001f\u007f]/;

export async function handleSetTitle(request: Request, env: Env, userId: string): Promise<Response> {
  const g = await guard(request, env, 'admin');
  if (g instanceof Response) return g;

  const user = await env.DB.prepare('SELECT id, email, role FROM users WHERE id = ?1')
    .bind(userId).first<{ id: string; email: string; role: string }>();
  if (!user) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
  if (user.role === 'owner' && g.viewer.role !== 'owner') {
    return fail(ERR.FORBIDDEN, 'CANNOT_EDIT_OWNER', 403);
  }

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (title) {
    if (title.length > TITLE_MAX || TITLE_BAD.test(title)) {
      return fail(ERR.VALIDATION_ERROR, 'INVALID_TITLE', 400, { field: 'title' });
    }
  }

  await env.DB.prepare('UPDATE users SET title = ?1 WHERE id = ?2')
    .bind(title || null, userId).run();

  await audit(env, request, g.viewer, {
    action: 'set_title',
    targetType: 'user',
    targetId: userId,
    detail: { email: user.email, title: title || null },
  });

  return ok({ title: title || null });
}

// 管理端帖子管理：待审队列 / 全量列表（筛选+分页）/ 详情（三视角预览）/ 审核 / 下架 / 删除
import type { Env } from '../common/env';
import { ERR, fail, ok } from '../common/envelope';
import { guard, type Viewer } from '../common/auth';
import { audit } from '../common/audit';
import { notify } from '../mail/notifier';
import { getSetting } from '../common/settings';
import { deleteProofs, proofRows } from '../cardhub/proofs';
import { serializePost, type PostRow } from '../cardhub/projection';
import { getPublicProfile } from '../auth/public-profile';
import { pushNotification } from '../common/notifications';

/** 管理端列表允许的帖子状态白名单（'*' 表示全部） */
const POST_STATUSES = new Set(['pending', 'open', 'rejected', 'closed', 'expired']);
/** 管理端列表允许的板块白名单（2026-09-29 板块重构后枚举） */
const BOARDS = new Set(['lost', 'found', 'rent_out', 'rent_want']);

/**
 * GET /api/admin/posts?status=&board=&q=&page=1&page_size=20
 * 全量帖子列表：状态/板块筛选 + 标题/城市关键字搜索 + 分页（page_size 上限 50）。
 */
export async function handleListPosts(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'admin');
  if (g instanceof Response) return g;

  const url = new URL(request.url);
  const status = url.searchParams.get('status') ?? '';
  const board = url.searchParams.get('board') ?? '';
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 50);
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(50, Math.max(5, parseInt(url.searchParams.get('page_size') ?? '20', 10) || 20));

  let where = 'WHERE 1=1';
  const binds: (string | number)[] = [];
  if (POST_STATUSES.has(status)) { where += ` AND p.status = ?${binds.length + 1}`; binds.push(status); }
  if (BOARDS.has(board)) { where += ` AND p.board = ?${binds.length + 1}`; binds.push(board); }
  if (q) {
    // 关键字命中标题或城市（LIKE 转义用户可控的 %/_，防通配符注入）；纯数字时同时精确匹配帖子编号
    const esc = q.replace(/([%_\\])/g, '\\$1');
    if (/^\d+$/.test(q)) {
      where += ` AND (p.title LIKE ?${binds.length + 1} ESCAPE '\\' OR p.city LIKE ?${binds.length + 2} ESCAPE '\\' OR p.post_no = ?${binds.length + 3})`;
      binds.push(`%${esc}%`, `%${esc}%`, Number(q));
    } else {
      where += ` AND (p.title LIKE ?${binds.length + 1} ESCAPE '\\' OR p.city LIKE ?${binds.length + 2} ESCAPE '\\')`;
      binds.push(`%${esc}%`, `%${esc}%`);
    }
  }

  // 先取总数用于分页器
  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM posts p ${where}`,
  ).bind(...binds).first<{ n: number }>();
  const total = totalRow?.n ?? 0;

  const rows = await env.DB.prepare(
    `SELECT p.id, p.post_no, p.board, p.carrier, p.province, p.city, p.title, p.status,
            p.contact_policy, p.contact_visibility, p.allow_chat, p.allow_relay, p.ttl_days, p.expires_at, p.closed_at, p.created_at,
            u.email AS user_email
     FROM posts p JOIN users u ON p.user_id = u.id
     ${where}
     ORDER BY p.created_at DESC
     LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`,
  ).bind(...binds, pageSize, (page - 1) * pageSize).all();

  return ok({ items: rows.results, total, page, page_size: pageSize });
}

// GET /api/admin/posts/pending：待审帖子队列（审核页首屏，保持轻量）
export async function handlePendingPosts(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'admin');
  if (g instanceof Response) return g;

  const rows = await env.DB.prepare(
    `SELECT p.id, p.post_no, p.board, p.carrier, p.province, p.city, p.title, p.descr,
            p.contact_policy, p.contact_visibility, p.allow_chat, p.allow_relay, p.extra_json, p.review_admin_id, p.created_at, u.email as user_email
     FROM posts p JOIN users u ON p.user_id = u.id
     WHERE p.status = 'pending'
       AND (p.review_admin_id IS NULL OR p.review_admin_id = ?1 OR ?2 = 'owner')
     ORDER BY p.created_at ASC LIMIT 100`,
  ).bind(g.viewer.id, g.viewer.role).all();

  // 证明材料（审核员可见）：批量取各帖 proof keys
  const ids = (rows.results || []).map((r) => r.id as string);
  const proofMap = new Map<string, Array<{ id: string; w: number; h: number }>>();
  if (ids.length) {
    const ph = ids.map((_, k) => `?${k + 1}`).join(',');
    const prow = await env.DB.prepare(
      `SELECT post_id, id, w, h FROM post_proofs WHERE post_id IN (${ph}) ORDER BY created_at ASC`,
    ).bind(...ids).all<{ post_id: string; id: string; w: number; h: number }>();
    for (const r of prow.results || []) {
      if (!proofMap.has(r.post_id)) proofMap.set(r.post_id, []);
      proofMap.get(r.post_id)!.push({ id: r.id, w: r.w, h: r.h });
    }
  }
  const items = (rows.results || []).map((r) => ({
    ...r,
    proofs: proofMap.get(r.id as string) || [],
  }));

  return ok({ items });
}

/**
 * GET /api/admin/posts/:id
 * 管理端帖子详情（任意状态可见）：raw 完整数据（含原始号码/帖内联系方式/发布者邮箱）
 * + 三视角公众效果预览——pending 帖克隆为 open 后走与用户端完全相同的 serializePost
 * 投影路径（listView 列表卡片 / userView 登录详情 / guestView 访客详情），保证预览零漂移。
 */
export async function handleAdminPostDetail(request: Request, env: Env, id: string): Promise<Response> {
  const g = await guard(request, env, 'admin');
  if (g instanceof Response) return g;

  const post = await env.DB.prepare(`SELECT * FROM posts WHERE id = ?1`).bind(id).first<PostRow>();
  if (!post) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);

  const ownerRow = await env.DB.prepare(
    'SELECT id, email FROM users WHERE id = ?1',
  ).bind(post.user_id).first<{ id: string; email: string }>();
  const prof = await getPublicProfile(env, post.user_id);

  // 审核预览语义：模拟「审核通过上架后」的公众效果（pending 帖公众投影本为 null）
  const previewPost: PostRow = {
    ...post,
    status: 'open',
    expires_at: post.expires_at ?? Date.now() + (post.ttl_days || 30) * 86400 * 1000,
  };
  const previewViewer: Viewer = { id: 'preview-user', email: 'preview@example.com', role: 'user', status: 'active' };
  const rawContacts = safeJson(post.contacts_json, []);
  const chats = Array.isArray(rawContacts)
    ? rawContacts.filter((c) => c && typeof c === 'object' && (c as { purpose?: string }).purpose === 'chat')
        .map((c) => ({ channel: (c as { channel: string }).channel, value: (c as { value: string }).value }))
    : [];

  return ok({
    raw: {
      id: post.id,
      post_no: post.post_no,
      board: post.board,
      carrier: post.carrier,
      province: post.province,
      city: post.city,
      title: post.title,
      descr: post.descr,
      status: post.status,
      contact_policy: post.contact_policy,
      ttl_days: post.ttl_days,
      extra: safeJson(post.extra_json, {}),
      tags: safeJson(post.tags_json, []),
      contacts: chats,
      phone_plain: post.phone_plain || null,
      reject_reason: post.reject_reason || null,
      review_admin_id: post.review_admin_id || null,
      created_at: post.created_at,
      submitted_at: post.submitted_at,
      expires_at: post.expires_at,
      user_id: post.user_id,
      user_email: ownerRow?.email || '-',
      author: prof ? { id: prof.id, nickname: prof.nickname, title: prof.title, avatar_v: prof.avatar_v } : null,
    },
    listView: serializePost(previewPost, null, 'public/list'),
    userView: serializePost(previewPost, previewViewer, 'public/detail'),
    guestView: serializePost(previewPost, null, 'public/detail'),
    proofs: await proofRows(env, post.id),
  });
}

function safeJson<T>(s: string | null, fallback: T): T {
  try { return JSON.parse(s || '') as T; } catch { return fallback; }
}

/**
 * POST /api/admin/posts/:id/review  body: { approve: boolean, reason?: string }
 * 审核帖子：通过置 open 并计算到期时间；拒绝必须携带原因（≤500 字）。
 * 成功后邮件通知发布者，并写审计日志。
 */
export async function handleReviewPost(request: Request, env: Env, id: string): Promise<Response> {
  const g = await guard(request, env, 'admin');
  if (g instanceof Response) return g;

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }
  const approve = body.approve === true;
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

  const post = await env.DB.prepare(
    'SELECT id, user_id, ttl_days, title, status, review_admin_id FROM posts WHERE id = ?1',
  ).bind(id).first<{ id: string; user_id: string; ttl_days: number; title: string; status: string; review_admin_id: string | null }>();
  if (!post) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
  if (post.status !== 'pending') return fail(ERR.VALIDATION_ERROR, 'NOT_PENDING', 400);

  // 「管理员审核」模式：仅站长(owner)或该帖指定的管理员可审
  if (post.review_admin_id && g.viewer.role !== 'owner' && g.viewer.id !== post.review_admin_id) {
    return fail(40301, 'REVIEW_FORBIDDEN', 403);
  }
  // 指定管理员不能审核自己发布的帖（防自审）
  if (post.review_admin_id && post.user_id === g.viewer.id && g.viewer.role !== 'owner') {
    return fail(40301, 'REVIEW_FORBIDDEN', 403);
  }

  const now = Date.now();
  if (approve) {
    await env.DB.prepare(
      `UPDATE posts SET status = 'open', reviewed_at = ?1, expires_at = ?2, reject_reason = NULL, updated_at = ?1 WHERE id = ?3`,
    ).bind(now, now + post.ttl_days * 86400 * 1000, id).run();
  } else {
    if (!reason) return fail(ERR.VALIDATION_ERROR, 'REASON_REQUIRED', 400, { field: 'reason' });
    await env.DB.prepare(
      `UPDATE posts SET status = 'rejected', reviewed_at = ?1, reject_reason = ?2, updated_at = ?1 WHERE id = ?3`,
    ).bind(now, reason.slice(0, 500), id).run();
  }

  // 通知发布者（失败不影响审核结果；受「帖子审核结果」邮件开关控制，站内通知不受影响）
  const user = await env.DB.prepare('SELECT email FROM users WHERE id = ?1').bind(post.user_id).first<{ email: string }>();
  if (user) {
    void (async () => {
      if (!(await getSetting<boolean>(env, 'mail_post_review_enabled', true))) return;
      const template = approve ? 'review_approved' : 'review_rejected';
      notify(env, user.email, template, { title: post.title, reason: approve ? '' : reason }).catch(() => {});
    })().catch(() => {});
  }
  await pushNotification(env, post.user_id,
    approve ? 'post_approved' : 'post_rejected',
    id,
    approve ? `你的帖子「${post.title}」已通过审核` : `你的帖子「${post.title}」未通过审核`,
    approve ? '已通过管理组审核并上架展示。' : `驳回原因：${reason || '未填写'}`);

  await audit(env, request, g.viewer, {
    action: approve ? 'review_post' : 'reject_post',
    targetType: 'post',
    targetId: id,
    detail: { approve, title: post.title, reason: approve ? undefined : reason.slice(0, 200) },
  });

  return ok({ status: approve ? 'open' : 'rejected' });
}

/**
 * POST /api/admin/posts/:id/close  body: { reason?: string }
 * 管理员下架：仅 open 帖子可下架，status → closed，close_reason 固定 admin_takedown。
 * （与用户侧 handleClosePost 区分：管理员下架不校验会话归属，直接生效）
 */
export async function handleAdminClosePost(request: Request, env: Env, id: string): Promise<Response> {
  const g = await guard(request, env, 'admin');
  if (g instanceof Response) return g;

  const post = await env.DB.prepare(
    'SELECT id, user_id, title, status FROM posts WHERE id = ?1',
  ).bind(id).first<{ id: string; user_id: string; title: string; status: string }>();
  if (!post) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
  if (post.status !== 'open') return fail(ERR.VALIDATION_ERROR, 'NOT_OPEN', 400);

  const now = Date.now();
  await env.DB.prepare(
    `UPDATE posts SET status = 'closed', closed_at = ?1, close_reason = 'admin_takedown', updated_at = ?1, pinned_at = NULL WHERE id = ?2`,
  ).bind(now, id).run();
  await pushNotification(env, post.user_id, 'post_closed', id,
    `你的帖子「${post.title}」已被管理组下架`,
    '帖子因违反站点规则或管理需要被下架，如有疑问可通过工单联系管理组。');

  await audit(env, request, g.viewer, {
    action: 'close_post',
    targetType: 'post',
    targetId: id,
    detail: { title: post.title },
  });

  return ok({ status: 'closed' });
}

/**
 * DELETE /api/admin/posts/:id
 * 硬删除帖子：连带清理会话/消息/中转申请（D1 未开启级联，显式按依赖顺序删除）。
 * 危险操作，仅 owner 可执行。
 */
export async function handleAdminDeletePost(request: Request, env: Env, id: string): Promise<Response> {
  const g = await guard(request, env, 'owner');
  if (g instanceof Response) return g;

  const post = await env.DB.prepare(
    'SELECT id, title, status FROM posts WHERE id = ?1',
  ).bind(id).first<{ id: string; title: string; status: string }>();
  if (!post) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);

  // messages ← conversations ← relay_requests ← favorites ← posts，先删子表再删主表
  await env.DB.prepare(
    `DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE post_id = ?1)`,
  ).bind(id).run();
  await env.DB.prepare(`DELETE FROM conversations WHERE post_id = ?1`).bind(id).run();
  await env.DB.prepare(`DELETE FROM relay_requests WHERE post_id = ?1`).bind(id).run();
  await env.DB.prepare(`DELETE FROM favorites WHERE post_id = ?1`).bind(id).run();
  await deleteProofs(env, id); // 级联删除证明材料（R2 对象 + 元数据）
  await env.DB.prepare(`DELETE FROM posts WHERE id = ?1`).bind(id).run();

  await audit(env, request, g.viewer, {
    action: 'delete_post',
    targetType: 'post',
    targetId: id,
    detail: { title: post.title, prev_status: post.status },
  });

  return ok({ deleted: true });
}

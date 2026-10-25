import type { Env } from './common/env';
import { ERR, fail, ok } from './common/envelope';
import { guard, type Viewer } from './common/auth';
import { hitLimit } from './common/ratelimit';
import { randomBase62 } from './common/crypto';
import { getPublicProfiles } from './auth/public-profile';

// 工单系统（用户 → 管理组正式沟通通道）：全站基础功能，不受号卡模块开关控制。
// 可见性：创建者本人恒可见；scope=all 全部管理组；scope=admin 仅被指定成员 + 站长（兜底监督）。
// 配额：同一用户 open（球在管理组）工单 ≤3，管理组回复变 replied 释放配额。

const CATEGORIES = new Set(['举报', '申诉', '建议', '咨询', '毛遂自荐', '其他']);
const SOURCES = new Set(['tariff', 'cardhub', 'ticket', 'config', 'admin', 'other']);
const OPEN_QUOTA = 3;
const BODY_MAX = 500;

/* 毛遂自荐（申请职位）注册表：各功能页的「毛遂自荐」按钮以 type 预填工单表单，
   模板文本由站长（非管理员，PUT settings owner-only）在管理中心设置。
   未来其他功能页申请其他职位 → 在此扩展 type 即可（按钮仅传 type，预填仅由按钮触发） */
const APPLY_TYPES: Record<string, { category: string; label: string; settingKey: string }> = {
  cardhub_guarantor: { category: '毛遂自荐', label: '卡商担保人', settingKey: 'ticket_apply_guarantor' },
};

// GET /api/tickets/apply-template?type=cardhub_guarantor：取自荐申请模板
// 公开只读端点（模板人人一样、无敏感信息）：采集端无 token 可拉取烘焙进 public-config.json 快照，
// 前端读快照、缺失时回落本接口；故不做登录校验
export async function handleTicketApplyTemplate(request: Request, env: Env): Promise<Response> {
  const type = new URL(request.url).searchParams.get('type') || '';
  const def = APPLY_TYPES[type];
  if (!def) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);

  const row = await env.DB.prepare(
    'SELECT value_json FROM settings WHERE key = ?1',
  ).bind(def.settingKey).first<{ value_json: string }>();
  let template = '';
  if (row) {
    try { const v = JSON.parse(row.value_json); if (typeof v === 'string') template = v; } catch { /* */ }
  }
  return ok({ type, category: def.category, label: def.label, template });
}

interface TicketRow {
  id: string;
  ticket_no: number;
  user_id: string;
  scope: string;
  target_id: string | null;
  category: string;
  title: string;
  status: string;
  close_reason: string | null;
  source: string;
  ref_no: number | null;
  last_reply_at: number;
  last_reply_by: string;
  created_at: number;
  updated_at: number;
}

function isStaff(v: Viewer): boolean {
  return v.role === 'admin' || v.role === 'owner';
}

function canView(t: TicketRow, v: Viewer): boolean {
  if (t.user_id === v.id) return true;
  if (!isStaff(v)) return false;
  return t.scope === 'all' || t.target_id === v.id || v.role === 'owner';
}

function serialize(t: TicketRow) {
  return {
    id: t.id,
    ticket_no: t.ticket_no,
    category: t.category,
    title: t.title,
    scope: t.scope,
    status: t.status,
    close_reason: t.close_reason,
    source: t.source,
    ref_no: t.ref_no,
    last_reply_at: t.last_reply_at,
    last_reply_by: t.last_reply_by,
    created_at: t.created_at,
  };
}

// POST /api/tickets：创建工单（配额 open ≤3；创建限流 5 次/时）
export async function handleCreateTicket(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;
  const viewer = g.viewer;

  const rl = await hitLimit(env, `ticket:create:${viewer.id}`, 5, 3600);
  if (rl.limited) return fail(ERR.RATE_LIMITED, 'RATE_LIMITED', 429);

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }

  const category = typeof body.category === 'string' ? body.category.trim() : '';
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  const scope = body.scope === 'admin' ? 'admin' : 'all';
  const targetId = typeof body.target_id === 'string' ? body.target_id.trim() : '';
  const source = typeof body.source === 'string' && SOURCES.has(body.source) ? body.source : 'ticket';
  const refNoRaw = Number(body.ref_no);
  const refNo = Number.isFinite(refNoRaw) && refNoRaw > 0 ? Math.round(refNoRaw) : null;

  if (!CATEGORIES.has(category)) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'category' });
  if (title.length < 2 || title.length > 60) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'title' });
  if (!content || content.length > BODY_MAX) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'content' });

  let targetIdNorm: string | null = null;
  if (scope === 'admin') {
    if (!targetId) return fail(ERR.VALIDATION_ERROR, 'TARGET_REQUIRED', 400, { field: 'target_id' });
    const u = await env.DB.prepare(`SELECT id, role, status FROM users WHERE id = ?1`)
      .bind(targetId).first<{ id: string; role: string; status: string }>();
    if (!u || !['admin', 'owner'].includes(u.role) || u.status !== 'active') {
      return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'target_id' });
    }
    targetIdNorm = targetId;
  }

  // 配额：open（球在管理组）< 3
  const open = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM tickets WHERE user_id = ?1 AND status = 'open'`,
  ).bind(viewer.id).first<{ c: number }>();
  if ((open?.c ?? 0) >= OPEN_QUOTA) {
    return fail(40901, 'TICKET_QUOTA_EXCEEDED', 409);
  }

  const now = Date.now();
  const id = randomBase62(12);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tickets (id, ticket_no, user_id, scope, target_id, category, title, status,
         source, ref_no, last_reply_at, last_reply_by, created_at, updated_at)
       VALUES (?1, (SELECT COALESCE(MAX(ticket_no), 2000) + 1 FROM tickets), ?2, ?3, ?4, ?5, ?6, 'open',
         ?7, ?8, ?9, 'user', ?9, ?9)`,
    ).bind(id, viewer.id, scope, targetIdNorm, category, title, source, refNo, now),
    env.DB.prepare(
      `INSERT INTO ticket_messages (id, ticket_id, sender, sender_id, body, created_at)
       VALUES (?1, ?2, 'user', ?3, ?4, ?5)`,
    ).bind(randomBase62(12), id, viewer.id, content, now),
    // 累计提单数（永久统计，工单被清理后仍保留）
    env.DB.prepare(`UPDATE users SET tickets_total = tickets_total + 1 WHERE id = ?1`).bind(viewer.id),
  ]);

  return ok({ id, status: 'open' });
}

// GET /api/tickets?box=mine|inbox
// mine（默认）：我的工单；inbox（管理组）：scope=all + 指定给我的 + owner 全部
export async function handleListTickets(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;
  const viewer = g.viewer;

  const url = new URL(request.url);
  const box = url.searchParams.get('box') === 'inbox' ? 'inbox' : 'mine';
  if (box === 'inbox' && !isStaff(viewer)) return fail(ERR.FORBIDDEN, 'FORBIDDEN', 403);

  // 管理后台筛选：status=all|open|replied|closed（默认收件箱只看未关闭）
  const status = url.searchParams.get('status') ?? '';

  const rows = box === 'inbox'
    ? await env.DB.prepare(
        `SELECT * FROM tickets
         WHERE (scope = 'all' OR target_id = ?1 OR ?2 = 'owner')
           AND (?3 = 'all' OR (?3 = '' AND status != 'closed') OR status = ?3)
         ORDER BY last_reply_at DESC LIMIT 200`,
      ).bind(viewer.id, viewer.role, ['open', 'replied', 'closed', 'all'].includes(status) ? status : '').all<TicketRow>()
    : await env.DB.prepare(
        `SELECT * FROM tickets WHERE user_id = ?1 ORDER BY last_reply_at DESC LIMIT 200`,
      ).bind(viewer.id).all<TicketRow>();

  return ok({ items: (rows.results || []).map(serialize), box });
}

// GET /api/tickets/:id：详情 + 消息流（参与者）。mine/is_mine 供前端判定气泡方向与关闭权限
export async function handleTicketDetail(request: Request, env: Env, id: string): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;
  const viewer = g.viewer;

  const t = await env.DB.prepare(`SELECT * FROM tickets WHERE id = ?1`).bind(id).first<TicketRow>();
  if (!t || !canView(t, viewer)) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);

  const msgs = await env.DB.prepare(
    `SELECT id, sender, sender_id, body, created_at
     FROM ticket_messages WHERE ticket_id = ?1 ORDER BY created_at ASC`,
  ).bind(id).all<{ id: string; sender: string; sender_id: string; body: string; created_at: number }>();

  // 发送者公开资料（昵称/头衔）走账号系统统一出口
  const profMap = await getPublicProfiles(env, (msgs.results || []).map((m) => m.sender_id));

  const isMine = t.user_id === viewer.id;
  const staffCanClose = isStaff(viewer) && (t.scope === 'all' || t.target_id === viewer.id || viewer.role === 'owner');
  return ok({
    ticket: { ...serialize(t), is_mine: isMine, can_close: isMine || staffCanClose },
    viewer_id: viewer.id,
    messages: (msgs.results || []).map((m) => {
      const p = profMap.get(m.sender_id);
      return {
        id: m.id, sender: m.sender, senderId: m.sender_id, body: m.body,
        createdAt: m.created_at, nickname: p?.nickname || '用户', title: p?.title || '平平无奇的路人',
        mine: m.sender_id === viewer.id,
      };
    }),
  });
}

// POST /api/tickets/:id/messages：回复（参与者）。状态随最后说话方流转：user→open（等管理组）、admin→replied（等用户）
export async function handleTicketReply(request: Request, env: Env, id: string): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;
  const viewer = g.viewer;

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content || content.length > BODY_MAX) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'content' });

  const t = await env.DB.prepare(`SELECT * FROM tickets WHERE id = ?1`).bind(id).first<TicketRow>();
  if (!t || !canView(t, viewer)) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
  if (t.status === 'closed') return fail(ERR.VALIDATION_ERROR, 'TICKET_CLOSED', 400);

  const sender = t.user_id === viewer.id ? 'user' : 'admin';
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO ticket_messages (id, ticket_id, sender, sender_id, body, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(randomBase62(12), id, sender, viewer.id, content, now),
    env.DB.prepare(
      `UPDATE tickets SET status = ?1, last_reply_at = ?2, last_reply_by = ?3, updated_at = ?2 WHERE id = ?4`,
    ).bind(sender === 'user' ? 'open' : 'replied', now, sender, id),
  ]);

  return ok({ status: sender === 'user' ? 'open' : 'replied' });
}

// POST /api/tickets/:id/close：关闭（发起者随时可关；管理组可关可见工单，body.reason ≤200 字）
export async function handleTicketClose(request: Request, env: Env, id: string): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;
  const viewer = g.viewer;

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }
  const reasonRaw = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : '';

  const t = await env.DB.prepare(`SELECT * FROM tickets WHERE id = ?1`).bind(id).first<TicketRow>();
  if (!t || !canView(t, viewer)) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
  if (t.status === 'closed') return fail(ERR.VALIDATION_ERROR, 'TICKET_CLOSED', 400);

  const byUser = t.user_id === viewer.id;
  // 管理组只能关闭自己可见的工单（scope=all 或指定给自己；owner 兜底）
  if (!byUser && !(t.scope === 'all' || t.target_id === viewer.id || viewer.role === 'owner')) {
    return fail(ERR.FORBIDDEN, 'FORBIDDEN', 403);
  }

  const closeReason = byUser ? 'user' : (reasonRaw || 'resolved');
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE tickets SET status = 'closed', close_reason = ?1, closed_at = ?2, updated_at = ?2 WHERE id = ?3`,
  ).bind(closeReason, now, id).run();

  return ok({ status: 'closed', close_reason: closeReason });
}

// DELETE /api/tickets/:id：永久删除（仅创建者本人；仅 closed 状态可删）
export async function handleTicketDelete(request: Request, env: Env, id: string): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;
  const viewer = g as Viewer;

  const t = await env.DB.prepare(`SELECT * FROM tickets WHERE id = ?1`).bind(id).first<TicketRow>();
  if (!t) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
  if (t.user_id !== viewer.id) return fail(ERR.FORBIDDEN, 'FORBIDDEN', 403);
  if (t.status !== 'closed') return fail(ERR.VALIDATION_ERROR, 'MUST_BE_CLOSED', 400);

  await env.DB.prepare(`DELETE FROM ticket_messages WHERE ticket_id = ?1`).bind(id).run();
  await env.DB.prepare(`DELETE FROM tickets WHERE id = ?1`).bind(id).run();
  return ok({ deleted: true });
}

// 定时清理：closed 超过 90 天永久删除（供 cron 调用）
export async function runTicketsCron(env: Env): Promise<{ rows: number }> {
  const cutoff = Date.now() - 90 * 86400 * 1000;
  const tickets = await env.DB.prepare(
    `SELECT id FROM tickets WHERE status = 'closed' AND closed_at < ?1`,
  ).bind(cutoff).all<{ id: string }>();
  const rows = tickets.results.length;
  if (rows > 0) {
    const ids = tickets.results.map(r => `'${r.id}'`).join(',');
    await env.DB.prepare(`DELETE FROM ticket_messages WHERE ticket_id IN (${ids})`).run();
    await env.DB.prepare(`DELETE FROM tickets WHERE id IN (${ids})`).run();
  }
  return { rows };
}

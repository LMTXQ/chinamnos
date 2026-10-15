// 管理端审计日志查询：按时间倒序分页，支持操作类型筛选
import type { Env } from '../common/env';
import { ok } from '../common/envelope';
import { guard } from '../common/auth';

/** GET /api/admin/audit?action=&page=1&page_size=30 — 审计日志列表（admin 可见） */
export async function handleListAuditLogs(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'admin');
  if (g instanceof Response) return g;

  const url = new URL(request.url);
  const action = (url.searchParams.get('action') ?? '').trim().slice(0, 50);
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(10, parseInt(url.searchParams.get('page_size') ?? '30', 10) || 30));

  let where = 'WHERE 1=1';
  const binds: (string | number)[] = [];
  if (action) { where += ` AND action = ?${binds.length + 1}`; binds.push(action); }

  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM audit_logs ${where}`,
  ).bind(...binds).first<{ n: number }>();
  const total = totalRow?.n ?? 0;

  const rows = await env.DB.prepare(
    `SELECT id, actor_id, actor_email, action, target_type, target_id, detail_json, ip, created_at
     FROM audit_logs ${where}
     ORDER BY created_at DESC
     LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`,
  ).bind(...binds, pageSize, (page - 1) * pageSize).all();

  return ok({ items: rows.results, total, page, page_size: pageSize });
}

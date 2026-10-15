import type { Env } from '../common/env';
import { ERR, fail, ok } from '../common/envelope';
import { guard } from '../common/auth';
import { audit } from '../common/audit';

// GET /api/admin/relay-requests?status=open|handled|ignored：中转意向列表
export async function handleListRelayRequests(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'admin');
  if (g instanceof Response) return g;

  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'open';

  const rows = await env.DB.prepare(
    `SELECT r.id, r.post_id, r.buyer_name, r.buyer_contact, r.note, r.status, r.created_at, r.handled_at,
            p.title as post_title
     FROM relay_requests r LEFT JOIN posts p ON r.post_id = p.id
     WHERE r.status = ?1 ORDER BY r.created_at DESC LIMIT 200`,
  ).bind(status).all();

  return ok({ items: rows.results });
}

// POST /api/admin/relay-requests/:id/handle：标记 handled 或 ignored
export async function handleRelayRequest(request: Request, env: Env, id: string): Promise<Response> {
  const g = await guard(request, env, 'admin');
  if (g instanceof Response) return g;

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }
  const action = body.action === 'ignored' ? 'ignored' : 'handled';

  const row = await env.DB.prepare('SELECT id, status FROM relay_requests WHERE id = ?1')
    .bind(id).first<{ id: string; status: string }>();
  if (!row) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
  if (row.status !== 'open') return fail(ERR.VALIDATION_ERROR, 'ALREADY_HANDLED', 400);

  const now = Date.now();
  await env.DB.prepare(
    `UPDATE relay_requests SET status = ?1, handler_id = ?2, handled_at = ?3 WHERE id = ?4`,
  ).bind(action, g.viewer.id, now, id).run();

  await audit(env, request, g.viewer, {
    action: 'relay_handle',
    targetType: 'relay',
    targetId: id,
    detail: { result: action },
  });

  return ok({ status: action });
}

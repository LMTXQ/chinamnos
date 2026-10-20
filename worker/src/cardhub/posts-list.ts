import type { Env } from '../common/env';
import { ERR, fail, ok } from '../common/envelope';
import { guard, type Viewer } from '../common/auth';
import { serializePost, type PostRow } from './projection';
import { getPublicProfiles } from '../auth/public-profile';

// GET /api/cardhub/posts：公开列表（仅 open），支持筛选+分页
export async function handlePostsList(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'anon');
  if (g instanceof Response) return g;
  const viewer = g.viewer;

  const url = new URL(request.url);
  const board = url.searchParams.get('board');
  const carrier = url.searchParams.get('carrier');
  const province = url.searchParams.get('province');
  const city = url.searchParams.get('city');
  const q = url.searchParams.get('q');
  // 市集板块专属：回收权益范围（单一/综合），按 extra_json.market_scope 过滤（市集无运营商/省市维度）
  const scope = url.searchParams.get('scope');
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(url.searchParams.get('pageSize')) || 20));

  const where = ["status = 'open'"];
  const binds: (string | number)[] = [];
  let i = 1;
  if (board) { where.push(`board = ?${i++}`); binds.push(board); }
  if (carrier) { where.push(`carrier = ?${i++}`); binds.push(carrier); }
  if (province) { where.push(`province = ?${i++}`); binds.push(province); }
  if (city) { where.push(`city = ?${i++}`); binds.push(city); }
  if (scope) { where.push(`json_extract(extra_json, '$.market_scope') = ?${i++}`); binds.push(scope); }
  if (q) {
    const qn = /^\d+$/.test(q) ? Number(q) : null;
    if (qn !== null) {
      // 纯数字：标题/描述模糊 + #编号精确匹配（占位符必须严格递增，重复编号会破坏 D1 bind 对位）
      where.push(`(title LIKE ?${i} OR descr LIKE ?${i + 1} OR post_no = ?${i + 2})`);
      binds.push(`%${q}%`, `%${q}%`, qn);
      i += 3;
    } else {
      where.push(`(title LIKE ?${i} OR descr LIKE ?${i + 1})`);
      binds.push(`%${q}%`, `%${q}%`);
      i += 2;
    }
  }

  const whereSql = where.join(' AND ');
  const offset = (page - 1) * pageSize;

  // 列表不返回 phone_plain 等隐私列（公众只见 extra_json.phone_masked）；
  // 精华置顶帖排最前（多帖置顶时最后置顶的最前），其余按发布时间倒序
  const rows = await env.DB.prepare(
    `SELECT id, board, carrier, province, city, title, tags_json, price_num, created_at, expires_at,
            status, contact_policy, contacts_json, descr, extra_json, images_json, ttl_days, closed_at, reject_reason, submitted_at, user_id, post_no, pinned_at
     FROM posts WHERE ${whereSql}
     ORDER BY (pinned_at IS NULL) ASC, pinned_at DESC, created_at DESC LIMIT ?${i++} OFFSET ?${i}`,
  )
    .bind(...binds, pageSize, offset)
    .all<PostRow>();

  const totalRow = await env.DB.prepare(`SELECT COUNT(*) as c FROM posts WHERE ${whereSql}`)
    .bind(...binds).first<{ c: number }>();

  // 批量取作者公开信息（昵称/头衔/头像版本）——账号系统统一出口，供列表卡片直接展示发帖人
  const uids = [...new Set(rows.results.map((r) => r.user_id))];
  const authorMap = await getPublicProfiles(env, uids);

  const items = rows.results
    .map((r) => {
      const item = serializePost(r, viewer.role === 'anon' ? null : viewer, 'public/list');
      if (!item) return null;
      const a = authorMap.get(r.user_id);
      item.author = { id: r.user_id, nickname: a?.nickname ?? null, title: a?.title ?? null, avatar_v: a?.avatar_v ?? null };
      return item;
    })
    .filter((x): x is Record<string, unknown> => x !== null);

  return ok({ items, total: totalRow?.c ?? 0, page, pageSize });
}

// GET /api/cardhub/board-counts：各板块 open 帖计数（侧栏导航徽章用，避免前端基于单页数据估算）
//   附带 total（在售总数）与 today（今日新增，东八区零点起）——跳蚤市集总览页统计卡用
export async function handleBoardCounts(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'anon');
  if (g instanceof Response) return g;

  const rows = await env.DB.prepare(
    `SELECT board, COUNT(*) AS c FROM posts WHERE status = 'open' GROUP BY board`,
  ).all<{ board: string; c: number }>();

  const counts: Record<string, number> = {};
  let total = 0;
  for (const r of rows.results) { counts[r.board] = r.c; total += r.c; }

  // 东八区当日零点（站点受众以国内为主）
  const now = Date.now();
  const todayStart = now - ((now + 8 * 3600 * 1000) % 86400000);
  const todayRow = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM posts WHERE status = 'open' AND created_at >= ?1`,
  ).bind(todayStart).first<{ c: number }>();

  return ok({ counts, total, today: todayRow?.c ?? 0 });
}

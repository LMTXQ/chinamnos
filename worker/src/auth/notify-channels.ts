import type { Env } from '../common/env';
import { ERR, fail, ok } from '../common/envelope';
import { guard } from '../common/auth';
import { hitLimit } from '../common/ratelimit';
import { ulid, randomDigits, sha256Hex } from '../common/crypto';
import { NOTIFY_KINDS } from '../common/notifications';
import { getSetting } from '../common/settings';
import { getChannel, sealCred, openCred } from '../notify/channels';

// 站点名称（验证码/站外推送消息标识来源，防钓鱼仿冒）：读管理后台 site_name 设置
// （F8 接线：getSetting 带 30 秒缓存，后台改完约 30 秒内生效），未配置回退默认值。
export const SITE_NAME_FALLBACK = 'ChinaMNOs 讯览台';
export async function getSiteName(env: Env): Promise<string> {
  const v = await getSetting<string>(env, 'site_name', '');
  const s = typeof v === 'string' ? v.trim() : '';
  return s || SITE_NAME_FALLBACK;
}

/* ── 用户通知渠道绑定（站外通知推送方案 · 小方案 A）──
   绑定流：发起（校验凭证 → 直发验证码 → pending）→ 回填激活 → 解绑。
   凭证 AES-GCM 加密落库，任何响应/日志只出 target_hint 脱敏串。
   同类型重复绑定顶替旧记录（保留原行 id 与 collect_report）；总数上限 3。 */

const CODE_TTL = 10 * 60 * 1000;
const MAX_BINDINGS = 3; // 用户决策：降低上限减轻服务端通知扇出压力

// GET /api/me/notify-channels：本人绑定列表（凭证永不回显）
export async function handleNotifyChannelsList(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  // F12：顺手清掉验证码已过期的待验证行（死数据——验证必被拒），保证前端
  // 「最多绑定 3 个」的计数口径与服务端名额判定一致（都只看 生效中 + 验证期内的行）
  await env.DB.prepare(
    `DELETE FROM user_notify_channels
     WHERE user_id = ?1 AND status = 'pending' AND verify_expires_at IS NOT NULL AND verify_expires_at < ?2`,
  ).bind(g.viewer.id, Date.now()).run();

  const rows = await env.DB.prepare(
    `SELECT id, channel_type, target_hint, status, collect_report, kinds_json, created_at
     FROM user_notify_channels WHERE user_id = ?1 ORDER BY created_at DESC`,
  ).bind(g.viewer.id).all<{ id: string; channel_type: string; target_hint: string; status: string; collect_report: number; kinds_json: string | null; created_at: number }>();
  const items = (rows.results || []).map((r) => {
    let kinds: string[] | null = null;
    if (r.kinds_json) {
      try { kinds = JSON.parse(r.kinds_json) as string[]; } catch { kinds = null; }
    }
    return { id: r.id, channel_type: r.channel_type, target_hint: r.target_hint, status: r.status, collect_report: r.collect_report, created_at: r.created_at, kinds };
  });
  return ok({ items });
}

// POST /api/me/notify-channels/prefs  body: { channel_type, kinds }
//   渠道级事件偏好：kinds 为全量 15 类的子集（空数组 = 该渠道静音）；
//   推送时与站点白名单取交集——用户在全量里勾选，站长放开/缩减后勾选长期有效
export async function handleNotifyChannelPrefs(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* 空 body */ }
  const type = typeof body.channel_type === 'string' ? body.channel_type : '';
  if (!type) return fail(ERR.VALIDATION_ERROR, '缺少渠道类型', 400, { field: 'channel_type' });
  if (!Array.isArray(body.kinds)) return fail(ERR.VALIDATION_ERROR, 'kinds 必须为数组', 400, { field: 'kinds' });

  const known = new Set<string>(NOTIFY_KINDS);
  const kinds = [...new Set(body.kinds.map((x) => String(x)))].filter((k) => known.has(k));

  const r = await env.DB.prepare(
    'UPDATE user_notify_channels SET kinds_json = ?1 WHERE user_id = ?2 AND channel_type = ?3',
  ).bind(JSON.stringify(kinds), g.viewer.id, type).run();
  if (!r.meta.changes) return fail(ERR.NOT_FOUND, '未找到该渠道绑定', 404, { field: 'channel_type' });
  return ok({ channel_type: type, kinds });
}

// POST /api/me/notify-channels  body: { channel_type, cred }
//   发起绑定：校验凭证 → 发验证码（真实外发）→ 存 pending
export async function handleNotifyChannelCreate(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* 空 body */ }
  const type = typeof body.channel_type === 'string' ? body.channel_type : '';
  const def = getChannel(type);
  if (!def) return fail(ERR.VALIDATION_ERROR, '该渠道类型暂不支持', 400, { field: 'channel_type' });

  // 频控：验证码真实外发，每用户 5 次/小时
  const rl = await hitLimit(env, `nch:create:${g.viewer.id}`, 5, 3600);
  if (rl.limited) return fail(ERR.RATE_LIMITED, '操作过于频繁，请 1 小时后再试', 429);

  const raw = body.cred && typeof body.cred === 'object' ? (body.cred as Record<string, unknown>) : {};
  const v = def.validate(raw, g.viewer.email);
  if (!v.ok) return fail(ERR.VALIDATION_ERROR, v.error, 400, { field: 'cred' });

  // 绑定数上限（顶替同类型不占新名额）；已生效渠道禁止重复绑定（更换需先解绑）。
  // F12：名额只统计「生效中 + 验证期内的待验证」——过期 pending 是死数据，先清掉再计数，
  // 防止后续扩渠道（飞书/PushPlus 等验证码渠道上线）后死行占满名额
  await env.DB.prepare(
    `DELETE FROM user_notify_channels
     WHERE user_id = ?1 AND status = 'pending' AND verify_expires_at IS NOT NULL AND verify_expires_at < ?2`,
  ).bind(g.viewer.id, Date.now()).run();
  const total = await env.DB.prepare(
    'SELECT COUNT(*) AS c FROM user_notify_channels WHERE user_id = ?1',
  ).bind(g.viewer.id).first<{ c: number }>();
  const existing = await env.DB.prepare(
    'SELECT id, status FROM user_notify_channels WHERE user_id = ?1 AND channel_type = ?2',
  ).bind(g.viewer.id, type).first<{ id: string; status: string }>();
  if (existing?.status === 'active') {
    return fail(ERR.VALIDATION_ERROR, '该渠道已绑定，请先解绑后再更换', 400);
  }
  if (!existing && (total?.c ?? 0) >= MAX_BINDINGS) {
    return fail(ERR.VALIDATION_ERROR, `最多绑定 ${MAX_BINDINGS} 个通知渠道`, 400);
  }

  // 邮件类渠道（skipVerify）绑定即生效；其余渠道走验证码流程
  const activated = !!def.skipVerify;
  const code = activated ? '' : randomDigits(6);
  const now = Date.now();
  const credEnc = await sealCred(env, v.cred);
  const codeHash = activated ? null : await sha256Hex(code);
  const expires = activated ? null : now + CODE_TTL;
  // 同类型顶替：ON CONFLICT 保留原 id / created_at / collect_report，重置状态
  await env.DB.prepare(
    `INSERT INTO user_notify_channels
       (id, user_id, channel_type, cred_enc, target_hint, status, verify_code_hash, verify_expires_at, collect_report, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9)
     ON CONFLICT(user_id, channel_type) DO UPDATE SET
       cred_enc = excluded.cred_enc,
       target_hint = excluded.target_hint,
       status = excluded.status,
       verify_code_hash = excluded.verify_code_hash,
       verify_expires_at = excluded.verify_expires_at`,
  ).bind(
    existing?.id || ulid(), g.viewer.id, type, credEnc, def.hint(v.cred),
    activated ? 'active' : 'pending', codeHash, expires, now,
  ).run();

  if (activated) return ok({ activated: true, channel_type: type });

  // 验证码真实外发（失败保留 pending，用户可重发；每次重发重新计码）
  // 消息强调站点身份与网址：群机器人收到的消息需能一眼识别来源，防钓鱼仿冒
  const site = env.PUBLIC_BASE_URL || 'https://chinamnos.ftac.dpdns.org';
  const siteName = await getSiteName(env);
  const r = await def.send(
    v.cred,
    `【${siteName}】通知渠道绑定验证码`,
    `站点：[${site.replace(/^https:\/\//, '')}](${site})\n\n绑定验证码：**${code}**（10 分钟内有效）\n\n若非你本人在 ${siteName} 站点操作，请忽略本消息。`,
  );
  if (!r.ok) return fail(ERR.INTERNAL_ERROR, `验证码发送失败：${r.error || '渠道无响应'}`, 502);
  return ok({ sent: true, channel_type: type });
}

// POST /api/me/notify-channels/verify  body: { code }
//   回填验证码激活（校验最新一条 pending）
export async function handleNotifyChannelVerify(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* 空 body */ }
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!/^\d{6}$/.test(code)) return fail(ERR.VALIDATION_ERROR, '请输入 6 位数字验证码', 400, { field: 'code' });

  // 防爆破：每用户 10 次/小时（含错误尝试）
  const rl = await hitLimit(env, `nch:verify:${g.viewer.id}`, 10, 3600);
  if (rl.limited) return fail(ERR.RATE_LIMITED, '尝试次数过多，请 1 小时后再试', 429);

  const row = await env.DB.prepare(
    `SELECT id, channel_type, verify_code_hash, verify_expires_at FROM user_notify_channels
     WHERE user_id = ?1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
  ).bind(g.viewer.id).first<{ id: string; channel_type: string; verify_code_hash: string | null; verify_expires_at: number | null }>();
  if (!row || !row.verify_code_hash) return fail(ERR.VALIDATION_ERROR, '没有待验证的绑定，请先发送验证码', 400, { field: 'code' });
  if ((row.verify_expires_at ?? 0) < Date.now()) return fail(ERR.VALIDATION_ERROR, '验证码已过期，请重新发送', 400, { field: 'code' });
  if ((await sha256Hex(code)) !== row.verify_code_hash) {
    return fail(ERR.VALIDATION_ERROR, '验证码错误', 400, { field: 'code' });
  }

  await env.DB.prepare(
    `UPDATE user_notify_channels SET status = 'active', verify_code_hash = NULL, verify_expires_at = NULL
     WHERE id = ?1 AND user_id = ?2`,
  ).bind(row.id, g.viewer.id).run();
  return ok({ channel_type: row.channel_type, active: true });
}

// POST /api/me/notify-channels/delete  body: { channel_type }
//   解绑（WHERE user_id 双保险防越权）
export async function handleNotifyChannelDelete(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* 空 body */ }
  const type = typeof body.channel_type === 'string' ? body.channel_type : '';
  if (!type) return fail(ERR.VALIDATION_ERROR, '缺少渠道类型', 400, { field: 'channel_type' });

  await env.DB.prepare(
    'DELETE FROM user_notify_channels WHERE user_id = ?1 AND channel_type = ?2',
  ).bind(g.viewer.id, type).run();
  return ok({ deleted: true });
}

/* 供后续推送分支（方案 B/C/D）使用：取用户全部 active 绑定并解密凭证。
   kinds = 渠道级事件偏好（null = 未配置即全收；数组 = 只收勾选类型，与站点白名单取交集） */
export interface ActiveBinding {
  id: string;
  channel_type: string;
  cred: Record<string, string>;
  kinds: string[] | null;
}

export async function loadActiveBindings(env: Env, userId: string): Promise<ActiveBinding[]> {
  const rows = await env.DB.prepare(
    `SELECT id, channel_type, cred_enc, kinds_json FROM user_notify_channels
     WHERE user_id = ?1 AND status = 'active'`,
  ).bind(userId).all<{ id: string; channel_type: string; cred_enc: string; kinds_json: string | null }>();
  const out: ActiveBinding[] = [];
  for (const r of rows.results || []) {
    try {
      let kinds: string[] | null = null;
      if (r.kinds_json) {
        try { kinds = JSON.parse(r.kinds_json) as string[]; } catch { kinds = null; }
      }
      out.push({ id: r.id, channel_type: r.channel_type, cred: await openCred(env, r.cred_enc), kinds });
    } catch { /* 单条解密失败跳过，不影响其余 */ }
  }
  return out;
}

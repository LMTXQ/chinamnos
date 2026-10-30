import type { Env } from '../common/env';
import { ERR, fail, ok } from '../common/envelope';
import { guard } from '../common/auth';
import { hitLimit } from '../common/ratelimit';
import { ulid, randomDigits, sha256Hex } from '../common/crypto';
import { NOTIFY_KINDS } from '../common/notifications';
import { getSetting } from '../common/settings';
import { getChannel, sealCred, openCred, plainify, qmsgSendRaw } from '../notify/channels';
import { getAppAccessToken } from '../notify/qqbot';
// 需求号：NCH-TEST-1
// 需求内容：已绑定渠道的「测试」按钮
// 改动说明：测试消息发送需要真实投递，邮件渠道复用既有 Resend 适配器（其 send 为批量分支占位恒成功）
import { resendSend } from '../mail/resend';

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
   同类型多实例（增量 3，2026-10-29）：0044 已拆除 (user_id, channel_type) 唯一索引——
   同渠道可并存多个生效实例；同渠道同凭证的「待验证行」就地重填（不占新名额）；
   重复凭证仅软提示不硬拦；email 凭证即账号邮箱，保留单绑定。
   端点寻址：优先按绑定行 id，未传 id 回退按渠道类型（旧前端兼容，单实例语义）。 */

const CODE_TTL = 10 * 60 * 1000;
const BIND_CODE_TTL = 24 * 3600 * 1000; // QQ 机器人绑定码（群内发码消费）有效期
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
    `SELECT id, channel_type, cred_enc, target_hint, status, collect_report, kinds_json, kinds_mode, provinces_json, digest_mode, announce_push, created_at
     FROM user_notify_channels WHERE user_id = ?1 ORDER BY created_at DESC`,
  ).bind(g.viewer.id).all<{ id: string; channel_type: string; cred_enc: string; target_hint: string; status: string; collect_report: number; kinds_json: string | null; kinds_mode: string; provinces_json: string | null; digest_mode: string; announce_push: number | null; created_at: number }>();
  const items = await Promise.all((rows.results || []).map(async (r) => {
    let kinds: string[] | null = null;
    if (r.kinds_json) {
      try { kinds = JSON.parse(r.kinds_json) as string[]; } catch { kinds = null; }
    }
    let provinces: unknown = [];
    if (r.provinces_json) {
      try { provinces = JSON.parse(r.provinces_json) as unknown; } catch { provinces = []; }
    }
    // 群目标渠道（QQ 机器人回调收集 / Qmsg 手动登记）：解密 cred 取群列表供前端展示
    // （group_openid / QQ 群号非敏感，secret/key 不出库）
    let targets: string[] | undefined;
    const chDef = getChannel(r.channel_type);
    if (chDef?.bindByCallback || chDef?.manualTargets) {
      try {
        const cred = await openCred(env, r.cred_enc);
        if (Array.isArray(cred.targets)) targets = cred.targets.filter(Boolean);
        else if (chDef.manualTargets) targets = [];
      } catch { targets = undefined; }
    }
    return { id: r.id, channel_type: r.channel_type, target_hint: r.target_hint, status: r.status, collect_report: r.collect_report === 1, digest_mode: r.digest_mode === 'custom' ? 'custom' : 'follow', kinds_mode: r.kinds_mode === 'custom' ? 'custom' : 'follow', announce_push: r.announce_push, provinces, created_at: r.created_at, kinds, targets };
  }));
  return ok({ items });
}

// POST /api/me/notify-channels/prefs  body: { channel_type, kinds, scope?, kinds_mode? }
//   渠道级事件偏好：kinds 为全量 15 类的子集（空数组 = 该渠道静音）；
//   scope='global' → 写账号全局事件偏好（user_digest_prefs.kinds_json，所有跟随渠道生效）；
//   缺省 scope='channel' → 写渠道 kinds_json + kinds_mode（'custom' 独立配置 | 'follow' 跟随全局，
//   仅 kinds_mode='custom' 时推送消费渠道自有 kinds）。推送时与站点白名单取交集。
//   ⚠️ kinds_mode 必须随 kinds 一并落库——曾因全局化重构漏写该列，独立配置保存后重进回到跟随（已修）。
export async function handleNotifyChannelPrefs(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* 空 body */ }
  const scope = body.scope === 'global' ? 'global' : 'channel';
  if (!Array.isArray(body.kinds)) return fail(ERR.VALIDATION_ERROR, 'kinds 必须为数组', 400, { field: 'kinds' });
  const known = new Set<string>(NOTIFY_KINDS);
  const kinds = [...new Set(body.kinds.map((x) => String(x)))].filter((k) => known.has(k));

  if (scope === 'global') {
    await env.DB.prepare(
      `INSERT INTO user_digest_prefs (user_id, kinds_json, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(user_id) DO UPDATE SET kinds_json = excluded.kinds_json, updated_at = excluded.updated_at`,
    ).bind(g.viewer.id, JSON.stringify(kinds), Date.now()).run();
    return ok({ scope, kinds });
  }

  const type = typeof body.channel_type === 'string' ? body.channel_type : '';
  if (!type) return fail(ERR.VALIDATION_ERROR, '缺少渠道类型', 400, { field: 'channel_type' });
  const kindsMode = body.kinds_mode === 'custom' ? 'custom' : 'follow';
  const id = typeof body.id === 'string' ? body.id.trim() : '';

  // 增量 3：多实例按行 id 寻址；未传 id 保留旧的按渠道类型语义
  const r = id
    ? await env.DB.prepare(
      'UPDATE user_notify_channels SET kinds_json = ?1, kinds_mode = ?2 WHERE id = ?3 AND user_id = ?4',
    ).bind(JSON.stringify(kinds), kindsMode, id, g.viewer.id).run()
    : await env.DB.prepare(
      'UPDATE user_notify_channels SET kinds_json = ?1, kinds_mode = ?2 WHERE user_id = ?3 AND channel_type = ?4',
    ).bind(JSON.stringify(kinds), kindsMode, g.viewer.id, type).run();
  if (!r.meta.changes) return fail(ERR.NOT_FOUND, '未找到该渠道绑定', 404, { field: 'channel_type' });
  return ok({ id, channel_type: type, kinds, kinds_mode: kindsMode });
}

// GET /api/me/digest-prefs —— 账号全局播报范围 + 事件偏好 + 公告开关（0041/0042/0043；null = 未设置 = 全收/关）
export async function handleDigestGlobalGet(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;
  const row = await env.DB.prepare(
    'SELECT pref_json, kinds_json, announce_push FROM user_digest_prefs WHERE user_id = ?1',
  ).bind(g.viewer.id).first<{ pref_json: string | null; kinds_json: string | null; announce_push: number }>();
  let provinces: unknown = null;
  if (row?.pref_json) {
    try { provinces = JSON.parse(row.pref_json) as unknown; } catch { provinces = null; }
  }
  let kinds: string[] | null = null;
  if (row?.kinds_json) {
    try { kinds = JSON.parse(row.kinds_json) as string[]; } catch { kinds = null; }
  }
  return ok({ provinces, kinds, announce_push: row?.announce_push === 1 ? 1 : 0 });
}

// PUT /api/me/digest-prefs  body: { provinces?, kinds?, announce_push? } —— 保存账号全局偏好（upsert，字段级合并）
export async function handleDigestGlobalSet(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;
  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* 空 body */ }
  const prefJson = body.provinces == null ? null : normalizeProvincesPref(body.provinces);
  if (body.provinces != null && prefJson === null) {
    return fail(ERR.VALIDATION_ERROR, 'provinces 格式无效（需为省份代码数组或按运营商分组对象）', 400, { field: 'provinces' });
  }
  let kindsJson: string | null = null;
  if (body.kinds != null) {
    if (!Array.isArray(body.kinds)) return fail(ERR.VALIDATION_ERROR, 'kinds 必须为数组', 400, { field: 'kinds' });
    const known = new Set<string>(NOTIFY_KINDS);
    const ks = [...new Set(body.kinds.map((x) => String(x)))].filter((k) => known.has(k));
    kindsJson = JSON.stringify(ks);
  }
  const announceRaw = body.announce_push;
  if (announceRaw !== undefined && announceRaw !== 0 && announceRaw !== 1) {
    return fail(ERR.VALIDATION_ERROR, 'announce_push 需为 0 或 1', 400, { field: 'announce_push' });
  }
  // 字段级合并：只更新请求里出现的字段（未提供的保留原值）
  const row = await env.DB.prepare(
    'SELECT pref_json, kinds_json, announce_push FROM user_digest_prefs WHERE user_id = ?1',
  ).bind(g.viewer.id).first<{ pref_json: string | null; kinds_json: string | null; announce_push: number }>();
  const nextPref = body.provinces != null ? prefJson : (row?.pref_json ?? null);
  const nextKinds = body.kinds != null ? kindsJson : (row?.kinds_json ?? null);
  const nextAnnounce = announceRaw !== undefined ? (announceRaw as number) : (row?.announce_push ?? 0);
  await env.DB.prepare(
    `INSERT INTO user_digest_prefs (user_id, pref_json, kinds_json, announce_push, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(user_id) DO UPDATE SET pref_json = excluded.pref_json, kinds_json = excluded.kinds_json, announce_push = excluded.announce_push, updated_at = excluded.updated_at`,
  ).bind(g.viewer.id, nextPref, nextKinds, nextAnnounce, Date.now()).run();
  return ok({
    provinces: nextPref === null ? null : JSON.parse(nextPref),
    kinds: nextKinds === null ? null : JSON.parse(nextKinds),
    announce_push: nextAnnounce,
  });
}

/* 采集播报省份偏好归一化：入库 JSON 字符串（非法返回 null → 由调用方 400）。
   两种格式（批次四升级：按运营商分组）：
   - 旧格式 Array<string>：平铺省份代码 = 全运营商同一份；空数组 → null（不限全收）
   - 新格式 Record<carrier, string[]>：按运营商分组；无勾选的运营商键被剔除 = 不收该运营商；
     全空 → '{}'（分发自按"缺失键 = 不收"处理，等效不推送）。
   省份代码权威来源在采集端 PROVINCES 表，此处不做白名单——未知代码在分发 join 时自然失效。 */
function normalizeProvincesPref(raw: unknown): string | null {
  const normCodes = (arr: unknown[]): string[] =>
    [...new Set(
      arr.filter((x): x is string => typeof x === 'string')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    )].slice(0, 34);
  if (Array.isArray(raw)) {
    const codes = normCodes(raw);
    return codes.length ? JSON.stringify(codes) : null;
  }
  if (typeof raw === 'object' && raw !== null) {
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const key = k.trim().toLowerCase();
      if (!key || !Array.isArray(v)) continue;
      const codes = normCodes(v);
      if (codes.length) out[key] = codes;
    }
    return JSON.stringify(out);
  }
  return null;
}

// POST /api/me/notify-channels/digest-prefs  body: { channel_type, enabled, mode, provinces? }
//   渠道级采集播报订阅（方案批次二，批次四追加全局/独立模式）：
//   enabled → collect_report；mode 'follow' 跟随账号全局（provinces_json 忽略）
//   | 'custom' 独立配置（provinces → provinces_json，旧平铺数组=全运营商/新对象=按运营商分组）。
// POST /api/me/notify-channels/digest-prefs  body: { channel_type, enabled?, mode?, provinces?, announce_push? }
//   渠道级采集播报订阅（方案批次二 + 追加迭代）。字段级合并：只更新请求中出现的字段。
//   enabled → collect_report；mode 'follow' 范围跟随账号全局（provinces_json 保留，切回独立即恢复）
//   | 'custom' 独立（provinces → provinces_json）；announce_push 渠道级公告开关（null=跟随账号全局）。
export async function handleNotifyChannelDigestPrefs(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* 空 body */ }
  const type = typeof body.channel_type === 'string' ? body.channel_type : '';
  if (!type || !getChannel(type)) return fail(ERR.VALIDATION_ERROR, '该渠道类型暂不支持', 400, { field: 'channel_type' });
  const id = typeof body.id === 'string' ? body.id.trim() : '';

  // 增量 3：多实例按行 id 寻址；未传 id 保留旧的按渠道类型语义
  const row = id
    ? await env.DB.prepare(
      `SELECT id, collect_report, digest_mode, provinces_json, announce_push FROM user_notify_channels
     WHERE id = ?1 AND user_id = ?2 AND status = 'active'`,
    ).bind(id, g.viewer.id).first<{ id: string; collect_report: number; digest_mode: string; provinces_json: string | null; announce_push: number | null }>()
    : await env.DB.prepare(
      `SELECT id, collect_report, digest_mode, provinces_json, announce_push FROM user_notify_channels
     WHERE user_id = ?1 AND channel_type = ?2 AND status = 'active'`,
    ).bind(g.viewer.id, type).first<{ id: string; collect_report: number; digest_mode: string; provinces_json: string | null; announce_push: number | null }>();
  if (!row) return fail(ERR.NOT_FOUND, '未找到该渠道的有效绑定', 404, { field: 'channel_type' });

  const mode = typeof body.mode === 'string' && (body.mode === 'custom' || body.mode === 'follow') ? body.mode : row.digest_mode;
  let provincesJson = row.provinces_json;
  if ('provinces' in body) {
    provincesJson = body.provinces == null ? null : normalizeProvincesPref(body.provinces);
    if (body.provinces != null && provincesJson === null) {
      return fail(ERR.VALIDATION_ERROR, 'provinces 格式无效（需为省份代码数组或按运营商分组对象）', 400, { field: 'provinces' });
    }
  }
  const nextEnabled = 'enabled' in body ? (body.enabled === true ? 1 : 0) : row.collect_report;
  const nextAnnounce = 'announce_push' in body
    ? (body.announce_push === 1 ? 1 : body.announce_push === 0 ? 0 : null)
    : row.announce_push;

  await env.DB.prepare(
    `UPDATE user_notify_channels
     SET collect_report = ?1, digest_mode = ?2, provinces_json = ?3, announce_push = ?4
     WHERE id = ?5 AND user_id = ?6`,
  ).bind(nextEnabled, mode, provincesJson, nextAnnounce, row.id, g.viewer.id).run();

  let provincesOut: unknown = [];
  if (provincesJson) { try { provincesOut = JSON.parse(provincesJson); } catch { provincesOut = []; } }
  return ok({
    channel_type: type,
    enabled: nextEnabled === 1,
    mode: mode === 'custom' ? 'custom' : 'follow',
    announce_push: nextAnnounce,
    provinces: provincesOut,
  });
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

  // F12：名额只统计「生效中 + 验证期内的待验证」——过期 pending 是死数据，先清掉再计数，
  // 防止死行占满名额。增量 3：同类型多实例按总行数计名额（2 qmsg + 1 qqbot = 3 用满即止）。
  await env.DB.prepare(
    `DELETE FROM user_notify_channels
     WHERE user_id = ?1 AND status = 'pending' AND verify_expires_at IS NOT NULL AND verify_expires_at < ?2`,
  ).bind(g.viewer.id, Date.now()).run();
  const total = await env.DB.prepare(
    'SELECT COUNT(*) AS c FROM user_notify_channels WHERE user_id = ?1',
  ).bind(g.viewer.id).first<{ c: number }>();

  const hint = def.hint(v.cred);

  // email 特例：凭证即账号邮箱，多实例无意义 → 保留单绑定（原靠唯一索引拦截，拆索引后须业务层兜住）
  if (type === 'email') {
    const act = await env.DB.prepare(
      `SELECT id FROM user_notify_channels WHERE user_id = ?1 AND channel_type = 'email' AND status = 'active'`,
    ).bind(g.viewer.id).first<{ id: string }>();
    if (act) return fail(ERR.VALIDATION_ERROR, '邮件渠道已绑定，如需更换请先解绑（或直接修改登录邮箱）', 400);
  }

  // 同渠道同凭证的「待验证行」就地重填（重发验证码 / 改错重填不占新名额、不遗留死行）
  const reuse = await env.DB.prepare(
    `SELECT id FROM user_notify_channels
     WHERE user_id = ?1 AND channel_type = ?2 AND status = 'pending' AND target_hint = ?3`,
  ).bind(g.viewer.id, type, hint).first<{ id: string }>();
  // 重复凭证软提示（尾号碰撞可能，不硬拦——增量 3 决策）
  const dup = await env.DB.prepare(
    `SELECT id FROM user_notify_channels
     WHERE user_id = ?1 AND channel_type = ?2 AND status = 'active' AND target_hint = ?3`,
  ).bind(g.viewer.id, type, hint).first<{ id: string }>();
  if (!reuse && (total?.c ?? 0) >= MAX_BINDINGS) {
    return fail(ERR.VALIDATION_ERROR, `最多绑定 ${MAX_BINDINGS} 个渠道实例`, 400);
  }

  // 邮件类渠道（skipVerify）绑定即生效；QQ 机器人（bindByCallback）不外发验证码——
  // 生成 24h 绑定码随响应返回（前端展示，群内 @机器人 消费），其余渠道走验证码流程
  const activated = !!def.skipVerify;

  // QQ 机器人绑定时即时校验凭证：AppID/Secret 换一次 token，填错当场报错（否则要到回调阶段才暴露）
  if (def.bindByCallback) {
    try {
      await getAppAccessToken(v.cred.appid as string, v.cred.secret as string);
    } catch (e) {
      return fail(ERR.VALIDATION_ERROR, `凭证校验失败（AppID/Secret 与开放平台不一致或平台无响应）：${String(e).slice(0, 120)}`, 400);
    }
  }

  const code = activated ? '' : randomDigits(6);
  const now = Date.now();
  const credEnc = await sealCred(env, v.cred);
  const codeHash = activated ? null : await sha256Hex(code);
  const expires = activated ? null : (def.bindByCallback ? now + BIND_CODE_TTL : now + CODE_TTL);
  // 增量 3：改纯 INSERT（唯一索引已拆，同类型多实例并存）；
  // 同名待验证行（reuse）就地更新，保留原 id / created_at，不占新名额
  const rowId = reuse?.id || ulid();
  if (reuse) {
    await env.DB.prepare(
      `UPDATE user_notify_channels
       SET cred_enc = ?1, target_hint = ?2, status = ?3, verify_code_hash = ?4, verify_expires_at = ?5
       WHERE id = ?6 AND user_id = ?7`,
    ).bind(credEnc, hint, activated ? 'active' : 'pending', codeHash, expires, rowId, g.viewer.id).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO user_notify_channels
         (id, user_id, channel_type, cred_enc, target_hint, status, verify_code_hash, verify_expires_at, collect_report, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9)`,
    ).bind(
      rowId, g.viewer.id, type, credEnc, hint,
      activated ? 'active' : 'pending', codeHash, expires, now,
    ).run();
  }

  if (activated) return ok({ id: rowId, activated: true, channel_type: type, duplicate_hint: !!dup });

  // QQ 机器人（bindByCallback）：不外发，绑定码随响应返回由前端展示，群内发码后由回调激活/追加
  if (def.bindByCallback) {
    return ok({ id: rowId, bind_code: code, channel_type: type, expires_in_hours: 24, duplicate_hint: !!dup });
  }

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
  return ok({ id: rowId, sent: true, channel_type: type, duplicate_hint: !!dup });
}

// POST /api/me/notify-channels/bindcode  body: { id?, channel_type }
//   QQ 机器人「添加群」：为已生效实例生成新绑定码（24h、消费即失效），随响应返回由前端展示。
//   行寻址：优先按绑定行 id（增量 3 多实例），未传 id 回退按 (user_id, channel_type)。
export async function handleNotifyChannelBindCode(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* 空 body */ }
  const type = typeof body.channel_type === 'string' ? body.channel_type : '';
  const def = getChannel(type);
  if (!def?.bindByCallback) return fail(ERR.VALIDATION_ERROR, '该渠道不支持绑定码加群', 400, { field: 'channel_type' });

  // 频控：与发起绑定同额度（5 次/小时）
  const rl = await hitLimit(env, `nch:create:${g.viewer.id}`, 5, 3600);
  if (rl.limited) return fail(ERR.RATE_LIMITED, '操作过于频繁，请 1 小时后再试', 429);

  const id = typeof body.id === 'string' ? body.id.trim() : '';
  const row = id
    ? await env.DB.prepare(
      `SELECT id FROM user_notify_channels WHERE id = ?1 AND user_id = ?2 AND status = 'active'`,
    ).bind(id, g.viewer.id).first<{ id: string }>()
    : await env.DB.prepare(
      `SELECT id FROM user_notify_channels WHERE user_id = ?1 AND channel_type = ?2 AND status = 'active'`,
    ).bind(g.viewer.id, type).first<{ id: string }>();
  if (!row) return fail(ERR.NOT_FOUND, '未找到该渠道的有效绑定，请先完成实例绑定', 404, { field: 'channel_type' });

  const code = randomDigits(6);
  await env.DB.prepare(
    `UPDATE user_notify_channels SET verify_code_hash = ?1, verify_expires_at = ?2 WHERE id = ?3 AND user_id = ?4`,
  ).bind(await sha256Hex(code), Date.now() + BIND_CODE_TTL, row.id, g.viewer.id).run();
  return ok({ bind_code: code, channel_type: type, expires_in_hours: 24 });
}

// POST /api/me/notify-channels/targets  body: { id?, channel_type, op: 'add'|'verify'|'remove', group, code? }
//   Qmsg 群目标管理（对齐企微/钉钉验证码流）：
//   add    = 发起：经 Qmsg 向该群发送 6 位验证码（群未在 Qmsg 控制台绑定时发送失败——前置条件天然校验），
//            待验证群号存 cred.pending_group，码哈希存行 verify_code_hash（10 分钟 TTL，CODE_TTL）；
//   verify = 回填：校验 pending_group 与码 → 群号正式入 targets（一次性消费）→ 清 pending；
//   remove = 移除已登记群。
//   同一时间仅一个待验证群（新 add 覆盖旧的）；行寻址优先 id，未传回退 channel_type（增量 3）。
export async function handleNotifyChannelTargets(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* 空 body */ }
  const type = typeof body.channel_type === 'string' ? body.channel_type : '';
  const def = getChannel(type);
  if (!def?.manualTargets) return fail(ERR.VALIDATION_ERROR, '该渠道不支持手动群目标', 400, { field: 'channel_type' });
  const op = ['add', 'verify', 'remove'].includes(String(body.op)) ? String(body.op) : 'add';
  const group = typeof body.group === 'string' ? body.group.trim() : '';
  if (!/^\d{5,11}$/.test(group)) return fail(ERR.VALIDATION_ERROR, '群号格式不正确：应为 5~11 位数字 QQ 群号', 400, { field: 'group' });

  // 频控：add 会真实外发验证码，与发起绑定同额度（5 次/小时）
  const rl = await hitLimit(env, `nch:create:${g.viewer.id}`, 5, 3600);
  if (rl.limited) return fail(ERR.RATE_LIMITED, '操作过于频繁，请 1 小时后再试', 429);

  const id = typeof body.id === 'string' ? body.id.trim() : '';
  const row = id
    ? await env.DB.prepare(
      `SELECT id, cred_enc, verify_code_hash, verify_expires_at FROM user_notify_channels
     WHERE id = ?1 AND user_id = ?2 AND status = 'active'`,
    ).bind(id, g.viewer.id).first<{ id: string; cred_enc: string; verify_code_hash: string | null; verify_expires_at: number | null }>()
    : await env.DB.prepare(
      `SELECT id, cred_enc, verify_code_hash, verify_expires_at FROM user_notify_channels
     WHERE user_id = ?1 AND channel_type = ?2 AND status = 'active'`,
    ).bind(g.viewer.id, type).first<{ id: string; cred_enc: string; verify_code_hash: string | null; verify_expires_at: number | null }>();
  if (!row) return fail(ERR.NOT_FOUND, '未找到该渠道的有效绑定', 404, { field: 'channel_type' });

  const cred = await openCred(env, row.cred_enc);
  const targets = Array.isArray(cred.targets) ? cred.targets.filter(Boolean) : [];

  if (op === 'add') {
    if (targets.includes(group)) return fail(ERR.VALIDATION_ERROR, '该群已在列表中', 400);
    // 验证码经 Qmsg 发到该群：群未在 Qmsg 控制台绑定时发送失败 → 引导用户先去平台绑群
    const code = randomDigits(6);
    const site = env.PUBLIC_BASE_URL || 'https://chinamnos.ftac.dpdns.org';
    const siteName = await getSiteName(env);
    const sendRes = await qmsgSendRaw(cred, group, plainify(
      `【${siteName}】群通知绑定验证码\n\n站点：[${site.replace(/^https:\/\//, '')}](${site})\n\n绑定验证码：**${code}**（10 分钟内有效）\n\n回站点输入该验证码完成添加；若非你本人在 ${siteName} 操作，请忽略。`,
    ));
    if (!sendRes.ok) {
      return fail(ERR.INTERNAL_ERROR, `验证码发送失败：${sendRes.error || '渠道无响应'}——请确认已在 Qmsg 控制台添加并绑定该群（机器人已在群内）`, 502);
    }
    const nextCred: Record<string, string> = { ...cred, pending_group: group } as Record<string, string>;
    await env.DB.prepare(
      `UPDATE user_notify_channels SET cred_enc = ?1, verify_code_hash = ?2, verify_expires_at = ?3 WHERE id = ?4 AND user_id = ?5`,
    ).bind(await sealCred(env, nextCred), await sha256Hex(code), Date.now() + CODE_TTL, row.id, g.viewer.id).run();
    return ok({ sent: true, group, expires_in_minutes: 10 });
  }

  if (op === 'verify') {
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!/^\d{6}$/.test(code)) return fail(ERR.VALIDATION_ERROR, '请输入 6 位数字验证码', 400, { field: 'code' });
    const pendingGroup = typeof cred.pending_group === 'string' ? cred.pending_group : '';
    if (!pendingGroup || pendingGroup !== group) return fail(ERR.VALIDATION_ERROR, '没有待验证的群，请先发送验证码', 400, { field: 'group' });
    if ((row.verify_expires_at ?? 0) < Date.now()) return fail(ERR.VALIDATION_ERROR, '验证码已过期，请重新发送', 400, { field: 'code' });
    if ((await sha256Hex(code)) !== row.verify_code_hash) return fail(ERR.VALIDATION_ERROR, '验证码错误', 400, { field: 'code' });

    const nextTargets = targets.includes(group) ? targets : [...targets, group];
    const { pending_group: _drop, ...rest } = cred;
    const nextCred: Record<string, string> = { ...rest, targets: nextTargets as unknown as string[] };
    await env.DB.prepare(
      `UPDATE user_notify_channels SET cred_enc = ?1, target_hint = ?2, verify_code_hash = NULL, verify_expires_at = NULL WHERE id = ?3 AND user_id = ?4`,
    ).bind(await sealCred(env, nextCred), def.hint(nextCred), row.id, g.viewer.id).run();
    return ok({ channel_type: type, targets: nextTargets });
  }

  // remove
  const idx = targets.indexOf(group);
  if (idx < 0) return fail(ERR.NOT_FOUND, '该群不在列表中', 404);
  targets.splice(idx, 1);
  const nextCred: Record<string, string> = { ...cred, targets: targets as unknown as string[] };
  await env.DB.prepare(
    `UPDATE user_notify_channels SET cred_enc = ?1, target_hint = ?2 WHERE id = ?3 AND user_id = ?4`,
  ).bind(await sealCred(env, nextCred), def.hint(nextCred), row.id, g.viewer.id).run();
  return ok({ channel_type: type, targets });
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

  // 增量 3：多实例待验证行并存——优先按行 id 定位（前端创建后即持有 id），未传 id 回退最新一条
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  const row = id
    ? await env.DB.prepare(
      `SELECT id, channel_type, verify_code_hash, verify_expires_at FROM user_notify_channels
     WHERE id = ?1 AND user_id = ?2 AND status = 'pending'`,
    ).bind(id, g.viewer.id).first<{ id: string; channel_type: string; verify_code_hash: string | null; verify_expires_at: number | null }>()
    : await env.DB.prepare(
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
  return ok({ id: row.id, channel_type: row.channel_type, active: true });
}

// POST /api/me/notify-channels/delete  body: { id?, channel_type }
//   解绑（WHERE user_id 双保险防越权）；增量 3：优先按行 id 删单实例，未传 id 回退按类型删（旧语义）
export async function handleNotifyChannelDelete(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* 空 body */ }
  const type = typeof body.channel_type === 'string' ? body.channel_type : '';
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!type && !id) return fail(ERR.VALIDATION_ERROR, '缺少渠道类型', 400, { field: 'channel_type' });

  if (id) {
    await env.DB.prepare(
      'DELETE FROM user_notify_channels WHERE id = ?1 AND user_id = ?2',
    ).bind(id, g.viewer.id).run();
  } else {
    await env.DB.prepare(
      'DELETE FROM user_notify_channels WHERE user_id = ?1 AND channel_type = ?2',
    ).bind(g.viewer.id, type).run();
  }
  return ok({ deleted: true });
}

// 需求号：NCH-TEST-1
// 需求内容：已绑定渠道的「测试」按钮
// 改动说明：新增测试发送端点——向已生效实例真实投递一条测试消息，用户据此确认绑定是否真的可用；
//           只读绑定行、不改任何订阅状态（频控与发起绑定同口径，避免被当作免费推送通道）
// POST /api/me/notify-channels/test  body: { id?, channel_type }
export async function handleNotifyChannelTest(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* 空 body */ }
  const type = typeof body.channel_type === 'string' ? body.channel_type : '';
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!type && !id) return fail(ERR.VALIDATION_ERROR, '缺少渠道类型', 400, { field: 'channel_type' });

  // 频控：测试为真实外发（多群渠道还会串行间隔），每用户 10 次/小时
  const rl = await hitLimit(env, `nch:test:${g.viewer.id}`, 10, 3600);
  if (rl.limited) return fail(ERR.RATE_LIMITED, '测试过于频繁，请 1 小时后再试', 429);

  // 增量 3：优先按行 id 定位实例；未传 id 回退按渠道类型（旧前端兼容）
  const row = id
    ? await env.DB.prepare(
      `SELECT id, channel_type, cred_enc, target_hint FROM user_notify_channels
       WHERE id = ?1 AND user_id = ?2 AND status = 'active'`,
    ).bind(id, g.viewer.id).first<{ id: string; channel_type: string; cred_enc: string; target_hint: string }>()
    : await env.DB.prepare(
      `SELECT id, channel_type, cred_enc, target_hint FROM user_notify_channels
       WHERE user_id = ?1 AND channel_type = ?2 AND status = 'active'`,
    ).bind(g.viewer.id, type).first<{ id: string; channel_type: string; cred_enc: string; target_hint: string }>();
  if (!row) return fail(ERR.NOT_FOUND, '未找到该渠道的有效绑定', 404, { field: 'channel_type' });

  const def = getChannel(row.channel_type);
  if (!def) return fail(ERR.VALIDATION_ERROR, '该渠道类型暂不支持', 400, { field: 'channel_type' });

  let cred: Record<string, string>;
  try { cred = await openCred(env, row.cred_enc); } catch {
    return fail(ERR.INTERNAL_ERROR, '凭证解密失败，请解绑后重新绑定', 500);
  }

  const site = env.PUBLIC_BASE_URL || 'https://chinamnos.ftac.dpdns.org';
  const siteName = await getSiteName(env);
  const title = `【${siteName}】通知渠道测试`;
  const content =
    `站点：[${site.replace(/^https:\/\//, '')}](${site})\n\n` +
    `这是一条测试消息：收到即表示该渠道可正常接收 ${siteName} 的站外通知。\n\n` +
    `若非你本人操作，请前往站点解绑该渠道。`;

  // 邮件渠道特例：ChannelDef.send 是批量分支占位（恒返回成功），测试改走 Resend 真发，避免假成功
  if (row.channel_type === 'email') {
    const m = await resendSend(env, { to: cred.email || g.viewer.email, subject: title, text: plainify(content) });
    if (!m.ok) return fail(ERR.INTERNAL_ERROR, `测试邮件发送失败：${m.error || '邮件服务无响应'}`, 502);
    return ok({ sent: true, channel_type: row.channel_type, hint: row.target_hint });
  }

  const r = await def.send(cred, title, content);
  if (!r.ok) return fail(ERR.INTERNAL_ERROR, `测试消息发送失败：${r.error || '渠道无响应'}`, 502);
  return ok({ sent: true, channel_type: row.channel_type, hint: row.target_hint });
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
    `SELECT c.id, c.channel_type, c.cred_enc, c.kinds_json, c.kinds_mode, g.kinds_json AS g_kinds
     FROM user_notify_channels c LEFT JOIN user_digest_prefs g ON g.user_id = c.user_id
     WHERE c.user_id = ?1 AND c.status = 'active'`,
  ).bind(userId).all<{ id: string; channel_type: string; cred_enc: string; kinds_json: string | null; kinds_mode: string; g_kinds: string | null }>();
  const out: ActiveBinding[] = [];
  for (const r of rows.results || []) {
    try {
      // 事件偏好来源（0042）：kinds_mode='follow' 用账号全局（null = 全收）；'custom' 用渠道自有
      let kinds: string[] | null = null;
      const raw = r.kinds_mode === 'custom' ? r.kinds_json : r.g_kinds;
      if (raw) {
        try { kinds = JSON.parse(raw) as string[]; } catch { kinds = null; }
      }
      out.push({ id: r.id, channel_type: r.channel_type, cred: await openCred(env, r.cred_enc), kinds });
    } catch { /* 单条解密失败跳过，不影响其余 */ }
  }
  return out;
}

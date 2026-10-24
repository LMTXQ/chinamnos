import type { Env } from '../common/env';
import { ok, fail, ERR } from '../common/envelope';
import { openCred } from './channels';

/* ── 采集播报订户名单（方案批次二，内部端点）──
   GET /api/internal/digest-subscribers
   青龙 notify_dispatch.py（方案批次三 digest 分支）发送前拉取订户名单：
   header X-Digest-Token 严格比对 env.DIGEST_PULL_TOKEN（timing-safe）；
   env 未配置 → 503 拒绝，不做任何回退。
   数据源：user_notify_channels WHERE status='active' AND collect_report=1，
   凭证逐行解密（单行失败跳过并告警，不阻塞整体），响应即用即弃不落盘。
   provinces 为省份代码数组（空数组 = 不限省份全收）；email 行附带 email_target。 */

function tokenMatches(expected: string | undefined, got: string | null): boolean {
  // 两侧 trim：token 值本身不含空白字符；防御 secret 上传管道可能夹带的行尾符
  const e = (expected || '').trim();
  const g = (got || '').trim();
  if (!e || !g) return false;
  const a = new TextEncoder().encode(e);
  const b = new TextEncoder().encode(g);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* provinces 偏好解析：旧格式 Array<string>（全运营商同一份）或新格式 Record<carrier, string[]>
   （按运营商分组，缺失键 = 不收该运营商）。损坏按 [] 处理（[] 在分发端 = 未设置偏好 = 全收）。 */
function parseProvincesPref(raw: string | null): unknown {
  if (!raw) return [];
  try {
    const p = JSON.parse(raw) as unknown;
    if (Array.isArray(p) || (typeof p === 'object' && p !== null)) return p;
  } catch { /* 损坏按空处理 */ }
  return [];
}

export async function handleDigestSubscribers(request: Request, env: Env): Promise<Response> {
  if (!env.DIGEST_PULL_TOKEN) {
    return fail(ERR.INTERNAL_ERROR, '订户名单端点未配置（DIGEST_PULL_TOKEN）', 503);
  }
  if (!tokenMatches(env.DIGEST_PULL_TOKEN, request.headers.get('X-Digest-Token'))) {
    return fail(ERR.UNAUTHORIZED, '无效的访问令牌', 401);
  }

  const rows = await env.DB.prepare(
    `SELECT c.user_id, c.channel_type, c.cred_enc, c.provinces_json, c.digest_mode, g.pref_json AS global_pref
     FROM user_notify_channels c
     LEFT JOIN user_digest_prefs g ON g.user_id = c.user_id
     WHERE c.status = 'active' AND c.collect_report = 1
     ORDER BY c.user_id, c.channel_type`,
  ).all<{ user_id: string; channel_type: string; cred_enc: string; provinces_json: string | null; digest_mode: string; global_pref: string | null }>();

  const subscribers: Array<Record<string, unknown>> = [];
  for (const r of rows.results || []) {
    try {
      const cred = await openCred(env, r.cred_enc);
      // 范围来源：'custom' 用渠道自有配置；'follow'（默认）用账号全局偏好（未设置 = 全收）
      const resolved = r.digest_mode === 'custom'
        ? parseProvincesPref(r.provinces_json)
        : parseProvincesPref(r.global_pref);
      const sub: Record<string, unknown> = {
        uid: r.user_id,
        channel_type: r.channel_type,
        cred,
        provinces: resolved,
      };
      if (r.channel_type === 'email' && typeof cred.email === 'string') {
        sub.email_target = cred.email;
      }
      subscribers.push(sub);
    } catch (e) {
      console.warn(`[digest-pull] 订户 ${r.user_id}/${r.channel_type} 凭证解密失败，跳过: ${String(e).slice(0, 100)}`);
    }
  }
  return ok({
    subscribers,
    site: env.PUBLIC_BASE_URL || 'https://chinamnos.ftac.dpdns.org', // 分发脚本拼进消息尾部的站点链接
  });
}

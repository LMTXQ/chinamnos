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
  if (!expected || !got) return false;
  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(got);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function parseProvinces(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const p = JSON.parse(raw) as unknown;
    if (Array.isArray(p)) return p.filter((x): x is string => typeof x === 'string');
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
    `SELECT user_id, channel_type, cred_enc, provinces_json FROM user_notify_channels
     WHERE status = 'active' AND collect_report = 1 ORDER BY user_id, channel_type`,
  ).all<{ user_id: string; channel_type: string; cred_enc: string; provinces_json: string | null }>();

  const subscribers: Array<Record<string, unknown>> = [];
  for (const r of rows.results || []) {
    try {
      const cred = await openCred(env, r.cred_enc);
      const sub: Record<string, unknown> = {
        uid: r.user_id,
        channel_type: r.channel_type,
        cred,
        provinces: parseProvinces(r.provinces_json),
      };
      if (r.channel_type === 'email' && typeof cred.email === 'string') {
        sub.email_target = cred.email;
      }
      subscribers.push(sub);
    } catch (e) {
      console.warn(`[digest-pull] 订户 ${r.user_id}/${r.channel_type} 凭证解密失败，跳过: ${String(e).slice(0, 100)}`);
    }
  }
  return ok({ subscribers });
}

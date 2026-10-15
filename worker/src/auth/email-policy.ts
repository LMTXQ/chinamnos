import type { Env } from '../common/env';
import { ok } from '../common/envelope';

/* 邮箱域名白名单（站长可配，settings key = email_domain_whitelist）：
   ▸ 未配置/配置为空数组 → 使用内置「常见邮箱」默认列表（开箱即用，注册+登录都只放行常见邮箱）
   ▸ 配置为非空数组 → 以配置为准（全量替换内置列表，放行列表内域名的注册与登录）
   ▸ 域名比对：@ 后整段小写精确匹配（支持子域形式如 vip.qq.com 单列）
   ▸ 前端经 GET /api/auth/email-policy 拉取同一份列表做即时校验（前后台双重校验） */

export const DEFAULT_EMAIL_DOMAINS: string[] = [
  'qq.com', 'foxmail.com', 'vip.qq.com', '163.com', '126.com', 'yeah.net', 'vip.163.com',
  'sina.com', 'sina.cn', 'sohu.com', '139.com', '189.cn', 'aliyun.com',
  'gmail.com', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'me.com', 'yahoo.com',
];

const SETTING_KEY = 'email_domain_whitelist';

/** 读白名单：settings 配置优先，未配置/空/异常回退内置默认 */
export async function getEmailWhitelist(env: Env): Promise<string[]> {
  const row = await env.DB.prepare(
    'SELECT value_json FROM settings WHERE key = ?1',
  ).bind(SETTING_KEY).first<{ value_json: string }>();
  if (row) {
    try {
      const v = JSON.parse(row.value_json);
      if (Array.isArray(v)) {
        const list = v.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
        if (list.length) return list;
      }
    } catch { /* 异常回退默认 */ }
  }
  return DEFAULT_EMAIL_DOMAINS;
}

export function emailDomainAllowed(whitelist: string[], email: string): boolean {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  return whitelist.includes(email.slice(at + 1).toLowerCase());
}

// GET /api/auth/email-policy：下发当前白名单（anon；域名列表本身非敏感，前端做注册/登录即时校验）
export async function handleEmailPolicy(request: Request, env: Env): Promise<Response> {
  const domains = await getEmailWhitelist(env);
  return ok({ domains });
}

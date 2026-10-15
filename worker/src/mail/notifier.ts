import type { Env } from '../common/env';
import { hitLimit } from '../common/ratelimit';
import { resendSend } from './resend';
import { renderTemplate } from './templates';

export interface NotifyResult {
  sent: boolean;
  suppressed?: 'daily_cap';
  id?: string;
  error?: string;
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

// usage_counters：每实际发出一封邮件累加一次（仅低频指标走 D1，§16.5）
async function incrSentCounter(env: Env): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO usage_counters (day, metric, count) VALUES (?1, 'email_sent', 1)
     ON CONFLICT(day, metric) DO UPDATE SET count = count + 1`,
  )
    .bind(utcDay())
    .run();
}

// 通知发送器（§12.2 邮件渠道）：单收件人每日上限 + 超限当日转一封汇总
export async function notify(
  env: Env,
  to: string,
  template: string,
  vars: Record<string, string> = {},
): Promise<NotifyResult> {
  const cap = Number.parseInt(env.MAIL_DAILY_CAP ?? '', 10) || 30;
  const day = utcDay();

  const quota = await hitLimit(env, `mail:rcp:${to}:${day}`, cap, 86400);
  let name = template;
  let suppressed: NotifyResult['suppressed'];

  if (quota.limited) {
    // 超限：当日最多再发一封汇总，其余静默压制
    const summary = await hitLimit(env, `mail:sum:${to}:${day}`, 1, 86400);
    if (summary.limited) return { sent: false, suppressed: 'daily_cap' };
    name = 'daily_summary';
    suppressed = 'daily_cap';
  }

  const msg = renderTemplate(name, vars, env);
  if (!msg) return { sent: false, error: `未知模板: ${name}` };

  const res = await resendSend(env, { to, ...msg });
  if (res.ok) await incrSentCounter(env);
  return { sent: res.ok, suppressed, id: res.id, error: res.error };
}

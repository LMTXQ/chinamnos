import type { Env } from '../common/env';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface SendResult {
  ok: boolean;
  id?: string;
  error?: string;
}

// Resend 适配器（§12）：纯 fetch，无 SDK 依赖，免费档 100 封/天
export async function resendSend(env: Env, msg: MailMessage): Promise<SendResult> {
  if (!env.RESEND_API_KEY) return { ok: false, error: 'RESEND_API_KEY 未配置' };
  let res: Response;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.MAIL_FROM || 'onboarding@resend.dev',
        to: [msg.to],
        subject: msg.subject,
        text: msg.text,
      }),
    });
  } catch (e) {
    return { ok: false, error: `网络错误: ${String(e)}` };
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    return { ok: false, error: `Resend ${res.status}: ${detail}` };
  }
  const data = (await res.json().catch(() => ({}))) as { id?: string };
  return { ok: true, id: data.id };
}

import type { Env } from '../common/env';

export interface RenderedMail {
  subject: string;
  text: string;
}

type TemplateFn = (vars: Record<string, string>, env: Env) => RenderedMail;

const BRAND = '资费监控';

// 变量统一净化：去回车换行（防注入）、截断（§12.2）
export function sanitizeVars(vars: Record<string, string>, max = 500): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) {
    out[k] = String(v).replace(/[\r\n]+/g, ' ').slice(0, max);
  }
  return out;
}

// 纯文本模板注册表（兼容群机器人；后续期新增通知场景在此登记）
export const TEMPLATES: Record<string, TemplateFn> = {
  // 系统自检（第 1 期验收用）
  system_test: (v, env) => ({
    subject: `【${BRAND}】邮件系统自检`,
    text: [
      '邮件系统自检通过。',
      '',
      `时间：${v.time ?? ''}`,
      `站点：${env.PUBLIC_BASE_URL || '(PUBLIC_BASE_URL 未配置)'}`,
      '',
      '本邮件用于验证 Resend 发信链路、模板渲染、日限额与发信计数。',
      '',
      '—— 系统自动发送，请勿回复',
    ].join('\n'),
  }),

  // 单收件人日超限后的合并汇总（§12.1：30 封保险丝，超限当日改发一封汇总）
  daily_summary: (_v, env) => ({
    subject: `【${BRAND}】今日通知汇总`,
    text: [
      '您好：',
      '',
      '您今日的通知较多，为避免打扰，其余通知已合并为本汇总邮件。',
      `在线查看：${(env.PUBLIC_BASE_URL || '')}/#/cardhub/me/conversations`,
      '',
      '—— 系统自动发送，请勿回复',
    ].join('\n'),
  }),

  // 邮箱验证码（注册/找回密码）
  verify_code: (v) => ({
    subject: `【${BRAND}】您的验证码`,
    text: [
      `您的验证码为：${v.code ?? ''}`,
      '',
      `有效期 10 分钟，请勿泄露给他人。`,
      `用途：${v.purpose === 'reset' ? '重置密码' : '注册账号'}`,
      '',
      '—— 系统自动发送，请勿回复',
    ].join('\n'),
  }),

  // 审核通过
  review_approved: (v) => ({
    subject: `【${BRAND}】您的信息已通过审核`,
    text: [
      `您发布的「${v.title ?? ''}」已通过审核，现已公开展示。`,
      '',
      '—— 系统自动发送，请勿回复',
    ].join('\n'),
  }),

  // 审核拒绝
  review_rejected: (v) => ({
    subject: `【${BRAND}】您的信息未通过审核`,
    text: [
      `您发布的「${v.title ?? ''}」未通过审核。`,
      `原因：${v.reason ?? ''}`,
      '',
      '您可修改后重新提交。',
      '',
      '—— 系统自动发送，请勿回复',
    ].join('\n'),
  }),

  // 在线沟通新消息通知（对方）
  conversation_new_message: (v, env) => ({
    subject: `【${BRAND}】您有一条新消息`,
    text: [
      `关于「${v.title ?? ''}」，${v.sender === 'buyer' ? '买家' : '卖家'}发来新消息：`,
      '',
      `"${v.body ?? ''}"`,
      '',
      `查看并回复：${(env.PUBLIC_BASE_URL || '')}/#/cardhub/me/conversations`,
      '',
      '—— 系统自动发送，请勿回复',
    ].join('\n'),
  }),

  // 站长中转意向通知
  relay_request: (v) => ({
    subject: `【${BRAND}】新的中转意向`,
    text: [
      `帖子「${v.title ?? ''}」收到一条站长中转意向：`,
      '',
      `联系人：${v.name ?? ''}`,
      `联系方式：${v.contact ?? ''}`,
      `留言：${v.note ?? ''}`,
      '',
      '请登录后台处理。',
      '—— 系统自动发送，请勿回复',
    ].join('\n'),
  }),

  // 帖子到期前 3 天提醒
  post_expiring: (v) => ({
    subject: `【${BRAND}】您的帖子即将到期`,
    text: [
      `您的帖子「${v.title ?? ''}」将在 3 天后到期。`,
      '',
      '如需继续展示，请登录后点击"重新发布"。',
      '—— 系统自动发送，请勿回复',
    ].join('\n'),
  }),
};

export function renderTemplate(
  name: string,
  rawVars: Record<string, string>,
  env: Env,
): RenderedMail | null {
  const fn = TEMPLATES[name];
  if (!fn) return null;
  return fn(sanitizeVars(rawVars), env);
}

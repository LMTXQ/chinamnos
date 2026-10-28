// 渠道注册表（站外通知推送方案 · §3.3）：每渠道注册 校验/脱敏/发送 三件套。
// 新增渠道 = 在 CHANNELS 加一个 ChannelDef，绑定流与后续推送分支（方案 B/C/D）零改动。
import type { Env } from '../common/env';
import { aesGcmEncrypt, aesGcmDecrypt } from '../common/crypto';
import { qqbotSendGroup, type QqBotCred } from './qqbot';

export interface SendResult {
  ok: boolean;
  error?: string;
}

export type ChannelCred = Record<string, string>;

export interface ChannelField {
  key: string;
  label: string;
  placeholder: string;
}

export interface ChannelDef {
  type: string;
  label: string;
  desc: string; // 绑定表单说明文案
  fields: ChannelField[];
  /** 绑定即生效（邮件渠道：凭证即账号邮箱，无需验证码） */
  skipVerify?: boolean;
  /** 绑定后由平台回调激活/追加群（QQ 官方机器人）：create 不外发验证码，改返回 24h 绑定码由群内 @机器人 消费 */
  bindByCallback?: boolean;
  /** 目标群手动登记（Qmsg：Qmsg 控制台绑群后回站内登记群号，经 targets 端点增删） */
  manualTargets?: boolean;
  /** 仅参与青龙批量管线（方案 C），即时分支跳过该渠道 */
  bulkOnly?: boolean;
  validate(raw: Record<string, unknown>, viewerEmail?: string): { ok: true; cred: ChannelCred } | { ok: false; error: string };
  hint(cred: ChannelCred): string; // 脱敏展示（target_hint）
  send(cred: ChannelCred, title: string, body: string): Promise<SendResult>;
}

// 按 UTF-8 字节截断（中文 3 字节），丢掉被切半个的尾字符避免乱码（对齐 notify.py 的 _trunc_bytes）
export function truncBytes(s: string, limit: number): string {
  const b = new TextEncoder().encode(s);
  if (b.length <= limit) return s;
  let cut = b.slice(0, limit);
  for (let i = 0; i < 4; i++) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(cut) + '\n\n…（内容过长已截断）';
    } catch {
      cut = cut.slice(0, -1);
    }
  }
  return new TextDecoder('utf-8').decode(cut) + '\n\n…（内容过长已截断）';
}

/* ── 企业微信群机器人 ──
   群设置 → 群机器人 → 添加，复制 Webhook 地址；markdown 消息上限 4096 字节（留余量）。 */
const wecom: ChannelDef = {
  type: 'wecom',
  label: '企业微信机器人',
  desc: '在企业微信群（建议单人群）设置中添加「群机器人」，复制 Webhook 地址粘贴绑定。验证码与后续通知都会发到该群。',
  fields: [
    { key: 'webhook', label: 'Webhook 地址', placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…' },
  ],
  validate(raw) {
    const v = typeof raw.webhook === 'string' ? raw.webhook.trim() : '';
    if (!/^https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[0-9a-zA-Z-]{16,}$/.test(v)) {
      return { ok: false, error: 'Webhook 地址格式不正确，请复制企业微信群机器人的完整 Webhook 地址' };
    }
    return { ok: true, cred: { webhook: v } };
  },
  hint(cred) {
    const m = /key=([0-9a-zA-Z-]+)/.exec(cred.webhook || '');
    return `企业微信机器人 · key 尾号 ${m ? m[1].slice(-4) : '****'}`;
  },
  async send(cred, title, body) {
    const content = truncBytes(`## ${title}\n${body}`, 3800);
    let res: Response;
    try {
      res = await fetch(cred.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
      });
    } catch (e) {
      return { ok: false, error: `网络错误: ${String(e)}` };
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string };
    if (data.errcode !== 0) return { ok: false, error: `errcode=${data.errcode} ${data.errmsg || ''}`.trim() };
    return { ok: true };
  },
};

/* ── 钉钉群机器人（加签可选）──
   群设置 → 智能群助手 → 添加「自定义」机器人；安全设置选「加签」则需填 SEC 开头密钥。
   markdown 消息 title ≤64 字；频控 20 条/分钟/机器人。 */
async function dingtalkSign(secret: string, ts: number): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${ts}\n${secret}`));
  let bin = '';
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
  return encodeURIComponent(btoa(bin));
}

const dingtalk: ChannelDef = {
  type: 'dingtalk',
  label: '钉钉机器人',
  desc: '在钉钉群设置中添加「自定义机器人」（安全设置建议选「加签」），复制 Webhook 地址；如选了加签请一并填入 SEC 开头的密钥。验证码与后续通知都会发到该群。',
  fields: [
    { key: 'webhook', label: 'Webhook 地址', placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=…' },
    { key: 'secret', label: '加签密钥（可选）', placeholder: 'SEC 开头，仅安全设置选「加签」时填写' },
  ],
  validate(raw) {
    const v = typeof raw.webhook === 'string' ? raw.webhook.trim() : '';
    if (!/^https:\/\/oapi\.dingtalk\.com\/robot\/send\?access_token=[0-9a-zA-Z]{16,}$/.test(v)) {
      return { ok: false, error: 'Webhook 地址格式不正确，请复制钉钉自定义机器人的完整 Webhook 地址' };
    }
    const s = typeof raw.secret === 'string' ? raw.secret.trim() : '';
    if (s && !/^SEC[0-9a-zA-Z]{6,}$/.test(s)) {
      return { ok: false, error: '加签密钥格式不正确：应为创建机器人时生成的 SEC 开头字符串' };
    }
    return { ok: true, cred: s ? { webhook: v, secret: s } : { webhook: v } };
  },
  hint(cred) {
    const m = /access_token=([0-9a-zA-Z]+)/.exec(cred.webhook || '');
    return `钉钉机器人 · token 尾号 ${m ? m[1].slice(-4) : '****'}${cred.secret ? '（加签）' : ''}`;
  },
  async send(cred, title, body) {
    let url = cred.webhook;
    if (cred.secret) {
      const ts = Date.now();
      url += `&timestamp=${ts}&sign=${await dingtalkSign(cred.secret, ts)}`;
    }
    const content = truncBytes(`## ${title}\n${body}`, 3800);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'markdown', markdown: { title: title.slice(0, 64), text: content } }),
      });
    } catch (e) {
      return { ok: false, error: `网络错误: ${String(e)}` };
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string };
    if (data.errcode !== 0) return { ok: false, error: `errcode=${data.errcode} ${data.errmsg || ''}`.trim() };
    return { ok: true };
  },
};

/* ── 邮件（账号邮箱，一键绑定）──
   凭证即账号邮箱（绑定即激活，无验证码——所有权由账号体系天然保证）。
   即时分支不发本渠道（私信/审核类邮件由既有 mail_* 开关链路负责，避免重复）；
   批量分支（方案 C cron 到期帖 / 方案 D 采集播报）经青龙 SMTP 多邮箱池发送。 */
const email: ChannelDef = {
  type: 'email',
  label: '邮件',
  desc: '一键绑定你的注册邮箱。到期提醒、采集播报等批量通知将发送到该邮箱；私信与审核类通知本就会发送到你的邮箱，不受此绑定影响。',
  fields: [],
  skipVerify: true,
  bulkOnly: true,
  validate(_raw, viewerEmail) {
    if (!viewerEmail) return { ok: false, error: '账号缺少邮箱，无法绑定邮件渠道' };
    return { ok: true, cred: { email: viewerEmail } };
  },
  hint(cred) {
    return `邮件 · ${cred.email || ''}`;
  },
  async send() {
    // 即时分支占位：本渠道即时事件不发（见上），批量事件由青龙侧 SMTP 池负责
    return { ok: true };
  },
};

/* ── Qmsg酱（QQ 推送，第三方中转）──
   cred: {key, domain?, targets?[]}，targets = QQ 群号数组（手动登记：Qmsg 控制台绑定群后抄群号，
   经 targets 端点管理——Qmsg 无回调，与 qqbot 的自动收集不同）。targets 空 = 发平台绑定默认目标。
   仅 plain 文本（Qmsg 不支持 markdown 透传）。域名/截断上限以实测为准：
   新版文档出现 api.atku.cn、旧版 qmsg.zendee.cn——实测后只改下面常量（cred.domain 可覆盖域名）。
   平台硬限流：同 Key 每 5 秒 1 次、每日 500 次（多群串行间隔 5s）；URL/连续数字为风控点（实测未拦）。
   群通知需群主在群设置开启「机器人主动在群聊内发言」（与 qqbot 同理）。 */
const QMSG_DEFAULT_DOMAIN = 'https://qmsg.zendee.cn';
const QMSG_SEND_PATH = '/v3/jsend/';
const QMSG_MSG_LIMIT = 1800; // 官方文档：最长 1800 字符（UTF-8 字节级截断）
const QMSG_GROUP_INTERVAL_MS = 5000; // 同 Key 限流 5 秒/次，多群串行必须间隔

/* plain 渠道净化（导出：notify-channels 群验证码复用）：绑定验证码/即时消息正文可能含
   markdown 标记（**验证码**、[站点](url)），Qmsg 不渲染 markdown，发前去除标记保证 QQ 端可读。
   链接文字与网址相同（纯域名链接）时只保留网址，避免"域名: 网址"重复显示。 */
export function plainify(s: string): string {
  return s
    .replace(/\[([^\]\s]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => {
      const bare = url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
      return text.replace(/\/+$/, '') === bare ? url : `${text}: ${url}`;
    })
    .replace(/\*\*([^*]+)\*\*/g, '$1');
}

/** Qmsg 单目标发送（targets 循环与群验证码共用）：group=null = 平台默认目标 */
export async function qmsgSendRaw(
  cred: ChannelCred,
  group: string | null,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${cred.domain || QMSG_DEFAULT_DOMAIN}${QMSG_SEND_PATH}${encodeURIComponent(cred.key || '')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg: text, ...(group ? { group } : {}) }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = (await res.json().catch(() => ({}))) as { success?: boolean; reason?: string; message?: string };
    if (data.success === true) return { ok: true };
    return { ok: false, error: data.reason || data.message || 'Qmsg 返回失败' };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 120) };
  }
}

const qmsg: ChannelDef = {
  type: 'qmsg',
  label: 'Qmsg酱',
  desc: '在 Qmsg 平台获取 Key，默认发送到平台绑定的 QQ 单聊；群通知在 Qmsg 控制台绑定群后，回站内「添加群」登记群号。消息经 Qmsg 中转发往 QQ。',
  manualTargets: true,
  fields: [
    { key: 'key', label: 'Qmsg Key', placeholder: 'Qmsg 平台个人中心获取' },
  ],
  validate(raw) {
    const v = typeof raw.key === 'string' ? raw.key.trim() : '';
    if (!/^[0-9a-zA-Z_-]{6,}$/.test(v)) {
      return { ok: false, error: 'Qmsg Key 格式不正确，请在 Qmsg 平台个人中心复制完整 Key' };
    }
    // 域名覆盖为预留能力（绑定表单暂不展示该字段）：cred.domain 存在时校验为 https 完整域名
    const d = typeof raw.domain === 'string' ? raw.domain.trim().replace(/\/+$/, '') : '';
    if (d && !/^https:\/\/[^\s/]+$/.test(d)) {
      return { ok: false, error: '自定义域名格式不正确：应为 https:// 开头的完整域名' };
    }
    // 显式构造 cred（避免可选属性 union 推断无法赋给 ChannelCred）
    const cred: ChannelCred = { key: v };
    if (d) cred.domain = d;
    return { ok: true, cred };
  },
  hint(cred) {
    const n = Array.isArray(cred.targets) ? cred.targets.length : 0;
    return `Qmsg酱 · key 尾号 ${(cred.key || '').slice(-4) || '****'}${n ? ` · ${n} 群` : ''}`;
  },
  async send(cred, title, body) {
    const raw = `${title}\n\n${body}`;
    const text = truncBytes(plainify(raw), QMSG_MSG_LIMIT);
    const targets = Array.isArray(cred.targets) ? cred.targets.filter(Boolean) : [];
    // targets 空 = 平台绑定默认目标（单聊），无 group 参数；非空 = 逐群 + 5s 限流间隔
    const jobs: Array<Record<string, unknown>> = targets.length
      ? targets.map((g) => ({ msg: text, group: g }))
      : [{ msg: text }];
    let sent = 0;
    const errs: string[] = [];
    for (let i = 0; i < jobs.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, QMSG_GROUP_INTERVAL_MS));
      const group = jobs[i].group as string | undefined;
      const r = await qmsgSendRaw(cred, group || null, text);
      if (r.ok) sent++;
      else errs.push(`${group || '默认'}: ${r.error || '未知错误'}`);
    }
    if (!sent) return { ok: false, error: `全部发送失败：${errs.join('；').slice(0, 250)}` };
    if (errs.length) {
      return { ok: false, error: `部分失败 ${sent}/${jobs.length}：${errs.join('；').slice(0, 200)}` };
    }
    return { ok: true };
  },
};

/* ── QQ 官方机器人（群聊，直连 OpenAPI）──
   cred: {appid, secret, targets[]}，targets = group_openid 列表，由回调绑定码流程写入
   （见 qqbot-callback.ts）。md 优先（2026-10-29 实测：原生 md 含 GFM 表格渲染正常），
   无 md 权限的机器人自动降级 plain（plainify 净化后发送）——其他用户自有机器人未必有 md 权限。
   消息内容含 URL 需在 q.qq.com 后台「消息URL配置」登记域名（2026-10-29 实测当前平台未强制）。 */
const QQBOT_MSG_LIMIT = 1500; // 官方文本 content 上限约 1500 字节（UTF-8），超限截断不拆条
const QQBOT_USE_MD = true;

const qqbot: ChannelDef = {
  type: 'qqbot',
  label: 'QQ官方机器人',
  desc: '在 QQ 开放平台创建机器人，填入 AppID 与 AppSecret 绑定实例；再把机器人拉进群，在群内 @机器人 发送绑定码完成加群。通知直连官方接口发到群，需群主在群设置开启「机器人主动在群聊内发言」。',
  bindByCallback: true,
  fields: [
    { key: 'appid', label: 'AppID', placeholder: 'QQ 开放平台机器人的数字 AppID' },
    { key: 'secret', label: 'AppSecret', placeholder: 'QQ 开放平台生成的密钥字符串' },
  ],
  validate(raw) {
    const appid = typeof raw.appid === 'string' ? raw.appid.trim() : '';
    if (!/^\d{6,20}$/.test(appid)) {
      return { ok: false, error: 'AppID 格式不正确：应为 QQ 开放平台的数字 AppID' };
    }
    const secret = typeof raw.secret === 'string' ? raw.secret.trim() : '';
    if (!/^[0-9a-zA-Z]{16,64}$/.test(secret)) {
      return { ok: false, error: 'AppSecret 格式不正确：应为开放平台生成的密钥字符串' };
    }
    // targets 只能由回调流程追加：绑定时不接受用户提交的 targets（防伪造 group_openid）
    const cred: ChannelCred = { appid, secret };
    return { ok: true, cred };
  },
  hint(cred) {
    const n = Array.isArray(cred.targets) ? cred.targets.length : 0;
    return `QQ机器人 ${String(cred.appid || '').slice(-4)} · ${n} 个群`;
  },
  async send(cred, title, body) {
    const targets = Array.isArray(cred.targets) ? cred.targets.filter(Boolean) : [];
    if (!targets.length) return { ok: false, error: '未绑定任何群：先在群内 @机器人 发送绑定码' };
    const raw = `${title}\n\n${body}`;
    const mdContent = truncBytes(raw, QQBOT_MSG_LIMIT);
    const plainContent = truncBytes(plainify(raw), QQBOT_MSG_LIMIT);
    let sent = 0;
    const errs: string[] = [];
    await Promise.all(targets.map(async (g) => {
      try {
        // md 优先（表格/加粗/链接可渲染）；平台拒绝或异常 → 降级 plain 重发
        let r = QQBOT_USE_MD
          ? await qqbotSendGroup(cred as unknown as QqBotCred, g, { msg_type: 2, markdown: { content: mdContent } })
          : { ok: false as const, error: 'md off' };
        if (!r.ok && QQBOT_USE_MD) {
          r = await qqbotSendGroup(cred as unknown as QqBotCred, g, { msg_type: 0, content: plainContent });
        }
        if (r.ok) sent++;
        else errs.push(`${g.slice(-6)}: ${r.error || '未知错误'}`);
      } catch (e) {
        errs.push(`${g.slice(-6)}: ${String(e).slice(0, 80)}`);
      }
    }));
    if (!sent) return { ok: false, error: `全部 ${targets.length} 个群发送失败：${errs.join('；').slice(0, 250)}` };
    if (errs.length) {
      // 多群部分失败聚合为单值结果（文档口径）；频控/配额错误（22009 等）不区分对待，仅记录
      return { ok: false, error: `部分失败 ${sent}/${targets.length}：${errs.join('；').slice(0, 200)}` };
    }
    return { ok: true };
  },
};

/* ── 飞书自定义机器人（群聊）──
   群设置 → 群机器人 → 添加「自定义机器人」，复制 Webhook 地址；安全设置开启「签名校验」则需填密钥。
   官方文档（2025-10 版）：支持的 msg_type 仅 text / post / image / share_chat / interactive（卡片）——
   无独立 markdown 类型，卡片 lark_md 亦不支持表格，故仅发 text 纯文本（plainify 净化后）。
   加签规则与钉钉相反：以 `timestamp + "\n" + secret` 整串为 HMAC-SHA256 密钥对空消息体签名，
   再 Base64；payload 顶层带 timestamp（秒级字符串）与 sign，时间戳距发送须 ≤1 小时。
   请求体 ≤20KB；频控单机器人 100 次/分钟、5 次/秒（正常通知频率远低于此，不做节流）；成功响应 code=0。 */
const FEISHU_BODY_LIMIT = 18000; // 请求体 20KB 上限（含 JSON 包装与转义），留余量

async function feishuSign(secret: string, ts: number): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(`${ts}\n${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new Uint8Array(0));
  let bin = '';
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
  return btoa(bin);
}

const feishu: ChannelDef = {
  type: 'feishu',
  label: '飞书机器人',
  desc: '在飞书群（建议单人群）设置中添加「自定义机器人」，复制 Webhook 地址粘贴绑定；安全设置若开启「签名校验」，请一并填入密钥。验证码与后续通知都会发到该群。',
  fields: [
    { key: 'webhook', label: 'Webhook 地址', placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/…' },
    { key: 'secret', label: '签名密钥（可选）', placeholder: '仅安全设置开启「签名校验」时填写' },
  ],
  validate(raw) {
    const v = typeof raw.webhook === 'string' ? raw.webhook.trim() : '';
    // 国内版 open.feishu.cn / 国际版 Lark open.larksuite.com（webhook 主域不同，结构一致）
    if (!/^https:\/\/(open\.feishu\.cn|open\.larksuite\.com)\/open-apis\/bot\/v2\/hook\/[0-9a-zA-Z_-]{16,}$/.test(v)) {
      return { ok: false, error: 'Webhook 地址格式不正确，请复制飞书自定义机器人的完整 Webhook 地址' };
    }
    // 飞书签名密钥无固定前缀/格式（区别于钉钉 SEC 开头），仅排除空白字符
    const s = typeof raw.secret === 'string' ? raw.secret.trim() : '';
    if (s && !/^\S{6,64}$/.test(s)) {
      return { ok: false, error: '签名密钥格式不正确：应为机器人「签名校验」设置中生成的密钥' };
    }
    // 显式构造 cred（避免可选属性 union 推断无法赋给 ChannelCred）
    const cred: ChannelCred = { webhook: v };
    if (s) cred.secret = s;
    return { ok: true, cred };
  },
  hint(cred) {
    const m = /hook\/([0-9a-zA-Z_-]+)/.exec(cred.webhook || '');
    return `飞书机器人 · 尾号 ${m ? m[1].slice(-4) : '****'}${cred.secret ? '（加签）' : ''}`;
  },
  async send(cred, title, body) {
    const payload: Record<string, unknown> = {
      msg_type: 'text',
      content: { text: truncBytes(plainify(`${title}\n\n${body}`), FEISHU_BODY_LIMIT) },
    };
    if (cred.secret) {
      const ts = Math.floor(Date.now() / 1000);
      payload.timestamp = String(ts);
      payload.sign = await feishuSign(cred.secret, ts);
    }
    let res: Response;
    try {
      res = await fetch(cred.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      return { ok: false, error: `网络错误: ${String(e)}` };
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
    if (data.code !== 0) return { ok: false, error: `code=${data.code} ${data.msg || ''}`.trim() };
    return { ok: true };
  },
};

/* ── Bark（iOS 推送 App）──
   cred: {key, server?}，key = App 内推送 URL 中的 Device Key；server = 自建 bark-server 地址
   （官方明确支持自建，默认 https://api.day.app）。发送：POST {server}/push JSON（device_key+title+body），
   成功响应 HTTP 200 且 code=200（bark-server CommonResp），失败返回 HTTP 400/500。
   官方无频控（异常使用才封 IP）；无文档级长度上限，但 APNs 单条推送载荷约 4KB 上限——超长直接被苹果拒收，
   故按字节截断。markdown 参数不支持表格，统一发纯文本。 */
const BARK_DEFAULT_SERVER = 'https://api.day.app';
const BARK_BODY_LIMIT = 3000; // APNs 载荷 4KB 上限，留 JSON 包装（title/icon 等）余量

const bark: ChannelDef = {
  type: 'bark',
  label: 'Bark（iOS）',
  desc: 'iPhone 安装 Bark App 后复制推送 URL 中的 Key 绑定；自建服务器用户可改填服务器地址。验证码与通知直达 iPhone 通知中心。',
  fields: [
    { key: 'key', label: 'Device Key', placeholder: 'Bark App 内复制，如 https://api.day.app/你的Key 中的 Key' },
    { key: 'server', label: '服务器地址（可选）', placeholder: '留空使用官方 api.day.app；自建填 https:// 完整域名' },
  ],
  validate(raw) {
    const v = typeof raw.key === 'string' ? raw.key.trim() : '';
    if (!/^[0-9a-zA-Z]{16,64}$/.test(v)) {
      return { ok: false, error: 'Device Key 格式不正确，请在 Bark App 复制推送 URL 中的 Key（一串字母数字）' };
    }
    const s = typeof raw.server === 'string' ? raw.server.trim().replace(/\/+$/, '') : '';
    if (s && !/^https:\/\/[^\s/]+$/.test(s)) {
      return { ok: false, error: '服务器地址格式不正确：应为 https:// 开头的完整域名' };
    }
    const cred: ChannelCred = { key: v };
    if (s) cred.server = s;
    return { ok: true, cred };
  },
  hint(cred) {
    return `Bark · key 尾号 ${(cred.key || '').slice(-4) || '****'}${cred.server ? '（自建）' : ''}`;
  },
  async send(cred, title, body) {
    const server = (cred.server || BARK_DEFAULT_SERVER).replace(/\/+$/, '');
    let res: Response;
    try {
      res = await fetch(`${server}/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          device_key: cred.key,
          title: title.slice(0, 64),
          body: truncBytes(plainify(body), BARK_BODY_LIMIT),
        }),
      });
    } catch (e) {
      return { ok: false, error: `网络错误: ${String(e)}` };
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = (await res.json().catch(() => ({}))) as { code?: number; message?: string };
    if (data.code !== 200) return { ok: false, error: `code=${data.code} ${data.message || ''}`.trim() };
    return { ok: true };
  },
};

/* ── PushPlus（微信公众号推送，第三方中转）──
   cred: {token}，微信扫码登录 pushplus.plus 获取。发送：POST /send JSON（token+title+content+template=markdown）。
   官方文档 V1.18（2026-09）：markdown 模板官方支持；接口异步——同步响应 code=200 仅代表受理，
   最终结果需流水号查询/回调（本渠道以此为准，不追踪流水号）。免费额度（实名用户）：200 次/日、
   1 分钟 5 次、相同内容 1 小时 3 条——单人单 token 频率远低于此，不做节流；同内容去重由消息本身含轮次/时间戳天然规避。
   错误码：900=请求超量 903=token 无效 905=未实名。限制（实名）：标题 ≤100 字、内容 ≤2 万字。 */
const PUSHPLUS_SEND_URL = 'https://www.pushplus.plus/send';
const PUSHPLUS_TITLE_LIMIT = 100;
const PUSHPLUS_CONTENT_LIMIT = 18000; // 内容上限 2 万字（实名），UTF-8 字节级截断保守留余

const pushplus: ChannelDef = {
  type: 'pushplus',
  label: 'PushPlus',
  desc: '微信扫码登录 pushplus.plus（pushplus推送加公众号）获取 token 绑定，通知经其中转推送到你的微信。建议完成实名认证，未实名无法发送（错误码 905）。',
  fields: [
    { key: 'token', label: 'PushPlus Token', placeholder: 'pushplus.plus 个人中心获取' },
  ],
  validate(raw) {
    const v = typeof raw.token === 'string' ? raw.token.trim() : '';
    if (!/^[0-9a-zA-Z]{24,64}$/.test(v)) {
      return { ok: false, error: 'Token 格式不正确，请在 pushplus.plus 个人中心复制完整 token' };
    }
    return { ok: true, cred: { token: v } };
  },
  hint(cred) {
    return `PushPlus · token 尾号 ${(cred.token || '').slice(-4) || '****'}`;
  },
  async send(cred, title, body) {
    let res: Response;
    try {
      // markdown 模板直接保留标记（公众号侧渲染）；表格渲染未实测，异常时改发 plain
      res = await fetch(PUSHPLUS_SEND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: cred.token,
          title: title.slice(0, PUSHPLUS_TITLE_LIMIT),
          content: truncBytes(body, PUSHPLUS_CONTENT_LIMIT),
          template: 'markdown',
        }),
      });
    } catch (e) {
      return { ok: false, error: `网络错误: ${String(e)}` };
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
    if (data.code !== 200) return { ok: false, error: `code=${data.code} ${data.msg || ''}`.trim() };
    return { ok: true };
  },
};

/* 注册表：dingtalk / wecom / email / qmsg / qqbot / feishu / bark / pushplus 已上线 */
export const CHANNELS: Record<string, ChannelDef> = { dingtalk, wecom, email, qmsg, qqbot, feishu, bark, pushplus };

export function getChannel(type: string): ChannelDef | undefined {
  return CHANNELS[type];
}

/* 加解密（绑定流专用）：密钥与联系方式加密同源（CARDHUB_SECRET 派生） */
export async function sealCred(env: Env, cred: ChannelCred): Promise<string> {
  return aesGcmEncrypt(env.CARDHUB_SECRET || 'fallback', JSON.stringify(cred));
}

export async function openCred(env: Env, credEnc: string): Promise<ChannelCred> {
  return JSON.parse(await aesGcmDecrypt(env.CARDHUB_SECRET || 'fallback', credEnc)) as ChannelCred;
}

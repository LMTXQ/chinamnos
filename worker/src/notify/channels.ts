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
   在 Qmsg 平台获取 Key，推送目标（QQ 号/群）在 Qmsg 平台侧绑定，本站只存 Key。
   仅 plain 文本（Qmsg 不支持 markdown 透传）。域名/截断上限以实测为准：
   新版文档出现 api.atku.cn、旧版 qmsg.zendee.cn——实测后只改下面常量（cred.domain 可覆盖域名）。 */
const QMSG_DEFAULT_DOMAIN = 'https://qmsg.zendee.cn';
const QMSG_SEND_PATH = '/v3/jsend/';
const QMSG_MSG_LIMIT = 1800; // UTF-8 字节上限（旧版），新版实测确认后调整

/* plain 渠道净化：绑定验证码/即时消息正文可能含 markdown 标记（**验证码**、[站点](url)），
   Qmsg 不渲染 markdown，发前去除标记保证 QQ 端可读。
   链接文字与网址相同（纯域名链接）时只保留网址，避免"域名: 网址"重复显示。 */
function plainify(s: string): string {
  return s
    .replace(/\[([^\]\s]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => {
      const bare = url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
      return text.replace(/\/+$/, '') === bare ? url : `${text}: ${url}`;
    })
    .replace(/\*\*([^*]+)\*\*/g, '$1');
}

const qmsg: ChannelDef = {
  type: 'qmsg',
  label: 'Qmsg酱',
  desc: '在 Qmsg 平台获取 Key，并在 Qmsg 平台内绑定推送目标（QQ 号/群）。验证码与后续通知经 Qmsg 中转发往 QQ。',
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
    return `Qmsg酱 · key 尾号 ${(cred.key || '').slice(-4) || '****'}`;
  },
  async send(cred, title, body) {
    const text = truncBytes(plainify(`${title}\n\n${body}`), QMSG_MSG_LIMIT);
    let res: Response;
    try {
      res = await fetch(`${cred.domain || QMSG_DEFAULT_DOMAIN}${QMSG_SEND_PATH}${encodeURIComponent(cred.key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msg: text }),
      });
    } catch (e) {
      return { ok: false, error: `网络错误: ${String(e)}` };
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = (await res.json().catch(() => ({}))) as { success?: boolean; reason?: string; message?: string };
    if (data.success !== true) return { ok: false, error: data.reason || data.message || 'Qmsg 返回失败' };
    return { ok: true };
  },
};

/* ── QQ 官方机器人（群聊，直连 OpenAPI）──
   cred: {appid, secret, targets[]}，targets = group_openid 列表，由回调绑定码流程写入
   （见 qqbot-callback.ts）。v1 用纯文本 msg_type=0：QQ 官方 markdown 为受限子集（无表格）
   且部分机器人需模板/权限，留待实测后启用（届时改 qqbotSendGroup 的 payload 即可）。
   消息内容含 URL 需在 q.qq.com 后台「开发设置 → 消息URL配置」预先登记域名，否则发送失败。 */
const QQBOT_MSG_LIMIT = 1500; // 官方文本 content 上限约 1500 字节（UTF-8），超限截断不拆条

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
    const content = truncBytes(`${title}\n\n${body}`, QQBOT_MSG_LIMIT);
    let sent = 0;
    const errs: string[] = [];
    await Promise.all(targets.map(async (g) => {
      try {
        const r = await qqbotSendGroup(cred as unknown as QqBotCred, g, { msg_type: 0, content });
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

/* 注册表：dingtalk / wecom / email / qmsg / qqbot 已上线；feishu/pushplus 按同结构即插即用 */
export const CHANNELS: Record<string, ChannelDef> = { dingtalk, wecom, email, qmsg, qqbot };

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

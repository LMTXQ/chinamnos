// QQ 官方机器人 OpenAPI 客户端（增量 2）：token 缓存 + 群消息发送 + Ed25519 回调验签。
// 渠道无关的底层封装——channels.ts 的 ChannelDef.send 与 qqbot-callback.ts 回调路由共用。
// 官方文档要点（2026-07 版）：
//   统一 API 基址 https://api.bot.qq.com，鉴权头 `Authorization: QQBot {access_token}`；
//   token：POST https://bots.qq.com/app/getAppAccessToken {appId, clientSecret} → {access_token, expires_in}（字符串，秒，约 7200）；
//   群消息：POST /v2/groups/{group_openid}/messages {msg_type, content, msg_id?, msg_seq?}；
//     官方建议发消息超时 ≥5 秒（防"已发送成功但未收到同步结果"）；含 URL 的消息需在
//     q.qq.com 后台「开发设置 → 消息URL配置」预先登记域名，否则发送失败；
//   频控（2026-06-22 群主动推送全量开放后）：账号 60 qpm（未认证 30）、单群 20 qpm，超频 err_code=22009；
//   回调验签：seed = AppSecret 字节循环翻倍补足 32 字节 → Ed25519 派生密钥对；
//     事件验签 = verify(seed公钥, timestamp + body, hex(X-Signature-Ed25519))，且 sig[63] & 0xE0 == 0；
//     URL 验证握手(op 13) = 用 seed 私钥对 `event_ts + plain_token` 签名，返回 {plain_token, signature}。

export interface QqBotCred {
  appid: string;
  secret: string;
  /** group_openid 列表，由回调绑定码流程追加 */
  targets?: string[];
}

export const QQBOT_API_BASE = 'https://api.bot.qq.com';
const QQBOT_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const TOKEN_TTL_MS = 2 * 3600 * 1000;
const TOKEN_REFRESH_AHEAD_MS = 5 * 60 * 1000;
/** 发消息请求超时（官方建议 ≥5 秒，防"已成功但未收到同步结果"被误判失败） */
export const QQBOT_FETCH_TIMEOUT_MS = 8_000;

/* token 缓存（isolate 级内存）：跨 isolate 重复取 token 无害，避免为此引入 KV/D1 资源；
   换取失败不缓存、直接抛错由调用方兜底。 */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export function qqbotInvalidateToken(appid: string): void {
  tokenCache.delete(appid);
}

export async function getAppAccessToken(appid: string, secret: string): Promise<string> {
  const hit = tokenCache.get(appid);
  if (hit && hit.expiresAt > Date.now() + TOKEN_REFRESH_AHEAD_MS) return hit.token;
  const res = await fetch(QQBOT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: appid, clientSecret: secret }),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: string };
  const token = typeof data.access_token === 'string' ? data.access_token : '';
  if (!res.ok || !token) throw new Error(`token 获取失败 HTTP ${res.status} ${JSON.stringify(data).slice(0, 120)}`);
  const ttlSec = parseInt(data.expires_in || '7200', 10) || 7200;
  tokenCache.set(appid, { token, expiresAt: Date.now() + Math.min(ttlSec * 1000, TOKEN_TTL_MS) });
  return token;
}

/** 发群消息（msg_type 0 文本 / 2 markdown，payload 由调用方组装）。401 时清 token 缓存便于上层重试一次。 */
export async function qqbotSendGroup(
  cred: QqBotCred,
  groupOpenid: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string; rateLimited?: boolean }> {
  let token: string;
  try {
    token = await getAppAccessToken(cred.appid, cred.secret);
  } catch (e) {
    return { ok: false, error: `token: ${String(e).slice(0, 150)}` };
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${QQBOT_API_BASE}/v2/groups/${encodeURIComponent(groupOpenid)}/messages`, {
        method: 'POST',
        headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(QQBOT_FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      return { ok: false, error: `网络错误: ${String(e).slice(0, 120)}` };
    }
    const data = (await res.json().catch(() => ({}))) as { err_code?: number; message?: string };
    if (res.status === 401) {
      // token 失效：清缓存换新重试一次
      qqbotInvalidateToken(cred.appid);
      if (attempt === 0) {
        try {
          token = await getAppAccessToken(cred.appid, cred.secret);
          continue;
        } catch (e) {
          return { ok: false, error: `token 刷新失败: ${String(e).slice(0, 120)}` };
        }
      }
    }
    if (!res.ok || (typeof data.err_code === 'number' && data.err_code !== 0)) {
      return {
        ok: false,
        error: `HTTP ${res.status} err_code=${data.err_code ?? '-'} ${data.message || ''}`.trim(),
        rateLimited: data.err_code === 22009,
      };
    }
    return { ok: true };
  }
  return { ok: false, error: 'unreachable' };
}

/* ── Ed25519 回调验签（官方规则：AppSecret 派生密钥，无需额外配置密钥对） ──
   ⚠️ WebCrypto 的 raw 导入只认 Ed25519 公钥——私钥必须包成 PKCS8 DER（16 字节固定前缀 + seed）；
   验签公钥经 exportKey('jwk') 的 x 参数取回（实测 Node/workerd 同构）。
   ⚠️ 官方文档 sign.html 的 DEMO 输出数值不自洽（与标准 Ed25519 数学矛盾，公钥仅差 2 字节），
   以标准算法为准（平台服务端为标准库实现）。 */

// Ed25519 PKCS8 v1 前缀（RFC 8410）：302e020100300506032b657004220420 + seed
const ED25519_PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
// SPKI DER 公钥前缀长度（302a300506032b6570032100）——本项目未用 spki 导出，jwk.x 代替
const ED25519_SEED_LEN = 32;

function ed25519SeedBytes(secret: string): Uint8Array {
  const raw = new TextEncoder().encode(secret);
  if (!raw.length) throw new Error('empty secret');
  let seed = raw;
  while (seed.length < ED25519_SEED_LEN) {
    const doubled = new Uint8Array(seed.length * 2);
    doubled.set(seed, 0);
    doubled.set(seed, seed.length);
    seed = doubled;
  }
  return seed.slice(0, ED25519_SEED_LEN);
}

function ed25519Pkcs8(secret: string): Uint8Array {
  const seed = ed25519SeedBytes(secret);
  const der = new Uint8Array(ED25519_PKCS8_PREFIX.length + seed.length);
  der.set(ED25519_PKCS8_PREFIX, 0);
  der.set(seed, ED25519_PKCS8_PREFIX.length);
  return der;
}

function bytesToHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function ed25519PrivateKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', ed25519Pkcs8(secret), { name: 'Ed25519' }, true, ['sign']);
}

/** 由私钥取 raw 公钥（pkcs8 导入 → jwk.x），供验签用 */
async function ed25519PublicKeyRaw(secret: string): Promise<Uint8Array> {
  const priv = await ed25519PrivateKey(secret);
  const jwk = await crypto.subtle.exportKey('jwk', priv) as { x?: string };
  if (!jwk.x) throw new Error('jwk 导出缺少 x');
  return Uint8Array.from(atob(jwk.x.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
}

/** URL 验证握手(op 13)：对 `event_ts + plain_token` 签名，返回 hex 签名 */
export async function qqbotSignValidation(secret: string, eventTs: string, plainToken: string): Promise<string> {
  const key = await ed25519PrivateKey(secret);
  const sig = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(eventTs + plainToken));
  return bytesToHex(new Uint8Array(sig));
}

/** 事件验签：verify(seed派生公钥, timestamp + rawBody, hex(X-Signature-Ed25519)) */
export async function qqbotVerifyEvent(
  secret: string,
  timestamp: string,
  rawBody: string,
  sigHex: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{128}$/i.test(sigHex)) return false;
  const sig = Uint8Array.from(sigHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  if (sig.length !== 64 || (sig[63] & 0xe0) !== 0) return false;
  let pub: CryptoKey;
  try {
    const pubRaw = await ed25519PublicKeyRaw(secret);
    pub = await crypto.subtle.importKey('raw', pubRaw, { name: 'Ed25519' }, false, ['verify']);
  } catch {
    return false;
  }
  const msg = new TextEncoder().encode(timestamp + rawBody);
  return crypto.subtle.verify('Ed25519', pub, sig, msg).catch(() => false);
}

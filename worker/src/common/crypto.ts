// 加密工具（§15）：Web Crypto 标准，无第三方依赖

const enc = new TextEncoder();

// SHA-256（返回 hex）
export async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(data));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// HMAC-SHA256（返回 hex）
export async function hmacSha256Hex(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 生成 n 字节随机数，返回 base64
export function randomBase64(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  // 用 btoa + String.fromCharCode 做 base64（Workers 支持）
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin);
}

// 生成 n 位数字随机验证码
export function randomDigits(n: number): string {
  const buf = new Uint32Array(n);
  crypto.getRandomValues(buf);
  let s = '';
  for (let i = 0; i < n; i++) s += String(buf[i] % 10);
  return s;
}

// ULID（26 位 base32，时间有序）—— 用 crypto.randomUUID 兜底
// Workers 原生不支持 ULID，用时间戳+随机拼一个可排序的 id
export function ulid(): string {
  const now = Date.now();
  // 时间戳部分：10 位 base32（约到公元 10889 年）
  const ts = now.toString(32).padStart(10, '0').toUpperCase();
  // 随机部分：16 位 base32
  const rand = randomBase64(12).replace(/[^A-Z0-9]/g, '0').slice(0, 16).toUpperCase();
  return ts + rand;
}

// 帖子 id：随机 12 位 base62（防遍历枚举）
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export function randomBase62(len: number): string {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  let s = '';
  for (let i = 0; i < len; i++) s += B62[buf[i] % 62];
  return s;
}

// AES-GCM 加解密（notify 联系方式加密，密钥由 CARDHUB_SECRET 派生）
async function deriveKey(secret: string): Promise<CryptoKey> {
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function aesGcmEncrypt(secret: string, plaintext: string): Promise<string> {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  // 返回 base64(iv + ciphertext)
  const combined = new Uint8Array(iv.length + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), iv.length);
  let bin = '';
  for (const b of combined) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function aesGcmDecrypt(secret: string, ciphertextB64: string): Promise<string> {
  const key = await deriveKey(secret);
  const combined = Uint8Array.from(atob(ciphertextB64), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ct = combined.slice(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}

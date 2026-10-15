import type { Env } from './env';

// CORS 白名单（§16）：仅 ALLOWED_ORIGINS 内 Origin 获允许头；OPTIONS 短路
function allowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  const list = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes(origin) ? origin : null;
}

export function handleOptions(request: Request, env: Env): Response | null {
  if (request.method !== 'OPTIONS') return null;
  const headers = new Headers();
  const origin = allowedOrigin(request, env);
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Owner-Key');
    headers.set('Access-Control-Max-Age', '86400');
    headers.set('Vary', 'Origin');
  }
  return new Response(null, { status: 204, headers });
}

export function withCors(resp: Response, request: Request, env: Env): Response {
  const origin = allowedOrigin(request, env);
  const headers = new Headers(resp.headers);
  // 安全响应头：API 域只输出 JSON，全部响应统一加固（与 CORS 白名单无关，恒生效）
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  if (!origin) return new Response(resp.body, { status: resp.status, headers });
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Vary', 'Origin');
  return new Response(resp.body, { status: resp.status, headers });
}

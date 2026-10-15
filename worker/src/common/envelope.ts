// 统一响应信封（§13.1）
export const ERR = {
  VALIDATION_ERROR: 40001,
  RATE_LIMITED: 40029,
  CAPTCHA_FAILED: 40030,
  UNAUTHORIZED: 40100,
  FORBIDDEN: 40300,
  CONTACT_HIDDEN: 40301,
  BANNED: 40302,
  NOT_FOUND: 40400,
  MODULE_DISABLED: 50300,
  INTERNAL_ERROR: 50000,
} as const;

function json(body: unknown, status: number, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  h.set('Content-Type', 'application/json; charset=utf-8');
  // 动态 API 默认禁止缓存：无缓存头的 GET 会被浏览器启发式缓存，
  // 导致页面拿到部署前的旧响应（曾致列表接口新字段「丢失」的假象）。
  // 显式传入 Cache-Control 的接口（如 /api/meta 边缘缓存、头像长缓存）不受影响。
  if (!h.has('Cache-Control')) h.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers: h });
}

export function ok(data: unknown, headers?: HeadersInit): Response {
  return json({ code: 0, message: 'ok', data }, 200, headers);
}

export function fail(code: number, message: string, status: number, data?: unknown): Response {
  return json({ code, message, data: data ?? null }, status);
}

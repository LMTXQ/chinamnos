// 公开只读接口的边缘缓存（Cache API）——大量游客访问下削减 D1 读取与请求消耗的主力手段
// ▸ 只缓存「GET + 无 Authorization」的请求：游客视角响应恒定可安全复用；登录用户直连后端（响应含用户态字段）
// ▸ 短 TTL 免主动失效：内容写后最多 TTL 秒陈旧（先审后发的帖子上线延迟 ≤TTL 可接受），无需写操作反向清缓存
// ▸ 缓存命中时不执行 handler，即零 D1 查询、CPU 接近零；X-Cache 头用于线上验证命中情况
export async function cachedGet(
  request: Request,
  ctx: ExecutionContext,
  ttlSec: number,
  handler: () => Promise<Response>,
): Promise<Response> {
  if (request.method !== 'GET' || request.headers.get('Authorization')) return handler();
  const cache = caches.default;
  // key = 完整 URL（posts 的筛选/分页参数全在 query 上，天然分 key）
  const key = new Request(new URL(request.url).toString(), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) {
    const cached = new Response(hit.body, hit);
    cached.headers.set('X-Cache', 'HIT');
    return cached;
  }
  const resp = await handler();
  if (resp.status !== 200) return resp; // 错误响应不缓存，避免故障期污染
  const store = new Response(resp.body, resp);
  store.headers.set('Cache-Control', `public, max-age=${ttlSec}`);
  store.headers.set('X-Cache', 'MISS');
  ctx.waitUntil(cache.put(key, store.clone()));
  return store;
}

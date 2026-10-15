import type { Env } from '../common/env';
import { ok } from '../common/envelope';
import { getSchema } from './schema';

// GET /api/cardhub/schema：板块/字段/渠道/有效期档位/交易方式配置
// 浏览器缓存 5 分钟（与 /api/meta 同策略）：配置变更最多延迟 5 分钟生效，换取重复进页零请求；
// 新板块上线后老访客最长 5 分钟可见（如 fleet 上线时的感知窗口）
export async function handleSchema(_request: Request, env: Env): Promise<Response> {
  return ok(await getSchema(env), { 'Cache-Control': 'public, max-age=300' });
}

import type { Env } from '../common/env';
import { ERR, fail } from '../common/envelope';
import { getFlags } from '../common/settings';

// 模块总开关守卫（§4.1）：/api/cardhub/* 若关闭返回 503 MODULE_DISABLED
export async function moduleGuard(env: Env): Promise<Response | null> {
  const flags = await getFlags(env);
  if (!flags.cardhub) return fail(ERR.MODULE_DISABLED, 'MODULE_DISABLED', 503);
  return null;
}

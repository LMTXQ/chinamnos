import type { Env } from '../common/env';
import { ok } from '../common/envelope';
import { guard } from '../common/auth';
import { getPublicProfile } from './public-profile';
import { readContacts } from './profile';

// GET /api/auth/me：当前用户资料与角色（contacts 为完整数组，含各条 pub 开关）
// 公开资料（昵称/头衔/头像版本）走账号系统统一出口 getPublicProfile，
// 本体私有数据（contacts 完整数组 / bio）在此单独读取。
export async function handleMe(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;
  const prof = await getPublicProfile(env, g.viewer.id);
  const priv = await env.DB.prepare(
    'SELECT contacts, bio FROM users WHERE id = ?1',
  ).bind(g.viewer.id).first<{ contacts: string | null; bio: string | null }>();
  return ok({
    email: g.viewer.email,
    role: g.viewer.role,
    id: g.viewer.id,
    nickname: prof?.nickname || null,
    title: prof?.title || null,
    contacts: readContacts(priv?.contacts),
    bio: priv?.bio || null,
    avatar_v: prof?.avatar_v || null,
  });
}

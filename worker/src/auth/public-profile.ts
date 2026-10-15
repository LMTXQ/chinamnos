import type { Env } from '../common/env';

// ─────────────────────────────────────────────────────────────
// 账号系统统一出口：用户公开资料（昵称 / 头衔 / 头像版本）
// ─────────────────────────────────────────────────────────────
// users 表是账号系统基础设施，其他模块（跳蚤市集、工单、me…）展示用户
// 身份信息时一律走这里，禁止各自 SELECT users —— 各查各的字段子集
// 曾导致 /api/auth/me 漏 title 而跳蚤市集有 title 的不一致。
// 新增公开资料字段时只改这里，所有消费方自动同步。
// 注意：contacts 语义各异（本人完整 / 他人仅 pub），不在此出口内。

export interface PublicProfile {
  id: string;
  nickname: string | null;
  title: string | null;
  avatar_v: number | null;
}

/** 单个用户公开资料；不存在返回 null */
export async function getPublicProfile(env: Env, id: string): Promise<PublicProfile | null> {
  const rows = await getPublicProfiles(env, [id]);
  return rows.get(id) || null;
}

/** 批量用户公开资料（去重、最多 100 个/批防滥用）；key = user_id */
export async function getPublicProfiles(env: Env, ids: string[]): Promise<Map<string, PublicProfile>> {
  const uniq = [...new Set(ids.filter(Boolean))];
  const map = new Map<string, PublicProfile>();
  if (!uniq.length) return map;
  for (let i = 0; i < uniq.length; i += 100) {
    const batch = uniq.slice(i, i + 100);
    const ph = batch.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT id, nickname, title, avatar_updated_at FROM users WHERE id IN (${ph})`,
    ).bind(...batch).all<{ id: string; nickname: string | null; title: string | null; avatar_updated_at: number | null }>();
    for (const u of results || []) {
      map.set(u.id, { id: u.id, nickname: u.nickname, title: u.title, avatar_v: u.avatar_updated_at });
    }
  }
  return map;
}

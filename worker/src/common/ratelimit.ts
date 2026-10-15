import type { Env } from './env';

// D1 固定窗口限流桶（§16：KV 免费版不可用，用 rate_buckets 表替代）
// 语义：窗口内前 limit 次放行（limited=false），第 limit+1 次起 limited=true
export async function hitLimit(
  env: Env,
  bucketKey: string,
  limit: number,
  windowSec: number,
): Promise<{ limited: boolean; count: number; resetAt: number }> {
  const now = Date.now();
  const freshReset = now + windowSec * 1000;
  const row = await env.DB.prepare(
    `INSERT INTO rate_buckets (bucket_key, count, reset_at) VALUES (?1, 1, ?2)
     ON CONFLICT(bucket_key) DO UPDATE SET
       count    = CASE WHEN rate_buckets.reset_at < ?3 THEN 1 ELSE rate_buckets.count + 1 END,
       reset_at = CASE WHEN rate_buckets.reset_at < ?3 THEN ?2 ELSE rate_buckets.reset_at END
     RETURNING count, reset_at`,
  )
    .bind(bucketKey, freshReset, now)
    .first<{ count: number; reset_at: number }>();
  const count = row?.count ?? 1;
  return { limited: count > limit, count, resetAt: row?.reset_at ?? freshReset };
}

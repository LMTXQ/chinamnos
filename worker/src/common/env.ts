export interface Env {
  DB: D1Database;
  PROOFS?: R2Bucket;         // 证明材料桶（出让/出租审核照片）
  ALLOWED_ORIGINS?: string;
  PUBLIC_BASE_URL?: string;
  OWNER_EMAIL?: string;
  MAIL_FROM?: string;
  MAIL_DAILY_CAP?: string;
  RESEND_API_KEY?: string;
  CARDHUB_SECRET?: string;
  TURNSTILE_SECRET?: string;  // wrangler secret 写入；未配置则跳过人机校验
  TURNSTILE_SITEKEY?: string; // 公开，前端嵌入用
}

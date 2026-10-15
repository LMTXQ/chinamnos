// 审计日志辅助（0004_admin_audit.sql）：管理端所有写操作统一在此入账。
// 设计要点：
// - actor 信息来自 guard() 解出的 Viewer，不再二次查询；
// - detail_json 只放白名单化的动作参数（拒绝原因、目标值等），不落敏感原文；
// - 入账失败不影响主流程（catch 后仅 console 记录），但会尽力写入。
import type { Env } from './env';
import type { Viewer } from './auth';

/** 单条审计动作定义 */
export interface AuditInput {
  action: string;
  targetType: 'post' | 'user' | 'setting' | 'relay' | 'nav' | 'activity';
  targetId?: string | null;
  detail?: Record<string, unknown>;
}

/** 提取客户端真实 IP（Cloudflare 托管环境下以 CF-Connecting-IP 为准） */
function clientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0].trim() ||
    ''
  );
}

/**
 * 写入一条审计日志。应在成功执行业务写操作之后调用。
 * 例：await audit(env, request, viewer, { action: 'ban_user', targetType: 'user', targetId: uid, detail: { reason } });
 */
export async function audit(
  env: Env,
  request: Request,
  actor: Viewer,
  input: AuditInput,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO audit_logs (actor_id, actor_email, action, target_type, target_id, detail_json, ip, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
      .bind(
        actor.id,
        actor.email,
        input.action,
        input.targetType,
        input.targetId ?? null,
        JSON.stringify(input.detail ?? {}),
        clientIp(request),
        Date.now(),
      )
      .run();
  } catch (e) {
    // 审计失败不阻断业务，但保留痕迹便于排查
    console.error('audit_log_failed', input.action, e instanceof Error ? e.message : e);
  }
}

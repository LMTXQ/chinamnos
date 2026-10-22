import type { Env } from '../common/env';

/* ── 青龙 OpenAPI 客户端（站外通知推送方案 C-2）──
   职责：把 payload 行数组写入青龙脚本目录并触发分发任务。
   实测 API 形状（该面板为改版，与官方文档有差异，均已逐条验证）：
     ① token：GET /open/auth/token?client_id=&client_secret= → {code:200, data:{token}}
     ② 写脚本：POST /open/scripts {filename, content}（已存在自动覆盖）
     ③ 找任务：GET /open/crons?searchValue=<名称> → data.data[0].id（数字）
     ④ 触发：PUT /open/crons/run，body 为裸数字数组 [taskId]（不是 {id:[…]}！）

   payload 文件落在青龙 scripts/chinamnos/ 目录（与 notify_dispatch.py 同目录），
   文件即队列：notify_dispatch.py 扫描消化后删除，失败遗留自动补扫。 */

export interface PayloadRow {
  nid: string;            // 稳定去重键：`${kind}:${refId}:${channel_type}`
  uid: string;
  kind: string;
  title: string;
  body: string;
  channel_type: string;
  cred?: Record<string, string>; // webhook/token 类渠道凭证（已解密）
  email_target?: string;         // 仅 email 行：收件邮箱
}

const TASK_NAME = '站外通知分发';
const RETRY_DELAY_MS = 1500;

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let err: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      err = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  throw err;
}

/* 写入 payload 文件并触发分发任务。失败已重试后仍抛错由调用方记账（铃铛已落库，不影响主流程） */
export async function qlDispatchPayload(env: Env, filename: string, rows: PayloadRow[]): Promise<void> {
  const base = (env.QL_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !env.QL_CLIENT_ID || !env.QL_CLIENT_SECRET) {
    throw new Error('青龙 OpenAPI 未配置（QL_BASE_URL / QL_CLIENT_ID / QL_CLIENT_SECRET）');
  }

  await withRetry(async () => {
    // ① token（每次现取，不缓存）
    const tRes = await fetch(`${base}/open/auth/token?client_id=${env.QL_CLIENT_ID}&client_secret=${env.QL_CLIENT_SECRET}`);
    const t = (await tRes.json()) as { code: number; data?: { token: string } };
    if (t.code !== 200 || !t.data?.token) throw new Error(`token 获取失败: ${JSON.stringify(t).slice(0, 120)}`);
    const H = { Authorization: `Bearer ${t.data.token}`, 'Content-Type': 'application/json' };

    // ② 写 payload 文件（必须带 chinamnos/ 目录前缀：分发脚本只扫描 scripts/chinamnos/ 下的 batch_*.json，
    //    裸文件名会落到 scripts/ 根目录成为孤儿——脚本永远扫不到，且不报任何错）
    const wRes = await fetch(`${base}/open/scripts`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ filename: `chinamnos/${filename}`, content: JSON.stringify(rows) }),
    });
    const w = (await wRes.json()) as { code: number; message?: string };
    if (w.code !== 200) throw new Error(`payload 写入失败: ${JSON.stringify(w).slice(0, 120)}`);

    // ③ 按名称找分发任务
    const cRes = await fetch(`${base}/open/crons?searchValue=${encodeURIComponent(TASK_NAME)}`, { headers: H });
    const c = (await cRes.json()) as { code: number; data?: { data?: Array<{ id: number }> } };
    const taskId = c.data?.data?.[0]?.id;
    if (!taskId) throw new Error(`未找到分发任务「${TASK_NAME}」`);

    // ④ 触发（body 为裸数组）
    const rRes = await fetch(`${base}/open/crons/run`, { method: 'PUT', headers: H, body: JSON.stringify([taskId]) });
    const r = (await rRes.json()) as { code: number; message?: string };
    if (r.code !== 200) throw new Error(`任务触发失败: ${JSON.stringify(r).slice(0, 120)}`);
  });
}

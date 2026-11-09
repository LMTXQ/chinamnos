#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════
 *  chinamnos 更新执行器（青龙面板用 · Node 版）
 *
 *  作用：从 GitHub 拉取最新 chinamnos.py 与 qinglong/ 下的通知分发脚本
 *        （notify_dispatch.py + qq_text_render.py）到统一工作目录，校验通过后执行；
 *        通知分发脚本下载失败仅告警，不阻塞采集。
 *
 *  ── 启动方式（二选一，自动判定）──
 *  A. 解耦模式（推荐）：配好 TARIFF_CONFIG.notification.ql_trigger（配置页生成，
 *     = {url?, client_id, client_secret, task_name?, task_id?, autocreate?}，
 *     或等价的 QL_* 环境变量），本任务只做脚本同步，随后经面板 OpenAPI 触发
 *     「独立采集任务」运行 chinamnos.py——采集有自己的日志/耗时/运行状态，
 *     同步器自身秒级结束不占长任务线程。
 *     目标任务找不到时自动创建（schedule 用「@once」＝面板唯一接受的非周期写法）。
 *  B. 内联模式（兼容旧行为）：未配置上述凭证，或本次运行带了参数（--rebuild-stats 等
 *     手动特殊操作）→ 同步后在本任务内直接运行采集，参数原样透传。
 *
 *  ── 为什么用 JS ──
 *  bash 版需要 heredoc 起 python 子进程发请求，青龙面板按「主进程退出」判定任务结束，
 *  子进程/文件描述符继承会让面板误判为仍在运行。Node 版全程单进程：
 *  HTTP 用内置 http/https，不 fork、不起子 shell；仅在「内联执行采集」时 spawn 一次
 *  python3（那是真实业务需要），并等待其 exit 事件后再退出。
 *
 *  青龙任务命令示例（参数原样透传给 chinamnos.py）：
 *    task chinamnos_updater.js                     → 完整采集（解耦模式下触发独立任务）
 *    task chinamnos_updater.js --rebuild-stats     → 重建统计（内联执行）
 *    task chinamnos_updater.js --announce-only     → 仅公告采集（内联执行）
 *    task chinamnos_updater.js --deploy-frontend   → 仅部署前端（内联执行）
 *    SKIP_UPDATE=1 task chinamnos_updater.js       → 跳过更新直接执行
 * ═══════════════════════════════════════════════════════════════════
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { spawn } = require('child_process');

const REPO = 'LMTXQ/chinamnos';
const BRANCH = 'master';
const FILE = 'chinamnos.py';
const MARKER = '__main__';            // 完整性标记：下载后须含入口标记
const PY = process.env.PYTHON || 'python3';
const NFILES = ['notify_dispatch.py', 'qq_text_render.py'];
const REQ_TIMEOUT = 12000;            // 单文件下载/单次 API 请求超时
const RUN_TIMEOUT = 60000;            // 触发流程总超时

const URL_BASES = [
  `https://raw.githubusercontent.com/${REPO}/${BRANCH}`,
  `https://ghproxy.net/https://raw.githubusercontent.com/${REPO}/${BRANCH}`,
  `https://gh-proxy.com/https://raw.githubusercontent.com/${REPO}/${BRANCH}`,
];

// ── 输出：直接写 stdout，行尾统一 LF；面板按行收集日志 ──
function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════════════
//  工作目录：优先 TARIFF_CONFIG.notification.digest_dir
// ═══════════════════════════════════════════════════════════════════
function resolveWorkdir() {
  const scriptDir = __dirname;
  let configured = '';
  try {
    const cfg = JSON.parse(process.env.TARIFF_CONFIG || '{}');
    const d = cfg && cfg.notification && cfg.notification.digest_dir;
    if (typeof d === 'string') configured = d.trim();
  } catch {
    /* TARIFF_CONFIG 非法 JSON 时静默忽略，回退脚本目录 */
  }
  if (!configured) return { dir: scriptDir, configured: false };

  try {
    fs.mkdirSync(configured, { recursive: true });
    fs.accessSync(configured, fs.constants.W_OK);
    log(`[目录] 统一工作目录: ${configured}（notification.digest_dir，chinamnos.py 将下载到此处）`);
    return { dir: configured, configured: true };
  } catch {
    log(`[目录] ⚠ 配置目录不可用(${configured})，回退脚本所在目录: ${scriptDir}`);
    return { dir: scriptDir, configured: false };
  }
}

// ═══════════════════════════════════════════════════════════════════
//  HTTP：内置 http/https，不引入第三方依赖
// ═══════════════════════════════════════════════════════════════════

/**
 * 单次 HTTP 请求，返回 { status, body(Buffer) }。
 * - timeout：连接+读取的总时长上限，超时立即 destroy，绝不悬挂
 * - 显式 Connection: close，读完即销毁 socket
 */
function request(urlStr, opts = {}) {
  const { method = 'GET', headers = {}, body = null, timeout = REQ_TIMEOUT } = opts;
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      reject(new Error(`URL 非法: ${urlStr}`));
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      u,
      { method, headers: { 'Connection': 'close', ...headers }, timeout },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          res.destroy();
          resolve({ status: res.statusCode, body: Buffer.concat(chunks) });
        });
        res.on('error', reject);
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error(`请求超时(${timeout}ms): ${urlStr}`));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 下载文件到磁盘，返回 true/false（不抛异常） */
async function download(url, dest) {
  const { status, body } = await request(url);
  if (status !== 200) throw new Error(`HTTP ${status}`);
  fs.writeFileSync(dest, body);
  return true;
}

/** 多源依次尝试下载（每源 3 次重试，间隔 2s）。relPath 为仓库内相对路径 */
async function downloadFromAny(relPath, dest) {
  for (const base of URL_BASES) {
    const url = `${base}/${relPath}`;
    log(`[更新] 尝试下载: ${url}`);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await download(url, dest);
        return base;
      } catch (e) {
        if (attempt < 3) {
          log(`[更新]   第 ${attempt} 次失败(${e.message})，2s 后重试...`);
          await sleep(2000);
        }
      }
    }
    try {
      fs.unlinkSync(dest);
    } catch {
      /* 清理失败无需处理 */
    }
    log('[更新] 该源不可用，切换下一个');
  }
  return '';
}

/** 用 python3 -m py_compile 校验语法（仅校验，不执行）；不可用时退化为关键字检查 */
function pySyntaxOk(file) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    // 语法校验也走 spawn，但显式忽略 stdin、输出丢弃，且 await 其退出
    const p = spawn(PY, ['-m', 'py_compile', file], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, PYTHONPYCACHEPREFIX: path.join(path.dirname(file), 'temp', 'pycache') },
    });
    const timer = setTimeout(() => {
      try {
        p.kill('SIGKILL');
      } catch {
        /* 进程可能已退出 */
      }
      done(false);
    }, 20000);
    p.on('error', () => done(checkMarkerFallback(file)));   // 环境无 python3：退化为只检查入口标记
    p.on('exit', (code) => done(code === 0));
  });
}

function checkMarkerFallback(file) {
  try {
    return fs.readFileSync(file, 'utf8').includes(MARKER);
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  青龙 OpenAPI
// ═══════════════════════════════════════════════════════════════════
function qlConfig() {
  let ql = {};
  try {
    const cfg = JSON.parse(process.env.TARIFF_CONFIG || '{}');
    const q = cfg && cfg.notification && cfg.notification.ql_trigger;
    if (q && typeof q === 'object') ql = q;
  } catch {
    /* 忽略 */
  }
  const pick = (v, envKey, dflt = '') => {
    const s = v !== undefined && v !== null && v !== '' ? String(v) : (process.env[envKey] || '');
    return s.trim() || dflt;
  };
  const base = pick(ql.url, 'QL_URL', 'http://localhost:5700').replace(/\/+$/, '');
  const cid = pick(ql.client_id, 'QL_CLIENT_ID');
  const secret = pick(ql.client_secret, 'QL_CLIENT_SECRET');
  const taskName = pick(ql.task_name, 'QL_TASK_NAME', 'ChinaMNOs 采集');
  const taskId = pick(ql.task_id, 'QL_TASK_ID');
  let autocreate;
  if (ql.autocreate !== undefined) autocreate = Boolean(ql.autocreate);
  else autocreate = !['0', 'false', 'no', 'off'].includes(String(process.env.QL_AUTOCREATE || '1').trim().toLowerCase());
  return { base, cid, secret, taskName, taskId, autocreate, fromConfig: Object.keys(ql).length > 0 };
}

/** 统一 OpenAPI 调用：返回响应体的 data 字段 */
async function qlReq(ctx, method, apiPath, payload, token, query) {
  const url = `${ctx.base}${apiPath}${query ? `?${query}` : ''}`;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const body = payload === undefined ? null : Buffer.from(JSON.stringify(payload), 'utf8');
  const { status, body: buf } = await request(url, { method, headers, body });
  let d;
  try {
    d = JSON.parse(buf.toString('utf8') || '{}');
  } catch {
    throw new Error(`${method} ${apiPath} 响应非 JSON（HTTP ${status}）`);
  }
  if (d.code !== 200) {
    throw new Error(`${method} ${apiPath} -> ${JSON.stringify(d).slice(0, 200)}`);
  }
  return d.data;
}

/** 解耦触发：取 token → 找/建任务 → 触发运行。成功返回 0，失败返回 1，未配置返回 2 */
async function triggerDecoupled(ctx, workdir) {
  const started = Date.now();
  if (!ctx.cid || !ctx.secret) {
    log('[触发] 未配置解耦触发凭证，回退内联执行');
    return 2;
  }
  log(`[触发] 解耦模式：经面板 OpenAPI 启动独立采集任务（来源: ${ctx.fromConfig ? 'TARIFF_CONFIG.notification.ql_trigger' : 'QL_* 环境变量'}）`);

  const limit = new Promise((_, rej) =>
    setTimeout(() => rej(new Error(`触发流程总超时(${RUN_TIMEOUT}ms)`)), RUN_TIMEOUT).unref()
  );

  const run = async () => {
    const tok = await qlReq(
      ctx, 'GET', '/open/auth/token', undefined, null,
      `client_id=${encodeURIComponent(ctx.cid)}&client_secret=${encodeURIComponent(ctx.secret)}`
    );
    const token = tok && tok.token;
    if (!token) throw new Error('auth/token 响应缺少 token');

    const listTasks = async () => {
      const r = (await qlReq(ctx, 'GET', '/open/crons', undefined, token, `searchValue=${encodeURIComponent(ctx.taskName)}`)) || {};
      return r.data || [];
    };

    let tid = 0;
    if (ctx.taskId) {
      tid = parseInt(ctx.taskId, 10) || 0;
    } else {
      const cands = (await listTasks()).filter(
        (t) => String(t.command || '').includes('chinamnos.py') && !String(t.command || '').includes('chinamnos_updater')
      );
      if (cands.length) tid = cands[0].id || cands[0]._id || 0;
    }

    if (!tid && ctx.autocreate) {
      const cmd = `task "${path.join(workdir, 'chinamnos.py')}"`;
      const created = (await qlReq(ctx, 'POST', '/open/crons', { name: ctx.taskName, command: cmd, schedule: '@once' }, token)) || {};
      tid = created.id || created._id || 0;
      if (!tid) {
        const hit = (await listTasks()).find((t) => String(t.name || '') === ctx.taskName);
        tid = hit ? hit.id || hit._id || 0 : 0;
      }
      if (tid) log(`[触发] 已自动创建独立采集任务 #${tid}（永不定时，仅 API 触发）：${cmd}`);
    }

    if (!tid) throw new Error(`未找到目标任务（task_name=${ctx.taskName}）且 autocreate 未开启`);

    await qlReq(ctx, 'PUT', '/open/crons/run', [Number(tid)], token);
    log(`[触发] ✓ 已请求面板运行采集任务 #${tid}，本同步任务结束（耗时 ${Date.now() - started}ms）`);
  };

  try {
    await Promise.race([run(), limit]);
    return 0;
  } catch (e) {
    log(`[触发] ✗ 失败：${String(e.message || e).slice(0, 200)}`);
    log('[触发] 提示：先核对 TARIFF_CONFIG.notification.ql_trigger 的 url/client_id/client_secret'
      + '（可 curl /open/auth/token 验证）；接口路径须为 /open/crons*，应用需勾选「任务管理」权限。');
    return 1;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  内联执行采集（参数原样透传）
// ═══════════════════════════════════════════════════════════════════
function runPython(file, args, cwd) {
  return new Promise((resolve) => {
    log(`[执行] ${PY} ${file} ${args.join(' ')}`.trimEnd());
    const child = spawn(PY, [file, ...args], {
      cwd,
      stdio: ['ignore', 'inherit', 'inherit'],   // stdin 断开，输出直连父进程
      env: { ...process.env, PYTHONPYCACHEPREFIX: path.join(cwd, 'temp', 'pycache') },
    });
    child.on('error', (e) => {
      log(`[执行] ✗ 无法启动 ${PY}: ${e.message}`);
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      if (signal) log(`[执行] ⚠ 被信号终止: ${signal}`);
      resolve(code === null ? 1 : code);
    });
  });
}

// ═══════════════════════════════════════════════════════════════════
//  主流程
// ═══════════════════════════════════════════════════════════════════
async function main() {
  const { dir: workdir } = resolveWorkdir();
  process.chdir(workdir);
  fs.mkdirSync(path.join(workdir, 'temp', 'pycache'), { recursive: true });
  process.env.PYTHONPYCACHEPREFIX = path.join(workdir, 'temp', 'pycache');

  // ── 参数：只认 -- 开头的真实参数（--rebuild-stats 等）；位置参数忽略 ──
  // 改版面板 task 执行器会把脚本路径本身作为 argv[2] 传入，不能用 argv.length 判断
  const args = process.argv.slice(2).filter((a) => a !== __filename && !a.endsWith('chinamnos_updater.js'));
  const hasFlag = args.some((a) => a.startsWith('--'));

  // ── 更新阶段 ──
  if (process.env.SKIP_UPDATE !== '1') {
    const tmp = path.join(workdir, 'temp');
    const newFile = path.join(tmp, `${FILE}.new`);
    const okBase = await downloadFromAny(FILE, newFile);

    if (okBase && checkMarkerFallback(newFile) && (await pySyntaxOk(newFile))) {
      const target = path.join(workdir, FILE);
      if (fs.existsSync(target)) fs.copyFileSync(target, path.join(tmp, `${FILE}.bak`));
      fs.renameSync(newFile, target);
      log(`[更新] ✓ 已更新 ${FILE}（来源: ${okBase}/${FILE}，旧版备份为 temp/${FILE}.bak）`);
    } else {
      try {
        fs.unlinkSync(newFile);
      } catch {
        /* 文件可能不存在 */
      }
      if (fs.existsSync(path.join(workdir, FILE))) {
        log(`[更新] ✗ 全部下载源失败，使用本地现有 ${FILE} 继续执行`);
      } else {
        log(`[更新] ✗ 下载失败且本地无 ${FILE}，终止`);
        return 1;
      }
    }

    // ── notify_dispatch.py 及其同目录模块同步（失败仅告警，不阻塞采集）──
    for (const nf of NFILES) {
      const nfNew = path.join(tmp, `${nf}.new`);
      const base = await downloadFromAny(`qinglong/${nf}`, nfNew);
      if (base && (await pySyntaxOk(nfNew))) {
        const cur = path.join(workdir, nf);
        if (fs.existsSync(cur) && fs.readFileSync(cur).equals(fs.readFileSync(nfNew))) {
          fs.unlinkSync(nfNew);
          log(`[更新] ✓ ${nf} 已是最新`);
        } else {
          if (fs.existsSync(cur)) fs.copyFileSync(cur, path.join(tmp, `${nf}.bak`));
          fs.renameSync(nfNew, cur);
          log(`[更新] ✓ 已更新 ${nf}（来源: ${base}/qinglong/${nf}）`);
        }
      } else {
        try {
          fs.unlinkSync(nfNew);
        } catch {
          /* 文件可能不存在 */
        }
        log(`[更新] ⚠ ${nf} 全部源下载/校验失败，沿用现有版本继续`);
      }
    }
  } else {
    log('[更新] SKIP_UPDATE=1，跳过更新');
  }

  // ── 启动：解耦 / 内联 ──
  if (!hasFlag) {
    const rc = await triggerDecoupled(qlConfig(), workdir);
    if (rc === 0) {
      log('[完成] 采集已交由独立任务执行（面板可查看其日志与状态）');
      return 0;
    }
    if (rc === 2) {
      log('[触发] 未配置解耦触发凭证，回退内联执行');
    } else {
      log('[触发] ⚠ 回退内联执行（不影响本次采集）');
    }
  }

  const rc = await runPython(path.join(workdir, FILE), args, workdir);
  log(`[完成] 执行结束（exit=${rc}）`);
  return rc;
}

main()
  .then((code) => {
    process.exit(code || 0);
  })
  .catch((e) => {
    log(`[致命] ${e && e.message ? e.message : e}`);
    if (e && e.stack) log(e.stack);
    process.exit(1);
  });

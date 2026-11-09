#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  chinamnos 更新执行器（青龙面板用 · Bash 版）
#
#  ⚠ 已被 chinamnos_updater.js 取代，建议改用 Node 版：
#    功能/参数/环境变量完全一致，但整条链路压成单进程（不 fork python3、不 fork curl），
#    可规避部分青龙部署下「日志已打印、脚本已结束，面板仍显示执行中」的问题。
#    本文件保留仅为兼容旧任务，不再新增功能。
#
#  作用：从 GitHub 拉取最新 chinamnos.py 与 qinglong/ 下的通知分发脚本
#        （notify_dispatch.py + qq_text_render.py）到统一工作目录，校验通过后执行；
#        通知分发脚本下载失败仅告警，不阻塞采集
#  一次上传本文件到青龙后，无需再手动同步脚本
#
#  ── 启动方式（二选一，自动判定）──
#  A. 解耦模式（推荐）：配好 TARIFF_CONFIG.notification.ql_trigger（配置页生成，
#     = {url?, client_id, client_secret, task_name?, task_id?, autocreate?}，
#     或等价的 QL_* 环境变量），本任务只做脚本同步，随后经面板 OpenAPI 触发
#     「独立采集任务」运行 chinamnos.py——采集有自己的日志/耗时/运行状态，
#     同步器自身秒级结束不占长任务线程。
#     目标任务找不到时自动创建（schedule 用「@once」＝面板唯一接受的非周期写法，
#     不会自行定时运行，只由 API/手动触发；空 schedule 或 2 月 31 日之类会被
#     面板以「无效的定时规则」拒绝）。
#  B. 内联模式（兼容旧行为）：未配置上述凭证，或本次运行带了参数（--rebuild-stats 等
#     手动特殊操作）→ 同步后在本任务内直接 exec 采集，参数原样透传。
#
#  青龙任务命令示例（参数原样透传给 chinamnos.py）：
#    task chinamnos_updater.sh                     → 完整采集（解耦模式下触发独立任务）
#    task chinamnos_updater.sh --rebuild-stats     → 重建统计（内联执行）
#    task chinamnos_updater.sh --announce-only     → 仅公告采集（内联执行）
#    task chinamnos_updater.sh --deploy-frontend   → 仅部署前端（内联执行）
#    SKIP_UPDATE=1 task chinamnos_updater.sh       → 跳过更新直接执行
# ═══════════════════════════════════════════════════════════════════
set -u
cd "$(dirname "$0")"

REPO="LMTXQ/chinamnos"
BRANCH="master"
FILE="chinamnos.py"
MARKER="__main__"   # 完整性标记：下载后须含入口标记，且语法编译通过
PY=python3

# ── 统一工作目录（采集播报方案批次一）──
# 优先读取 TARIFF_CONFIG 的 notification.digest_dir（配置页「通知渠道」组「分发脚本目录」）：
# 有值且目录可用 → 下载 chinamnos.py 到该目录并在此执行（与 notify_dispatch.py、digest 文件同目录）；
# 无值 / 解析失败 / 建目录失败 → 打印提示并回退本脚本所在目录（与旧行为完全一致）
WORKDIR=""
if [ -n "${TARIFF_CONFIG:-}" ]; then
  WORKDIR=$($PY -c 'import json,os; d=json.loads(os.environ.get("TARIFF_CONFIG","{}")).get("notification",{}).get("digest_dir",""); print(d.strip() if isinstance(d,str) else "")' 2>/dev/null || true)
fi
if [ -n "$WORKDIR" ]; then
  if mkdir -p "$WORKDIR" 2>/dev/null && cd "$WORKDIR" 2>/dev/null; then
    echo "[目录] 统一工作目录: $WORKDIR（notification.digest_dir，chinamnos.py 将下载到此处）"
  else
    echo "[目录] ⚠ 配置目录不可用($WORKDIR)，回退脚本所在目录: $(pwd)"
  fi
fi

# ── temp/ 临时产物子目录（随时可删）：.new 下载中文件、.bak 上一版备份、pycache 字节码缓存──
# 工作目录根只留代码（+ queue/ 货单队列，由采集端/分发端维护）；PYTHONPYCACHEPREFIX 让
# py_compile 校验与 python 执行的字节码统一写进 temp/pycache，杜绝 __pycache__ 散落根目录
mkdir -p temp/pycache 2>/dev/null
export PYTHONPYCACHEPREFIX="$PWD/temp/pycache"

# 多源基址依次尝试：直连 → 两个常见加速镜像（文件路径拼在基址后）
URL_BASES=(
  "https://raw.githubusercontent.com/$REPO/$BRANCH"
  "https://ghproxy.net/https://raw.githubusercontent.com/$REPO/$BRANCH"
  "https://gh-proxy.com/https://raw.githubusercontent.com/$REPO/$BRANCH"
)

NFILES=("notify_dispatch.py" "qq_text_render.py")   # 采集播报分发脚本 + 其同目录排版模块（仓库 qinglong/ 目录）

fetch() { # $1=URL $2=输出文件
  # </dev/null：子进程不继承任务的 stdin 管道，避免其持有管道写端导致面板判定任务未结束
  # 重试：共 3 次尝试，失败间隔 2 秒，覆盖 SSL_ERROR_SYSCALL / 瞬时握手抖动
  local url="$1" out="$2" attempt=0
  while [ $attempt -lt 3 ]; do
    attempt=$((attempt + 1))
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL --connect-timeout 8 --max-time 60 -o "$out" "$url" </dev/null && return 0
    else
      wget -qO "$out" --timeout=60 "$url" </dev/null && return 0
    fi
    if [ $attempt -lt 3 ]; then
      echo "[更新]   第 ${attempt} 次失败，2s 后重试..."
      sleep 2
    fi
  done
  return 1
}

if [ "${SKIP_UPDATE:-0}" != "1" ]; then
  ok=""
  for b in "${URL_BASES[@]}"; do
    u="$b/$FILE"
    echo "[更新] 尝试下载: $u"
    if fetch "$u" "temp/$FILE.new" \
       && grep -q "$MARKER" "temp/$FILE.new" </dev/null \
       && $PY -m py_compile "temp/$FILE.new" 2>/dev/null </dev/null; then
      ok="$b"
      break
    fi
    rm -f "temp/$FILE.new"
    echo "[更新] 该源不可用，切换下一个"
  done

  if [ -n "$ok" ]; then
    [ -f "$FILE" ] && cp -f "$FILE" "temp/$FILE.bak"   # 保留上一版便于回滚
    mv -f "temp/$FILE.new" "$FILE"
    echo "[更新] ✓ 已更新 $FILE（来源: $ok/$FILE，旧版备份为 temp/$FILE.bak）"
  else
    if [ -f "$FILE" ]; then
      echo "[更新] ✗ 全部下载源失败，使用本地现有 $FILE 继续执行"
    else
      echo "[更新] ✗ 下载失败且本地无 $FILE，终止"
      exit 1
    fi
  fi

  # ── notify_dispatch.py 及其同目录模块同步（失败仅告警，不阻塞采集）──
  # QQTEXT-1 需求内容：同步 qq_text_render.py（notify_dispatch 的同目录辅助模块），否则线上 import 失败、全角表格不生效
  # QQTEXT-1 改动说明：单文件同步改为 NFILES 循环，逐个下载/语法校验/备份替换，任一失败只告警
  if [ -n "$ok" ]; then
    for NF in "${NFILES[@]}"; do
      nf_ok=""
      for b in "${URL_BASES[@]}"; do
        NURL="$b/qinglong/$NF"
        echo "[更新] 尝试下载: $NURL"
        if fetch "$NURL" "temp/$NF.new" \
           && $PY -m py_compile "temp/$NF.new" 2>/dev/null </dev/null; then
          nf_ok="$b"
          break
        fi
        rm -f "temp/$NF.new"
        echo "[更新] 该源不可用，切换下一个"
      done
      if [ -n "$nf_ok" ]; then
        if [ -f "$NF" ] && cmp -s "$NF" "temp/$NF.new"; then
          rm -f "temp/$NF.new"
          echo "[更新] ✓ $NF 已是最新"
        else
          [ -f "$NF" ] && cp -f "$NF" "temp/$NF.bak"   # 保留上一版便于回滚
          mv -f "temp/$NF.new" "$NF"
          echo "[更新] ✓ 已更新 $NF（来源: $nf_ok/qinglong/$NF）"
        fi
      else
        rm -f "temp/$NF.new"
        echo "[更新] ⚠ $NF 全部源下载/校验失败，沿用现有版本继续"
      fi
    done
  else
    echo "[更新] ⚠ chinamnos.py 未更新成功，跳过 ${NFILES[*]} 同步"
  fi
else
  echo "[更新] SKIP_UPDATE=1，跳过更新"
fi


# ═══════════════════════════════════════════════════════════════════
#  启动：解耦模式（OpenAPI 触发独立采集任务）或内联模式（本任务内执行）
#  凭证/参数来源（优先级从高到低）：
#    1. TARIFF_CONFIG.notification.ql_trigger（配置页「通知类型开关」面板生成，推荐）
#       = {url, client_id, client_secret, task_name?, task_id?, autocreate?}
#    2. 独立环境变量：QL_URL / QL_CLIENT_ID / QL_CLIENT_SECRET /
#       QL_TASK_NAME / QL_TASK_ID / QL_AUTOCREATE
#    默认值：url=http://localhost:5700  task_name="ChinaMNOs 采集"  autocreate=true
#  触发失败（OpenAPI 未开/凭证错/网络问题）自动回退内联执行，采集永不因此中断。
#  注意：目标任务与同步任务若同时运行，靠 chinamnos.py 自身逻辑兜底（与旧行为一致）。
# ═══════════════════════════════════════════════════════════════════
DIR_ABS=$(pwd)
# 内联判定只认 `--` 开头的真实参数（--rebuild-stats 等）；位置参数一律忽略——
# 改版面板 task 执行器会把脚本路径本身作为 $1 传入（如 chinamnos/chinamnos_updater.sh），
# 不能用 [ $# -eq 0 ] 判断，否则解耦模式永远被误杀成内联
_HAS_FLAG=0
for _a in "$@"; do
  case "$_a" in --*) _HAS_FLAG=1 ;; esac
done
if [ "$_HAS_FLAG" = 0 ]; then
  QL_URL="${QL_URL:-http://localhost:5700}" \
    CHINAMNOS_WORKDIR="$DIR_ABS" \
    $PY - <<'PYEOF'
import json
import os
import signal
import sys
import urllib.parse
import urllib.request

WORKDIR = os.environ.get("CHINAMNOS_WORKDIR", ".")

# 单次 OpenAPI 请求总超时（秒）：只管「叫醒别人」这一件事，不需要等很久。
# 面板偶发只回响应头不结束 body 时，旧代码会无限阻塞 → 任务一直显示「执行中」。
REQ_TIMEOUT = 12
# 整个触发流程总超时（秒）：取token + 查任务 + 建任务 + 触发，四步合计上限。
RUN_TIMEOUT = 40

# 凭证/参数解析：TARIFF_CONFIG.notification.ql_trigger 优先，QL_* 环境变量兜底
def _ql_cfg():
    try:
        raw = os.environ.get("TARIFF_CONFIG") or ""
        n = (json.loads(raw).get("notification") or {})
        q = n.get("ql_trigger")
        return q if isinstance(q, dict) else {}
    except Exception:
        return {}


def _pick(cfg_v, env_k, default=""):
    v = cfg_v if cfg_v not in (None, "") else os.environ.get(env_k, "")
    v = str(v).strip() if v is not None else ""
    return v or default


_q = _ql_cfg()
BASE = _pick(_q.get("url"), "QL_URL", "http://localhost:5700").rstrip("/")
CID = _pick(_q.get("client_id"), "QL_CLIENT_ID")
SECRET = _pick(_q.get("client_secret"), "QL_CLIENT_SECRET")
TASK_NAME = _pick(_q.get("task_name"), "QL_TASK_NAME", "ChinaMNOs 采集")
TASK_ID = _pick(_q.get("task_id"), "QL_TASK_ID")
if "autocreate" in _q:
    AUTOCREATE = bool(_q.get("autocreate"))
else:
    AUTOCREATE = str(os.environ.get("QL_AUTOCREATE", "1")).strip().lower() not in ("0", "false", "no", "off")

if not CID or not SECRET:
    # 未配置解耦触发：静默回退内联执行（退出码 2）
    sys.exit(2)


def req(method, path, payload=None, token=None, qs=""):
    """单次 OpenAPI 调用。

    urlopen(timeout=) 只管单次 socket 操作，不是总时长；面板偶发只发头部不结束响应体时，
    json.load 会一直阻塞，脚本就卡在这里不退——面板随即一直显示「执行中」。
    所以这里 read() 一次性读尽 body 再解析，慢/半死连接交给外层 RUN_TIMEOUT 总兜底。
    """
    url = BASE + path + (("?%s" % qs) if qs else "")
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Content-Type": "application/json", "Connection": "close"}
    if token:
        headers["Authorization"] = "Bearer " + token

    # 不在 req 内设置 signal.alarm：那会覆盖并清掉外层「总超时」，导致总超时失效。
    # 单请求靠 urlopen 的 socket 超时兜底（连接/读取各自触发），整体靠外层 RUN_TIMEOUT 兜底。
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(r, timeout=REQ_TIMEOUT) as resp:
        # read() 读尽整个 body（不依赖 json.load 的增量解析），确保连接可正常收尾
        raw = resp.read()
    d = json.loads(raw.decode("utf-8", "replace") or "{}")
    if d.get("code") != 200:
        raise RuntimeError("%s %s -> %s" % (method, path, json.dumps(d, ensure_ascii=False)[:200]))
    return d.get("data")


def _run_alarm(_sig, _frm):
    raise TimeoutError("触发流程总超时(%ds)" % RUN_TIMEOUT)


try:
    # 整个触发流程总兜底：即使某个环节卡在非 socket 位置（DNS、连接池、面板慢查询），
    # 也保证在 RUN_TIMEOUT 内退出，绝不把「执行中」状态一直挂住
    if hasattr(signal, "SIGALRM"):
        signal.signal(signal.SIGALRM, _run_alarm)
        signal.alarm(RUN_TIMEOUT)
    print("[触发] 解耦模式：经面板 OpenAPI 启动独立采集任务（来源: %s）"
          % ("TARIFF_CONFIG.notification.ql_trigger" if _q else "QL_* 环境变量"))
    tok = req("GET", "/open/auth/token",
              qs="client_id=%s&client_secret=%s" % (urllib.parse.quote(CID), urllib.parse.quote(SECRET)))
    token = (tok or {}).get("token")
    if not token:
        raise RuntimeError("auth/token 响应缺少 token")

    # 任务表接口是 /open/crons（响应形状 {code:200, data:{data:[{id,name,command,...}]}}）；
    # 该改版面板没有 /open/tasks* 路由（未知路径同样回 401，与「未带令牌」表现一致）。
    # 关键：除取 token 外，每个请求都必须显式传 token=token，否则一律 401。
    def _list_tasks():
        # req() 已返回响应体的 data 字段（形状 {data:[...]}），这里只需再取一层
        r = req("GET", "/open/crons",
                qs="searchValue=%s" % urllib.parse.quote(TASK_NAME), token=token) or {}
        return r.get("data") or []

    tid = 0
    if TASK_ID:
        tid = int(TASK_ID)
    else:
        # 目标特征：命令含 chinamnos.py 且非本更新器（避免把同步任务自己再拉起来）
        cands = [t for t in _list_tasks()
                 if "chinamnos.py" in str(t.get("command") or "")
                 and "chinamnos_updater" not in str(t.get("command") or "")]
        if cands:
            tid = cands[0].get("id") or cands[0].get("_id") or 0

    if not tid and AUTOCREATE:
        # 面板执行器会改写命令里的裸 `cd`（实测 cd 后 pwd 变成 /ql），
        # 所以不能用 `cd WORKDIR && python3 chinamnos.py`；改用面板原生 `task <脚本绝对路径>`。
        cmd = 'task "%s/chinamnos.py"' % WORKDIR
        new = req("POST", "/open/crons",
                  {"name": TASK_NAME, "command": cmd, "schedule": "@once"},
                  token=token) or {}
        tid = new.get("id") or new.get("_id") or 0
        if not tid:
            # 创建接口若未回传 id，回查一次，避免绑定具体响应形状
            hit = [t for t in _list_tasks() if str(t.get("name") or "") == TASK_NAME]
            tid = (hit[0].get("id") or hit[0].get("_id") or 0) if hit else 0
        if tid:
            print("[触发] 已自动创建独立采集任务 #%s（永不定时，仅 API 触发）：%s" % (tid, cmd))

    if not tid:
        raise RuntimeError("未找到目标任务（task_name=%s）且 autocreate 未开启" % TASK_NAME)

    req("PUT", "/open/crons/run", [int(tid)], token=token)
    print("[触发] ✓ 已请求面板运行采集任务 #%s，本同步任务结束" % tid)
    sys.stdout.flush()
    # 触发完即走：取消总超时，os._exit 不给解释器留任何等待/GC 的机会
    if hasattr(signal, "SIGALRM"):
        signal.alarm(0)
    os._exit(0)
except Exception as e:
    print("[触发] ✗ 失败：%s" % str(e)[:200])
    print("[触发] 提示：先核对 TARIFF_CONFIG.notification.ql_trigger 的 url/client_id/client_secret"
          "（可直接 curl /open/auth/token 验证）；接口路径须为 /open/crons*，"
          "应用需勾选「任务管理」权限。")
    sys.stdout.flush()
    if hasattr(signal, "SIGALRM"):
        signal.alarm(0)
    os._exit(1)
PYEOF
  _trig=$?
  case $_trig in
    0)
      echo "[完成] 采集已交由独立任务执行（面板可查看其日志与状态）"
      exit 0
      ;;
    2)
      echo "[触发] 未配置解耦触发凭证，回退内联执行"
      ;;
    *)
      echo "[触发] ⚠ 回退内联执行（不影响本次采集）"
      ;;
  esac
fi

echo "[执行] $PY $FILE $*"
# 不使用 exec：exec 会把 shell 整体替换为 python，脚本的退出流程随之消失。
# </dev/null：子进程不继承任务 stdin（同 fetch 的既有做法）
$PY "$FILE" "$@" </dev/null
_rc=$?
echo "[完成] 执行结束（exit=$_rc）"
exit $_rc

#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  chinamnos 更新执行器（青龙面板用）
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
#     目标任务找不到时自动创建（永不匹配的 cron，仅 API 触发，不会自行定时跑）。
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

# 多源基址依次尝试：直连 → 两个常见加速镜像（文件路径拼在基址后）
URL_BASES=(
  "https://raw.githubusercontent.com/$REPO/$BRANCH"
  "https://ghproxy.net/https://raw.githubusercontent.com/$REPO/$BRANCH"
  "https://gh-proxy.com/https://raw.githubusercontent.com/$REPO/$BRANCH"
)

NFILES=("notify_dispatch.py" "qq_text_render.py")   # 采集播报分发脚本 + 其同目录排版模块（仓库 qinglong/ 目录）

fetch() { # $1=URL $2=输出文件
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 8 --max-time 60 -o "$2" "$1"
  else
    wget -qO "$2" --timeout=60 "$1"
  fi
}

if [ "${SKIP_UPDATE:-0}" != "1" ]; then
  ok=""
  for b in "${URL_BASES[@]}"; do
    u="$b/$FILE"
    echo "[更新] 尝试下载: $u"
    if fetch "$u" "$FILE.new" \
       && grep -q "$MARKER" "$FILE.new" \
       && $PY -m py_compile "$FILE.new" 2>/dev/null; then
      ok="$b"
      break
    fi
    rm -f "$FILE.new"
    echo "[更新] 该源不可用，切换下一个"
  done

  if [ -n "$ok" ]; then
    [ -f "$FILE" ] && cp -f "$FILE" "$FILE.bak"   # 保留上一版便于回滚
    mv -f "$FILE.new" "$FILE"
    echo "[更新] ✓ 已更新 $FILE（来源: $ok/$FILE，旧版备份为 $FILE.bak）"
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
      NURL="$ok/qinglong/$NF"
      echo "[更新] 尝试下载: $NURL"
      if fetch "$NURL" "$NF.new" \
         && $PY -m py_compile "$NF.new" 2>/dev/null; then
        if [ -f "$NF" ] && cmp -s "$NF" "$NF.new"; then
          rm -f "$NF.new"
          echo "[更新] ✓ $NF 已是最新"
        else
          [ -f "$NF" ] && cp -f "$NF" "$NF.bak"   # 保留上一版便于回滚
          mv -f "$NF.new" "$NF"
          echo "[更新] ✓ 已更新 $NF"
        fi
      else
        rm -f "$NF.new"
        echo "[更新] ⚠ $NF 下载/校验失败，沿用现有版本继续"
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
if [ $# -eq 0 ]; then
  QL_URL="${QL_URL:-http://localhost:5700}" \
    CHINAMNOS_WORKDIR="$DIR_ABS" \
    CHINAMNOS_PY="$PY" \
    $PY - <<'PYEOF'
import json
import os
import sys
import urllib.parse
import urllib.request

WORKDIR = os.environ.get("CHINAMNOS_WORKDIR", ".")
PYBIN = os.environ.get("CHINAMNOS_PY", "python3")

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
    url = BASE + path + (("?%s" % qs) if qs else "")
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(r, timeout=15) as resp:
        d = json.load(resp)
    if d.get("code") != 200:
        raise RuntimeError("%s %s -> %s" % (method, path, json.dumps(d, ensure_ascii=False)[:200]))
    return d.get("data")


try:
    print("[触发] 解耦模式：经面板 OpenAPI 启动独立采集任务（来源: %s）"
          % ("TARIFF_CONFIG.notification.ql_trigger" if _q else "QL_* 环境变量"))
    tok = req("GET", "/open/auth/token",
              qs="client_id=%s&client_secret=%s" % (urllib.parse.quote(CID), urllib.parse.quote(SECRET)))
    token = (tok or {}).get("token")
    if not token:
        raise RuntimeError("auth/token 响应缺少 token")

    tid = 0
    if TASK_ID:
        tid = int(TASK_ID)
    else:
        tasks = req("GET", "/open/tasks", qs="searchValue=%s" % urllib.parse.quote(TASK_NAME)) or []
        # 目标特征：命令含 chinamnos.py 且非本更新器（避免把同步任务自己再拉起来）
        cands = [t for t in tasks
                 if "chinamnos.py" in str(t.get("command") or "")
                 and "chinamnos_updater" not in str(t.get("command") or "")]
        if cands:
            tid = cands[0].get("id") or cands[0].get("_id")

    if not tid and AUTOCREATE:
        cmd = 'cd "%s" && %s chinamnos.py' % (WORKDIR, PYBIN)
        new = req("POST", "/open/tasks",
                  {"name": TASK_NAME, "command": cmd, "schedule": "0 0 31 2 *"})
        tid = (new or {}).get("id") or (new or {}).get("_id")
        print("[触发] 已自动创建独立采集任务 #%s（永不定时，仅 API 触发）：%s" % (tid, cmd))

    if not tid:
        raise RuntimeError("未找到目标任务（task_name=%s）且 autocreate 未开启" % TASK_NAME)

    req("PUT", "/open/tasks/run", [int(tid)])
    print("[触发] ✓ 已请求面板运行采集任务 #%s，本同步任务结束" % tid)
except Exception as e:
    print("[触发] ✗ 失败：%s" % str(e)[:200])
    print("[触发] 提示：需在面板「设置→应用设置」创建应用并勾选「任务管理」权限；"
          "也可配 task_id 直接指定目标任务。")
    sys.exit(1)
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
exec $PY "$FILE" "$@"

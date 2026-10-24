#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  chinamnos 更新执行器（青龙面板用）
#  作用：从 GitHub 拉取最新 chinamnos.py 与 qinglong/notify_dispatch.py（采集播报分发脚本）
#        到统一工作目录，校验通过后执行；notify_dispatch.py 下载失败仅告警，不阻塞采集
#  一次上传本文件到青龙后，无需再手动同步脚本
#
#  青龙任务命令示例（参数原样透传给 chinamnos.py）：
#    task chinamnos_updater.sh                     → 完整采集
#    task chinamnos_updater.sh --rebuild-stats     → 重建统计
#    task chinamnos_updater.sh --announce-only     → 仅公告采集
#    task chinamnos_updater.sh --deploy-frontend   → 仅部署前端
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

NFILE="notify_dispatch.py"   # 采集播报分发脚本（仓库 qinglong/ 目录，与 chinamnos.py 同目录部署）

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

  # ── notify_dispatch.py 同步（采集播报分发脚本；失败仅告警，不阻塞采集）──
  if [ -n "$ok" ]; then
    NURL="$ok/qinglong/$NFILE"
    echo "[更新] 尝试下载: $NURL"
    if fetch "$NURL" "$NFILE.new" \
       && $PY -m py_compile "$NFILE.new" 2>/dev/null; then
      if [ -f "$NFILE" ] && cmp -s "$NFILE" "$NFILE.new"; then
        rm -f "$NFILE.new"
        echo "[更新] ✓ $NFILE 已是最新"
      else
        [ -f "$NFILE" ] && cp -f "$NFILE" "$NFILE.bak"   # 保留上一版便于回滚
        mv -f "$NFILE.new" "$NFILE"
        echo "[更新] ✓ 已更新 $NFILE"
      fi
    else
      rm -f "$NFILE.new"
      echo "[更新] ⚠ $NFILE 下载/校验失败，沿用现有版本继续"
    fi
  else
    echo "[更新] ⚠ chinamnos.py 未更新成功，跳过 $NFILE 同步"
  fi
else
  echo "[更新] SKIP_UPDATE=1，跳过更新"
fi

echo "[执行] $PY $FILE $*"
exec $PY "$FILE" "$@"

#!/bin/bash
# Computer-use init — run once at the start of each task.
# Sets up three things: scale factor, scroll tool, snap helper.
# Safe to re-run; only recompiles scroll tool if source changed.

set -euo pipefail
for required in screencapture sips osascript python3 swiftc cliclick; do
    command -v "$required" >/dev/null || { echo "缺少依赖：$required" >&2; exit 1; }
done
umask 077
CU_DIR=$(mktemp -d "${TMPDIR:-/tmp}/computer-use.XXXXXX")
echo "本任务工具目录：$CU_DIR"
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# ── 1. Retina scale factor ─────────────────────────────────────────────────
# screencapture gives pixel dimensions; cliclick uses logical points.
# On Retina screens these differ (typically 2×). We need the ratio so
# coordinates read from screenshots can be used directly for cliclick.
screencapture -x "$CU_DIR"/_cu_check.png
PX=$(sips -g pixelWidth "$CU_DIR"/_cu_check.png | awk '/pixelWidth/{print $2}')
LW=$(osascript -e 'tell application "Finder" to get item 3 of (get bounds of window of desktop)' 2>/dev/null)
SCALE=$(python3 -c "import sys; p=float(sys.argv[1]); w=float(sys.argv[2]); assert p>0 and w>0; print(p/w)" "$PX" "$LW")
echo "$SCALE" > "$CU_DIR"/_cu_scale
echo "scale=$SCALE  (screenshot=${PX}px  logical=${LW}px)"

# ── 2. Scroll tool ─────────────────────────────────────────────────────────
# cliclick has no scroll wheel command; keyboard shortcuts are stolen by
# chat-app input boxes. We compile a tiny Swift binary using CGEvent instead.
cp "$SKILL_DIR/scripts/scroll.swift" "$CU_DIR"/_cu_scroll.swift
if [ ! -f "$CU_DIR"/_cu_scroll ] || [ "$CU_DIR"/_cu_scroll.swift -nt "$CU_DIR"/_cu_scroll ]; then
    swiftc "$CU_DIR"/_cu_scroll.swift -o "$CU_DIR"/_cu_scroll
    echo "scroll tool compiled"
else
    echo "scroll tool up-to-date"
fi

# ── 3. Snap helper ─────────────────────────────────────────────────────────
# Wraps screencapture + resize-to-logical-resolution + optional crop.
# 全屏图采用逻辑坐标；裁剪图上的坐标还需加回裁剪偏移。
# Keeping screenshots at logical resolution (rather than retina pixels)
# 可减少图像像素量；具体 token 消耗取决于宿主。
#
# Usage:
#   "$CU_DIR"/_cu_snap.sh <out.png>
#   "$CU_DIR"/_cu_snap.sh <out.png> <W> <H> <x_offset> <y_offset>   # crop after resize
cat << 'SH' > "$CU_DIR"/_cu_snap.sh
#!/bin/bash
set -euo pipefail
CU_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT=${1:?请提供新截图输出路径}
S=$(cat "$CU_DIR"/_cu_scale)
screencapture -x "$OUT"
PW=$(sips -g pixelWidth  "$OUT" | awk '/pixelWidth/{print $2}')
PH=$(sips -g pixelHeight "$OUT" | awk '/pixelHeight/{print $2}')
read -r LW LH < <(python3 -c "import sys; w,h,s=map(float,sys.argv[1:]); assert s>0; print(round(w/s),round(h/s))" "$PW" "$PH" "$S")
sips -z "$LH" "$LW" "$OUT" --out "$OUT" > /dev/null
if [ -n "${2:-}" ]; then
    sips "$OUT" --cropToHeightWidth "$3" "${2:-}" --cropOffset "${5:-0}" "${4:-0}" \
        --out "$OUT" > /dev/null
fi
echo "snap: ${LW}x${LH}$([ -n "${2:-}" ] && echo " → crop $2×$3") → $OUT"
SH
chmod +x "$CU_DIR"/_cu_snap.sh
echo "snap helper ready"

# ── 4. Visible processes ───────────────────────────────────────────────────
# Always print so you know the real process name before calling osascript.
# (e.g. Feishu ≠ Lark, WeChat ≠ 微信)
echo "--- visible processes ---"
osascript -e 'tell application "System Events" to get name of every process whose visible is true'

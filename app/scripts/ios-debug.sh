#!/usr/bin/env bash
set -euo pipefail

# 用法：
#   app/scripts/ios-debug.sh
#   app/scripts/ios-debug.sh --release
#   app/scripts/ios-debug.sh --device "iPhone 16"
# 默认优先使用精确名称为 "iPhone 16" 的 iOS 模拟器，找不到则回退到第一个可用 iPhone 模拟器。

usage() {
  cat <<'EOF'
用法：
  app/scripts/ios-debug.sh [--release] [--device "<name>"]

选项：
  --release          使用 flutter run --release
  --device "<name>"  指定优先使用的模拟器名称，例如 "iPhone 16"
  -h, --help         显示帮助
EOF
}

die() {
  echo "错误：$*" >&2
  exit 1
}

require_command() {
  local command_name="$1"
  local install_hint="$2"

  if ! command -v "$command_name" >/dev/null 2>&1; then
    die "未找到 ${command_name}。${install_hint}"
  fi
}

find_device_by_exact_name() {
  local desired_name="$1"
  local devices="$2"
  local line name udid state
  local device_line_regex='^[[:space:]]*(.+)[[:space:]]+\(([0-9A-Fa-f-]+)\)[[:space:]]+\(([^)]*)\)[[:space:]]*$'

  while IFS= read -r line; do
    if [[ "$line" =~ $device_line_regex ]]; then
      name="${BASH_REMATCH[1]}"
      udid="${BASH_REMATCH[2]}"
      state="${BASH_REMATCH[3]}"

      if [[ "$name" == "$desired_name" ]]; then
        printf '%s\t%s\t%s\n' "$udid" "$state" "$name"
        return 0
      fi
    fi
  done <<<"$devices"

  return 1
}

find_first_iphone_device() {
  local devices="$1"
  local line name udid state
  local device_line_regex='^[[:space:]]*(.+)[[:space:]]+\(([0-9A-Fa-f-]+)\)[[:space:]]+\(([^)]*)\)[[:space:]]*$'

  while IFS= read -r line; do
    if [[ "$line" =~ $device_line_regex ]]; then
      name="${BASH_REMATCH[1]}"
      udid="${BASH_REMATCH[2]}"
      state="${BASH_REMATCH[3]}"

      if [[ "$name" == iPhone* ]]; then
        printf '%s\t%s\t%s\n' "$udid" "$state" "$name"
        return 0
      fi
    fi
  done <<<"$devices"

  return 1
}

get_device_state_by_udid() {
  local target_udid="$1"
  local devices="$2"
  local line udid state
  local device_line_regex='^[[:space:]]*(.+)[[:space:]]+\(([0-9A-Fa-f-]+)\)[[:space:]]+\(([^)]*)\)[[:space:]]*$'

  while IFS= read -r line; do
    if [[ "$line" =~ $device_line_regex ]]; then
      udid="${BASH_REMATCH[2]}"
      state="${BASH_REMATCH[3]}"

      if [[ "$udid" == "$target_udid" ]]; then
        printf '%s\n' "$state"
        return 0
      fi
    fi
  done <<<"$devices"

  return 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET_DEVICE_NAME="iPhone 16"
RUN_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --release)
      RUN_ARGS+=(--release)
      shift
      ;;
    --device)
      [[ $# -ge 2 ]] || die "--device 需要跟一个模拟器名称，例如：--device \"iPhone 16\""
      TARGET_DEVICE_NAME="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "未知参数：$1。可用 --help 查看用法。"
      ;;
  esac
done

require_command "xcrun" "请确认已安装 Xcode 或 Xcode Command Line Tools。"
require_command "flutter" "请确认 Flutter SDK 已安装，并且 flutter 已加入 PATH。"

if ! xcrun simctl help >/dev/null 2>&1; then
  die "xcrun simctl 不可用。请确认已安装 Xcode，并通过 xcode-select 选择正确的 Xcode 路径。"
fi

if ! DEVICE_LIST="$(xcrun simctl list devices available 2>/dev/null)"; then
  die "读取 iOS 模拟器列表失败。请确认 Xcode 已正确安装并至少安装了一个 iOS Simulator runtime。"
fi

DEVICE_RECORD="$(find_device_by_exact_name "$TARGET_DEVICE_NAME" "$DEVICE_LIST" || true)"

if [[ -z "$DEVICE_RECORD" ]]; then
  echo "未找到精确名称为 \"${TARGET_DEVICE_NAME}\" 的可用模拟器，改用第一个可用 iPhone 模拟器。" >&2
  DEVICE_RECORD="$(find_first_iphone_device "$DEVICE_LIST" || true)"
fi

[[ -n "$DEVICE_RECORD" ]] || die "没有找到任何可用的 iPhone 模拟器。请在 Xcode 中安装 iOS Simulator runtime。"

IFS=$'\t' read -r DEVICE_UDID DEVICE_STATE DEVICE_NAME <<<"$DEVICE_RECORD"

echo "目标模拟器：${DEVICE_NAME} (${DEVICE_UDID})，当前状态：${DEVICE_STATE}"

if [[ "$DEVICE_STATE" != "Booted" ]]; then
  echo "正在启动模拟器 ${DEVICE_NAME}..."
  if ! xcrun simctl boot "$DEVICE_UDID" >/dev/null 2>&1; then
    DEVICE_LIST="$(xcrun simctl list devices available 2>/dev/null || true)"
    DEVICE_STATE="$(get_device_state_by_udid "$DEVICE_UDID" "$DEVICE_LIST" || true)"
    if [[ "$DEVICE_STATE" != "Booted" && "$DEVICE_STATE" != "Booting" ]]; then
      die "启动模拟器失败：${DEVICE_NAME} (${DEVICE_UDID})。当前状态：${DEVICE_STATE:-未知}。"
    fi
  fi
else
  echo "模拟器已启动，跳过 boot。"
fi

if ! open -a Simulator; then
  die "打开 Simulator 应用失败。请确认 Xcode 已正确安装。"
fi

echo "等待模拟器启动完成..."
if ! xcrun simctl bootstatus "$DEVICE_UDID" -b; then
  die "等待模拟器启动完成失败：${DEVICE_NAME} (${DEVICE_UDID})。"
fi

cd "$APP_DIR"

echo "在 app/ 目录执行：flutter run ${RUN_ARGS[*]} -d ${DEVICE_UDID}"
exec flutter run "${RUN_ARGS[@]}" -d "$DEVICE_UDID"

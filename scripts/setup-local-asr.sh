#!/usr/bin/env bash
# Download the local ASR models (SenseVoiceSmall int8 + silero VAD) used by
# src/asr-local.js. Safe to re-run; skips files that already exist.
# Models live outside the repo (~240MB) in ~/.multicc/asr-models by default.
set -euo pipefail

MODEL_DIR="${ASR_LOCAL_MODEL_DIR:-$HOME/.multicc/asr-models}"
SV_NAME="sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
GH_BASE="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models"

mkdir -p "$MODEL_DIR"
cd "$MODEL_DIR"

fetch() {
  local out="$1" url="$2"
  echo "Downloading $out ..."
  curl -fL --connect-timeout 20 --retry 2 -o "$out" "$url" \
    || curl -fL --connect-timeout 20 --retry 2 -o "$out" "https://gh-proxy.com/$url"
}

if [ ! -f silero_vad.onnx ]; then
  fetch silero_vad.onnx "$GH_BASE/silero_vad.onnx"
else
  echo "silero_vad.onnx already present"
fi

if [ ! -f "$SV_NAME/model.int8.onnx" ]; then
  fetch "$SV_NAME.tar.bz2" "$GH_BASE/$SV_NAME.tar.bz2"
  tar xjf "$SV_NAME.tar.bz2"
  rm -f "$SV_NAME.tar.bz2"
else
  echo "$SV_NAME already present"
fi

echo "Done. Models in $MODEL_DIR"
echo "Restart the multicc server; /api/settings/voice → asr.status.local.ready should be true."

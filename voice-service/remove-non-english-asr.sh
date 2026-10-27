#!/usr/bin/env bash
set -euo pipefail

SERVICE_ROOT="/opt/sharpertime-voice"
MODEL_ROOT="$SERVICE_ROOT/models"
PYTHON="$SERVICE_ROOT/.venv/bin/python"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this cleanup with sudo after deploying the English-only voice service." >&2
  exit 1
fi

if [[ ! -d "$SERVICE_ROOT" || -L "$SERVICE_ROOT" || "$(realpath -e "$SERVICE_ROOT")" != "$SERVICE_ROOT" ]]; then
  echo "Unexpected voice-service directory; refusing to remove files." >&2
  exit 1
fi

if grep -Eq 'local_asr|supports_language|transcribe_local_audio' "$SERVICE_ROOT/server.py"; then
  echo "Deploy the English-only server.py before removing its language models." >&2
  exit 1
fi

if [[ -d "$MODEL_ROOT" && ( -L "$MODEL_ROOT" || "$(realpath -e "$MODEL_ROOT")" != "$MODEL_ROOT" ) ]]; then
  echo "Unexpected ASR model directory; refusing to remove files." >&2
  exit 1
fi

remove_model_path() {
  local path="$1"
  case "$path" in
    "$MODEL_ROOT"/*) ;;
    *) echo "Refusing path outside the ASR model directory: $path" >&2; exit 1 ;;
  esac

  if [[ -L "$path" || -f "$path" ]]; then
    rm -f -- "$path"
    printf 'Removed %s\n' "$path"
  elif [[ -d "$path" ]]; then
    rm -rf -- "$path"
    printf 'Removed %s\n' "$path"
  fi
}

systemctl daemon-reload
systemctl stop sharpertime-voice.service

for name in \
  fluister-turbo \
  swivuriso-turbo \
  omnilingual-300m-ctc-int8 \
  sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-int8-2025-11-12 \
  .omnilingual-asr-ctc-int8.tar.bz2 \
  huggingface
do
  remove_model_path "$MODEL_ROOT/$name"
done

if [[ -d "$MODEL_ROOT" ]]; then
  for backup in "$MODEL_ROOT"/omnilingual-300m-ctc-int8.previous.*; do
    [[ -e "$backup" || -L "$backup" ]] || continue
    remove_model_path "$backup"
  done
fi

rm -f -- \
  "$SERVICE_ROOT/local_asr.py" \
  "$SERVICE_ROOT/download-asr-models.sh" \
  "$SERVICE_ROOT/sharpertime-voice-asr.conf"

if [[ -x "$PYTHON" ]]; then
  for package in faster-whisper sherpa-onnx ctranslate2; do
    if "$PYTHON" -m pip show "$package" >/dev/null 2>&1; then
      "$PYTHON" -m pip uninstall -y "$package"
    fi
  done
fi

systemctl start sharpertime-voice.service
systemctl is-active --quiet sharpertime-voice.service
printf 'Removed the non-English ASR models and restarted the English-only voice service.\n'

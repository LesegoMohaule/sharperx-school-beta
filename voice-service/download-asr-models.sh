#!/usr/bin/env bash
set -euo pipefail

SERVICE_ROOT="${SERVICE_ROOT:-/opt/sharpertime-voice}"
MODEL_ROOT="${SHARPERTIME_ASR_MODEL_DIR:-$SERVICE_ROOT/models}"
SERVICE_USER="${SERVICE_USER:-sharpertime-voice}"
PYTHON="$SERVICE_ROOT/.venv/bin/python"
OMNI_ARCHIVE="$MODEL_ROOT/.omnilingual-asr-ctc-int8.tar.bz2"
OMNI_SOURCE="$MODEL_ROOT/sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-int8-2025-11-12"
OMNI_TARGET="$MODEL_ROOT/omnilingual-300m-ctc-int8"

install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$MODEL_ROOT"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$MODEL_ROOT/huggingface"

sudo -u "$SERVICE_USER" env HF_HOME="$MODEL_ROOT/huggingface" MODEL_ROOT="$MODEL_ROOT" "$PYTHON" - <<'PY'
import os
from pathlib import Path
from huggingface_hub import snapshot_download

root = Path(os.environ["MODEL_ROOT"])
for repo, revision, folder in (
    ("digiphyte/swivuriso-turbo", "078ab5ce8bc1666d658680e61893f76d94c0dec7", "swivuriso-turbo"),
    ("digiphyte/fluister-turbo", "2210b90080c71d204843b242731f7de40db93c4c", "fluister-turbo"),
):
    destination = root / folder
    if not (destination / "model.bin").is_file():
        print(f"Downloading {repo} at {revision}", flush=True)
        snapshot_download(repo_id=repo, revision=revision, local_dir=str(destination))
PY

if [[ ! -s "$OMNI_TARGET/model.int8.onnx" || ! -s "$OMNI_TARGET/tokens.txt" ]]; then
  archive_url="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-int8-2025-11-12.tar.bz2"
  curl --fail --location --retry 3 "$archive_url" --output "$OMNI_ARCHIVE"
  tar -xjf "$OMNI_ARCHIVE" -C "$MODEL_ROOT"
  if [[ -e "$OMNI_TARGET" ]]; then
    mv "$OMNI_TARGET" "$OMNI_TARGET.previous.$(date -u +%Y%m%dT%H%M%SZ)"
  fi
  mv "$OMNI_SOURCE" "$OMNI_TARGET"
  rm -f "$OMNI_ARCHIVE"
fi

chown -R "$SERVICE_USER:$SERVICE_USER" "$MODEL_ROOT"
chmod -R u=rwX,g=rX,o= "$MODEL_ROOT"
printf 'Local ASR models are installed under %s\n' "$MODEL_ROOT"

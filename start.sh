#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

python3 -c "import fastapi, uvicorn, multipart, zxingcpp, rapidocr_onnxruntime" 2>/dev/null || \
  pip install --no-cache-dir -r requirements.txt

exec python3 -m uvicorn backend.main:app --host 0.0.0.0 --port 8000

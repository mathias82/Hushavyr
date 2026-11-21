#!/usr/bin/env bash
set -euo pipefail

MODEL="${OLLAMA_MODEL:-qwen2.5-coder:7b}"
URL="http://127.0.0.1:11434"

if ! command -v ollama >/dev/null 2>&1; then
  echo "Ollama is missing. Install it with: brew install ollama" >&2
  exit 1
fi

if ! curl --silent --fail --max-time 2 "$URL/api/tags" >/dev/null; then
  if command -v brew >/dev/null 2>&1 && brew list --formula ollama >/dev/null 2>&1; then
    echo "Starting Ollama with Homebrew..."
    brew services start ollama
  else
    echo "Starting Ollama in the background..."
    OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q8_0 nohup ollama serve > "${TMPDIR:-/tmp}/ai-privacy-router-ollama.log" 2>&1 < /dev/null &
  fi
fi

echo "Waiting for local Ollama at $URL..."
ready=0
for _ in {1..30}; do
  if curl --silent --fail --max-time 2 "$URL/api/tags" >/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "Ollama did not become ready. Check the server logs." >&2
  exit 1
fi

if ! ollama list | awk 'NR>1 {print $1}' | grep -Fxq "$MODEL"; then
  echo "Downloading missing model: $MODEL"
  ollama pull "$MODEL"
fi

echo "Ollama is ready. The VS Code extension can use $MODEL locally."
if [ "${1:-}" = "--serve-only" ]; then
  exit 0
fi
echo "Starting interactive Qwen. Type /bye to exit (the server stays running)."
exec ollama run "$MODEL"

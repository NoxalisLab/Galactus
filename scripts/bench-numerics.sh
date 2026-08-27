#!/bin/zsh
# Ce que coûte GALACTUS_METAL_BITEXACT, mesuré plutôt qu'affirmé.
# Reproduit le lancement de lib.rs pour olmoe-1b-7b, une fois avec le drapeau
# et une fois sans, et compare l'ingestion de prompt.
set -e
ROOT="/Volumes/NoxalisExtended/Noxalis Lab/NoxalisAi/galactus"
BIN="$ROOT/app/src-tauri/engine/llama-server"
GGUF="$ROOT/models/olmoe-1b-7b/OLMoE-1B-7B-0924-Instruct-Q4_K_M.gguf"
PROF="$ROOT/models/olmoe-1b-7b/profile.engine.txt"
INT="/Users/dschaerer/GalactusH4/olmoe-1b-7b/olmoe-1b-7b-internal.pack"
EXT="/Volumes/NoxalisExtended/GalactusH4/olmoe-1b-7b/olmoe-1b-7b-external.pack"
PORT=18099
OUT="$(dirname $0)"

# Un prompt long, pour que l'ingestion domine: c'est elle qu'on mesure.
PROMPT=$(python3 -c "print('Le dispositif medical doit etre verifie avant chaque utilisation. ' * 180)")

run() {
  local label="$1" bitexact="$2"
  local log="$OUT/bench-$label.log"
  rm -f "$log"
  env LC_ALL=C \
      GALACTUS_H4=1 GALACTUS_H4_INTERNAL="$INT" GALACTUS_H4_EXTERNAL="$EXT" \
      GALACTUS_H4_CACHE_BYTES=4000000000 GALACTUS_H4_PROTECTED=0.75 GALACTUS_H4_QD=32 \
      GALACTUS_PROFILE="$PROF" \
      ${bitexact:+GALACTUS_METAL_BITEXACT=1} \
      "$BIN" --model "$GGUF" --host 127.0.0.1 --port $PORT \
      --ctx-size 4096 --n-gpu-layers 99 --no-repack --fit off --no-mmap \
      --batch-size 512 --ubatch-size 512 --parallel 1 --jinja \
      --reasoning-format deepseek > "$log" 2>&1 &
  local pid=$!
  for i in $(seq 1 120); do
    sleep 1
    curl -s "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"ok"' && break
  done
  # Deux passes: la premiere chauffe le cache d'experts, la seconde mesure.
  for pass in 1 2; do
    curl -s "http://127.0.0.1:$PORT/completion" -H "Content-Type: application/json" \
      -d "$(python3 -c "
import json,sys
print(json.dumps({'prompt': sys.argv[1], 'n_predict': 16, 'cache_prompt': False}))" "$PROMPT")" > /dev/null
  done
  kill $pid 2>/dev/null || true
  wait $pid 2>/dev/null || true
  echo "--- $label ---"
  grep -E "prompt eval time|^.*\| *eval time" "$log" | tail -4
}

run bitexact 1
sleep 3
run standard ""

#!/bin/zsh
# Le meme banc, sur le modele que l'utilisateur fait tourner vraiment (mxfp4).
ROOT="/Volumes/NoxalisExtended/Noxalis Lab/NoxalisAi/galactus"
BIN="$ROOT/app/src-tauri/engine/llama-server"
GGUF="$ROOT/models/gpt-oss-120b/gpt-oss-120b-F16.gguf"
PROF="$ROOT/models/gpt-oss-120b/profile.engine.txt"
S="$(dirname $0)"
PROMPT=$(python3 -c "print('Le dispositif medical doit etre verifie avant chaque utilisation. ' * 320)")
run() {
  env LC_ALL=C GALACTUS_H4=1 \
    GALACTUS_H4_INTERNAL="$GGUF" GALACTUS_H4_EXTERNAL="$GGUF" \
    GALACTUS_H4_CACHE_BYTES=60926459904 GALACTUS_H4_PROTECTED=0.75 GALACTUS_H4_QD=32 \
    GALACTUS_PROFILE="$PROF" ${1:+GALACTUS_METAL_BITEXACT=1} \
    "$BIN" --model "$GGUF" --host 127.0.0.1 --port 18097 --ctx-size 8192 \
    --n-gpu-layers 99 --no-repack --fit off --no-mmap --batch-size 512 \
    --ubatch-size 512 --parallel 1 > "$S/gptoss-$2.log" 2>&1 &
  local pid=$!
  for i in $(seq 1 240); do sleep 1; curl -s http://127.0.0.1:18097/health 2>/dev/null | grep -q '"ok"' && break; done
  for pass in 1 2; do
    curl -s http://127.0.0.1:18097/completion -H "Content-Type: application/json" \
      -d "$(python3 -c "import json,sys;print(json.dumps({'prompt':sys.argv[1],'n_predict':16,'cache_prompt':False}))" "$PROMPT")" > /dev/null
  done
  kill $pid 2>/dev/null; wait $pid 2>/dev/null
  echo "--- $2 ---"
  grep -E "prompt eval time" "$S/gptoss-$2.log" | tail -1
  grep -E "\| *eval time" "$S/gptoss-$2.log" | tail -1
}
run "" standard

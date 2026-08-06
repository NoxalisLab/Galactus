#!/bin/bash
# Hardware advisor — inspects this machine and recommends which registered
# MoE models it can run, at which expert-cache size, with expected speed.
# This module ships as-is inside the galactus CLI (`galactus check`).
# Self-locating, no machine-specific paths.
set -u
export LC_ALL=C
HERE="$(cd "$(dirname "$0")" && pwd)"
REGISTRY="${HERE}/models-registry.json"

echo "=== galactus hardware check ==="
OS="$(uname -s)"
if [ "${OS}" = "Darwin" ]; then
  RAM_BYTES=$(sysctl -n hw.memsize)
  CHIP=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "Apple Silicon")
  CORES=$(sysctl -n hw.ncpu)
else
  RAM_BYTES=$(( $(grep MemTotal /proc/meminfo | awk '{print $2}') * 1024 ))
  CHIP=$(grep -m1 "model name" /proc/cpuinfo | cut -d: -f2- | sed 's/^ //')
  CORES=$(nproc)
fi
RAM_GB=$(( RAM_BYTES / 1000000000 ))
DISK_FREE_GB=$(df -g "${HERE}" 2>/dev/null | awk 'NR==2 {print $4}')
[ -z "${DISK_FREE_GB:-}" ] && DISK_FREE_GB=$(df -BG "${HERE}" | awk 'NR==2 {print $4}' | tr -d G)

echo "chip        : ${CHIP} (${CORES} cores)"
echo "memory      : ${RAM_GB} GB"
echo "disk free   : ${DISK_FREE_GB} GB (volume of this install)"

# Optional quick sequential-read sample (first large file found in models/ or packs/)
SAMPLE=""
for CAND in "${HERE}/../artifacts/h4/packs"/*/*.pack "${HERE}/../models"/*/*.gguf; do
  [ -f "${CAND}" ] && SAMPLE="${CAND}" && break
done
if [ -n "${SAMPLE}" ]; then
  T0=$(date +%s)
  dd if="${SAMPLE}" of=/dev/null bs=16m count=64 2>/dev/null
  T1=$(date +%s)
  D=$(( T1 - T0 )); [ "${D}" -lt 1 ] && D=1
  SSD_GBS=$(( 1 / D )); [ "${SSD_GBS}" -lt 1 ] && SSD_GBS="<1"
  echo "ssd read    : ~$(( 1073 / D / 1000 )).$(( (1073 / D) % 1000 / 100 )) GB/s (1 GB sample, cache-inflated on reruns)"
fi

# Rule of thumb encoded from measured tiers (see models-registry.json):
# usable expert cache = RAM - overhead (non-expert weights ~4.5 GB + KV + OS ~4.5 GB)
OVERHEAD_GB=9
CACHE_GB=$(( RAM_GB - OVERHEAD_GB ))
echo ""
echo "=== recommendations ==="
if [ ! -f "${REGISTRY}" ]; then
  echo "registry not found: ${REGISTRY}"
  exit 1
fi

python3 - "${REGISTRY}" "${RAM_GB}" "${CACHE_GB}" "${DISK_FREE_GB}" <<'PYEOF'
import json, sys
reg = json.load(open(sys.argv[1]))
ram_gb, cache_gb, disk_gb = int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
print(f"usable expert cache on this machine: ~{cache_gb} GB (RAM {ram_gb} - ~9 overhead)")
print()
for m in reg["models"]:
    name, status = m["name"], m.get("status", "?")
    line = f"- {name} [{status}]"
    fit_native = m.get("native_fit_ram_gb")
    need_disk = m.get("gguf_bytes", 0) / 1e9
    min_cache = m.get("min_cache_bytes", 0) / 1e9
    if status == "pending_certification":
        print(line + " : not yet certified, skip")
        continue
    if fit_native and ram_gb >= fit_native:
        print(line + f" : fits in RAM natively -> run stock llama.cpp (fastest), galactus unnecessary")
        continue
    if min_cache and cache_gb < min_cache:
        print(line + f" : needs >= {min_cache:.0f} GB expert cache, this machine has ~{cache_gb} -> too small")
        continue
    req = m.get("requires")
    if req and ram_gb < 128 and "128" in req:
        print(line + f" : {req} -> not this machine")
        continue
    # interpolate expected speed from measured points
    pts = sorted(m.get("measured", []), key=lambda p: p["cache_gb"])
    est = None
    if pts:
        use = min(cache_gb, pts[-1]["cache_gb"])
        lo = max((p for p in pts if p["cache_gb"] <= use), key=lambda p: p["cache_gb"], default=pts[0])
        hi = min((p for p in pts if p["cache_gb"] >= use), key=lambda p: p["cache_gb"], default=pts[-1])
        if hi["cache_gb"] == lo["cache_gb"]:
            est = lo["gen_tps"]
        else:
            f = (use - lo["cache_gb"]) / (hi["cache_gb"] - lo["cache_gb"])
            est = lo["gen_tps"] + f * (hi["gen_tps"] - lo["gen_tps"])
    extra = f", expect ~{est:.1f} tok/s (reference machine; slower SSD/CPU scales down)" if est else ""
    disk_note = "" if disk_gb > need_disk * 2 else f" (disk: needs ~{need_disk*2:.0f} GB for model+pack, {disk_gb} free)"
    print(line + f" : RUN with expert cache ~{min(cache_gb, 128):.0f} GB{extra}{disk_note}")
PYEOF
echo ""
echo "(speeds measured on the reference machine in the registry; the CLI will"
echo " refine them per-machine after the first run)"

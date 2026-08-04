#!/bin/bash
# Les deux mesures qui restent, en sequence, sans aucune interaction.
#
# Pas de `read` a la fin : ce script est fait pour etre double-clique OU lance
# en nohup, et dans les deux cas il ecrit tout dans le depot, la ou je peux le
# lire. Il commence par se signaler, pour qu'on sache tout de suite s'il a
# demarre ou non.
set -u
export LC_ALL=C
export LANG=C
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "${ROOT}/galactus.env" ] && . "${ROOT}/galactus.env"
JOURNAL="${ROOT}/artifacts/h4/LANCER-TOUT.log"
mkdir -p "${ROOT}/artifacts/h4" 2>/dev/null
exec >>"${JOURNAL}" 2>&1
echo ""
echo "==================================================================="
echo "=== LANCER-TOUT demarre $(date -u +%Y-%m-%dT%H:%M:%SZ) pid $$ ==="
echo "cwd=$(pwd)  utilisateur=$(id -un)  shell=${SHELL:-?}"
cd "${ROOT}" || { echo "ARRET : cd impossible vers ${ROOT}"; exit 1; }
echo "cd OK vers ${ROOT}"
/usr/bin/memory_pressure -Q | grep -i "free percentage"
/usr/sbin/sysctl -n vm.swapusage

# ---------- 1. cout de soumission : trois minutes ----------
OUT1="${ROOT}/artifacts/h4/compute-microbench"
mkdir -p "${OUT1}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
echo ""
echo "--- 1/2 cout de soumission (${STAMP}) ---"
cmake --build build --target galactus-glm-compute-microbench 2>&1 | tail -4
for R in 1 2 3; do
  echo "  replique ${R}"
  build/galactus-glm-compute-microbench --mode full \
      --output "${OUT1}/${STAMP}-r${R}.json" 2>&1 | tail -2
done
python3 - "${OUT1}" "${STAMP}" <<'PYEOF'
import json, sys
out, stamp = sys.argv[1], sys.argv[2]
IO = 62.33
def fit(pts):
    n=len(pts); sx=sum(p[0] for p in pts); sy=sum(p[1] for p in pts)
    sxx=sum(p[0]**2 for p in pts); sxy=sum(p[0]*p[1] for p in pts)
    s=(n*sxy-sx*sy)/(n*sxx-sx*sx); return s, (sy-s*sx)/n
allpts, inters = [], []
print(f"{'replique':>10} {'pente':>10} {'origine':>10} {'residu max':>11} {'tok/s livrable':>15}")
for r in (1, 2, 3):
    try: d = json.load(open(f"{out}/{stamp}-r{r}.json"))
    except Exception as e: print(f"  replique {r} illisible: {e}"); continue
    pts = [(x['layers'], x['full_schedule']['p50_ms']) for x in d['schedule_scaling']['runs']]
    allpts += pts; s, i = fit(pts); inters.append(i)
    res = max(abs(t-(s*L+i)) for L, t in pts)
    comp = (75*s+i) + 74*i
    print(f"{r:>10} {s:10.6f} {i:10.6f} {res:11.4f} {1000/(comp+IO):15.2f}")
if allpts:
    s, i = fit(allpts); comp = (75*s+i) + 74*i
    print(f"{'poole':>10} {s:10.6f} {i:10.6f} {'':>11} {1000/(comp+IO):15.2f}")
    if len(inters) > 1:
        m = sum(inters)/len(inters)
        sd = (sum((x-m)**2 for x in inters)/len(inters))**0.5
        print(f"origine : moyenne {m:.4f} ms, ecart-type {sd:.4f}, etendue {min(inters):.4f}-{max(inters):.4f}")
PYEOF

# ---------- 2. balayage llama.cpp : environ une heure ----------
OUT2="${ROOT}/artifacts/benchmarks/h4-ncmoe/tour231"
mkdir -p "${OUT2}"
echo ""
echo "--- 2/2 balayage llama.cpp t231 ---"
/bin/ps -axo pid=,command= | grep -E "llama-cli|llama-server" | grep -v grep \
  && echo "ATTENTION : processus llama residuel" || echo "aucun processus llama residuel"
if ! python3 scripts/run-h4-ncmoe-sweep-t231.py --dry-run > "${OUT2}/dry-run.json" 2> "${OUT2}/dry-run.err"; then
    echo "ARRET : validation echouee"; cat "${OUT2}/dry-run.err"; exit 1
fi
echo "validation OK ($(wc -c < "${OUT2}/dry-run.json") octets de plan)"
python3 scripts/run-h4-ncmoe-sweep-t231.py >> "${OUT2}/campaign.log" 2>&1
echo "--- balayage termine, statut $? ---"
tail -5 "${OUT2}/campaign.log"
echo "=== LANCER-TOUT fini $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

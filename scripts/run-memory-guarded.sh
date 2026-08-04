#!/usr/bin/env bash

set -euo pipefail

min_free_percent=40
benchmark_min_free_percent=45
max_footprint_gib=48
max_preexisting_swap_mb=256
swap_policy="benchmark"
capture_max_swap_delta_bytes=$((64 * 1024 * 1024))
capacity_io_max_swapin_delta_bytes=$((4 * 16 * 1024))
poll_seconds=0.20
max_wall_seconds=0
log_path=""
output_path=""
swap_observation_path=""
rss_inventory_path=""
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
memory_probe="${repo_root}/build/galactus-process-memory"

usage() {
    echo "usage: $0 [--min-free-percent N] [--max-footprint-gib N] [--max-preexisting-swap-mb N] [--swap-policy capture|benchmark|capacity-io] [--poll-seconds N] [--max-wall-seconds N] --log FILE [--output FILE] [--swap-observation-log FILE --rss-inventory-log FILE] -- COMMAND..." >&2
    exit 2
}

while (($#)); do
    case "$1" in
        --min-free-percent)
            min_free_percent="${2:-}"
            shift 2
            ;;
        --max-footprint-gib)
            max_footprint_gib="${2:-}"
            shift 2
            ;;
        --poll-seconds)
            poll_seconds="${2:-}"
            shift 2
            ;;
        --max-wall-seconds)
            max_wall_seconds="${2:-}"
            shift 2
            ;;
        --max-preexisting-swap-mb)
            max_preexisting_swap_mb="${2:-}"
            shift 2
            ;;
        --swap-policy)
            swap_policy="${2:-}"
            shift 2
            ;;
        --log)
            log_path="${2:-}"
            shift 2
            ;;
        --output)
            output_path="${2:-}"
            shift 2
            ;;
        --swap-observation-log)
            swap_observation_path="${2:-}"
            shift 2
            ;;
        --rss-inventory-log)
            rss_inventory_path="${2:-}"
            shift 2
            ;;
        --)
            shift
            break
            ;;
        *)
            usage
            ;;
    esac
done

if [[ -z "${log_path}" || $# -eq 0 ]]; then
    usage
fi
if [[ ! "${min_free_percent}" =~ ^[0-9]+$ ]] || ((min_free_percent < 1 || min_free_percent > 99)); then
    usage
fi
if [[ ! "${max_footprint_gib}" =~ ^[0-9]+$ ]] || ((max_footprint_gib < 1)); then
    usage
fi
if [[ ! "${max_preexisting_swap_mb}" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
    usage
fi
if [[ "${swap_policy}" != "capture" && "${swap_policy}" != "benchmark" && "${swap_policy}" != "capacity-io" ]]; then
    usage
fi
if [[ "${swap_policy}" != "capture" ]] && ((min_free_percent < benchmark_min_free_percent)); then
    echo "error: ${swap_policy} policy requires --min-free-percent >= ${benchmark_min_free_percent}" >&2
    exit 2
fi
if [[ "${swap_policy}" == "capacity-io" ]]; then
    if [[ -z "${swap_observation_path}" || -z "${rss_inventory_path}" ]]; then
        echo "error: capacity-io policy requires --swap-observation-log and --rss-inventory-log" >&2
        exit 2
    fi
elif [[ -n "${swap_observation_path}" || -n "${rss_inventory_path}" ]]; then
    echo "error: swap observation outputs are reserved for capacity-io policy" >&2
    exit 2
fi
if [[ ! "${poll_seconds}" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
    usage
fi
if [[ ! "${max_wall_seconds}" =~ ^[0-9]+$ ]]; then
    usage
fi

mkdir -p "$(dirname "${log_path}")"
if [[ -n "${output_path}" ]]; then
    mkdir -p "$(dirname "${output_path}")"
fi
if [[ -n "${swap_observation_path}" ]]; then
    mkdir -p "$(dirname "${swap_observation_path}")"
    mkdir -p "$(dirname "${rss_inventory_path}")"
fi
if [[ ! -x "${memory_probe}" ]]; then
    echo "error: missing memory probe: ${memory_probe}; run scripts/build.sh" >&2
    exit 2
fi
max_footprint_bytes=$((max_footprint_gib * 1024 * 1024 * 1024))
child_pid=""
swap_baseline_mb=""
vm_page_size_bytes=""
swapins_baseline_pages=""
swapouts_baseline_pages=""
last_footprint_bytes=0
last_resident_bytes=0
last_free_percent=0
last_swap_used_mb=0
last_swap_used_delta_mb=0
last_swapins_pages=0
last_swapins_delta_pages=0
last_swapin_delta_bytes=0
last_swapouts_pages=0
last_swapouts_delta_pages=0
last_swapout_delta_bytes=0
last_pageins=0
last_diskio_bytesread=0
last_observed_swapins_delta_pages=0

read_swap_used_mb() {
    sysctl -n vm.swapusage | awk '{gsub(/M/, "", $6); print $6}'
}

read_vm_counters() {
    vm_stat | awk '
        NR == 1 {
            for (i = 1; i <= NF; ++i) {
                if ($i == "size" && (i + 2) <= NF) {
                    size = $(i + 2)
                    gsub(/[^0-9]/, "", size)
                    size_seen = 1
                }
            }
        }
        /^Swapins:/  { swapins = $2;  gsub(/[^0-9]/, "", swapins);  swapins_seen = 1 }
        /^Swapouts:/ { swapouts = $2; gsub(/[^0-9]/, "", swapouts); swapouts_seen = 1 }
        END {
            if (!size_seen || !swapins_seen || !swapouts_seen) {
                print "invalid invalid invalid"
                exit
            }
            print size + 0, swapins + 0, swapouts + 0
        }
    '
}

append_event() {
    local event="$1"
    local pid="$2"
    local detail="$3"
    printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${event}" "${pid}" \
        "${last_footprint_bytes}" "${last_resident_bytes}" "${last_free_percent}" \
        "${last_swap_used_mb}" "${swap_baseline_mb:-0}" "${last_swap_used_delta_mb}" \
        "${vm_page_size_bytes:-0}" "${last_swapins_pages}" "${last_swapins_delta_pages}" \
        "${last_swapin_delta_bytes}" "${last_swapouts_pages}" "${last_swapouts_delta_pages}" \
        "${last_swapout_delta_bytes}" "${last_pageins}" "${last_diskio_bytesread}" \
        "${detail}" >>"${log_path}"
}

append_capacity_io_observation() {
    local observed_at="$1"
    printf '%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
        "${observed_at}" "${swapins_baseline_pages}" "${last_swapins_pages}" \
        "${last_swapins_delta_pages}" "${last_swapin_delta_bytes}" \
        "${swapouts_baseline_pages}" "${last_swapouts_pages}" \
        "${last_swapout_delta_bytes}" "${last_swap_used_mb}" \
        >>"${swap_observation_path}"
    ps -axo pid=,ppid=,rss=,command= | awk -v observed_at="${observed_at}" '
        $3 > 1048576 {
            command = $0
            sub(/^[[:space:]]*[0-9]+[[:space:]]+[0-9]+[[:space:]]+[0-9]+[[:space:]]+/, "", command)
            gsub(/\t/, " ", command)
            printf "%s\t%s\t%s\t%s\t%s\n", observed_at, $1, $2, $3, command
        }
    ' >>"${rss_inventory_path}"
}

capacity_io_model_processes() {
    ps -axo pid=,comm=,command= | awk '
        $2 ~ /^python/ && $0 ~ /-m mlx_lm server/ { print; next }
        $2 ~ /^llama-(cli|server)$/ { print; next }
        $2 == "ollama" && $0 ~ /runner/ { print; next }
    '
}

stop_child() {
    local reason="$1"
    if [[ -z "${child_pid}" ]] || ! kill -0 "${child_pid}" 2>/dev/null; then
        return
    fi
    append_event "guard_stop" "${child_pid}" "${reason}"
    kill -TERM "${child_pid}" 2>/dev/null || true
    for _ in {1..20}; do
        if ! kill -0 "${child_pid}" 2>/dev/null; then
            return
        fi
        sleep 0.10
    done
    kill -KILL "${child_pid}" 2>/dev/null || true
}

on_signal() {
    stop_child "supervisor_interrupted"
    exit 130
}
trap on_signal INT TERM HUP

printf 'timestamp,event,pid,physical_footprint_bytes,resident_bytes,system_free_percent,swap_used_mb,swap_baseline_mb,swap_used_delta_mb,vm_page_size_bytes,swapins_pages,swapins_delta_pages,swapin_delta_bytes,swapouts_pages,swapouts_delta_pages,swapout_delta_bytes,pageins,diskio_bytesread,detail\n' >"${log_path}"
if [[ "${swap_policy}" == "capacity-io" ]]; then
    printf 'timestamp,swapins_baseline_pages,swapins_pages,swapins_delta_pages,swapin_delta_bytes,swapouts_baseline_pages,swapouts_pages,swapout_delta_bytes,swap_used_mb\n' >"${swap_observation_path}"
    printf 'timestamp\tpid\tppid\trss_kib\tcommand\n' >"${rss_inventory_path}"
    if [[ -n "$(capacity_io_model_processes)" ]]; then
        append_event "preflight_reject" "0" "model_process_detected"
        echo "error: capacity-io policy is restricted to model-free workloads" >&2
        exit 98
    fi
fi
swap_baseline_mb="$(read_swap_used_mb)"
if [[ ! "${swap_baseline_mb}" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
    append_event "preflight_reject" "0" "swap_baseline_unreadable"
    echo "error: cannot read swap baseline" >&2
    exit 98
fi
read -r vm_page_size_bytes swapins_baseline_pages swapouts_baseline_pages <<<"$(read_vm_counters)"
if [[ ! "${vm_page_size_bytes}" =~ ^[1-9][0-9]*$ ]] || \
        [[ ! "${swapins_baseline_pages}" =~ ^[0-9]+$ ]] || \
        [[ ! "${swapouts_baseline_pages}" =~ ^[0-9]+$ ]]; then
    append_event "preflight_reject" "0" "vm_stat_baseline_unreadable"
    echo "error: cannot read vm_stat swap baselines" >&2
    exit 98
fi
last_swap_used_mb="${swap_baseline_mb}"
last_swapins_pages="${swapins_baseline_pages}"
last_swapouts_pages="${swapouts_baseline_pages}"
if awk -v swap="${swap_baseline_mb}" -v limit="${max_preexisting_swap_mb}" 'BEGIN { exit !(swap > limit) }'; then
    append_event "preflight_reject" "0" "preexisting_swap_above_health_limit"
    echo "error: preexisting swap ${swap_baseline_mb} MiB exceeds health limit ${max_preexisting_swap_mb} MiB" >&2
    exit 98
fi
append_event "preflight" "0" "swap_baseline_accepted:${swap_policy}"
if [[ -n "${output_path}" ]]; then
    "$@" >"${output_path}" 2>&1 &
else
    "$@" &
fi
child_pid=$!
wall_start_seconds=${SECONDS}
append_event "started" "${child_pid}" ""

guard_breached=0
while kill -0 "${child_pid}" 2>/dev/null; do
    memory_values="$("${memory_probe}" "${child_pid}" 2>/dev/null || true)"
    read -r footprint_bytes resident_bytes pageins diskio_bytesread <<<"${memory_values}"
    footprint_bytes="${footprint_bytes:-0}"
    resident_bytes="${resident_bytes:-0}"
    pageins="${pageins:-0}"
    diskio_bytesread="${diskio_bytesread:-0}"
    free_percent="$(memory_pressure -Q | awk '/free percentage/ {gsub(/%/, "", $NF); print $NF}')"
    free_percent="${free_percent:-0}"
    swap_used_mb="$(read_swap_used_mb)"
    swap_used_mb="${swap_used_mb:-0}"
    swap_used_delta_mb="$(awk -v current="${swap_used_mb}" -v baseline="${swap_baseline_mb}" 'BEGIN { printf "%.6f", current - baseline }')"
    read -r current_page_size_bytes swapins_pages swapouts_pages <<<"$(read_vm_counters)"
    if [[ ! "${current_page_size_bytes}" =~ ^[1-9][0-9]*$ ]] || \
            [[ ! "${swapins_pages}" =~ ^[0-9]+$ ]] || \
            [[ ! "${swapouts_pages}" =~ ^[0-9]+$ ]] || \
            [[ "${current_page_size_bytes}" != "${vm_page_size_bytes}" ]]; then
        stop_child "vm_page_size_changed_or_unreadable"
        guard_breached=1
        break
    fi
    swapins_delta_pages=$((swapins_pages - swapins_baseline_pages))
    swapouts_delta_pages=$((swapouts_pages - swapouts_baseline_pages))
    swapin_delta_bytes=$((swapins_delta_pages * vm_page_size_bytes))
    swapout_delta_bytes=$((swapouts_delta_pages * vm_page_size_bytes))
    last_footprint_bytes="${footprint_bytes}"
    last_resident_bytes="${resident_bytes}"
    last_free_percent="${free_percent}"
    last_swap_used_mb="${swap_used_mb}"
    last_swap_used_delta_mb="${swap_used_delta_mb}"
    last_swapins_pages="${swapins_pages}"
    last_swapins_delta_pages="${swapins_delta_pages}"
    last_swapin_delta_bytes="${swapin_delta_bytes}"
    last_swapouts_pages="${swapouts_pages}"
    last_swapouts_delta_pages="${swapouts_delta_pages}"
    last_swapout_delta_bytes="${swapout_delta_bytes}"
    last_pageins="${pageins}"
    last_diskio_bytesread="${diskio_bytesread}"
    append_event "sample" "${child_pid}" ""

    if ((swapins_delta_pages < 0 || swapouts_delta_pages < 0)); then
        stop_child "vm_swap_counter_regressed"
        guard_breached=1
        break
    fi

    if ((max_wall_seconds > 0 && SECONDS - wall_start_seconds >= max_wall_seconds)); then
        stop_child "wall_clock_timeout_exceeded"
        guard_breached=1
        break
    fi
    if ((footprint_bytes > max_footprint_bytes)); then
        stop_child "physical_footprint_limit_exceeded"
        guard_breached=1
        break
    fi
    if ((free_percent < min_free_percent)); then
        stop_child "system_free_memory_below_threshold"
        guard_breached=1
        break
    fi
    if [[ "${swap_policy}" == "benchmark" ]]; then
        max_swapin_delta_bytes=0
        max_swapout_delta_bytes=0
    elif [[ "${swap_policy}" == "capacity-io" ]]; then
        max_swapin_delta_bytes="${capacity_io_max_swapin_delta_bytes}"
        max_swapout_delta_bytes=0
    else
        max_swapin_delta_bytes="${capture_max_swap_delta_bytes}"
        max_swapout_delta_bytes="${capture_max_swap_delta_bytes}"
    fi
    if [[ "${swap_policy}" == "capacity-io" ]]; then
        if [[ -n "$(capacity_io_model_processes)" ]]; then
            stop_child "model_process_detected"
            guard_breached=1
            break
        fi
        if awk -v current="${swap_used_mb}" -v baseline="${swap_baseline_mb}" 'BEGIN { exit !(current != baseline) }'; then
            stop_child "swap_used_changed"
            guard_breached=1
            break
        fi
        if ((swapins_delta_pages > 0 && swapins_delta_pages != last_observed_swapins_delta_pages)); then
            observed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
            append_event "swap_warning" "${child_pid}" "bounded_cumulative_swapin_echo"
            append_capacity_io_observation "${observed_at}"
            last_observed_swapins_delta_pages="${swapins_delta_pages}"
        fi
    fi
    if ((swapin_delta_bytes > max_swapin_delta_bytes)); then
        stop_child "swapin_delta_limit_exceeded"
        guard_breached=1
        break
    fi
    if ((swapout_delta_bytes > max_swapout_delta_bytes)); then
        stop_child "swapout_delta_limit_exceeded"
        guard_breached=1
        break
    fi
    sleep "${poll_seconds}"
done

set +e
wait "${child_pid}"
child_status=$?
set -e
append_event "finished" "${child_pid}" ""

if ((guard_breached)); then
    exit 99
fi
exit "${child_status}"

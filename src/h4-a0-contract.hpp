#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace h4::a0 {

constexpr std::uint64_t kPhysicalMemoryBytes = 137'438'953'472ULL;
constexpr std::uint64_t kMetalRecommendedBytes = 121'056'767'508ULL;
constexpr std::uint64_t kCacheTargetBytes = 95'188'058'112ULL;
constexpr std::uint64_t kConservativeCpuChargeBytes = 212'473'784ULL;
constexpr std::uint64_t kMaximumPhysicalDeltaBytes = 121'843'850'772ULL;
constexpr std::uint64_t kTouchQuantumBytes = 67'108'864ULL;
constexpr std::uint64_t kCacheMilestoneBytes = 8ULL * 1024ULL * 1024ULL * 1024ULL;
constexpr std::uint32_t kPreflightMinimumFreePercent = 89;
constexpr std::uint32_t kRuntimeMinimumFreePercent = 11;
constexpr std::uint32_t kExternalPollMilliseconds = 50;
constexpr std::uint32_t kFinalHoldSeconds = 60;
constexpr std::uint32_t kPageSizeBytes = 16'384;
constexpr std::uint32_t kMinimumHandleCount = 10'760;

enum class Domain {
    metal_shared,
    cpu_physical,
};

struct FixedRung {
    std::string_view id;
    Domain domain;
    std::uint64_t bytes;
};

constexpr std::array<FixedRung, 7> kFixedRungs{{
    {"core-metal", Domain::metal_shared, 14'787'622'912ULL},
    {"core-cpu", Domain::cpu_physical, 535'265'280ULL},
    {"kv-32k-metal", Domain::metal_shared, 3'644'850'176ULL},
    {"compute-32k-metal", Domain::metal_shared, 4'937'295'872ULL},
    {"compute-32k-cpu", Domain::cpu_physical, 251'817'984ULL},
    {"staging-a8-cpu", Domain::cpu_physical, 210'763'776ULL},
    {"runtime-metadata-cpu", Domain::cpu_physical, 1'710'008ULL},
}};

struct CacheSegment {
    std::uint32_t handle_count;
    std::uint32_t large_handle_count;
    std::uint64_t base_length_bytes;
    std::uint64_t payload_bytes;
    std::uint64_t cumulative_payload_bytes;
};

constexpr std::array<CacheSegment, 12> kCacheSegments{{
    {971, 570, 8'846'482ULL, 8'589'934'592ULL, 8'589'934'592ULL},
    {971, 570, 8'846'482ULL, 8'589'934'592ULL, 17'179'869'184ULL},
    {971, 570, 8'846'482ULL, 8'589'934'592ULL, 25'769'803'776ULL},
    {971, 570, 8'846'482ULL, 8'589'934'592ULL, 34'359'738'368ULL},
    {971, 570, 8'846'482ULL, 8'589'934'592ULL, 42'949'672'960ULL},
    {971, 570, 8'846'482ULL, 8'589'934'592ULL, 51'539'607'552ULL},
    {971, 570, 8'846'482ULL, 8'589'934'592ULL, 60'129'542'144ULL},
    {971, 570, 8'846'482ULL, 8'589'934'592ULL, 68'719'476'736ULL},
    {971, 570, 8'846'482ULL, 8'589'934'592ULL, 77'309'411'328ULL},
    {971, 570, 8'846'482ULL, 8'589'934'592ULL, 85'899'345'920ULL},
    {971, 570, 8'846'482ULL, 8'589'934'592ULL, 94'489'280'512ULL},
    {79, 6, 8'845'286ULL, 698'777'600ULL, 95'188'058'112ULL},
}};

constexpr std::uint64_t cache_segment_payload_sum() {
    std::uint64_t total = 0;
    for (const CacheSegment & segment : kCacheSegments) {
        total += segment.payload_bytes;
    }
    return total;
}

constexpr std::uint64_t cache_segment_handle_sum() {
    std::uint64_t total = 0;
    for (const CacheSegment & segment : kCacheSegments) {
        total += segment.handle_count;
    }
    return total;
}

static_assert(cache_segment_payload_sum() == kCacheTargetBytes);
static_assert(cache_segment_handle_sum() == kMinimumHandleCount);

constexpr std::uint64_t sum_domain(Domain domain) {
    std::uint64_t total = 0;
    for (const FixedRung & rung : kFixedRungs) {
        if (rung.domain == domain) {
            total += rung.bytes;
        }
    }
    return total;
}

constexpr std::uint64_t kFixedMetalBytes = sum_domain(Domain::metal_shared);
constexpr std::uint64_t kFixedCpuBytes = sum_domain(Domain::cpu_physical);
constexpr std::uint64_t kFixedPhysicalBytes = kFixedMetalBytes + kFixedCpuBytes;
constexpr std::uint64_t kTargetCurrentAllocatedBytes = kFixedMetalBytes + kCacheTargetBytes;
constexpr std::uint64_t kTargetConservativeMetalChargeBytes =
    kTargetCurrentAllocatedBytes + kConservativeCpuChargeBytes;
constexpr std::uint64_t kTargetPhysicalKnownBytes = kFixedPhysicalBytes + kCacheTargetBytes;
constexpr std::uint64_t kDecisionMarginBytes =
    kMetalRecommendedBytes - kTargetConservativeMetalChargeBytes;

static_assert(kFixedMetalBytes == 23'369'768'960ULL);
static_assert(kFixedCpuBytes == 999'557'048ULL);
static_assert(kFixedPhysicalBytes == 24'369'326'008ULL);
static_assert(kTargetCurrentAllocatedBytes == 118'557'827'072ULL);
static_assert(kTargetConservativeMetalChargeBytes == 118'770'300'856ULL);
static_assert(kTargetPhysicalKnownBytes == 119'557'384'120ULL);
static_assert(kDecisionMarginBytes == 2'286'466'652ULL);

enum class Verdict {
    open_15_physical_envelope,
    closed_observed_under_contract,
    allocation_failure_without_observed_pressure,
    inconclusive_invalid,
};

struct VerdictInputs {
    bool control_valid = false;
    bool exact_target_touched = false;
    bool final_hold_complete = false;
    bool capacity_gate_breached = false;
    bool allocation_failed = false;
    bool pressure_observed = false;
};

constexpr Verdict classify(const VerdictInputs & input) {
    if (!input.control_valid) {
        return Verdict::inconclusive_invalid;
    }
    if (input.allocation_failed && !input.pressure_observed) {
        return Verdict::allocation_failure_without_observed_pressure;
    }
    if (input.capacity_gate_breached || (input.allocation_failed && input.pressure_observed)) {
        return Verdict::closed_observed_under_contract;
    }
    if (input.exact_target_touched && input.final_hold_complete) {
        return Verdict::open_15_physical_envelope;
    }
    return Verdict::inconclusive_invalid;
}

constexpr std::string_view verdict_name(Verdict verdict) {
    switch (verdict) {
        case Verdict::open_15_physical_envelope:
            return "open-15-physical-envelope";
        case Verdict::closed_observed_under_contract:
            return "closed-observed-under-contract";
        case Verdict::allocation_failure_without_observed_pressure:
            return "allocation-failure-without-observed-pressure";
        case Verdict::inconclusive_invalid:
            return "inconclusive-invalid";
    }
    return "inconclusive-invalid";
}

constexpr std::uint64_t splitmix64(std::uint64_t value) {
    value += 0x9e3779b97f4a7c15ULL;
    value = (value ^ (value >> 30U)) * 0xbf58476d1ce4e5b9ULL;
    value = (value ^ (value >> 27U)) * 0x94d049bb133111ebULL;
    return value ^ (value >> 31U);
}

constexpr std::uint64_t pattern_word(
    std::uint64_t resource_ordinal,
    std::uint64_t byte_offset
) {
    return splitmix64((resource_ordinal << 32U) ^ (byte_offset >> 3U));
}

}  // namespace h4::a0

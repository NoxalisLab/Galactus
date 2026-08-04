#pragma once

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

namespace galactus::c1_contract {

constexpr std::array<int, 5> BATCH_SIZES{1, 2, 4, 6, 8};
constexpr std::array<std::array<int, 5>, 2> WARMUP_ORDERS{{
    {{1, 2, 4, 6, 8}},
    {{8, 6, 4, 2, 1}},
}};
constexpr std::array<std::array<int, 5>, 7> MEASURED_ORDERS{{
    {{1, 2, 4, 6, 8}},
    {{2, 4, 6, 8, 1}},
    {{4, 6, 8, 1, 2}},
    {{6, 8, 1, 2, 4}},
    {{8, 1, 2, 4, 6}},
    {{1, 2, 4, 6, 8}},
    {{8, 6, 4, 2, 1}},
}};
constexpr int CYCLIC_SHIFT = 1;
constexpr std::size_t INPUT_WIDTH = 6144;

enum class GateStatus {
    pass,
    fail,
    vacuous,
};

struct GateResult {
    GateStatus status = GateStatus::fail;
    bool pairwise_distinct = false;
    bool cyclic_equivariant = false;
    std::string reason;
};

struct DigestIdentityResult {
    bool pass = false;
    std::size_t occurrence_count = 0;
    std::string reference;
    std::vector<std::size_t> mismatch_indices;
    std::string reason;
};

inline const char * gate_status_name(GateStatus status) {
    switch (status) {
        case GateStatus::pass: return "pass";
        case GateStatus::fail: return "fail";
        case GateStatus::vacuous: return "vacuous";
    }
    return "fail";
}

inline std::vector<float> make_canonical_inputs(int batch_size) {
    if (batch_size < 1 || batch_size > 8) {
        throw std::invalid_argument("C1 batch size must be in [1,8]");
    }
    std::vector<float> values(INPUT_WIDTH * static_cast<std::size_t>(batch_size));
    for (int position = 0; position < batch_size; ++position) {
        const std::size_t base = static_cast<std::size_t>(position) * INPUT_WIDTH;
        for (std::size_t coordinate = 8; coordinate < INPUT_WIDTH; ++coordinate) {
            const std::uint64_t mixed =
                (coordinate * UINT64_C(6364136223846793005) + UINT64_C(1442695040888963407))
                >> 40U;
            values.at(base + coordinate) =
                static_cast<float>(static_cast<double>(mixed) / 16777216.0 - 0.5) * 0.02F;
        }
        values.at(base + static_cast<std::size_t>(position)) = 1.0F;
    }
    return values;
}

inline std::vector<float> cyclic_shift_inputs(
    const std::vector<float> & canonical,
    int batch_size) {
    const std::size_t expected = INPUT_WIDTH * static_cast<std::size_t>(batch_size);
    if (canonical.size() != expected) {
        throw std::invalid_argument("C1 canonical input size mismatch");
    }
    std::vector<float> shifted(expected);
    for (int destination = 0; destination < batch_size; ++destination) {
        const int source = (destination + CYCLIC_SHIFT) % batch_size;
        std::copy_n(
            canonical.begin() + static_cast<std::ptrdiff_t>(source) *
                static_cast<std::ptrdiff_t>(INPUT_WIDTH),
            INPUT_WIDTH,
            shifted.begin() + static_cast<std::ptrdiff_t>(destination) *
                static_cast<std::ptrdiff_t>(INPUT_WIDTH));
    }
    return shifted;
}

inline bool equal_position(
    const std::vector<std::uint8_t> & left,
    std::size_t left_position,
    const std::vector<std::uint8_t> & right,
    std::size_t right_position,
    std::size_t bytes_per_position) {
    const auto left_begin = left.begin() + static_cast<std::ptrdiff_t>(
        left_position * bytes_per_position);
    const auto right_begin = right.begin() + static_cast<std::ptrdiff_t>(
        right_position * bytes_per_position);
    return std::equal(left_begin, left_begin + static_cast<std::ptrdiff_t>(bytes_per_position),
                      right_begin);
}

inline GateResult evaluate_gate(
    const std::vector<std::uint8_t> & canonical_outputs,
    const std::vector<std::uint8_t> & shifted_outputs,
    int batch_size,
    std::size_t bytes_per_position) {
    GateResult result;
    if (batch_size == 1) {
        result.status = GateStatus::vacuous;
        result.reason = "K=1 has no non-trivial positional permutation";
        return result;
    }
    if (batch_size < 1 || bytes_per_position == 0 ||
        canonical_outputs.size() != bytes_per_position * static_cast<std::size_t>(batch_size) ||
        shifted_outputs.size() != canonical_outputs.size()) {
        result.reason = "invalid output geometry";
        return result;
    }

    result.pairwise_distinct = true;
    for (int left = 0; left < batch_size && result.pairwise_distinct; ++left) {
        for (int right = left + 1; right < batch_size; ++right) {
            if (equal_position(canonical_outputs, static_cast<std::size_t>(left),
                               canonical_outputs, static_cast<std::size_t>(right),
                               bytes_per_position)) {
                result.pairwise_distinct = false;
                break;
            }
        }
    }

    result.cyclic_equivariant = true;
    for (int destination = 0; destination < batch_size; ++destination) {
        const int source = (destination + CYCLIC_SHIFT) % batch_size;
        if (!equal_position(shifted_outputs, static_cast<std::size_t>(destination),
                            canonical_outputs, static_cast<std::size_t>(source),
                            bytes_per_position)) {
            result.cyclic_equivariant = false;
            break;
        }
    }
    if (result.pairwise_distinct && result.cyclic_equivariant) {
        result.status = GateStatus::pass;
        result.reason = "all positions distinct and cyclically equivariant";
    } else if (!result.pairwise_distinct) {
        result.reason = "at least two canonical output positions are identical";
    } else {
        result.reason = "shifted output is not the exact cyclic permutation";
    }
    return result;
}

inline DigestIdentityResult evaluate_digest_identity(
    const std::vector<std::string> & digests,
    std::size_t expected_occurrence_count) {
    DigestIdentityResult result;
    result.occurrence_count = digests.size();
    if (expected_occurrence_count < 2 || digests.size() != expected_occurrence_count) {
        result.reason = "digest occurrence count mismatch";
        return result;
    }
    result.reference = digests.front();
    if (result.reference.empty()) {
        result.reason = "empty digest reference";
        return result;
    }
    for (std::size_t index = 1; index < digests.size(); ++index) {
        if (digests.at(index) != result.reference) {
            result.mismatch_indices.push_back(index);
        }
    }
    result.pass = result.mismatch_indices.empty();
    result.reason = result.pass
        ? "all output digests are bitwise-identical"
        : "at least one output digest differs from the reference";
    return result;
}

inline std::array<int, 5> measured_slot_sums() {
    std::array<int, 5> sums{};
    for (const auto & round : MEASURED_ORDERS) {
        for (std::size_t slot = 0; slot < round.size(); ++slot) {
            const auto found = std::find(BATCH_SIZES.begin(), BATCH_SIZES.end(), round.at(slot));
            if (found == BATCH_SIZES.end()) {
                throw std::logic_error("C1 schedule contains an unknown K");
            }
            sums.at(static_cast<std::size_t>(found - BATCH_SIZES.begin())) +=
                static_cast<int>(slot);
        }
    }
    return sums;
}

inline std::array<int, 5> measured_slot_variance_numerators() {
    std::array<int, 5> numerators{};
    for (const auto & round : MEASURED_ORDERS) {
        for (std::size_t slot = 0; slot < round.size(); ++slot) {
            const auto found = std::find(BATCH_SIZES.begin(), BATCH_SIZES.end(), round.at(slot));
            if (found == BATCH_SIZES.end()) {
                throw std::logic_error("C1 schedule contains an unknown K");
            }
            const int centered = static_cast<int>(slot) - 2;
            numerators.at(static_cast<std::size_t>(found - BATCH_SIZES.begin())) +=
                centered * centered;
        }
    }
    return numerators;
}

} // namespace galactus::c1_contract

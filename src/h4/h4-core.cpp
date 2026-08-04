#include "h4-core.hpp"

#include <algorithm>
#include <array>
#include <limits>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <utility>

namespace galactus::h4 {
namespace {

constexpr std::array<std::uint64_t, 75> layer_record_bytes = {
    9'732'096, 9'732'096, 9'732'096, 11'304'960, 9'732'096, 13'172'736,
    11'304'960, 9'732'096, 9'732'096, 9'732'096, 9'732'096, 9'732'096,
    9'732'096, 9'732'096, 9'732'096, 9'732'096, 9'732'096, 9'732'096,
    9'732'096, 9'732'096, 9'732'096, 9'732'096, 9'732'096, 9'732'096,
    9'732'096, 9'732'096, 11'304'960, 9'732'096, 9'732'096, 9'732'096,
    9'732'096, 9'732'096, 9'732'096, 9'732'096, 9'732'096, 9'732'096,
    11'304'960, 11'304'960, 11'304'960, 11'304'960, 11'304'960, 11'304'960,
    11'304'960, 11'304'960, 11'304'960, 11'304'960, 9'732'096, 9'732'096,
    9'732'096, 9'732'096, 9'732'096, 9'732'096, 9'732'096, 9'732'096,
    9'732'096, 9'732'096, 9'732'096, 9'732'096, 9'732'096, 9'732'096,
    9'732'096, 9'732'096, 9'732'096, 9'732'096, 9'732'096, 11'304'960,
    9'732'096, 11'304'960, 9'732'096, 11'304'960, 11'304'960, 11'304'960,
    13'172'736, 13'172'736, 13'172'736,
};

template <typename Integer>
Integer read_little_endian(std::istream & input, const char * field) {
    static_assert(std::is_unsigned_v<Integer>);
    std::array<unsigned char, sizeof(Integer)> bytes{};
    input.read(reinterpret_cast<char *>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
    if (!input) {
        throw std::runtime_error(std::string("truncated miss sequence at ") + field);
    }
    Integer value = 0;
    for (std::size_t index = 0; index < bytes.size(); ++index) {
        value |= static_cast<Integer>(bytes[index]) << (8U * index);
    }
    return value;
}

void validate_key(std::uint32_t key) {
    const std::uint32_t layer = key >> 8U;
    const std::uint32_t expert = key & 0xffU;
    if (layer < minimum_routed_layer || layer > maximum_routed_layer || expert >= experts_per_layer) {
        throw std::runtime_error("miss sequence contains a key outside the routed-expert domain");
    }
}

std::uint64_t checked_add(std::uint64_t left, std::uint64_t right, const char * operation) {
    if (right > std::numeric_limits<std::uint64_t>::max() - left) {
        throw std::overflow_error(operation);
    }
    return left + right;
}

} // namespace

const std::array<std::uint64_t, 75> & frozen_layer_record_bytes() noexcept {
    return layer_record_bytes;
}

SplitRecordPlan plan_p0_split(std::uint64_t record_bytes, P0Profile profile) {
    if (record_bytes == 0 || record_bytes % record_alignment_bytes != 0) {
        throw std::invalid_argument("P0 record size must be a positive multiple of 16 KiB");
    }
    const std::uint64_t blocks = record_bytes / record_alignment_bytes;
    std::uint64_t internal_blocks = 0;
    if (profile == P0Profile::v1_599_401) {
        if (blocks > (std::numeric_limits<std::uint64_t>::max() - 500) / 599) {
            throw std::overflow_error("P0 block split overflow");
        }
        internal_blocks = (blocks * 599 + 500) / 1000;
    } else {
        // Jointly selected literal P0v2 cut points. Do not derive these by
        // per-class rounding: 576 minimizes the aggregate large-class error.
        switch (record_bytes) {
        case 9'732'096: internal_blocks = 425; break;
        case 11'304'960: internal_blocks = 494; break;
        case 13'172'736: internal_blocks = 576; break;
        default: throw std::invalid_argument("P0v2 has no frozen split for this record size");
        }
    }
    const std::uint64_t external_blocks = blocks - internal_blocks;
    return {
        internal_blocks * record_alignment_bytes,
        external_blocks * record_alignment_bytes,
    };
}

Volume P1Placement::assign(std::uint64_t record_bytes) {
    if (record_bytes == 0 || record_bytes % record_alignment_bytes != 0) {
        throw std::invalid_argument("P1 record size must be a positive multiple of 16 KiB");
    }
    const std::uint64_t next_internal = checked_add(internal_bytes_, record_bytes, "P1 internal byte overflow");
    const std::uint64_t next_external = checked_add(external_bytes_, record_bytes, "P1 external byte overflow");
    const auto internal_score = static_cast<unsigned __int128>(next_internal) * 401U;
    const auto external_score = static_cast<unsigned __int128>(next_external) * 599U;
    if (internal_score <= external_score) {
        internal_bytes_ = next_internal;
        return Volume::internal;
    }
    external_bytes_ = next_external;
    return Volume::external;
}

std::uint64_t P1Placement::internal_bytes() const noexcept {
    return internal_bytes_;
}

std::uint64_t P1Placement::external_bytes() const noexcept {
    return external_bytes_;
}

Volume CanonicalP1Placement::assign(
    std::uint32_t layer,
    std::uint32_t expert,
    std::uint64_t record_bytes) {
    constexpr std::uint32_t routed_layer_count = maximum_routed_layer - minimum_routed_layer + 1;
    constexpr std::uint32_t record_count = routed_layer_count * experts_per_layer;
    if (assigned_records_ >= record_count) {
        throw std::logic_error("canonical P1 placement already contains all routed experts");
    }
    const std::uint32_t expected_layer = minimum_routed_layer + assigned_records_ / experts_per_layer;
    const std::uint32_t expected_expert = assigned_records_ % experts_per_layer;
    if (layer != expected_layer || expert != expected_expert) {
        throw std::invalid_argument("P1 records must be assigned in canonical layer/expert order");
    }
    const auto volume = placement_.assign(record_bytes);
    ++assigned_records_;
    return volume;
}

std::uint32_t CanonicalP1Placement::assigned_records() const noexcept {
    return assigned_records_;
}

bool CanonicalP1Placement::complete() const noexcept {
    constexpr std::uint32_t routed_layer_count = maximum_routed_layer - minimum_routed_layer + 1;
    return assigned_records_ == routed_layer_count * experts_per_layer;
}

std::uint64_t CanonicalP1Placement::internal_bytes() const noexcept {
    return placement_.internal_bytes();
}

std::uint64_t CanonicalP1Placement::external_bytes() const noexcept {
    return placement_.external_bytes();
}

std::vector<MissToken> read_miss_sequence(
    std::istream & input,
    std::uint32_t expected_tokens,
    std::uint16_t maximum_misses_per_token) {
    std::vector<MissToken> result;
    result.reserve(expected_tokens);
    for (std::uint32_t expected_index = 0; expected_index < expected_tokens; ++expected_index) {
        const auto token_index = read_little_endian<std::uint32_t>(input, "token index");
        const auto miss_count = read_little_endian<std::uint16_t>(input, "miss count");
        if (token_index != expected_index) {
            throw std::runtime_error("miss sequence token indices are not contiguous from zero");
        }
        if (miss_count > maximum_misses_per_token) {
            throw std::runtime_error("miss count exceeds the configured per-token maximum");
        }
        MissToken token{token_index, {}};
        token.keys.reserve(miss_count);
        for (std::uint16_t miss = 0; miss < miss_count; ++miss) {
            const auto key = read_little_endian<std::uint32_t>(input, "miss key");
            validate_key(key);
            token.keys.push_back(key);
        }
        result.push_back(std::move(token));
    }
    if (input.peek() != std::char_traits<char>::eof()) {
        throw std::runtime_error("miss sequence contains trailing bytes");
    }
    return result;
}

std::uint64_t conservative_inflight_payload_bytes(
    std::uint32_t queue_depth_per_volume,
    std::uint64_t maximum_record_bytes) {
    if (queue_depth_per_volume == 0 || maximum_record_bytes == 0) {
        throw std::invalid_argument("queue depth and maximum record bytes must be positive");
    }
    const auto one_volume = static_cast<unsigned __int128>(queue_depth_per_volume) * maximum_record_bytes;
    const auto both_volumes = one_volume * 2U;
    if (both_volumes > std::numeric_limits<std::uint64_t>::max()) {
        throw std::overflow_error("in-flight payload byte calculation overflow");
    }
    return static_cast<std::uint64_t>(both_volumes);
}

RingPlan plan_ring(
    std::uint32_t requested_queue_depth_per_volume,
    std::uint64_t maximum_record_bytes,
    std::uint64_t configured_ring_limit_bytes) {
    if (requested_queue_depth_per_volume == 0 || maximum_record_bytes == 0) {
        throw std::invalid_argument("requested queue depth and maximum record bytes must be positive");
    }
    if (configured_ring_limit_bytes == 0 || configured_ring_limit_bytes % record_alignment_bytes != 0) {
        throw std::invalid_argument("ring limit must be a positive multiple of 16 KiB");
    }
    if (configured_ring_limit_bytes > hard_ring_buffer_limit_bytes) {
        throw std::invalid_argument("ring limit exceeds the frozen 2 GiB hard ceiling");
    }
    if (maximum_record_bytes > std::numeric_limits<std::uint64_t>::max() / 2U) {
        throw std::overflow_error("maximum record size cannot be represented for two volumes");
    }
    const std::uint64_t bytes_per_queue_depth = maximum_record_bytes * 2U;
    const std::uint64_t maximum_queue_depth = configured_ring_limit_bytes / bytes_per_queue_depth;
    if (maximum_queue_depth == 0) {
        throw std::invalid_argument("ring limit cannot hold one maximum-sized record per volume");
    }
    const auto effective_queue_depth = static_cast<std::uint32_t>(
        std::min<std::uint64_t>(requested_queue_depth_per_volume, maximum_queue_depth));
    const auto inflight_bytes = conservative_inflight_payload_bytes(effective_queue_depth, maximum_record_bytes);
    if (inflight_bytes > configured_ring_limit_bytes) {
        throw std::logic_error("ring planner exceeded its configured byte ceiling");
    }
    return {
        configured_ring_limit_bytes,
        requested_queue_depth_per_volume,
        effective_queue_depth,
        inflight_bytes,
        effective_queue_depth != requested_queue_depth_per_volume,
    };
}

} // namespace galactus::h4

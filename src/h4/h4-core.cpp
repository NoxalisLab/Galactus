#include "h4-core.hpp"
#include "h4-profile.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <utility>

namespace galactus::h4 {
namespace {

// (table GLM-5.2 retiree : la verite vit dans h4-profile.cpp, profil integre)

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
    const std::uint32_t layer = key >> key_expert_bits;
    const std::uint32_t expert = key & key_expert_mask;
    // Domaine du MODELE, pas capacite d'encodage : un expert au-dela de
    // profile.experts n'existe pas et doit etre rejete.
    const auto & profile = ModelProfile::active();
    if (layer < profile.first_layer || layer > profile.last_layer || expert >= profile.experts) {
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

const std::vector<std::uint64_t> & frozen_layer_record_bytes() noexcept {
    return ModelProfile::active().record_bytes;
}

SplitRecordPlan plan_p0_split(std::uint64_t record_bytes, P0Profile profile) {
    if (record_bytes == 0 || record_bytes % record_alignment_bytes != 0) {
        throw std::invalid_argument("P0 record size must be a positive multiple of 16 KiB");
    }
    const std::uint64_t blocks = record_bytes / record_alignment_bytes;
    std::uint64_t internal_blocks = 0;
    if (profile == P0Profile::single_volume) {
        // Un seul SSD : l'enregistrement entier vit sur le volume interne.
        return { blocks * record_alignment_bytes, 0 };
    }
    if (profile == P0Profile::v1_599_401) {
        if (blocks > (std::numeric_limits<std::uint64_t>::max() - 500) / 599) {
            throw std::overflow_error("P0 block split overflow");
        }
        internal_blocks = (blocks * 599 + 500) / 1000;
    } else {
        // Jointly selected literal P0v2 cut points for the frozen GLM-5.2
        // classes. Do not derive these by per-class rounding: 576 minimizes
        // the aggregate large-class error.
        switch (record_bytes) {
        case 9'732'096: internal_blocks = 425; break;
        case 11'304'960: internal_blocks = 494; break;
        case 13'172'736: internal_blocks = 576; break;
        default:
            // Generic dual packs (app install, any MoE model): the cut MUST
            // reproduce scripts/galactus-pack-plan.py --volumes dual, i.e.
            // round(blocks * 0.7157) with Python's round() semantics
            // (ties-to-even). nearbyint under FE_TONEAREST matches exactly.
            internal_blocks = static_cast<std::uint64_t>(
                std::nearbyint(static_cast<double>(blocks) * 0.7157));
            internal_blocks = std::min(internal_blocks, blocks);
            break;
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
    // Le placement parcourt les enregistrements REELS du modele : couches et
    // experts viennent du profil actif, jamais de la capacite d'encodage.
    const auto & profile = ModelProfile::active();
    const std::uint32_t record_count = profile.layer_count() * profile.experts;
    if (assigned_records_ >= record_count) {
        throw std::logic_error("canonical P1 placement already contains all routed experts");
    }
    const std::uint32_t expected_layer = profile.first_layer + assigned_records_ / profile.experts;
    const std::uint32_t expected_expert = assigned_records_ % profile.experts;
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
    const auto & profile = ModelProfile::active();
    return assigned_records_ == profile.layer_count() * profile.experts;
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

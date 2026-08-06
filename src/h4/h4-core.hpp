#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <istream>
#include <vector>

namespace galactus::h4 {

constexpr std::uint64_t record_alignment_bytes = 16'384;
// Encodage des clefs : une clef est (couche << key_expert_bits) | expert.
// 10 bits d'expert = 1024 au maximum structurel (Qwen3-Next : 512 par couche ;
// GLM saturait exactement les 8 bits historiques a 256).
constexpr std::uint32_t key_expert_bits = 10;
constexpr std::uint32_t key_expert_mask = (1U << key_expert_bits) - 1U;
// CAPACITE D'ENCODAGE, jamais le nombre d'experts du modele. Ne sert qu'a
// dimensionner les tableaux indexes par (clef & key_expert_mask), pour qu'une
// clef hors domaine reste dans les bornes. Le nombre REEL d'experts par couche
// est ModelProfile::active().experts, et la plage de couches
// ModelProfile::active().first_layer .. last_layer (voir h4-profile.hpp).
constexpr std::uint32_t key_expert_capacity = 1U << key_expert_bits;
constexpr std::uint64_t hard_ring_buffer_limit_bytes = 2'147'483'648;
constexpr std::uint64_t hard_process_footprint_limit_bytes = 6'442'450'944;

// Table des enregistrements par couche du PROFIL ACTIF (voir h4-profile.hpp).
// Nom historique conserve : gelee signifie desormais immuable une fois le
// profil charge, et non plus codee en dur GLM-5.2.
[[nodiscard]] const std::vector<std::uint64_t> & frozen_layer_record_bytes() noexcept;

enum class P0Profile {
    v1_599_401,
    v2_7157_2843,
    single_volume,   // un seul SSD : tout l'enregistrement sur le volume interne
};

struct SplitRecordPlan {
    std::uint64_t internal_bytes;
    std::uint64_t external_bytes;
};

SplitRecordPlan plan_p0_split(
    std::uint64_t record_bytes,
    P0Profile profile = P0Profile::v1_599_401);

enum class Volume {
    internal,
    external,
};

class P1Placement {
public:
    Volume assign(std::uint64_t record_bytes);
    [[nodiscard]] std::uint64_t internal_bytes() const noexcept;
    [[nodiscard]] std::uint64_t external_bytes() const noexcept;

private:
    std::uint64_t internal_bytes_ = 0;
    std::uint64_t external_bytes_ = 0;
};

class CanonicalP1Placement {
public:
    Volume assign(std::uint32_t layer, std::uint32_t expert, std::uint64_t record_bytes);
    [[nodiscard]] std::uint32_t assigned_records() const noexcept;
    [[nodiscard]] bool complete() const noexcept;
    [[nodiscard]] std::uint64_t internal_bytes() const noexcept;
    [[nodiscard]] std::uint64_t external_bytes() const noexcept;

private:
    P1Placement placement_;
    std::uint32_t assigned_records_ = 0;
};

struct MissToken {
    std::uint32_t token_index;
    std::vector<std::uint32_t> keys;
};

std::vector<MissToken> read_miss_sequence(
    std::istream & input,
    std::uint32_t expected_tokens,
    std::uint16_t maximum_misses_per_token = 600);

std::uint64_t conservative_inflight_payload_bytes(
    std::uint32_t queue_depth_per_volume,
    std::uint64_t maximum_record_bytes);

struct RingPlan {
    std::uint64_t ring_limit_bytes;
    std::uint32_t requested_queue_depth_per_volume;
    std::uint32_t effective_queue_depth_per_volume;
    std::uint64_t maximum_inflight_payload_bytes;
    bool queue_depth_clamped;
};

RingPlan plan_ring(
    std::uint32_t requested_queue_depth_per_volume,
    std::uint64_t maximum_record_bytes,
    std::uint64_t configured_ring_limit_bytes = hard_ring_buffer_limit_bytes);

} // namespace galactus::h4

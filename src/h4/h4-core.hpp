#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <istream>
#include <string>
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

// ---------------------------------------------------------------- dual split
//
// A dual pack cuts every record at round(blocks * ratio) blocks, ties to even.
// The packer (scripts/galactus-pack-plan.py) and the reader MUST land on the
// same number for every single record, or the engine reads the wrong bytes off
// one of the two volumes and nothing says so. Three things keep them agreed:
//
//   1. ONE FORMULA. Python round() on a float is ties-to-even;
//      std::nearbyint under FE_TONEAREST is the same function. The engine
//      checks the rounding mode instead of trusting it.
//   2. ONE VALUE. The ratio travels as a decimal string of at most
//      p0_ratio_decimals fractional digits. Python float() and C strtod are
//      both correctly rounded, so both recover the SAME IEEE double from that
//      spelling. Producers quantise; consumers only parse.
//   3. ONE PROOF. The pack writer records the ratio and the resulting totals
//      beside the pack (see SplitSidecar); the engine recomputes the layout at
//      load and refuses to start when its totals do not reproduce them. A
//      disagreement on any record moves the total, so it cannot stay silent.

// P0v2, the historical dual cut. Every pack written before the ratio became a
// runtime value used exactly this number, so it stays the fallback: an already
// installed model keeps loading byte for byte as it did.
inline constexpr double p0v2_default_ratio = 0.7157;

// Usable bounds for a runtime ratio. Outside them one volume carries so little
// of each record that the read it still costs is pure overhead (0.05 is a 19:1
// bandwidth gap, past anything a pair of SSDs shows), and a degenerate 0 or 1
// would produce a pack whose other half is empty. A ratio outside the bounds,
// or not finite, is a failed measurement: callers fall back to
// p0v2_default_ratio rather than write something nothing can read.
inline constexpr double p0_ratio_minimum = 0.05;
inline constexpr double p0_ratio_maximum = 0.95;
// Fractional digits the ratio is quantised to by whoever produces it. Four is
// far finer than the bandwidth probe's own noise and keeps the decimal
// spelling short enough to read in a log.
inline constexpr int p0_ratio_decimals = 4;

// True when `ratio` is finite and inside [p0_ratio_minimum, p0_ratio_maximum].
[[nodiscard]] bool p0_ratio_usable(double ratio) noexcept;

// `ratio` when usable, p0v2_default_ratio otherwise. The single fallback point
// for a bandwidth measurement that failed or a degenerate 0 / 1.
[[nodiscard]] double sanitized_p0_ratio(double ratio) noexcept;

enum class P0Profile {
    v1_599_401,
    v2_7157_2843,    // legacy GLM-5.2 dual pack: frozen literal cut points
    single_volume,   // un seul SSD : tout l'enregistrement sur le volume interne
    dual_ratio,      // generic dual pack: round(blocks * ratio), ties to even
};

struct SplitRecordPlan {
    std::uint64_t internal_bytes;
    std::uint64_t external_bytes;
};

// `ratio` is read only by P0Profile::dual_ratio. The other profiles carry
// their cut in their own definition and ignore it.
SplitRecordPlan plan_p0_split(
    std::uint64_t record_bytes,
    P0Profile profile = P0Profile::v1_599_401,
    double ratio = p0v2_default_ratio);

// What the pack writer left beside the internal pack: the ratio the records
// were actually cut at, and the totals that ratio produced. Flat text on
// purpose, like the engine profile sidecar: the engine parses it without a
// JSON library.
struct SplitSidecar {
    bool dual = false;
    double ratio = 0.0;              // meaningful only when dual
    std::uint64_t records = 0;
    std::uint64_t internal_bytes = 0;
    std::uint64_t external_bytes = 0;
};

// The sidecar path for an internal pack: "<pack>.split".
[[nodiscard]] std::string split_sidecar_path(const std::string & internal_pack_path);

// Loads the sidecar. Returns false when the file simply does not exist, which
// is what every pack written before this record existed looks like. THROWS
// when the file exists but does not parse: a corrupt record is not a missing
// one, and reading a dual pack at the wrong ratio is exactly the failure this
// whole mechanism exists to prevent.
[[nodiscard]] bool load_split_sidecar(const std::string & path, SplitSidecar & out);

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

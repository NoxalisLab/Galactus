#include "h4-core.hpp"
#include "h4-profile.hpp"

#include <algorithm>
#include <array>
#include <cfenv>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <limits>
#include <sstream>
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

// THE cut. Every dual record on the generic path goes through this function
// and nothing else, so there is exactly one place where the packer and the
// reader can disagree, and it is three lines long.
//
// It must reproduce scripts/galactus-pack-plan.py, i.e. Python
// round(blocks * ratio): a double multiply, then round-half-to-even.
// std::nearbyint IS round-half-to-even, but only under FE_TONEAREST. That is
// the default rounding mode, and a caller who changed it would silently move
// the cut of every record in the pack, so it is checked rather than assumed.
std::uint64_t generic_dual_cut(std::uint64_t blocks, double ratio) {
    if (std::fegetround() != FE_TONEAREST) {
        throw std::runtime_error(
            "P0 dual split requires the FE_TONEAREST rounding mode: the packer rounds "
            "ties to even and any other mode would cut records elsewhere");
    }
    const double cut = std::nearbyint(static_cast<double>(blocks) * ratio);
    return std::min(static_cast<std::uint64_t>(cut), blocks);
}

std::string ratio_text(double ratio) {
    std::ostringstream out;
    // 17 significant digits round-trip any IEEE double, so a mismatch message
    // never shows two values that print the same.
    out.precision(17);
    out << ratio;
    return out.str();
}

} // namespace

bool p0_ratio_usable(double ratio) noexcept {
    return std::isfinite(ratio) && ratio >= p0_ratio_minimum && ratio <= p0_ratio_maximum;
}

double sanitized_p0_ratio(double ratio) noexcept {
    return p0_ratio_usable(ratio) ? ratio : p0v2_default_ratio;
}

std::string split_sidecar_path(const std::string & internal_pack_path) {
    return internal_pack_path + ".split";
}

bool load_split_sidecar(const std::string & path, SplitSidecar & out) {
    std::ifstream in(path);
    if (!in) {
        return false;   // pack written before this record existed
    }
    auto fail = [&](const std::string & why) {
        throw std::runtime_error("split sidecar (" + path + "): " + why);
    };
    std::string magic;
    int version = 0;
    in >> magic >> version;
    if (magic != "galactus-split" || version != 1) fail("en-tete inconnu");
    SplitSidecar parsed;
    bool ended = false;
    bool has_volumes = false;
    bool has_ratio = false;
    std::string key;
    while (in >> key) {
        if (key == "volumes") {
            std::string mode;
            in >> mode;
            if (mode != "dual" && mode != "single") fail("volumes inconnu: " + mode);
            parsed.dual = mode == "dual";
            has_volumes = true;
        } else if (key == "ratio") {
            std::string text;
            in >> text;
            char * stop = nullptr;
            // strtod is correctly rounded, and so is Python float(): the same
            // decimal spelling therefore yields the same double on both sides.
            parsed.ratio = std::strtod(text.c_str(), &stop);
            if (stop == text.c_str() || (stop != nullptr && *stop != '\0')) {
                fail("ratio illisible: " + text);
            }
            has_ratio = true;
        } else if (key == "records") {
            in >> parsed.records;
        } else if (key == "internal_bytes") {
            in >> parsed.internal_bytes;
        } else if (key == "external_bytes") {
            in >> parsed.external_bytes;
        } else if (key == "end") {
            ended = true;
            break;
        } else {
            fail("clef inconnue " + key);
        }
        if (!in) fail("lecture interrompue");
    }
    if (!ended) fail("fin de fichier sans 'end'");
    if (!has_volumes) fail("champ 'volumes' absent");
    if (parsed.dual) {
        if (!has_ratio) fail("pack dual sans champ 'ratio'");
        if (!p0_ratio_usable(parsed.ratio)) {
            fail("ratio " + ratio_text(parsed.ratio) + " hors bornes ["
                 + ratio_text(p0_ratio_minimum) + ", " + ratio_text(p0_ratio_maximum) + "]");
        }
        if (parsed.external_bytes == 0) fail("pack dual sans octets externes");
    } else if (parsed.external_bytes != 0) {
        fail("pack mono-volume avec des octets externes");
    }
    if (parsed.records == 0 || parsed.internal_bytes == 0) fail("totaux vides");
    out = parsed;
    return true;
}

const std::vector<std::uint64_t> & frozen_layer_record_bytes() noexcept {
    return ModelProfile::active().record_bytes;
}

SplitRecordPlan plan_p0_split(std::uint64_t record_bytes, P0Profile profile, double ratio) {
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
    } else if (profile == P0Profile::dual_ratio) {
        // Generic dual pack: the cut comes from the measured bandwidths, and
        // the ONLY thing the reader is allowed to do with it is reproduce
        // scripts/galactus-pack-plan.py. No per-record special case lives on
        // this path: a literal exception here would apply to models the packer
        // never gave one to. Refuse an unusable ratio outright instead of
        // quietly substituting a default, because the caller has already had
        // its chance to fall back (sanitized_p0_ratio) and a cut that differs
        // from the pack's is worse than not starting.
        if (!p0_ratio_usable(ratio)) {
            throw std::invalid_argument(
                "P0 dual split ratio " + ratio_text(ratio) + " is outside ["
                + ratio_text(p0_ratio_minimum) + ", " + ratio_text(p0_ratio_maximum) + "]");
        }
        internal_blocks = generic_dual_cut(blocks, ratio);
    } else {
        // LEGACY P0v2, and legacy only: the packs that carry no ratio record.
        // Jointly selected literal cut points for the frozen GLM-5.2 classes.
        // Do not derive these by per-class rounding: 576 minimizes the
        // aggregate large-class error, and it is NOT what round(804 * 0.7157)
        // gives (575). That divergence is precisely why these literals may
        // never leak onto the generic path above.
        switch (record_bytes) {
        case 9'732'096: internal_blocks = 425; break;
        case 11'304'960: internal_blocks = 494; break;
        case 13'172'736: internal_blocks = 576; break;
        default:
            internal_blocks = generic_dual_cut(blocks, p0v2_default_ratio);
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

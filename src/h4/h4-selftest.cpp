#include "h4-core.hpp"
#include "h4-profile.hpp"
#include "h4-reader.hpp"

#include <array>
#include <cerrno>
#include <cstdlib>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <unistd.h>
#include <vector>

namespace {

void require(bool condition, const char * message) {
    if (!condition) {
        throw std::runtime_error(message);
    }
}

template <typename Integer>
void append_little_endian(std::string & output, Integer value) {
    static_assert(std::is_unsigned_v<Integer>);
    for (std::size_t index = 0; index < sizeof(Integer); ++index) {
        output.push_back(static_cast<char>((value >> (8U * index)) & 0xffU));
    }
}

std::uint64_t fnv1a(const unsigned char * data, std::size_t size) {
    std::uint64_t value = 14'695'981'039'346'656'037ULL;
    for (std::size_t index = 0; index < size; ++index) {
        value ^= data[index];
        value *= 1'099'511'628'211ULL;
    }
    return value;
}

class TemporaryFile {
public:
    explicit TemporaryFile(unsigned char seed) {
        char pattern[] = "/tmp/galactus-h4-reader-XXXXXX";
        const int descriptor = mkstemp(pattern);
        if (descriptor < 0) {
            throw std::runtime_error(std::string("mkstemp failed: ") + std::strerror(errno));
        }
        path_ = pattern;
        std::vector<unsigned char> payload(2U * galactus::h4::record_alignment_bytes);
        for (std::size_t index = 0; index < payload.size(); ++index) {
            payload[index] = static_cast<unsigned char>(seed + index % 251U);
        }
        std::size_t completed = 0;
        while (completed < payload.size()) {
            const auto written = pwrite(
                descriptor,
                payload.data() + completed,
                payload.size() - completed,
                static_cast<off_t>(completed));
            if (written < 0) {
                const auto message = std::string("pwrite failed: ") + std::strerror(errno);
                close(descriptor);
                unlink(path_.c_str());
                throw std::runtime_error(message);
            }
            completed += static_cast<std::size_t>(written);
        }
        close(descriptor);
        first_checksum_ = fnv1a(payload.data(), galactus::h4::record_alignment_bytes);
        second_checksum_ = fnv1a(
            payload.data() + galactus::h4::record_alignment_bytes,
            galactus::h4::record_alignment_bytes);
    }

    ~TemporaryFile() {
        if (!path_.empty()) {
            unlink(path_.c_str());
        }
    }

    TemporaryFile(const TemporaryFile &) = delete;
    TemporaryFile & operator=(const TemporaryFile &) = delete;

    [[nodiscard]] const std::string & path() const noexcept {
        return path_;
    }

    [[nodiscard]] std::uint64_t first_checksum() const noexcept {
        return first_checksum_;
    }

    [[nodiscard]] std::uint64_t second_checksum() const noexcept {
        return second_checksum_;
    }

private:
    std::string path_;
    std::uint64_t first_checksum_ = 0;
    std::uint64_t second_checksum_ = 0;
};

} // namespace

int main() {
    using namespace galactus::h4;

    const auto small = plan_p0_split(9'732'096);
    const auto medium = plan_p0_split(11'304'960);
    const auto large = plan_p0_split(13'172'736);
    require(small.internal_bytes / record_alignment_bytes == 356, "invalid small P0 internal split");
    require(small.external_bytes / record_alignment_bytes == 238, "invalid small P0 external split");
    require(medium.internal_bytes / record_alignment_bytes == 413, "invalid medium P0 internal split");
    require(medium.external_bytes / record_alignment_bytes == 277, "invalid medium P0 external split");
    require(large.internal_bytes / record_alignment_bytes == 482, "invalid large P0 internal split");
    require(large.external_bytes / record_alignment_bytes == 322, "invalid large P0 external split");

    const auto v2_small = plan_p0_split(9'732'096, P0Profile::v2_7157_2843);
    const auto v2_medium = plan_p0_split(11'304'960, P0Profile::v2_7157_2843);
    const auto v2_large = plan_p0_split(13'172'736, P0Profile::v2_7157_2843);
    require(v2_small.internal_bytes / record_alignment_bytes == 425, "invalid small P0v2 internal split");
    require(v2_small.external_bytes / record_alignment_bytes == 169, "invalid small P0v2 external split");
    require(v2_medium.internal_bytes / record_alignment_bytes == 494, "invalid medium P0v2 internal split");
    require(v2_medium.external_bytes / record_alignment_bytes == 196, "invalid medium P0v2 external split");
    require(v2_large.internal_bytes / record_alignment_bytes == 576, "invalid large P0v2 internal split");
    require(v2_large.external_bytes / record_alignment_bytes == 228, "invalid large P0v2 external split");

    // Enumeration des experts REELS du profil actif (integre : GLM-5.2, donc
    // 75 couches x 256 experts = 19 200 enregistrements).
    const auto & profile = ModelProfile::active();
    const auto & layer_bytes = frozen_layer_record_bytes();
    CanonicalP1Placement placement;
    for (std::uint32_t layer_index = 0; layer_index < layer_bytes.size(); ++layer_index) {
        const auto bytes = layer_bytes[layer_index];
        for (std::uint32_t expert = 0; expert < profile.experts; ++expert) {
            placement.assign(profile.first_layer + layer_index, expert, bytes);
        }
    }
    require(placement.complete(), "canonical P1 placement is incomplete");
    require(placement.assigned_records() == 19'200, "canonical P1 record count mismatch");
    require(placement.internal_bytes() == 118'379'053'056, "P1 internal byte total mismatch");
    require(placement.external_bytes() == 79'248'162'816, "P1 external byte total mismatch");

    bool rejected_out_of_order = false;
    try {
        CanonicalP1Placement invalid_placement;
        invalid_placement.assign(profile.first_layer, 1, layer_bytes[0]);
    } catch (const std::invalid_argument &) {
        rejected_out_of_order = true;
    }
    require(rejected_out_of_order, "canonical P1 accepted an out-of-order expert");

    std::string encoded;
    append_little_endian<std::uint32_t>(encoded, 0);
    append_little_endian<std::uint16_t>(encoded, 2);
    append_little_endian<std::uint32_t>(encoded, (3U << key_expert_bits) | 7U);
    append_little_endian<std::uint32_t>(encoded, (77U << key_expert_bits) | 255U);
    append_little_endian<std::uint32_t>(encoded, 1);
    append_little_endian<std::uint16_t>(encoded, 0);
    std::istringstream input(encoded);
    const auto tokens = read_miss_sequence(input, 2);
    require(tokens.size() == 2, "miss token count mismatch");
    require(tokens[0].keys.size() == 2, "miss key count mismatch");
    require(tokens[1].keys.empty(), "zero-miss token mismatch");

    require(
        conservative_inflight_payload_bytes(32, 13'172'736) == 843'055'104,
        "in-flight payload bound mismatch");

    const auto full_ring = plan_ring(80, 13'172'736);
    require(full_ring.effective_queue_depth_per_volume == 80, "2 GiB ring unexpectedly clamped QD80");
    require(full_ring.maximum_inflight_payload_bytes == 2'107'637'760, "QD80 payload bound mismatch");
    require(!full_ring.queue_depth_clamped, "QD80 clamp flag mismatch");

    const auto bounded_degradation = plan_ring(32, 13'172'736, 64U * 1024U * 1024U);
    require(bounded_degradation.effective_queue_depth_per_volume == 2, "64 MiB ring must clamp QD32 to QD2");
    require(bounded_degradation.maximum_inflight_payload_bytes == 52'690'944, "clamped payload mismatch");
    require(bounded_degradation.queue_depth_clamped, "bounded degradation clamp flag missing");

    bool rejected_oversized_ring = false;
    try {
        static_cast<void>(plan_ring(32, 13'172'736, hard_ring_buffer_limit_bytes + record_alignment_bytes));
    } catch (const std::invalid_argument &) {
        rejected_oversized_ring = true;
    }
    require(rejected_oversized_ring, "ring planner accepted a ceiling above 2 GiB");

    bool rejected_undersized_ring = false;
    try {
        static_cast<void>(plan_ring(1, 13'172'736, record_alignment_bytes));
    } catch (const std::invalid_argument &) {
        rejected_undersized_ring = true;
    }
    require(rejected_undersized_ring, "ring planner accepted less than one record per volume");

    const P0Layout p0_layout(layer_bytes);
    require(p0_layout.internal_bytes() == 118'405'201'920, "P0 internal file size mismatch");
    require(p0_layout.external_bytes() == 79'222'013'952, "P0 external file size mismatch");
    const MissToken planned_token{7, {(3U << key_expert_bits), (77U << key_expert_bits) | 255U}};
    const auto planned_reads = p0_layout.plan_token(planned_token, 100);
    require(planned_reads.size() == 4, "P0 must emit two reads per missed record");
    require(planned_reads.front().request_id == 100, "P0 first request identifier mismatch");
    require(planned_reads.back().request_id == 103, "P0 last request identifier mismatch");
    require(planned_reads[0].volume == Volume::internal, "P0 first slice must target internal storage");
    require(planned_reads[1].volume == Volume::external, "P0 second slice must target external storage");

    const P0Layout p0v2_layout(layer_bytes, P0Profile::v2_7157_2843);
    require(p0v2_layout.internal_bytes() == 141'436'125'184, "P0v2 internal file size mismatch");
    require(p0v2_layout.external_bytes() == 56'191'090'688, "P0v2 external file size mismatch");
    const auto planned_v2_reads = p0v2_layout.plan_token(planned_token, 300);
    require(planned_v2_reads.size() == 4, "P0v2 must emit two reads per missed record");
    require(planned_v2_reads[0].length == 425U * record_alignment_bytes, "P0v2 small internal slice mismatch");
    require(planned_v2_reads[1].length == 169U * record_alignment_bytes, "P0v2 small external slice mismatch");
    require(planned_v2_reads[2].length == 576U * record_alignment_bytes, "P0v2 large internal slice mismatch");
    require(planned_v2_reads[3].length == 228U * record_alignment_bytes, "P0v2 large external slice mismatch");

    const P1Layout p1_layout(layer_bytes);
    require(p1_layout.internal_bytes() == 118'379'053'056, "P1 layout internal file size mismatch");
    require(p1_layout.external_bytes() == 79'248'162'816, "P1 layout external file size mismatch");
    const auto planned_p1_reads = p1_layout.plan_token(planned_token, 200);
    require(planned_p1_reads.size() == 2, "P1 must emit one read per missed record");
    require(planned_p1_reads.front().request_id == 200, "P1 first request identifier mismatch");
    require(planned_p1_reads.back().request_id == 201, "P1 last request identifier mismatch");

    TemporaryFile internal_fixture(17);
    TemporaryFile external_fixture(93);
    DualVolumeReader reader(
        internal_fixture.path(),
        external_fixture.path(),
        32,
        record_alignment_bytes,
        64U * 1024U,
        false);
    require(reader.ring_plan().effective_queue_depth_per_volume == 2, "fixture reader QD clamp mismatch");
    auto internal_read = reader.submit({1, Volume::internal, 0, record_alignment_bytes, true});
    auto external_read = reader.submit({2, Volume::external, record_alignment_bytes, record_alignment_bytes, true});
    const auto internal_result = internal_read.get();
    const auto external_result = external_read.get();
    require(internal_result.bytes_read == record_alignment_bytes, "internal fixture read length mismatch");
    require(external_result.bytes_read == record_alignment_bytes, "external fixture read length mismatch");
    require(internal_result.checksum == internal_fixture.first_checksum(), "internal fixture checksum mismatch");
    require(external_result.checksum == external_fixture.second_checksum(), "external fixture checksum mismatch");
    require(
        internal_result.completed_at_ns >= internal_result.submitted_at_ns &&
            internal_result.completion_latency_ns ==
                internal_result.completed_at_ns - internal_result.submitted_at_ns,
        "internal request latency timestamps mismatch");
    require(
        external_result.completed_at_ns >= external_result.submitted_at_ns &&
            external_result.completion_latency_ns ==
                external_result.completed_at_ns - external_result.submitted_at_ns,
        "external request latency timestamps mismatch");
    require(reader.queue_metrics(Volume::internal).submitted_requests == 1, "internal queue metrics mismatch");
    require(reader.queue_metrics(Volume::external).submitted_requests == 1, "external queue metrics mismatch");

    bool rejected_unaligned_read = false;
    try {
        static_cast<void>(reader.submit({3, Volume::internal, 1, record_alignment_bytes, false}));
    } catch (const std::invalid_argument &) {
        rejected_unaligned_read = true;
    }
    require(rejected_unaligned_read, "dual-volume reader accepted an unaligned request");

    std::cout << "h4-selftest: ok\n";
    return 0;
}

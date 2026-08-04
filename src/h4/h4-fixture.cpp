#include "h4-core.hpp"
#include "h4-reader.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cerrno>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <future>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <thread>
#include <unistd.h>
#include <vector>

namespace {

using galactus::h4::DualVolumeReader;
using galactus::h4::MissToken;
using galactus::h4::P0Layout;
using galactus::h4::P1Layout;
using galactus::h4::QueueMetrics;
using galactus::h4::ReadRequest;
using galactus::h4::Volume;

constexpr int usage_exit_code = 64;
constexpr int validation_exit_code = 65;
constexpr int expected_ring_rejection_exit_code = 66;
constexpr std::uint64_t maximum_record_bytes = 13'172'736;

struct Options {
    std::string fixture;
    std::string internal_directory;
    std::string external_directory;
    std::string miss_sequence;
};

[[noreturn]] void usage() {
    std::cerr
        << "usage: galactus-h4-fixture --fixture success|qd-clamp|ring-reject|guard-child "
           "[--internal-dir DIR --external-dir DIR --miss-sequence FILE]\n";
    std::exit(usage_exit_code);
}

Options parse_options(int argc, char ** argv) {
    Options options;
    for (int index = 1; index < argc; ++index) {
        const std::string argument = argv[index];
        if (argument == "--fixture" && index + 1 < argc) {
            options.fixture = argv[++index];
        } else if (argument == "--internal-dir" && index + 1 < argc) {
            options.internal_directory = argv[++index];
        } else if (argument == "--external-dir" && index + 1 < argc) {
            options.external_directory = argv[++index];
        } else if (argument == "--miss-sequence" && index + 1 < argc) {
            options.miss_sequence = argv[++index];
        } else {
            usage();
        }
    }
    if (options.fixture.empty()) {
        usage();
    }
    return options;
}

std::runtime_error system_error(const std::string & operation) {
    return std::runtime_error(operation + ": " + std::strerror(errno));
}

std::uint64_t fnv1a(const unsigned char * data, std::size_t size) {
    std::uint64_t value = 14'695'981'039'346'656'037ULL;
    for (std::size_t index = 0; index < size; ++index) {
        value ^= data[index];
        value *= 1'099'511'628'211ULL;
    }
    return value;
}

class SparseFixtureFile {
public:
    SparseFixtureFile(const std::string & directory, const std::string & label, std::uint64_t size) {
        if (size > static_cast<std::uint64_t>(std::numeric_limits<off_t>::max())) {
            throw std::invalid_argument("fixture file size exceeds off_t");
        }
        std::string pattern = directory + "/galactus-h4-" + label + "-XXXXXX";
        std::vector<char> mutable_pattern(pattern.begin(), pattern.end());
        mutable_pattern.push_back('\0');
        descriptor_ = mkstemp(mutable_pattern.data());
        if (descriptor_ < 0) {
            throw system_error("cannot create sparse H4 fixture file");
        }
        path_ = mutable_pattern.data();
        if (ftruncate(descriptor_, static_cast<off_t>(size)) != 0) {
            const auto error = system_error("cannot size sparse H4 fixture file");
            close(descriptor_);
            descriptor_ = -1;
            unlink(path_.c_str());
            throw error;
        }
    }

    ~SparseFixtureFile() {
        if (descriptor_ >= 0) {
            close(descriptor_);
        }
        if (!path_.empty()) {
            unlink(path_.c_str());
        }
    }

    SparseFixtureFile(const SparseFixtureFile &) = delete;
    SparseFixtureFile & operator=(const SparseFixtureFile &) = delete;

    [[nodiscard]] const std::string & path() const noexcept {
        return path_;
    }

    std::uint64_t write_pattern(std::uint64_t offset, std::uint64_t length, unsigned char seed) {
        if (length > std::numeric_limits<std::size_t>::max() ||
            offset > static_cast<std::uint64_t>(std::numeric_limits<off_t>::max()) - length) {
            throw std::invalid_argument("fixture region cannot be represented");
        }
        std::vector<unsigned char> payload(static_cast<std::size_t>(length));
        for (std::size_t index = 0; index < payload.size(); ++index) {
            payload[index] = static_cast<unsigned char>(seed + index % 251U);
        }
        std::size_t completed = 0;
        while (completed < payload.size()) {
            const auto written = pwrite(
                descriptor_,
                payload.data() + completed,
                payload.size() - completed,
                static_cast<off_t>(offset + completed));
            if (written < 0) {
                if (errno == EINTR) {
                    continue;
                }
                throw system_error("cannot write H4 fixture region");
            }
            if (written == 0) {
                throw std::runtime_error("zero-length write while creating H4 fixture");
            }
            completed += static_cast<std::size_t>(written);
        }
        return fnv1a(payload.data(), payload.size());
    }

private:
    int descriptor_ = -1;
    std::string path_;
};

std::uint32_t nearest_rank_queue_depth(const QueueMetrics & metrics, std::uint32_t percentile) {
    if (percentile == 0 || percentile > 100 || metrics.submitted_requests == 0) {
        return 0;
    }
    const auto rank = (static_cast<std::uint64_t>(percentile) * metrics.submitted_requests + 99U) / 100U;
    std::uint64_t cumulative = 0;
    for (std::uint32_t depth = 0; depth < metrics.pending_depth_histogram.size(); ++depth) {
        cumulative += metrics.pending_depth_histogram[depth];
        if (cumulative >= rank) {
            return depth;
        }
    }
    throw std::logic_error("queue histogram does not cover submitted requests");
}

double nearest_rank_latency(std::vector<double> values, double quantile) {
    if (values.empty() || quantile <= 0.0 || quantile > 1.0) {
        throw std::invalid_argument("invalid latency percentile input");
    }
    std::sort(values.begin(), values.end());
    const auto rank = static_cast<std::size_t>(std::ceil(quantile * static_cast<double>(values.size())));
    return values.at(rank - 1U);
}

void verify_result(
    std::future<galactus::h4::ReadResult> future,
    std::uint64_t expected_bytes,
    std::uint64_t expected_checksum) {
    const auto result = future.get();
    if (result.bytes_read != expected_bytes || !result.checksum_computed || result.checksum != expected_checksum) {
        throw std::runtime_error("fixture checksum verification failed");
    }
}

int run_qd_clamp(const Options & options) {
    if (options.internal_directory.empty() || options.external_directory.empty()) {
        usage();
    }
    SparseFixtureFile internal(options.internal_directory, "qd-int", maximum_record_bytes);
    SparseFixtureFile external(options.external_directory, "qd-ext", maximum_record_bytes);
    DualVolumeReader reader(
        internal.path(), external.path(), 32, maximum_record_bytes, 64U * 1024U * 1024U, true);
    const auto & plan = reader.ring_plan();
    if (!plan.queue_depth_clamped || plan.effective_queue_depth_per_volume != 2 ||
        plan.maximum_inflight_payload_bytes != 52'690'944) {
        throw std::runtime_error("QD clamp fixture did not reproduce the frozen plan");
    }
    // Leave one bounded observation window after both volume pools have been
    // allocated and touched so the external guard can sample the stable peak.
    std::this_thread::sleep_for(std::chrono::milliseconds(250));
    std::cout
        << "{\n"
        << "  \"schema_version\": 1,\n"
        << "  \"fixture\": \"fixture-qd-clamp\",\n"
        << "  \"status\": \"passed\",\n"
        << "  \"requested_qd_per_volume\": 32,\n"
        << "  \"effective_qd_per_volume\": 2,\n"
        << "  \"ring_limit_bytes\": 67108864,\n"
        << "  \"maximum_inflight_payload_bytes\": 52690944,\n"
        << "  \"f_nocache_internal\": " << (reader.f_nocache_applied(Volume::internal) ? "true" : "false") << ",\n"
        << "  \"f_nocache_external\": " << (reader.f_nocache_applied(Volume::external) ? "true" : "false") << "\n"
        << "}\n";
    return 0;
}

int run_ring_reject() {
    bool oversized_rejected = false;
    bool undersized_rejected = false;
    try {
        static_cast<void>(galactus::h4::plan_ring(
            32, maximum_record_bytes,
            galactus::h4::hard_ring_buffer_limit_bytes + galactus::h4::record_alignment_bytes));
    } catch (const std::invalid_argument &) {
        oversized_rejected = true;
    }
    try {
        static_cast<void>(galactus::h4::plan_ring(1, maximum_record_bytes, galactus::h4::record_alignment_bytes));
    } catch (const std::invalid_argument &) {
        undersized_rejected = true;
    }
    if (!oversized_rejected || !undersized_rejected) {
        throw std::runtime_error("ring rejection fixture did not reject both invalid limits");
    }
    std::cout
        << "{\n"
        << "  \"schema_version\": 1,\n"
        << "  \"fixture\": \"fixture-ring-reject\",\n"
        << "  \"status\": \"expected-rejection\",\n"
        << "  \"oversized_rejected_before_allocation\": true,\n"
        << "  \"undersized_rejected_before_allocation\": true,\n"
        << "  \"exit_code\": " << expected_ring_rejection_exit_code << "\n"
        << "}\n";
    return expected_ring_rejection_exit_code;
}

int run_guard_child() {
    std::this_thread::sleep_for(std::chrono::seconds(30));
    return 0;
}

int run_success(const Options & options) {
    if (options.internal_directory.empty() || options.external_directory.empty() || options.miss_sequence.empty()) {
        usage();
    }
    const auto & layer_bytes = galactus::h4::frozen_layer_record_bytes();
    const P0Layout p0(layer_bytes);
    const P1Layout p1(layer_bytes);
    SparseFixtureFile p0_internal(options.internal_directory, "p0-int", p0.internal_bytes());
    SparseFixtureFile p0_external(options.external_directory, "p0-ext", p0.external_bytes());
    SparseFixtureFile p1_internal(options.internal_directory, "p1-int", p1.internal_bytes());
    SparseFixtureFile p1_external(options.external_directory, "p1-ext", p1.external_bytes());

    const std::vector<std::uint32_t> sentinel_keys = {(3U << 8U), (6U << 8U), (8U << 8U)};
    struct Verification {
        ReadRequest request;
        std::uint64_t checksum;
    };
    std::vector<Verification> p0_verifications;
    std::vector<Verification> p1_verifications;
    std::uint64_t request_id = 0;
    unsigned char seed = 1;
    for (const auto key : sentinel_keys) {
        const auto & location = p0.lookup(key);
        const auto internal_checksum = p0_internal.write_pattern(
            location.internal_offset, location.internal_length, seed++);
        const auto external_checksum = p0_external.write_pattern(
            location.external_offset, location.external_length, seed++);
        p0_verifications.push_back({
            {request_id++, Volume::internal, location.internal_offset, location.internal_length, true},
            internal_checksum,
        });
        p0_verifications.push_back({
            {request_id++, Volume::external, location.external_offset, location.external_length, true},
            external_checksum,
        });

        const auto & p1_location = p1.lookup(key);
        auto & file = p1_location.volume == Volume::internal ? p1_internal : p1_external;
        const auto checksum = file.write_pattern(p1_location.offset, p1_location.length, seed++);
        p1_verifications.push_back({
            {request_id++, p1_location.volume, p1_location.offset, p1_location.length, true},
            checksum,
        });
    }

    {
        DualVolumeReader reader(
            p1_internal.path(), p1_external.path(), 2, maximum_record_bytes,
            64U * 1024U * 1024U, true);
        for (const auto & verification : p1_verifications) {
            verify_result(reader.submit(verification.request), verification.request.length, verification.checksum);
        }
    }

    std::ifstream sequence_stream(options.miss_sequence, std::ios::binary);
    if (!sequence_stream) {
        throw std::runtime_error("cannot open locked doc17 miss sequence");
    }
    const auto tokens = galactus::h4::read_miss_sequence(sequence_stream, 256);
    DualVolumeReader reader(
        p0_internal.path(), p0_external.path(), 8, maximum_record_bytes,
        256U * 1024U * 1024U, true);
    for (const auto & verification : p0_verifications) {
        verify_result(reader.submit(verification.request), verification.request.length, verification.checksum);
    }

    std::uint64_t total_bytes = 0;
    std::uint64_t total_requests = 0;
    std::vector<double> token_latencies_ms;
    token_latencies_ms.reserve(tokens.size());
    const auto replay_start = std::chrono::steady_clock::now();
    for (const MissToken & token : tokens) {
        const auto token_start = std::chrono::steady_clock::now();
        auto requests = p0.plan_token(token, request_id);
        request_id += requests.size();
        std::vector<std::future<galactus::h4::ReadResult>> futures;
        futures.reserve(requests.size());
        for (const auto & request : requests) {
            total_bytes += request.length;
            ++total_requests;
            futures.push_back(reader.submit(request));
        }
        for (std::size_t index = 0; index < futures.size(); ++index) {
            const auto result = futures[index].get();
            if (result.bytes_read != requests[index].length || result.checksum_computed) {
                throw std::runtime_error("unexpected replay read result");
            }
        }
        const auto token_end = std::chrono::steady_clock::now();
        token_latencies_ms.push_back(
            std::chrono::duration<double, std::milli>(token_end - token_start).count());
    }
    const auto replay_end = std::chrono::steady_clock::now();
    if (total_bytes != 157'479'075'840 || total_requests != 30'518) {
        throw std::runtime_error("doc17 replay totals do not match the frozen manifest");
    }
    const auto elapsed_seconds = std::chrono::duration<double>(replay_end - replay_start).count();
    const auto internal_metrics = reader.queue_metrics(Volume::internal);
    const auto external_metrics = reader.queue_metrics(Volume::external);
    std::cout
        << "{\n"
        << "  \"schema_version\": 1,\n"
        << "  \"fixture\": \"fixture-success\",\n"
        << "  \"status\": \"passed-reader-only-guard-telemetry-external\",\n"
        << "  \"sparse_zero_fill\": true,\n"
        << "  \"performance_interpretation\": \"functional-non-representative\",\n"
        << "  \"logical_gbps_representative_of_ssd\": false,\n"
        << "  \"latency_metrics_representative_of_ssd\": false,\n"
        << "  \"document\": 17,\n"
        << "  \"tokens\": 256,\n"
        << "  \"misses\": 15259,\n"
        << "  \"read_requests\": " << total_requests << ",\n"
        << "  \"logical_bytes_read\": " << total_bytes << ",\n"
        << "  \"elapsed_seconds\": " << elapsed_seconds << ",\n"
        << "  \"logical_gbps\": " << (static_cast<double>(total_bytes) / 1.0e9 / elapsed_seconds) << ",\n"
        << "  \"token_completion_p50_ms\": " << nearest_rank_latency(token_latencies_ms, 0.50) << ",\n"
        << "  \"token_completion_p95_ms\": " << nearest_rank_latency(token_latencies_ms, 0.95) << ",\n"
        << "  \"requested_qd_per_volume\": 8,\n"
        << "  \"effective_qd_per_volume\": " << reader.ring_plan().effective_queue_depth_per_volume << ",\n"
        << "  \"ring_limit_bytes\": 268435456,\n"
        << "  \"maximum_inflight_payload_bytes\": " << reader.ring_plan().maximum_inflight_payload_bytes << ",\n"
        << "  \"p0_sentinel_ranges_verified\": 6,\n"
        << "  \"p1_sentinel_records_verified\": 3,\n"
        << "  \"f_nocache_internal\": " << (reader.f_nocache_applied(Volume::internal) ? "true" : "false") << ",\n"
        << "  \"f_nocache_external\": " << (reader.f_nocache_applied(Volume::external) ? "true" : "false") << ",\n"
        << "  \"internal_queue_p95_depth\": " << nearest_rank_queue_depth(internal_metrics, 95) << ",\n"
        << "  \"external_queue_p95_depth\": " << nearest_rank_queue_depth(external_metrics, 95) << ",\n"
        << "  \"internal_backpressure_events\": " << internal_metrics.submit_backpressure_events << ",\n"
        << "  \"external_backpressure_events\": " << external_metrics.submit_backpressure_events << "\n"
        << "}\n";
    return 0;
}

} // namespace

int main(int argc, char ** argv) {
    try {
        const auto options = parse_options(argc, argv);
        if (options.fixture == "qd-clamp") {
            return run_qd_clamp(options);
        }
        if (options.fixture == "ring-reject") {
            return run_ring_reject();
        }
        if (options.fixture == "guard-child") {
            return run_guard_child();
        }
        if (options.fixture == "success") {
            return run_success(options);
        }
        usage();
    } catch (const std::exception & error) {
        std::cerr << "fixture error: " << error.what() << '\n';
        return validation_exit_code;
    }
}

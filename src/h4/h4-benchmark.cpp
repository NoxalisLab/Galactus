#include "h4-profile.hpp"
#include "h4-reader.hpp"

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <future>
#include <iomanip>
#include <iostream>
#include <libproc.h>
#include <sstream>
#include <limits>
#include <random>
#include <stdexcept>
#include <string>
#include <sys/resource.h>
#include <sys/stat.h>
#include <utility>
#include <unistd.h>
#include <vector>

namespace {

using galactus::h4::DualVolumeReader;
using galactus::h4::ModelProfile;
using galactus::h4::P0Layout;
using galactus::h4::P0Profile;
using galactus::h4::P1Layout;
using galactus::h4::QueueMetrics;
using galactus::h4::ReadRequest;
using galactus::h4::ReadResult;
using galactus::h4::Volume;

constexpr std::uint64_t maximum_record_bytes = 13'172'736;
constexpr std::uint64_t histogram_maximum_us = 5'000'000;

struct Options {
    std::string layout;
    std::string internal_file;
    std::string external_file;
    std::uint32_t queue_depth = 0;
    std::uint64_t chunk_bytes = 0;
    double minimum_seconds = 0.0;
    double maximum_seconds = 0.0;
    std::uint64_t minimum_logical_bytes = 0;
    std::uint64_t seed = 0;
    std::string timeseries_file;
    std::string active_volume = "both";
    std::string io_policy = "unchanged";
    std::string p0_profile = "v1";
};

std::string require_value(int argc, char ** argv, int & index, const std::string & option) {
    if (++index >= argc) {
        throw std::invalid_argument("missing value for " + option);
    }
    return argv[index];
}

std::uint64_t parse_u64(const std::string & text, const std::string & option) {
    std::size_t consumed = 0;
    const auto value = std::stoull(text, &consumed, 10);
    if (consumed != text.size()) {
        throw std::invalid_argument("invalid integer for " + option + ": " + text);
    }
    return value;
}

double parse_double(const std::string & text, const std::string & option) {
    std::size_t consumed = 0;
    const auto value = std::stod(text, &consumed);
    if (consumed != text.size() || !std::isfinite(value)) {
        throw std::invalid_argument("invalid number for " + option + ": " + text);
    }
    return value;
}

Options parse_options(int argc, char ** argv) {
    Options options;
    for (int index = 1; index < argc; ++index) {
        const std::string option = argv[index];
        if (option == "--layout") {
            options.layout = require_value(argc, argv, index, option);
        } else if (option == "--internal-file") {
            options.internal_file = require_value(argc, argv, index, option);
        } else if (option == "--external-file") {
            options.external_file = require_value(argc, argv, index, option);
        } else if (option == "--qd") {
            const auto value = parse_u64(require_value(argc, argv, index, option), option);
            if (value > std::numeric_limits<std::uint32_t>::max()) {
                throw std::invalid_argument("--qd exceeds uint32");
            }
            options.queue_depth = static_cast<std::uint32_t>(value);
        } else if (option == "--chunk-bytes") {
            options.chunk_bytes = parse_u64(require_value(argc, argv, index, option), option);
        } else if (option == "--minimum-seconds") {
            options.minimum_seconds = parse_double(require_value(argc, argv, index, option), option);
        } else if (option == "--maximum-seconds") {
            options.maximum_seconds = parse_double(require_value(argc, argv, index, option), option);
        } else if (option == "--minimum-logical-bytes") {
            options.minimum_logical_bytes = parse_u64(require_value(argc, argv, index, option), option);
        } else if (option == "--seed") {
            options.seed = parse_u64(require_value(argc, argv, index, option), option);
        } else if (option == "--timeseries-file") {
            options.timeseries_file = require_value(argc, argv, index, option);
        } else if (option == "--active-volume") {
            options.active_volume = require_value(argc, argv, index, option);
        } else if (option == "--io-policy") {
            options.io_policy = require_value(argc, argv, index, option);
        } else if (option == "--p0-profile") {
            options.p0_profile = require_value(argc, argv, index, option);
        } else {
            throw std::invalid_argument("unknown option: " + option);
        }
    }
    if (options.layout != "p0" && options.layout != "p1") {
        throw std::invalid_argument("--layout must be p0 or p1");
    }
    if (options.internal_file.empty() || options.external_file.empty()) {
        throw std::invalid_argument("--internal-file and --external-file are required");
    }
    if (options.queue_depth == 0 || options.minimum_seconds <= 0.0 ||
        options.maximum_seconds < options.minimum_seconds || options.minimum_logical_bytes == 0) {
        throw std::invalid_argument("invalid qd/duration/byte thresholds");
    }
    if (options.chunk_bytes != 0 &&
        (options.chunk_bytes > maximum_record_bytes ||
         options.chunk_bytes % galactus::h4::record_alignment_bytes != 0)) {
        throw std::invalid_argument("--chunk-bytes must be zero/native or a 16 KiB multiple <= max record");
    }
    if (!options.timeseries_file.empty() && options.chunk_bytes != 0) {
        throw std::invalid_argument("--timeseries-file is restricted to native requests");
    }
    if (options.active_volume != "both" && options.active_volume != "internal" &&
        options.active_volume != "external") {
        throw std::invalid_argument("--active-volume must be both, internal or external");
    }
    if (options.layout != "p0" && options.active_volume != "both") {
        throw std::invalid_argument("single-volume mode is restricted to P0");
    }
    if (options.io_policy != "unchanged" && options.io_policy != "important") {
        throw std::invalid_argument("--io-policy must be unchanged or important");
    }
    if (options.p0_profile != "v1" && options.p0_profile != "v2") {
        throw std::invalid_argument("--p0-profile must be v1 or v2");
    }
    if (options.layout != "p0" && options.p0_profile != "v1") {
        throw std::invalid_argument("--p0-profile v2 is restricted to P0");
    }
    return options;
}

std::uint64_t checked_file_size(const std::string & path) {
    struct stat status {};
    if (stat(path.c_str(), &status) != 0) {
        throw std::runtime_error("cannot stat pack: " + path);
    }
    if (!S_ISREG(status.st_mode) || status.st_size < 0) {
        throw std::runtime_error("pack is not a regular non-negative file: " + path);
    }
    return static_cast<std::uint64_t>(status.st_size);
}

std::uint64_t process_diskio_bytesread() {
    rusage_info_v4 usage = {};
    if (proc_pid_rusage(getpid(), RUSAGE_INFO_V4, reinterpret_cast<rusage_info_t *>(&usage)) != 0) {
        throw std::runtime_error("proc_pid_rusage failed: " + std::string(std::strerror(errno)));
    }
    return usage.ri_diskio_bytesread;
}

class LatencyHistogram {
public:
    LatencyHistogram() : bins_(histogram_maximum_us + 1U, 0) {}

    void add_ns(std::uint64_t nanoseconds) {
        const auto rounded_up_us = nanoseconds / 1'000U + (nanoseconds % 1'000U != 0 ? 1U : 0U);
        const auto bin = std::min<std::uint64_t>(rounded_up_us, histogram_maximum_us);
        ++bins_.at(static_cast<std::size_t>(bin));
        ++count_;
        if (rounded_up_us >= histogram_maximum_us) {
            ++overflow_count_;
        }
    }

    [[nodiscard]] std::uint64_t nearest_rank(double quantile) const {
        if (count_ == 0) {
            return 0;
        }
        const auto rank = static_cast<std::uint64_t>(std::ceil(quantile * static_cast<double>(count_)));
        std::uint64_t cumulative = 0;
        for (std::uint64_t index = 0; index < bins_.size(); ++index) {
            cumulative += bins_[static_cast<std::size_t>(index)];
            if (cumulative >= rank) {
                return index;
            }
        }
        throw std::logic_error("latency histogram rank not found");
    }

    [[nodiscard]] std::uint64_t count() const noexcept { return count_; }
    [[nodiscard]] std::uint64_t overflow_count() const noexcept { return overflow_count_; }

private:
    std::vector<std::uint64_t> bins_;
    std::uint64_t count_ = 0;
    std::uint64_t overflow_count_ = 0;
};

std::uint32_t nearest_rank_queue_depth(const QueueMetrics & metrics, double quantile) {
    if (metrics.submitted_requests == 0) {
        return 0;
    }
    const auto rank = static_cast<std::uint64_t>(
        std::ceil(quantile * static_cast<double>(metrics.submitted_requests)));
    std::uint64_t cumulative = 0;
    for (std::uint32_t depth = 0; depth < metrics.pending_depth_histogram.size(); ++depth) {
        cumulative += metrics.pending_depth_histogram.at(depth);
        if (cumulative >= rank) {
            return depth;
        }
    }
    throw std::logic_error("queue-depth rank not found");
}

std::string json_escape(const std::string & input) {
    std::string output;
    output.reserve(input.size() + 8U);
    for (const auto character : input) {
        switch (character) {
        case '\\': output += "\\\\"; break;
        case '"': output += "\\\""; break;
        case '\n': output += "\\n"; break;
        case '\r': output += "\\r"; break;
        case '\t': output += "\\t"; break;
        default: output += character; break;
        }
    }
    return output;
}

std::vector<ReadRequest> chunk_requests(
    const std::vector<ReadRequest> & native,
    std::uint64_t chunk_bytes,
    std::uint64_t & next_request_id) {
    std::vector<ReadRequest> requests;
    for (const auto & source : native) {
        if (chunk_bytes == 0) {
            requests.push_back({next_request_id++, source.volume, source.offset, source.length, false});
            continue;
        }
        for (std::uint64_t consumed = 0; consumed < source.length;) {
            const auto length = std::min(chunk_bytes, source.length - consumed);
            requests.push_back({next_request_id++, source.volume, source.offset + consumed, length, false});
            consumed += length;
        }
    }
    return requests;
}

class KeyEpochs {
public:
    explicit KeyEpochs(std::uint64_t seed) : generator_(seed) {
        // Les clefs enumerees sont celles du modele : couches et experts du
        // profil actif, pas la capacite d'encodage des clefs.
        const auto & profile = ModelProfile::active();
        keys_.reserve(static_cast<std::size_t>(profile.layer_count()) * profile.experts);
        for (std::uint32_t layer = profile.first_layer; layer <= profile.last_layer; ++layer) {
            for (std::uint32_t expert = 0; expert < profile.experts; ++expert) {
                keys_.push_back((layer << galactus::h4::key_expert_bits) | expert);
            }
        }
        shuffle();
    }

    std::uint32_t next() {
        if (cursor_ == keys_.size()) {
            shuffle();
        }
        return keys_.at(cursor_++);
    }

    [[nodiscard]] std::uint64_t epochs_started() const noexcept { return epochs_started_; }

private:
    void shuffle() {
        std::shuffle(keys_.begin(), keys_.end(), generator_);
        cursor_ = 0;
        ++epochs_started_;
    }

    std::mt19937_64 generator_;
    std::vector<std::uint32_t> keys_;
    std::size_t cursor_ = 0;
    std::uint64_t epochs_started_ = 0;
};

struct PendingRecord {
    std::vector<ReadRequest> requests;
    std::vector<std::future<ReadResult>> futures;
};

struct VolumeTotals {
    std::uint64_t bytes = 0;
    std::uint64_t requests = 0;
};

struct WindowVolume {
    std::uint64_t bytes = 0;
    std::uint64_t requests = 0;
    std::vector<std::uint32_t> latency_us;
};

struct TimeWindow {
    WindowVolume internal;
    WindowVolume external;
};

std::uint32_t nearest_rank_samples(std::vector<std::uint32_t> samples, double quantile) {
    if (samples.empty()) {
        return 0;
    }
    const auto rank = static_cast<std::size_t>(
        std::ceil(quantile * static_cast<double>(samples.size())));
    std::nth_element(samples.begin(), samples.begin() + static_cast<std::ptrdiff_t>(rank - 1U), samples.end());
    return samples.at(rank - 1U);
}

void write_all(int descriptor, const std::string & value) {
    std::size_t written = 0;
    while (written < value.size()) {
        const auto result = ::write(descriptor, value.data() + written, value.size() - written);
        if (result < 0) {
            if (errno == EINTR) {
                continue;
            }
            throw std::runtime_error("cannot write H4 timeseries: " + std::string(std::strerror(errno)));
        }
        written += static_cast<std::size_t>(result);
    }
}

void write_timeseries(
    const std::string & path,
    const std::vector<TimeWindow> & windows,
    std::uint64_t started_ns,
    std::uint64_t elapsed_ns) {
    if (path.empty()) {
        return;
    }
    const auto partial = path + ".partial";
    if (access(path.c_str(), F_OK) == 0 || access(partial.c_str(), F_OK) == 0) {
        throw std::runtime_error("H4 timeseries target or partial already exists");
    }
    std::ostringstream output;
    output << "second_index,window_start_relative_ns,window_start_monotonic_ns,window_duration_ns,"
              "internal_logical_bytes,internal_requests,internal_latency_p50_us,"
              "internal_latency_p95_us,internal_latency_p99_us,"
              "external_logical_bytes,external_requests,external_latency_p50_us,"
              "external_latency_p95_us,external_latency_p99_us\n";
    for (std::size_t index = 0; index < windows.size(); ++index) {
        const auto start_ns = static_cast<std::uint64_t>(index) * 1'000'000'000ULL;
        const auto duration_ns = elapsed_ns > start_ns
            ? std::min<std::uint64_t>(1'000'000'000ULL, elapsed_ns - start_ns)
            : 0;
        const auto & window = windows.at(index);
        output << index << ',' << start_ns << ',' << started_ns + start_ns << ',' << duration_ns << ','
               << window.internal.bytes << ',' << window.internal.requests << ','
               << nearest_rank_samples(window.internal.latency_us, 0.50) << ','
               << nearest_rank_samples(window.internal.latency_us, 0.95) << ','
               << nearest_rank_samples(window.internal.latency_us, 0.99) << ','
               << window.external.bytes << ',' << window.external.requests << ','
               << nearest_rank_samples(window.external.latency_us, 0.50) << ','
               << nearest_rank_samples(window.external.latency_us, 0.95) << ','
               << nearest_rank_samples(window.external.latency_us, 0.99) << '\n';
    }
    const auto serialized = output.str();
    const auto descriptor = open(partial.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0644);
    if (descriptor < 0) {
        throw std::runtime_error("cannot create H4 timeseries partial: " + std::string(std::strerror(errno)));
    }
    try {
        write_all(descriptor, serialized);
        if (fsync(descriptor) != 0) {
            throw std::runtime_error("cannot fsync H4 timeseries: " + std::string(std::strerror(errno)));
        }
        if (close(descriptor) != 0) {
            throw std::runtime_error("cannot close H4 timeseries: " + std::string(std::strerror(errno)));
        }
        if (rename(partial.c_str(), path.c_str()) != 0) {
            throw std::runtime_error("cannot publish H4 timeseries: " + std::string(std::strerror(errno)));
        }
    } catch (...) {
        close(descriptor);
        throw;
    }
}

void print_latency_json(const LatencyHistogram & histogram) {
    std::cout << "{\"count\":" << histogram.count()
              << ",\"p50_us\":" << histogram.nearest_rank(0.50)
              << ",\"p95_us\":" << histogram.nearest_rank(0.95)
              << ",\"p99_us\":" << histogram.nearest_rank(0.99)
              << ",\"overflow_ge_5000000us\":" << histogram.overflow_count() << "}";
}

void print_queue_json(const QueueMetrics & metrics) {
    std::cout << "{\"submitted_requests\":" << metrics.submitted_requests
              << ",\"backpressure_events\":" << metrics.submit_backpressure_events
              << ",\"maximum_pending_depth\":" << metrics.maximum_pending_depth
              << ",\"p95_pending_depth\":" << nearest_rank_queue_depth(metrics, 0.95) << "}";
}

int run(const Options & options) {
    const auto io_policy_before = getiopolicy_np(IOPOL_TYPE_DISK, IOPOL_SCOPE_PROCESS);
    if (io_policy_before < 0) {
        throw std::runtime_error("getiopolicy_np before run failed: " + std::string(std::strerror(errno)));
    }
    if (options.io_policy == "important" &&
        setiopolicy_np(IOPOL_TYPE_DISK, IOPOL_SCOPE_PROCESS, IOPOL_IMPORTANT) != 0) {
        throw std::runtime_error("setiopolicy_np IOPOL_IMPORTANT failed: " + std::string(std::strerror(errno)));
    }
    const auto io_policy_effective = getiopolicy_np(IOPOL_TYPE_DISK, IOPOL_SCOPE_PROCESS);
    if (io_policy_effective < 0) {
        throw std::runtime_error("getiopolicy_np after configuration failed: " + std::string(std::strerror(errno)));
    }
    const auto & record_bytes = galactus::h4::frozen_layer_record_bytes();
    const auto p0_profile = options.p0_profile == "v2"
        ? P0Profile::v2_7157_2843
        : P0Profile::v1_599_401;
    const P0Layout p0(record_bytes, p0_profile);
    const P1Layout p1(record_bytes);
    const auto expected_internal = options.layout == "p0" ? p0.internal_bytes() : p1.internal_bytes();
    const auto expected_external = options.layout == "p0" ? p0.external_bytes() : p1.external_bytes();
    const auto actual_internal = checked_file_size(options.internal_file);
    const auto actual_external = checked_file_size(options.external_file);
    if (actual_internal != expected_internal || actual_external != expected_external) {
        throw std::runtime_error("pack size does not match the selected canonical layout");
    }

    const auto configured_read_bytes = options.chunk_bytes == 0 ? maximum_record_bytes : options.chunk_bytes;
    DualVolumeReader reader(
        options.internal_file,
        options.external_file,
        options.queue_depth,
        configured_read_bytes,
        galactus::h4::hard_ring_buffer_limit_bytes,
        true);
    if (!reader.f_nocache_applied(Volume::internal) || !reader.f_nocache_applied(Volume::external)) {
        throw std::runtime_error("F_NOCACHE is required on both H4 pack descriptors");
    }

    const auto effective_qd = reader.ring_plan().effective_queue_depth_per_volume;
    const auto records_per_wave = std::max<std::uint32_t>(32U, effective_qd * 4U);
    KeyEpochs keys(options.seed);
    LatencyHistogram request_latency;
    LatencyHistogram internal_request_latency;
    LatencyHistogram external_request_latency;
    LatencyHistogram record_latency;
    std::vector<TimeWindow> time_windows;
    VolumeTotals internal;
    VolumeTotals external;
    std::uint64_t next_request_id = 0;
    std::uint64_t records_completed = 0;
    std::uint64_t logical_bytes = 0;

    const auto diskio_before = process_diskio_bytesread();
    const auto started = std::chrono::steady_clock::now();
    const auto started_ns = static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(started.time_since_epoch()).count());
    double elapsed_seconds = 0.0;
    do {
        std::vector<PendingRecord> wave;
        wave.reserve(records_per_wave);
        for (std::uint32_t record_index = 0; record_index < records_per_wave; ++record_index) {
            const galactus::h4::MissToken token{0, {keys.next()}};
            const auto native = options.layout == "p0"
                ? p0.plan_token(token)
                : p1.plan_token(token);
            std::vector<ReadRequest> selected_native;
            selected_native.reserve(native.size());
            for (const auto & request : native) {
                if (options.active_volume == "both" ||
                    (options.active_volume == "internal" && request.volume == Volume::internal) ||
                    (options.active_volume == "external" && request.volume == Volume::external)) {
                    selected_native.push_back(request);
                }
            }
            auto requests = chunk_requests(selected_native, options.chunk_bytes, next_request_id);
            PendingRecord pending;
            pending.futures.reserve(requests.size());
            pending.requests = std::move(requests);
            wave.push_back(std::move(pending));
        }

        // P0 has one native request per volume and submit() applies blocking
        // backpressure per volume. Keep both independent queues fed together;
        // submitting a whole wave volume-by-volume serializes the devices.
        for (auto & record : wave) {
            for (const auto & request : record.requests) {
                record.futures.push_back(reader.submit(request));
            }
        }

        for (auto & record : wave) {
            std::uint64_t first_submitted_ns = std::numeric_limits<std::uint64_t>::max();
            std::uint64_t last_completed_ns = 0;
            std::uint64_t record_bytes_read = 0;
            for (auto & future : record.futures) {
                const auto result = future.get();
                first_submitted_ns = std::min(first_submitted_ns, result.submitted_at_ns);
                last_completed_ns = std::max(last_completed_ns, result.completed_at_ns);
                request_latency.add_ns(result.completion_latency_ns);
                record_bytes_read += result.bytes_read;
                auto & totals = result.volume == Volume::internal ? internal : external;
                totals.bytes += result.bytes_read;
                ++totals.requests;
                auto & volume_latency = result.volume == Volume::internal
                    ? internal_request_latency
                    : external_request_latency;
                volume_latency.add_ns(result.completion_latency_ns);
                if (!options.timeseries_file.empty()) {
                    if (result.completed_at_ns < started_ns) {
                        throw std::logic_error("request completion predates benchmark start");
                    }
                    const auto window_index = static_cast<std::size_t>(
                        (result.completed_at_ns - started_ns) / 1'000'000'000ULL);
                    if (time_windows.size() <= window_index) {
                        time_windows.resize(window_index + 1U);
                    }
                    auto & window_volume = result.volume == Volume::internal
                        ? time_windows.at(window_index).internal
                        : time_windows.at(window_index).external;
                    window_volume.bytes += result.bytes_read;
                    ++window_volume.requests;
                    const auto latency_us = result.completion_latency_ns / 1'000U +
                        (result.completion_latency_ns % 1'000U != 0 ? 1U : 0U);
                    window_volume.latency_us.push_back(static_cast<std::uint32_t>(
                        std::min<std::uint64_t>(latency_us, std::numeric_limits<std::uint32_t>::max())));
                }
            }
            if (first_submitted_ns == std::numeric_limits<std::uint64_t>::max() ||
                last_completed_ns < first_submitted_ns) {
                throw std::logic_error("record completed without valid request timestamps");
            }
            record_latency.add_ns(last_completed_ns - first_submitted_ns);
            logical_bytes += record_bytes_read;
            ++records_completed;
        }

        elapsed_seconds = std::chrono::duration<double>(
            std::chrono::steady_clock::now() - started).count();
        if (elapsed_seconds > options.maximum_seconds &&
            (elapsed_seconds < options.minimum_seconds || logical_bytes < options.minimum_logical_bytes)) {
            throw std::runtime_error("maximum duration reached before satisfying both minimum thresholds");
        }
    } while (elapsed_seconds < options.minimum_seconds || logical_bytes < options.minimum_logical_bytes);

    const auto diskio_after = process_diskio_bytesread();
    if (diskio_after < diskio_before) {
        throw std::logic_error("process disk I/O counter regressed");
    }
    const auto process_diskio_bytes = diskio_after - diskio_before;
    const auto internal_queue = reader.queue_metrics(Volume::internal);
    const auto external_queue = reader.queue_metrics(Volume::external);
    const auto elapsed_ns = static_cast<std::uint64_t>(elapsed_seconds * 1e9);
    write_timeseries(options.timeseries_file, time_windows, started_ns, elapsed_ns);
    const auto aggregate_gbps = static_cast<double>(logical_bytes) / elapsed_seconds / 1e9;
    const auto internal_gbps = static_cast<double>(internal.bytes) / elapsed_seconds / 1e9;
    const auto external_gbps = static_cast<double>(external.bytes) / elapsed_seconds / 1e9;

    std::cout << std::fixed << std::setprecision(9)
              << "{\"schema\":\"galactus.h4.exploratory-run.v1\""
              << ",\"layout\":\"" << options.layout << "\""
              << ",\"p0_profile\":\"" << options.p0_profile << "\""
              << ",\"active_volume\":\"" << options.active_volume << "\""
              << ",\"io_policy_requested\":\"" << options.io_policy << "\""
              << ",\"io_policy_set_succeeded\":"
              << (options.io_policy == "important" ? "true" : "false")
              << ",\"io_policy_process_disk_before\":" << io_policy_before
              << ",\"io_policy_process_disk_effective\":" << io_policy_effective
              << ",\"sampling\":\"seeded_permutation_without_replacement_then_new_epoch\""
              << ",\"seed\":" << options.seed
              << ",\"chunk_bytes\":" << options.chunk_bytes
              << ",\"chunk_semantics\":\"request_granularity; offsets_and_lengths_16KiB_aligned\""
              << ",\"requested_qd_per_volume\":" << options.queue_depth
              << ",\"effective_qd_per_volume\":" << effective_qd
              << ",\"ring_bytes\":" << reader.ring_plan().ring_limit_bytes
              << ",\"f_nocache_internal\":true,\"f_nocache_external\":true"
              << ",\"internal_file\":\"" << json_escape(options.internal_file) << "\""
              << ",\"external_file\":\"" << json_escape(options.external_file) << "\""
              << ",\"minimum_seconds\":" << options.minimum_seconds
              << ",\"minimum_logical_bytes\":" << options.minimum_logical_bytes
              << ",\"timeseries_file\":\"" << json_escape(options.timeseries_file) << "\""
              << ",\"started_monotonic_ns\":" << started_ns
              << ",\"elapsed_seconds\":" << elapsed_seconds
              << ",\"logical_bytes\":" << logical_bytes
              << ",\"process_diskio_bytes\":" << process_diskio_bytes
              << ",\"physical_over_logical\":"
              << static_cast<double>(process_diskio_bytes) / static_cast<double>(logical_bytes)
              << ",\"records_completed\":" << records_completed
              << ",\"epochs_started\":" << keys.epochs_started()
              << ",\"aggregate_gbps\":" << aggregate_gbps
              << ",\"volumes\":{\"internal\":{\"bytes\":" << internal.bytes
              << ",\"requests\":" << internal.requests << ",\"gbps_wall\":" << internal_gbps
              << "},\"external\":{\"bytes\":" << external.bytes
              << ",\"requests\":" << external.requests << ",\"gbps_wall\":" << external_gbps << "}}"
              << ",\"request_latency\":";
    print_latency_json(request_latency);
    std::cout << ",\"request_latency_by_volume\":{\"internal\":";
    print_latency_json(internal_request_latency);
    std::cout << ",\"external\":";
    print_latency_json(external_request_latency);
    std::cout << "}";
    std::cout << ",\"record_completion_latency\":";
    print_latency_json(record_latency);
    std::cout << ",\"queues\":{\"internal\":";
    print_queue_json(internal_queue);
    std::cout << ",\"external\":";
    print_queue_json(external_queue);
    std::cout << "}}\n";
    return 0;
}

} // namespace

int main(int argc, char ** argv) {
    try {
        return run(parse_options(argc, argv));
    } catch (const std::exception & error) {
        std::cerr << "h4-benchmark: " << error.what() << '\n';
        return 64;
    }
}

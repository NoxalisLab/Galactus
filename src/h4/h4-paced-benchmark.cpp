#include "h4-reader.hpp"

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fcntl.h>
#include <fstream>
#include <future>
#include <iomanip>
#include <iostream>
#include <libproc.h>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <sys/resource.h>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>
#include <utility>
#include <vector>

namespace {

using galactus::h4::DualVolumeReader;
using galactus::h4::MissToken;
using galactus::h4::P0Layout;
using galactus::h4::P0Profile;
using galactus::h4::ReadRequest;
using galactus::h4::ReadResult;
using galactus::h4::Volume;

constexpr std::uint64_t maximum_record_bytes = 13'172'736;
constexpr std::uint32_t expected_documents = 18;
constexpr std::uint32_t expected_tokens_per_document = 256;
constexpr std::uint64_t expected_corpus_logical_bytes = 3'473'773'068'288ULL;

struct Options {
    std::string internal_file;
    std::string external_file;
    std::string miss_directory;
    std::string timeseries_file;
    std::uint32_t queue_depth = 0;
    double target_tokens_per_second = 0.0;
    double duration_seconds = 0.0;
    std::string p0_profile;
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
        if (option == "--internal-file") {
            options.internal_file = require_value(argc, argv, index, option);
        } else if (option == "--external-file") {
            options.external_file = require_value(argc, argv, index, option);
        } else if (option == "--miss-directory") {
            options.miss_directory = require_value(argc, argv, index, option);
        } else if (option == "--timeseries-file") {
            options.timeseries_file = require_value(argc, argv, index, option);
        } else if (option == "--qd") {
            const auto value = parse_u64(require_value(argc, argv, index, option), option);
            if (value > std::numeric_limits<std::uint32_t>::max()) {
                throw std::invalid_argument("--qd exceeds uint32");
            }
            options.queue_depth = static_cast<std::uint32_t>(value);
        } else if (option == "--target-tokens-per-second") {
            options.target_tokens_per_second = parse_double(require_value(argc, argv, index, option), option);
        } else if (option == "--duration-seconds") {
            options.duration_seconds = parse_double(require_value(argc, argv, index, option), option);
        } else if (option == "--p0-profile") {
            options.p0_profile = require_value(argc, argv, index, option);
        } else {
            throw std::invalid_argument("unknown option: " + option);
        }
    }
    if (options.internal_file.empty() || options.external_file.empty() ||
        options.miss_directory.empty() || options.timeseries_file.empty()) {
        throw std::invalid_argument(
            "--internal-file, --external-file, --miss-directory and --timeseries-file are required");
    }
    if (options.queue_depth == 0 || options.target_tokens_per_second <= 0.0 ||
        options.duration_seconds <= 0.0) {
        throw std::invalid_argument("qd, target token rate and duration must be positive");
    }
    if (options.p0_profile != "v2") {
        throw std::invalid_argument("paced H4 qualification is restricted to --p0-profile v2");
    }
    const double slots = options.target_tokens_per_second * options.duration_seconds;
    if (slots > static_cast<double>(std::numeric_limits<std::uint32_t>::max()) ||
        std::abs(slots - std::round(slots)) > 1e-9) {
        throw std::invalid_argument("duration multiplied by target token rate must be an exact uint32");
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

std::uint64_t monotonic_now_ns() noexcept {
    return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count());
}

std::uint64_t checked_add(std::uint64_t left, std::uint64_t right, const char * operation) {
    if (right > std::numeric_limits<std::uint64_t>::max() - left) {
        throw std::overflow_error(operation);
    }
    return left + right;
}

std::vector<MissToken> load_corpus(const std::string & directory) {
    namespace fs = std::filesystem;
    std::vector<fs::path> paths;
    for (const auto & entry : fs::directory_iterator(directory)) {
        if (entry.is_regular_file() && entry.path().extension() == ".bin" &&
            entry.path().filename().string().rfind("misses-t5-doc", 0) == 0) {
            paths.push_back(entry.path());
        }
    }
    std::sort(paths.begin(), paths.end());
    if (paths.size() != expected_documents) {
        throw std::runtime_error("miss corpus must contain exactly 18 canonical document files");
    }
    std::vector<std::vector<MissToken>> documents;
    documents.reserve(expected_documents);
    for (const auto & path : paths) {
        std::ifstream input(path, std::ios::binary);
        if (!input) {
            throw std::runtime_error("cannot open miss sequence: " + path.string());
        }
        documents.push_back(galactus::h4::read_miss_sequence(input, expected_tokens_per_document));
    }
    // Interleave documents at each token index. Every source token remains
    // intact, while any partial corpus cycle samples all documents instead of
    // overweighting the low-numbered documents.
    std::vector<MissToken> corpus;
    corpus.reserve(expected_documents * expected_tokens_per_document);
    for (std::uint32_t token = 0; token < expected_tokens_per_document; ++token) {
        for (std::uint32_t document = 0; document < expected_documents; ++document) {
            corpus.push_back(std::move(documents[document][token]));
        }
    }
    return corpus;
}

struct CorpusRotation {
    std::size_t start = 0;
    std::uint64_t planned_bytes = 0;
};

CorpusRotation closest_average_rotation(
    const std::vector<std::uint64_t> & token_bytes,
    std::uint32_t target_slots,
    std::uint64_t corpus_bytes) {
    if (token_bytes.empty()) {
        throw std::invalid_argument("cannot rotate an empty paced corpus");
    }
    const auto corpus_slots = static_cast<std::uint64_t>(token_bytes.size());
    const auto full_cycles = static_cast<std::uint64_t>(target_slots) / corpus_slots;
    const auto remainder = static_cast<std::size_t>(target_slots % corpus_slots);
    const auto fixed_bytes = static_cast<unsigned __int128>(full_cycles) * corpus_bytes;
    const long double ideal_bytes = static_cast<long double>(corpus_bytes) * target_slots / corpus_slots;
    if (fixed_bytes > std::numeric_limits<std::uint64_t>::max()) {
        throw std::overflow_error("paced full-cycle bytes overflow");
    }
    if (remainder == 0) {
        return {0, static_cast<std::uint64_t>(fixed_bytes)};
    }

    std::uint64_t window_bytes = 0;
    for (std::size_t index = 0; index < remainder; ++index) {
        window_bytes = checked_add(window_bytes, token_bytes[index], "paced rotation byte overflow");
    }
    std::size_t best_start = 0;
    std::uint64_t best_window_bytes = window_bytes;
    long double best_error = std::abs(
        static_cast<long double>(static_cast<std::uint64_t>(fixed_bytes) + window_bytes) - ideal_bytes);
    for (std::size_t start = 1; start < token_bytes.size(); ++start) {
        window_bytes -= token_bytes[start - 1U];
        window_bytes = checked_add(
            window_bytes,
            token_bytes[(start + remainder - 1U) % token_bytes.size()],
            "paced rotation sliding window overflow");
        const auto candidate = static_cast<std::uint64_t>(fixed_bytes) + window_bytes;
        const auto error = std::abs(static_cast<long double>(candidate) - ideal_bytes);
        if (error < best_error) {
            best_error = error;
            best_start = start;
            best_window_bytes = window_bytes;
        }
    }
    return {
        best_start,
        checked_add(
            static_cast<std::uint64_t>(fixed_bytes),
            best_window_bytes,
            "paced planned byte overflow"),
    };
}

template <typename Integer>
Integer nearest_rank(std::vector<Integer> values, double quantile) {
    if (values.empty()) {
        return 0;
    }
    const auto rank = static_cast<std::size_t>(std::ceil(quantile * values.size()));
    std::nth_element(values.begin(), values.begin() + static_cast<std::ptrdiff_t>(rank - 1U), values.end());
    return values.at(rank - 1U);
}

struct WindowVolume {
    std::uint64_t bytes = 0;
    std::uint64_t requests = 0;
    std::vector<std::uint32_t> latency_us;
};

struct TimeWindow {
    WindowVolume internal;
    WindowVolume external;
    std::uint32_t tokens_completed = 0;
    std::vector<std::uint32_t> token_completion_us;
};

struct StallEpisode {
    std::uint32_t first_slot = 0;
    std::uint32_t last_slot = 0;
    std::uint32_t tokens = 0;
    std::uint32_t maximum_depth_tokens = 0;
    std::uint64_t maximum_completion_ns = 0;
};

void write_all(int descriptor, const std::string & value) {
    std::size_t written = 0;
    while (written < value.size()) {
        const auto result = ::write(descriptor, value.data() + written, value.size() - written);
        if (result < 0) {
            if (errno == EINTR) {
                continue;
            }
            throw std::runtime_error("cannot write paced timeseries: " + std::string(std::strerror(errno)));
        }
        written += static_cast<std::size_t>(result);
    }
}

void write_timeseries(
    const std::string & path,
    const std::vector<TimeWindow> & windows,
    std::uint64_t started_ns,
    std::uint64_t nominal_duration_ns) {
    const auto partial = path + ".partial";
    if (access(path.c_str(), F_OK) == 0 || access(partial.c_str(), F_OK) == 0) {
        throw std::runtime_error("paced timeseries target or partial already exists");
    }
    std::ostringstream output;
    output << "second_index,window_start_relative_ns,window_start_monotonic_ns,window_duration_ns,"
              "internal_logical_bytes,internal_requests,internal_latency_p50_us,"
              "internal_latency_p95_us,internal_latency_p99_us,"
              "external_logical_bytes,external_requests,external_latency_p50_us,"
              "external_latency_p95_us,external_latency_p99_us,"
              "tokens_completed,token_completion_p50_us,token_completion_p95_us\n";
    for (std::size_t index = 0; index < windows.size(); ++index) {
        const auto start_ns = static_cast<std::uint64_t>(index) * 1'000'000'000ULL;
        const auto duration_ns = nominal_duration_ns > start_ns
            ? std::min<std::uint64_t>(1'000'000'000ULL, nominal_duration_ns - start_ns)
            : 0;
        const auto & window = windows[index];
        output << index << ',' << start_ns << ',' << started_ns + start_ns << ',' << duration_ns << ','
               << window.internal.bytes << ',' << window.internal.requests << ','
               << nearest_rank(window.internal.latency_us, 0.50) << ','
               << nearest_rank(window.internal.latency_us, 0.95) << ','
               << nearest_rank(window.internal.latency_us, 0.99) << ','
               << window.external.bytes << ',' << window.external.requests << ','
               << nearest_rank(window.external.latency_us, 0.50) << ','
               << nearest_rank(window.external.latency_us, 0.95) << ','
               << nearest_rank(window.external.latency_us, 0.99) << ','
               << window.tokens_completed << ','
               << nearest_rank(window.token_completion_us, 0.50) << ','
               << nearest_rank(window.token_completion_us, 0.95) << '\n';
    }
    const auto serialized = output.str();
    const int descriptor = open(partial.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0644);
    if (descriptor < 0) {
        throw std::runtime_error("cannot create paced timeseries: " + std::string(std::strerror(errno)));
    }
    try {
        write_all(descriptor, serialized);
        if (fsync(descriptor) != 0 || close(descriptor) != 0) {
            throw std::runtime_error("cannot publish paced timeseries payload");
        }
        if (rename(partial.c_str(), path.c_str()) != 0) {
            throw std::runtime_error("cannot rename paced timeseries: " + std::string(std::strerror(errno)));
        }
    } catch (...) {
        close(descriptor);
        throw;
    }
}

int run(const Options & options) {
    const auto corpus = load_corpus(options.miss_directory);
    const P0Layout layout(galactus::h4::frozen_layer_record_bytes(), P0Profile::v2_7157_2843);
    if (checked_file_size(options.internal_file) != layout.internal_bytes() ||
        checked_file_size(options.external_file) != layout.external_bytes()) {
        throw std::runtime_error("pack size does not match canonical P0v2");
    }

    std::uint64_t corpus_bytes = 0;
    std::vector<std::uint64_t> corpus_token_bytes;
    corpus_token_bytes.reserve(corpus.size());
    for (const auto & token : corpus) {
        std::uint64_t token_bytes = 0;
        for (const auto & request : layout.plan_token(token)) {
            corpus_bytes = checked_add(corpus_bytes, request.length, "corpus logical byte overflow");
            token_bytes = checked_add(token_bytes, request.length, "corpus token byte overflow");
        }
        corpus_token_bytes.push_back(token_bytes);
    }
    if (corpus.size() != expected_documents * expected_tokens_per_document ||
        corpus_bytes != expected_corpus_logical_bytes) {
        throw std::runtime_error("miss corpus geometry diverges from the jointly frozen t5-v1 profile");
    }

    DualVolumeReader reader(
        options.internal_file,
        options.external_file,
        options.queue_depth,
        maximum_record_bytes,
        galactus::h4::hard_ring_buffer_limit_bytes,
        true);
    if (!reader.f_nocache_applied(Volume::internal) || !reader.f_nocache_applied(Volume::external)) {
        throw std::runtime_error("F_NOCACHE is required on both paced-run descriptors");
    }

    const auto target_slots = static_cast<std::uint32_t>(
        std::llround(options.target_tokens_per_second * options.duration_seconds));
    const auto rotation = closest_average_rotation(
        corpus_token_bytes, target_slots, corpus_bytes);
    const auto period_ns = static_cast<std::uint64_t>(
        std::llround(1e9 / options.target_tokens_per_second));
    const auto nominal_duration_ns = static_cast<std::uint64_t>(
        std::llround(options.duration_seconds * 1e9));
    const auto started_ns = monotonic_now_ns();
    const auto end_ns = started_ns + nominal_duration_ns;
    const auto diskio_before = process_diskio_bytesread();

    std::vector<std::uint64_t> token_completion_ns;
    std::vector<std::uint64_t> token_service_ns;
    token_completion_ns.reserve(target_slots);
    token_service_ns.reserve(target_slots);
    std::vector<TimeWindow> windows(static_cast<std::size_t>(std::ceil(options.duration_seconds)) + 1U);
    std::vector<StallEpisode> episodes;
    StallEpisode current_episode;
    bool episode_open = false;
    std::uint64_t logical_bytes = 0;
    std::uint64_t internal_bytes = 0;
    std::uint64_t external_bytes = 0;
    std::uint64_t next_request_id = 0;
    std::uint32_t completed_tokens = 0;

    for (std::uint32_t slot = 0; slot < target_slots; ++slot) {
        const auto scheduled_ns = started_ns + static_cast<std::uint64_t>(slot) * period_ns;
        const auto now_ns = monotonic_now_ns();
        if (now_ns < scheduled_ns) {
            std::this_thread::sleep_until(std::chrono::steady_clock::time_point(
                std::chrono::nanoseconds(scheduled_ns)));
        }
        if (monotonic_now_ns() >= end_ns) {
            break;
        }

        const auto & token = corpus[(rotation.start + slot) % corpus.size()];
        auto requests = layout.plan_token(token, next_request_id);
        next_request_id = checked_add(next_request_id, requests.size(), "request identifier overflow");
        std::vector<std::future<ReadResult>> futures;
        futures.reserve(requests.size());
        for (const auto & request : requests) {
            futures.push_back(reader.submit(request));
        }

        std::uint64_t first_submitted_ns = std::numeric_limits<std::uint64_t>::max();
        std::uint64_t last_completed_ns = 0;
        for (auto & future : futures) {
            const auto result = future.get();
            first_submitted_ns = std::min(first_submitted_ns, result.submitted_at_ns);
            last_completed_ns = std::max(last_completed_ns, result.completed_at_ns);
            logical_bytes = checked_add(logical_bytes, result.bytes_read, "paced logical byte overflow");
            auto & volume_bytes = result.volume == Volume::internal ? internal_bytes : external_bytes;
            volume_bytes = checked_add(volume_bytes, result.bytes_read, "paced volume byte overflow");
            const auto relative_ns = result.completed_at_ns > started_ns
                ? result.completed_at_ns - started_ns : 0;
            const auto window_index = std::min<std::size_t>(
                relative_ns / 1'000'000'000ULL, windows.size() - 1U);
            auto & volume = result.volume == Volume::internal
                ? windows[window_index].internal : windows[window_index].external;
            volume.bytes += result.bytes_read;
            ++volume.requests;
            const auto latency_us = std::min<std::uint64_t>(
                (result.completion_latency_ns + 999U) / 1'000U,
                std::numeric_limits<std::uint32_t>::max());
            volume.latency_us.push_back(static_cast<std::uint32_t>(latency_us));
        }
        if (first_submitted_ns == std::numeric_limits<std::uint64_t>::max() ||
            last_completed_ns < first_submitted_ns || last_completed_ns < scheduled_ns) {
            throw std::logic_error("paced token has invalid timestamps");
        }
        const auto completion_ns = last_completed_ns - scheduled_ns;
        const auto service_ns = last_completed_ns - first_submitted_ns;
        token_completion_ns.push_back(completion_ns);
        token_service_ns.push_back(service_ns);
        const auto completion_window = std::min<std::size_t>(
            (last_completed_ns - started_ns) / 1'000'000'000ULL, windows.size() - 1U);
        ++windows[completion_window].tokens_completed;
        windows[completion_window].token_completion_us.push_back(static_cast<std::uint32_t>(
            std::min<std::uint64_t>((completion_ns + 999U) / 1'000U, std::numeric_limits<std::uint32_t>::max())));
        ++completed_tokens;

        const bool missed = completion_ns > period_ns;
        if (missed) {
            const auto depth = static_cast<std::uint32_t>((completion_ns + period_ns - 1U) / period_ns);
            if (!episode_open) {
                current_episode = {slot, slot, 0, 0, 0};
                episode_open = true;
            }
            current_episode.last_slot = slot;
            ++current_episode.tokens;
            current_episode.maximum_depth_tokens = std::max(current_episode.maximum_depth_tokens, depth);
            current_episode.maximum_completion_ns = std::max(current_episode.maximum_completion_ns, completion_ns);
        } else if (episode_open) {
            episodes.push_back(current_episode);
            episode_open = false;
        }
    }
    if (episode_open) {
        episodes.push_back(current_episode);
    }
    const auto before_final_wait_ns = monotonic_now_ns();
    if (before_final_wait_ns < end_ns) {
        std::this_thread::sleep_until(std::chrono::steady_clock::time_point(std::chrono::nanoseconds(end_ns)));
    }
    const auto finished_ns = monotonic_now_ns();
    const auto diskio_after = process_diskio_bytesread();
    if (diskio_after < diskio_before) {
        throw std::logic_error("process disk I/O counter regressed");
    }
    const auto process_diskio_bytes = diskio_after - diskio_before;
    write_timeseries(options.timeseries_file, windows, started_ns, nominal_duration_ns);

    const auto corpus_average_bytes = static_cast<double>(corpus_bytes) / corpus.size();
    const auto target_logical_gbps = corpus_average_bytes * options.target_tokens_per_second / 1e9;
    const auto offered_logical_gbps = static_cast<double>(logical_bytes) / options.duration_seconds / 1e9;
    const auto planned_logical_gbps = static_cast<double>(rotation.planned_bytes) /
        options.duration_seconds / 1e9;
    const auto maximum_completion_ns = token_completion_ns.empty()
        ? 0 : *std::max_element(token_completion_ns.begin(), token_completion_ns.end());
    std::cout << std::fixed << std::setprecision(9)
              << "{\"schema\":\"galactus.h4.paced-run.v1\""
              << ",\"layout\":\"p0\",\"p0_profile\":\"v2\""
              << ",\"workload\":\"canonical-misses-t5-token-index-interleaved-cyclic\""
              << ",\"documents\":" << expected_documents
              << ",\"corpus_tokens\":" << corpus.size()
              << ",\"corpus_logical_bytes\":" << corpus_bytes
              << ",\"corpus_rotation_start\":" << rotation.start
              << ",\"target_tokens_per_second\":" << options.target_tokens_per_second
              << ",\"target_logical_gbps_from_corpus_average\":" << target_logical_gbps
              << ",\"nominal_duration_seconds\":" << options.duration_seconds
              << ",\"target_tokens\":" << target_slots
              << ",\"completed_tokens\":" << completed_tokens
              << ",\"target_tokens_completed\":" << (completed_tokens == target_slots ? "true" : "false")
              << ",\"actual_wall_seconds\":" << static_cast<double>(finished_ns - started_ns) / 1e9
              << ",\"logical_bytes\":" << logical_bytes
              << ",\"planned_logical_bytes\":" << rotation.planned_bytes
              << ",\"planned_logical_gbps\":" << planned_logical_gbps
              << ",\"planned_rate_deviation_percent\":"
              << 100.0 * (planned_logical_gbps / target_logical_gbps - 1.0)
              << ",\"offered_logical_gbps\":" << offered_logical_gbps
              << ",\"process_diskio_bytes\":" << process_diskio_bytes
              << ",\"physical_over_logical\":"
              << (logical_bytes ? static_cast<double>(process_diskio_bytes) / logical_bytes : 0.0)
              << ",\"cache_participation\":"
              << (logical_bytes && process_diskio_bytes < logical_bytes
                  ? 1.0 - static_cast<double>(process_diskio_bytes) / logical_bytes : 0.0)
              << ",\"volumes\":{\"internal\":{\"bytes\":" << internal_bytes
              << "},\"external\":{\"bytes\":" << external_bytes << "}}"
              << ",\"requested_qd_per_volume\":" << options.queue_depth
              << ",\"effective_qd_per_volume\":" << reader.ring_plan().effective_queue_depth_per_volume
              << ",\"ring_bytes\":" << reader.ring_plan().ring_limit_bytes
              << ",\"f_nocache_internal\":true,\"f_nocache_external\":true"
              << ",\"token_completion\":{\"p50_us\":"
              << nearest_rank(token_completion_ns, 0.50) / 1'000U
              << ",\"p95_us\":" << nearest_rank(token_completion_ns, 0.95) / 1'000U
              << ",\"p99_us\":" << nearest_rank(token_completion_ns, 0.99) / 1'000U
              << ",\"maximum_us\":" << maximum_completion_ns / 1'000U << "}"
              << ",\"token_service\":{\"p50_us\":" << nearest_rank(token_service_ns, 0.50) / 1'000U
              << ",\"p95_us\":" << nearest_rank(token_service_ns, 0.95) / 1'000U << "}"
              << ",\"deadline_us\":" << period_ns / 1'000U
              << ",\"stall_episode_count\":" << episodes.size()
              << ",\"stall_episodes\":[";
    for (std::size_t index = 0; index < episodes.size(); ++index) {
        if (index != 0) {
            std::cout << ',';
        }
        const auto & episode = episodes[index];
        std::cout << "{\"first_slot\":" << episode.first_slot
                  << ",\"last_slot\":" << episode.last_slot
                  << ",\"tokens\":" << episode.tokens
                  << ",\"duration_seconds\":"
                  << static_cast<double>((episode.last_slot - episode.first_slot + 1U) * period_ns) / 1e9
                  << ",\"maximum_depth_tokens\":" << episode.maximum_depth_tokens
                  << ",\"maximum_completion_us\":" << episode.maximum_completion_ns / 1'000U << '}';
    }
    std::cout << "]}"
              << '\n';
    return completed_tokens == target_slots ? 0 : 75;
}

} // namespace

int main(int argc, char ** argv) {
    try {
        return run(parse_options(argc, argv));
    } catch (const std::exception & error) {
        std::cerr << "h4-paced-benchmark: " << error.what() << '\n';
        return 64;
    }
}

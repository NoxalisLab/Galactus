#include "h4-core.hpp"

#include <cerrno>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <iomanip>
#include <iostream>
#include <libproc.h>
#include <limits>
#include <random>
#include <stdexcept>
#include <string>
#include <sys/resource.h>
#include <sys/stat.h>
#include <unistd.h>

namespace {

struct Options {
    std::string internal_file;
    std::string external_file;
    std::uint64_t bytes = 0;
    std::uint64_t seed = 0;
    std::string order = "external-internal";
};

struct Result {
    std::string volume;
    std::string path;
    std::uint64_t offset;
    std::uint64_t logical_bytes;
    std::uint64_t process_diskio_bytes;
    double elapsed_seconds;
    bool f_nocache_applied;
};

std::string require_value(int argc, char ** argv, int & index, const std::string & option) {
    if (++index >= argc) {
        throw std::invalid_argument("missing value for " + option);
    }
    return argv[index];
}

std::uint64_t parse_u64(const std::string & value, const std::string & option) {
    std::size_t consumed = 0;
    const auto parsed = std::stoull(value, &consumed, 10);
    if (consumed != value.size()) {
        throw std::invalid_argument("invalid integer for " + option);
    }
    return parsed;
}

Options parse_options(int argc, char ** argv) {
    Options options;
    for (int index = 1; index < argc; ++index) {
        const std::string option = argv[index];
        if (option == "--internal-file") {
            options.internal_file = require_value(argc, argv, index, option);
        } else if (option == "--external-file") {
            options.external_file = require_value(argc, argv, index, option);
        } else if (option == "--bytes") {
            options.bytes = parse_u64(require_value(argc, argv, index, option), option);
        } else if (option == "--seed") {
            options.seed = parse_u64(require_value(argc, argv, index, option), option);
        } else if (option == "--order") {
            options.order = require_value(argc, argv, index, option);
        } else {
            throw std::invalid_argument("unknown option: " + option);
        }
    }
    if (options.internal_file.empty() || options.external_file.empty() || options.bytes == 0 ||
        options.bytes > 1024ULL * 1024ULL * 1024ULL ||
        options.bytes % galactus::h4::record_alignment_bytes != 0) {
        throw std::invalid_argument("sentinel requires two files and 16 KiB-aligned bytes <= 1 GiB");
    }
    if (options.order != "internal-external" && options.order != "external-internal") {
        throw std::invalid_argument("--order must be internal-external or external-internal");
    }
    return options;
}

std::uint64_t file_size(const std::string & path) {
    struct stat status {};
    if (stat(path.c_str(), &status) != 0 || !S_ISREG(status.st_mode) || status.st_size < 0) {
        throw std::runtime_error("cannot stat sentinel file: " + path);
    }
    return static_cast<std::uint64_t>(status.st_size);
}

std::uint64_t diskio_bytesread() {
    rusage_info_v4 usage = {};
    if (proc_pid_rusage(getpid(), RUSAGE_INFO_V4, reinterpret_cast<rusage_info_t *>(&usage)) != 0) {
        throw std::runtime_error("proc_pid_rusage failed: " + std::string(std::strerror(errno)));
    }
    return usage.ri_diskio_bytesread;
}

std::uint64_t random_offset(const std::string & path, std::uint64_t bytes, std::mt19937_64 & generator) {
    const auto size = file_size(path);
    if (size < bytes) {
        throw std::runtime_error("sentinel file is smaller than requested read");
    }
    const auto maximum_block = (size - bytes) / galactus::h4::record_alignment_bytes;
    std::uniform_int_distribution<std::uint64_t> distribution(0, maximum_block);
    return distribution(generator) * galactus::h4::record_alignment_bytes;
}

Result read_one(
    const std::string & volume,
    const std::string & path,
    std::uint64_t offset,
    std::uint64_t bytes,
    void * buffer) {
    const auto descriptor = open(path.c_str(), O_RDONLY | O_CLOEXEC);
    if (descriptor < 0) {
        throw std::runtime_error("cannot open sentinel file: " + std::string(std::strerror(errno)));
    }
    bool f_nocache_applied = false;
#if defined(__APPLE__)
    f_nocache_applied = fcntl(descriptor, F_NOCACHE, 1) == 0;
#endif
    if (!f_nocache_applied) {
        close(descriptor);
        throw std::runtime_error("sentinel requires F_NOCACHE");
    }
    const auto disk_before = diskio_bytesread();
    const auto started = std::chrono::steady_clock::now();
    std::uint64_t completed = 0;
    while (completed < bytes) {
        const auto result = pread(
            descriptor,
            static_cast<unsigned char *>(buffer) + completed,
            static_cast<std::size_t>(bytes - completed),
            static_cast<off_t>(offset + completed));
        if (result < 0) {
            if (errno == EINTR) {
                continue;
            }
            close(descriptor);
            throw std::runtime_error("sentinel pread failed: " + std::string(std::strerror(errno)));
        }
        if (result == 0) {
            close(descriptor);
            throw std::runtime_error("sentinel pread reached EOF");
        }
        completed += static_cast<std::uint64_t>(result);
    }
    const auto ended = std::chrono::steady_clock::now();
    const auto disk_after = diskio_bytesread();
    if (close(descriptor) != 0) {
        throw std::runtime_error("cannot close sentinel descriptor");
    }
    if (disk_after < disk_before) {
        throw std::logic_error("sentinel disk I/O counter regressed");
    }
    return {
        volume,
        path,
        offset,
        completed,
        disk_after - disk_before,
        std::chrono::duration<double>(ended - started).count(),
        f_nocache_applied,
    };
}

std::string json_escape(const std::string & input) {
    std::string output;
    for (const auto character : input) {
        if (character == '\\' || character == '"') {
            output += '\\';
        }
        output += character;
    }
    return output;
}

void print_result(const Result & result) {
    std::cout << "{\"path\":\"" << json_escape(result.path) << "\""
              << ",\"offset\":" << result.offset
              << ",\"logical_bytes\":" << result.logical_bytes
              << ",\"process_diskio_bytes\":" << result.process_diskio_bytes
              << ",\"physical_over_logical\":"
              << static_cast<double>(result.process_diskio_bytes) / result.logical_bytes
              << ",\"elapsed_seconds\":" << result.elapsed_seconds
              << ",\"logical_gbps\":" << result.logical_bytes / result.elapsed_seconds / 1e9
              << ",\"physical_gbps\":" << result.process_diskio_bytes / result.elapsed_seconds / 1e9
              << ",\"f_nocache_applied\":true}";
}

int run(const Options & options) {
    if (options.bytes > std::numeric_limits<std::size_t>::max()) {
        throw std::invalid_argument("sentinel buffer exceeds size_t");
    }
    void * buffer = nullptr;
    if (posix_memalign(&buffer, galactus::h4::record_alignment_bytes, static_cast<std::size_t>(options.bytes)) != 0) {
        throw std::bad_alloc();
    }
    std::memset(buffer, 0, static_cast<std::size_t>(options.bytes));
    try {
        std::mt19937_64 generator(options.seed);
        const auto internal_offset = random_offset(options.internal_file, options.bytes, generator);
        const auto external_offset = random_offset(options.external_file, options.bytes, generator);
        Result internal;
        Result external;
        const auto internal_first = options.order == "internal-external";
        if (internal_first) {
            internal = read_one("internal", options.internal_file, internal_offset, options.bytes, buffer);
            external = read_one("external", options.external_file, external_offset, options.bytes, buffer);
        } else {
            external = read_one("external", options.external_file, external_offset, options.bytes, buffer);
            internal = read_one("internal", options.internal_file, internal_offset, options.bytes, buffer);
        }
        std::free(buffer);
        std::cout << std::fixed << std::setprecision(9)
                  << "{\"schema\":\"galactus.h4.recovery-sentinel.v1\""
                  << ",\"seed\":" << options.seed
                  << ",\"bytes_per_volume\":" << options.bytes
                  << ",\"order\":\"" << (internal_first ? "internal-external" : "external-internal") << "\""
                  << ",\"internal\":";
        print_result(internal);
        std::cout << ",\"external\":";
        print_result(external);
        std::cout << "}\n";
        return 0;
    } catch (...) {
        std::free(buffer);
        throw;
    }
}

} // namespace

int main(int argc, char ** argv) {
    try {
        return run(parse_options(argc, argv));
    } catch (const std::exception & error) {
        std::cerr << "h4-sentinel: " << error.what() << '\n';
        return 64;
    }
}

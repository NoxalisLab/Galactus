#include <cerrno>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <string>
#include <sys/clonefile.h>
#include <sys/stat.h>
#include <unistd.h>

namespace {

struct Options {
    std::string source;
    std::string destination;
};

std::string require_value(int argc, char ** argv, int & index, const std::string & option) {
    if (++index >= argc) {
        throw std::invalid_argument("missing value for " + option);
    }
    return argv[index];
}

Options parse_options(int argc, char ** argv) {
    Options options;
    for (int index = 1; index < argc; ++index) {
        const std::string option = argv[index];
        if (option == "--source") {
            options.source = require_value(argc, argv, index, option);
        } else if (option == "--destination") {
            options.destination = require_value(argc, argv, index, option);
        } else {
            throw std::invalid_argument("unknown option: " + option);
        }
    }
    if (options.source.empty() || options.destination.empty() || options.source == options.destination) {
        throw std::invalid_argument("distinct --source and --destination are required");
    }
    return options;
}

struct stat checked_source(const std::string & path) {
    struct stat status {};
    if (lstat(path.c_str(), &status) != 0) {
        throw std::runtime_error("cannot lstat clone source: " + std::string(std::strerror(errno)));
    }
    if (!S_ISREG(status.st_mode)) {
        throw std::runtime_error("clone source must be a regular non-symlink file");
    }
    return status;
}

void require_absent(const std::string & path) {
    struct stat status {};
    if (lstat(path.c_str(), &status) == 0) {
        throw std::runtime_error("clone destination already exists");
    }
    if (errno != ENOENT) {
        throw std::runtime_error("cannot inspect clone destination: " + std::string(std::strerror(errno)));
    }
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

int run(const Options & options) {
    const auto source = checked_source(options.source);
    require_absent(options.destination);
    const int flags = CLONE_NOFOLLOW | CLONE_NOOWNERCOPY;
    if (clonefile(options.source.c_str(), options.destination.c_str(), flags) != 0) {
        throw std::runtime_error(
            "clonefile failed without fallback: " + std::string(std::strerror(errno)));
    }

    struct stat destination {};
    if (lstat(options.destination.c_str(), &destination) != 0) {
        throw std::runtime_error("cannot lstat clone destination after clonefile");
    }
    if (!S_ISREG(destination.st_mode) || destination.st_dev != source.st_dev ||
        destination.st_ino == source.st_ino || destination.st_size != source.st_size) {
        throw std::runtime_error("clone destination failed device/inode/size postconditions");
    }

    std::cout << "{\"schema\":\"galactus.h4.apfs-clone.v1\""
              << ",\"method\":\"clonefile(2)-no-fallback\""
              << ",\"source\":\"" << json_escape(options.source) << "\""
              << ",\"destination\":\"" << json_escape(options.destination) << "\""
              << ",\"bytes\":" << static_cast<std::uint64_t>(destination.st_size)
              << ",\"device\":" << static_cast<std::uint64_t>(destination.st_dev)
              << ",\"source_inode\":" << static_cast<std::uint64_t>(source.st_ino)
              << ",\"destination_inode\":" << static_cast<std::uint64_t>(destination.st_ino)
              << ",\"source_blocks_512\":" << static_cast<std::uint64_t>(source.st_blocks)
              << ",\"destination_blocks_512\":" << static_cast<std::uint64_t>(destination.st_blocks)
              << ",\"same_device\":true,\"distinct_inode\":true,\"same_size\":true}\n";
    return 0;
}

} // namespace

int main(int argc, char ** argv) {
    try {
        return run(parse_options(argc, argv));
    } catch (const std::exception & error) {
        std::cerr << "h4-clone-pack: " << error.what() << '\n';
        return 64;
    }
}

#pragma once

#include <CommonCrypto/CommonDigest.h>

#include <array>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iterator>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace galactus::b2c {

inline std::string sha256_file(const std::filesystem::path & path) {
    std::ifstream input(path, std::ios::binary);
    if (!input) {
        throw std::runtime_error("cannot open hash input: " + path.string());
    }
    std::vector<unsigned char> bytes(
        (std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
    if (input.bad()) {
        throw std::runtime_error("cannot read hash input: " + path.string());
    }
    if (bytes.size() > static_cast<size_t>(std::numeric_limits<CC_LONG>::max())) {
        throw std::runtime_error("hash input exceeds CommonCrypto one-shot limit");
    }
    std::array<unsigned char, CC_SHA256_DIGEST_LENGTH> digest{};
    CC_SHA256(bytes.data(), static_cast<CC_LONG>(bytes.size()), digest.data());
    std::ostringstream output;
    output << std::hex << std::setfill('0');
    for (const unsigned char byte : digest) {
        output << std::setw(2) << static_cast<unsigned int>(byte);
    }
    return output.str();
}

} // namespace galactus::b2c

#include "b2c-sha256-file.hpp"

#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <string_view>

namespace {

constexpr std::string_view EXPECTED_SHA256 =
    "74d665037fa25a34e8ef3ae566f57a7722b33146ce2be2e465b3aff7454c843a";

} // namespace

int main(int argc, char ** argv) {
    try {
        if (argc != 2) {
            throw std::runtime_error("usage: b2c-sha256-file-test FIXTURE");
        }
        const std::filesystem::path fixture(argv[1]);
        if (!std::filesystem::is_regular_file(fixture) ||
            std::filesystem::file_size(fixture) == 0) {
            throw std::runtime_error("fixture must be a non-empty regular file");
        }
        const std::string actual = galactus::b2c::sha256_file(fixture);
        if (actual != EXPECTED_SHA256) {
            std::cerr << "b2c-sha256-file-runtime=FAIL expected="
                      << EXPECTED_SHA256 << " actual=" << actual << '\n';
            return 1;
        }
        std::cout << "b2c-sha256-file-runtime=PASS sha256=" << actual
                  << "; metal=NOT_LINKED; token=NOT_APPLICABLE\n";
        return 0;
    } catch (const std::exception & error) {
        std::cerr << "b2c-sha256-file-runtime=ERROR detail=" << error.what()
                  << '\n';
        return 2;
    }
}

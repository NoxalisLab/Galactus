#include "h4-c1-contract.hpp"

#include <algorithm>
#include <array>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <vector>

namespace contract = galactus::c1_contract;

namespace {

void require(bool condition, const char * message) {
    if (!condition) {
        throw std::runtime_error(message);
    }
}

std::vector<std::uint8_t> healthy_outputs(int batch_size, std::size_t width) {
    std::vector<std::uint8_t> output(static_cast<std::size_t>(batch_size) * width);
    for (int position = 0; position < batch_size; ++position) {
        for (std::size_t byte = 0; byte < width; ++byte) {
            output.at(static_cast<std::size_t>(position) * width + byte) =
                static_cast<std::uint8_t>(17 * position + 3 * static_cast<int>(byte) + 1);
        }
    }
    return output;
}

std::vector<std::uint8_t> shifted_outputs(
    const std::vector<std::uint8_t> & canonical,
    int batch_size,
    std::size_t width) {
    std::vector<std::uint8_t> shifted(canonical.size());
    for (int destination = 0; destination < batch_size; ++destination) {
        const int source = (destination + contract::CYCLIC_SHIFT) % batch_size;
        std::copy_n(canonical.begin() + source * static_cast<std::ptrdiff_t>(width), width,
                    shifted.begin() + destination * static_cast<std::ptrdiff_t>(width));
    }
    return shifted;
}

} // namespace

int main() {
    constexpr std::size_t width = 32;
    for (const int batch_size : contract::BATCH_SIZES) {
        const auto inputs = contract::make_canonical_inputs(batch_size);
        require(inputs.size() == contract::INPUT_WIDTH * static_cast<std::size_t>(batch_size),
                "canonical input geometry mismatch");
        for (int position = 0; position < batch_size; ++position) {
            for (int coordinate = 0; coordinate < 8; ++coordinate) {
                const float expected = coordinate == position ? 1.0F : 0.0F;
                require(inputs.at(static_cast<std::size_t>(position) * contract::INPUT_WIDTH +
                                  static_cast<std::size_t>(coordinate)) == expected,
                        "collision-free prefix mismatch");
            }
        }
        const auto shifted_inputs = contract::cyclic_shift_inputs(inputs, batch_size);
        require(shifted_inputs.size() == inputs.size(), "shifted input geometry mismatch");

        const auto canonical = healthy_outputs(batch_size, width);
        const auto shifted = shifted_outputs(canonical, batch_size, width);
        const auto healthy = contract::evaluate_gate(canonical, shifted, batch_size, width);
        if (batch_size == 1) {
            require(healthy.status == contract::GateStatus::vacuous,
                    "K=1 gate must be vacuous");
            continue;
        }
        require(healthy.status == contract::GateStatus::pass, "healthy gate must pass");

        auto full_broadcast = canonical;
        for (int position = 1; position < batch_size; ++position) {
            std::copy_n(full_broadcast.begin(), width,
                        full_broadcast.begin() + position * static_cast<std::ptrdiff_t>(width));
        }
        require(contract::evaluate_gate(full_broadcast, full_broadcast, batch_size, width).status ==
                    contract::GateStatus::fail,
                "full broadcast must fail");

        auto partial_broadcast = canonical;
        std::copy_n(partial_broadcast.begin(), width,
                    partial_broadcast.begin() + static_cast<std::ptrdiff_t>(width));
        require(contract::evaluate_gate(
                    partial_broadcast,
                    shifted_outputs(partial_broadcast, batch_size, width),
                    batch_size, width).status == contract::GateStatus::fail,
                "partial broadcast must fail");

        require(contract::evaluate_gate(canonical, canonical, batch_size, width).status ==
                    contract::GateStatus::fail,
                "wrong permutation must fail");
    }

    require(contract::measured_slot_sums() == std::array<int, 5>{14, 14, 14, 14, 14},
            "measured slot means are not balanced");
    require(contract::measured_slot_variance_numerators() ==
                std::array<int, 5>{18, 12, 10, 12, 18},
            "measured slot variances changed");

    const std::vector<std::string> eight_identical(8, "digest-a");
    const auto identity_pass = contract::evaluate_digest_identity(eight_identical, 8);
    require(identity_pass.pass && identity_pass.occurrence_count == 8 &&
                identity_pass.mismatch_indices.empty(),
            "eight-occurrence digest identity must pass");
    auto one_drift = eight_identical;
    one_drift.at(6) = "digest-b";
    const auto identity_fail = contract::evaluate_digest_identity(one_drift, 8);
    require(!identity_fail.pass &&
                identity_fail.mismatch_indices == std::vector<std::size_t>{6},
            "single digest drift must fail at its exact index");
    require(!contract::evaluate_digest_identity(
                 std::vector<std::string>(7, "digest-a"), 8).pass,
            "missing digest occurrence must fail");
    require(!contract::evaluate_digest_identity(
                 std::vector<std::string>(8, ""), 8).pass,
            "empty digest reference must fail");
    auto one_empty = eight_identical;
    one_empty.at(3).clear();
    const auto one_empty_fail = contract::evaluate_digest_identity(one_empty, 8);
    require(!one_empty_fail.pass &&
                one_empty_fail.mismatch_indices == std::vector<std::size_t>{3},
            "one empty digest must fail at its exact index");
    require(!contract::evaluate_digest_identity(
                 std::vector<std::string>{"digest-a"}, 1).pass,
            "a single expected occurrence must fail");
    std::cout << "C1 contract tests: pass\n";
    return 0;
}

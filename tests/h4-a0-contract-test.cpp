#include "h4-a0-contract.hpp"

#include <cstdlib>
#include <iostream>
#include <set>
#include <string_view>

namespace {

void require(bool condition, std::string_view message) {
    if (!condition) {
        std::cerr << "FAIL: " << message << '\n';
        std::exit(1);
    }
}

}  // namespace

int main() {
    using namespace h4::a0;

    require(kFixedRungs.size() == 7, "fixed rung cardinality");
    std::set<std::string_view> ids;
    for (const FixedRung & rung : kFixedRungs) {
        require(rung.bytes > 0, "zero-sized fixed rung");
        require(ids.insert(rung.id).second, "duplicate fixed rung id");
    }
    require(kFixedMetalBytes == 23'369'768'960ULL, "Metal fixed sum");
    require(kFixedCpuBytes == 999'557'048ULL, "CPU fixed sum");
    require(kTargetConservativeMetalChargeBytes == 118'770'300'856ULL,
            "conservative Metal target");
    require(kDecisionMarginBytes == 2'286'466'652ULL, "decision margin");

    require(classify({false, true, true, false, false, false}) ==
                Verdict::inconclusive_invalid,
            "invalid control cannot open");
    require(classify({true, true, true, false, false, false}) ==
                Verdict::open_15_physical_envelope,
            "complete healthy target opens");
    require(classify({true, false, false, true, false, true}) ==
                Verdict::closed_observed_under_contract,
            "capacity gate closes");
    require(classify({true, false, false, false, true, false}) ==
                Verdict::allocation_failure_without_observed_pressure,
            "allocation failure without pressure stays non-causal");
    require(classify({true, false, false, false, true, true}) ==
                Verdict::closed_observed_under_contract,
            "allocation failure with observed pressure closes");
    require(classify({true, true, false, false, false, false}) ==
                Verdict::inconclusive_invalid,
            "target without hold cannot open");

    require(pattern_word(1, 0) != 0, "pattern must be non-zero");
    require(pattern_word(1, 0) != pattern_word(2, 0), "resource patterns differ");
    require(pattern_word(1, 0) != pattern_word(1, kPageSizeBytes),
            "page patterns differ");

    std::cout << "h4-a0-contract: PASS\n";
    return 0;
}

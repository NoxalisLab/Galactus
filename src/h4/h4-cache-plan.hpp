#pragma once

// Cache plan: how many slots each MoE layer should get, and why not the same
// number for all of them.
//
// THE MEASUREMENT THAT MOTIVATES THIS
//
// The expert cache gives every layer the same quota. The layers are not the
// same. Replayed on the real routing traces of artifacts/h4/routes, qwen3-30b
// serves 45.7 percent of layer 0's accesses from RAM and 84 to 92 percent of
// the accesses of every layer from the tenth on. A slot given to layer 0
// removes several times more device reads than the same slot given to layer
// 20, and the SSD is the bottleneck by construction, so that difference is
// throughput sitting on the table.
//
// WHAT THE ALLOCATION IS ALLOWED TO DEPEND ON
//
// The arena is laid out once, before the first token: layer L's three expert
// tensors are 3D views whose ne[2] is that layer's slot count and whose nb[2]
// is the record size, backed at a fixed address inside one buffer. Slots of a
// layer are therefore contiguous and their number is frozen at construction.
// Nothing can move a slot from one layer to another while the model runs, so
// no online scheme can do this job. The allocation has to come from something
// knowable before the run.
//
// What can be known before the run is how each layer's miss count falls as
// its quota grows. That curve is a property of the MODEL: routing is bit
// exact and never depends on the cache, so one recorded trace answers the
// question at every quota at once, and the same curve is valid on a machine
// with a different budget. scripts/derive-cache-plan.py measures it and
// writes it here; this unit reads it back and runs the allocator against the
// budget THIS machine has.
//
// WHAT IT COSTS IN MEMORY: NOTHING
//
// The budget handed to the allocator is exactly the arena the uniform quota
// would have bought, to the byte. This moves slots between layers; it never
// asks for one more.
//
// FAIL OPEN, DELIBERATELY
//
// A plan is an optimisation, not a correctness input. A missing file, a plan
// for another architecture, a plan whose layer range does not match the
// active profile: every one of those falls back to the uniform quota and says
// so on stderr. The one thing that is never tolerated is a plan that parses
// as something other than what it is, which is why the header is checked and
// every malformed line throws.

#include <cstdint>
#include <string>
#include <vector>

namespace galactus::h4 {

struct CachePlan {
    std::string architecture;
    std::uint32_t first_layer = 0;
    std::uint32_t last_layer = 0;
    std::uint32_t experts = 0;
    std::string source;
    // curves[layer index][quota] = misses that layer took at that quota over
    // the measured window. Index 0 IS quota 0, so the reader never has to
    // remember an offset. Entries 0 and 1 repeat the value at quota 2, which
    // is the smallest quota the engine accepts.
    std::vector<std::vector<std::uint32_t>> curves;

    [[nodiscard]] std::uint32_t layer_count() const noexcept {
        return last_layer - first_layer + 1;
    }

    static CachePlan load(const std::string & path);

    // The plan for this process, or nullptr when there is none.
    //
    //   GALACTUS_H4_CACHE_PLAN=<path>      use this plan
    //   otherwise                          cache-plan.txt beside GALACTUS_PROFILE
    //
    // Loaded once, on first call. Returns nullptr whenever the selected policy
    // does not want a plan.
    static const CachePlan * active();
};

// Which cache policy this process runs, from GALACTUS_H4_CACHE_POLICY.
//
//   (unset) or auto   plan plus frequency victim, the default
//   uniform           the policy that shipped before this work, unchanged
//   plan              plan only, LRU victim
//   frequency         equal quota, frequency victim
//
// One variable, four values, so a regression can be bisected to either half
// of this work in a single run and the certification can be taken both ways.
struct CachePolicySelection {
    bool use_plan = true;
    bool frequency_victim = true;

    static const CachePolicySelection & active();
};

// Spend a byte budget where a slot removes the most reads.
//
// Every layer starts at the floor, then slots go one group at a time to
// whichever layer offers the steepest fall in misses per byte spent. An SLRU
// is not a stack algorithm, so a curve can rise when the quota grows and a
// single step can be flat in front of a cliff; the candidate for a layer is
// therefore the best AVERAGE slope over a run of consecutive slots, which is
// the concave envelope of its curve, and not the next single step. Ties go to
// the lowest layer index, so the result is a deterministic function of the
// inputs and can be checked against the Python allocator that produced every
// published number.
//
// record_bytes is indexed the same way as curves. The result never costs more
// than budget_bytes and never puts a layer below floor or above ceiling.
std::vector<std::uint32_t> plan_layer_quotas(
    const std::vector<std::vector<std::uint32_t>> & curves,
    const std::vector<std::uint64_t> & record_bytes,
    std::uint64_t budget_bytes,
    std::uint32_t floor,
    std::uint32_t ceiling);

}  // namespace galactus::h4

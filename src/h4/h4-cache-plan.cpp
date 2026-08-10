#include "h4-cache-plan.hpp"

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>

namespace galactus::h4 {

namespace {

constexpr const char * plan_magic = "galactus-cache-plan";
constexpr int plan_version = 1;

// The plan sits beside the profile sidecar, under a fixed name, so that a
// model directory carries its own plan and no launcher has to learn a new
// flag. An explicit GALACTUS_H4_CACHE_PLAN overrides that.
std::string plan_beside_profile() {
    const char * profile = std::getenv("GALACTUS_PROFILE");
    if (profile == nullptr || profile[0] == '\0') return {};
    std::string path = profile;
    const auto cut = path.find_last_of('/');
    if (cut == std::string::npos) return "cache-plan.txt";
    return path.substr(0, cut + 1) + "cache-plan.txt";
}

}  // namespace

CachePlan CachePlan::load(const std::string & path) {
    std::ifstream in(path);
    if (!in) throw std::runtime_error("plan de cache illisible: " + path);
    std::string magic;
    int version = 0;
    in >> magic >> version;
    if (magic != plan_magic || version != plan_version) {
        throw std::runtime_error("plan de cache (" + path + "): en-tete inconnu");
    }
    CachePlan plan;
    std::uint32_t used = 0;
    bool ended = false;
    std::string key;
    while (in >> key) {
        if (key == "arch") in >> plan.architecture;
        else if (key == "first_layer") in >> plan.first_layer;
        else if (key == "last_layer") in >> plan.last_layer;
        else if (key == "experts") in >> plan.experts;
        else if (key == "used") in >> used;
        else if (key == "source") in >> plan.source;
        else if (key == "tokens") { std::uint64_t t = 0; in >> t; }
        else if (key == "curve") {
            std::uint32_t layer = 0;
            in >> layer;
            const std::uint32_t expected = plan.first_layer +
                static_cast<std::uint32_t>(plan.curves.size());
            if (layer != expected) {
                throw std::runtime_error("plan de cache (" + path
                    + "): courbes non contigues a " + std::to_string(layer));
            }
            if (plan.experts == 0) {
                throw std::runtime_error("plan de cache (" + path
                    + "): une courbe avant le nombre d'experts");
            }
            std::vector<std::uint32_t> row(static_cast<std::size_t>(plan.experts) + 1);
            for (auto & value : row) {
                if (!(in >> value)) {
                    throw std::runtime_error("plan de cache (" + path + "): courbe couche "
                        + std::to_string(layer) + " trop courte");
                }
            }
            plan.curves.push_back(std::move(row));
        } else if (key == "end") { ended = true; break; }
        else throw std::runtime_error("plan de cache (" + path + "): clef inconnue " + key);
        if (!in) throw std::runtime_error("plan de cache (" + path + "): lecture interrompue");
    }
    if (!ended) throw std::runtime_error("plan de cache (" + path + "): fin sans 'end'");
    if (plan.first_layer > plan.last_layer) {
        throw std::runtime_error("plan de cache (" + path + "): plage de couches inversee");
    }
    if (plan.curves.size() != plan.layer_count()) {
        throw std::runtime_error("plan de cache (" + path + "): "
            + std::to_string(plan.curves.size()) + " courbes pour "
            + std::to_string(plan.layer_count()) + " couches");
    }
    return plan;
}

const CachePolicySelection & CachePolicySelection::active() {
    static const CachePolicySelection instance = [] {
        CachePolicySelection selection;
        const char * policy = std::getenv("GALACTUS_H4_CACHE_POLICY");
        const std::string name = policy == nullptr || policy[0] == '\0' ? "auto" : policy;
        if (name == "auto") {
            // The default. Nothing is printed: the plan and the victim rule
            // each say what they did when they do it.
        } else if (name == "uniform") {
            selection.use_plan = false;
            selection.frequency_victim = false;
            std::fprintf(stderr, "galactus_h4: GALACTUS_H4_CACHE_POLICY=uniform, "
                                 "quota egal par couche et victime LRU\n");
        } else if (name == "plan") {
            selection.frequency_victim = false;
            std::fprintf(stderr, "galactus_h4: GALACTUS_H4_CACHE_POLICY=plan, "
                                 "victime LRU\n");
        } else if (name == "frequency") {
            selection.use_plan = false;
            std::fprintf(stderr, "galactus_h4: GALACTUS_H4_CACHE_POLICY=frequency, "
                                 "quota egal par couche\n");
        } else {
            // Fail closed on a value nobody defined: a typo that silently
            // selected the default would make a bisection lie.
            throw std::runtime_error(
                "galactus_h4: GALACTUS_H4_CACHE_POLICY=" + name
                + " inconnu (auto, uniform, plan, frequency)");
        }
        return selection;
    }();
    return instance;
}

const CachePlan * CachePlan::active() {
    static const CachePlan * instance = [] () -> const CachePlan * {
        if (!CachePolicySelection::active().use_plan) return nullptr;
        const char * explicit_path = std::getenv("GALACTUS_H4_CACHE_PLAN");
        std::string path = explicit_path != nullptr ? explicit_path : plan_beside_profile();
        if (path.empty()) return nullptr;
        try {
            auto * plan = new CachePlan(load(path));
            std::fprintf(stderr, "galactus_h4: plan de cache %s (arch %s, source %s)\n",
                         path.c_str(), plan->architecture.c_str(), plan->source.c_str());
            return plan;
        } catch (const std::exception & error) {
            // A plan is an optimisation. Its absence is the normal case and
            // must stay silent; anything else is worth one line and then the
            // uniform quota, which is always correct.
            if (explicit_path != nullptr) {
                std::fprintf(stderr, "galactus_h4: %s, quota egal par couche\n", error.what());
            }
            return nullptr;
        }
    }();
    return instance;
}

std::vector<std::uint32_t> plan_layer_quotas(
        const std::vector<std::vector<std::uint32_t>> & curves,
        const std::vector<std::uint64_t> & record_bytes,
        std::uint64_t budget_bytes,
        std::uint32_t floor,
        std::uint32_t ceiling) {
    if (curves.size() != record_bytes.size()) {
        throw std::invalid_argument("plan de cache: courbes et enregistrements de tailles "
                                    "differentes");
    }
    if (floor > ceiling) {
        throw std::invalid_argument("plan de cache: plancher au dessus du plafond");
    }
    const std::size_t count = curves.size();
    std::vector<std::uint32_t> quotas(count, floor);
    std::uint64_t spent = 0;
    for (std::size_t index = 0; index < count; ++index) {
        spent += static_cast<std::uint64_t>(floor) * record_bytes[index];
    }
    if (spent > budget_bytes) {
        throw std::invalid_argument("plan de cache: le plancher depasse deja le budget");
    }

    // The best average slope from a layer's current quota, and how many slots
    // it takes to get it. A slope of zero means the layer has nothing left to
    // offer at any depth, and take == 0 takes it out of the running.
    struct Step { double slope; std::uint32_t take; };
    auto best_step = [&](std::size_t index) -> Step {
        const auto & row = curves[index];
        const std::uint32_t here = quotas[index];
        const std::uint32_t top = ceiling < static_cast<std::uint32_t>(row.size() - 1)
            ? ceiling : static_cast<std::uint32_t>(row.size() - 1);
        Step best{0.0, 0};
        if (here >= top) return best;
        const double cost = static_cast<double>(record_bytes[index]);
        for (std::uint32_t take = 1; take <= top - here; ++take) {
            const std::uint32_t before = row[here];
            const std::uint32_t after = row[here + take];
            if (after >= before) continue;   // a curve that rises buys nothing
            const double gain = static_cast<double>(before - after);
            const double slope = gain / (static_cast<double>(take) * cost);
            if (slope > best.slope) best = Step{slope, take};
        }
        return best;
    };

    std::vector<Step> pending(count);
    for (std::size_t index = 0; index < count; ++index) pending[index] = best_step(index);

    for (;;) {
        bool found = false;
        double best_slope = 0.0;
        std::size_t best_index = 0;
        std::uint32_t best_take = 0;
        std::uint64_t best_cost = 0;
        for (std::size_t index = 0; index < count; ++index) {
            const Step step = pending[index];
            if (step.take == 0) continue;
            const std::uint64_t cost =
                static_cast<std::uint64_t>(step.take) * record_bytes[index];
            if (spent + cost > budget_bytes) continue;
            // Strictly greater, scanning upwards: a tie goes to the lowest
            // layer, which is what makes this a function and not a choice.
            if (!found || step.slope > best_slope) {
                found = true;
                best_slope = step.slope;
                best_index = index;
                best_take = step.take;
                best_cost = cost;
            }
        }
        if (!found) break;
        quotas[best_index] += best_take;
        spent += best_cost;
        pending[best_index] = best_step(best_index);
    }
    return quotas;
}

}  // namespace galactus::h4

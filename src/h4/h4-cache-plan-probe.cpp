// Expose le plan de cache et son allocateur au differentiel Python.
//
// L'allocateur C++ decide combien de places chaque couche recoit dans l'arene.
// Toutes les mesures publiees (scripts/replay-cache.py) viennent de
// l'allocateur Python. Deux implementations d'une meme regle divergent tot ou
// tard ; celle-ci est donc comparee a l'autre, sur les vrais plans, par
// scripts/tests/test-cache-plan-differential.py. Un ecart d'une seule place
// fait echouer le test, parce qu'une place en plus ou en moins quelque part
// est exactement ce que ce travail pretend controler.
//
// Sortie : une ligne "quota <couche> <places>" par couche, puis "bytes <n>".

#include "h4-cache-plan.hpp"

#include <cinttypes>
#include <cstdio>
#include <cstdlib>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

std::uint64_t parse_u64(const char * text) {
    char * end = nullptr;
    const auto value = std::strtoull(text, &end, 10);
    if (end == text || *end != '\0') throw std::runtime_error("entier attendu");
    return value;
}

}  // namespace

int main(int argc, char ** argv) try {
    std::string plan_path;
    std::uint64_t record_bytes = 0;
    std::uint64_t budget = 0;
    std::uint32_t floor = 0;
    std::uint32_t ceiling = 0;

    for (int index = 1; index < argc; ++index) {
        const std::string option = argv[index];
        auto next = [&]() -> const char * {
            if (index + 1 >= argc) throw std::runtime_error("valeur manquante pour " + option);
            return argv[++index];
        };
        if (option == "--plan") plan_path = next();
        else if (option == "--record-bytes") record_bytes = parse_u64(next());
        else if (option == "--budget") budget = parse_u64(next());
        else if (option == "--floor") floor = static_cast<std::uint32_t>(parse_u64(next()));
        else if (option == "--ceiling") ceiling = static_cast<std::uint32_t>(parse_u64(next()));
        else throw std::runtime_error("option inconnue: " + option);
    }
    if (plan_path.empty()) throw std::runtime_error("--plan est requis");
    if (record_bytes == 0) throw std::runtime_error("--record-bytes est requis");

    const auto plan = galactus::h4::CachePlan::load(plan_path);
    std::vector<std::uint64_t> records(plan.layer_count(), record_bytes);
    if (ceiling == 0) ceiling = plan.experts;
    if (budget == 0) throw std::runtime_error("--budget est requis");

    const auto quotas = galactus::h4::plan_layer_quotas(plan.curves, records, budget,
                                                        floor, ceiling);
    std::uint64_t spent = 0;
    for (std::size_t index = 0; index < quotas.size(); ++index) {
        std::printf("quota %u %u\n", plan.first_layer + static_cast<std::uint32_t>(index),
                    quotas[index]);
        spent += static_cast<std::uint64_t>(quotas[index]) * records[index];
    }
    std::printf("bytes %" PRIu64 "\n", spent);
    return 0;
} catch (const std::exception & error) {
    std::fprintf(stderr, "erreur: %s\n", error.what());
    return 2;
}

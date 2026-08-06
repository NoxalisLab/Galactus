// Rejeu des traces reelles a travers le cache C++, pour verifier qu'il
// reproduit EXACTEMENT la politique simulee en Python.
//
// Un nouvel instrument se teste contre l'ancien avant de servir (regle 15).
// Les valeurs attendues sont passees en ligne de commande ; toute divergence,
// meme d'un octet, fait echouer le binaire.
//
// Entrees : les tableaux compacts produits par scripts/trace-compact.py,
//   <base>.keys.u32   uint32  (layer << key_expert_bits) | expert
//   <base>.phase.u8   uint8   index de phase
// L'ordre de rejeu est l'ordre trie des noms, comme dans le simulateur.

#include "h4-expert-cache.hpp"

#include <algorithm>
#include <cinttypes>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dirent.h>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

namespace {

std::vector<std::string> sorted_bases(const std::string & directory) {
    std::vector<std::string> bases;
    DIR * handle = opendir(directory.c_str());
    if (handle == nullptr) {
        throw std::runtime_error("cannot open trace directory: " + directory);
    }
    while (dirent * entry = readdir(handle)) {
        const std::string name = entry->d_name;
        const std::string suffix = ".keys.u32";
        if (name.size() > suffix.size() &&
            name.compare(name.size() - suffix.size(), suffix.size(), suffix) == 0) {
            bases.push_back(name.substr(0, name.size() - suffix.size()));
        }
    }
    closedir(handle);
    std::sort(bases.begin(), bases.end());
    return bases;
}

template <typename T>
std::vector<T> read_all(const std::string & path) {
    std::ifstream input(path, std::ios::binary | std::ios::ate);
    if (!input) throw std::runtime_error("cannot open: " + path);
    const auto size = static_cast<std::size_t>(input.tellg());
    if (size % sizeof(T) != 0) throw std::runtime_error("ragged file: " + path);
    input.seekg(0);
    std::vector<T> data(size / sizeof(T));
    input.read(reinterpret_cast<char *>(data.data()), static_cast<std::streamsize>(size));
    if (!input) throw std::runtime_error("short read: " + path);
    return data;
}

std::uint64_t parse_u64(const char * text) {
    char * end = nullptr;
    const auto value = std::strtoull(text, &end, 10);
    if (end == text || *end != '\0') throw std::runtime_error("expected an integer");
    return value;
}

}  // namespace

int main(int argc, char ** argv) try {
    std::string trace_directory;
    std::uint64_t capacity_bytes = 99'868'171'264ULL;
    double protected_fraction = 0.75;
    std::uint8_t generation_phase = 1;
    std::uint64_t expect_hits = 0, expect_accesses = 0, expect_cold = 0;
    bool have_expectations = false;

    for (int index = 1; index < argc; ++index) {
        const std::string option = argv[index];
        auto next = [&]() -> const char * {
            if (index + 1 >= argc) throw std::runtime_error("missing value for " + option);
            return argv[++index];
        };
        if (option == "--trace-directory") trace_directory = next();
        else if (option == "--capacity-bytes") capacity_bytes = parse_u64(next());
        else if (option == "--protected-fraction") protected_fraction = std::atof(next());
        else if (option == "--generation-phase") generation_phase = static_cast<std::uint8_t>(parse_u64(next()));
        else if (option == "--expect-hits") { expect_hits = parse_u64(next()); have_expectations = true; }
        else if (option == "--expect-accesses") { expect_accesses = parse_u64(next()); have_expectations = true; }
        else if (option == "--expect-cold-bytes") { expect_cold = parse_u64(next()); have_expectations = true; }
        else throw std::runtime_error("unknown option: " + option);
    }
    if (trace_directory.empty()) throw std::runtime_error("--trace-directory is required");

    galactus::h4::ExpertCache cache(capacity_bytes, protected_fraction);
    std::printf("capacite %" PRIu64 " octets : %u experts par couche, %u proteges, %u en probation\n",
                capacity_bytes, cache.quota_per_layer(),
                cache.protected_quota(), cache.probation_quota());

    std::uint64_t hits = 0, accesses = 0, cold = 0;
    for (const auto & base : sorted_bases(trace_directory)) {
        const auto keys = read_all<std::uint32_t>(trace_directory + "/" + base + ".keys.u32");
        const auto phases = read_all<std::uint8_t>(trace_directory + "/" + base + ".phase.u8");
        if (keys.size() != phases.size()) throw std::runtime_error("length mismatch: " + base);
        std::uint64_t h = 0, a = 0, c = 0;
        for (std::size_t i = 0; i < keys.size(); ++i) {
            const bool counted = phases[i] == generation_phase;
            const std::uint32_t layer = keys[i] >> galactus::h4::key_expert_bits;
            const bool was_resident = cache.resident(keys[i]);
            cache.touch(keys[i]);
            if (!counted) continue;
            ++a;
            if (was_resident) ++h;
            else c += cache.expert_bytes(layer);
        }
        hits += h; accesses += a; cold += c;
        std::printf("  %-56s hits %8" PRIu64 " / %8" PRIu64 "  froid %15" PRIu64 "\n",
                    base.c_str(), h, a, c);
    }

    std::printf("\nGENERATION  hits %" PRIu64 " / %" PRIu64 "  taux %.9f  froid %" PRIu64 " octets\n",
                hits, accesses, static_cast<double>(hits) / static_cast<double>(accesses), cold);
    std::printf("            resident en fin de rejeu %" PRIu64 " octets (budget %" PRIu64 ")\n",
                cache.resident_bytes(), capacity_bytes);

    if (have_expectations) {
        bool ok = true;
        auto check = [&](const char * name, std::uint64_t got, std::uint64_t want) {
            if (want == 0) return;
            if (got != want) {
                std::printf("DIVERGENCE %s : obtenu %" PRIu64 ", attendu %" PRIu64 " (ecart %+" PRId64 ")\n",
                            name, got, want, static_cast<std::int64_t>(got) - static_cast<std::int64_t>(want));
                ok = false;
            } else {
                std::printf("CONCORDE   %s = %" PRIu64 "\n", name, got);
            }
        };
        check("hits", hits, expect_hits);
        check("accesses", accesses, expect_accesses);
        check("cold_bytes", cold, expect_cold);
        if (!ok) {
            std::printf("\nECHEC : le cache C++ ne reproduit pas la politique simulee.\n");
            return 1;
        }
        std::printf("\nOK : le cache C++ reproduit la politique simulee a l'octet.\n");
    }
    return 0;
} catch (const std::exception & error) {
    std::fprintf(stderr, "erreur: %s\n", error.what());
    return 2;
}

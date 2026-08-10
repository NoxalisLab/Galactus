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
#include <sstream>
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

// Rejeu direct d'un fichier .routes ecrit par GALACTUS_H4_ROUTES.
//
// Les tableaux compacts ci-dessus datent d'un outil qui n'existe plus. Le
// fichier de routes, lui, est ce que le moteur ecrit aujourd'hui et ce que
// scripts/replay-cache.py lit, et c'est ce qui permet de comparer CE cache a
// la simulation Python sur les memes octets. Une entree "e" est un micro-lot
// d'une couche : c'est aussi la frontiere de lot que le cache doit connaitre,
// donc begin_batch est appele la, exactement comme le magasin le fait.
struct RouteEntry {
    std::uint32_t layer = 0;
    std::vector<std::uint32_t> experts;
};

std::vector<RouteEntry> read_routes(const std::string & path, std::uint32_t & first_layer,
                                    std::uint32_t & last_layer) {
    std::ifstream input(path);
    if (!input) throw std::runtime_error("cannot open: " + path);
    std::vector<RouteEntry> entries;
    std::string line;
    while (std::getline(input, line)) {
        if (line.rfind("# first_layer ", 0) == 0) {
            std::istringstream header(line.substr(1));
            std::string key, k2, k3, k4;
            std::uint32_t experts = 0, used = 0;
            header >> key >> first_layer >> k2 >> last_layer >> k3 >> experts >> k4 >> used;
            continue;
        }
        if (line.rfind("e ", 0) != 0) continue;
        std::istringstream fields(line);
        std::string tag;
        std::uint64_t seq = 0, tokens = 0, k = 0, a = 0, b = 0, c = 0, d = 0, e = 0;
        RouteEntry entry;
        fields >> tag >> seq >> entry.layer >> tokens >> k >> a >> b >> c >> d >> e;
        std::string token;
        while (fields >> token) {
            const auto colon = token.find(':');
            if (colon == std::string::npos) throw std::runtime_error("malformed route id");
            entry.experts.push_back(static_cast<std::uint32_t>(
                std::strtoul(token.substr(0, colon).c_str(), nullptr, 10)));
        }
        entries.push_back(std::move(entry));
    }
    if (entries.empty()) throw std::runtime_error("no entry in: " + path);
    return entries;
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
    std::string routes_file;
    std::uint64_t generation_steps = 256;
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
        else if (option == "--routes") routes_file = next();
        else if (option == "--generation-steps") generation_steps = parse_u64(next());
        else if (option == "--capacity-bytes") capacity_bytes = parse_u64(next());
        else if (option == "--protected-fraction") protected_fraction = std::atof(next());
        else if (option == "--generation-phase") generation_phase = static_cast<std::uint8_t>(parse_u64(next()));
        else if (option == "--expect-hits") { expect_hits = parse_u64(next()); have_expectations = true; }
        else if (option == "--expect-accesses") { expect_accesses = parse_u64(next()); have_expectations = true; }
        else if (option == "--expect-cold-bytes") { expect_cold = parse_u64(next()); have_expectations = true; }
        else throw std::runtime_error("unknown option: " + option);
    }
    if (trace_directory.empty() && routes_file.empty()) {
        throw std::runtime_error("--trace-directory or --routes is required");
    }

    galactus::h4::ExpertCache cache(capacity_bytes, protected_fraction);
    const auto first = galactus::h4::ExpertCache::first_layer();
    std::printf("capacite %" PRIu64 " octets : quota uniforme %u, couche %u a %u places "
                "(%u protegees, %u en probation), plan %s\n",
                capacity_bytes, cache.quota_per_layer(), first, cache.quota_of(first),
                cache.protected_quota_of(first), cache.probation_quota_of(first),
                cache.planned() ? "actif" : "absent");

    if (!routes_file.empty()) {
        std::uint32_t first = 0, last = 0;
        const auto entries = read_routes(routes_file, first, last);
        // Meme decoupage en pas que le simulateur : une couche dont l'indice
        // ne croit pas ouvre un nouveau token.
        std::vector<std::size_t> step_start;
        std::uint32_t previous = 0;
        bool have_previous = false;
        for (std::size_t index = 0; index < entries.size(); ++index) {
            if (!have_previous || entries[index].layer <= previous) step_start.push_back(index);
            previous = entries[index].layer;
            have_previous = true;
        }
        const std::size_t boundary = step_start.size() > generation_steps
            ? step_start.size() - static_cast<std::size_t>(generation_steps) : 0;
        const std::size_t counted_from = step_start[boundary];
        std::uint64_t h = 0, a = 0;
        for (std::size_t index = 0; index < entries.size(); ++index) {
            const auto & entry = entries[index];
            const bool counted = index >= counted_from;
            cache.begin_batch(entry.layer);
            for (const auto expert : entry.experts) {
                const std::uint32_t key = (entry.layer << galactus::h4::key_expert_bits) | expert;
                const bool hit = cache.touch(key);
                if (!counted) continue;
                ++a;
                if (hit) ++h;
            }
        }
        std::printf("ROUTES %s\n", routes_file.c_str());
        std::printf("steps %zu generation %" PRIu64 " hits %" PRIu64 " accesses %" PRIu64 "\n",
                    step_start.size(), generation_steps, h, a);
        return 0;
    }

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

// Banc de forme-decodage : le chemin cache + lecteur, sur les vrais packs,
// avec la politique reelle et les traces reelles.
//
// Mesure directement la question du recouvrement, en deux regimes :
//   --mode token   toutes les lectures manquantes des 75 couches emises d'un
//                  coup. Borne haute, suppose l'avance de routes.
//   --mode layer   couche par couche, chaque couche attendue avant la suivante.
//                  Regime reel : le routeur de la couche n lit l'etat cache
//                  apres l'attention de n, on ne peut pas lire plus tot.
//
// Le cache est chauffe par la phase de prompt A TRAVERS LA POLITIQUE SEULE,
// sans E/S : le motif de succes de la generation devient exact et seul le
// temps de la generation est mesure. Ce banc mesure du temps, pas du contenu.
//
// Le temps de CALCUL n'est pas inclus. Il vaut 0,8149 ms par couche, mesure
// separement (tour113), dont 0,5126 d'attention qui precede le routeur.

#include "h4-expert-store.hpp"

#include <algorithm>
#include <cinttypes>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dirent.h>
#include <numeric>
#include <fstream>
#include <string>
#include <vector>

namespace {

using namespace galactus::h4;

constexpr std::size_t accesses_per_token = 600;  // 75 couches x 8 experts

std::vector<std::string> sorted_bases(const std::string & directory) {
    std::vector<std::string> bases;
    DIR * handle = opendir(directory.c_str());
    if (handle == nullptr) throw std::runtime_error("cannot open " + directory);
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
    if (!input) throw std::runtime_error("cannot open " + path);
    const auto size = static_cast<std::size_t>(input.tellg());
    input.seekg(0);
    std::vector<T> data(size / sizeof(T));
    input.read(reinterpret_cast<char *>(data.data()), static_cast<std::streamsize>(size));
    return data;
}

std::uint64_t parse_u64(const char * text) {
    char * end = nullptr;
    const auto value = std::strtoull(text, &end, 10);
    if (end == text || *end != '\0') throw std::runtime_error("expected an integer");
    return value;
}

double percentile(std::vector<std::uint64_t> values, double fraction) {
    if (values.empty()) return 0.0;
    std::sort(values.begin(), values.end());
    const auto index = static_cast<std::size_t>(fraction * static_cast<double>(values.size() - 1));
    return static_cast<double>(values[index]);
}

}  // namespace

int main(int argc, char ** argv) try {
    std::string internal_path, external_path, trace_directory;
    std::uint64_t capacity_bytes = 99'868'171'264ULL;
    double protected_fraction = 0.75;
    std::uint32_t queue_depth = 32;
    std::uint32_t split = 1;      // requetes par part d'enregistrement et par volume
    std::uint64_t documents = 0;   // 0 = tous
    ServeMode mode = ServeMode::layer;
    std::uint8_t generation_phase = 1;

    for (int index = 1; index < argc; ++index) {
        const std::string option = argv[index];
        auto next = [&]() -> const char * {
            if (index + 1 >= argc) throw std::runtime_error("missing value for " + option);
            return argv[++index];
        };
        if (option == "--internal-file") internal_path = next();
        else if (option == "--external-file") external_path = next();
        else if (option == "--trace-directory") trace_directory = next();
        else if (option == "--capacity-bytes") capacity_bytes = parse_u64(next());
        else if (option == "--protected-fraction") protected_fraction = std::atof(next());
        else if (option == "--qd") queue_depth = static_cast<std::uint32_t>(parse_u64(next()));
        else if (option == "--split") split = static_cast<std::uint32_t>(parse_u64(next()));
        else if (option == "--documents") documents = parse_u64(next());
        else if (option == "--generation-phase") generation_phase = static_cast<std::uint8_t>(parse_u64(next()));
        else if (option == "--mode") {
            const std::string value = next();
            if (value == "token") mode = ServeMode::token;
            else if (value == "layer") mode = ServeMode::layer;
            else throw std::runtime_error("--mode must be token or layer");
        } else throw std::runtime_error("unknown option: " + option);
    }
    if (internal_path.empty() || external_path.empty() || trace_directory.empty()) {
        throw std::runtime_error("--internal-file, --external-file and --trace-directory are required");
    }

    // 32 MiB de tampon d'anneau par worker : inutilise ici puisque chaque
    // requete porte sa destination, mais le lecteur le demande a la construction.
    DualVolumeReader reader(internal_path, external_path, queue_depth,
                            32ULL << 20, 2ULL << 30, true);
    P0Layout layout(frozen_layer_record_bytes(), P0Profile::v2_7157_2843);
    ExpertStore store(capacity_bytes, protected_fraction, reader, layout, split);

    std::printf("cache %" PRIu64 " octets -> jusqu'a %u experts par couche, arene %" PRIu64 " octets\n",
                capacity_bytes, store.max_slots_per_layer(), store.slot_bytes());
    std::printf("regime %s, QD %u, split %u, F_NOCACHE int/ext %d/%d\n",
                mode == ServeMode::token ? "token (borne haute)" : "layer (reel)",
                queue_depth, split,
                reader.f_nocache_applied(Volume::internal) ? 1 : 0,
                reader.f_nocache_applied(Volume::external) ? 1 : 0);

    std::vector<std::uint64_t> token_ns;
    std::uint64_t hits = 0, misses = 0, bytes = 0, tokens = 0;
    std::uint64_t processed = 0;

    for (const auto & base : sorted_bases(trace_directory)) {
        if (documents != 0 && processed >= documents) break;
        ++processed;
        const auto keys = read_all<std::uint32_t>(trace_directory + "/" + base + ".keys.u32");
        const auto phases = read_all<std::uint8_t>(trace_directory + "/" + base + ".phase.u8");
        std::vector<std::uint32_t> token(accesses_per_token);
        std::uint64_t document_ns = 0, document_tokens = 0, document_hits = 0, document_misses = 0;

        for (std::size_t offset = 0; offset + accesses_per_token <= keys.size();
             offset += accesses_per_token) {
            std::copy(keys.begin() + static_cast<std::ptrdiff_t>(offset),
                      keys.begin() + static_cast<std::ptrdiff_t>(offset + accesses_per_token),
                      token.begin());
            if (phases[offset] != generation_phase) {
                store.warm(token);       // chauffage : politique seule, aucune E/S
                continue;
            }
            const auto result = store.serve_token(token, mode);
            token_ns.push_back(result.wall_ns);
            document_ns += result.wall_ns;
            hits += result.hits; misses += result.misses; bytes += result.bytes_read;
            document_hits += result.hits; document_misses += result.misses;
            ++document_tokens; ++tokens;
        }
        const double ms = static_cast<double>(document_ns) / 1e6 / static_cast<double>(document_tokens);
        std::printf("  %-56s %5" PRIu64 " tokens  %7.2f ms/token  E/S seule %6.2f tok/s  succes %.4f\n",
                    base.c_str(), document_tokens, ms, 1000.0 / ms,
                    static_cast<double>(document_hits) /
                        static_cast<double>(document_hits + document_misses));
    }

    const double mean_ms = static_cast<double>(
        std::accumulate(token_ns.begin(), token_ns.end(), std::uint64_t{0})) / 1e6 /
        static_cast<double>(tokens);
    std::printf("\nTOKENS %" PRIu64 "  succes %.6f  octets lus %" PRIu64 "\n",
                tokens, static_cast<double>(hits) / static_cast<double>(hits + misses), bytes);
    std::printf("SERVICE E/S par token  moyenne %.2f ms  p50 %.2f  p95 %.2f  p99 %.2f  max %.2f\n",
                mean_ms, percentile(token_ns, 0.50) / 1e6, percentile(token_ns, 0.95) / 1e6,
                percentile(token_ns, 0.99) / 1e6, percentile(token_ns, 1.0) / 1e6);
    std::printf("DEBIT E/S seule %.3f tok/s   (%.3f Go/s effectifs)\n",
                1000.0 / mean_ms,
                static_cast<double>(bytes) / (mean_ms * static_cast<double>(tokens) / 1000.0) / 1e9);

    // Le calcul mesure au tour 113 : 0,8149 ms par couche dont 0,5126 avant le
    // routeur. En regime layer, l'E/S d'une couche ne peut se recouvrir qu'avec
    // le shared FFN et les experts residents de cette meme couche.
    constexpr double compute_ms_per_token = 61.3358125;
    std::printf("AVEC LE CALCUL  serialise %.3f tok/s   recouvrement parfait %.3f tok/s\n",
                1000.0 / (mean_ms + compute_ms_per_token),
                1000.0 / std::max(mean_ms, compute_ms_per_token));
    return 0;
} catch (const std::exception & error) {
    std::fprintf(stderr, "erreur: %s\n", error.what());
    return 2;
}

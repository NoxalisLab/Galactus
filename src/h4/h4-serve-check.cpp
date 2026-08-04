// Verificateur de CONTENU du chemin de service : le vrai magasin, le vrai
// lecteur, les vrais packs — puis comparaison octet a octet contre le GGUF,
// cote hote, sans Metal.
//
// Si un emplacement differe de sa source GGUF : le defaut est dans
// lecteur->arene (recouture, offsets, pread). Si tout concorde : le defaut
// est en aval, dans la consommation Metal des tenseurs a pas d'arene.
//
// Entree : un fichier de controle texte, une ligne par portion attendue :
//   <layer> <expert> <role> <chemin_shard> <offset_source> <longueur> <offset_dans_enregistrement>
// (genere par le lanceur depuis le plan tour81, qui est lui-meme deja
//  verifie conforme aux packs et au GGUF)

#include "h4-expert-cache.hpp"
#include "h4-expert-store.hpp"
#include "h4-reader.hpp"

#include <cstdio>
#include <cstring>
#include <fstream>
#include <map>
#include <memory>
#include <string>
#include <vector>

using namespace galactus::h4;

int main(int argc, char ** argv) try {
    if (argc != 5) {
        std::fprintf(stderr,
            "usage: %s <pack_interne> <pack_externe> <capacite_octets> <fichier_controle>\n",
            argv[0]);
        return 2;
    }
    const std::string internal_path = argv[1];
    const std::string external_path = argv[2];
    const std::uint64_t capacity = std::strtoull(argv[3], nullptr, 10);
    std::ifstream control(argv[4]);
    if (!control) throw std::runtime_error("fichier de controle illisible");

    DualVolumeReader reader(internal_path, external_path, 32, 32ULL << 20, 2ULL << 30, true);
    P0Layout layout(frozen_layer_record_bytes(), P0Profile::v2_7157_2843);
    ExpertStore store(capacity, 0.75, reader, layout);
    std::printf("magasin : %u experts par couche\n", store.slots_per_layer());

    struct Span { std::string role, shard; std::uint64_t source_offset, length, record_offset; };
    std::map<std::uint32_t, std::vector<Span>> spans_by_key;
    { // lecture du fichier de controle
        std::uint32_t layer, expert;
        Span s;
        while (control >> layer >> expert >> s.role >> s.shard >> s.source_offset >> s.length >> s.record_offset) {
            spans_by_key[(layer << 8) | expert].push_back(s);
        }
    }
    std::printf("controle : %zu cles\n", spans_by_key.size());

    // Service par couche, comme le rappel du graphe : les cles d'une meme
    // couche ensemble.
    std::map<std::uint32_t, std::vector<std::uint32_t>> keys_by_layer;
    for (const auto & [key, _] : spans_by_key) keys_by_layer[key >> 8].push_back(key);

    // Barattage optionnel : forcer evictions et reemplois d'emplacements
    // AVANT le service des cles de controle. C'est le chemin que le premier
    // passage (24 cles fraiches, zero eviction) n'exercait pas.
    const int churn_rounds = std::getenv("GALACTUS_CHECK_CHURN") != nullptr
        ? std::atoi(std::getenv("GALACTUS_CHECK_CHURN")) : 0;
    if (churn_rounds > 0) {
        std::printf("barattage : %d tours de 256 experts par couche de controle\n", churn_rounds);
        for (const auto & [layer, _] : keys_by_layer) {
            for (int round = 0; round < churn_rounds; ++round) {
                // parcours pseudo-melange deterministe (pas de PRNG : 149 est
                // premier avec 256, l'ordre varie avec le tour)
                for (std::uint32_t chunk = 0; chunk < 256; chunk += 8) {
                    std::uint32_t batch[8];
                    for (std::uint32_t i = 0; i < 8; ++i) {
                        const std::uint32_t expert = (149U * (chunk + i) + 31U * round) & 0xFFU;
                        batch[i] = (layer << 8) | expert;
                    }
                    store.serve_layer(batch, 8);
                }
            }
        }
    }
    for (const auto & [layer, keys] : keys_by_layer) {
        store.serve_layer(keys.data(), static_cast<std::uint32_t>(keys.size()));
    }

    std::map<std::string, std::unique_ptr<std::ifstream>> shards;
    std::vector<char> expected;
    int checked = 0, failed = 0;
    for (const auto & [key, spans] : spans_by_key) {
        const auto * slot = static_cast<const unsigned char *>(store.data(key));
        if (slot == nullptr) {
            std::printf("L%u E%u : PAS D'EMPLACEMENT\n", key >> 8, key & 0xFF);
            ++failed; continue;
        }
        for (const auto & s : spans) {
            auto & shard = shards[s.shard];
            if (!shard) {
                shard = std::make_unique<std::ifstream>(s.shard, std::ios::binary);
                if (!*shard) throw std::runtime_error("shard illisible: " + s.shard);
            }
            expected.resize(s.length);
            shard->seekg(static_cast<std::streamoff>(s.source_offset));
            shard->read(expected.data(), static_cast<std::streamsize>(s.length));
            if (static_cast<std::uint64_t>(shard->gcount()) != s.length) {
                throw std::runtime_error("lecture shard incomplete");
            }
            const int same = std::memcmp(slot + s.record_offset, expected.data(), s.length);
            ++checked;
            if (same != 0) {
                ++failed;
                // premier octet different, pour localiser
                std::uint64_t first = 0;
                while (first < s.length &&
                       slot[s.record_offset + first] == static_cast<unsigned char>(expected[first])) ++first;
                std::printf("L%u E%u %-4s : DIFFERENT des l'octet %llu / %llu\n",
                            key >> 8, key & 0xFF, s.role.c_str(),
                            (unsigned long long) first, (unsigned long long) s.length);
            } else {
                std::printf("L%u E%u %-4s : OK (%llu octets)\n",
                            key >> 8, key & 0xFF, s.role.c_str(), (unsigned long long) s.length);
            }
        }
    }
    std::printf("\n%d portions verifiees, %d en echec\n", checked, failed);
    return failed == 0 ? 0 : 1;
} catch (const std::exception & error) {
    std::fprintf(stderr, "erreur: %s\n", error.what());
    return 2;
}

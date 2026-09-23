#pragma once

// Profil de modele : la geometrie MoE que le moteur servait autrefois depuis
// des constantes gelees GLM-5.2. Charge depuis le sidecar texte emis par
// scripts/moe-profile.py (GALACTUS_PROFILE=<chemin>), ou repli sur le profil
// GLM-5.2 integre : sans variable d'environnement, chaque binaire existant
// se comporte exactement comme avant.
//
// Fail-closed : tout champ manquant, toute incoherence (couches non
// croissantes ou hors [first_layer, last_layer], experts au-dela de la
// capacite d'encodage des clefs galactus::h4::key_expert_capacity, record non
// aligne) leve au chargement.
//
// Couches MoE creuses : les architectures hybrides (nemotron_h_moe : Mamba,
// attention et MoE entremeles) n'ont des experts que sur une partie des
// couches de [first_layer, last_layer]. Le sidecar ne liste alors que ces
// couches ; toute table par couche du moteur (records, quotas, emplacements,
// disposition du pack) est indexee par le RANG de la couche dans `layers`
// (index_of), jamais par `layer - first_layer`. Un profil contigu donne
// index_of(layer) == layer - first_layer : les profils existants se chargent
// et se comportent a l'identique.

#include <cstdint>
#include <string>
#include <vector>

namespace galactus::h4 {

struct ModelProfile {
    std::string architecture;
    std::uint32_t first_layer = 0;
    std::uint32_t last_layer = 0;
    std::uint32_t experts = 0;        // experts par couche (<= key_expert_capacity)
    std::uint32_t used = 0;           // experts actifs par token et par couche
    std::vector<std::uint64_t> record_bytes;      // par indice de couche, PAD 16 KiB
    std::vector<std::uint64_t> record_bytes_raw;  // octets utiles (== pad pour GLM)
    // Numeros des couches MoE, strictement croissants, un par record : rang i
    // <-> layers[i]. Rempli par load() / le profil integre.
    std::vector<std::uint32_t> layers;
    // Table creuse (layer - first_layer) -> rang, -1 pour une couche sans
    // experts (SSM, attention). Derivee de `layers` par index_layers().
    std::vector<std::int32_t> rank_of_layer;

    // Nombre de couches MOE (== nombre de records par expert), pas l'etendue
    // de la plage [first_layer, last_layer].
    [[nodiscard]] std::uint32_t layer_count() const noexcept {
        return static_cast<std::uint32_t>(layers.size());
    }
    [[nodiscard]] bool has_layer(std::uint32_t layer) const noexcept {
        return layer >= first_layer && layer <= last_layer
            && rank_of_layer[layer - first_layer] >= 0;
    }
    // Rang de la couche dans les tables du moteur. Precondition : has_layer.
    [[nodiscard]] std::uint32_t index_of(std::uint32_t layer) const noexcept {
        return static_cast<std::uint32_t>(rank_of_layer[layer - first_layer]);
    }
    [[nodiscard]] std::uint32_t layer_at(std::uint32_t index) const noexcept {
        return layers[index];
    }
    [[nodiscard]] bool contiguous() const noexcept {
        return layer_count() == last_layer - first_layer + 1;
    }
    // Construit rank_of_layer depuis `layers` (appele par load et le profil
    // integre avant validation).
    void index_layers();
    [[nodiscard]] std::uint64_t max_record_bytes() const noexcept;

    // Charge et valide un sidecar .engine.txt.
    static ModelProfile load(const std::string & path);

    // Le profil actif du processus : GALACTUS_PROFILE si defini, sinon le
    // profil GLM-5.2 integre. Charge une fois, immuable ensuite.
    static const ModelProfile & active();
};

}  // namespace galactus::h4

#pragma once

// Profil de modele : la geometrie MoE que le moteur servait autrefois depuis
// des constantes gelees GLM-5.2. Charge depuis le sidecar texte emis par
// scripts/moe-profile.py (GALACTUS_PROFILE=<chemin>), ou repli sur le profil
// GLM-5.2 integre : sans variable d'environnement, chaque binaire existant
// se comporte exactement comme avant.
//
// Fail-closed : tout champ manquant, toute incoherence (couches non
// contigues, experts au-dela de la capacite d'encodage des clefs
// galactus::h4::key_expert_capacity, record non aligne) leve au chargement.

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

    [[nodiscard]] std::uint32_t layer_count() const noexcept {
        return last_layer - first_layer + 1;
    }
    [[nodiscard]] std::uint64_t max_record_bytes() const noexcept;

    // Charge et valide un sidecar .engine.txt.
    static ModelProfile load(const std::string & path);

    // Le profil actif du processus : GALACTUS_PROFILE si defini, sinon le
    // profil GLM-5.2 integre. Charge une fois, immuable ensuite.
    static const ModelProfile & active();
};

}  // namespace galactus::h4

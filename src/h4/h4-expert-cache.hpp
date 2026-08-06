#pragma once

// Cache d'experts resident — politique slru_par_couche.
//
// Un SLRU independant par couche MoE, quota egal en NOMBRE d'experts, deux
// segments (probation puis protege), promotion au deuxieme acces. Choisie
// apres mesure : W-TinyLFU donne 9,61 tok/s contre 15,13 pour un LRU nu sur
// ces memes traces, et la LFU a fenetre est pire que LRU a toutes les periodes
// testees. Dans ce workload la recence domine la frequence — la distance de
// reutilisation vaut un token pour tout expert reselectionne, la question
// n'est pas a quelle frequence mais s'il revient.
//
// Sans allocation en regime permanent : les deux listes d'une couche sont
// chainees dans un tableau fixe de key_expert_capacity noeuds, dimensionne sur
// la CAPACITE d'encodage des clefs et non sur le nombre d'experts du modele.
// Tout est O(1), et une clef hors domaine reste dans les bornes du tableau.
//
// La taille d'un expert vient de galactus::h4::frozen_layer_record_bytes(),
// c'est-a-dire de la table du profil actif, pas d'une table recopiee.

#include "h4-core.hpp"

#include <array>
#include <cstdint>
#include <vector>

namespace galactus::h4 {

class ExpertCache {
public:
    // Plage de couches du profil actif (h4-profile.hpp). Le nombre reel
    // d'experts par couche est ModelProfile::active().experts ; il ne faut pas
    // le confondre avec galactus::h4::key_expert_capacity, qui n'est qu'une
    // borne de structure, ni avec quota_per_layer(), qui est le nombre
    // d'experts RESIDENTS autorises par couche.
    [[nodiscard]] static std::uint32_t first_layer() noexcept;
    [[nodiscard]] static std::uint32_t last_layer() noexcept;
    [[nodiscard]] static std::uint32_t layer_count() noexcept;

    // capacity_bytes est le budget TOTAL du cache. Le quota par couche est
    // egal en nombre d'experts : n = capacity / somme des tailles d'un expert
    // de chaque couche. L'analyse marginale le justifie — les 75 couches
    // recoivent exactement 8 acces par token chacune, donc le gain d'un expert
    // supplementaire ne depend pas de sa taille.
    ExpertCache(std::uint64_t capacity_bytes, double protected_fraction);

    struct Access {
        bool hit = false;
        bool evicted = false;           // une cle est sortie du cache
        std::uint32_t evicted_key = 0;  // valide seulement si evicted
    };

    // Met a jour l'etat du cache et rapporte l'eviction eventuelle, pour que
    // l'appelant puisse reutiliser l'emplacement memoire libere.
    Access access(std::uint32_t key) noexcept;

    // Renvoie true si l'expert etait deja resident, et met a jour l'etat du
    // cache. Une cle est (couche << key_expert_bits) | expert.
    bool touch(std::uint32_t key) noexcept { return access(key).hit; }

    [[nodiscard]] bool resident(std::uint32_t key) const noexcept;

    // Nombre d'experts RESIDENTS autorises par couche, deduit du budget.
    [[nodiscard]] std::uint32_t quota_per_layer() const noexcept { return quota_; }
    [[nodiscard]] std::uint32_t protected_quota() const noexcept { return protected_quota_; }
    [[nodiscard]] std::uint32_t probation_quota() const noexcept { return probation_quota_; }
    [[nodiscard]] std::uint64_t capacity_bytes() const noexcept { return capacity_bytes_; }
    [[nodiscard]] std::uint64_t resident_bytes() const noexcept;
    [[nodiscard]] std::uint64_t expert_bytes(std::uint32_t layer) const noexcept;

    // Compteurs cumules depuis la construction.
    [[nodiscard]] std::uint64_t hits() const noexcept { return hits_; }
    [[nodiscard]] std::uint64_t accesses() const noexcept { return accesses_; }
    [[nodiscard]] std::uint64_t cold_bytes() const noexcept { return cold_bytes_; }
    void reset_counters() noexcept { hits_ = accesses_ = cold_bytes_ = 0; }

private:
    enum class Segment : std::uint8_t { absent = 0, probation = 1, protected_ = 2 };

    struct Node {
        std::int16_t previous = -1;
        std::int16_t next = -1;
        Segment segment = Segment::absent;
    };

    struct Layer {
        std::array<Node, key_expert_capacity> nodes{};
        std::int16_t probation_head = -1, probation_tail = -1;
        std::int16_t protected_head = -1, protected_tail = -1;
        std::uint32_t probation_size = 0, protected_size = 0;
    };

    void unlink(Layer & layer, std::int16_t index, Segment from) noexcept;
    void push_back(Layer & layer, std::int16_t index, Segment into) noexcept;
    std::int16_t pop_front(Layer & layer, Segment from) noexcept;

    std::uint64_t capacity_bytes_;
    std::uint32_t quota_ = 0;
    std::uint32_t protected_quota_ = 0;
    std::uint32_t probation_quota_ = 0;
    std::vector<Layer> layers_;
    std::uint64_t hits_ = 0, accesses_ = 0, cold_bytes_ = 0;
};

}  // namespace galactus::h4

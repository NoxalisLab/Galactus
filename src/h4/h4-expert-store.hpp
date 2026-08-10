#pragma once

// Magasin d'experts resident : relie la politique de cache au lecteur.
//
// Le cache decide QUI reste ; le magasin possede la memoire et sait OU. Un
// emplacement par expert resident, tailles prises de frozen_layer_record_bytes(),
// tout aligne sur 16 KiB pour que le pread F_NOCACHE ecrive directement dedans.
//
// Deux regimes de service, et leur ecart EST la question du recouvrement :
//   token  toutes les lectures manquantes des 75 couches sont emises d'un coup
//          puis attendues. Borne haute : suppose qu'on connait les routes du
//          token entier a l'avance.
//   layer  les lectures d'une couche sont emises puis attendues avant de
//          passer a la suivante. Regime reel sans avance de routes, puisque le
//          routeur de la couche n lit l'etat cache apres l'attention de n.

#include "h4-expert-cache.hpp"
#include "h4-reader.hpp"

#include <cstdint>
#include <vector>

namespace galactus::h4 {

enum class ServeMode { token, layer };

class ExpertStore {
public:
    // split : nombre de requetes par part d'enregistrement et par volume.
    // 1 reproduit le comportement d'origine. Au-dela, les memes octets sont
    // lus aux memes offsets, simplement en plusieurs requetes concurrentes.
    ExpertStore(std::uint64_t capacity_bytes,
                double protected_fraction,
                DualVolumeReader & reader,
                const P0Layout & layout,
                std::uint32_t split = 1);
    ~ExpertStore();

    ExpertStore(const ExpertStore &) = delete;
    ExpertStore & operator=(const ExpertStore &) = delete;

    struct TokenResult {
        std::uint32_t hits = 0;
        std::uint32_t misses = 0;
        std::uint64_t bytes_read = 0;
        std::uint64_t wall_ns = 0;
    };

    // keys : 8 experts par couche, couches croissantes, 600 cles pour un token.
    TokenResult serve_token(const std::vector<std::uint32_t> & keys, ServeMode mode);

    // Rejoue des cles a travers la POLITIQUE seule, sans aucune lecture. Sert
    // a chauffer le cache avec la phase de prompt : le motif de succes de la
    // phase generation devient exact, et seule celle-ci fait de vraies E/S.
    // Les octets des emplacements ainsi chauffes ne sont pas valides -- ce banc
    // mesure du TEMPS, pas du contenu.
    void warm(const std::vector<std::uint32_t> & keys);

    // Pointeur vers les octets d'un expert resident, nullptr sinon.
    [[nodiscard]] const void * data(std::uint32_t key) const noexcept;

    // Sert les cles d'UNE couche : acces cache, lectures des manquants dans
    // leurs emplacements, attente. C'est le regime layer, appele couche par
    // couche. Renvoie les octets lus.
    std::uint64_t serve_layer(const std::uint32_t * keys, std::uint32_t count);

    // Numero d'emplacement d'une cle residente, -1 sinon.
    [[nodiscard]] std::int16_t slot_of(std::uint32_t key) const noexcept;

    // Adresses pour adosser des vues de tenseurs a l'arene.
    [[nodiscard]] const unsigned char * arena_base() const noexcept { return arena_; }
    [[nodiscard]] std::uint64_t layer_base(std::uint32_t layer_index) const noexcept {
        return layer_base_[layer_index];
    }

    [[nodiscard]] const ExpertCache & cache() const noexcept { return cache_; }
    [[nodiscard]] std::uint64_t slot_bytes() const noexcept { return slot_bytes_; }
    [[nodiscard]] bool pinned() const noexcept { return pin_; }
    // Emplacements reellement alloues pour UNE couche : tous les experts du
    // modele en mode epingle, sinon le quota que le cache accorde a cette
    // couche. Il n'y a plus de nombre unique : un plan de cache donne plus de
    // places aux couches ou une place enleve le plus de lectures.
    [[nodiscard]] std::uint32_t slots_of(std::uint32_t layer) const noexcept;
    [[nodiscard]] std::uint32_t max_slots_per_layer() const noexcept;
    // Le plus gros bloc contigu d'une seule couche, pour le decoupage des
    // tampons du backend.
    [[nodiscard]] std::uint64_t max_slab_bytes() const noexcept;

private:
    std::uint32_t allocate_slot(std::uint32_t key);  // lance si la liste libre est a sec
    void release_slot(std::uint32_t key) noexcept;
    void issue(std::uint32_t key, std::vector<std::future<ReadResult>> & pending);

    ExpertCache cache_;
    DualVolumeReader & reader_;
    const P0Layout & layout_;

    unsigned char * arena_ = nullptr;
    std::uint64_t slot_bytes_ = 0;
    std::vector<std::uint64_t> layer_base_;          // offset du premier emplacement
    std::vector<std::uint32_t> slots_of_layer_;      // places allouees, par couche
    std::vector<std::int16_t> slot_of_;              // couches * capacite, -1 si absent
    std::vector<std::vector<std::int16_t>> free_slots_;
    std::uint64_t next_request_id_ = 0;
    std::uint32_t split_ = 1;

    // Sonde zero-eviction (GALACTUS_H4_PIN=1) : chaque couche cablee recoit
    // tous les experts du profil actif a demeure, les autres 0. Jamais
    // d'eviction ni de liberation ; le SLRU n'est pas consulte. Diagnostic
    // seulement.
    bool pin_ = false;
    std::uint32_t pin_low_ = 0, pin_high_ = 0;

    void issue_part(Volume volume, std::uint64_t offset, std::uint64_t length,
                    unsigned char * destination,
                    std::vector<std::future<ReadResult>> & pending);
};

}  // namespace galactus::h4

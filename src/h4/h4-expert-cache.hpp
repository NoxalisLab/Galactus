#pragma once

// Cache d'experts resident — politique slru_par_couche.
//
// Un SLRU independant par couche MoE, deux segments (probation puis protege),
// promotion au deuxieme acces.
//
// LA VICTIME DE LA PROBATION EST LA MOINS FREQUENTE, PLUS LA MOINS RECENTE.
//
// L'ADMISSION par frequence, elle, reste impossible ici, et pas par choix :
// un expert manquant doit entrer dans un emplacement pour que la couche
// calcule, il n'existe pas de contournement dans une arene. "Refuser
// l'admission" signifie donc "le mettre dans un anneau de rejet", et cet
// anneau doit tenir tous les experts d'un lot, soit `used` places. A quota 9
// pour 8 experts actifs, cela demande la quasi-totalite du cache. Rejeu sur
// traces reelles : W-TinyLFU avec anneau de `used` fait +4 a +28 % de
// lectures partout. C'est structurel, ce n'est pas un reglage a trouver.
//
// L'EVICTION par frequence, elle, ne coute aucun emplacement, et elle gagne
// exactement la ou la RAM manque. Rejeu 2026-08-10, lectures par token contre
// le LRU a budget d'arene identique :
//
//   quota le plus petit qui tourne   qwen3 -3,8 %   phi35 -2,4 %   olmoe -7,7 %
//   quota livre aujourd'hui          qwen3 -4,3 %   phi35 -3,7 %   olmoe -23,9 %
//   residence pleine                 egalite exacte partout
//
// La mesure historique qui disait le contraire (LFU pire que LRU a toutes les
// periodes) portait sur une LFU qui pouvait evincer une cle entree dans le
// MEME micro-lot, ce qui est a la fois faux et catastrophique ; voir
// begin_batch() plus bas. Tout est dans scripts/replay-cache.py --sweep.
//
// LE QUOTA N'EST PLUS EGAL ENTRE LES COUCHES. Il l'etait, et les couches ne
// le sont pas : sur qwen3-30b la couche 0 sert 45,7 % de ses acces depuis la
// RAM quand les couches profondes en servent 85 a 92. Un plan de cache
// (h4-cache-plan.hpp) porte la courbe misses/quota de chaque couche, mesuree
// une fois sur une trace de routage, et l'allocateur depense ici le MEME
// budget d'arene la ou une place enleve le plus de lectures.
//
// GALACTUS_H4_CACHE_POLICY choisit, et une seule valeur suffit a bissecter :
//   (absente) ou auto   plan + victime par frequence (le defaut)
//   uniform             la politique livree avant ce travail, a l'identique
//   plan                plan seul, victime LRU
//   frequency           quota egal, victime par frequence
//
// CE QUE LA VICTIME PAR FREQUENCE COUTE EN MEMOIRE : quatre octets de plus
// par noeud, dans le tableau que le SLRU alloue deja. 196 Ko pour qwen3-30b,
// contre une arene de 2,2 a 30 Go selon le budget. Ce n'est pas de l'arene :
// aucun emplacement d'expert n'est perdu, l'arene ne bouge pas d'un octet.
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
    // Acces d'une couche entre deux halvings des compteurs de frequence.
    // Mesure sur les traces reelles : la valeur ne fait rien bouger entre 1024
    // et 16384, ce qui est le signe qu'elle regle l'oubli et non le
    // classement. 4096 acces valent environ 512 tokens a 8 experts actifs.
    static constexpr std::uint32_t decay_period = 4096;

    // Plage de couches du profil actif (h4-profile.hpp). Le nombre reel
    // d'experts par couche est ModelProfile::active().experts ; il ne faut pas
    // le confondre avec galactus::h4::key_expert_capacity, qui n'est qu'une
    // borne de structure, ni avec quota_per_layer(), qui est le nombre
    // d'experts RESIDENTS autorises par couche.
    [[nodiscard]] static std::uint32_t first_layer() noexcept;
    [[nodiscard]] static std::uint32_t last_layer() noexcept;
    [[nodiscard]] static std::uint32_t layer_count() noexcept;

    // capacity_bytes est le budget TOTAL du cache. Le quota UNIFORME en est
    // deduit : n = capacity / somme des tailles d'un expert de chaque couche.
    // C'est lui qui fixe la taille de l'arene, et un plan de cache ne fait
    // ensuite que redistribuer ces memes octets entre les couches : le budget
    // rendu a l'allocateur vaut exactement n x somme des tailles, jamais un
    // octet de plus.
    ExpertCache(std::uint64_t capacity_bytes, double protected_fraction);

    // Ouvre un micro-lot sur une couche. A appeler AVANT le premier access()
    // du lot.
    //
    // L'INVARIANT QUE CELA PROTEGE. Tous les experts d'un micro-lot doivent
    // etre residents au MEME instant : un seul mul_mat_id les consomme. Rien
    // de ce que ce lot fait entrer ne peut donc etre evince par ce lot. Le LRU
    // l'obtient gratuitement, une cle qui vient d'entrer est en queue de
    // probation et la victime est prise en tete. La victime par frequence ne
    // l'obtient pas : un expert froid admis a l'instant a le plus petit
    // compteur de la couche, c'est exactement ce qu'un balayage naif
    // choisirait. Marquer le lot de dernier acces de chaque cle est ce qui
    // permet au balayage de les sauter. Sans cela, la politique lirait les
    // mauvais octets, ce qui n'est pas une question de performance.
    void begin_batch(std::uint32_t layer) noexcept;

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

    // Le quota UNIFORME deduit du budget : la reference, celle qui dimensionne
    // l'arene. Ce n'est PAS forcement le quota d'une couche donnee.
    [[nodiscard]] std::uint32_t quota_per_layer() const noexcept { return quota_; }
    // Le quota reel d'une couche, et ses deux segments.
    [[nodiscard]] std::uint32_t quota_of(std::uint32_t layer) const noexcept;
    [[nodiscard]] std::uint32_t protected_quota_of(std::uint32_t layer) const noexcept;
    [[nodiscard]] std::uint32_t probation_quota_of(std::uint32_t layer) const noexcept;
    // Le plus petit segment probation de toutes les couches. C'est la borne
    // que le moteur oppose a un micro-lot ; l'allocateur ne la fait jamais
    // descendre sous celle du quota uniforme, donc une forme de lot qui
    // passait hier passe encore.
    [[nodiscard]] std::uint32_t min_probation_quota() const noexcept;
    // true quand un plan de cache a redistribue les places.
    [[nodiscard]] bool planned() const noexcept { return planned_; }
    // true quand la victime de la probation est choisie par frequence.
    [[nodiscard]] bool frequency_victim() const noexcept { return frequency_victim_; }
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
        // Compteur d'acces amorti, et numero du dernier micro-lot ou la cle a
        // ete touchee. Le numero de lot boucle sur 16 bits, et cela est sur
        // dans le seul sens qui compte : une egalite fortuite fait SAUTER un
        // candidat a l'eviction, elle n'en designe jamais un du lot courant.
        std::uint16_t frequency = 0;
        std::uint16_t epoch = 0;
    };

    struct Layer {
        std::array<Node, key_expert_capacity> nodes{};
        std::int16_t probation_head = -1, probation_tail = -1;
        std::int16_t protected_head = -1, protected_tail = -1;
        std::uint32_t probation_size = 0, protected_size = 0;
        std::uint32_t quota = 0;
        std::uint32_t protected_quota = 0;
        std::uint32_t probation_quota = 0;
        std::uint16_t epoch = 1;
        std::uint32_t since_decay = 0;
    };

    // Redistribue les places entre couches a partir du plan actif, dans le
    // budget que le quota uniforme achetait. Sans plan, ne fait rien.
    void apply_plan(double protected_fraction, std::uint64_t one_of_each,
                    std::uint32_t model_experts);

    void unlink(Layer & layer, std::int16_t index, Segment from) noexcept;
    void push_back(Layer & layer, std::int16_t index, Segment into) noexcept;
    std::int16_t pop_front(Layer & layer, Segment from) noexcept;
    // La victime de la probation : la tete en LRU, la moins frequente hors du
    // lot courant en mode frequence.
    std::int16_t take_victim(Layer & layer) noexcept;
    void note_access(Layer & layer, std::int16_t index) noexcept;

    std::uint64_t capacity_bytes_;
    std::uint32_t quota_ = 0;
    std::uint32_t protected_quota_ = 0;
    std::uint32_t probation_quota_ = 0;
    bool planned_ = false;
    bool frequency_victim_ = false;
    std::vector<Layer> layers_;
    std::uint64_t hits_ = 0, accesses_ = 0, cold_bytes_ = 0;
};

}  // namespace galactus::h4

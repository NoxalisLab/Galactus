#include "h4-expert-store.hpp"

#include "h4-profile.hpp"

#include <algorithm>

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <new>
#include <stdexcept>

namespace galactus::h4 {

namespace {

std::uint64_t monotonic_ns() {
    return static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now().time_since_epoch()).count());
}

std::uint32_t layer_index(std::uint32_t key) {
    return (key >> key_expert_bits) - ExpertCache::first_layer();
}

}  // namespace

ExpertStore::ExpertStore(std::uint64_t capacity_bytes,
                         double protected_fraction,
                         DualVolumeReader & reader,
                         const P0Layout & layout,
                         std::uint32_t split)
    : cache_(capacity_bytes, protected_fraction), reader_(reader), layout_(layout),
      split_(split == 0 ? 1 : split) {
    // Mode epingle : une couche cablee recoit TOUS les experts du modele, pas
    // la capacite d'encodage des clefs.
    const std::uint32_t model_experts = ModelProfile::active().experts;
    { // sonde zero-eviction : l'environnement est lu une fois, ici
        const char * pin = std::getenv("GALACTUS_H4_PIN");
        pin_ = pin != nullptr && pin[0] == '1';
        pin_low_ = ExpertCache::first_layer();
        pin_high_ = ExpertCache::last_layer();
        const char * spec = std::getenv("GALACTUS_H4_ONLY_LAYERS");
        int low = 0, high = 0;
        if (spec != nullptr && std::sscanf(spec, "%d-%d", &low, &high) == 2) {
            pin_low_ = static_cast<std::uint32_t>(low);
            pin_high_ = static_cast<std::uint32_t>(high);
        }
        if (pin_ && (pin_high_ - pin_low_) > 20) {
            throw std::runtime_error(
                "expert store: mode epingle limite a 21 couches cablees "
                "(tous les experts partout = arene intenable)");
        }
    }
    layer_base_.resize(ExpertCache::layer_count());
    free_slots_.resize(ExpertCache::layer_count());
    slots_of_layer_.reserve(ExpertCache::layer_count());
    // Indexe par (clef & key_expert_mask) : dimensionne sur la CAPACITE
    // d'encodage pour qu'une clef hors domaine reste dans les bornes.
    slot_of_.assign(static_cast<std::size_t>(ExpertCache::layer_count()) * key_expert_capacity, -1);

    std::uint64_t offset = 0;
    for (std::uint32_t index = 0; index < ExpertCache::layer_count(); ++index) {
        layer_base_[index] = offset;
        const std::uint64_t record = frozen_layer_record_bytes()[index];
        if (record % record_alignment_bytes != 0) {
            throw std::runtime_error("expert store: record size is not 16 KiB aligned");
        }
        const std::uint32_t layer_number = index + ExpertCache::first_layer();
        // La couche recoit exactement les places que le cache lui accorde.
        // Sans plan de cache elles sont toutes egales, comme avant.
        const std::uint32_t layer_quota = !pin_ ? cache_.quota_of(layer_number)
            : (layer_number >= pin_low_ && layer_number <= pin_high_
               ? model_experts : 0U);
        slots_of_layer_.push_back(layer_quota);
        offset += record * layer_quota;
        free_slots_[index].reserve(layer_quota);
        for (std::int32_t slot = static_cast<std::int32_t>(layer_quota) - 1; slot >= 0; --slot) {
            free_slots_[index].push_back(static_cast<std::int16_t>(slot));
        }
    }
    slot_bytes_ = offset;

    void * memory = nullptr;
    if (posix_memalign(&memory, record_alignment_bytes, static_cast<std::size_t>(slot_bytes_)) != 0) {
        throw std::bad_alloc();
    }
    arena_ = static_cast<unsigned char *>(memory);
}

ExpertStore::~ExpertStore() {
    std::free(arena_);
}

std::uint32_t ExpertStore::slots_of(std::uint32_t layer) const noexcept {
    return slots_of_layer_[layer - ExpertCache::first_layer()];
}

std::uint32_t ExpertStore::max_slots_per_layer() const noexcept {
    std::uint32_t most = 0;
    for (const auto slots : slots_of_layer_) most = std::max(most, slots);
    return most;
}

std::uint64_t ExpertStore::max_slab_bytes() const noexcept {
    // La plaque d'une couche : ses places contigues, une par expert resident.
    // C'est CETTE taille qui doit etre le chevauchement des MTLBuffers quand
    // ggml decoupe l'arene, pas le produit du plus gros enregistrement par le
    // plus grand nombre de places, qui appartiendrait a aucune couche.
    std::uint64_t widest = 0;
    for (std::size_t index = 0; index < slots_of_layer_.size(); ++index) {
        widest = std::max(widest, frozen_layer_record_bytes()[index]
                                      * static_cast<std::uint64_t>(slots_of_layer_[index]));
    }
    return widest;
}

const void * ExpertStore::data(std::uint32_t key) const noexcept {
    const std::uint32_t index = layer_index(key);
    const std::int16_t slot = slot_of_[static_cast<std::size_t>(index) * key_expert_capacity + (key & key_expert_mask)];
    if (slot < 0) return nullptr;
    return arena_ + layer_base_[index] +
           static_cast<std::uint64_t>(slot) * frozen_layer_record_bytes()[index];
}

std::uint32_t ExpertStore::allocate_slot(std::uint32_t key) {
    const std::uint32_t index = layer_index(key);
    auto & free_list = free_slots_[index];
    if (free_list.empty()) {
        // Ne doit jamais arriver : le cache evince exactement une cle par
        // insertion. Une liste a sec signifie une fuite d'emplacements --
        // l'UB silencieux du 3 aout (PPL 8,89) ne se reproduira pas.
        throw std::runtime_error("expert store: free list a sec, fuite d'emplacements (couche "
                                 + std::to_string(index + ExpertCache::first_layer()) + ")");
    }
    const std::int16_t slot = free_list.back();
    free_list.pop_back();
    slot_of_[static_cast<std::size_t>(index) * key_expert_capacity + (key & key_expert_mask)] = slot;
    return static_cast<std::uint32_t>(slot);
}

void ExpertStore::release_slot(std::uint32_t key) noexcept {
    const std::uint32_t index = layer_index(key);
    auto & entry = slot_of_[static_cast<std::size_t>(index) * key_expert_capacity + (key & key_expert_mask)];
    if (entry >= 0) {
        free_slots_[index].push_back(entry);
        entry = -1;
    }
}

void ExpertStore::issue(std::uint32_t key, std::vector<std::future<ReadResult>> & pending) {
    const std::uint32_t index = layer_index(key);
    const std::uint32_t slot = allocate_slot(key);
    unsigned char * destination = arena_ + layer_base_[index] +
        static_cast<std::uint64_t>(slot) * frozen_layer_record_bytes()[index];

    // P0v2 coupe chaque enregistrement entre les deux volumes : la part interne
    // d'abord, la part externe ensuite, contigues dans l'emplacement.
    const auto & record = layout_.lookup(key);
    if (record.internal_length > 0) {
        issue_part(Volume::internal, record.internal_offset, record.internal_length,
                   destination, pending);
    }
    if (record.external_length > 0) {
        issue_part(Volume::external, record.external_offset, record.external_length,
                   destination + record.internal_length, pending);
    }
}

void ExpertStore::issue_part(Volume volume, std::uint64_t offset, std::uint64_t length,
                             unsigned char * destination,
                             std::vector<std::future<ReadResult>> & pending) {
    // Les longueurs et les offsets du pack sont deja des multiples de 16 KiB ;
    // on coupe en blocs entiers pour que chaque morceau le reste, sinon
    // F_NOCACHE refuse.
    const std::uint64_t blocks = length / record_alignment_bytes;
    std::uint32_t pieces = split_;
    if (pieces > blocks) pieces = static_cast<std::uint32_t>(blocks);
    if (pieces == 0) pieces = 1;
    const std::uint64_t blocks_each = blocks / pieces;

    std::uint64_t done = 0;
    for (std::uint32_t piece = 0; piece < pieces; ++piece) {
        const std::uint64_t take = (piece + 1 == pieces)
            ? (blocks - done)
            : blocks_each;
        const std::uint64_t chunk = take * record_alignment_bytes;
        pending.push_back(reader_.submit({next_request_id_++, volume,
                                          offset + done * record_alignment_bytes,
                                          chunk, false,
                                          destination + done * record_alignment_bytes}));
        done += take;
    }
}

void ExpertStore::warm(const std::vector<std::uint32_t> & keys) {
    std::uint32_t current_layer = keys.empty() ? 0 : (keys.front() >> key_expert_bits);
    if (!keys.empty()) cache_.begin_batch(current_layer);
    for (const auto key : keys) {
        if ((key >> key_expert_bits) != current_layer) {
            current_layer = key >> key_expert_bits;
            cache_.begin_batch(current_layer);
        }
        const auto access = cache_.access(key);
        if (access.evicted) release_slot(access.evicted_key);  // meme sur un succes
        if (access.hit) continue;
        allocate_slot(key);
    }
}

std::int16_t ExpertStore::slot_of(std::uint32_t key) const noexcept {
    const std::uint32_t index = layer_index(key);
    return slot_of_[static_cast<std::size_t>(index) * key_expert_capacity + (key & key_expert_mask)];
}

std::uint64_t ExpertStore::serve_layer(const std::uint32_t * keys, std::uint32_t count) {
    // Un appel = un micro-lot d'une couche. Le cache doit le savoir avant le
    // premier acces : sa victime ne peut pas etre une cle que ce lot fait
    // entrer, sans quoi la couche calculerait sur des octets absents.
    if (count > 0) cache_.begin_batch(keys[0] >> key_expert_bits);
    std::uint64_t bytes_read = 0;
    std::vector<std::future<ReadResult>> pending;
    pending.reserve(count * 2U);
    if (pin_) {
        // epingle : un expert lu une fois reste a demeure. allocate_slot pose
        // slot_of immediatement, donc un doublon dans le lot ne relit pas.
        for (std::uint32_t i = 0; i < count; ++i) {
            if (slot_of(keys[i]) >= 0) continue;
            issue(keys[i], pending);
        }
        for (auto & future : pending) {
            bytes_read += future.get().bytes_read;
        }
        return bytes_read;
    }
    std::vector<std::uint32_t> inflight;
    inflight.reserve(count);
    for (std::uint32_t i = 0; i < count; ++i) {
        const auto access = cache_.access(keys[i]);
        // L'eviction peut survenir sur un SUCCES aussi (promotion ->
        // debordement du protege -> retrogradation -> debordement de la
        // probation). Toujours liberer AVANT de decider quoi que ce soit.
        if (access.evicted) {
            // Course corrigee (tour Linux h4check2) : si la cle evincee a une
            // lecture emise dans CE service encore en vol, recycler son
            // emplacement ferait ecrire deux pread concurrents au meme
            // endroit. On draine d'abord, puis on libere. Les services de
            // generation (peu de manquants, evictions de cles anciennes) ne
            // drainent jamais ici ; seuls les lots de prompt le font.
            if (std::find(inflight.begin(), inflight.end(), access.evicted_key)
                    != inflight.end()) {
                for (auto & future : pending) {
                    bytes_read += future.get().bytes_read;
                }
                pending.clear();
                inflight.clear();
            }
            release_slot(access.evicted_key);
        }
        if (access.hit) continue;
        issue(keys[i], pending);
        inflight.push_back(keys[i]);
    }
    for (auto & future : pending) {
        bytes_read += future.get().bytes_read;
    }
    return bytes_read;
}

ExpertStore::TokenResult ExpertStore::serve_token(
        const std::vector<std::uint32_t> & keys, ServeMode mode) {
    TokenResult result;
    const std::uint64_t started = monotonic_ns();
    std::vector<std::future<ReadResult>> pending;
    pending.reserve(keys.size() * 2U);

    auto drain = [&]() {
        for (auto & future : pending) {
            result.bytes_read += future.get().bytes_read;
        }
        pending.clear();
    };

    std::uint32_t current_layer = keys.empty() ? 0 : (keys.front() >> key_expert_bits);
    if (!keys.empty()) cache_.begin_batch(current_layer);
    std::vector<std::uint32_t> inflight;
    inflight.reserve(keys.size());
    for (const auto key : keys) {
        if ((key >> key_expert_bits) != current_layer) {
            // Nouvelle couche, donc nouveau micro-lot du point de vue du
            // cache, quel que soit le regime de service.
            cache_.begin_batch(key >> key_expert_bits);
        }
        if (mode == ServeMode::layer && (key >> key_expert_bits) != current_layer) {
            // regime reel : on ne peut pas lire la couche suivante avant que
            // celle-ci soit servie, puisque son routeur n'a pas encore tourne
            drain();
            inflight.clear();
            current_layer = key >> key_expert_bits;
        }
        const auto access = cache_.access(key);
        if (access.evicted) {
            // meme sur un succes : voir serve_layer. Ne jamais recycler un
            // emplacement dont la lecture de ce lot est encore en vol.
            if (std::find(inflight.begin(), inflight.end(), access.evicted_key)
                    != inflight.end()) {
                drain();
                inflight.clear();
            }
            release_slot(access.evicted_key);
        }
        if (access.hit) {
            ++result.hits;
            continue;
        }
        ++result.misses;
        issue(key, pending);
        inflight.push_back(key);
    }
    drain();
    result.wall_ns = monotonic_ns() - started;
    return result;
}

}  // namespace galactus::h4

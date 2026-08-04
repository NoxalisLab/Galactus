#!/usr/bin/env python3
"""Sonde zero-eviction (tour 238) : mode epingle du magasin, GALACTUS_H4_PIN=1.

Constat qui la motive : trois plages d'UNE couche cablee donnent 2,6518 /
2,5993 / 2,7476 la ou un cablage bit-identique devrait donner EXACTEMENT la
reference stock 2,6373. Le differentiel a prouve les premiers ubatches
bit-identiques ; la divergence nait donc EN COURS de run. Ce qui n'existe pas
au debut et arrive ensuite : l'eviction (256 experts pour 80 emplacements).

Le mode epingle donne a chaque couche cablee ses 256 experts a demeure (aux
autres : 0), et serve_layer ne consulte plus le SLRU : un expert lu reste.
Zero eviction possible. Si la PPL claque alors exactement sur la reference,
le chemin d'eviction est le coupable demontre ; si elle reste deviee, il est
innocente et la divergence vient d'ailleurs.

Inactif sans GALACTUS_H4_PIN=1 : quotas, arene et service inchanges.
"""
import pathlib
import sys

root = pathlib.Path(sys.argv[1])  # racine du depot galactus

EDITS = {
"src/h4/h4-expert-store.hpp": [
    (
        """    [[nodiscard]] const ExpertCache & cache() const noexcept { return cache_; }
    [[nodiscard]] std::uint64_t slot_bytes() const noexcept { return slot_bytes_; }
    [[nodiscard]] std::uint32_t slots_per_layer() const noexcept { return cache_.experts_per_layer(); }
""",
        """    [[nodiscard]] const ExpertCache & cache() const noexcept { return cache_; }
    [[nodiscard]] std::uint64_t slot_bytes() const noexcept { return slot_bytes_; }
    [[nodiscard]] bool pinned() const noexcept { return pin_; }
    [[nodiscard]] std::uint32_t slots_per_layer() const noexcept {
        return pin_ ? ExpertCache::experts_per_layer_count : cache_.experts_per_layer();
    }
""",
    ),
    (
        """    std::uint64_t next_request_id_ = 0;
    std::uint32_t split_ = 1;
""",
        """    std::uint64_t next_request_id_ = 0;
    std::uint32_t split_ = 1;

    // Sonde zero-eviction (GALACTUS_H4_PIN=1) : chaque couche cablee recoit
    // ses 256 experts a demeure, les autres 0. Jamais d'eviction ni de
    // liberation ; le SLRU n'est pas consulte. Diagnostic seulement.
    bool pin_ = false;
    std::uint32_t pin_low_ = 0, pin_high_ = 0;
""",
    ),
],
"src/h4/h4-expert-store.cpp": [
    (
        """#include <chrono>
#include <cstdlib>
""",
        """#include <chrono>
#include <cstdio>
#include <cstdlib>
""",
    ),
    (
        """    const std::uint32_t quota = cache_.experts_per_layer();
    layer_base_.resize(ExpertCache::layer_count);
""",
        """    const std::uint32_t quota = cache_.experts_per_layer();
    { // sonde zero-eviction : l'environnement est lu une fois, ici
        const char * pin = std::getenv("GALACTUS_H4_PIN");
        pin_ = pin != nullptr && pin[0] == '1';
        pin_low_ = ExpertCache::first_layer;
        pin_high_ = ExpertCache::last_layer;
        const char * spec = std::getenv("GALACTUS_H4_ONLY_LAYERS");
        int low = 0, high = 0;
        if (spec != nullptr && std::sscanf(spec, "%d-%d", &low, &high) == 2) {
            pin_low_ = static_cast<std::uint32_t>(low);
            pin_high_ = static_cast<std::uint32_t>(high);
        }
        if (pin_ && (pin_high_ - pin_low_) > 20) {
            throw std::runtime_error(
                "expert store: mode epingle limite a 21 couches cablees "
                "(256 emplacements partout = arene intenable)");
        }
    }
    layer_base_.resize(ExpertCache::layer_count);
""",
    ),
    (
        """        offset += record * quota;
        free_slots_[index].reserve(quota);
        for (std::int32_t slot = static_cast<std::int32_t>(quota) - 1; slot >= 0; --slot) {
            free_slots_[index].push_back(static_cast<std::int16_t>(slot));
        }
""",
        """        const std::uint32_t layer_number = index + ExpertCache::first_layer;
        const std::uint32_t layer_quota = !pin_ ? quota
            : (layer_number >= pin_low_ && layer_number <= pin_high_
               ? ExpertCache::experts_per_layer_count : 0U);
        offset += record * layer_quota;
        free_slots_[index].reserve(layer_quota);
        for (std::int32_t slot = static_cast<std::int32_t>(layer_quota) - 1; slot >= 0; --slot) {
            free_slots_[index].push_back(static_cast<std::int16_t>(slot));
        }
""",
    ),
    (
        """    std::uint64_t bytes_read = 0;
    std::vector<std::future<ReadResult>> pending;
    pending.reserve(count * 2U);
    for (std::uint32_t i = 0; i < count; ++i) {
        const auto access = cache_.access(keys[i]);
""",
        """    std::uint64_t bytes_read = 0;
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
    for (std::uint32_t i = 0; i < count; ++i) {
        const auto access = cache_.access(keys[i]);
""",
    ),
],
}

total = 0
for relative, edits in EDITS.items():
    path = root / relative
    text = path.read_text(encoding="utf-8")
    for index, (old, new) in enumerate(edits, 1):
        count = text.count(old)
        if count != 1:
            raise SystemExit(f"{relative} edit {index}: anchor found {count} times, expected 1")
        text = text.replace(old, new, 1)
        total += 1
    path.write_text(text, encoding="utf-8")
    print(f"{relative}: {len(edits)} editions")
print(f"total: {total} editions, chacune exactement une fois")

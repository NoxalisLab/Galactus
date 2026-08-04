#include "h4-expert-cache.hpp"

#include "h4-core.hpp"

#include <stdexcept>

namespace galactus::h4 {

namespace {

std::uint64_t layer_expert_bytes(std::uint32_t layer) {
    if (layer < ExpertCache::first_layer || layer > ExpertCache::last_layer) {
        throw std::out_of_range("expert cache: layer outside the routed range 3..77");
    }
    return frozen_layer_record_bytes()[layer - ExpertCache::first_layer];
}

}  // namespace

ExpertCache::ExpertCache(std::uint64_t capacity_bytes, double protected_fraction)
    : capacity_bytes_(capacity_bytes), layers_(layer_count) {
    if (capacity_bytes == 0) {
        throw std::invalid_argument("expert cache: capacity must be positive");
    }
    if (protected_fraction <= 0.0 || protected_fraction >= 1.0) {
        throw std::invalid_argument("expert cache: protected fraction must be in (0,1)");
    }
    std::uint64_t one_of_each = 0;
    for (std::uint32_t layer = first_layer; layer <= last_layer; ++layer) {
        one_of_each += layer_expert_bytes(layer);
    }
    quota_ = static_cast<std::uint32_t>(capacity_bytes / one_of_each);
    if (quota_ == 0) {
        throw std::invalid_argument("expert cache: capacity below one expert per layer");
    }
    if (quota_ > experts_per_layer_count) {
        quota_ = experts_per_layer_count;
    }
    protected_quota_ = static_cast<std::uint32_t>(
        static_cast<double>(quota_) * protected_fraction);
    if (protected_quota_ < 1) protected_quota_ = 1;
    probation_quota_ = quota_ > protected_quota_ ? quota_ - protected_quota_ : 1;
}

std::uint64_t ExpertCache::expert_bytes(std::uint32_t layer) const noexcept {
    return frozen_layer_record_bytes()[layer - first_layer];
}

std::uint64_t ExpertCache::resident_bytes() const noexcept {
    std::uint64_t total = 0;
    for (std::uint32_t index = 0; index < layer_count; ++index) {
        const auto & layer = layers_[index];
        total += static_cast<std::uint64_t>(layer.probation_size + layer.protected_size) *
                 frozen_layer_record_bytes()[index];
    }
    return total;
}

void ExpertCache::unlink(Layer & layer, std::int16_t index, Segment from) noexcept {
    auto & node = layer.nodes[static_cast<std::size_t>(index)];
    std::int16_t & head = from == Segment::probation ? layer.probation_head : layer.protected_head;
    std::int16_t & tail = from == Segment::probation ? layer.probation_tail : layer.protected_tail;
    std::uint32_t & size = from == Segment::probation ? layer.probation_size : layer.protected_size;
    if (node.previous >= 0) {
        layer.nodes[static_cast<std::size_t>(node.previous)].next = node.next;
    } else {
        head = node.next;
    }
    if (node.next >= 0) {
        layer.nodes[static_cast<std::size_t>(node.next)].previous = node.previous;
    } else {
        tail = node.previous;
    }
    node.previous = node.next = -1;
    node.segment = Segment::absent;
    --size;
}

void ExpertCache::push_back(Layer & layer, std::int16_t index, Segment into) noexcept {
    auto & node = layer.nodes[static_cast<std::size_t>(index)];
    std::int16_t & head = into == Segment::probation ? layer.probation_head : layer.protected_head;
    std::int16_t & tail = into == Segment::probation ? layer.probation_tail : layer.protected_tail;
    std::uint32_t & size = into == Segment::probation ? layer.probation_size : layer.protected_size;
    node.previous = tail;
    node.next = -1;
    node.segment = into;
    if (tail >= 0) {
        layer.nodes[static_cast<std::size_t>(tail)].next = index;
    } else {
        head = index;
    }
    tail = index;
    ++size;
}

std::int16_t ExpertCache::pop_front(Layer & layer, Segment from) noexcept {
    std::int16_t & head = from == Segment::probation ? layer.probation_head : layer.protected_head;
    const std::int16_t index = head;
    if (index >= 0) {
        unlink(layer, index, from);
    }
    return index;
}

bool ExpertCache::resident(std::uint32_t key) const noexcept {
    const std::uint32_t layer = key >> 8;
    if (layer < first_layer || layer > last_layer) return false;
    return layers_[layer - first_layer]
               .nodes[static_cast<std::size_t>(key & 0xFFu)]
               .segment != Segment::absent;
}

ExpertCache::Access ExpertCache::access(std::uint32_t key) noexcept {
    const std::uint32_t layer_number = key >> 8;
    const auto expert = static_cast<std::int16_t>(key & 0xFFu);
    Layer & layer = layers_[layer_number - first_layer];
    Node & node = layer.nodes[static_cast<std::size_t>(expert)];
    const std::uint32_t layer_base = layer_number << 8;
    Access outcome;

    ++accesses_;

    if (node.segment == Segment::protected_) {
        // deja protege : simple rafraichissement de recence
        unlink(layer, expert, Segment::protected_);
        push_back(layer, expert, Segment::protected_);
        ++hits_;
        outcome.hit = true;
        return outcome;
    }

    if (node.segment == Segment::probation) {
        // deuxieme acces : promotion. Si le segment protege deborde, son plus
        // ancien redescend en probation, et si la probation deborde a son tour
        // son plus ancien sort du cache.
        unlink(layer, expert, Segment::probation);
        push_back(layer, expert, Segment::protected_);
        if (layer.protected_size > protected_quota_) {
            const std::int16_t demoted = pop_front(layer, Segment::protected_);
            if (demoted >= 0) {
                push_back(layer, demoted, Segment::probation);
                if (layer.probation_size > probation_quota_) {
                    const std::int16_t dropped = pop_front(layer, Segment::probation);
                    if (dropped >= 0) {
                        outcome.evicted = true;
                        outcome.evicted_key = layer_base | static_cast<std::uint32_t>(dropped);
                    }
                }
            }
        }
        ++hits_;
        outcome.hit = true;
        return outcome;
    }

    // absent : admission inconditionnelle en probation. L'admission par
    // frequence a ete mesuree nuisible sur ce workload.
    cold_bytes_ += frozen_layer_record_bytes()[layer_number - first_layer];
    push_back(layer, expert, Segment::probation);
    if (layer.probation_size > probation_quota_) {
        const std::int16_t dropped = pop_front(layer, Segment::probation);
        if (dropped >= 0) {
            outcome.evicted = true;
            outcome.evicted_key = layer_base | static_cast<std::uint32_t>(dropped);
        }
    }
    return outcome;
}

}  // namespace galactus::h4

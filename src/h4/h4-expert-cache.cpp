#include "h4-expert-cache.hpp"

#include "h4-cache-plan.hpp"
#include "h4-core.hpp"
#include "h4-profile.hpp"

#include <algorithm>
#include <cstdio>
#include <stdexcept>

namespace galactus::h4 {

namespace {

std::uint64_t layer_expert_bytes(std::uint32_t layer) {
    if (layer < ExpertCache::first_layer() || layer > ExpertCache::last_layer()) {
        throw std::out_of_range("expert cache: layer outside the active profile routed range");
    }
    return frozen_layer_record_bytes()[layer - ExpertCache::first_layer()];
}

// Les deux segments d'une couche, a partir de son quota.
//
// probation_floor est ce dont une allocation NON uniforme a besoin et dont
// l'uniforme n'a jamais eu besoin : le moteur borne un micro-lot par le plus
// petit du quota et du segment probation, parce qu'un lot froid n'insere
// qu'en probation. Retrecir une couche retrecirait cette borne avec elle, et
// une forme de lot qui tournait hier leverait aujourd'hui. Maintenir la
// probation au plancher que l'uniforme fournissait deja rend la borne
// invariante par redistribution ; le segment protege absorbe tout l'ecart.
// A plancher nul, cette fonction est la formule d'origine, inchangee.
void split_segments(std::uint32_t quota, double protected_fraction,
                    std::uint32_t model_experts, std::uint32_t probation_floor,
                    std::uint32_t & protected_quota, std::uint32_t & probation_quota) {
    // RESIDENCE PLEINE : quand le quota d'une couche atteint le nombre
    // d'experts du modele, chaque expert possede son emplacement a demeure et
    // AUCUNE eviction ne peut jamais etre necessaire. On porte alors les deux
    // segments au niveau du quota : le nombre de cles distinctes de la couche
    // vaut au plus experts == quota, donc ni protected_size ni probation_size
    // ne peut depasser sa borne et aucune branche d'eviction de access() ne se
    // declenche. Sans cela le SLRU evincait sur la seule CAPACITE DE SEGMENT
    // (GLM-4.5-Air : probation 32 sur 128 emplacements, un pour chaque expert)
    // alors que l'arene tenait tout le modele : evictions et relectures
    // gratuites, et surtout un micro-lot borne a 3 tokens par le garde-fou du
    // moteur, soit un prompt a 21 tok/s. Le SLRU normal est inchange.
    if (quota >= model_experts) {
        protected_quota = quota;
        probation_quota = quota;
        return;
    }
    protected_quota = static_cast<std::uint32_t>(
        static_cast<double>(quota) * protected_fraction);
    if (protected_quota < 1) protected_quota = 1;
    if (protected_quota > quota - 1) protected_quota = quota - 1;
    probation_quota = quota - protected_quota;
    if (probation_quota < probation_floor) {
        probation_quota = std::min(quota - 1, probation_floor);
        protected_quota = quota - probation_quota;
    }
}

}  // namespace

std::uint32_t ExpertCache::first_layer() noexcept { return ModelProfile::active().first_layer; }
std::uint32_t ExpertCache::last_layer() noexcept { return ModelProfile::active().last_layer; }
std::uint32_t ExpertCache::layer_count() noexcept { return ModelProfile::active().layer_count(); }

ExpertCache::ExpertCache(std::uint64_t capacity_bytes, double protected_fraction)
    : capacity_bytes_(capacity_bytes), layers_(layer_count()) {
    if (capacity_bytes == 0) {
        throw std::invalid_argument("expert cache: capacity must be positive");
    }
    if (protected_fraction <= 0.0 || protected_fraction >= 1.0) {
        throw std::invalid_argument("expert cache: protected fraction must be in (0,1)");
    }
    std::uint64_t one_of_each = 0;
    for (std::uint32_t layer = first_layer(); layer <= last_layer(); ++layer) {
        one_of_each += layer_expert_bytes(layer);
    }
    quota_ = static_cast<std::uint32_t>(capacity_bytes / one_of_each);
    if (quota_ == 0) {
        throw std::invalid_argument("expert cache: capacity below one expert per layer");
    }
    const std::uint32_t model_experts = ModelProfile::active().experts;
    if (quota_ > model_experts) {
        quota_ = model_experts;
    }
    // Deux segments d'au moins 1, et leur somme vaut EXACTEMENT le quota :
    // avec les anciens minimums independants, quota 1 donnait protege 1 +
    // probation 1 = 2 cles residentes pour 1 seul emplacement memoire, et le
    // magasin fuyait ("free list a sec", banc llama4 Mac 16 Go, 2026-08-05).
    if (quota_ < 2) {
        throw std::invalid_argument(
            "expert cache: quota " + std::to_string(quota_)
            + " par couche : il faut au moins 2 emplacements (agrandir "
              "GALACTUS_H4_CACHE_BYTES)");
    }
    // La victime par frequence n'a rien a decider en residence pleine, ou
    // aucune eviction n'arrive jamais : on la laisse eteinte pour que ce
    // regime reste identique au byte pres a la politique d'origine.
    frequency_victim_ = CachePolicySelection::active().frequency_victim
                        && quota_ < model_experts;
    split_segments(quota_, protected_fraction, model_experts, 0,
                   protected_quota_, probation_quota_);
    // LE PLANCHER QUI REND LES PETITS CACHES ATTEIGNABLES. Un micro-lot d'un
    // token demande `used` experts residents en meme temps, et un lot froid
    // n'insere qu'en probation, donc une probation plus courte que `used` ne
    // tourne pas : le moteur leve et demande de reduire le micro-lot, ce qui
    // n'aide pas quand il vaut deja 1. A fraction protegee 0,75, qwen3-30b
    // (8 actifs) n'a une probation de 8 qu'a partir de 29 places par couche,
    // soit 7 Go d'arene ; a 9 places, soit 2,2 Go, la probation vaut 3 et le
    // moteur refuse. Or c'est exactement le regime qui interesse : le plus de
    // debit avec le moins de RAM. Le plancher deplace la frontiere du quota
    // vers used+1 sans toucher a la fraction protegee ailleurs. Il fait
    // partie de la nouvelle politique, donc GALACTUS_H4_CACHE_POLICY=uniform
    // le retire avec le reste.
    if (CachePolicySelection::active().use_plan
        || CachePolicySelection::active().frequency_victim) {
        const std::uint32_t used = ModelProfile::active().used;
        if (quota_ < model_experts && probation_quota_ < used) {
            split_segments(quota_, protected_fraction, model_experts,
                           std::min(quota_ - 1, used), protected_quota_, probation_quota_);
        }
    }
    for (auto & layer : layers_) {
        layer.quota = quota_;
        layer.protected_quota = protected_quota_;
        layer.probation_quota = probation_quota_;
    }
    if (quota_ >= model_experts) {
        // Residence pleine : rien a redistribuer, le modele entier tient.
        return;
    }
    apply_plan(protected_fraction, one_of_each, model_experts);
}

void ExpertCache::apply_plan(double protected_fraction, std::uint64_t one_of_each,
                             std::uint32_t model_experts) {
    const CachePlan * plan = CachePlan::active();
    if (plan == nullptr) return;
    const auto & profile = ModelProfile::active();
    if (plan->architecture != profile.architecture || plan->first_layer != profile.first_layer
        || plan->last_layer != profile.last_layer || plan->experts != profile.experts) {
        std::fprintf(stderr,
                     "galactus_h4: plan de cache pour %s %u-%u/%u, profil actif %s %u-%u/%u : "
                     "ignore, quota egal par couche\n",
                     plan->architecture.c_str(), plan->first_layer, plan->last_layer,
                     plan->experts, profile.architecture.c_str(), profile.first_layer,
                     profile.last_layer, profile.experts);
        return;
    }
    // Le budget rendu a l'allocateur est EXACTEMENT l'arene que le quota
    // uniforme achetait. Redistribuer, jamais agrandir.
    const std::uint64_t budget = static_cast<std::uint64_t>(quota_) * one_of_each;
    // Plancher : le segment probation de l'uniforme, plus une place protegee.
    // En dessous, la borne de micro-lot du moteur reculerait.
    const std::uint32_t floor = probation_quota_ + 1;
    if (floor > model_experts) return;
    std::vector<std::uint64_t> record_bytes(frozen_layer_record_bytes().begin(),
                                            frozen_layer_record_bytes().end());
    std::vector<std::uint32_t> quotas;
    try {
        quotas = plan_layer_quotas(plan->curves, record_bytes, budget, floor, model_experts);
    } catch (const std::exception & error) {
        std::fprintf(stderr, "galactus_h4: %s, quota egal par couche\n", error.what());
        return;
    }
    // Ceinture et bretelles : l'allocateur respecte le budget par
    // construction, mais c'est lui qui decide de la taille de l'arene, donc
    // la verification est refaite ici plutot que supposee.
    std::uint64_t spent = 0;
    for (std::size_t index = 0; index < quotas.size(); ++index) {
        if (quotas[index] < 2) {
            std::fprintf(stderr, "galactus_h4: plan de cache : couche %zu a %u places, "
                                 "quota egal par couche\n", index, quotas[index]);
            return;
        }
        spent += static_cast<std::uint64_t>(quotas[index]) * record_bytes[index];
    }
    if (spent > budget) {
        std::fprintf(stderr, "galactus_h4: plan de cache : %llu octets pour un budget de "
                             "%llu, quota egal par couche\n",
                     static_cast<unsigned long long>(spent),
                     static_cast<unsigned long long>(budget));
        return;
    }
    std::uint32_t low = model_experts, high = 0;
    for (std::size_t index = 0; index < quotas.size(); ++index) {
        auto & layer = layers_[index];
        layer.quota = quotas[index];
        split_segments(layer.quota, protected_fraction, model_experts, probation_quota_,
                       layer.protected_quota, layer.probation_quota);
        low = std::min(low, layer.quota);
        high = std::max(high, layer.quota);
    }
    planned_ = true;
    std::fprintf(stderr,
                 "galactus_h4: plan de cache applique, %u a %u places par couche "
                 "(uniforme %u), %llu octets sur %llu\n",
                 low, high, quota_, static_cast<unsigned long long>(spent),
                 static_cast<unsigned long long>(budget));
}

std::uint32_t ExpertCache::quota_of(std::uint32_t layer) const noexcept {
    return layers_[layer - first_layer()].quota;
}

std::uint32_t ExpertCache::protected_quota_of(std::uint32_t layer) const noexcept {
    return layers_[layer - first_layer()].protected_quota;
}

std::uint32_t ExpertCache::probation_quota_of(std::uint32_t layer) const noexcept {
    return layers_[layer - first_layer()].probation_quota;
}

std::uint32_t ExpertCache::min_probation_quota() const noexcept {
    std::uint32_t smallest = probation_quota_;
    for (const auto & layer : layers_) {
        smallest = std::min(smallest, layer.probation_quota);
    }
    return smallest;
}

std::uint64_t ExpertCache::expert_bytes(std::uint32_t layer) const noexcept {
    return frozen_layer_record_bytes()[layer - first_layer()];
}

std::uint64_t ExpertCache::resident_bytes() const noexcept {
    std::uint64_t total = 0;
    for (std::uint32_t index = 0; index < layer_count(); ++index) {
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

void ExpertCache::begin_batch(std::uint32_t layer_number) noexcept {
    if (layer_number < first_layer() || layer_number > last_layer()) return;
    ++layers_[layer_number - first_layer()].epoch;
}

void ExpertCache::note_access(Layer & layer, std::int16_t index) noexcept {
    if (!frequency_victim_) return;
    Node & node = layer.nodes[static_cast<std::size_t>(index)];
    node.epoch = layer.epoch;
    if (node.frequency < 0xFFFFu) ++node.frequency;
    // Amortissement : sans lui un expert brulant au debut du prompt resterait
    // le plus frequent pour toujours et la politique deviendrait un classement
    // fige. Halver periodiquement garde l'ordre relatif et laisse la fenetre
    // recente peser.
    if (++layer.since_decay >= decay_period) {
        layer.since_decay = 0;
        for (auto & other : layer.nodes) other.frequency = static_cast<std::uint16_t>(
            other.frequency >> 1);
    }
}

std::int16_t ExpertCache::take_victim(Layer & layer) noexcept {
    if (!frequency_victim_) return pop_front(layer, Segment::probation);
    // La moins frequente, la plus ancienne en cas d'egalite (la liste est en
    // ordre LRU, tete en premier), et jamais une cle du lot courant.
    std::int16_t worst = -1;
    std::uint16_t worst_frequency = 0;
    for (std::int16_t index = layer.probation_head; index >= 0;
         index = layer.nodes[static_cast<std::size_t>(index)].next) {
        const Node & node = layer.nodes[static_cast<std::size_t>(index)];
        if (node.epoch == layer.epoch) continue;
        if (worst < 0 || node.frequency < worst_frequency) {
            worst = index;
            worst_frequency = node.frequency;
        }
    }
    if (worst < 0) {
        // Toutes les cles appartiennent au lot courant. Le garde-fou du moteur
        // rend ce cas inatteignable (un lot ne peut pas contenir plus
        // d'experts distincts que le segment probation) ; retomber sur la plus
        // ancienne garde la politique definie plutot que silencieusement
        // fausse si jamais il l'etait.
        return pop_front(layer, Segment::probation);
    }
    unlink(layer, worst, Segment::probation);
    return worst;
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
    const std::uint32_t layer = key >> key_expert_bits;
    if (layer < first_layer() || layer > last_layer()) return false;
    return layers_[layer - first_layer()]
               .nodes[static_cast<std::size_t>(key & key_expert_mask)]
               .segment != Segment::absent;
}

ExpertCache::Access ExpertCache::access(std::uint32_t key) noexcept {
    const std::uint32_t layer_number = key >> key_expert_bits;
    const auto expert = static_cast<std::int16_t>(key & key_expert_mask);
    Layer & layer = layers_[layer_number - first_layer()];
    Node & node = layer.nodes[static_cast<std::size_t>(expert)];
    const std::uint32_t layer_base = layer_number << key_expert_bits;
    Access outcome;

    ++accesses_;
    note_access(layer, expert);

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
        if (layer.protected_size > layer.protected_quota) {
            const std::int16_t demoted = pop_front(layer, Segment::protected_);
            if (demoted >= 0) {
                push_back(layer, demoted, Segment::probation);
                if (layer.probation_size > layer.probation_quota) {
                    const std::int16_t dropped = take_victim(layer);
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
    cold_bytes_ += frozen_layer_record_bytes()[layer_number - first_layer()];
    push_back(layer, expert, Segment::probation);
    if (layer.probation_size > layer.probation_quota) {
        const std::int16_t dropped = take_victim(layer);
        if (dropped >= 0) {
            outcome.evicted = true;
            outcome.evicted_key = layer_base | static_cast<std::uint32_t>(dropped);
        }
    }
    return outcome;
}

}  // namespace galactus::h4

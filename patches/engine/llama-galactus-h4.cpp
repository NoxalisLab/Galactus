#include "llama-galactus-h4.h"

#include "h4-expert-cache.hpp"
#include "h4-expert-store.hpp"
#include "h4-profile.hpp"
#include "h4-reader.hpp"
#include "h4-route-observer.hpp"

#include "ggml-alloc.h"
#include "ggml-backend.h"

#include <algorithm>
#include <atomic>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

namespace galactus_h4 {

namespace {

using namespace galactus::h4;

const char * environment(const char * name, const char * fallback) {
    const char * value = std::getenv(name);
    return value != nullptr && value[0] != '\0' ? value : fallback;
}

// Un tenseur cree au chargement, en attente d'adossement a l'arene.
struct PendingTensor {
    ggml_tensor * tensor;
    int layer;
    int rank;                   // down=0, gate|gate_up=1, up=2 (ordre du pack)
    std::uint64_t matrix_bytes; // taille de la matrice d'UN expert
    std::uint64_t role_offset;  // calcule par init(), independant de l'ordre de creation
};

struct State {
    bool activated = false;

    ggml_context * context = nullptr;                 // possede les tenseurs exps
    std::vector<PendingTensor> pending;

    std::unique_ptr<DualVolumeReader> reader;
    std::unique_ptr<P0Layout> layout;
    std::unique_ptr<ExpertStore> store;
    ggml_backend_buffer_t arena_buffer = nullptr;

    std::atomic<std::uint64_t> served_layers{0};
    std::atomic<std::uint64_t> hits{0};
    std::atomic<std::uint64_t> misses{0};
    std::atomic<std::uint64_t> bytes_read{0};

    std::mutex serve_mutex;
};

State & state() {
    // Fuite volontaire : un destructeur statique joindrait les threads du
    // lecteur pendant que dyld demonte le processus. L'OS recupere tout.
    static State * instance = new State();
    return *instance;
}

// L'ordre des roles dans un enregistrement du pack est GELE : down, gate, up.
// (scripts/h4-pack-write.py, EXPECTED_ROLE_ORDER)
int role_rank(const char * role) {
    if (std::strcmp(role, "down") == 0) return 0;
    if (std::strcmp(role, "gate") == 0) return 1;
    if (std::strcmp(role, "gate_up") == 0) return 1;   // dispositions fusionnees (gpt-oss...)
    if (std::strcmp(role, "up") == 0) return 2;
    throw std::runtime_error(std::string("galactus_h4: role inconnu ") + role);
}

std::string ratio_text(double ratio) {
    char buffer[32];
    // 17 significant digits round-trip any IEEE double: two values that differ
    // must never print the same in a refusal message.
    std::snprintf(buffer, sizeof(buffer), "%.17g", ratio);
    return buffer;
}

std::uint64_t file_size_or_zero(const char * path) {
    struct stat info {};
    return ::stat(path, &info) == 0 ? static_cast<std::uint64_t>(info.st_size) : 0;
}

// Where the record split comes from, and how a disagreement is made loud.
//
// THE SOURCE OF TRUTH IS THE PACK. galactus-pack-write.py leaves a
// "<internal pack>.split" sidecar naming the ratio the records were actually
// cut at and the totals that ratio produced. The engine reads THAT, never a
// live bandwidth measurement: a user who reprobes their SSDs after installing
// gets a different r*, and the pack on disk has not moved.
//
// GALACTUS_H4_RATIO is the caller's belief (the app passes what it recorded at
// install). It is a CROSS-CHECK, not an input: when it disagrees with the
// sidecar, something has been swapped underneath us and the engine refuses to
// start naming both numbers. It only becomes an input when there is no sidecar
// at all, which is a hand-built pair of packs.
//
// A pack written before the sidecar existed keeps its historical treatment,
// bit for bit: same path twice means mono-volume, two paths mean the frozen
// P0v2 cut. Updating the app cannot make an installed model unreadable.
std::unique_ptr<P0Layout> build_layout(const char * internal_path, const char * external_path) {
    const bool same_path = std::strcmp(internal_path, external_path) == 0;

    SplitSidecar sidecar;
    const std::string sidecar_path = split_sidecar_path(internal_path);
    const bool has_sidecar = load_split_sidecar(sidecar_path, sidecar);

    const char * ratio_env = std::getenv("GALACTUS_H4_RATIO");
    const bool has_env = ratio_env != nullptr && ratio_env[0] != '\0';
    double env_ratio = 0.0;
    if (has_env) {
        char * stop = nullptr;
        env_ratio = std::strtod(ratio_env, &stop);
        if (stop == ratio_env || (stop != nullptr && *stop != '\0')) {
            throw std::runtime_error(std::string("galactus_h4: GALACTUS_H4_RATIO illisible: ")
                                     + ratio_env);
        }
    }

    P0Profile profile = P0Profile::single_volume;
    double ratio = p0v2_default_ratio;
    const char * origin = "";

    if (has_sidecar) {
        if (!sidecar.dual) {
            if (!same_path) {
                throw std::runtime_error(
                    "galactus_h4: le pack est enregistre mono-volume (" + sidecar_path
                    + ") mais deux chemins distincts ont ete fournis");
            }
            if (has_env) {
                throw std::runtime_error(
                    "galactus_h4: pack mono-volume (" + sidecar_path
                    + ") mais GALACTUS_H4_RATIO=" + ratio_text(env_ratio)
                    + " demande une decoupe a deux volumes");
            }
            profile = P0Profile::single_volume;
            origin = "mono-volume (sidecar)";
        } else {
            if (same_path) {
                throw std::runtime_error(
                    "galactus_h4: le pack est enregistre a deux volumes (" + sidecar_path
                    + ") mais un seul chemin a ete fourni");
            }
            // THE cross-check. Exact equality on purpose: both sides parsed
            // the same decimal spelling with a correctly rounded strtod, so
            // equal spellings give equal doubles and anything else is a real
            // divergence, not a rounding artefact.
            if (has_env && env_ratio != sidecar.ratio) {
                throw std::runtime_error(
                    "galactus_h4: ratio de decoupe incoherent : le pack a ete ecrit a "
                    + ratio_text(sidecar.ratio) + " (" + sidecar_path
                    + ") et l'appelant demande " + ratio_text(env_ratio)
                    + " (GALACTUS_H4_RATIO). Reinstaller le modele ou corriger l'appelant : "
                      "lire ce pack a l'autre ratio renverrait de mauvais octets.");
            }
            profile = P0Profile::dual_ratio;
            ratio = sidecar.ratio;
            origin = "deux volumes (sidecar)";
        }
    } else if (same_path) {
        profile = P0Profile::single_volume;
        origin = "mono-volume (heritage)";
    } else if (has_env) {
        if (!p0_ratio_usable(env_ratio)) {
            throw std::runtime_error(
                "galactus_h4: GALACTUS_H4_RATIO=" + ratio_text(env_ratio) + " hors bornes ["
                + ratio_text(p0_ratio_minimum) + ", " + ratio_text(p0_ratio_maximum) + "]");
        }
        profile = P0Profile::dual_ratio;
        ratio = env_ratio;
        origin = "deux volumes (GALACTUS_H4_RATIO, pack sans sidecar)";
    } else {
        profile = P0Profile::v2_7157_2843;
        origin = "deux volumes (P0v2 heritage)";
    }

    auto layout = std::make_unique<P0Layout>(frozen_layer_record_bytes(), profile, ratio);

    // THE PROOF, and the reason a rounding disagreement cannot stay silent.
    // The totals are the sum of every per-record cut: if the reader placed a
    // single record one 16 KiB block away from where the packer put it, the
    // sums no longer match and the engine stops here instead of serving
    // garbage from one of the two volumes.
    if (has_sidecar) {
        if (layout->internal_bytes() != sidecar.internal_bytes
            || layout->external_bytes() != sidecar.external_bytes) {
            throw std::runtime_error(
                "galactus_h4: la disposition calculee ne reproduit pas le pack ("
                + sidecar_path + ") : interne " + std::to_string(layout->internal_bytes())
                + " contre " + std::to_string(sidecar.internal_bytes)
                + ", externe " + std::to_string(layout->external_bytes())
                + " contre " + std::to_string(sidecar.external_bytes)
                + ". Le packeur et le lecteur ne coupent pas au meme endroit.");
        }
        // And the packs themselves: a truncated or substituted file is caught
        // here rather than as wrong logits three hours later.
        const std::uint64_t internal_size = file_size_or_zero(internal_path);
        if (internal_size != layout->internal_bytes()) {
            throw std::runtime_error(
                "galactus_h4: pack interne " + std::string(internal_path) + " : "
                + std::to_string(internal_size) + " octets, "
                + std::to_string(layout->internal_bytes()) + " attendus");
        }
        if (sidecar.dual) {
            const std::uint64_t external_size = file_size_or_zero(external_path);
            if (external_size != layout->external_bytes()) {
                throw std::runtime_error(
                    "galactus_h4: pack externe " + std::string(external_path) + " : "
                    + std::to_string(external_size) + " octets, "
                    + std::to_string(layout->external_bytes()) + " attendus");
            }
        }
    }

    if (profile == P0Profile::dual_ratio) {
        std::fprintf(stderr, "galactus_h4: disposition %s, ratio interne %s\n",
                     origin, ratio_text(ratio).c_str());
    } else {
        std::fprintf(stderr, "galactus_h4: disposition %s\n", origin);
    }
    return layout;
}

// userdata du rappel : l'indice de couche, encode en pointeur stable.
struct LayerTag { int layer; };
LayerTag layer_tags[512];   // borne large : Qwen3-235B a 94 couches

std::uint64_t fnv1a64(const unsigned char * data, std::size_t length) {
    // Base FNV-1a 64 bits reelle. Elle portait un chiffre en moins, ce qui
    // donnait une empreinte coherente avec elle-meme mais differente de tout
    // FNV-1a calcule ailleurs : les comparaisons hors ligne trace/pack
    // repondaient NON alors que les octets etaient identiques.
    std::uint64_t hash = 14695981039346656037ULL;
    for (std::size_t i = 0; i < length; ++i) {
        hash ^= data[i];
        hash *= 1099511628211ULL;
    }
    return hash;
}

void remap_callback(ggml_tensor * dst, const ggml_tensor * source, int ith, int nth, void * userdata) {
    (void) nth;
    if (ith != 0) return;
    auto & s = state();
    // Observation only (GALACTUS_H4_ROUTES). When the variable is unset,
    // enabled() is false and every branch below is skipped; nothing it does
    // touches a tensor, the arena, the cache or the store.
    auto & observer = RouteObserver::instance();
    const std::uint64_t observed_enter_ns =
        observer.enabled() ? RouteObserver::now_ns() : 0;
    const int layer = static_cast<const LayerTag *>(userdata)->layer;
    const auto count = ggml_nelements(source);
    // LE BUG DE PERPLEXITE (tour 238) : selected_experts est une VUE non
    // contigue (ggml_top_k : ne=[8, n_tokens], nb[1] = rangee argsort
    // complete de n_expert). La lecture lineaire etait juste pour le premier
    // token du micro-lot et lisait, pour les suivants, les rangs 9+ du
    // PREMIER token : tout token au-dela du premier partait sur les mauvais
    // experts. Lecture par strides, rien d'autre ne change.
    const auto * source_bytes = static_cast<const unsigned char *>(source->data);
    auto * dst_bytes = static_cast<unsigned char *>(dst->data);
    std::vector<std::int32_t> expert_ids(static_cast<std::size_t>(count));
    {
        std::size_t flat = 0;
        for (int64_t i2 = 0; i2 < source->ne[2]; ++i2)
        for (int64_t i1 = 0; i1 < source->ne[1]; ++i1)
        for (int64_t i0 = 0; i0 < source->ne[0]; ++i0, ++flat) {
            expert_ids[flat] = *reinterpret_cast<const std::int32_t *>(
                source_bytes + i2 * source->nb[2] + i1 * source->nb[1] + i0 * source->nb[0]);
        }
    }

    // Observation only, opt-in (GALACTUS_H4_ROUTES_RANKS=1). The argsort ranks
    // BELOW the top-k cut, which is what answers "would a wider fetch have
    // covered the next token"; top-k alone cannot answer it.
    //
    // They are NOT readable from here. ggml_argsort_top_k builds a view whose
    // nb[1] spans the whole argsort row, so the ranks look like they sit next
    // to the ones the layer uses, but the scheduler hands this CPU node a copy
    // that keeps that stride and holds k values only: reading rank k+1 would
    // read past the copy. They come instead from the evaluation callback
    // further down, which reads the argsort node itself once it has been
    // computed and leaves the row in the observer.
    std::vector<std::int32_t> observed_ranks;
    std::uint32_t observed_ranks_per_token = 0;
    if (observer.enabled() && observer.wants_extended_ranks()) {
        observed_ranks = observer.take_ranks(
            static_cast<std::uint32_t>(layer),
            static_cast<std::uint32_t>(source->ne[1] * source->ne[2]),
            observed_ranks_per_token);
    }

    std::vector<std::uint32_t> keys(static_cast<std::size_t>(count));
    for (int64_t i = 0; i < count; ++i) {
        keys[static_cast<std::size_t>(i)] = (static_cast<std::uint32_t>(layer) << key_expert_bits)
                | (static_cast<std::uint32_t>(expert_ids[static_cast<std::size_t>(i)]) & key_expert_mask);
    }

    // Le lot entier alimente UN mul_mat_id : tous ses experts distincts
    // doivent etre residents SIMULTANEMENT. Deux bornes, fail-closed, la plus
    // petite s'applique :
    //   - le quota d'emplacements de la couche (borne physique de l'arene) ;
    //   - le segment probation du SLRU (un lot froid n'insere qu'en
    //     probation ; au-dela, il evincerait ses propres membres).
    // En residence pleine le cache n'evince plus rien et porte la probation au
    // niveau du quota (h4-expert-cache.cpp) : la borne redevient le quota,
    // donc le micro-lot physique standard passe. En regime ruisselant la
    // probation reste inferieure au quota et rien ne change.
    // La parade operationnelle est un micro-lot plus petit (-ub).
    {
        std::vector<std::uint32_t> distinct(keys);
        std::sort(distinct.begin(), distinct.end());
        distinct.erase(std::unique(distinct.begin(), distinct.end()), distinct.end());
        const auto quota = s.store->slots_of(static_cast<std::uint32_t>(layer));
        const auto probation =
            s.store->cache().probation_quota_of(static_cast<std::uint32_t>(layer));
        const auto bound = std::min(quota, probation);
        if (distinct.size() > bound) {
            const auto used = std::max(1U, ModelProfile::active().used);
            throw std::runtime_error(
                "galactus_h4: couche " + std::to_string(layer) + " : "
                + std::to_string(distinct.size()) + " experts distincts dans le lot, "
                + "borne sure " + std::to_string(bound)
                + (bound == probation ? " (segment probation)" : " (quota de couche)")
                + ". Reduire le micro-lot : -ub " + std::to_string(bound / used));
        }
    }

    std::lock_guard<std::mutex> lock(s.serve_mutex);
    // Observation only: the SAME residency bits the hit counter below already
    // samples, kept per key instead of only summed. A prefetch that names an
    // expert the cache was going to serve anyway costs bandwidth and saves
    // nothing, so the residency bit is what makes a hit rate net of the cache.
    std::vector<std::uint8_t> observed_resident;
    if (observer.enabled()) observed_resident.resize(static_cast<std::size_t>(count));
    std::uint32_t before_hits = 0;
    for (int64_t i = 0; i < count; ++i) {
        const bool was_resident = s.store->cache().resident(keys[i]);
        if (observer.enabled()) {
            observed_resident[static_cast<std::size_t>(i)] = was_resident ? 1u : 0u;
        }
        before_hits += was_resident ? 1u : 0u;
    }
    const std::uint64_t observed_serve_start_ns =
        observer.enabled() ? RouteObserver::now_ns() : 0;
    const auto bytes = s.store->serve_layer(keys.data(), static_cast<std::uint32_t>(count));
    const std::uint64_t observed_serve_end_ns =
        observer.enabled() ? RouteObserver::now_ns() : 0;

    // Autoverification (GALACTUS_H4_AUTOVERIF=1) : immediatement apres le
    // service, relire chaque enregistrement du pack par un descripteur NEUF
    // sans F_NOCACHE et comparer aux octets de l'arene. Ecart present ici =
    // la lecture elle-meme livre des octets faux ; absent ici mais present
    // au trace = quelque chose ecrase l'arene entre les deux.
    static const bool autoverif = [] {
        const char * v = std::getenv("GALACTUS_H4_AUTOVERIF");
        return v != nullptr && v[0] == '1';
    }();
    static std::atomic<std::uint64_t> autoverified{0};
    if (autoverif && autoverified.load(std::memory_order_relaxed) < 48) {
        static int verif_fd = ::open(std::getenv("GALACTUS_H4_INTERNAL"), O_RDONLY);
        std::vector<std::uint32_t> lot(keys);
        std::sort(lot.begin(), lot.end());
        lot.erase(std::unique(lot.begin(), lot.end()), lot.end());
        for (const auto key : lot) {
            if (autoverified.fetch_add(1, std::memory_order_relaxed) >= 48) break;
            const auto * arena = static_cast<const unsigned char *>(s.store->data(key));
            const auto & loc = s.layout->lookup(key);
            const std::uint64_t len = loc.internal_length + loc.external_length;
            std::vector<unsigned char> disk(static_cast<std::size_t>(len));
            std::uint64_t done = 0;
            bool bad_read = verif_fd < 0;
            while (!bad_read && done < len) {
                const ssize_t got = ::pread(verif_fd, disk.data() + done,
                                            static_cast<std::size_t>(len - done),
                                            static_cast<off_t>(loc.internal_offset + done));
                if (got <= 0) { bad_read = true; break; }
                done += static_cast<std::uint64_t>(got);
            }
            if (arena == nullptr || bad_read) {
                std::fprintf(stderr, "galactus_autoverif: couche %u expert %u : INDISPONIBLE\n",
                             key >> key_expert_bits, key & key_expert_mask);
                continue;
            }
            std::uint64_t first = len;
            for (std::uint64_t b = 0; b < len; ++b) {
                if (arena[b] != disk[b]) { first = b; break; }
            }
            if (first == len) {
                std::fprintf(stderr,
                             "galactus_autoverif: couche %u expert %3u emplacement %d : IDENTIQUE (%llu octets)\n",
                             key >> key_expert_bits, key & key_expert_mask, (int) s.store->slot_of(key),
                             (unsigned long long) len);
            } else {
                std::fprintf(stderr,
                             "galactus_autoverif: couche %u expert %3u emplacement %d : DIFFERENT des l'octet %llu\n",
                             key >> key_expert_bits, key & key_expert_mask, (int) s.store->slot_of(key),
                             (unsigned long long) first);
            }
        }
    }
    s.bytes_read.fetch_add(bytes, std::memory_order_relaxed);
    s.served_layers.fetch_add(1, std::memory_order_relaxed);
    s.hits.fetch_add(before_hits, std::memory_order_relaxed);
    s.misses.fetch_add(static_cast<std::uint64_t>(count) - before_hits, std::memory_order_relaxed);

    if (observer.enabled()) {
        observer.record(static_cast<std::uint32_t>(layer),
                        static_cast<std::uint32_t>(source->ne[1] * source->ne[2]),
                        static_cast<std::uint32_t>(source->ne[0]),
                        expert_ids.data(), observed_resident.data(),
                        observed_ranks.empty() ? nullptr : observed_ranks.data(),
                        observed_ranks_per_token,
                        observed_enter_ns, observed_serve_start_ns,
                        observed_serve_end_ns, bytes);
    }

    {
        std::size_t flat = 0;
        for (int64_t i2 = 0; i2 < dst->ne[2]; ++i2)
        for (int64_t i1 = 0; i1 < dst->ne[1]; ++i1)
        for (int64_t i0 = 0; i0 < dst->ne[0]; ++i0, ++flat) {
            const std::int16_t slot = s.store->slot_of(keys[flat]);
            if (slot < 0) throw std::runtime_error("galactus_h4: cle servie sans emplacement");
            *reinterpret_cast<std::int32_t *>(
                dst_bytes + i2 * dst->nb[2] + i1 * dst->nb[1] + i0 * dst->nb[0]) = slot;
        }
    }

    // Mode paranoia : GALACTUS_H4_TRACE=<fichier> capture (couche, expert,
    // emplacement, empreinte des octets REELLEMENT dans l'arene au moment du
    // remappage) pour les premiers rappels. La comparaison hors-ligne contre
    // le pack juge le systeme VIVANT, pas ses pieces isolees.
    static FILE * trace = [] () -> FILE * {
        const char * path = std::getenv("GALACTUS_H4_TRACE");
        return path != nullptr ? std::fopen(path, "w") : nullptr;
    }();
    static std::atomic<std::uint64_t> traced{0};
    if (trace != nullptr && traced.fetch_add(1) < 600) {
        for (int64_t i = 0; i < count; ++i) {
            const auto * bytes = static_cast<const unsigned char *>(s.store->data(keys[i]));
            const std::uint32_t layer_index = ExpertCache::layer_index(keys[i] >> key_expert_bits);
            const std::uint64_t record = frozen_layer_record_bytes()[layer_index];
            const std::uint64_t raw = ModelProfile::active().record_bytes_raw[layer_index];
            std::fprintf(trace, "%u %u %d %016llx %016llx %016llx\n",
                         keys[i] >> key_expert_bits, keys[i] & key_expert_mask,
                         (int) s.store->slot_of(keys[i]),
                         (unsigned long long) fnv1a64(bytes, 16384),
                         (unsigned long long) fnv1a64(bytes, static_cast<std::size_t>(raw)),
                         (unsigned long long) fnv1a64(bytes, static_cast<std::size_t>(record)));
        }
        std::fflush(trace);
    }

    // Observation only: the end of this callback is the start of the window a
    // prefetch issued here would have to fill, so it is stamped last.
    observer.mark_exit();
}

}  // namespace

bool active() {
    static const bool value = [] {
        const char * flag = std::getenv("GALACTUS_H4");
        return flag != nullptr && std::strcmp(flag, "1") == 0;
    }();
    return value;
}

bool wants_layer(int layer) {
    // Profil creux (hybrides) : une couche de la plage sans experts (SSM,
    // attention) n'est pas cablee.
    if (layer < 0 || !ExpertCache::routed_layer(static_cast<std::uint32_t>(layer))) {
        return false;
    }
    // GALACTUS_H4_ONLY_LAYERS=A-B : bissection — le cablage ne s'applique
    // qu'aux couches [A..B], les autres passent par la voie stock (-ncmoe).
    static const auto range = [] () -> std::pair<int, int> {
        // Par defaut : aucune restriction, les bornes du profil font foi.
        const char * spec = std::getenv("GALACTUS_H4_ONLY_LAYERS");
        int low = 0, high = 0;
        if (spec == nullptr || std::sscanf(spec, "%d-%d", &low, &high) != 2) {
            return {std::numeric_limits<int>::min(), std::numeric_limits<int>::max()};
        }
        return {low, high};
    }();
    return layer >= range.first && layer <= range.second;
}

ggml_tensor * create_exps(int layer, const char * role, ggml_type type,
                          int64_t ne0, int64_t ne1) {
    auto & s = state();
    if (s.context == nullptr) {
        ggml_init_params params{};
        params.mem_size = 4 * 1024 * 1024;
        params.no_alloc = true;
        s.context = ggml_init(params);
        if (s.context == nullptr) throw std::runtime_error("galactus_h4: ggml_init");
    }
    if (s.store == nullptr) {
        // Le magasin est construit ici (et pas dans init) parce que le quota
        // decide de ne[2] des maintenant. Le lecteur vient plus tard.
        const std::uint64_t capacity = std::strtoull(
            environment("GALACTUS_H4_CACHE_BYTES", "99868171264"), nullptr, 10);
        const std::uint32_t queue_depth = static_cast<std::uint32_t>(std::strtoul(
            environment("GALACTUS_H4_QD", "32"), nullptr, 10));
        const char * internal_path = std::getenv("GALACTUS_H4_INTERNAL");
        const char * external_path = std::getenv("GALACTUS_H4_EXTERNAL");
        if (internal_path == nullptr || external_path == nullptr) {
            throw std::runtime_error(
                "galactus_h4: GALACTUS_H4_INTERNAL et GALACTUS_H4_EXTERNAL sont requis");
        }
        // GALACTUS_H4_NOCACHE=0 desactive F_NOCACHE (experience une-variable :
        // si la PPL cable rejoint le stock sans lui, le coupable est nomme).
        const bool nocache = environment("GALACTUS_H4_NOCACHE", "1")[0] == '1';
        s.reader = std::make_unique<DualVolumeReader>(
            internal_path, external_path, queue_depth, 32ULL << 20, 2ULL << 30, nocache);
        std::fprintf(stderr, "galactus_h4: F_NOCACHE %s\n", nocache ? "demande" : "DESACTIVE");
        s.layout = build_layout(internal_path, external_path);
        // GALACTUS_H4_PROTECTED : fraction du quota reservee au segment
        // protege du SLRU (defaut 0,75). La baisser degage de la probation et
        // permet les gros modeles sur petites machines : le garde exige que
        // les experts distincts d'un micro-lot tiennent en probation. A 0,5,
        // Qwen3-235B (8 actifs) passe des ~26 Go de cache ; a 0,25, des ~14.
        const double protected_fraction = std::strtod(
            environment("GALACTUS_H4_PROTECTED", "0.75"), nullptr);
        if (protected_fraction <= 0.0 || protected_fraction >= 1.0) {
            throw std::runtime_error("galactus_h4: GALACTUS_H4_PROTECTED doit etre dans (0,1)");
        }
        s.store = std::make_unique<ExpertStore>(capacity, protected_fraction, *s.reader, *s.layout);
        std::fprintf(stderr, "galactus_h4: fraction protegee %.2f\n", protected_fraction);
        std::fprintf(stderr,
                     "galactus_h4: magasin construit, jusqu'a %u experts par couche, "
                     "arene %llu octets\n",
                     s.store->max_slots_per_layer(),
                     static_cast<unsigned long long>(s.store->slot_bytes()));
        // Observation only: the shape of the cache the hit rates below are net
        // of. A route file without it cannot be read after the fact.
        RouteObserver::instance().note_configuration(
            capacity, protected_fraction, s.store->cache().quota_per_layer(),
            s.store->cache().min_probation_quota(), s.store->max_slots_per_layer());
    }

    const std::uint32_t layer_index = ExpertCache::layer_index(static_cast<std::uint32_t>(layer));
    const std::uint64_t record = frozen_layer_record_bytes()[layer_index];
    const std::uint64_t matrix_bytes = ggml_row_size(type, ne0) * static_cast<std::uint64_t>(ne1);

    // ne[2] est le nombre de places de CETTE couche : un plan de cache en
    // donne plus la ou une place enleve le plus de lectures, et le tenseur
    // d'experts d'une couche doit decrire l'arene de cette couche.
    auto * tensor = ggml_new_tensor_3d(
        s.context, type, ne0, ne1,
        static_cast<int64_t>(s.store->slots_of(static_cast<std::uint32_t>(layer))));
    tensor->nb[2] = record;   // pas inter-expert = l'enregistrement du pack
    ggml_format_name(tensor, "galactus.blk.%d.%s_exps", layer, role);
    // L'offset du role dans l'enregistrement ne peut pas dependre de l'ordre
    // de creation (les architectures ne le garantissent pas) : il est calcule
    // et valide contre le profil au moment de l'adossement, dans init().
    s.pending.push_back({tensor, layer, role_rank(role), matrix_bytes, 0});
    return tensor;
}

void init() {
    auto & s = state();
    if (s.store == nullptr || s.pending.empty()) {
        return;   // actif mais aucune couche cablee (modele dense, plage vide)
    }

    // Offsets de roles par rang fixe, puis somme validee contre le profil :
    // chaque couche doit reconstituer exactement son enregistrement utile.
    std::size_t wired_layers = 0;
    {
        std::map<int, std::vector<PendingTensor *>> by_layer;
        for (auto & entry : s.pending) by_layer[entry.layer].push_back(&entry);
        wired_layers = by_layer.size();
        const auto & profile = ModelProfile::active();
        for (auto & [layer, entries] : by_layer) {
            std::sort(entries.begin(), entries.end(),
                      [](const PendingTensor * a, const PendingTensor * b) { return a->rank < b->rank; });
            std::uint64_t offset = 0;
            for (std::size_t i = 0; i < entries.size(); ++i) {
                if (i > 0 && entries[i]->rank == entries[i - 1]->rank) {
                    throw std::runtime_error("galactus_h4: rangs de roles dupliques, couche "
                                             + std::to_string(layer));
                }
                entries[i]->role_offset = offset;
                offset += entries[i]->matrix_bytes;
            }
            const std::uint32_t index = profile.index_of(static_cast<std::uint32_t>(layer));
            if (offset != profile.record_bytes_raw[index]) {
                throw std::runtime_error("galactus_h4: couche " + std::to_string(layer)
                    + " : somme des roles " + std::to_string(offset)
                    + " != enregistrement du profil "
                    + std::to_string(profile.record_bytes_raw[index]));
            }
        }
    }
    std::fprintf(stderr, "galactus_h4: %zu tenseurs a adosser (%zu couches sous cablage)\n",
                 s.pending.size(), wired_layers);

    ggml_backend_dev_t device = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_GPU);
    if (device == nullptr) throw std::runtime_error("galactus_h4: pas de device GPU");

    // GALACTUS_H4_CPU_MOE=1 : l'arene devient un tampon CPU — le planificateur
    // place alors les mul_mat_id d'experts sur le CPU (accumulation f32).
    // Mesure sonde v4 : les noyaux Metal mv_id des quants iq divergent de la
    // verite CPU de 1-2 % relatif par couche ; a 1,58 bpw cette imprecision,
    // injectee 75 fois par token dans le flux residuel, est la meilleure
    // explication restante de la perplexite 8,89 contre 2,67.
    const char * cpu_moe = std::getenv("GALACTUS_H4_CPU_MOE");
    const bool use_cpu = cpu_moe != nullptr && std::strcmp(cpu_moe, "1") == 0;

    auto * arena = const_cast<unsigned char *>(s.store->arena_base());
    if (use_cpu) {
        s.arena_buffer = ggml_backend_cpu_buffer_from_ptr(arena, s.store->slot_bytes());
        if (s.arena_buffer == nullptr) throw std::runtime_error("galactus_h4: tampon CPU refuse");
        // Sans ce marquage, le planificateur traite l'arene comme des donnees
        // ordinaires et place le mul_mat_id des experts sur Metal (memoire
        // unifiee) : noyau GPU, numerique differente, +1,1 % de PPL mesure
        // sur gpt-oss. Le chargeur stock marque TOUS ses tampons de poids
        // ainsi ; c'est ce qui epingle les ops ncmoe sur le CPU.
        ggml_backend_buffer_set_usage(s.arena_buffer, GGML_BACKEND_BUFFER_USAGE_WEIGHTS);
        for (const auto & entry : s.pending) {
            const std::uint32_t li = ExpertCache::layer_index(static_cast<std::uint32_t>(entry.layer));
            unsigned char * address = arena + s.store->layer_base(li) + entry.role_offset;
            if (ggml_backend_tensor_alloc(s.arena_buffer, entry.tensor, address) != GGML_STATUS_SUCCESS) {
                throw std::runtime_error("galactus_h4: tensor_alloc CPU a echoue");
            }
            if (entry.tensor->buffer == nullptr) throw std::runtime_error("galactus_h4: tampon nul");
        }
        s.activated = true;
        std::atexit([] {
            auto & st = state();
            if (st.arena_buffer != nullptr) { ggml_backend_buffer_free(st.arena_buffer); st.arena_buffer = nullptr; }
        });
        std::fprintf(stderr, "galactus_h4: %zu tenseurs adosses a l'arene ('%s'), experts sur CPU\n",
                     s.pending.size(), ggml_backend_buffer_name(s.arena_buffer));
        s.pending.clear();
        return;
    }
    // L'arene depasse maxBufferLength (86,6 Go sur M5 Max) : ggml la decoupe
    // en plusieurs MTLBuffers qui se CHEVAUCHENT de max_tensor_size. Nos
    // tenseurs a pas d'arene s'etendent sur toute la plaque d'une couche
    // (quota x enregistrement, ~1,5 Go) : c'est CETTE taille qui doit etre
    // le chevauchement, sinon la plaque qui tombe sur une frontiere devient
    // introuvable (mesure : couche 74, 'buffer is nil', a ~86 Go).
    const std::uint64_t max_slab = s.store->max_slab_bytes();
    s.arena_buffer = ggml_backend_dev_buffer_from_host_ptr(
        device, arena, s.store->slot_bytes(), max_slab);
    if (s.arena_buffer == nullptr) {
        throw std::runtime_error("galactus_h4: buffer_from_host_ptr refuse");
    }
    ggml_backend_buffer_set_usage(s.arena_buffer, GGML_BACKEND_BUFFER_USAGE_WEIGHTS);

    for (const auto & entry : s.pending) {
        const std::uint32_t layer_index =
            ExpertCache::layer_index(static_cast<std::uint32_t>(entry.layer));
        unsigned char * address = arena + s.store->layer_base(layer_index) + entry.role_offset;
        const auto status = ggml_backend_tensor_alloc(s.arena_buffer, entry.tensor, address);
        if (status != GGML_STATUS_SUCCESS) {
            throw std::runtime_error("galactus_h4: tensor_alloc a echoue (couche "
                                     + std::to_string(entry.layer) + ")");
        }
    }
    for (const auto & entry : s.pending) {
        if (entry.tensor->buffer == nullptr || entry.tensor->data == nullptr) {
            throw std::runtime_error(std::string("galactus_h4: tenseur sans tampon apres adossement: ")
                                     + entry.tensor->name);
        }
    }
    s.activated = true;
    // Le tampon Metal doit etre libere AVANT le demontage du device ggml,
    // sinon son residency set n'est pas vide et l'assert de ggml-metal-device
    // tue le processus apres Exiting... atexit s'enregistre ici, donc APRES
    // la construction du device : il s'executera avant sa destruction.
    std::atexit([] {
        auto & st = state();
        if (st.arena_buffer != nullptr) {
            ggml_backend_buffer_free(st.arena_buffer);
            st.arena_buffer = nullptr;
        }
    });
    std::fprintf(stderr,
                 "galactus_h4: %zu tenseurs adosses a l'arene ('%s'), cablage actif\n",
                 s.pending.size(), ggml_backend_buffer_name(s.arena_buffer));
    s.pending.clear();
}

ggml_tensor * remap_ids(ggml_context * ctx, ggml_tensor * selected_experts, int layer) {
    layer_tags[layer].layer = layer;
    return ggml_map_custom1(ctx, selected_experts, remap_callback, 1, &layer_tags[layer]);
}

void debug_probe(const ggml_tensor * gate, const ggml_tensor * up,
                 const ggml_tensor * down, int layer) {
    static std::atomic<bool> done{false};
    bool expected = false;
    if (!done.compare_exchange_strong(expected, true)) return;
    for (const auto * t : {gate, up, down}) {
        // Pas de gate : experts relu^2 a deux matrices (nemotron_h_moe) ou
        // gate_up fusionne. Un role absent n'a rien a montrer.
        if (t == nullptr) continue;
        std::fprintf(stderr,
            "galactus_h4: graphe couche %d voit '%s' type=%s ne2=%lld nb2=%zu data=%p tampon=%s\n",
            layer, t->name, ggml_type_name(t->type),
            (long long) t->ne[2], t->nb[2], t->data,
            t->buffer != nullptr ? ggml_backend_buffer_name(t->buffer) : "NUL");
    }
}

// Sonde differentielle : GALACTUS_H4_DUMP=1 imprime, pour la couche 3, les
// tenseurs intermediaires du MoE (absmax + 4 premieres valeurs + empreinte).
// Deux runs — stock et cablage — et la premiere ligne qui diverge nomme
// l'operation coupable. Fonctionne AUSSI sans cablage (GALACTUS_H4 absent).
bool dump_callback(ggml_tensor * t, bool ask, void * user_data) {
    (void) user_data;
    static const std::vector<std::string> wanted = [] {
        const char * layer = std::getenv("GALACTUS_H4_DUMP_LAYER");
        const std::string suffix = std::string("-") + (layer != nullptr && layer[0] != '\0' ? layer : "3");
        const char * stems[] = {
            "ffn_inp", "ffn_norm",
            "ffn_moe_logits", "ffn_moe_probs", "ffn_moe_argsort",
            "ffn_moe_topk", "ffn_moe_topk_galactus", "ffn_moe_weights",
            "ffn_moe_weights_norm", "ffn_moe_gate_up", "ffn_moe_gate_up_biased",
            "ffn_moe_gate", "ffn_moe_up", "ffn_moe_swiglu_oai",
            "ffn_moe_down", "ffn_moe_down_biased", "ffn_moe_weighted",
            "ffn_moe_out", "ffn_out", "l_out",
        };
        std::vector<std::string> names;
        for (const char * stem : stems) names.push_back(stem + suffix);
        return names;
    }();
    bool match = false;
    for (const auto & name : wanted) {
        if (name == t->name) { match = true; break; }
    }
    if (!match) return false;      // ask: pas interesse ; observe: rien
    if (ask) return true;
    static const int cap = [] {
        const char * value = std::getenv("GALACTUS_H4_DUMP_CAP");
        return value != nullptr && value[0] != '\0' ? std::atoi(value) : 26;
    }();
    static std::atomic<int> printed{0};
    if (printed.fetch_add(1) >= cap) return true;
    const auto count = ggml_nelements(t);
    // Lecture INTEGRALE : l'ancienne borne 4096 laissait le token 2 des
    // micro-lots (l_out = 6144 x 2 = 12288 elements) hors comparaison.
    std::vector<float> values(static_cast<std::size_t>(count));
    std::uint64_t digest = 0;
    if (t->type == GGML_TYPE_F32) {
        ggml_backend_tensor_get(t, values.data(), 0, values.size() * sizeof(float));
        digest = fnv1a64(reinterpret_cast<const unsigned char *>(values.data()),
                         values.size() * sizeof(float));
    } else if (t->type == GGML_TYPE_I32) {
        std::vector<std::int32_t> raw(values.size());
        ggml_backend_tensor_get(t, raw.data(), 0, raw.size() * sizeof(std::int32_t));
        digest = fnv1a64(reinterpret_cast<const unsigned char *>(raw.data()),
                         raw.size() * sizeof(std::int32_t));
        for (std::size_t i = 0; i < raw.size(); ++i) values[i] = static_cast<float>(raw[i]);
    } else {
        std::fprintf(stderr, "galactus_dump: %s type=%s (non lu)\n", t->name, ggml_type_name(t->type));
        return true;
    }
    double absmax = 0.0, sum = 0.0;
    for (const float v : values) { absmax = std::max(absmax, (double) std::fabs(v)); sum += v; }
    std::fprintf(stderr,
        "galactus_dump: %-26s ne=[%lld,%lld,%lld] empreinte=%016llx absmax=%.9g somme=%.9g v0..3=[%.9g %.9g %.9g %.9g]\n",
        t->name, (long long) t->ne[0], (long long) t->ne[1], (long long) t->ne[2],
        (unsigned long long) digest,
        absmax, sum, values.size() > 0 ? values[0] : 0.0f, values.size() > 1 ? values[1] : 0.0f,
        values.size() > 2 ? values[2] : 0.0f, values.size() > 3 ? values[3] : 0.0f);
    // Empreintes par colonne (token, k) pour les sorties d'experts : la
    // colonne qui diverge nomme l'expert fautif du micro-lot.
    if (t->type == GGML_TYPE_F32 && std::strncmp(t->name, "ffn_moe_", 8) == 0
            && t->ne[0] > 4 && t->ne[1] >= 1 && t->ne[2] >= 1
            && (long long) t->ne[0] * t->ne[1] * t->ne[2] == (long long) count) {
        std::string line = "galactus_dump: |colonnes";
        char piece[64];
        for (int64_t i2 = 0; i2 < t->ne[2]; ++i2) {
            for (int64_t i1 = 0; i1 < t->ne[1]; ++i1) {
                const float * col = values.data() + (i2 * t->ne[1] + i1) * t->ne[0];
                const std::uint64_t d = fnv1a64(
                    reinterpret_cast<const unsigned char *>(col),
                    static_cast<std::size_t>(t->ne[0]) * sizeof(float));
                std::snprintf(piece, sizeof(piece), " %lld/%lld=%016llx",
                              (long long) i2, (long long) i1, (unsigned long long) d);
                line += piece;
            }
        }
        std::fprintf(stderr, "%s\n", line.c_str());
    }
    return true;
}

bool dump_requested() {
    const char * flag = std::getenv("GALACTUS_H4_DUMP");
    return flag != nullptr && std::strcmp(flag, "1") == 0;
}

// Observation only. GALACTUS_H4_ROUTES_RANKS=1 asks for the argsort ranks below
// the top-k cut, which no longer exist by the time the remap callback runs: the
// scheduler hands that node a copy holding k values. The full argsort is its
// own graph node, named by llama-graph.cpp, so it is read here after it has
// been computed, the same way GALACTUS_H4_DUMP reads intermediate tensors.
//
// Installing an eval callback makes the scheduler walk the graph node by node,
// which is a real change of execution granularity. That is why this is a
// separate run whose TIMINGS are thrown away, and why the analysis cross-checks
// the top-k it stashes here against the top-k the remap callback saw.
bool routes_ranks_requested() {
    const char * routes = std::getenv("GALACTUS_H4_ROUTES");
    const char * ranks = std::getenv("GALACTUS_H4_ROUTES_RANKS");
    return routes != nullptr && routes[0] != '\0' && ranks != nullptr && ranks[0] == '1';
}

bool routes_ranks_callback(ggml_tensor * t, bool ask, void * user_data) {
    (void) user_data;
    static const std::string stem = "ffn_moe_argsort-";
    if (std::strncmp(t->name, stem.c_str(), stem.size()) != 0) return false;
    if (t->type != GGML_TYPE_I32) return false;
    if (ask) return true;
    const int layer = std::atoi(t->name + stem.size());
    if (!wants_layer(layer)) return true;
    const std::int64_t per_row = t->ne[0];
    const std::int64_t rows = t->ne[1] * t->ne[2] * t->ne[3];
    if (per_row <= 0 || rows <= 0) return true;
    // Bounded on purpose: only the ranks a widened fetch could plausibly reach
    // are of any use, and the whole row of a 128 expert model would multiply
    // the size of the route file by sixteen for nothing.
    const std::int64_t take = std::min<std::int64_t>(
        per_row, static_cast<std::int64_t>(ModelProfile::active().used) + 8);
    std::vector<std::int32_t> row(static_cast<std::size_t>(per_row));
    std::vector<std::int32_t> kept(static_cast<std::size_t>(rows * take));
    for (std::int64_t r = 0; r < rows; ++r) {
        ggml_backend_tensor_get(t, row.data(), static_cast<std::size_t>(r * per_row) * sizeof(std::int32_t),
                                row.size() * sizeof(std::int32_t));
        std::copy(row.begin(), row.begin() + take, kept.begin() + static_cast<std::size_t>(r * take));
    }
    RouteObserver::instance().stash_ranks(static_cast<std::uint32_t>(layer),
                                          static_cast<std::uint32_t>(rows),
                                          static_cast<std::uint32_t>(take), kept.data());
    return true;
}

Stats stats() {
    auto & s = state();
    return {
        s.served_layers.load(std::memory_order_relaxed),
        s.hits.load(std::memory_order_relaxed),
        s.misses.load(std::memory_order_relaxed),
        s.bytes_read.load(std::memory_order_relaxed),
    };
}

}  // namespace galactus_h4

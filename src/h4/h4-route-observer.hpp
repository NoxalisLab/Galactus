#pragma once

// Route observer: what the router picked, when, and what the cache already had.
//
// WHY THIS EXISTS
//
// Expert records are read from SSD at the moment a layer asks for them, so the
// read latency sits on the critical path. Prefetching can only hide that
// latency if the experts a layer is about to need can be named before the layer
// asks, and the router of layer L+1 consumes the output of layer L, so no
// prefetch can be exact. Whether speculation pays is therefore an empirical
// question about one number: the hit rate of a guess, measured NET of what the
// SLRU cache already serves, against the bytes the guess wastes.
//
// This unit records the evidence and computes nothing. It is switched on by
// GALACTUS_H4_ROUTES=<file> and is inert otherwise: when the variable is unset,
// enabled() is false and every entry point returns immediately.
//
// STRICTLY OBSERVATIONAL
//
// Nothing here writes to a tensor, to the arena, to the cache or to the store.
// It reads the expert ids the callback already extracted, the residency bits
// the callback already computed for its own hit counter, and the clock. The
// engine's claim is bit exactness; an instrument that can move a computed value
// is not an instrument, it is a bug.
//
// WHY THE RECORDS ARE BUFFERED IN MEMORY
//
// Two of the questions are about time: how long a layer's compute takes, and
// how long a record read takes. Writing a line to a file inside the measured
// window would put the file system in the middle of the measurement. Entries
// are appended to preallocated vectors and the file is written once, at exit.
//
// EXTENDED RANKS (GALACTUS_H4_ROUTES_RANKS=1, off by default)
//
// The tensor the callback receives is a view of the FULL argsort row
// (ggml_argsort_top_k returns a view_4d with nb[1] equal to the whole row), so
// ranks beyond top-k are physically present next to the ones the layer uses.
// Reading them answers "would widening the fetch have covered the next token",
// which cannot be answered from top-k alone. It is a read past the view's own
// ne[0], which is why it is opt-in and why every id read that way is checked
// against the model's expert count: one out-of-range value disables the capture
// for the rest of the run and says so in the file.

#include "h4-core.hpp"
#include "h4-profile.hpp"

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

namespace galactus::h4 {

class RouteObserver {
public:
    static RouteObserver & instance() {
        // Deliberately leaked, like the engine state it observes: a static
        // destructor would run while the process is being torn down.
        static RouteObserver * observer = new RouteObserver();
        return *observer;
    }

    [[nodiscard]] bool enabled() const noexcept { return file_ != nullptr; }
    [[nodiscard]] bool wants_extended_ranks() const noexcept { return extended_; }

    [[nodiscard]] static std::uint64_t now_ns() noexcept {
        return static_cast<std::uint64_t>(
            std::chrono::duration_cast<std::chrono::nanoseconds>(
                std::chrono::steady_clock::now().time_since_epoch()).count());
    }

    // One line of context, written once, so the file can be read years later
    // without the command that produced it.
    void note_configuration(std::uint64_t cache_bytes, double protected_fraction,
                            std::uint32_t quota, std::uint32_t probation,
                            std::uint32_t slots_per_layer) {
        if (!enabled()) return;
        std::lock_guard<std::mutex> lock(mutex_);
        cache_bytes_ = cache_bytes;
        protected_fraction_ = protected_fraction;
        quota_ = quota;
        probation_ = probation;
        slots_ = slots_per_layer;
    }

    // Called once per MoE layer per micro-batch, from inside the remap
    // callback, after the layer has been served.
    //
    // ids            tokens * k expert ids, score order, token major
    // resident       tokens * k residency bits, sampled BEFORE the serve
    // ranks          tokens * ranks_per_token extended ids, or empty
    void record(std::uint32_t layer, std::uint32_t tokens, std::uint32_t k,
                const std::int32_t * ids, const std::uint8_t * resident,
                const std::int32_t * ranks, std::uint32_t ranks_per_token,
                std::uint64_t enter_ns, std::uint64_t serve_start_ns,
                std::uint64_t serve_end_ns, std::uint64_t bytes_read) {
        if (!enabled()) return;
        std::lock_guard<std::mutex> lock(mutex_);
        if (entries_.size() >= entry_cap_) {
            truncated_ = true;
            return;
        }
        const std::size_t count = static_cast<std::size_t>(tokens) * k;
        Entry entry;
        entry.layer = layer;
        entry.tokens = tokens;
        entry.k = k;
        entry.ranks_per_token = ranks_per_token;
        entry.enter_ns = enter_ns;
        entry.serve_start_ns = serve_start_ns;
        entry.serve_end_ns = serve_end_ns;
        entry.gap_ns = last_exit_ns_ == 0 ? 0 : enter_ns - last_exit_ns_;
        entry.bytes_read = bytes_read;
        entry.id_offset = ids_.size();
        entry.rank_offset = ranks_.size();
        ids_.insert(ids_.end(), ids, ids + count);
        resident_.insert(resident_.end(), resident, resident + count);
        if (ranks != nullptr && ranks_per_token > 0) {
            ranks_.insert(ranks_.end(), ranks,
                          ranks + static_cast<std::size_t>(tokens) * ranks_per_token);
        }
        entries_.push_back(entry);
    }

    // The end of the callback, which is the start of the window a prefetch
    // issued here would have to fill.
    void mark_exit() noexcept {
        if (!enabled()) return;
        const std::uint64_t stamp = now_ns();
        std::lock_guard<std::mutex> lock(mutex_);
        last_exit_ns_ = stamp;
    }

    // THE SECOND WAY TO GET THE RANKS, and why it is needed.
    //
    // Reading past the view fails on the shipped path: the scheduler hands the
    // CPU node a copy of the top-k, laid out with the original row stride but
    // allocated for k values only, so ranks beyond k are simply not there. The
    // full argsort is, though, as its own graph node, and the engine already
    // has a way to look at a node after it has been computed without touching
    // it (the eval callback used by GALACTUS_H4_DUMP). The callback stashes the
    // row here, the remap callback of the same layer picks it up.
    //
    // That path serialises node execution, which is why it is a separate,
    // clearly marked run: what it produces is route CONTENT, never a timing.
    void stash_ranks(std::uint32_t layer, std::uint32_t tokens,
                     std::uint32_t per_token, const std::int32_t * ids) {
        if (!enabled()) return;
        std::lock_guard<std::mutex> lock(mutex_);
        if (stashed_.size() <= layer) stashed_.resize(layer + 1);
        auto & slot = stashed_[layer];
        slot.tokens = tokens;
        slot.per_token = per_token;
        slot.ids.assign(ids, ids + static_cast<std::size_t>(tokens) * per_token);
    }

    // The stash of one layer, or an empty vector. per_token is set on success.
    [[nodiscard]] std::vector<std::int32_t> take_ranks(std::uint32_t layer,
                                                       std::uint32_t tokens,
                                                       std::uint32_t & per_token) {
        per_token = 0;
        if (!enabled()) return {};
        std::lock_guard<std::mutex> lock(mutex_);
        if (stashed_.size() <= layer) return {};
        auto & slot = stashed_[layer];
        if (slot.per_token == 0 || slot.tokens != tokens) return {};
        per_token = slot.per_token;
        return slot.ids;
    }

    // An id read past the view's own ne[0] that cannot be an expert id. The
    // extended capture stops for the rest of the run rather than filling the
    // file with values whose provenance is unknown.
    void disable_extended_ranks(const char * why) noexcept {
        if (!extended_) return;
        extended_ = false;
        std::lock_guard<std::mutex> lock(mutex_);
        extended_refusal_ = why;
    }

private:
    struct Entry {
        std::uint32_t layer = 0;
        std::uint32_t tokens = 0;
        std::uint32_t k = 0;
        std::uint32_t ranks_per_token = 0;
        std::uint64_t enter_ns = 0;
        std::uint64_t serve_start_ns = 0;
        std::uint64_t serve_end_ns = 0;
        std::uint64_t gap_ns = 0;
        std::uint64_t bytes_read = 0;
        std::size_t id_offset = 0;
        std::size_t rank_offset = 0;
    };

    RouteObserver() {
        const char * path = std::getenv("GALACTUS_H4_ROUTES");
        if (path == nullptr || path[0] == '\0') return;
        file_ = std::fopen(path, "w");
        if (file_ == nullptr) {
            std::fprintf(stderr, "galactus_routes: cannot open %s, observation is off\n", path);
            return;
        }
        const char * ranks = std::getenv("GALACTUS_H4_ROUTES_RANKS");
        extended_ = ranks != nullptr && ranks[0] == '1';
        const char * cap = std::getenv("GALACTUS_H4_ROUTES_CAP");
        if (cap != nullptr && cap[0] != '\0') {
            entry_cap_ = std::strtoull(cap, nullptr, 10);
        }
        entries_.reserve(1u << 16);
        ids_.reserve(1u << 22);
        resident_.reserve(1u << 22);
        std::atexit([] { instance().flush(); });
        std::fprintf(stderr, "galactus_routes: observing into %s%s\n", path,
                     extended_ ? " (extended ranks)" : "");
    }

    void flush() {
        std::lock_guard<std::mutex> lock(mutex_);
        if (file_ == nullptr) return;
        const auto & profile = ModelProfile::active();
        std::fprintf(file_, "# galactus.route-observer.v1\n");
        std::fprintf(file_, "# arch %s\n", profile.architecture.c_str());
        std::fprintf(file_, "# first_layer %u last_layer %u experts %u used %u\n",
                     profile.first_layer, profile.last_layer, profile.experts, profile.used);
        std::fprintf(file_, "# cache_bytes %llu protected %.2f quota %u probation %u slots %u\n",
                     static_cast<unsigned long long>(cache_bytes_), protected_fraction_,
                     quota_, probation_, slots_);
        for (std::uint32_t layer = profile.first_layer; layer <= profile.last_layer; ++layer) {
            std::fprintf(file_, "# record %u %llu\n", layer,
                         static_cast<unsigned long long>(
                             frozen_layer_record_bytes()[layer - profile.first_layer]));
        }
        std::fprintf(file_, "# entries %zu truncated %d\n", entries_.size(),
                     truncated_ ? 1 : 0);
        if (!extended_refusal_.empty()) {
            std::fprintf(file_, "# extended_ranks_refused %s\n", extended_refusal_.c_str());
        }
        // e: one micro-batch of one layer. The ids follow, token major, score
        // order within a token, each id carrying the residency bit sampled
        // before the serve. r: the extended ranks of the same micro-batch.
        std::fprintf(file_,
                     "# e <seq> <layer> <tokens> <k> <enter_ns> <serve_start_ns> "
                     "<serve_end_ns> <gap_ns> <bytes_read> then <id>:<resident>...\n");
        std::fprintf(file_, "# r <seq> <ranks_per_token> then <id>...\n");
        for (std::size_t index = 0; index < entries_.size(); ++index) {
            const Entry & entry = entries_[index];
            std::fprintf(file_, "e %zu %u %u %u %llu %llu %llu %llu %llu", index,
                         entry.layer, entry.tokens, entry.k,
                         static_cast<unsigned long long>(entry.enter_ns),
                         static_cast<unsigned long long>(entry.serve_start_ns),
                         static_cast<unsigned long long>(entry.serve_end_ns),
                         static_cast<unsigned long long>(entry.gap_ns),
                         static_cast<unsigned long long>(entry.bytes_read));
            const std::size_t count = static_cast<std::size_t>(entry.tokens) * entry.k;
            for (std::size_t i = 0; i < count; ++i) {
                std::fprintf(file_, " %d:%u", ids_[entry.id_offset + i],
                             static_cast<unsigned>(resident_[entry.id_offset + i]));
            }
            std::fputc('\n', file_);
            if (entry.ranks_per_token > 0) {
                std::fprintf(file_, "r %zu %u", index, entry.ranks_per_token);
                const std::size_t total =
                    static_cast<std::size_t>(entry.tokens) * entry.ranks_per_token;
                for (std::size_t i = 0; i < total; ++i) {
                    std::fprintf(file_, " %d", ranks_[entry.rank_offset + i]);
                }
                std::fputc('\n', file_);
            }
        }
        std::fflush(file_);
        std::fclose(file_);
        file_ = nullptr;
    }

    std::FILE * file_ = nullptr;
    bool extended_ = false;
    bool truncated_ = false;
    std::string extended_refusal_;
    std::uint64_t entry_cap_ = 4000000;
    std::uint64_t last_exit_ns_ = 0;
    std::uint64_t cache_bytes_ = 0;
    double protected_fraction_ = 0.0;
    std::uint32_t quota_ = 0, probation_ = 0, slots_ = 0;
    std::vector<Entry> entries_;
    std::vector<std::int32_t> ids_;
    std::vector<std::uint8_t> resident_;
    std::vector<std::int32_t> ranks_;
    struct Stash {
        std::uint32_t tokens = 0;
        std::uint32_t per_token = 0;
        std::vector<std::int32_t> ids;
    };
    std::vector<Stash> stashed_;
    std::mutex mutex_;
};

}  // namespace galactus::h4

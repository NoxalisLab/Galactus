#pragma once

#include "h4-core.hpp"

#include <array>
#include <cstdint>
#include <future>
#include <memory>
#include <string>
#include <vector>

namespace galactus::h4 {

struct ReadRequest {
    std::uint64_t request_id;
    Volume volume;
    std::uint64_t offset;
    std::uint64_t length;
    bool compute_checksum = false;
    // nullptr : le worker lit dans son tampon d'anneau et le contenu est jete
    // (chemin de qualification du debit, inchange depuis le tour 85).
    // Non nul : pread ecrit directement ici. Le tampon doit etre aligne sur
    // 16 KiB et faire au moins `length` octets ; c'est l'appelant qui le
    // garantit. Chemin zero-copie vers une tranche de tampon Metal.
    void * destination = nullptr;
};

struct ReadResult {
    std::uint64_t request_id;
    Volume volume;
    std::uint64_t offset;
    std::uint64_t bytes_read;
    std::uint64_t checksum;
    bool checksum_computed;
    std::uint64_t submitted_at_ns;
    std::uint64_t completed_at_ns;
    std::uint64_t completion_latency_ns;
};

struct QueueMetrics {
    std::uint64_t submitted_requests;
    std::uint64_t submit_backpressure_events;
    std::uint32_t maximum_pending_depth;
    std::vector<std::uint64_t> pending_depth_histogram;
};

class DualVolumeReader {
public:
    DualVolumeReader(
        std::string internal_path,
        std::string external_path,
        std::uint32_t requested_queue_depth_per_volume,
        std::uint64_t maximum_read_bytes,
        std::uint64_t ring_limit_bytes,
        bool request_f_nocache = true);
    ~DualVolumeReader();

    DualVolumeReader(const DualVolumeReader &) = delete;
    DualVolumeReader & operator=(const DualVolumeReader &) = delete;
    DualVolumeReader(DualVolumeReader &&) = delete;
    DualVolumeReader & operator=(DualVolumeReader &&) = delete;

    [[nodiscard]] const RingPlan & ring_plan() const noexcept;
    [[nodiscard]] bool f_nocache_applied(Volume volume) const noexcept;
    [[nodiscard]] QueueMetrics queue_metrics(Volume volume) const;
    std::future<ReadResult> submit(ReadRequest request);

private:
    class Implementation;
    std::unique_ptr<Implementation> implementation_;
};

struct P0RecordLocation {
    std::uint64_t internal_offset;
    std::uint64_t internal_length;
    std::uint64_t external_offset;
    std::uint64_t external_length;
};

class P0Layout {
public:
    // `ratio` is read only by P0Profile::dual_ratio (see plan_p0_split).
    explicit P0Layout(
        const std::vector<std::uint64_t> & layer_record_bytes,
        P0Profile profile = P0Profile::v1_599_401,
        double ratio = p0v2_default_ratio);

    [[nodiscard]] const P0RecordLocation & lookup(std::uint32_t key) const;
    [[nodiscard]] std::uint64_t internal_bytes() const noexcept;
    [[nodiscard]] std::uint64_t external_bytes() const noexcept;
    [[nodiscard]] std::vector<ReadRequest> plan_token(
        const MissToken & token,
        std::uint64_t first_request_id = 0) const;

private:
    std::vector<P0RecordLocation> records_;
    std::uint64_t internal_bytes_ = 0;
    std::uint64_t external_bytes_ = 0;
};

struct P1RecordLocation {
    Volume volume;
    std::uint64_t offset;
    std::uint64_t length;
};

class P1Layout {
public:
    explicit P1Layout(const std::vector<std::uint64_t> & layer_record_bytes);

    [[nodiscard]] const P1RecordLocation & lookup(std::uint32_t key) const;
    [[nodiscard]] std::uint64_t internal_bytes() const noexcept;
    [[nodiscard]] std::uint64_t external_bytes() const noexcept;
    [[nodiscard]] std::vector<ReadRequest> plan_token(
        const MissToken & token,
        std::uint64_t first_request_id = 0) const;

private:
    std::vector<P1RecordLocation> records_;
    std::uint64_t internal_bytes_ = 0;
    std::uint64_t external_bytes_ = 0;
};

} // namespace galactus::h4

#include "h4-reader.hpp"

#include "h4-profile.hpp"

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <deque>
#include <fcntl.h>
#include <limits>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <unistd.h>

namespace galactus::h4 {
namespace {

class AlignedBuffer {
public:
    explicit AlignedBuffer(std::size_t size) : size_(size) {
        if (posix_memalign(&data_, record_alignment_bytes, size_) != 0) {
            throw std::bad_alloc();
        }
        std::memset(data_, 0, size_);
    }

    ~AlignedBuffer() {
        std::free(data_);
    }

    AlignedBuffer(const AlignedBuffer &) = delete;
    AlignedBuffer & operator=(const AlignedBuffer &) = delete;
    AlignedBuffer(AlignedBuffer &&) = delete;
    AlignedBuffer & operator=(AlignedBuffer &&) = delete;

    [[nodiscard]] void * data() noexcept {
        return data_;
    }

private:
    void * data_ = nullptr;
    std::size_t size_ = 0;
};

std::uint64_t fnv1a(const unsigned char * data, std::size_t size) {
    std::uint64_t value = 14'695'981'039'346'656'037ULL;
    for (std::size_t index = 0; index < size; ++index) {
        value ^= data[index];
        value *= 1'099'511'628'211ULL;
    }
    return value;
}

std::runtime_error system_error(const std::string & operation) {
    return std::runtime_error(operation + ": " + std::strerror(errno));
}

struct Task {
    ReadRequest request;
    std::promise<ReadResult> promise;
    std::uint64_t submitted_at_ns;
};

std::uint64_t monotonic_now_ns() noexcept {
    return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count());
}

class VolumeWorkerPool {
public:
    VolumeWorkerPool(
        const std::string & path,
        Volume volume,
        std::uint32_t worker_count,
        std::size_t maximum_read_bytes,
        bool request_f_nocache)
        : volume_(volume), maximum_read_bytes_(maximum_read_bytes), queue_capacity_(worker_count),
          pending_depth_histogram_(static_cast<std::size_t>(worker_count) + 1U, 0) {
        descriptor_ = open(path.c_str(), O_RDONLY | O_CLOEXEC);
        if (descriptor_ < 0) {
            throw system_error("cannot open H4 volume file " + path);
        }
#if defined(__APPLE__)
        if (request_f_nocache) {
            f_nocache_applied_ = fcntl(descriptor_, F_NOCACHE, 1) == 0;
        }
#else
        static_cast<void>(request_f_nocache);
#endif
        try {
            buffers_.reserve(worker_count);
            workers_.reserve(worker_count);
            for (std::uint32_t worker = 0; worker < worker_count; ++worker) {
                buffers_.push_back(std::make_unique<AlignedBuffer>(maximum_read_bytes_));
            }
            for (std::uint32_t worker = 0; worker < worker_count; ++worker) {
                workers_.emplace_back([this, worker] { run(worker); });
            }
        } catch (...) {
            stop_and_join();
            close(descriptor_);
            descriptor_ = -1;
            throw;
        }
    }

    ~VolumeWorkerPool() {
        stop_and_join();
        if (descriptor_ >= 0) {
            close(descriptor_);
        }
    }

    VolumeWorkerPool(const VolumeWorkerPool &) = delete;
    VolumeWorkerPool & operator=(const VolumeWorkerPool &) = delete;

    std::future<ReadResult> submit(ReadRequest request) {
        const auto submitted_at_ns = monotonic_now_ns();
        Task task{request, {}, submitted_at_ns};
        auto future = task.promise.get_future();
        {
            std::unique_lock<std::mutex> lock(mutex_);
            if (tasks_.size() >= queue_capacity_) {
                ++submit_backpressure_events_;
            }
            space_condition_.wait(lock, [this] { return stopping_ || tasks_.size() < queue_capacity_; });
            if (stopping_) {
                throw std::runtime_error("cannot submit to a stopped H4 volume reader");
            }
            tasks_.push_back(std::move(task));
            ++submitted_requests_;
            maximum_pending_depth_ = std::max<std::uint32_t>(
                maximum_pending_depth_, static_cast<std::uint32_t>(tasks_.size()));
            ++pending_depth_histogram_.at(tasks_.size());
        }
        condition_.notify_one();
        return future;
    }

    [[nodiscard]] bool f_nocache_applied() const noexcept {
        return f_nocache_applied_;
    }

    QueueMetrics queue_metrics() {
        std::lock_guard<std::mutex> lock(mutex_);
        return {
            submitted_requests_,
            submit_backpressure_events_,
            maximum_pending_depth_,
            pending_depth_histogram_,
        };
    }

private:
    void stop_and_join() noexcept {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            stopping_ = true;
        }
        condition_.notify_all();
        space_condition_.notify_all();
        for (auto & worker : workers_) {
            if (worker.joinable()) {
                worker.join();
            }
        }
        workers_.clear();
    }

    // A promise allocation failure is process-fatal under noexcept. This is a
    // deliberate fail-stop policy for the benchmark; ordinary I/O failures
    // are transported to the caller through the future.
    void run(std::size_t worker_index) noexcept {
        while (true) {
            Task task;
            {
                std::unique_lock<std::mutex> lock(mutex_);
                condition_.wait(lock, [this] { return stopping_ || !tasks_.empty(); });
                if (tasks_.empty()) {
                    if (stopping_) {
                        return;
                    }
                    continue;
                }
                task = std::move(tasks_.front());
                tasks_.pop_front();
            }
            space_condition_.notify_one();
            try {
                auto * destination = task.request.destination != nullptr
                    ? static_cast<unsigned char *>(task.request.destination)
                    : static_cast<unsigned char *>(buffers_[worker_index]->data());
                std::uint64_t completed = 0;
                while (completed < task.request.length) {
                    const auto remaining = static_cast<std::size_t>(task.request.length - completed);
                    const auto result = pread(
                        descriptor_,
                        destination + completed,
                        remaining,
                        static_cast<off_t>(task.request.offset + completed));
                    if (result < 0) {
                        if (errno == EINTR) {
                            continue;
                        }
                        throw system_error("H4 pread failed");
                    }
                    if (result == 0) {
                        throw std::runtime_error("H4 pread reached EOF before completing the request");
                    }
                    completed += static_cast<std::uint64_t>(result);
                }
                const auto checksum = task.request.compute_checksum
                    ? fnv1a(destination, static_cast<std::size_t>(task.request.length))
                    : 0;
                const auto completed_at_ns = monotonic_now_ns();
                task.promise.set_value({
                    task.request.request_id,
                    volume_,
                    task.request.offset,
                    completed,
                    checksum,
                    task.request.compute_checksum,
                    task.submitted_at_ns,
                    completed_at_ns,
                    completed_at_ns - task.submitted_at_ns,
                });
            } catch (...) {
                task.promise.set_exception(std::current_exception());
            }
        }
    }

    Volume volume_;
    std::size_t maximum_read_bytes_;
    int descriptor_ = -1;
    bool f_nocache_applied_ = false;
    std::vector<std::unique_ptr<AlignedBuffer>> buffers_;
    std::vector<std::thread> workers_;
    std::mutex mutex_;
    std::condition_variable condition_;
    std::condition_variable space_condition_;
    std::deque<Task> tasks_;
    std::size_t queue_capacity_;
    std::uint64_t submitted_requests_ = 0;
    std::uint64_t submit_backpressure_events_ = 0;
    std::uint32_t maximum_pending_depth_ = 0;
    std::vector<std::uint64_t> pending_depth_histogram_;
    bool stopping_ = false;
};

} // namespace

class DualVolumeReader::Implementation {
public:
    Implementation(
        const std::string & internal_path,
        const std::string & external_path,
        std::uint32_t requested_queue_depth_per_volume,
        std::uint64_t maximum_read_bytes,
        std::uint64_t ring_limit_bytes,
        bool request_f_nocache)
        : plan(plan_ring(requested_queue_depth_per_volume, maximum_read_bytes, ring_limit_bytes)) {
        if (maximum_read_bytes > std::numeric_limits<std::size_t>::max()) {
            throw std::invalid_argument("maximum H4 read size exceeds addressable memory");
        }
        internal = std::make_unique<VolumeWorkerPool>(
            internal_path,
            Volume::internal,
            plan.effective_queue_depth_per_volume,
            static_cast<std::size_t>(maximum_read_bytes),
            request_f_nocache);
        external = std::make_unique<VolumeWorkerPool>(
            external_path,
            Volume::external,
            plan.effective_queue_depth_per_volume,
            static_cast<std::size_t>(maximum_read_bytes),
            request_f_nocache);
        maximum_read_bytes_ = maximum_read_bytes;
    }

    std::future<ReadResult> submit(ReadRequest request) {
        if (request.length == 0) {
            throw std::invalid_argument("H4 read length is outside the configured range");
        }
        // La borne de l'anneau ne concerne que le chemin sans destination.
        if (request.destination == nullptr && request.length > maximum_read_bytes_) {
            throw std::invalid_argument("H4 read length is outside the configured range");
        }
        if (request.destination != nullptr &&
            reinterpret_cast<std::uintptr_t>(request.destination) % record_alignment_bytes != 0) {
            throw std::invalid_argument("H4 read destination must be aligned to 16 KiB");
        }
        if (request.offset % record_alignment_bytes != 0 || request.length % record_alignment_bytes != 0) {
            throw std::invalid_argument("H4 reads must be aligned to 16 KiB");
        }
        if (request.offset > static_cast<std::uint64_t>(std::numeric_limits<off_t>::max()) - request.length) {
            throw std::overflow_error("H4 read offset exceeds off_t");
        }
        return request.volume == Volume::internal
            ? internal->submit(request)
            : external->submit(request);
    }

    RingPlan plan;
    std::unique_ptr<VolumeWorkerPool> internal;
    std::unique_ptr<VolumeWorkerPool> external;

private:
    std::uint64_t maximum_read_bytes_ = 0;
};

DualVolumeReader::DualVolumeReader(
    std::string internal_path,
    std::string external_path,
    std::uint32_t requested_queue_depth_per_volume,
    std::uint64_t maximum_read_bytes,
    std::uint64_t ring_limit_bytes,
    bool request_f_nocache)
    : implementation_(std::make_unique<Implementation>(
          internal_path,
          external_path,
          requested_queue_depth_per_volume,
          maximum_read_bytes,
          ring_limit_bytes,
          request_f_nocache)) {}

DualVolumeReader::~DualVolumeReader() = default;

const RingPlan & DualVolumeReader::ring_plan() const noexcept {
    return implementation_->plan;
}

bool DualVolumeReader::f_nocache_applied(Volume volume) const noexcept {
    return volume == Volume::internal
        ? implementation_->internal->f_nocache_applied()
        : implementation_->external->f_nocache_applied();
}

QueueMetrics DualVolumeReader::queue_metrics(Volume volume) const {
    return volume == Volume::internal
        ? implementation_->internal->queue_metrics()
        : implementation_->external->queue_metrics();
}

std::future<ReadResult> DualVolumeReader::submit(ReadRequest request) {
    return implementation_->submit(request);
}

P0Layout::P0Layout(
    const std::vector<std::uint64_t> & layer_record_bytes,
    P0Profile profile) {
    const std::uint32_t experts = ModelProfile::active().experts;
    records_.reserve(layer_record_bytes.size() * experts);
    for (std::uint32_t layer_index = 0; layer_index < layer_record_bytes.size(); ++layer_index) {
        const auto split = plan_p0_split(layer_record_bytes[layer_index], profile);
        for (std::uint32_t expert = 0; expert < experts; ++expert) {
            records_.push_back({internal_bytes_, split.internal_bytes, external_bytes_, split.external_bytes});
            internal_bytes_ += split.internal_bytes;
            external_bytes_ += split.external_bytes;
        }
    }
}

const P0RecordLocation & P0Layout::lookup(std::uint32_t key) const {
    const auto layer = key >> key_expert_bits;
    const auto expert = key & key_expert_mask;
    const auto & mp = ModelProfile::active();
    if (layer < mp.first_layer || layer > mp.last_layer || expert >= mp.experts) {
        throw std::invalid_argument("P0 lookup key is outside the routed-expert domain");
    }
    const auto index = (layer - mp.first_layer) * mp.experts + expert;
    return records_.at(index);
}

std::uint64_t P0Layout::internal_bytes() const noexcept {
    return internal_bytes_;
}

std::uint64_t P0Layout::external_bytes() const noexcept {
    return external_bytes_;
}

std::vector<ReadRequest> P0Layout::plan_token(const MissToken & token, std::uint64_t first_request_id) const {
    if (token.keys.size() > (std::numeric_limits<std::uint64_t>::max() - first_request_id) / 2U) {
        throw std::overflow_error("P0 request identifiers overflow");
    }
    std::vector<ReadRequest> requests;
    requests.reserve(token.keys.size() * 2U);
    auto request_id = first_request_id;
    for (const auto key : token.keys) {
        const auto & record = lookup(key);
        requests.push_back({request_id++, Volume::internal, record.internal_offset, record.internal_length, false});
        requests.push_back({request_id++, Volume::external, record.external_offset, record.external_length, false});
    }
    return requests;
}

P1Layout::P1Layout(const std::vector<std::uint64_t> & layer_record_bytes) {
    const std::uint32_t experts = ModelProfile::active().experts;
    records_.reserve(layer_record_bytes.size() * experts);
    CanonicalP1Placement placement;
    for (std::uint32_t layer_index = 0; layer_index < layer_record_bytes.size(); ++layer_index) {
        const auto layer = ModelProfile::active().first_layer + layer_index;
        const auto bytes = layer_record_bytes[layer_index];
        for (std::uint32_t expert = 0; expert < experts; ++expert) {
            const auto volume = placement.assign(layer, expert, bytes);
            if (volume == Volume::internal) {
                records_.push_back({volume, internal_bytes_, bytes});
                internal_bytes_ += bytes;
            } else {
                records_.push_back({volume, external_bytes_, bytes});
                external_bytes_ += bytes;
            }
        }
    }
    if (!placement.complete() || placement.internal_bytes() != internal_bytes_ ||
        placement.external_bytes() != external_bytes_) {
        throw std::logic_error("P1 layout diverged from the canonical placement");
    }
}

const P1RecordLocation & P1Layout::lookup(std::uint32_t key) const {
    const auto layer = key >> key_expert_bits;
    const auto expert = key & key_expert_mask;
    const auto & mp = ModelProfile::active();
    if (layer < mp.first_layer || layer > mp.last_layer || expert >= mp.experts) {
        throw std::invalid_argument("P1 lookup key is outside the routed-expert domain");
    }
    const auto index = (layer - mp.first_layer) * mp.experts + expert;
    return records_.at(index);
}

std::uint64_t P1Layout::internal_bytes() const noexcept {
    return internal_bytes_;
}

std::uint64_t P1Layout::external_bytes() const noexcept {
    return external_bytes_;
}

std::vector<ReadRequest> P1Layout::plan_token(const MissToken & token, std::uint64_t first_request_id) const {
    if (token.keys.size() > std::numeric_limits<std::uint64_t>::max() - first_request_id) {
        throw std::overflow_error("P1 request identifiers overflow");
    }
    std::vector<ReadRequest> requests;
    requests.reserve(token.keys.size());
    auto request_id = first_request_id;
    for (const auto key : token.keys) {
        const auto & record = lookup(key);
        requests.push_back({request_id++, record.volume, record.offset, record.length, false});
    }
    return requests;
}

} // namespace galactus::h4

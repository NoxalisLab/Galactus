#include "h4-a0-contract.hpp"

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>

#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <fcntl.h>
#include <iomanip>
#include <iostream>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <unistd.h>
#include <utility>
#include <vector>

#include <mach/mach.h>

namespace {

using namespace h4::a0;

struct Options {
    bool child = false;
    std::string event_log;
};

Options parse_options(int argc, char ** argv) {
    Options result;
    for (int index = 1; index < argc; ++index) {
        const std::string_view argument = argv[index];
        if (argument == "--child") {
            result.child = true;
        } else if (argument == "--event-log" && index + 1 < argc) {
            result.event_log = argv[++index];
        } else {
            throw std::invalid_argument("unknown or incomplete argument");
        }
    }
    if (!result.child || result.event_log.empty()) {
        throw std::invalid_argument("child mode and event log are required");
    }
    return result;
}

bool is_lower_hex_64(std::string_view value) {
    return value.size() == 64 && std::all_of(value.begin(), value.end(), [](char character) {
        return (character >= '0' && character <= '9') ||
               (character >= 'a' && character <= 'f');
    });
}

std::string json_escape(std::string_view value) {
    std::string output;
    for (const char character : value) {
        switch (character) {
            case '\\': output += "\\\\"; break;
            case '"': output += "\\\""; break;
            case '\n': output += "\\n"; break;
            case '\r': output += "\\r"; break;
            case '\t': output += "\\t"; break;
            default: output += character; break;
        }
    }
    return output;
}

class DurableEvents {
  public:
    explicit DurableEvents(const std::string & path) {
        descriptor_ = ::open(path.c_str(), O_WRONLY | O_APPEND | O_CREAT | O_EXCL, 0644);
        if (descriptor_ < 0) {
            throw std::runtime_error("cannot create append-only event log");
        }
    }

    DurableEvents(const DurableEvents &) = delete;
    DurableEvents & operator=(const DurableEvents &) = delete;

    ~DurableEvents() {
        if (descriptor_ >= 0) {
            ::close(descriptor_);
        }
    }

    void emit(const std::string & line) {
        std::string payload = line;
        payload.push_back('\n');
        std::size_t written = 0;
        while (written < payload.size()) {
            const ssize_t count = ::write(descriptor_, payload.data() + written, payload.size() - written);
            if (count < 0) {
                throw std::runtime_error("event log write failed");
            }
            written += static_cast<std::size_t>(count);
        }
        if (::fsync(descriptor_) != 0) {
            throw std::runtime_error("event log fsync failed");
        }
        std::cout << line << std::endl;
    }

  private:
    int descriptor_ = -1;
};

struct Resource {
    void * pointer = nullptr;
    std::uint64_t length = 0;
    id<MTLBuffer> buffer = nil;
    bool metal = false;
    std::uint64_t ordinal = 0;

    Resource() = default;
    Resource(const Resource &) = delete;
    Resource & operator=(const Resource &) = delete;

    Resource(Resource && other) noexcept {
        *this = std::move(other);
    }

    Resource & operator=(Resource && other) noexcept {
        if (this != &other) {
            release();
            pointer = std::exchange(other.pointer, nullptr);
            length = std::exchange(other.length, 0);
            buffer = std::exchange(other.buffer, nil);
            metal = std::exchange(other.metal, false);
            ordinal = std::exchange(other.ordinal, 0);
        }
        return *this;
    }

    ~Resource() { release(); }

    void release() {
        if (buffer != nil) {
            [buffer release];
            buffer = nil;
            pointer = nullptr;
        } else if (pointer != nullptr) {
            vm_deallocate(mach_task_self(), reinterpret_cast<vm_address_t>(pointer),
                          static_cast<vm_size_t>(length));
            pointer = nullptr;
        }
    }
};

struct Counters {
    std::uint64_t metal_requested = 0;
    std::uint64_t cpu_requested = 0;
    std::uint64_t cache_requested = 0;
    std::uint64_t cache_touched = 0;
    std::uint64_t resource_count = 0;
    std::uint64_t checksum = 0;
};

std::string event_json(
    std::string_view event,
    std::string_view component,
    const Counters & counters,
    id<MTLDevice> device,
    std::uint64_t requested_bytes = 0,
    std::uint64_t touched_bytes = 0,
    std::uint64_t ordinal = 0,
    kern_return_t vm_result = KERN_SUCCESS,
    std::string_view allocation_api = ""
) {
    std::ostringstream output;
    output << '{'
           << "\"schema\":\"galactus.h4-a0-child-event.v1\","
           << "\"event\":\"" << json_escape(event) << "\","
           << "\"component\":\"" << json_escape(component) << "\","
           << "\"requested_bytes\":" << requested_bytes << ','
           << "\"touched_bytes\":" << touched_bytes << ','
           << "\"resource_ordinal\":" << ordinal << ','
           << "\"resource_count\":" << counters.resource_count << ','
           << "\"metal_requested_bytes\":" << counters.metal_requested << ','
           << "\"cpu_requested_bytes\":" << counters.cpu_requested << ','
           << "\"cache_requested_bytes\":" << counters.cache_requested << ','
           << "\"cache_touched_bytes\":" << counters.cache_touched << ','
           << "\"conservative_metal_charge_bytes\":"
           << counters.metal_requested + kConservativeCpuChargeBytes << ','
           << "\"current_allocated_bytes\":"
           << (device == nil ? 0ULL : static_cast<std::uint64_t>(device.currentAllocatedSize)) << ','
           << "\"recommended_max_working_set_bytes\":"
           << (device == nil ? 0ULL : static_cast<std::uint64_t>(device.recommendedMaxWorkingSetSize)) << ','
           << "\"max_buffer_length_bytes\":"
           << (device == nil ? 0ULL : static_cast<std::uint64_t>(device.maxBufferLength)) << ','
           << "\"checksum\":" << counters.checksum << ','
           << "\"vm_allocate_kern_return\":" << vm_result << ','
           << "\"allocation_api\":\"" << json_escape(allocation_api) << "\""
           << '}';
    return output.str();
}

void wait_for(std::string_view expected) {
    std::string line;
    if (!std::getline(std::cin, line) || line != expected) {
        throw std::runtime_error("supervisor acknowledgement missing or invalid");
    }
}

bool allocate_resource(
    Resource & resource,
    std::uint64_t length,
    bool metal,
    std::uint64_t ordinal,
    id<MTLDevice> device,
    kern_return_t & vm_result
) {
    if (length == 0 || length > std::numeric_limits<vm_size_t>::max()) {
        throw std::invalid_argument("resource length is invalid");
    }
    vm_address_t address = 0;
    vm_result = vm_allocate(mach_task_self(), &address, static_cast<vm_size_t>(length),
                            VM_FLAGS_ANYWHERE);
    if (vm_result != KERN_SUCCESS) {
        return false;
    }
    resource.pointer = reinterpret_cast<void *>(address);
    resource.length = length;
    resource.metal = metal;
    resource.ordinal = ordinal;
    if (!metal) {
        return true;
    }
    resource.buffer = [device newBufferWithBytesNoCopy:resource.pointer
                                                length:static_cast<NSUInteger>(length)
                                               options:MTLResourceStorageModeShared
                                           deallocator:^(void * pointer, NSUInteger size) {
                                               vm_deallocate(
                                                   mach_task_self(),
                                                   reinterpret_cast<vm_address_t>(pointer),
                                                   static_cast<vm_size_t>(size));
                                           }];
    if (resource.buffer == nil) {
        vm_deallocate(mach_task_self(), address, static_cast<vm_size_t>(length));
        resource.pointer = nullptr;
        return false;
    }
    return true;
}

std::uint64_t touch_chunk(Resource & resource, std::uint64_t offset, std::uint64_t maximum) {
    const std::uint64_t end = std::min(resource.length, offset + maximum);
    auto * bytes = static_cast<unsigned char *>(resource.pointer);
    std::uint64_t position = offset;
    while (position + sizeof(std::uint64_t) <= end) {
        const std::uint64_t word = pattern_word(resource.ordinal, position);
        std::memcpy(bytes + position, &word, sizeof(word));
        position += sizeof(word);
    }
    if (position < end) {
        const std::uint64_t word = pattern_word(resource.ordinal, position);
        std::memcpy(bytes + position, &word, static_cast<std::size_t>(end - position));
    }
    return end - offset;
}

std::uint64_t verify_resource_pages(const Resource & resource) {
    const auto * bytes = static_cast<const unsigned char *>(resource.pointer);
    std::uint64_t checksum = 0;
    for (std::uint64_t offset = 0; offset < resource.length; offset += kPageSizeBytes) {
        const std::size_t readable = static_cast<std::size_t>(
            std::min<std::uint64_t>(sizeof(std::uint64_t), resource.length - offset));
        std::uint64_t observed = 0;
        std::memcpy(&observed, bytes + offset, readable);
        const std::uint64_t expected = pattern_word(resource.ordinal, offset);
        const std::uint64_t mask = readable == sizeof(std::uint64_t)
            ? std::numeric_limits<std::uint64_t>::max()
            : ((1ULL << (readable * 8U)) - 1ULL);
        if ((observed & mask) != (expected & mask)) {
            throw std::runtime_error("touch checksum mismatch");
        }
        checksum ^= splitmix64(observed ^ offset ^ resource.ordinal);
    }
    return checksum;
}

void touch_resources_guarded(
    std::vector<Resource> & resources,
    std::string_view component,
    Counters & counters,
    id<MTLDevice> device,
    DurableEvents & events,
    bool cache
) {
    std::uint64_t quantum = 0;
    std::uint64_t quantum_touched = 0;
    for (Resource & resource : resources) {
        std::uint64_t offset = 0;
        while (offset < resource.length) {
            const std::uint64_t allowance = kTouchQuantumBytes - quantum;
            const std::uint64_t count = touch_chunk(resource, offset, allowance);
            offset += count;
            quantum += count;
            quantum_touched += count;
            if (cache) {
                counters.cache_touched += count;
            }
            if (quantum == kTouchQuantumBytes) {
                events.emit(event_json("touch_quantum", component, counters, device,
                                       quantum_touched, quantum_touched, resource.ordinal));
                wait_for("ACK");
                quantum = 0;
                quantum_touched = 0;
            }
        }
        counters.checksum ^= verify_resource_pages(resource);
    }
    if (quantum != 0) {
        events.emit(event_json("touch_quantum", component, counters, device,
                               quantum_touched, quantum_touched,
                               resources.empty() ? 0 : resources.back().ordinal));
        wait_for("ACK");
    }
}

int run_child(const Options & options) {
    const char * capability_value = std::getenv("GALACTUS_A0_CHILD_CAPABILITY");
    const std::string capability = capability_value == nullptr ? "" : capability_value;
    if (!is_lower_hex_64(capability)) {
        throw std::runtime_error("missing child capability");
    }

    DurableEvents events(options.event_log);
    Counters counters;
    events.emit(event_json("pre_backend", "control", counters, nil));
    wait_for("ACK");

    id<MTLDevice> device = MTLCreateSystemDefaultDevice();
    if (device == nil) {
        events.emit(event_json("backend_failure", "control", counters, nil));
        return 4;
    }
    events.emit(event_json("post_backend", "control", counters, device));
    wait_for("START " + capability);

    std::vector<Resource> fixed_resources;
    fixed_resources.reserve(kFixedRungs.size());
    std::uint64_t ordinal = 0;
    for (const FixedRung & rung : kFixedRungs) {
        std::vector<Resource> current;
        current.emplace_back();
        ++ordinal;
        kern_return_t vm_result = KERN_SUCCESS;
        const bool metal = rung.domain == Domain::metal_shared;
        if (!allocate_resource(current.back(), rung.bytes, metal, ordinal, device, vm_result)) {
            events.emit(event_json("allocation_failure", rung.id, counters, device,
                                   rung.bytes, 0, ordinal, vm_result,
                                   metal ? "vm_allocate+newBufferWithBytesNoCopy" : "vm_allocate"));
            wait_for("STOP");
            return 4;
        }
        counters.resource_count += 1;
        if (metal) counters.metal_requested += rung.bytes;
        else counters.cpu_requested += rung.bytes;
        events.emit(event_json("post_reserve", rung.id, counters, device,
                               rung.bytes, 0, ordinal, vm_result,
                               metal ? "vm_allocate+newBufferWithBytesNoCopy" : "vm_allocate"));
        wait_for("ACK");
        touch_resources_guarded(current, rung.id, counters, device, events, false);
        events.emit(event_json("post_touch", rung.id, counters, device,
                               rung.bytes, rung.bytes, ordinal));
        wait_for("ACK");
        fixed_resources.push_back(std::move(current.back()));
    }

    std::vector<Resource> cache_resources;
    cache_resources.reserve(kMinimumHandleCount);
    for (std::size_t segment_index = 0; segment_index < kCacheSegments.size(); ++segment_index) {
        const CacheSegment & segment = kCacheSegments[segment_index];
        const std::size_t begin = cache_resources.size();
        for (std::uint32_t index = 0; index < segment.handle_count; ++index) {
            const std::uint64_t length = segment.base_length_bytes +
                (index < segment.large_handle_count ? 1ULL : 0ULL);
            cache_resources.emplace_back();
            ++ordinal;
            kern_return_t vm_result = KERN_SUCCESS;
            if (!allocate_resource(cache_resources.back(), length, true, ordinal, device, vm_result)) {
                events.emit(event_json("allocation_failure", "cache", counters, device,
                                       length, 0, ordinal, vm_result,
                                       "vm_allocate+newBufferWithBytesNoCopy"));
                wait_for("STOP");
                return 4;
            }
            counters.resource_count += 1;
            counters.metal_requested += length;
            counters.cache_requested += length;
        }
        events.emit(event_json("post_reserve", "cache", counters, device,
                               segment.payload_bytes, 0, ordinal, KERN_SUCCESS,
                               "vm_allocate+newBufferWithBytesNoCopy"));
        wait_for("ACK");
        std::vector<Resource> segment_resources;
        segment_resources.reserve(segment.handle_count);
        for (std::size_t index = begin; index < cache_resources.size(); ++index) {
            segment_resources.emplace_back(std::move(cache_resources[index]));
        }
        touch_resources_guarded(segment_resources, "cache", counters, device, events, true);
        for (std::size_t index = 0; index < segment_resources.size(); ++index) {
            cache_resources[begin + index] = std::move(segment_resources[index]);
        }
        events.emit(event_json("post_touch", "cache", counters, device,
                               segment.payload_bytes, segment.payload_bytes, ordinal));
        wait_for("ACK");
    }

    events.emit(event_json("target_touched", "cache", counters, device,
                           kCacheTargetBytes, kCacheTargetBytes, ordinal));
    wait_for("HOLD");
    std::this_thread::sleep_for(std::chrono::seconds(kFinalHoldSeconds));
    events.emit(event_json("hold_complete", "cache", counters, device,
                           kCacheTargetBytes, kCacheTargetBytes, ordinal));
    wait_for("RELEASE");

    cache_resources.clear();
    fixed_resources.clear();
    events.emit(event_json("released", "control", counters, device));
    wait_for("ACK");
    [device release];
    return 0;
}

}  // namespace

int main(int argc, char ** argv) {
    @autoreleasepool {
        try {
            return run_child(parse_options(argc, argv));
        } catch (const std::exception & error) {
            std::cerr << "h4-a0-ramp: " << error.what() << '\n';
            return 70;
        }
    }
}

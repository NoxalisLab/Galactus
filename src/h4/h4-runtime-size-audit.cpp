#include "h4-core.hpp"
#include "h4-profile.hpp"
#include "h4-reader.hpp"

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <pthread.h>
#include <stdexcept>

namespace {

constexpr std::uint32_t maximum_slot_count = 10'760;
constexpr std::uint32_t minimum_slot_count = 7'949;
constexpr std::uint32_t queue_depth_per_volume = 32;
constexpr std::uint64_t maximum_record_bytes = 13'172'736;
constexpr std::uint64_t quarter_gibibyte = 268'435'456;

struct ProposedCacheEntry {
    std::atomic<std::uint64_t> generation_id;
    std::atomic<std::uint64_t> last_use_stamp;
    std::atomic<std::uint32_t> pin_count;
    std::atomic<std::uint32_t> slot_index;
    std::atomic<std::uint32_t> state;
    std::uint16_t lru_previous;
    std::uint16_t lru_next;
};

struct ProposedSlotDescriptor {
    void * cpu_address;
    void * metal_buffer_handle;
    std::uint64_t length;
    std::uint32_t entry_index;
    std::uint32_t record_class;
    std::atomic<std::uint32_t> inflight_fragments;
    std::uint32_t reserved;
};

struct ProposedLayerLru {
    std::uint16_t head;
    std::uint16_t tail;
    std::uint32_t resident_count;
};

std::uint64_t checked_product(std::uint64_t left, std::uint64_t right) {
    if (left != 0 && right > UINT64_MAX / left) {
        throw std::overflow_error("size product overflow");
    }
    return left * right;
}

} // namespace

int main() {
    // Enregistrements et couches REELS du profil actif, pas la capacite
    // d'encodage des clefs.
    const auto & profile = galactus::h4::ModelProfile::active();
    const std::uint32_t layer_count = profile.layer_count();
    const std::uint32_t record_count = layer_count * profile.experts;

    const auto current_plan = galactus::h4::plan_ring(
        queue_depth_per_volume,
        maximum_record_bytes,
        galactus::h4::hard_ring_buffer_limit_bytes);
    const auto quarter_gib_plan = galactus::h4::plan_ring(
        queue_depth_per_volume,
        maximum_record_bytes,
        quarter_gibibyte);
    const auto p0_maximum_split = galactus::h4::plan_p0_split(
        maximum_record_bytes,
        galactus::h4::P0Profile::v2_7157_2843);

    const std::uint64_t current_reader_staging_bytes = checked_product(
        checked_product(current_plan.effective_queue_depth_per_volume, maximum_record_bytes), 2);
    const std::uint64_t per_volume_sized_staging_bytes = checked_product(
        queue_depth_per_volume,
        p0_maximum_split.internal_bytes + p0_maximum_split.external_bytes);

    pthread_attr_t attributes;
    if (pthread_attr_init(&attributes) != 0) {
        throw std::runtime_error("pthread_attr_init failed");
    }
    std::size_t default_thread_stack_bytes = 0;
    const int stack_result = pthread_attr_getstacksize(&attributes, &default_thread_stack_bytes);
    pthread_attr_destroy(&attributes);
    if (stack_result != 0) {
        throw std::runtime_error("pthread_attr_getstacksize failed");
    }

    const std::uint64_t entry_table_bytes = checked_product(record_count, sizeof(ProposedCacheEntry));
    const std::uint64_t maximum_slot_table_bytes = checked_product(
        maximum_slot_count, sizeof(ProposedSlotDescriptor));
    const std::uint64_t free_slot_stack_bytes = checked_product(maximum_slot_count, sizeof(std::uint32_t));
    const std::uint64_t layer_lru_bytes = checked_product(layer_count, sizeof(ProposedLayerLru));
    const std::uint64_t p0_layout_bytes = checked_product(record_count, sizeof(galactus::h4::P0RecordLocation));
    const std::uint64_t maximum_request_result_bytes = checked_product(
        queue_depth_per_volume * 2U,
        sizeof(galactus::h4::ReadRequest) + sizeof(galactus::h4::ReadResult));
    const std::uint64_t deterministic_metadata_bytes =
        entry_table_bytes + maximum_slot_table_bytes + free_slot_stack_bytes +
        layer_lru_bytes + p0_layout_bytes + maximum_request_result_bytes;
    const std::uint64_t current_worker_stack_virtual_bytes = checked_product(
        queue_depth_per_volume * 2U, default_thread_stack_bytes);

    std::cout
        << "{\n"
        << "  \"schema\":\"galactus.h4-runtime-size-audit.v1\",\n"
        << "  \"scope\":\"sizeof and arithmetic only; no cache, thread, buffer, model, or Metal allocation\",\n"
        << "  \"constants\":{\n"
        << "    \"record_count\":" << record_count << ",\n"
        << "    \"minimum_slot_count\":" << minimum_slot_count << ",\n"
        << "    \"maximum_slot_count\":" << maximum_slot_count << ",\n"
        << "    \"queue_depth_per_volume\":" << queue_depth_per_volume << ",\n"
        << "    \"maximum_record_bytes\":" << maximum_record_bytes << "\n"
        << "  },\n"
        << "  \"sizeof_bytes\":{\n"
        << "    \"proposed_cache_entry\":" << sizeof(ProposedCacheEntry) << ",\n"
        << "    \"proposed_slot_descriptor\":" << sizeof(ProposedSlotDescriptor) << ",\n"
        << "    \"proposed_layer_lru\":" << sizeof(ProposedLayerLru) << ",\n"
        << "    \"p0_record_location\":" << sizeof(galactus::h4::P0RecordLocation) << ",\n"
        << "    \"p1_record_location\":" << sizeof(galactus::h4::P1RecordLocation) << ",\n"
        << "    \"read_request\":" << sizeof(galactus::h4::ReadRequest) << ",\n"
        << "    \"read_result\":" << sizeof(galactus::h4::ReadResult) << ",\n"
        << "    \"default_pthread_stack\":" << default_thread_stack_bytes << "\n"
        << "  },\n"
        << "  \"deterministic_metadata_majorant\":{\n"
        << "    \"direct_entry_table_bytes\":" << entry_table_bytes << ",\n"
        << "    \"maximum_slot_table_bytes\":" << maximum_slot_table_bytes << ",\n"
        << "    \"free_slot_stack_bytes\":" << free_slot_stack_bytes << ",\n"
        << "    \"layer_lru_bytes\":" << layer_lru_bytes << ",\n"
        << "    \"p0_layout_bytes\":" << p0_layout_bytes << ",\n"
        << "    \"maximum_request_result_bytes\":" << maximum_request_result_bytes << ",\n"
        << "    \"subtotal_bytes\":" << deterministic_metadata_bytes << ",\n"
        << "    \"hash_index_required\":false,\n"
        << "    \"reason\":\"the key domain maps directly to (layer-first_layer)*experts+expert\"\n"
        << "  },\n"
        << "  \"current_reader_qd32\":{\n"
        << "    \"effective_queue_depth_per_volume\":" << current_plan.effective_queue_depth_per_volume << ",\n"
        << "    \"touched_staging_bytes\":" << current_reader_staging_bytes << ",\n"
        << "    \"worker_threads\":" << queue_depth_per_volume * 2U << ",\n"
        << "    \"worker_stack_virtual_upper_bytes\":" << current_worker_stack_virtual_bytes << ",\n"
        << "    \"implementation_evidence\":\"one max-record AlignedBuffer per worker and volume; constructor memset touches each buffer\"\n"
        << "  },\n"
        << "  \"per_volume_sized_qd32_candidate\":{\n"
        << "    \"maximum_internal_fragment_bytes\":" << p0_maximum_split.internal_bytes << ",\n"
        << "    \"maximum_external_fragment_bytes\":" << p0_maximum_split.external_bytes << ",\n"
        << "    \"staging_bytes\":" << per_volume_sized_staging_bytes << "\n"
        << "  },\n"
        << "  \"quarter_gibibyte_candidate\":{\n"
        << "    \"configured_bytes\":" << quarter_gibibyte << ",\n"
        << "    \"effective_queue_depth_per_volume_with_current_reader\":"
        << quarter_gib_plan.effective_queue_depth_per_volume << ",\n"
        << "    \"inflight_payload_bytes\":" << quarter_gib_plan.maximum_inflight_payload_bytes << ",\n"
        << "    \"qd32_claim_valid\":false\n"
        << "  },\n"
        << "  \"direct_in_place_candidate\":{\n"
        << "    \"separate_staging_payload_bytes\":0,\n"
        << "    \"p0_two_fragments_can_target_non_overlapping_slot_ranges\":true,\n"
        << "    \"required_publication_rule\":\"slot remains loading and unavailable to Metal until both volume completions succeed; release publication precedes graph pin\",\n"
        << "    \"metal_resource_overhead_measured\":false,\n"
        << "    \"cpu_gpu_synchronization_qualified\":false\n"
        << "  }\n"
        << "}\n";
}

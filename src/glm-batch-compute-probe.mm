#include "ggml-backend.h"
#include "ggml-alloc.h"
#include "ggml-cpp.h"
#include "ggml.h"

#import <Metal/Metal.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <memory>
#include <numeric>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include <unistd.h>

namespace {

constexpr int64_t N_EMBD = 6144;
constexpr int64_t N_FF_EXPERT = 2048;
constexpr int64_t N_FF_SHARED = 2048;
constexpr int64_t N_EXPERT_USED = 8;
constexpr int64_t N_HEAD = 64;
constexpr int64_t Q_LORA = 2048;
constexpr int64_t KV_LORA = 512;
constexpr int64_t QK_NOPE = 192;
constexpr int64_t QK_ROPE = 64;
constexpr int64_t V_HEAD = 256;
constexpr int64_t MLA_QK = KV_LORA + QK_ROPE;
constexpr int64_t N_CTX = 4096;
constexpr int ROUTED_LAYERS = 75;
constexpr int POOL_SIZE = 8;
constexpr size_t CONTEXT_BYTES = 256ULL * 1024ULL * 1024ULL;
constexpr size_t GRAPH_CAPACITY = 16384;
constexpr size_t SCHEDULER_GRAPH_SIZE = 2 * GRAPH_CAPACITY + 64;
constexpr int B2R_RESERVE_REPEATS = 3;
constexpr std::array<int, 2> B2_BATCH_SIZES{1, 2};
constexpr std::array<int, 4> FULL_BATCH_SIZES{1, 2, 4, 8};

struct Options {
    std::string rung;
    std::string output;
    uint64_t expected_context_alloc_bytes = 0;
    uint64_t expected_maximum_reserve_bytes = 0;
};

struct ExpertClass {
    char name;
    ggml_type gate_up_type;
    ggml_type down_type;
};

constexpr ExpertClass CLASS_A{'A', GGML_TYPE_IQ1_S, GGML_TYPE_IQ3_XXS};
constexpr ExpertClass CLASS_B{'B', GGML_TYPE_IQ2_XXS, GGML_TYPE_IQ3_XXS};
constexpr ExpertClass CLASS_C{'C', GGML_TYPE_IQ2_XXS, GGML_TYPE_IQ4_XS};

struct ExpertBundle {
    ggml_tensor * gate;
    ggml_tensor * up;
    ggml_tensor * down;
};

struct SharedBundle {
    ggml_tensor * gate;
    ggml_tensor * up;
    ggml_tensor * down;
};

struct AttentionBundle {
    ggml_tensor * wq_a;
    ggml_tensor * wq_b;
    ggml_tensor * wkv_a;
    ggml_tensor * wk_b;
    ggml_tensor * wv_b;
    ggml_tensor * wo;
};

struct InitializedTensor {
    ggml_tensor * tensor;
    uint32_t seed;
    bool zero;
};

struct Timing {
    std::vector<double> samples_ms;
    double p50_ms = 0.0;
    double p95_ms = 0.0;
};

enum class ChainKind {
    full,
    attention,
    routed,
    shared,
    combined_ffn,
};

struct GraphCase {
    int batch_size;
    ggml_tensor * input;
    ggml_tensor * ids;
    ggml_tensor * full_root;
    ggml_cgraph * full;
    ggml_cgraph * attention;
    ggml_cgraph * routed;
    ggml_cgraph * shared;
    ggml_cgraph * combined_ffn;
    size_t reserve_bytes = 0;
    Timing full_timing;
    Timing attention_timing;
    Timing routed_timing;
    Timing shared_timing;
    Timing combined_ffn_timing;
    float checksum = 0.0f;
};

struct ReserveCaseMeasurement {
    int batch_size;
    int nodes;
    size_t graph_capacity;
    size_t reserve_bytes;
};

struct ReserveRepeatMeasurement {
    int repeat_index;
    uint64_t before_scheduler;
    uint64_t after_scheduler;
    uint64_t after_reserve;
    uint64_t after_context_sizing;
    uint64_t after_scheduler_free;
    size_t context_alloc_bytes;
    std::vector<ReserveCaseMeasurement> cases;
};

struct SchedulerDeleter {
    void operator()(ggml_backend_sched_t scheduler) const {
        if (scheduler != nullptr) {
            ggml_backend_sched_free(scheduler);
        }
    }
};

using scheduler_ptr = std::unique_ptr<ggml_backend_sched, SchedulerDeleter>;

Options parse_options(int argc, char ** argv) {
    Options options;
    for (int index = 1; index < argc; ++index) {
        const std::string argument = argv[index];
        auto value = [&]() -> std::string {
            if (++index >= argc) {
                throw std::runtime_error("missing value for " + argument);
            }
            return argv[index];
        };
        if (argument == "--rung") {
            options.rung = value();
        } else if (argument == "--output") {
            options.output = value();
        } else if (argument == "--expected-context-alloc-bytes") {
            options.expected_context_alloc_bytes = std::stoull(value());
        } else if (argument == "--expected-maximum-reserve-bytes") {
            options.expected_maximum_reserve_bytes = std::stoull(value());
        } else {
            throw std::runtime_error("unknown argument: " + argument);
        }
    }
    if (options.rung != "b2r" && options.rung != "b2" &&
        options.rung != "b3" && options.rung != "b4") {
        throw std::runtime_error("--rung must be b2r, b2, b3, or b4");
    }
    if (options.output.empty()) {
        throw std::runtime_error("--output is required");
    }
    if (options.rung == "b2r" &&
        (options.expected_context_alloc_bytes != 0 ||
         options.expected_maximum_reserve_bytes != 0)) {
        throw std::runtime_error("b2r forbids expected sizing arguments");
    }
    if (options.rung != "b2r" &&
        (options.expected_context_alloc_bytes == 0 ||
         options.expected_maximum_reserve_bytes == 0)) {
        throw std::runtime_error("compute rungs require both expected sizing arguments");
    }
    return options;
}

const ExpertClass & layer_class(int layer) {
    static constexpr std::array<int, 18> class_b = {
        6, 9, 29, 39, 40, 41, 42, 43, 44,
        45, 46, 47, 48, 68, 70, 72, 73, 74,
    };
    static constexpr std::array<int, 4> class_c = {8, 75, 76, 77};
    if (std::find(class_c.begin(), class_c.end(), layer) != class_c.end()) {
        return CLASS_C;
    }
    if (std::find(class_b.begin(), class_b.end(), layer) != class_b.end()) {
        return CLASS_B;
    }
    return CLASS_A;
}

ggml_tensor * new_quant_2d(
    ggml_context * context,
    ggml_type type,
    int64_t ne0,
    int64_t ne1,
    std::vector<InitializedTensor> & initialized,
    uint32_t seed) {
    auto * tensor = ggml_new_tensor_2d(context, type, ne0, ne1);
    initialized.push_back({tensor, seed, false});
    return tensor;
}

ggml_tensor * new_quant_3d(
    ggml_context * context,
    ggml_type type,
    int64_t ne0,
    int64_t ne1,
    int64_t ne2,
    std::vector<InitializedTensor> & initialized,
    uint32_t seed) {
    auto * tensor = ggml_new_tensor_3d(context, type, ne0, ne1, ne2);
    initialized.push_back({tensor, seed, false});
    return tensor;
}

ExpertBundle new_expert_bundle(
    ggml_context * context,
    const ExpertClass & type,
    std::vector<InitializedTensor> & initialized,
    uint32_t seed) {
    return {
        new_quant_3d(context, type.gate_up_type, N_EMBD, N_FF_EXPERT,
                     N_EXPERT_USED, initialized, seed + 1),
        new_quant_3d(context, type.gate_up_type, N_EMBD, N_FF_EXPERT,
                     N_EXPERT_USED, initialized, seed + 2),
        new_quant_3d(context, type.down_type, N_FF_EXPERT, N_EMBD,
                     N_EXPERT_USED, initialized, seed + 3),
    };
}

SharedBundle new_shared_bundle(
    ggml_context * context,
    std::vector<InitializedTensor> & initialized,
    uint32_t seed) {
    return {
        new_quant_2d(context, GGML_TYPE_Q5_K, N_EMBD, N_FF_SHARED,
                     initialized, seed + 1),
        new_quant_2d(context, GGML_TYPE_Q5_K, N_EMBD, N_FF_SHARED,
                     initialized, seed + 2),
        new_quant_2d(context, GGML_TYPE_Q6_K, N_FF_SHARED, N_EMBD,
                     initialized, seed + 3),
    };
}

AttentionBundle new_attention_bundle(
    ggml_context * context,
    std::vector<InitializedTensor> & initialized,
    uint32_t seed) {
    return {
        new_quant_2d(context, GGML_TYPE_Q5_K, N_EMBD, Q_LORA,
                     initialized, seed + 1),
        new_quant_2d(context, GGML_TYPE_Q8_0, Q_LORA,
                     (QK_NOPE + QK_ROPE) * N_HEAD, initialized, seed + 2),
        new_quant_2d(context, GGML_TYPE_Q8_0, N_EMBD, MLA_QK,
                     initialized, seed + 3),
        new_quant_3d(context, GGML_TYPE_Q8_0, QK_NOPE, KV_LORA, N_HEAD,
                     initialized, seed + 4),
        new_quant_3d(context, GGML_TYPE_Q8_0, KV_LORA, V_HEAD, N_HEAD,
                     initialized, seed + 5),
        new_quant_2d(context, GGML_TYPE_Q5_K, V_HEAD * N_HEAD, N_EMBD,
                     initialized, seed + 6),
    };
}

ggml_tensor * checked_mul_mat(
    ggml_context * context,
    ggml_tensor * weights,
    ggml_tensor * input,
    const char * name) {
    const bool compatible = weights->ne[0] == input->ne[0]
        && input->ne[2] % weights->ne[2] == 0
        && input->ne[3] % weights->ne[3] == 0;
    if (!compatible) {
        throw std::runtime_error(std::string("incompatible multiply: ") + name);
    }
    return ggml_mul_mat(context, weights, input);
}

ggml_tensor * build_moe(
    ggml_context * context,
    const ExpertBundle & bundle,
    ggml_tensor * ids,
    ggml_tensor * input,
    int batch_size) {
    auto * current = ggml_reshape_3d(context, input, N_EMBD, 1, batch_size);
    auto * gate = ggml_mul_mat_id(context, bundle.gate, current, ids);
    auto * up = ggml_mul_mat_id(context, bundle.up, current, ids);
    auto * activated = ggml_swiglu_split(context, gate, up);
    auto * experts = ggml_mul_mat_id(context, bundle.down, activated, ids);
    auto * output = ggml_view_2d(
        context, experts, N_EMBD, batch_size, experts->nb[2], 0);
    for (int expert = 1; expert < N_EXPERT_USED; ++expert) {
        auto * lane = ggml_view_2d(
            context, experts, N_EMBD, batch_size, experts->nb[2],
            static_cast<size_t>(expert) * experts->nb[1]);
        output = ggml_add(context, output, lane);
    }
    return output;
}

ggml_tensor * build_shared(
    ggml_context * context,
    const SharedBundle & bundle,
    ggml_tensor * input) {
    auto * gate = checked_mul_mat(context, bundle.gate, input, "shared.gate");
    auto * up = checked_mul_mat(context, bundle.up, input, "shared.up");
    auto * activated = ggml_swiglu_split(context, gate, up);
    return checked_mul_mat(context, bundle.down, activated, "shared.down");
}

ggml_tensor * build_attention(
    ggml_context * context,
    const AttentionBundle & bundle,
    ggml_tensor * k_cache,
    ggml_tensor * input,
    int batch_size) {
    auto * q_a = checked_mul_mat(context, bundle.wq_a, input, "attention.wq_a");
    auto * q = checked_mul_mat(context, bundle.wq_b, q_a, "attention.wq_b");
    q = ggml_reshape_3d(context, q, QK_NOPE + QK_ROPE, N_HEAD, batch_size);
    auto * q_nope = ggml_view_3d(
        context, q, QK_NOPE, N_HEAD, batch_size, q->nb[1], q->nb[2], 0);
    auto * q_rope = ggml_view_3d(
        context, q, QK_ROPE, N_HEAD, batch_size, q->nb[1], q->nb[2],
        QK_NOPE * q->nb[0]);

    auto * kv_current = checked_mul_mat(
        context, bundle.wkv_a, input, "attention.wkv_a");
    auto * k_rope = ggml_view_3d(
        context, kv_current, QK_ROPE, 1, batch_size,
        kv_current->nb[1], kv_current->nb[1], KV_LORA * kv_current->nb[0]);
    q_rope = ggml_add(context, q_rope, k_rope);

    q_nope = ggml_permute(context, q_nope, 0, 2, 1, 3);
    auto * q_absorbed = checked_mul_mat(
        context, bundle.wk_b, q_nope, "attention.wk_b");
    q_rope = ggml_permute(context, q_rope, 0, 2, 1, 3);
    auto * q_mla = ggml_concat(context, q_absorbed, q_rope, 0);

    auto * v_cache = ggml_view_3d(
        context, k_cache, KV_LORA, N_CTX, 1, k_cache->nb[1], k_cache->nb[2], 0);
    auto * attended = ggml_flash_attn_ext(
        context, q_mla, k_cache, v_cache, nullptr,
        1.0f / std::sqrt(static_cast<float>(MLA_QK)), 0.0f, 0.0f);
    ggml_flash_attn_ext_set_prec(attended, GGML_PREC_F32);
    attended = ggml_permute(context, attended, 0, 2, 1, 3);
    auto * value_heads = checked_mul_mat(
        context, bundle.wv_b, attended, "attention.wv_b");
    value_heads = ggml_permute(context, value_heads, 0, 2, 1, 3);
    value_heads = ggml_cont(context, value_heads);
    auto * value_flat = ggml_reshape_2d(
        context, value_heads, V_HEAD * N_HEAD, batch_size);
    return checked_mul_mat(context, bundle.wo, value_flat, "attention.wo");
}

const ExpertBundle & expert_for_layer(
    int layer,
    int pool,
    const std::vector<ExpertBundle> & experts_a,
    const std::vector<ExpertBundle> & experts_b,
    const std::vector<ExpertBundle> & experts_c) {
    const auto & type = layer_class(layer);
    if (type.name == 'A') {
        return experts_a.at(static_cast<size_t>(pool));
    }
    if (type.name == 'B') {
        return experts_b.at(static_cast<size_t>(pool));
    }
    return experts_c.at(static_cast<size_t>(pool));
}

ggml_tensor * build_chain(
    ggml_context * context,
    ChainKind kind,
    int batch_size,
    const std::vector<ExpertBundle> & experts_a,
    const std::vector<ExpertBundle> & experts_b,
    const std::vector<ExpertBundle> & experts_c,
    const std::vector<SharedBundle> & shared,
    const std::vector<AttentionBundle> & attention,
    ggml_tensor * k_cache,
    ggml_tensor * ids,
    ggml_tensor * input) {
    ggml_tensor * current = input;
    for (int offset = 0; offset < ROUTED_LAYERS; ++offset) {
        const int layer = 3 + offset;
        const int pool = offset % POOL_SIZE;
        const auto & expert = expert_for_layer(
            layer, pool, experts_a, experts_b, experts_c);
        if (kind == ChainKind::full || kind == ChainKind::attention) {
            auto * attention_output = build_attention(
                context, attention.at(static_cast<size_t>(pool)), k_cache,
                current, batch_size);
            current = ggml_add(context, current, attention_output);
        }
        if (kind == ChainKind::full || kind == ChainKind::combined_ffn) {
            auto * routed_output = build_moe(
                context, expert, ids, current, batch_size);
            auto * shared_output = build_shared(
                context, shared.at(static_cast<size_t>(pool)), current);
            current = ggml_add(context, current, routed_output);
            current = ggml_add(context, current, shared_output);
        } else if (kind == ChainKind::routed) {
            current = ggml_add(
                context, current, build_moe(context, expert, ids, current, batch_size));
        } else if (kind == ChainKind::shared) {
            current = ggml_add(
                context, current,
                build_shared(context, shared.at(static_cast<size_t>(pool)), current));
        }
    }
    return current;
}

ggml_cgraph * graph_for(ggml_context * context, ggml_tensor * output) {
    auto * graph = ggml_new_graph_custom(context, GRAPH_CAPACITY, false);
    ggml_build_forward_expand(graph, output);
    return graph;
}

void initialize_quantized(ggml_tensor * tensor, uint32_t seed) {
    const int64_t row_elements = tensor->ne[0];
    const int64_t rows = ggml_nrows(tensor);
    std::vector<float> source(static_cast<size_t>(row_elements));
    std::vector<float> imatrix(static_cast<size_t>(row_elements), 1.0f);
    for (int64_t index = 0; index < row_elements; ++index) {
        const double phase = static_cast<double>((index + 1) * (seed + 17U));
        source.at(static_cast<size_t>(index)) =
            static_cast<float>(0.01 * std::sin(phase * 0.00037));
    }
    const size_t row_bytes = ggml_row_size(tensor->type, row_elements);
    std::vector<uint8_t> quantized(row_bytes);
    const float * importance = ggml_quantize_requires_imatrix(tensor->type)
        ? imatrix.data() : nullptr;
    const size_t produced = ggml_quantize_chunk(
        tensor->type, source.data(), quantized.data(), 0, 1,
        row_elements, importance);
    if (produced != row_bytes) {
        throw std::runtime_error("quantized row size mismatch");
    }
    constexpr size_t TARGET_CHUNK = 1024 * 1024;
    const size_t rows_per_chunk = std::max<size_t>(1, TARGET_CHUNK / row_bytes);
    std::vector<uint8_t> chunk(rows_per_chunk * row_bytes);
    for (size_t row = 0; row < rows_per_chunk; ++row) {
        std::copy(quantized.begin(), quantized.end(), chunk.begin() + row * row_bytes);
    }
    int64_t written_rows = 0;
    while (written_rows < rows) {
        const size_t current_rows = static_cast<size_t>(std::min<int64_t>(
            rows - written_rows, static_cast<int64_t>(rows_per_chunk)));
        ggml_backend_tensor_set(
            tensor, chunk.data(), static_cast<size_t>(written_rows) * row_bytes,
            current_rows * row_bytes);
        written_rows += static_cast<int64_t>(current_rows);
    }
}

void initialize_zero(ggml_tensor * tensor) {
    constexpr size_t CHUNK_BYTES = 1024 * 1024;
    std::vector<uint8_t> zeros(CHUNK_BYTES, 0);
    size_t offset = 0;
    const size_t total = ggml_nbytes(tensor);
    while (offset < total) {
        const size_t count = std::min(CHUNK_BYTES, total - offset);
        ggml_backend_tensor_set(tensor, zeros.data(), offset, count);
        offset += count;
    }
}

double percentile(std::vector<double> values, double quantile) {
    std::sort(values.begin(), values.end());
    const size_t index = static_cast<size_t>(
        std::ceil(quantile * static_cast<double>(values.size())) - 1.0);
    return values.at(std::min(index, values.size() - 1));
}

uint64_t current_allocated_bytes(id<MTLDevice> device) {
    return static_cast<uint64_t>(device.currentAllocatedSize);
}

Timing time_graph(
    ggml_backend_t backend,
    ggml_cgraph * graph,
    int warmup,
    int repetitions,
    id<MTLDevice> device,
    uint64_t & maximum_observed_metal_bytes) {
    auto run_once = [&]() -> double {
        const auto start = std::chrono::steady_clock::now();
        const auto status = ggml_backend_graph_compute(backend, graph);
        const auto end = std::chrono::steady_clock::now();
        if (status != GGML_STATUS_SUCCESS) {
            throw std::runtime_error(
                std::string("graph failed: ") + ggml_status_to_string(status));
        }
        const uint64_t allocated = current_allocated_bytes(device);
        maximum_observed_metal_bytes = std::max(maximum_observed_metal_bytes, allocated);
        return std::chrono::duration<double, std::milli>(end - start).count();
    };
    for (int index = 0; index < warmup; ++index) {
        static_cast<void>(run_once());
    }
    std::vector<double> samples;
    samples.reserve(static_cast<size_t>(repetitions));
    for (int index = 0; index < repetitions; ++index) {
        samples.push_back(run_once());
    }
    return {samples, percentile(samples, 0.50), percentile(samples, 0.95)};
}

void write_timing(std::ostream & output, const Timing & timing, int indent) {
    const std::string space(static_cast<size_t>(indent), ' ');
    output << "{\n" << space << "  \"samples_ms\": [";
    for (size_t index = 0; index < timing.samples_ms.size(); ++index) {
        output << (index == 0 ? "" : ", ") << timing.samples_ms.at(index);
    }
    output << "],\n" << space << "  \"p50_ms\": " << timing.p50_ms
           << ",\n" << space << "  \"p95_ms\": " << timing.p95_ms
           << "\n" << space << "}";
}

void write_preallocation_refusal(
    const Options & options,
    uint64_t before_backend,
    uint64_t before_scheduler,
    uint64_t after_scheduler,
    uint64_t after_no_alloc_sizing,
    const std::string & status,
    const std::vector<GraphCase> & cases,
    size_t maximum_reserve_bytes) {
    std::ofstream output(options.output, std::ios::out | std::ios::trunc);
    if (!output) {
        throw std::runtime_error("cannot open refusal output");
    }
    output << "{\n"
           << "  \"schema\": \"galactus.h4-batch-compute-probe.v1\",\n"
           << "  \"status\": \"" << status << "\",\n"
           << "  \"rung\": \"" << options.rung << "\",\n"
           << "  \"graph_compute_executed\": false,\n"
           << "  \"metal_current_allocated_before_backend\": " << before_backend << ",\n"
           << "  \"metal_current_allocated_before_scheduler\": " << before_scheduler << ",\n"
           << "  \"metal_current_allocated_after_scheduler\": " << after_scheduler << ",\n"
           << "  \"metal_current_allocated_after_no_alloc_sizing\": "
           << after_no_alloc_sizing << ",\n"
           << "  \"maximum_reserve_bytes\": " << maximum_reserve_bytes << ",\n"
           << "  \"expected_maximum_reserve_bytes\": "
           << options.expected_maximum_reserve_bytes << ",\n"
           << "  \"reserve_bytes_by_k\": {";
    for (size_t index = 0; index < cases.size(); ++index) {
        const auto & item = cases.at(index);
        output << (index == 0 ? "" : ", ") << "\"" << item.batch_size
               << "\": " << item.reserve_bytes;
    }
    output << "}\n}\n";
}

void write_result(
    const Options & options,
    int warmup,
    int repetitions,
    uint64_t before_backend,
    uint64_t before_scheduler,
    uint64_t after_scheduler,
    uint64_t after_reserve,
    uint64_t before_allocation,
    uint64_t after_allocation,
    uint64_t after_initialization,
    uint64_t maximum_observed_metal_bytes,
    size_t allocated_buffer_bytes,
    const std::string & context_buffer_type,
    uint64_t system_page_size_bytes,
    size_t context_buffer_max_size_bytes,
    const std::vector<GraphCase> & cases) {
    const double baseline_ms = cases.front().full_timing.p50_ms;
    const size_t baseline_reserve = cases.front().reserve_bytes;
    size_t maximum_reserve_bytes = 0;
    for (const auto & item : cases) {
        maximum_reserve_bytes = std::max(maximum_reserve_bytes, item.reserve_bytes);
    }
    std::ofstream output(options.output, std::ios::out | std::ios::trunc);
    if (!output) {
        throw std::runtime_error("cannot open output: " + options.output);
    }
    output << std::fixed << std::setprecision(9);
    output << "{\n"
           << "  \"schema\": \"galactus.h4-batch-compute-probe.v1\",\n"
           << "  \"status\": \"measurement-complete\",\n"
           << "  \"rung\": \"" << options.rung << "\",\n"
           << "  \"scope\": \"same8-lower-bound fixed-kv-optimistic\",\n"
           << "  \"backend\": \"Metal-only scheduler and compute\",\n"
           << "  \"context_buffer_type\": \"" << context_buffer_type << "\",\n"
           << "  \"system_page_size_bytes\": " << system_page_size_bytes << ",\n"
           << "  \"context_buffer_max_size_bytes\": "
           << context_buffer_max_size_bytes << ",\n"
           << "  \"context_fits_single_buffer\": "
           << (allocated_buffer_bytes <= context_buffer_max_size_bytes
                   ? "true" : "false") << ",\n"
           << "  \"warmup\": " << warmup << ",\n"
           << "  \"repetitions\": " << repetitions << ",\n"
           << "  \"expected_context_alloc_bytes\": "
           << options.expected_context_alloc_bytes << ",\n"
           << "  \"expected_maximum_reserve_bytes\": "
           << options.expected_maximum_reserve_bytes << ",\n"
           << "  \"maximum_reserve_bytes\": " << maximum_reserve_bytes << ",\n"
           << "  \"context_alloc_matches_expected\": "
           << (allocated_buffer_bytes == options.expected_context_alloc_bytes
                   ? "true" : "false") << ",\n"
           << "  \"maximum_reserve_matches_expected\": "
           << (maximum_reserve_bytes == options.expected_maximum_reserve_bytes
                   ? "true" : "false") << ",\n"
           << "  \"metal_current_allocated_bytes\": {\n"
           << "    \"before_backend_init\": " << before_backend << ",\n"
           << "    \"before_scheduler_new\": " << before_scheduler << ",\n"
           << "    \"after_scheduler_new\": " << after_scheduler << ",\n"
           << "    \"after_all_reserve_size\": " << after_reserve << ",\n"
           << "    \"delta_scheduler_and_reserve\": "
           << static_cast<int64_t>(after_reserve)
                - static_cast<int64_t>(before_scheduler) << ",\n"
           << "    \"before_tensor_allocation\": " << before_allocation << ",\n"
           << "    \"after_tensor_allocation\": " << after_allocation << ",\n"
           << "    \"after_tensor_initialization\": " << after_initialization << ",\n"
           << "    \"maximum_observed_after_synchronized_submissions\": "
           << maximum_observed_metal_bytes << "\n"
           << "  },\n"
           << "  \"allocated_context_buffer_bytes\": " << allocated_buffer_bytes << ",\n"
           << "  \"cases\": [\n";
    for (size_t index = 0; index < cases.size(); ++index) {
        const auto & item = cases.at(index);
        const double ratio = item.full_timing.p50_ms / baseline_ms;
        output << "    {\n"
               << "      \"k\": " << item.batch_size << ",\n"
               << "      \"input_shape\": [6144, " << item.batch_size << "],\n"
               << "      \"ids_shape\": [8, " << item.batch_size << "],\n"
               << "      \"nodes\": " << ggml_graph_n_nodes(item.full) << ",\n"
               << "      \"graph_capacity\": " << ggml_graph_size(item.full) << ",\n"
               << "      \"metal_reserve_bytes\": " << item.reserve_bytes << ",\n"
               << "      \"incremental_metal_reserve_bytes_vs_k1\": "
               << (item.reserve_bytes > baseline_reserve
                       ? item.reserve_bytes - baseline_reserve : 0) << ",\n"
               << "      \"full75\": ";
        write_timing(output, item.full_timing, 6);
        output << ",\n      \"attention75\": ";
        write_timing(output, item.attention_timing, 6);
        output << ",\n      \"routed75\": ";
        write_timing(output, item.routed_timing, 6);
        output << ",\n      \"shared75\": ";
        write_timing(output, item.shared_timing, 6);
        output << ",\n      \"combined_ffn75\": ";
        write_timing(output, item.combined_ffn_timing, 6);
        output << ",\n      \"R_k\": " << ratio << ",\n"
               << "      \"beta_k\": ";
        if (item.batch_size == 1) {
            output << "null";
        } else {
            output << (ratio - 1.0) / static_cast<double>(item.batch_size - 1);
        }
        output << ",\n      \"checksum\": " << item.checksum << "\n"
               << "    }" << (index + 1 == cases.size() ? "\n" : ",\n");
    }
    output << "  ],\n"
           << "  \"limits\": {\n"
           << "    \"same8_is_optimistic_weight_reuse_lower_bound\": true,\n"
           << "    \"causal_kv_exact\": false,\n"
           << "    \"distinct_lanes_executed\": false,\n"
           << "    \"checkpoint_or_pack_read\": false,\n"
           << "    \"measures_acceptance_or_draft_cost\": false,\n"
           << "    \"maximum_observed_is_not_a_transient_metal_peak\": true,\n"
           << "    \"pointwise_metal_ceiling_enforced\": false,\n"
           << "    \"physical_safety_enforced_by_external_continuous_guard\": true,\n"
           << "    \"not_an_end_to_end_throughput_claim\": true\n"
           << "  }\n"
           << "}\n";
    if (!output) {
        throw std::runtime_error("failed while writing output");
    }
}

void write_postallocation_refusal(
    const Options & options,
    const std::string & status,
    size_t allocated_buffer_bytes,
    uint64_t current_allocated,
    const std::vector<GraphCase> & cases) {
    std::ofstream output(options.output, std::ios::out | std::ios::trunc);
    if (!output) {
        throw std::runtime_error("cannot open post-allocation refusal output");
    }
    output << "{\n"
           << "  \"schema\": \"galactus.h4-batch-compute-probe.v1\",\n"
           << "  \"status\": \"" << status << "\",\n"
           << "  \"rung\": \"" << options.rung << "\",\n"
           << "  \"graph_compute_executed\": false,\n"
           << "  \"allocated_context_buffer_bytes\": " << allocated_buffer_bytes << ",\n"
           << "  \"metal_current_allocated_bytes\": " << current_allocated << ",\n"
           << "  \"expected_context_alloc_bytes\": "
           << options.expected_context_alloc_bytes << ",\n"
           << "  \"expected_maximum_reserve_bytes\": "
           << options.expected_maximum_reserve_bytes << ",\n"
           << "  \"reserve_bytes_by_k\": {";
    for (size_t index = 0; index < cases.size(); ++index) {
        const auto & item = cases.at(index);
        output << (index == 0 ? "" : ", ") << "\"" << item.batch_size
               << "\": " << item.reserve_bytes;
    }
    output << "}\n}\n";
}

void write_reserve_only_result(
    const Options & options,
    uint64_t before_backend,
    const std::string & context_buffer_type,
    uint64_t system_page_size_bytes,
    size_t context_buffer_max_size_bytes,
    const std::vector<ReserveRepeatMeasurement> & repeats) {
    std::ofstream output(options.output, std::ios::out | std::ios::trunc);
    if (!output) {
        throw std::runtime_error("cannot open reserve-only output");
    }

    if (repeats.empty() || repeats.front().cases.empty()) {
        throw std::runtime_error("reserve-only result has no measurements");
    }
    bool all_repeat_vectors_identical = true;
    bool all_context_alloc_bytes_identical = true;
    std::vector<ReserveCaseMeasurement> canonical = repeats.front().cases;
    size_t canonical_context_alloc_bytes = repeats.front().context_alloc_bytes;
    for (const auto & repeat : repeats) {
        if (repeat.cases.size() != canonical.size()) {
            throw std::runtime_error("reserve-only repeat shape mismatch");
        }
        for (size_t index = 0; index < canonical.size(); ++index) {
            const auto & measured = repeat.cases.at(index);
            auto & selected = canonical.at(index);
            if (measured.batch_size != selected.batch_size) {
                throw std::runtime_error("reserve-only repeat batch mismatch");
            }
            if (measured.reserve_bytes != repeats.front().cases.at(index).reserve_bytes) {
                all_repeat_vectors_identical = false;
            }
            selected.reserve_bytes = std::max(selected.reserve_bytes, measured.reserve_bytes);
            selected.nodes = std::max(selected.nodes, measured.nodes);
            selected.graph_capacity = std::max(
                selected.graph_capacity, measured.graph_capacity);
        }
        if (repeat.context_alloc_bytes != repeats.front().context_alloc_bytes) {
            all_context_alloc_bytes_identical = false;
        }
        canonical_context_alloc_bytes = std::max(
            canonical_context_alloc_bytes, repeat.context_alloc_bytes);
    }

    output << "{\n"
           << "  \"schema\": \"galactus.h4-batch-compute-reserve-only.v3\",\n"
           << "  \"status\": \"valid-no-allocation\",\n"
           << "  \"rung\": \"" << options.rung << "\",\n"
           << "  \"scope\": \"same8-lower-bound fixed-kv-optimistic\",\n"
           << "  \"backend\": \"Metal-only scheduler\",\n"
           << "  \"context_buffer_type\": \"" << context_buffer_type << "\",\n"
           << "  \"system_page_size_bytes\": " << system_page_size_bytes << ",\n"
           << "  \"context_buffer_max_size_bytes\": "
           << context_buffer_max_size_bytes << ",\n"
           << "  \"buffer_creation_allowed\": false,\n"
           << "  \"tensor_initialization_executed\": false,\n"
           << "  \"graph_compute_executed\": false,\n"
           << "  \"metal_current_allocated_before_backend_init\": "
           << before_backend << ",\n"
           << "  \"allocated_buffer_count\": 0,\n"
           << "  \"reserve_repeat_count\": " << repeats.size() << ",\n"
           << "  \"fresh_scheduler_per_repeat\": true,\n"
           << "  \"all_repeat_vectors_identical\": "
           << (all_repeat_vectors_identical ? "true" : "false") << ",\n"
           << "  \"all_context_alloc_bytes_identical\": "
           << (all_context_alloc_bytes_identical ? "true" : "false") << ",\n"
           << "  \"reserve_canonical_rule\": "
           << "\"common vector if identical; per-k maximum otherwise\",\n"
           << "  \"context_alloc_canonical_rule\": "
           << "\"common value if identical; maximum otherwise\",\n"
           << "  \"repeats\": [\n";
    for (size_t repeat_index = 0; repeat_index < repeats.size(); ++repeat_index) {
        const auto & repeat = repeats.at(repeat_index);
        const size_t baseline = repeat.cases.front().reserve_bytes;
        output << "    {\n"
               << "      \"repeat_index\": " << repeat.repeat_index << ",\n"
               << "      \"metal_current_allocated_bytes\": {\n"
               << "        \"before_scheduler_new\": " << repeat.before_scheduler << ",\n"
               << "        \"after_scheduler_new\": " << repeat.after_scheduler << ",\n"
               << "        \"after_all_reserve_size\": " << repeat.after_reserve << ",\n"
               << "        \"after_context_alloc_size\": "
               << repeat.after_context_sizing << ",\n"
               << "        \"delta_scheduler_reserve_and_context_sizing\": "
               << static_cast<int64_t>(repeat.after_context_sizing)
                    - static_cast<int64_t>(repeat.before_scheduler) << ",\n"
               << "        \"after_scheduler_free\": "
               << repeat.after_scheduler_free << "\n"
               << "      },\n"
               << "      \"context_alloc_bytes\": "
               << repeat.context_alloc_bytes << ",\n"
               << "      \"cases\": [\n";
        for (size_t case_index = 0; case_index < repeat.cases.size(); ++case_index) {
            const auto & item = repeat.cases.at(case_index);
            output << "        {\"k\": " << item.batch_size
                   << ", \"nodes\": " << item.nodes
                   << ", \"graph_capacity\": " << item.graph_capacity
                   << ", \"metal_reserve_bytes\": " << item.reserve_bytes
                   << ", \"incremental_metal_reserve_bytes_vs_k1\": "
                   << (item.reserve_bytes > baseline ? item.reserve_bytes - baseline : 0)
                   << "}" << (case_index + 1 == repeat.cases.size() ? "\n" : ",\n");
        }
        output << "      ]\n"
               << "    }" << (repeat_index + 1 == repeats.size() ? "\n" : ",\n");
    }
    output << "  ],\n"
           << "  \"canonical_context_alloc_bytes\": "
           << canonical_context_alloc_bytes << ",\n"
           << "  \"canonical_context_fits_single_buffer\": "
           << (canonical_context_alloc_bytes <= context_buffer_max_size_bytes
                   ? "true" : "false") << ",\n"
           << "  \"single_buffer_physical_rounding_upper_bound_bytes\": ";
    if (canonical_context_alloc_bytes <= context_buffer_max_size_bytes) {
        output << system_page_size_bytes - 1;
    } else {
        output << "null";
    }
    output << ",\n"
           << "  \"multi_buffer_physical_rounding_bound_requires_buffer_count\": "
           << (canonical_context_alloc_bytes > context_buffer_max_size_bytes
                   ? "true" : "false") << ",\n"
           << "  \"canonical_cases\": [\n";
    const size_t canonical_baseline = canonical.front().reserve_bytes;
    for (size_t index = 0; index < canonical.size(); ++index) {
        const auto & item = canonical.at(index);
        output << "    {\"k\": " << item.batch_size
               << ", \"nodes\": " << item.nodes
               << ", \"graph_capacity\": " << item.graph_capacity
               << ", \"metal_reserve_bytes\": " << item.reserve_bytes
               << ", \"incremental_metal_reserve_bytes_vs_k1\": "
               << (item.reserve_bytes > canonical_baseline
                       ? item.reserve_bytes - canonical_baseline : 0)
               << "}" << (index + 1 == canonical.size() ? "\n" : ",\n");
    }
    output << "  ],\n"
           << "  \"limits\": {\n"
           << "    \"compute_expected_sizing_requires_separate_countersignature\": true,\n"
           << "    \"context_sizing_allocates_backend_buffer\": false,\n"
           << "    \"pointwise_metal_ceiling_enforced\": false,\n"
           << "    \"physical_safety_enforced_by_external_continuous_guard\": true,\n"
           << "    \"distinct_lanes_executed\": false,\n"
           << "    \"checkpoint_or_pack_read\": false\n"
           << "  }\n"
           << "}\n";
    if (!output) {
        throw std::runtime_error("failed while writing reserve-only output");
    }
}

} // namespace

int main(int argc, char ** argv) {
    try {
        const Options options = parse_options(argc, argv);
        const bool reserve_only = options.rung == "b2r";
        const bool smoke = reserve_only || options.rung == "b2";
        const int warmup = smoke ? 1 : 2;
        const int repetitions = smoke ? 1 : 7;
        const std::vector<int> batch_sizes = smoke
            ? std::vector<int>(B2_BATCH_SIZES.begin(), B2_BATCH_SIZES.end())
            : std::vector<int>(FULL_BATCH_SIZES.begin(), FULL_BATCH_SIZES.end());

        id<MTLDevice> metal_device = MTLCreateSystemDefaultDevice();
        if (metal_device == nil) {
            throw std::runtime_error("MTLCreateSystemDefaultDevice failed");
        }
        const uint64_t before_backend = current_allocated_bytes(metal_device);

        ggml_backend_load_all();
        ggml_backend_ptr backend(
            ggml_backend_init_by_type(GGML_BACKEND_DEVICE_TYPE_GPU, nullptr));
        if (!backend) {
            throw std::runtime_error("no GPU backend available");
        }

        ggml_init_params parameters{};
        parameters.mem_size = CONTEXT_BYTES;
        parameters.mem_buffer = nullptr;
        parameters.no_alloc = true;
        ggml_context_ptr context(ggml_init(parameters));
        if (!context) {
            throw std::runtime_error("ggml_init failed");
        }

        std::vector<InitializedTensor> initialized;
        std::vector<ExpertBundle> experts_a;
        std::vector<ExpertBundle> experts_b;
        std::vector<ExpertBundle> experts_c;
        std::vector<SharedBundle> shared;
        std::vector<AttentionBundle> attention;
        for (int pool = 0; pool < POOL_SIZE; ++pool) {
            experts_a.push_back(new_expert_bundle(
                context.get(), CLASS_A, initialized, 1000 + pool * 10));
            experts_b.push_back(new_expert_bundle(
                context.get(), CLASS_B, initialized, 2000 + pool * 10));
            experts_c.push_back(new_expert_bundle(
                context.get(), CLASS_C, initialized, 3000 + pool * 10));
            shared.push_back(new_shared_bundle(
                context.get(), initialized, 4000 + pool * 10));
            attention.push_back(new_attention_bundle(
                context.get(), initialized, 5000 + pool * 10));
        }
        auto * k_cache = ggml_new_tensor_3d(
            context.get(), GGML_TYPE_F16, MLA_QK, N_CTX, 1);
        initialized.push_back({k_cache, 0, true});

        std::vector<GraphCase> cases;
        for (const int batch_size : batch_sizes) {
            auto * input = ggml_new_tensor_2d(
                context.get(), GGML_TYPE_F32, N_EMBD, batch_size);
            auto * ids = ggml_new_tensor_2d(
                context.get(), GGML_TYPE_I32, N_EXPERT_USED, batch_size);
            ggml_set_input(input);
            ggml_set_input(ids);
            auto * full_root = build_chain(
                context.get(), ChainKind::full, batch_size,
                experts_a, experts_b, experts_c, shared, attention,
                k_cache, ids, input);
            auto * attention_root = build_chain(
                context.get(), ChainKind::attention, batch_size,
                experts_a, experts_b, experts_c, shared, attention,
                k_cache, ids, input);
            auto * routed_root = build_chain(
                context.get(), ChainKind::routed, batch_size,
                experts_a, experts_b, experts_c, shared, attention,
                k_cache, ids, input);
            auto * shared_root = build_chain(
                context.get(), ChainKind::shared, batch_size,
                experts_a, experts_b, experts_c, shared, attention,
                k_cache, ids, input);
            auto * combined_ffn_root = build_chain(
                context.get(), ChainKind::combined_ffn, batch_size,
                experts_a, experts_b, experts_c, shared, attention,
                k_cache, ids, input);
            GraphCase item{};
            item.batch_size = batch_size;
            item.input = input;
            item.ids = ids;
            item.full_root = full_root;
            item.full = graph_for(context.get(), full_root);
            item.attention = graph_for(context.get(), attention_root);
            item.routed = graph_for(context.get(), routed_root);
            item.shared = graph_for(context.get(), shared_root);
            item.combined_ffn = graph_for(context.get(), combined_ffn_root);
            cases.push_back(item);
        }

        std::array<ggml_backend_t, 1> backends{backend.get()};
        ggml_backend_buffer_type_t metal_buft =
            ggml_backend_get_default_buffer_type(backend.get());
        const long system_page_size = sysconf(_SC_PAGESIZE);
        if (system_page_size <= 0) {
            throw std::runtime_error("sysconf(_SC_PAGESIZE) failed");
        }
        const uint64_t system_page_size_bytes =
            static_cast<uint64_t>(system_page_size);
        const size_t context_buffer_max_size_bytes =
            ggml_backend_buft_get_max_size(metal_buft);
        if (context_buffer_max_size_bytes == 0) {
            throw std::runtime_error("Metal buffer type reported zero max size");
        }
        if (reserve_only) {
            std::vector<ReserveRepeatMeasurement> reserve_repeats;
            reserve_repeats.reserve(B2R_RESERVE_REPEATS);
            for (int repeat_index = 1;
                 repeat_index <= B2R_RESERVE_REPEATS;
                 ++repeat_index) {
                ReserveRepeatMeasurement repeat{};
                repeat.repeat_index = repeat_index;
                repeat.before_scheduler = current_allocated_bytes(metal_device);
                scheduler_ptr reserve_scheduler(ggml_backend_sched_new(
                    backends.data(), nullptr, 1, SCHEDULER_GRAPH_SIZE, false, true));
                if (!reserve_scheduler) {
                    throw std::runtime_error("ggml_backend_sched_new failed");
                }
                repeat.after_scheduler = current_allocated_bytes(metal_device);
                size_t maximum_reserve_bytes = 0;
                for (auto & item : cases) {
                    std::array<size_t, 1> sizes{};
                    ggml_backend_sched_reserve_size(
                        reserve_scheduler.get(), item.full, sizes.data());
                    item.reserve_bytes = sizes.front();
                    maximum_reserve_bytes = std::max(
                        maximum_reserve_bytes, item.reserve_bytes);
                    repeat.cases.push_back({
                        item.batch_size,
                        ggml_graph_n_nodes(item.full),
                        static_cast<size_t>(ggml_graph_size(item.full)),
                        item.reserve_bytes,
                    });
                }
                repeat.after_reserve = current_allocated_bytes(metal_device);
                repeat.context_alloc_bytes =
                    ggml_backend_alloc_ctx_tensors_from_buft_size(
                        context.get(), metal_buft);
                repeat.after_context_sizing = current_allocated_bytes(metal_device);
                if (repeat.before_scheduler != repeat.after_scheduler ||
                    repeat.after_scheduler != repeat.after_reserve ||
                    repeat.after_reserve != repeat.after_context_sizing) {
                    write_preallocation_refusal(
                        options, before_backend, repeat.before_scheduler,
                        repeat.after_scheduler, repeat.after_context_sizing,
                        "refused-before-allocation-no-alloc-sizing-path-allocated",
                        cases, maximum_reserve_bytes);
                    return 3;
                }
                reserve_scheduler.reset();
                repeat.after_scheduler_free = current_allocated_bytes(metal_device);
                reserve_repeats.push_back(std::move(repeat));
            }
            write_reserve_only_result(
                options, before_backend, ggml_backend_buft_name(metal_buft),
                system_page_size_bytes, context_buffer_max_size_bytes,
                reserve_repeats);
            return 0;
        }

        const uint64_t before_scheduler = current_allocated_bytes(metal_device);
        scheduler_ptr scheduler(ggml_backend_sched_new(
            backends.data(), nullptr, 1, SCHEDULER_GRAPH_SIZE, false, true));
        if (!scheduler) {
            throw std::runtime_error("ggml_backend_sched_new failed");
        }
        const uint64_t after_scheduler = current_allocated_bytes(metal_device);
        size_t maximum_reserve_bytes = 0;
        for (auto & item : cases) {
            std::array<size_t, 1> sizes{};
            ggml_backend_sched_reserve_size(scheduler.get(), item.full, sizes.data());
            item.reserve_bytes = sizes.front();
            maximum_reserve_bytes = std::max(maximum_reserve_bytes, item.reserve_bytes);
        }
        const uint64_t after_reserve = current_allocated_bytes(metal_device);
        if (before_scheduler != after_scheduler || after_scheduler != after_reserve) {
            write_preallocation_refusal(
                options, before_backend, before_scheduler, after_scheduler, after_reserve,
                "refused-before-allocation-reserve-path-allocated",
                cases, maximum_reserve_bytes);
            return 3;
        }
        if (maximum_reserve_bytes != options.expected_maximum_reserve_bytes) {
            write_preallocation_refusal(
                options, before_backend, before_scheduler, after_scheduler, after_reserve,
                "refused-before-allocation-reserve-mismatch",
                cases, maximum_reserve_bytes);
            return 3;
        }
        scheduler.reset();

        const uint64_t before_allocation = current_allocated_bytes(metal_device);
        ggml_backend_buffer_ptr buffer(
            ggml_backend_alloc_ctx_tensors(context.get(), backend.get()));
        if (!buffer) {
            throw std::runtime_error("backend tensor allocation failed");
        }
        const size_t allocated_buffer_bytes = ggml_backend_buffer_get_size(buffer.get());
        const uint64_t after_allocation = current_allocated_bytes(metal_device);
        if (allocated_buffer_bytes != options.expected_context_alloc_bytes) {
            write_postallocation_refusal(
                options, "refused-after-allocation-context-size-mismatch",
                allocated_buffer_bytes, after_allocation, cases);
            return 4;
        }

        for (const auto & item : initialized) {
            if (item.zero) {
                initialize_zero(item.tensor);
            } else {
                initialize_quantized(item.tensor, item.seed);
            }
        }
        for (auto & item : cases) {
            std::vector<float> input_values(
                static_cast<size_t>(N_EMBD * item.batch_size));
            for (size_t index = 0; index < input_values.size(); ++index) {
                input_values.at(index) =
                    static_cast<float>(0.01 * std::cos(static_cast<double>(index) * 0.003));
            }
            ggml_backend_tensor_set(
                item.input, input_values.data(), 0,
                input_values.size() * sizeof(float));
            std::vector<int32_t> ids_values(
                static_cast<size_t>(N_EXPERT_USED * item.batch_size));
            for (int batch = 0; batch < item.batch_size; ++batch) {
                std::iota(
                    ids_values.begin() + batch * N_EXPERT_USED,
                    ids_values.begin() + (batch + 1) * N_EXPERT_USED,
                    0);
            }
            ggml_backend_tensor_set(
                item.ids, ids_values.data(), 0,
                ids_values.size() * sizeof(int32_t));
        }

        const uint64_t after_initialization = current_allocated_bytes(metal_device);

        uint64_t maximum_observed_metal_bytes = after_initialization;
        for (auto & item : cases) {
            item.full_timing = time_graph(
                backend.get(), item.full, warmup, repetitions,
                metal_device, maximum_observed_metal_bytes);
            item.attention_timing = time_graph(
                backend.get(), item.attention, warmup, repetitions,
                metal_device, maximum_observed_metal_bytes);
            item.routed_timing = time_graph(
                backend.get(), item.routed, warmup, repetitions,
                metal_device, maximum_observed_metal_bytes);
            item.shared_timing = time_graph(
                backend.get(), item.shared, warmup, repetitions,
                metal_device, maximum_observed_metal_bytes);
            item.combined_ffn_timing = time_graph(
                backend.get(), item.combined_ffn, warmup, repetitions,
                metal_device, maximum_observed_metal_bytes);
            ggml_backend_tensor_get(
                item.full_root, &item.checksum, 0, sizeof(item.checksum));
            if (!std::isfinite(item.checksum)) {
                throw std::runtime_error("non-finite output checksum");
            }
        }

        write_result(
            options, warmup, repetitions,
            before_backend, before_scheduler, after_scheduler, after_reserve,
            before_allocation, after_allocation, after_initialization,
            maximum_observed_metal_bytes, allocated_buffer_bytes,
            ggml_backend_buft_name(metal_buft), system_page_size_bytes,
            context_buffer_max_size_bytes, cases);
        ggml_quantize_free();
        return 0;
    } catch (const std::exception & error) {
        std::cerr << "galactus-glm-batch-compute-probe: "
                  << error.what() << std::endl;
        return 2;
    }
}

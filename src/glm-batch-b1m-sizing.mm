#include "ggml-backend.h"
#include "ggml-cpp.h"
#include "ggml.h"

#import <Metal/Metal.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <memory>
#include <numeric>
#include <stdexcept>
#include <string>
#include <vector>

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
constexpr std::array<int, 4> BATCH_SIZES{1, 2, 4, 8};

struct Options {
    std::string output;
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

struct GraphCase {
    int batch_size;
    ggml_tensor * input;
    ggml_tensor * ids;
    ggml_tensor * output;
    ggml_cgraph * graph;
};

struct BackendSize {
    std::string backend;
    std::string buffer_type;
    size_t reserve_bytes;
    size_t allocated_buffer_bytes;
};

struct CaseResult {
    int batch_size;
    int nodes;
    int graph_capacity;
    std::vector<BackendSize> backends;
    size_t reserve_total_bytes;
    size_t allocated_total_bytes;
    uint64_t metal_current_allocated_bytes;
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
        if (argument == "--output") {
            if (++index >= argc) {
                throw std::runtime_error("missing value for --output");
            }
            options.output = argv[index];
        } else {
            throw std::runtime_error("unknown argument: " + argument);
        }
    }
    if (options.output.empty()) {
        throw std::runtime_error("--output is required");
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

ggml_tensor * quant_2d(
    ggml_context * context, ggml_type type, int64_t ne0, int64_t ne1) {
    return ggml_new_tensor_2d(context, type, ne0, ne1);
}

ggml_tensor * quant_3d(
    ggml_context * context, ggml_type type, int64_t ne0, int64_t ne1, int64_t ne2) {
    return ggml_new_tensor_3d(context, type, ne0, ne1, ne2);
}

ExpertBundle new_expert_bundle(ggml_context * context, const ExpertClass & type) {
    return {
        quant_3d(context, type.gate_up_type, N_EMBD, N_FF_EXPERT, N_EXPERT_USED),
        quant_3d(context, type.gate_up_type, N_EMBD, N_FF_EXPERT, N_EXPERT_USED),
        quant_3d(context, type.down_type, N_FF_EXPERT, N_EMBD, N_EXPERT_USED),
    };
}

SharedBundle new_shared_bundle(ggml_context * context) {
    return {
        quant_2d(context, GGML_TYPE_Q5_K, N_EMBD, N_FF_SHARED),
        quant_2d(context, GGML_TYPE_Q5_K, N_EMBD, N_FF_SHARED),
        quant_2d(context, GGML_TYPE_Q6_K, N_FF_SHARED, N_EMBD),
    };
}

AttentionBundle new_attention_bundle(ggml_context * context) {
    return {
        quant_2d(context, GGML_TYPE_Q5_K, N_EMBD, Q_LORA),
        quant_2d(context, GGML_TYPE_Q8_0, Q_LORA, (QK_NOPE + QK_ROPE) * N_HEAD),
        quant_2d(context, GGML_TYPE_Q8_0, N_EMBD, MLA_QK),
        quant_3d(context, GGML_TYPE_Q8_0, QK_NOPE, KV_LORA, N_HEAD),
        quant_3d(context, GGML_TYPE_Q8_0, KV_LORA, V_HEAD, N_HEAD),
        quant_2d(context, GGML_TYPE_Q5_K, V_HEAD * N_HEAD, N_EMBD),
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
    ggml_context * context, const SharedBundle & bundle, ggml_tensor * input) {
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
        auto * attention_output = build_attention(
            context, attention.at(static_cast<size_t>(pool)), k_cache,
            current, batch_size);
        current = ggml_add(context, current, attention_output);
        auto * routed_output = build_moe(
            context, expert_for_layer(layer, pool, experts_a, experts_b, experts_c),
            ids, current, batch_size);
        auto * shared_output = build_shared(
            context, shared.at(static_cast<size_t>(pool)), current);
        current = ggml_add(context, current, routed_output);
        current = ggml_add(context, current, shared_output);
    }
    return current;
}

std::string json_escape(const std::string & value) {
    std::string escaped;
    escaped.reserve(value.size());
    for (const char character : value) {
        if (character == '\\' || character == '"') {
            escaped.push_back('\\');
        }
        escaped.push_back(character);
    }
    return escaped;
}

uint64_t current_allocated_bytes(id<MTLDevice> device) {
    return static_cast<uint64_t>(device.currentAllocatedSize);
}

bool write_result(
    const Options & options,
    uint64_t before_backend,
    uint64_t before_scheduler,
    uint64_t after_scheduler,
    uint64_t after_reserve,
    size_t scheduler_graph_size,
    const std::vector<CaseResult> & results) {
    const size_t allocated_buffer_count = static_cast<size_t>(std::count_if(
        results.begin(), results.end(), [](const CaseResult & result) {
            return result.allocated_total_bytes != 0;
        }));
    // Backend initialization may legitimately materialize Metal pipelines. The
    // hard no-allocation interval starts immediately before scheduler creation.
    const bool no_scheduler_allocation = before_scheduler == after_scheduler
        && after_scheduler == after_reserve;
    const bool valid = no_scheduler_allocation && allocated_buffer_count == 0;

    std::ofstream output(options.output, std::ios::out | std::ios::trunc);
    if (!output) {
        throw std::runtime_error("cannot open output: " + options.output);
    }
    output << "{\n"
           << "  \"schema\": \"galactus.h4-batch-b1m-metal-reserve.v1\",\n"
           << "  \"status\": \""
           << (valid ? "valid-no-allocation" : "invalid-allocation-observed")
           << "\",\n"
           << "  \"scope\": \"same8-lower-bound fixed-kv-optimistic\",\n"
           << "  \"buffer_creation_allowed\": false,\n"
           << "  \"graph_compute_executed\": false,\n"
           << "  \"backend_initialization_delta_is_informational\": true,\n"
           << "  \"hard_zero_allocation_interval\": "
              "\"before_scheduler_new..after_all_reserve_size\",\n"
           << "  \"scheduler_graph_size\": " << scheduler_graph_size << ",\n"
           << "  \"metal_current_allocated_bytes\": {\n"
           << "    \"before_backend_init\": " << before_backend << ",\n"
           << "    \"before_scheduler_new\": " << before_scheduler << ",\n"
           << "    \"after_scheduler_new\": " << after_scheduler << ",\n"
           << "    \"after_all_reserve_size\": " << after_reserve << ",\n"
           << "    \"delta_scheduler_and_reserve\": "
           << static_cast<int64_t>(after_reserve) - static_cast<int64_t>(before_scheduler)
           << ",\n"
           << "    \"delta_backend_to_final\": "
           << static_cast<int64_t>(after_reserve) - static_cast<int64_t>(before_backend)
           << "\n  },\n"
           << "  \"allocated_buffer_count\": " << allocated_buffer_count << ",\n"
           << "  \"cases\": [\n";
    const size_t baseline = results.front().reserve_total_bytes;
    for (size_t index = 0; index < results.size(); ++index) {
        const auto & result = results[index];
        output << "    {\n"
               << "      \"k\": " << result.batch_size << ",\n"
               << "      \"input_shape\": [6144, " << result.batch_size << "],\n"
               << "      \"ids_shape\": [8, " << result.batch_size << "],\n"
               << "      \"nodes\": " << result.nodes << ",\n"
               << "      \"graph_capacity\": " << result.graph_capacity << ",\n"
               << "      \"reserve_total_bytes\": " << result.reserve_total_bytes << ",\n"
               << "      \"incremental_reserve_bytes_vs_k1\": "
               << (result.reserve_total_bytes > baseline
                       ? result.reserve_total_bytes - baseline : 0)
               << ",\n"
               << "      \"allocated_buffer_bytes\": "
               << result.allocated_total_bytes << ",\n"
               << "      \"metal_current_allocated_bytes\": "
               << result.metal_current_allocated_bytes << ",\n"
               << "      \"backends\": [\n";
        for (size_t backend_index = 0; backend_index < result.backends.size(); ++backend_index) {
            const auto & backend = result.backends[backend_index];
            output << "        {\"name\": \"" << json_escape(backend.backend)
                   << "\", \"buffer_type\": \"" << json_escape(backend.buffer_type)
                   << "\", \"reserve_bytes\": " << backend.reserve_bytes
                   << ", \"allocated_buffer_bytes\": "
                   << backend.allocated_buffer_bytes << "}"
                   << (backend_index + 1 == result.backends.size() ? "\n" : ",\n");
        }
        output << "      ]\n"
               << "    }" << (index + 1 == results.size() ? "\n" : ",\n");
    }
    output << "  ]\n}\n";
    if (!output) {
        throw std::runtime_error("failed while writing output: " + options.output);
    }
    return valid;
}

} // namespace

int main(int argc, char ** argv) {
    try {
        const Options options = parse_options(argc, argv);
        id<MTLDevice> metal_device = MTLCreateSystemDefaultDevice();
        if (metal_device == nil) {
            throw std::runtime_error("MTLCreateSystemDefaultDevice failed");
        }
        const uint64_t before_backend = current_allocated_bytes(metal_device);

        ggml_backend_load_all();
        ggml_backend_ptr metal_backend(
            ggml_backend_init_by_type(GGML_BACKEND_DEVICE_TYPE_GPU, nullptr));
        ggml_backend_ptr cpu_backend(
            ggml_backend_init_by_type(GGML_BACKEND_DEVICE_TYPE_CPU, nullptr));
        if (!metal_backend || !cpu_backend) {
            throw std::runtime_error("required Metal/CPU backend unavailable");
        }
        ggml_init_params parameters{};
        parameters.mem_size = CONTEXT_BYTES;
        parameters.mem_buffer = nullptr;
        parameters.no_alloc = true;
        ggml_context_ptr context(ggml_init(parameters));
        if (!context) {
            throw std::runtime_error("ggml_init failed");
        }

        std::vector<ExpertBundle> experts_a;
        std::vector<ExpertBundle> experts_b;
        std::vector<ExpertBundle> experts_c;
        std::vector<SharedBundle> shared;
        std::vector<AttentionBundle> attention;
        for (int pool = 0; pool < POOL_SIZE; ++pool) {
            experts_a.push_back(new_expert_bundle(context.get(), CLASS_A));
            experts_b.push_back(new_expert_bundle(context.get(), CLASS_B));
            experts_c.push_back(new_expert_bundle(context.get(), CLASS_C));
            shared.push_back(new_shared_bundle(context.get()));
            attention.push_back(new_attention_bundle(context.get()));
        }
        auto * k_cache = ggml_new_tensor_3d(
            context.get(), GGML_TYPE_F16, MLA_QK, N_CTX, 1);

        std::vector<GraphCase> graphs;
        for (const int batch_size : BATCH_SIZES) {
            auto * input = ggml_new_tensor_2d(
                context.get(), GGML_TYPE_F32, N_EMBD, batch_size);
            auto * ids = ggml_new_tensor_2d(
                context.get(), GGML_TYPE_I32, N_EXPERT_USED, batch_size);
            ggml_set_input(input);
            ggml_set_input(ids);
            auto * result = build_chain(
                context.get(), batch_size, experts_a, experts_b, experts_c,
                shared, attention, k_cache, ids, input);
            auto * graph = ggml_new_graph_custom(context.get(), GRAPH_CAPACITY, false);
            ggml_build_forward_expand(graph, result);
            graphs.push_back({batch_size, input, ids, result, graph});
        }

        const auto & largest = graphs.back();
        // ggml_cgraph is opaque in the public API.  Twice the k=8 graph
        // capacity is a conservative public-API bound for nodes + leaves.
        const size_t largest_capacity = static_cast<size_t>(
            ggml_graph_size(largest.graph));
        const size_t scheduler_graph_size = std::max<size_t>(
            GRAPH_CAPACITY, largest_capacity * 2 + 64);

        std::array<ggml_backend_t, 2> backends{
            metal_backend.get(), cpu_backend.get(),
        };
        const uint64_t before_scheduler = current_allocated_bytes(metal_device);
        scheduler_ptr scheduler(ggml_backend_sched_new(
            backends.data(), nullptr, static_cast<int>(backends.size()),
            scheduler_graph_size, false, true));
        if (!scheduler) {
            throw std::runtime_error("ggml_backend_sched_new failed");
        }
        const uint64_t after_scheduler = current_allocated_bytes(metal_device);

        std::vector<CaseResult> results;
        for (const auto & item : graphs) {
            std::array<size_t, 2> sizes{};
            ggml_backend_sched_reserve_size(scheduler.get(), item.graph, sizes.data());
            CaseResult result{};
            result.batch_size = item.batch_size;
            result.nodes = ggml_graph_n_nodes(item.graph);
            result.graph_capacity = ggml_graph_size(item.graph);
            result.metal_current_allocated_bytes = current_allocated_bytes(metal_device);
            for (size_t index = 0; index < backends.size(); ++index) {
                const auto backend = backends[index];
                const size_t allocated = ggml_backend_sched_get_buffer_size(
                    scheduler.get(), backend);
                auto buffer_type = ggml_backend_sched_get_buffer_type(
                    scheduler.get(), backend);
                result.backends.push_back({
                    ggml_backend_name(backend),
                    ggml_backend_buft_name(buffer_type),
                    sizes[index],
                    allocated,
                });
                result.reserve_total_bytes += sizes[index];
                result.allocated_total_bytes += allocated;
            }
            results.push_back(std::move(result));
        }
        const uint64_t after_reserve = current_allocated_bytes(metal_device);
        const bool valid = write_result(
            options, before_backend, before_scheduler, after_scheduler, after_reserve,
            scheduler_graph_size, results);
        return valid ? 0 : 2;
    } catch (const std::exception & error) {
        std::cerr << "error: " << error.what() << '\n';
        return 1;
    }
}

#include "ggml-backend.h"
#include "ggml-cpp.h"
#include "ggml.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <numeric>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

constexpr int64_t N_EMBD = 6144;
constexpr int64_t N_FF_EXPERT = 2048;
constexpr int64_t N_FF_SHARED = 2048;
constexpr int64_t N_EXPERT_LOGICAL = 256;
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

struct Options {
    std::string mode = "smoke";
    std::string output;
    int warmup = -1;
    int repetitions = -1;
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
    double p50_ms;
    double p95_ms;
};

enum class ChainKind {
    full,
    attention,
    routed,
    shared,
    combined_ffn,
};

struct ScalingGraphs {
    int layers;
    ggml_tensor * full_root;
    ggml_cgraph * full;
    ggml_cgraph * attention;
    ggml_cgraph * routed;
    ggml_cgraph * shared;
    ggml_cgraph * combined_ffn;
};

struct ScalingResult {
    int layers;
    Timing full;
    Timing attention;
    Timing routed;
    Timing shared;
    Timing combined_ffn;
};

ggml_tensor * checked_mul_mat(
    ggml_context * context,
    ggml_tensor * weights,
    ggml_tensor * input,
    const char * name) {
    const bool compatible = weights->ne[0] == input->ne[0]
        && input->ne[2] % weights->ne[2] == 0
        && input->ne[3] % weights->ne[3] == 0;
    if (!compatible) {
        throw std::runtime_error(
            std::string("cannot multiply ") + name + ": weights.ne0="
            + std::to_string(weights->ne[0]) + " input.ne0="
            + std::to_string(input->ne[0]) + " weights.ne2="
            + std::to_string(weights->ne[2]) + " input.ne2="
            + std::to_string(input->ne[2]));
    }
    return ggml_mul_mat(context, weights, input);
}

Options parse_options(int argc, char ** argv) {
    Options options;
    for (int i = 1; i < argc; ++i) {
        const std::string argument = argv[i];
        auto value = [&]() -> std::string {
            if (++i >= argc) {
                throw std::runtime_error("missing value for " + argument);
            }
            return argv[i];
        };
        if (argument == "--mode") {
            options.mode = value();
        } else if (argument == "--output") {
            options.output = value();
        } else if (argument == "--warmup") {
            options.warmup = std::stoi(value());
        } else if (argument == "--repetitions") {
            options.repetitions = std::stoi(value());
        } else {
            throw std::runtime_error("unknown argument: " + argument);
        }
    }
    if (options.mode != "smoke" && options.mode != "full") {
        throw std::runtime_error("--mode must be smoke or full");
    }
    if (options.output.empty()) {
        throw std::runtime_error("--output is required");
    }
    if (options.warmup < 0) {
        options.warmup = options.mode == "smoke" ? 0 : 2;
    }
    if (options.repetitions < 0) {
        options.repetitions = options.mode == "smoke" ? 1 : 25;
    }
    if (options.warmup < 0 || options.repetitions < 1 || options.repetitions > 100) {
        throw std::runtime_error("invalid warmup/repetition count");
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
    const ExpertClass & expert_class,
    std::vector<InitializedTensor> & initialized,
    uint32_t seed) {
    return {
        new_quant_3d(context, expert_class.gate_up_type, N_EMBD, N_FF_EXPERT,
                     N_EXPERT_USED, initialized, seed + 1),
        new_quant_3d(context, expert_class.gate_up_type, N_EMBD, N_FF_EXPERT,
                     N_EXPERT_USED, initialized, seed + 2),
        new_quant_3d(context, expert_class.down_type, N_FF_EXPERT, N_EMBD,
                     N_EXPERT_USED, initialized, seed + 3),
    };
}

SharedBundle new_shared_bundle(
    ggml_context * context,
    std::vector<InitializedTensor> & initialized,
    uint32_t seed) {
    return {
        new_quant_2d(context, GGML_TYPE_Q5_K, N_EMBD, N_FF_SHARED, initialized, seed + 1),
        new_quant_2d(context, GGML_TYPE_Q5_K, N_EMBD, N_FF_SHARED, initialized, seed + 2),
        new_quant_2d(context, GGML_TYPE_Q6_K, N_FF_SHARED, N_EMBD, initialized, seed + 3),
    };
}

AttentionBundle new_attention_bundle(
    ggml_context * context,
    std::vector<InitializedTensor> & initialized,
    uint32_t seed) {
    return {
        new_quant_2d(context, GGML_TYPE_Q5_K, N_EMBD, Q_LORA, initialized, seed + 1),
        new_quant_2d(context, GGML_TYPE_Q8_0, Q_LORA, (QK_NOPE + QK_ROPE) * N_HEAD,
                     initialized, seed + 2),
        new_quant_2d(context, GGML_TYPE_Q8_0, N_EMBD, MLA_QK, initialized, seed + 3),
        new_quant_3d(context, GGML_TYPE_Q8_0, QK_NOPE, KV_LORA, N_HEAD,
                     initialized, seed + 4),
        new_quant_3d(context, GGML_TYPE_Q8_0, KV_LORA, V_HEAD, N_HEAD,
                     initialized, seed + 5),
        new_quant_2d(context, GGML_TYPE_Q5_K, V_HEAD * N_HEAD, N_EMBD,
                     initialized, seed + 6),
    };
}

ggml_tensor * build_moe(
    ggml_context * context,
    const ExpertBundle & bundle,
    ggml_tensor * ids,
    ggml_tensor * input) {
    auto * current = ggml_reshape_3d(context, input, N_EMBD, 1, 1);
    auto * gate = ggml_mul_mat_id(context, bundle.gate, current, ids);
    auto * up = ggml_mul_mat_id(context, bundle.up, current, ids);
    auto * activated = ggml_swiglu_split(context, gate, up);
    auto * experts = ggml_mul_mat_id(context, bundle.down, activated, ids);
    auto * output = ggml_view_2d(context, experts, N_EMBD, 1, experts->nb[2], 0);
    for (int expert = 1; expert < N_EXPERT_USED; ++expert) {
        auto * lane = ggml_view_2d(
            context, experts, N_EMBD, 1, experts->nb[2], expert * experts->nb[1]);
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
    ggml_tensor * input) {
    auto * q_a = checked_mul_mat(context, bundle.wq_a, input, "attention.wq_a");
    auto * q = checked_mul_mat(context, bundle.wq_b, q_a, "attention.wq_b");
    q = ggml_reshape_3d(context, q, QK_NOPE + QK_ROPE, N_HEAD, 1);
    auto * q_nope = ggml_view_3d(
        context, q, QK_NOPE, N_HEAD, 1, q->nb[1], q->nb[2], 0);
    auto * q_rope = ggml_view_3d(
        context, q, QK_ROPE, N_HEAD, 1, q->nb[1], q->nb[2],
        QK_NOPE * q->nb[0]);

    auto * kv_current = checked_mul_mat(context, bundle.wkv_a, input, "attention.wkv_a");
    auto * k_rope = ggml_view_2d(
        context, kv_current, QK_ROPE, 1, kv_current->nb[1], KV_LORA * kv_current->nb[0]);
    q_rope = ggml_add(context, q_rope, k_rope);

    q_nope = ggml_permute(context, q_nope, 0, 2, 1, 3);
    auto * q_absorbed = checked_mul_mat(context, bundle.wk_b, q_nope, "attention.wk_b");
    q_rope = ggml_permute(context, q_rope, 0, 2, 1, 3);
    auto * q_mla = ggml_concat(context, q_absorbed, q_rope, 0);

    auto * v_cache = ggml_view_3d(
        context, k_cache, KV_LORA, N_CTX, 1, k_cache->nb[1], k_cache->nb[2], 0);
    auto * attended = ggml_flash_attn_ext(
        context, q_mla, k_cache, v_cache, nullptr,
        1.0f / std::sqrt(static_cast<float>(MLA_QK)), 0.0f, 0.0f);
    ggml_flash_attn_ext_set_prec(attended, GGML_PREC_F32);
    attended = ggml_permute(context, attended, 0, 2, 1, 3);
    auto * value_heads = checked_mul_mat(context, bundle.wv_b, attended, "attention.wv_b");
    value_heads = ggml_permute(context, value_heads, 0, 2, 1, 3);
    value_heads = ggml_cont(context, value_heads);
    auto * value_flat = ggml_reshape_2d(context, value_heads, V_HEAD * N_HEAD, 1);
    return checked_mul_mat(context, bundle.wo, value_flat, "attention.wo");
}

const ExpertBundle & expert_for_layer(
    int layer,
    int pool,
    const std::vector<ExpertBundle> & experts_a,
    const std::vector<ExpertBundle> & experts_b,
    const std::vector<ExpertBundle> & experts_c) {
    const auto & expert_class = layer_class(layer);
    if (expert_class.name == 'A') {
        return experts_a[static_cast<size_t>(pool)];
    }
    if (expert_class.name == 'B') {
        return experts_b[static_cast<size_t>(pool)];
    }
    return experts_c[static_cast<size_t>(pool)];
}

ggml_tensor * build_chain(
    ggml_context * context,
    ChainKind kind,
    int layers,
    int pool_size,
    const std::vector<ExpertBundle> & experts_a,
    const std::vector<ExpertBundle> & experts_b,
    const std::vector<ExpertBundle> & experts_c,
    const std::vector<SharedBundle> & shared,
    const std::vector<AttentionBundle> & attention,
    ggml_tensor * k_cache,
    ggml_tensor * ids,
    ggml_tensor * input) {
    ggml_tensor * current = input;
    for (int offset = 0; offset < layers; ++offset) {
        const int layer = 3 + offset;
        const int pool = offset % pool_size;
        const auto & expert = expert_for_layer(
            layer, pool, experts_a, experts_b, experts_c);
        if (kind == ChainKind::full || kind == ChainKind::attention) {
            auto * attention_out = build_attention(
                context, attention[static_cast<size_t>(pool)], k_cache, current);
            current = ggml_add(context, current, attention_out);
        }
        if (kind == ChainKind::full || kind == ChainKind::combined_ffn) {
            auto * routed_out = build_moe(context, expert, ids, current);
            auto * shared_out = build_shared(
                context, shared[static_cast<size_t>(pool)], current);
            current = ggml_add(context, current, routed_out);
            current = ggml_add(context, current, shared_out);
        } else if (kind == ChainKind::routed) {
            current = ggml_add(context, current, build_moe(context, expert, ids, current));
        } else if (kind == ChainKind::shared) {
            current = ggml_add(
                context, current,
                build_shared(context, shared[static_cast<size_t>(pool)], current));
        }
    }
    return current;
}

ggml_cgraph * graph_for(ggml_context * context, ggml_tensor * output, size_t nodes) {
    auto * graph = ggml_new_graph_custom(context, nodes, false);
    ggml_build_forward_expand(graph, output);
    return graph;
}

void initialize_quantized(ggml_tensor * tensor, uint32_t seed) {
    const int64_t row_elements = tensor->ne[0];
    const int64_t rows = ggml_nrows(tensor);
    std::vector<float> source(static_cast<size_t>(row_elements));
    std::vector<float> imatrix(static_cast<size_t>(row_elements), 1.0f);
    for (int64_t i = 0; i < row_elements; ++i) {
        const double phase = static_cast<double>((i + 1) * (seed + 17U));
        source[static_cast<size_t>(i)] = static_cast<float>(0.01 * std::sin(phase * 0.00037));
    }
    const size_t row_bytes = ggml_row_size(tensor->type, row_elements);
    std::vector<uint8_t> quantized(row_bytes);
    const float * importance = ggml_quantize_requires_imatrix(tensor->type)
        ? imatrix.data()
        : nullptr;
    const size_t produced = ggml_quantize_chunk(
        tensor->type, source.data(), quantized.data(), 0, 1, row_elements, importance);
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
        const size_t current_rows = static_cast<size_t>(
            std::min<int64_t>(rows - written_rows, static_cast<int64_t>(rows_per_chunk)));
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
    return values[std::min(index, values.size() - 1)];
}

Timing time_graph(
    ggml_backend_t backend,
    ggml_cgraph * graph,
    int warmup,
    int repetitions) {
    for (int i = 0; i < warmup; ++i) {
        const auto status = ggml_backend_graph_compute(backend, graph);
        if (status != GGML_STATUS_SUCCESS) {
            throw std::runtime_error(std::string("warmup failed: ") + ggml_status_to_string(status));
        }
    }
    std::vector<double> samples;
    samples.reserve(static_cast<size_t>(repetitions));
    for (int i = 0; i < repetitions; ++i) {
        const auto start = std::chrono::steady_clock::now();
        const auto status = ggml_backend_graph_compute(backend, graph);
        const auto end = std::chrono::steady_clock::now();
        if (status != GGML_STATUS_SUCCESS) {
            throw std::runtime_error(std::string("graph failed: ") + ggml_status_to_string(status));
        }
        samples.push_back(std::chrono::duration<double, std::milli>(end - start).count());
    }
    return {samples, percentile(samples, 0.50), percentile(samples, 0.95)};
}

double linear_slope_per_layer(
    const std::vector<ScalingResult> & results,
    const Timing ScalingResult::* member) {
    double mean_x = 0.0;
    double mean_y = 0.0;
    for (const auto & result : results) {
        mean_x += static_cast<double>(result.layers);
        mean_y += (result.*member).p50_ms;
    }
    mean_x /= static_cast<double>(results.size());
    mean_y /= static_cast<double>(results.size());
    double numerator = 0.0;
    double denominator = 0.0;
    for (const auto & result : results) {
        const double dx = static_cast<double>(result.layers) - mean_x;
        numerator += dx * ((result.*member).p50_ms - mean_y);
        denominator += dx * dx;
    }
    if (denominator == 0.0) {
        throw std::runtime_error("cannot fit scaling slope");
    }
    return numerator / denominator;
}

void write_timing(std::ostream & output, const Timing & timing, int indent) {
    const std::string space(static_cast<size_t>(indent), ' ');
    output << "{\n" << space << "  \"samples_ms\": [";
    for (size_t i = 0; i < timing.samples_ms.size(); ++i) {
        output << (i == 0 ? "" : ", ") << timing.samples_ms[i];
    }
    output << "],\n" << space << "  \"p50_ms\": " << timing.p50_ms
           << ",\n" << space << "  \"p95_ms\": " << timing.p95_ms
           << "\n" << space << "}";
}

size_t bundle_bytes(const ExpertBundle & bundle) {
    return ggml_nbytes(bundle.gate) + ggml_nbytes(bundle.up) + ggml_nbytes(bundle.down);
}

size_t bundle_bytes(const SharedBundle & bundle) {
    return ggml_nbytes(bundle.gate) + ggml_nbytes(bundle.up) + ggml_nbytes(bundle.down);
}

size_t bundle_bytes(const AttentionBundle & bundle) {
    return ggml_nbytes(bundle.wq_a) + ggml_nbytes(bundle.wq_b)
        + ggml_nbytes(bundle.wkv_a) + ggml_nbytes(bundle.wk_b)
        + ggml_nbytes(bundle.wv_b) + ggml_nbytes(bundle.wo);
}

} // namespace

int main(int argc, char ** argv) {
    try {
        const Options options = parse_options(argc, argv);
        const int pool_size = options.mode == "smoke" ? 1 : 8;

        ggml_backend_load_all();
        ggml_backend_ptr backend(
            ggml_backend_init_by_type(GGML_BACKEND_DEVICE_TYPE_GPU, nullptr));
        if (!backend) {
            throw std::runtime_error("no GPU backend available");
        }

        ggml_init_params parameters{};
        parameters.mem_size = 256 * 1024 * 1024;
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
        for (int i = 0; i < pool_size; ++i) {
            experts_a.push_back(new_expert_bundle(context.get(), CLASS_A, initialized, 1000 + i * 10));
            experts_b.push_back(new_expert_bundle(context.get(), CLASS_B, initialized, 2000 + i * 10));
            experts_c.push_back(new_expert_bundle(context.get(), CLASS_C, initialized, 3000 + i * 10));
            shared.push_back(new_shared_bundle(context.get(), initialized, 4000 + i * 10));
            attention.push_back(new_attention_bundle(context.get(), initialized, 5000 + i * 10));
        }

        auto * k_cache = ggml_new_tensor_3d(context.get(), GGML_TYPE_F16, MLA_QK, N_CTX, 1);
        initialized.push_back({k_cache, 0, true});
        auto * input = ggml_new_tensor_2d(context.get(), GGML_TYPE_F32, N_EMBD, 1);
        auto * ids = ggml_new_tensor_2d(context.get(), GGML_TYPE_I32, N_EXPERT_USED, 1);

        auto * attention_root = build_attention(context.get(), attention.front(), k_cache, input);
        auto * shared_root = build_shared(context.get(), shared.front(), input);
        auto * class_a_root = build_moe(context.get(), experts_a.front(), ids, input);
        auto * class_b_root = build_moe(context.get(), experts_b.front(), ids, input);
        auto * class_c_root = build_moe(context.get(), experts_c.front(), ids, input);
        auto * attention_graph = graph_for(context.get(), attention_root, 256);
        auto * shared_graph = graph_for(context.get(), shared_root, 128);
        auto * class_a_graph = graph_for(context.get(), class_a_root, 128);
        auto * class_b_graph = graph_for(context.get(), class_b_root, 128);
        auto * class_c_graph = graph_for(context.get(), class_c_root, 128);

        std::array<int, 3> layer_counts{0, 0, 0};
        for (int layer = 3; layer <= 77; ++layer) {
            const auto & expert_class = layer_class(layer);
            if (expert_class.name == 'A') {
                ++layer_counts[0];
            } else if (expert_class.name == 'B') {
                ++layer_counts[1];
            } else {
                ++layer_counts[2];
            }
        }
        if (layer_counts != std::array<int, 3>{53, 18, 4}) {
            throw std::runtime_error("routed layer class schedule mismatch");
        }

        constexpr std::array<int, 9> scaling_layer_counts{1, 2, 3, 4, 6, 10, 25, 50, 75};
        std::vector<ScalingGraphs> scaling_graphs;
        for (const int layers : scaling_layer_counts) {
            auto * full_root = build_chain(
                context.get(), ChainKind::full, layers, pool_size,
                experts_a, experts_b, experts_c, shared, attention,
                k_cache, ids, input);
            auto * attention_root_n = build_chain(
                context.get(), ChainKind::attention, layers, pool_size,
                experts_a, experts_b, experts_c, shared, attention,
                k_cache, ids, input);
            auto * routed_root_n = build_chain(
                context.get(), ChainKind::routed, layers, pool_size,
                experts_a, experts_b, experts_c, shared, attention,
                k_cache, ids, input);
            auto * shared_root_n = build_chain(
                context.get(), ChainKind::shared, layers, pool_size,
                experts_a, experts_b, experts_c, shared, attention,
                k_cache, ids, input);
            auto * combined_ffn_root_n = build_chain(
                context.get(), ChainKind::combined_ffn, layers, pool_size,
                experts_a, experts_b, experts_c, shared, attention,
                k_cache, ids, input);
            scaling_graphs.push_back(
                {
                    layers,
                    full_root,
                    graph_for(context.get(), full_root, 8192),
                    graph_for(context.get(), attention_root_n, 8192),
                    graph_for(context.get(), routed_root_n, 8192),
                    graph_for(context.get(), shared_root_n, 8192),
                    graph_for(context.get(), combined_ffn_root_n, 8192),
                });
        }

        ggml_backend_buffer_ptr buffer(
            ggml_backend_alloc_ctx_tensors(context.get(), backend.get()));
        if (!buffer) {
            throw std::runtime_error("backend tensor allocation failed");
        }

        for (const auto & item : initialized) {
            if (item.zero) {
                initialize_zero(item.tensor);
            } else {
                initialize_quantized(item.tensor, item.seed);
            }
        }
        std::vector<float> input_values(static_cast<size_t>(N_EMBD));
        for (int64_t i = 0; i < N_EMBD; ++i) {
            input_values[static_cast<size_t>(i)] = static_cast<float>(0.01 * std::cos(i * 0.003));
        }
        ggml_backend_tensor_set(input, input_values.data(), 0,
                                input_values.size() * sizeof(float));
        std::array<int32_t, N_EXPERT_USED> id_values{};
        std::iota(id_values.begin(), id_values.end(), 0);
        ggml_backend_tensor_set(ids, id_values.data(), 0,
                                id_values.size() * sizeof(int32_t));

        const Timing attention_timing = time_graph(
            backend.get(), attention_graph, options.warmup, options.repetitions);
        const Timing shared_timing = time_graph(
            backend.get(), shared_graph, options.warmup, options.repetitions);
        const Timing class_a_timing = time_graph(
            backend.get(), class_a_graph, options.warmup, options.repetitions);
        const Timing class_b_timing = time_graph(
            backend.get(), class_b_graph, options.warmup, options.repetitions);
        const Timing class_c_timing = time_graph(
            backend.get(), class_c_graph, options.warmup, options.repetitions);
        std::vector<ScalingResult> scaling_results;
        for (const auto & graphs : scaling_graphs) {
            scaling_results.push_back(
                {
                    graphs.layers,
                    time_graph(backend.get(), graphs.full, options.warmup, options.repetitions),
                    time_graph(backend.get(), graphs.attention, options.warmup, options.repetitions),
                    time_graph(backend.get(), graphs.routed, options.warmup, options.repetitions),
                    time_graph(backend.get(), graphs.shared, options.warmup, options.repetitions),
                    time_graph(
                        backend.get(), graphs.combined_ffn,
                        options.warmup, options.repetitions),
                });
        }
        const auto & schedule_timing = scaling_results.back().full;

        const double full_slope_ms = linear_slope_per_layer(
            scaling_results, &ScalingResult::full);
        const double attention_slope_ms = linear_slope_per_layer(
            scaling_results, &ScalingResult::attention);
        const double routed_slope_ms = linear_slope_per_layer(
            scaling_results, &ScalingResult::routed);
        const double shared_slope_ms = linear_slope_per_layer(
            scaling_results, &ScalingResult::shared);
        const double combined_ffn_slope_ms = linear_slope_per_layer(
            scaling_results, &ScalingResult::combined_ffn);

        float checksum = 0.0f;
        ggml_backend_tensor_get(
            scaling_graphs.back().full_root, &checksum, 0, sizeof(checksum));
        if (!std::isfinite(checksum)) {
            throw std::runtime_error("non-finite output checksum");
        }

        const size_t expert_bytes = static_cast<size_t>(pool_size)
            * (bundle_bytes(experts_a.front()) + bundle_bytes(experts_b.front())
               + bundle_bytes(experts_c.front()));
        const size_t shared_bytes = static_cast<size_t>(pool_size) * bundle_bytes(shared.front());
        const size_t attention_bytes = static_cast<size_t>(pool_size) * bundle_bytes(attention.front());
        const size_t kv_bytes = ggml_nbytes(k_cache);
        const size_t working_set_bytes = expert_bytes + shared_bytes + attention_bytes + kv_bytes;

        std::ofstream output(options.output, std::ios::out | std::ios::trunc);
        if (!output) {
            throw std::runtime_error("cannot open output: " + options.output);
        }
        output << std::fixed << std::setprecision(6);
        output << "{\n"
               << "  \"schema\": \"galactus.glm-compute-microbench.v2\",\n"
               << "  \"status\": \"measurement-complete\",\n"
               << "  \"label\": \"borne compute résidente optimiste\",\n"
               << "  \"mode\": \"" << options.mode << "\",\n"
               << "  \"backend\": \"" << ggml_backend_name(backend.get()) << "\",\n"
               << "  \"warmup\": " << options.warmup << ",\n"
               << "  \"repetitions\": " << options.repetitions << ",\n"
               << "  \"model_geometry\": {\n"
               << "    \"embedding\": 6144,\n"
               << "    \"routed_layers\": 75,\n"
               << "    \"layer_range\": [3, 77],\n"
               << "    \"layer_classes\": {\"A\": 53, \"B\": 18, \"C\": 4},\n"
               << "    \"logical_experts\": 256,\n"
               << "    \"materialized_selected_experts\": 8,\n"
               << "    \"shared_experts\": 1,\n"
               << "    \"mla_context_tokens\": 4096,\n"
               << "    \"mla_qk_dimension\": 576,\n"
               << "    \"mla_value_dimension\": 512\n"
               << "  },\n"
               << "  \"resident_working_set\": {\n"
               << "    \"pool_size_per_class\": " << pool_size << ",\n"
               << "    \"expert_bytes\": " << expert_bytes << ",\n"
               << "    \"shared_bytes\": " << shared_bytes << ",\n"
               << "    \"attention_bytes\": " << attention_bytes << ",\n"
               << "    \"kv_cache_bytes\": " << kv_bytes << ",\n"
               << "    \"total_bytes\": " << working_set_bytes << "\n"
               << "  },\n"
               << "  \"kernel_class_timings\": {\n"
               << "    \"measurement_contract\": \"one graph submission and synchronization per isolated kernel/class sample\",\n"
               << "    \"mla_4k_with_dequant\": ";
        write_timing(output, attention_timing, 4);
        output << ",\n    \"shared_ffn_with_dequant\": ";
        write_timing(output, shared_timing, 4);
        output << ",\n    \"top8_class_A_IQ1S_IQ3XXS_with_dequant\": ";
        write_timing(output, class_a_timing, 4);
        output << ",\n    \"top8_class_B_IQ2XXS_IQ3XXS_with_dequant\": ";
        write_timing(output, class_b_timing, 4);
        output << ",\n    \"top8_class_C_IQ2XXS_IQ4XS_with_dequant\": ";
        write_timing(output, class_c_timing, 4);
        output << "\n  },\n"
               << "  \"schedule_scaling\": {\n"
               << "    \"dependency_contract\": \"strict layer-to-layer; attention residual precedes routed/shared FFN; routed and shared share the same post-attention input\",\n"
               << "    \"runs\": [\n";
        for (size_t index = 0; index < scaling_results.size(); ++index) {
            const auto & result = scaling_results[index];
            output << "      {\n"
                   << "        \"layers\": " << result.layers << ",\n"
                   << "        \"full_schedule\": ";
            write_timing(output, result.full, 8);
            output << ",\n        \"attention_chain\": ";
            write_timing(output, result.attention, 8);
            output << ",\n        \"routed_chain\": ";
            write_timing(output, result.routed, 8);
            output << ",\n        \"shared_chain\": ";
            write_timing(output, result.shared, 8);
            output << ",\n        \"combined_ffn_chain\": ";
            write_timing(output, result.combined_ffn, 8);
            const double separate_sum = result.attention.p50_ms
                + result.routed.p50_ms + result.shared.p50_ms;
            const double phase_sum = result.attention.p50_ms
                + result.combined_ffn.p50_ms;
            output << ",\n        \"separate_component_chain_sum_p50_ms\": "
                   << separate_sum
                   << ",\n        \"serialized_phase_chain_sum_p50_ms\": "
                   << phase_sum
                   << ",\n        \"full_over_separate_component_sum\": "
                   << result.full.p50_ms / separate_sum
                   << ",\n        \"full_over_serialized_phase_sum\": "
                   << result.full.p50_ms / phase_sum << "\n"
                   << "      }" << (index + 1 == scaling_results.size() ? "\n" : ",\n");
        }
        output << "    ],\n"
               << "    \"linear_fit_p50_ms_per_layer\": {\n"
               << "      \"full_schedule\": " << full_slope_ms << ",\n"
               << "      \"attention_chain\": " << attention_slope_ms << ",\n"
               << "      \"routed_chain\": " << routed_slope_ms << ",\n"
               << "      \"shared_chain\": " << shared_slope_ms << ",\n"
               << "      \"combined_ffn_chain\": " << combined_ffn_slope_ms << ",\n"
               << "      \"separate_component_sum\": "
               << attention_slope_ms + routed_slope_ms + shared_slope_ms << ",\n"
               << "      \"serialized_phase_sum\": "
               << attention_slope_ms + combined_ffn_slope_ms << ",\n"
               << "      \"full_over_separate_component_sum\": "
               << full_slope_ms / (attention_slope_ms + routed_slope_ms + shared_slope_ms)
               << ",\n      \"full_over_serialized_phase_sum\": "
               << full_slope_ms / (attention_slope_ms + combined_ffn_slope_ms) << "\n"
               << "    }\n"
               << "  },\n"
               << "  \"synthetic_75_layer_schedule\": {\n"
               << "    \"timing\": ";
        write_timing(output, schedule_timing, 4);
        output << ",\n    \"optimistic_resident_tokens_per_second_p50\": "
               << 1000.0 / schedule_timing.p50_ms << ",\n"
               << "    \"checksum\": " << checksum << "\n"
               << "  },\n"
               << "  \"scope\": {\n"
               << "    \"included\": [\"quantized Metal matmul dequant\", \"top-8 routed FFN\", \"shared FFN\", \"MLA flash attention at 4k\", \"75-layer dependency chain\"],\n"
               << "    \"excluded\": [\"checkpoint loading\", \"NVMe streaming\", \"router and top-k\", \"RMSNorm\", \"DSA lightning indexer\", \"three leading dense layers\", \"MTP layer\", \"tokenizer and sampling\"],\n"
               << "    \"not_a_claim\": [\"checkpoint throughput\", \"end-to-end throughput\", \"20 tokens/s contract\"]\n"
               << "  }\n"
               << "}\n";
        output.close();
        if (!output) {
            throw std::runtime_error("failed while writing output");
        }

        std::cout << "microbench mode=" << options.mode
                  << " working_set_bytes=" << working_set_bytes
                  << " schedule_p50_ms=" << schedule_timing.p50_ms
                  << " optimistic_tps=" << 1000.0 / schedule_timing.p50_ms
                  << std::endl;
        ggml_quantize_free();
        return 0;
    } catch (const std::exception & error) {
        std::cerr << "galactus-glm-compute-microbench: " << error.what() << std::endl;
        return 2;
    }
}

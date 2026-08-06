// Sonde de parite numerique CPU vs Metal pour les noyaux mul_mat_id.
//
// Phase MESURE : quantifier la divergence AVANT tout correctif.
// Lecon v4 retenue : les blocs quantifies sont produits par
// ggml_quantize_chunk depuis des floats aleatoires (jamais des octets
// aleatoires, qui fabriquent des echelles invalides et des NaN).
// Tout NaN/inf dans une sortie est un ECHEC de la sonde.
//
// Meme graphe out = mul_mat_id(W, x, ids), memes octets d'entree,
// calcule sur le backend CPU puis sur le backend Metal, puis compare
// element par element. Q8_0 sert de temoin (attendu quasi exact).

#include "ggml.h"
#include "ggml-backend.h"
#include "ggml-cpp.h"

#include <array>
#include <cinttypes>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <random>
#include <stdexcept>
#include <vector>

namespace {

// Geometrie realiste GLM : experts [n_embd, n_ff, n_expert], top-8, 2 tokens.
constexpr int64_t n_embd       = 6144;
constexpr int64_t n_ff         = 2048;
constexpr int64_t n_expert     = 8;
constexpr int64_t experts_used = 8;
constexpr int64_t n_tokens     = 2;

// Les 6 types des tenseurs d'experts du pack GLM-5.2, puis les 5 types couvrant
// les experts de tous les modeles certifies du registre :
// gpt-oss = MXFP4, qwen3-30b/coder = Q8_0, glm-4.5-air = Q8_0+Q4_K+Q5_0,
// llama4/qwen3-235b/qwen3-next/olmoe = Q4_K+Q6_K.
constexpr std::array<ggml_type, 11> probe_types = {
    GGML_TYPE_IQ1_S,
    GGML_TYPE_IQ2_XXS,
    GGML_TYPE_IQ3_XXS,
    GGML_TYPE_IQ4_XS,
    GGML_TYPE_Q2_K,
    GGML_TYPE_Q3_K,
    GGML_TYPE_Q8_0,
    GGML_TYPE_Q5_0,
    GGML_TYPE_Q4_K,
    GGML_TYPE_Q6_K,
    GGML_TYPE_MXFP4,
};

struct Comparison {
    int64_t elements;
    int64_t identical;
    double  max_abs;
    double  max_rel;
    double  mean_rel;
};

// Poids : floats N(0, 0.5) deterministes -> blocs valides via ggml_quantize_chunk.
std::vector<uint8_t> quantize_weights(ggml_type type, const std::vector<float> & source) {
    const int64_t rows = n_ff * n_expert;
    const size_t row_bytes = ggml_row_size(type, n_embd);
    std::vector<uint8_t> quantized(row_bytes * static_cast<size_t>(rows));
    std::vector<float> imatrix(static_cast<size_t>(n_embd), 1.0f);
    const float * importance = ggml_quantize_requires_imatrix(type)
        ? imatrix.data()
        : nullptr;
    const size_t produced = ggml_quantize_chunk(
        type, source.data(), quantized.data(), 0, rows, n_embd, importance);
    if (produced != quantized.size()) {
        throw std::runtime_error("taille quantifiee inattendue pour "
                                 + std::string(ggml_type_name(type)));
    }
    return quantized;
}

// Calcule out = mul_mat_id(W, x, ids) sur un backend et rend la sortie f32.
std::vector<float> run_backend(
    ggml_backend_t backend,
    ggml_type type,
    const std::vector<uint8_t> & weights_bytes,
    const std::vector<float> & activations,
    const std::vector<int32_t> & id_values) {
    ggml_init_params parameters{};
    parameters.mem_size = 16 * 1024 * 1024;
    parameters.mem_buffer = nullptr;
    parameters.no_alloc = true;
    ggml_context_ptr context(ggml_init(parameters));
    if (!context) {
        throw std::runtime_error("ggml_init a echoue");
    }
    auto * ctx = context.get();

    auto * weights = ggml_new_tensor_3d(ctx, type, n_embd, n_ff, n_expert);
    auto * input   = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, n_embd, n_tokens);
    auto * ids     = ggml_new_tensor_2d(ctx, GGML_TYPE_I32, experts_used, n_tokens);
    auto * current = ggml_reshape_3d(ctx, input, n_embd, 1, n_tokens);
    auto * out     = ggml_mul_mat_id(ctx, weights, current, ids);

    auto * graph = ggml_new_graph(ctx);
    ggml_build_forward_expand(graph, out);

    ggml_backend_buffer_ptr buffer(ggml_backend_alloc_ctx_tensors(ctx, backend));
    if (!buffer) {
        throw std::runtime_error("allocation des tenseurs sur le backend a echoue");
    }

    if (ggml_nbytes(weights) != weights_bytes.size()) {
        throw std::runtime_error("taille des poids incoherente");
    }
    ggml_backend_tensor_set(weights, weights_bytes.data(), 0, weights_bytes.size());
    ggml_backend_tensor_set(input, activations.data(), 0,
                            activations.size() * sizeof(float));
    ggml_backend_tensor_set(ids, id_values.data(), 0,
                            id_values.size() * sizeof(int32_t));

    const auto status = ggml_backend_graph_compute(backend, graph);
    if (status != GGML_STATUS_SUCCESS) {
        throw std::runtime_error(std::string("calcul du graphe echoue sur ")
                                 + ggml_backend_name(backend) + " : "
                                 + ggml_status_to_string(status));
    }

    if (out->type != GGML_TYPE_F32) {
        throw std::runtime_error("sortie non f32");
    }
    std::vector<float> output(static_cast<size_t>(ggml_nelements(out)));
    ggml_backend_tensor_get(out, output.data(), 0, output.size() * sizeof(float));
    return output;
}

Comparison compare_outputs(
    const std::vector<float> & cpu,
    const std::vector<float> & metal) {
    if (cpu.size() != metal.size() || cpu.empty()) {
        throw std::runtime_error("tailles de sortie incoherentes");
    }
    Comparison result{static_cast<int64_t>(cpu.size()), 0, 0.0, 0.0, 0.0};
    double rel_sum = 0.0;
    for (size_t i = 0; i < cpu.size(); ++i) {
        const float a = cpu[i];
        const float b = metal[i];
        // NaN/inf n'importe ou -> comparaison vide de sens -> ECHEC.
        if (!std::isfinite(a) || !std::isfinite(b)) {
            throw std::runtime_error("valeur non finie dans une sortie (indice "
                                     + std::to_string(i) + ")");
        }
        if (std::memcmp(&a, &b, sizeof(float)) == 0) {
            ++result.identical;
        }
        const double abs_diff = std::fabs(static_cast<double>(a) - static_cast<double>(b));
        const double rel_diff = abs_diff
            / std::max(static_cast<double>(std::fabs(a)), 1e-6);
        result.max_abs = std::max(result.max_abs, abs_diff);
        result.max_rel = std::max(result.max_rel, rel_diff);
        rel_sum += rel_diff;
    }
    result.mean_rel = rel_sum / static_cast<double>(cpu.size());
    return result;
}

} // namespace

int main() {
    try {
        ggml_backend_load_all();
        ggml_backend_ptr cpu_backend(
            ggml_backend_init_by_type(GGML_BACKEND_DEVICE_TYPE_CPU, nullptr));
        if (!cpu_backend) {
            throw std::runtime_error("aucun backend CPU disponible");
        }
        ggml_backend_ptr gpu_backend(
            ggml_backend_init_by_type(GGML_BACKEND_DEVICE_TYPE_GPU, nullptr));
        if (!gpu_backend) {
            throw std::runtime_error("aucun backend GPU (Metal) disponible");
        }

        // Sources deterministes : memes octets pour les deux backends.
        std::mt19937 weight_rng(42);
        std::normal_distribution<float> weight_dist(0.0f, 0.5f);
        std::vector<float> weight_source(
            static_cast<size_t>(n_embd * n_ff * n_expert));
        for (auto & value : weight_source) {
            value = weight_dist(weight_rng);
        }

        std::mt19937 activation_rng(43);
        std::normal_distribution<float> activation_dist(0.0f, 1.0f);
        std::vector<float> activations(static_cast<size_t>(n_embd * n_tokens));
        for (auto & value : activations) {
            value = activation_dist(activation_rng);
        }

        // ids [8, 2] : chaque token route vers les experts 0..7.
        std::vector<int32_t> id_values(static_cast<size_t>(experts_used * n_tokens));
        for (int64_t token = 0; token < n_tokens; ++token) {
            for (int64_t expert = 0; expert < experts_used; ++expert) {
                id_values[static_cast<size_t>(token * experts_used + expert)] =
                    static_cast<int32_t>(expert);
            }
        }

        std::printf("Sonde de parite mul_mat_id CPU vs Metal\n");
        std::printf("CPU=%s  GPU=%s  W=[%" PRId64 ",%" PRId64 ",%" PRId64
                    "]  x=[%" PRId64 ",%" PRId64 "]  top-%" PRId64 "\n\n",
                    ggml_backend_name(cpu_backend.get()),
                    ggml_backend_name(gpu_backend.get()),
                    n_embd, n_ff, n_expert, n_embd, n_tokens, experts_used);
        std::printf("%-10s %10s %20s %14s %14s %14s\n",
                    "type", "elements", "bits identiques", "max_abs", "max_rel", "mean_rel");

        for (const ggml_type type : probe_types) {
            const auto weights_bytes = quantize_weights(type, weight_source);
            const auto cpu_output = run_backend(
                cpu_backend.get(), type, weights_bytes, activations, id_values);
            const auto metal_output = run_backend(
                gpu_backend.get(), type, weights_bytes, activations, id_values);
            const Comparison comparison = compare_outputs(cpu_output, metal_output);
            char identical_text[32];
            std::snprintf(identical_text, sizeof(identical_text),
                          "%" PRId64 "/%" PRId64,
                          comparison.identical, comparison.elements);
            std::printf("%-10s %10" PRId64 " %20s %14.6e %14.6e %14.6e\n",
                        ggml_type_name(type), comparison.elements, identical_text,
                        comparison.max_abs, comparison.max_rel, comparison.mean_rel);
        }

        ggml_quantize_free();
        return 0;
    } catch (const std::exception & error) {
        std::fprintf(stderr, "ECHEC galactus-h4-kernel-parity-probe : %s\n", error.what());
        return 1;
    }
}

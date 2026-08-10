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
//
// Balayage n_tokens : la parite est verifiee pour chaque type sur toute la
// plage de formes de micro-lot que le moteur produit reellement (1 a 512),
// et pas seulement sur le cas degenere n_tokens=2. Les activations d'un token
// donne sont identiques quel que soit n_tokens (prefixe du meme tirage), donc
// toute dependance du resultat a la forme du lot est un defaut de noyau.
//
// Balayage projection : le bloc MoE emet DEUX formes de src1 pour mul_mat_id.
// Montante (gate/up) : src1 = [n_embd, 1, n_tokens], une activation diffusee
// sur les experts routes. Descendante (down) : src1 = [n_ff, experts_used,
// n_tokens], une activation par expert route. Le noyau les distingue par
// i11 = idx % ne11 et l'activation quantifiee est indexee par i12*ne11 + i11 :
// les deux formes doivent etre couvertes.
//
// Reglages optionnels (mise au point) :
//   GALACTUS_PROBE_TOKENS=1,2,512   sous-ensemble de n_tokens
//   GALACTUS_PROBE_TYPES=q8_0,q4_K  sous-ensemble de types
//   GALACTUS_PROBE_NEMBD=2880       longueur de ligne (multiple de 64)
//   GALACTUS_PROBE_NFF=256          nombre de lignes par expert
//   GALACTUS_PROBE_NEXPERT=128      experts du tenseur
//   GALACTUS_PROBE_USED=4           experts routes par token

#include "ggml.h"
#include "ggml-backend.h"
#include "ggml-cpp.h"

#include <array>
#include <cinttypes>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <random>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {

// Geometrie realiste GLM : experts [n_embd, n_ff, n_expert], top-8.
// Tous ces parametres sont ajustables par variable d'environnement pour couvrir
// les autres modeles du registre (gpt-oss : 2880 / 2880 / 128 / 4) ; les valeurs
// par defaut restent la geometrie certifiee.
//   GALACTUS_PROBE_NEMBD   longueur de ligne (multiple de 64)
//   GALACTUS_PROBE_NFF     lignes par expert
//   GALACTUS_PROBE_NEXPERT experts du tenseur
//   GALACTUS_PROBE_USED    experts routes par token
int64_t n_embd       = 6144;
int64_t n_ff         = 2048;
int64_t n_expert     = 8;
int64_t experts_used = 8;

// Formes de micro-lot balayees : sous, a et sur la taille d'un simdgroup (32),
// puis les valeurs que le planificateur produit aujourd'hui, jusqu'a 512.
constexpr std::array<int64_t, 13> probe_tokens = {
    1, 2, 3, 4, 7, 8, 15, 16, 31, 32, 64, 128, 512,
};

constexpr int64_t max_probe_tokens = 512;

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
    int64_t bad_tokens;      // tokens portant au moins un element divergent
    int64_t first_bad_token; // -1 si aucun
};

// Decoupe "a,b,c" en une liste de chaines.
std::vector<std::string> split_list(const char * text) {
    std::vector<std::string> parts;
    std::string current;
    for (const char * p = text; ; ++p) {
        if (*p == ',' || *p == '\0') {
            if (!current.empty()) {
                parts.push_back(current);
            }
            current.clear();
            if (*p == '\0') {
                break;
            }
            continue;
        }
        current.push_back(*p);
    }
    return parts;
}

std::vector<int64_t> selected_tokens() {
    std::vector<int64_t> tokens(probe_tokens.begin(), probe_tokens.end());
    const char * env = std::getenv("GALACTUS_PROBE_TOKENS");
    if (env == nullptr || env[0] == '\0') {
        return tokens;
    }
    std::vector<int64_t> chosen;
    for (const auto & part : split_list(env)) {
        const long long value = std::strtoll(part.c_str(), nullptr, 10);
        if (value <= 0 || value > max_probe_tokens) {
            throw std::runtime_error("GALACTUS_PROBE_TOKENS hors plage : " + part);
        }
        chosen.push_back(static_cast<int64_t>(value));
    }
    return chosen;
}

std::vector<ggml_type> selected_types() {
    std::vector<ggml_type> types(probe_types.begin(), probe_types.end());
    const char * env = std::getenv("GALACTUS_PROBE_TYPES");
    if (env == nullptr || env[0] == '\0') {
        return types;
    }
    std::vector<ggml_type> chosen;
    for (const auto & part : split_list(env)) {
        bool found = false;
        for (const ggml_type type : probe_types) {
            if (part == ggml_type_name(type)) {
                chosen.push_back(type);
                found = true;
                break;
            }
        }
        if (!found) {
            throw std::runtime_error("GALACTUS_PROBE_TYPES type inconnu : " + part);
        }
    }
    return chosen;
}

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
// n_rows_per_token = 1 reproduit les projections montantes (gate/up : une
// activation par token, diffusee sur les experts routes) ; n_rows_per_token =
// experts_used reproduit la projection descendante (down : une activation
// distincte par expert route). Ces deux formes prennent des chemins d'indexage
// differents dans le noyau (i11 = idx % ne11), il faut les deux.
std::vector<float> run_backend(
    ggml_backend_t backend,
    ggml_type type,
    int64_t n_tokens,
    int64_t n_rows_per_token,
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
    auto * input   = ggml_new_tensor_3d(ctx, GGML_TYPE_F32, n_embd, n_rows_per_token, n_tokens);
    auto * ids     = ggml_new_tensor_2d(ctx, GGML_TYPE_I32, experts_used, n_tokens);
    auto * out     = ggml_mul_mat_id(ctx, weights, input, ids);

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
                            static_cast<size_t>(ggml_nbytes(input)));
    ggml_backend_tensor_set(ids, id_values.data(), 0,
                            static_cast<size_t>(ggml_nbytes(ids)));

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
    const std::vector<float> & metal,
    int64_t n_tokens) {
    if (cpu.size() != metal.size() || cpu.empty()) {
        throw std::runtime_error("tailles de sortie incoherentes");
    }
    Comparison result{static_cast<int64_t>(cpu.size()), 0, 0.0, 0.0, 0.0, 0, -1};
    // Sortie [n_ff, experts_used, n_tokens] : le token est l'axe le plus lent.
    const int64_t per_token = static_cast<int64_t>(cpu.size()) / n_tokens;
    double rel_sum = 0.0;
    int64_t last_bad_token = -1;
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
        } else {
            const int64_t token = static_cast<int64_t>(i) / per_token;
            if (result.first_bad_token < 0) {
                result.first_bad_token = token;
            }
            if (token != last_bad_token) {
                ++result.bad_tokens;
                last_bad_token = token;
            }
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
        if (const char * env_nembd = std::getenv("GALACTUS_PROBE_NEMBD")) {
            const long long value = std::strtoll(env_nembd, nullptr, 10);
            // Multiple de 64 : condition d'activation du chemin bit-exact pour
            // les types a activation Q8_0. Les types a activation Q8_K exigent
            // en plus un multiple de 256 (sinon le chemin bit-exact se desactive
            // et la comparaison mesure le noyau amont, ce qui n'a pas de sens).
            if (value <= 0 || value % 64 != 0) {
                throw std::runtime_error("GALACTUS_PROBE_NEMBD doit etre un multiple de 64");
            }
            n_embd = static_cast<int64_t>(value);
        }
        if (const char * env_nff = std::getenv("GALACTUS_PROBE_NFF")) {
            const long long value = std::strtoll(env_nff, nullptr, 10);
            if (value <= 0) {
                throw std::runtime_error("GALACTUS_PROBE_NFF invalide");
            }
            n_ff = static_cast<int64_t>(value);
        }
        if (const char * env_nexp = std::getenv("GALACTUS_PROBE_NEXPERT")) {
            const long long value = std::strtoll(env_nexp, nullptr, 10);
            if (value <= 0) {
                throw std::runtime_error("GALACTUS_PROBE_NEXPERT invalide");
            }
            n_expert     = static_cast<int64_t>(value);
            experts_used = n_expert;
        }
        if (const char * env_used = std::getenv("GALACTUS_PROBE_USED")) {
            const long long value = std::strtoll(env_used, nullptr, 10);
            if (value <= 0 || value > n_expert) {
                throw std::runtime_error("GALACTUS_PROBE_USED hors plage");
            }
            experts_used = static_cast<int64_t>(value);
        }

        const std::vector<int64_t>   tokens_sweep = selected_tokens();
        const std::vector<ggml_type> types_sweep  = selected_types();

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

        // Activations pour le plus grand lot ; les lots plus petits en prennent
        // le prefixe, donc un token donne voit exactement les memes octets quel
        // que soit n_tokens.
        std::mt19937 activation_rng(43);
        std::normal_distribution<float> activation_dist(0.0f, 1.0f);
        // Dimensionnees pour la forme descendante (experts_used lignes par
        // token) ; la forme montante en prend le prefixe.
        std::vector<float> activations_full(
            static_cast<size_t>(n_embd * experts_used * max_probe_tokens));
        for (auto & value : activations_full) {
            value = activation_dist(activation_rng);
        }

        // ids [experts_used, n_tokens]. Quand tous les experts sont routes le
        // choix est l'identite (routage historique de la sonde) ; sinon chaque
        // token tire experts_used experts DISTINCTS de facon deterministe,
        // comme le fait un top-k reel.
        std::vector<int32_t> id_values_full(
            static_cast<size_t>(experts_used * max_probe_tokens));
        std::mt19937 route_rng(44);
        std::vector<int32_t> pool(static_cast<size_t>(n_expert));
        for (int64_t expert = 0; expert < n_expert; ++expert) {
            pool[static_cast<size_t>(expert)] = static_cast<int32_t>(expert);
        }
        for (int64_t token = 0; token < max_probe_tokens; ++token) {
            if (experts_used == n_expert) {
                for (int64_t slot = 0; slot < experts_used; ++slot) {
                    id_values_full[static_cast<size_t>(token * experts_used + slot)] =
                        static_cast<int32_t>(slot);
                }
                continue;
            }
            for (int64_t slot = 0; slot < experts_used; ++slot) {
                std::uniform_int_distribution<int64_t> pick(slot, n_expert - 1);
                std::swap(pool[static_cast<size_t>(slot)],
                          pool[static_cast<size_t>(pick(route_rng))]);
                id_values_full[static_cast<size_t>(token * experts_used + slot)] =
                    pool[static_cast<size_t>(slot)];
            }
        }

        std::printf("Sonde de parite mul_mat_id CPU vs Metal\n");
        std::printf("CPU=%s  GPU=%s  W=[%" PRId64 ",%" PRId64 ",%" PRId64
                    "]  x=[%" PRId64 ",n_tokens]  top-%" PRId64 "\n",
                    ggml_backend_name(cpu_backend.get()),
                    ggml_backend_name(gpu_backend.get()),
                    n_embd, n_ff, n_expert, n_embd, experts_used);
        std::printf("balayage n_tokens :");
        for (const int64_t tokens : tokens_sweep) {
            std::printf(" %" PRId64, tokens);
        }
        std::printf("\n");
        std::printf("projections : mont (ne11=1, gate/up)  desc (ne11=%" PRId64 ", down)\n\n",
                    experts_used);
        std::printf("%-10s %5s %9s %10s %20s %14s %14s %14s %14s\n",
                    "type", "proj", "n_tokens", "elements", "bits identiques",
                    "max_abs", "max_rel", "mean_rel", "tokens KO");

        // Les deux formes de src1 du bloc MoE. Quand un seul expert est route
        // les deux formes coincident : on n'en garde qu'une.
        std::vector<std::pair<const char *, int64_t>> projections = {
            {"mont", 1},
        };
        if (experts_used > 1) {
            projections.push_back({"desc", experts_used});
        }

        int64_t failures = 0;
        int64_t cases    = 0;

        for (const ggml_type type : types_sweep) {
            const auto weights_bytes = quantize_weights(type, weight_source);

            for (const auto & projection : projections) {
                const int64_t rows_per_token = projection.second;

                for (const int64_t n_tokens : tokens_sweep) {
                    const std::vector<float> activations(
                        activations_full.begin(),
                        activations_full.begin()
                            + static_cast<size_t>(n_embd * rows_per_token * n_tokens));
                    const std::vector<int32_t> id_values(
                        id_values_full.begin(),
                        id_values_full.begin()
                            + static_cast<size_t>(experts_used * n_tokens));

                    const auto cpu_output = run_backend(
                        cpu_backend.get(), type, n_tokens, rows_per_token,
                        weights_bytes, activations, id_values);
                    const auto metal_output = run_backend(
                        gpu_backend.get(), type, n_tokens, rows_per_token,
                        weights_bytes, activations, id_values);
                    const Comparison comparison =
                        compare_outputs(cpu_output, metal_output, n_tokens);

                    ++cases;
                    if (comparison.identical != comparison.elements) {
                        ++failures;
                    }

                    char identical_text[40];
                    std::snprintf(identical_text, sizeof(identical_text),
                                  "%" PRId64 "/%" PRId64,
                                  comparison.identical, comparison.elements);
                    char first_bad_text[40];
                    if (comparison.first_bad_token < 0) {
                        std::snprintf(first_bad_text, sizeof(first_bad_text), "-");
                    } else {
                        // nombre de tokens touches, et indice du premier
                        std::snprintf(first_bad_text, sizeof(first_bad_text),
                                      "%" PRId64 " (1er %" PRId64 ")",
                                      comparison.bad_tokens, comparison.first_bad_token);
                    }
                    std::printf("%-10s %5s %9" PRId64 " %10" PRId64
                                " %20s %14.6e %14.6e %14.6e %14s\n",
                                ggml_type_name(type), projection.first, n_tokens,
                                comparison.elements, identical_text, comparison.max_abs,
                                comparison.max_rel, comparison.mean_rel, first_bad_text);
                    std::fflush(stdout);
                }
            }
        }

        std::printf("\n");
        if (failures == 0) {
            std::printf("PARITE : %" PRId64 " cas (type x projection x n_tokens), "
                        "tous les bits identiques\n", cases);
        } else {
            std::printf("PARITE ROMPUE : %" PRId64 " cas divergents sur %" PRId64 "\n",
                        failures, cases);
            // The bit-exact Metal kernels are opt-in on the host side
            // (GALACTUS_METAL_BITEXACT=1, set by start_engine). Without the
            // variable this probe measures the UPSTREAM Metal kernels, which
            // are expected to diverge, and the verdict above reads exactly
            // like a regression in the shipped path. Say which path was
            // measured rather than letting a reader guess: an audit already
            // spent a run concluding the certified numerics were broken when
            // the only thing missing was this variable.
            const char * bitexact = std::getenv("GALACTUS_METAL_BITEXACT");
            if (bitexact == nullptr || bitexact[0] != '1') {
                std::printf(
                    "note : GALACTUS_METAL_BITEXACT n'etait pas a 1, donc ce sont les noyaux "
                    "Metal AMONT qui viennent d'etre mesures, et non le chemin expedie. "
                    "Relancer avec GALACTUS_METAL_BITEXACT=1 avant de conclure a une "
                    "regression.\n");
            }
        }

        ggml_quantize_free();
        return failures == 0 ? 0 : 1;
    } catch (const std::exception & error) {
        std::fprintf(stderr, "ECHEC galactus-h4-kernel-parity-probe : %s\n", error.what());
        return 1;
    }
}

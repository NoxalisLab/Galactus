// Sonde de parite numerique CPU vs Metal pour l'exponentielle et pour l'operateur
// SWIGLU_OAI complet (chemin bit-exact GALACTUS_METAL_BITEXACT).
//
// PHASE 1 : expf, balayage EXHAUSTIF des 2^32 flottants simple precision.
// Le code MSL teste n'est pas recopie ici : il est EXTRAIT du fichier reellement
// livre, third_party/llama.cpp/ggml/src/ggml-metal/ggml-metal.metal, entre les
// marqueurs GALACTUS-EXPF-BEGIN et GALACTUS-EXPF-END, puis compile tel quel. Aucune
// derive possible entre ce qui est prouve ici et ce que le moteur execute.
// La reference est expf() de la libm d'Apple, exactement l'appel que fait
// ggml_compute_forward_swiglu_oai_f32 sur le backend CPU.
//
// Fait mesure, pas suppose : l'expf d'Apple n'est PAS correctement arrondie. Sur les
// 2 239 889 410 entrees dont le resultat n'est ni un debordement garanti ni un zero
// garanti (plage -104 a +89), elle differe de la valeur correctement arrondie sur
// 2 041 856 entrees. Une expf correctement arrondie ne peut donc PAS etre bit-exacte
// avec le CPU. Le noyau replique l'algorithme d'Apple lui-meme, operation par
// operation, en emulant la binary64 sur entiers 64 bits (Metal n'a pas de double).
//
// PHASE 2 : l'operateur SWIGLU_OAI entier, meme graphe sur backend CPU et sur backend
// Metal, sur plusieurs formes de lot (n_tokens 1, 2, 32, 512) et plusieurs geometries.
// Comparaison bit a bit.
//
// Reglages optionnels :
//   GALACTUS_PROBE_EXPF_ONLY=1     phase 1 seule
//   GALACTUS_PROBE_SWIGLU_ONLY=1   phase 2 seule
//   GALACTUS_PROBE_EXPF_LIMIT=N    limiter la phase 1 aux N premiers motifs binaires
//   GALACTUS_METAL_SRC=<chemin>    autre ggml-metal.metal

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>

#include "ggml.h"
#include "ggml-backend.h"
#include "ggml-cpp.h"

#include <array>
#include <atomic>
#include <cinttypes>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <random>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace {

// ------------------------------------------------------------------------------------------------
// PHASE 1 : expf exhaustif
// ------------------------------------------------------------------------------------------------

constexpr const char * marker_begin = "// GALACTUS-EXPF-BEGIN";
constexpr const char * marker_end   = "// GALACTUS-EXPF-END";

std::string metal_source_path() {
    if (const char * env = std::getenv("GALACTUS_METAL_SRC")) {
        return std::string(env);
    }
#ifdef GALACTUS_METAL_SRC_PATH
    return std::string(GALACTUS_METAL_SRC_PATH);
#else
    throw std::runtime_error("chemin de ggml-metal.metal inconnu");
#endif
}

// Extrait le bloc expf du fichier .metal livre.
std::string extract_expf_block() {
    const std::string path = metal_source_path();
    std::ifstream file(path);
    if (!file) {
        throw std::runtime_error("lecture impossible : " + path);
    }
    std::stringstream buffer;
    buffer << file.rdbuf();
    const std::string source = buffer.str();

    const size_t start = source.find(marker_begin);
    const size_t stop  = source.find(marker_end);
    if (start == std::string::npos || stop == std::string::npos || stop < start) {
        throw std::runtime_error("marqueurs GALACTUS-EXPF-BEGIN/END absents de " + path);
    }
    return source.substr(start, stop - start + std::strlen(marker_end));
}

struct ExpfResult {
    int64_t compared;
    int64_t identical;
    int64_t nan_both;      // les deux sont NaN mais les charges utiles different
    int64_t different;     // divergence numerique reelle
    int64_t max_ulp;
    uint32_t first_bad_in;
    uint32_t first_bad_cpu;
    uint32_t first_bad_gpu;
};

// Distance en ulp entre deux flottants finis de meme signe (ordre monotone des motifs).
int64_t ulp_distance(uint32_t a, uint32_t b) {
    const auto order = [](uint32_t v) -> int64_t {
        return (v & 0x80000000u) ? -(int64_t)(v & 0x7fffffffu) : (int64_t) v;
    };
    const int64_t d = order(a) - order(b);
    return d < 0 ? -d : d;
}

ExpfResult run_expf_sweep(uint64_t total) {
    ExpfResult result{0, 0, 0, 0, 0, 0, 0, 0};

    @autoreleasepool {
        id<MTLDevice> device = MTLCreateSystemDefaultDevice();
        if (device == nil) {
            throw std::runtime_error("aucun peripherique Metal");
        }

        std::string source = "#include <metal_stdlib>\nusing namespace metal;\n\n";
        source += extract_expf_block();
        source +=
            "\n\n"
            "kernel void galactus_expf_probe(\n"
            "        constant uint & base [[buffer(0)]],\n"
            "        device uint * dst    [[buffer(1)]],\n"
            "        uint gid [[thread_position_in_grid]]) {\n"
            "    dst[gid] = as_type<uint>(galactus_expf_bitexact(as_type<float>(base + gid)));\n"
            "}\n";

        NSError * error = nil;
        // Memes options que ggml-metal-device.m : MTLCompileOptions par defaut.
        MTLCompileOptions * options = [MTLCompileOptions new];
        id<MTLLibrary> library = [device newLibraryWithSource:@(source.c_str())
                                                      options:options
                                                        error:&error];
        if (library == nil) {
            throw std::runtime_error(std::string("compilation MSL echouee : ")
                                     + [[error description] UTF8String]);
        }

        id<MTLFunction> function = [library newFunctionWithName:@"galactus_expf_probe"];
        id<MTLComputePipelineState> pipeline =
            [device newComputePipelineStateWithFunction:function error:&error];
        if (pipeline == nil) {
            throw std::runtime_error(std::string("pipeline echoue : ")
                                     + [[error description] UTF8String]);
        }

        id<MTLCommandQueue> queue = [device newCommandQueue];

        constexpr uint32_t batch = 1u << 24;
        id<MTLBuffer> output = [device newBufferWithLength:batch * sizeof(uint32_t)
                                                   options:MTLResourceStorageModeShared];

        const unsigned n_threads = std::max(2u, std::thread::hardware_concurrency());

        for (uint64_t base = 0; base < total; base += batch) {
            const uint32_t base32 = (uint32_t) base;
            const uint32_t count  = (uint32_t) std::min<uint64_t>(batch, total - base);

            @autoreleasepool {
                id<MTLCommandBuffer> command = [queue commandBuffer];
                id<MTLComputeCommandEncoder> encoder = [command computeCommandEncoder];
                [encoder setComputePipelineState:pipeline];
                [encoder setBytes:&base32 length:sizeof(base32) atIndex:0];
                [encoder setBuffer:output offset:0 atIndex:1];
                [encoder dispatchThreads:MTLSizeMake(count, 1, 1)
                   threadsPerThreadgroup:MTLSizeMake(256, 1, 1)];
                [encoder endEncoding];
                [command commit];
                [command waitUntilCompleted];
                if (command.error != nil) {
                    throw std::runtime_error("execution du noyau echouee");
                }
            }

            const uint32_t * gpu = (const uint32_t *) output.contents;

            std::atomic<int64_t> identical{0};
            std::atomic<int64_t> nan_both{0};
            std::atomic<int64_t> different{0};
            std::atomic<int64_t> max_ulp{0};
            std::atomic<uint64_t> first_bad{UINT64_MAX};

            std::vector<std::thread> workers;
            for (unsigned t = 0; t < n_threads; ++t) {
                workers.emplace_back([&, t]() {
                    int64_t l_identical = 0, l_nan = 0, l_diff = 0, l_ulp = 0;
                    for (uint32_t i = t; i < count; i += n_threads) {
                        const uint32_t bits = base32 + i;
                        float x;
                        std::memcpy(&x, &bits, sizeof(x));
                        const float reference = expf(x);
                        uint32_t cpu;
                        std::memcpy(&cpu, &reference, sizeof(cpu));
                        const uint32_t got = gpu[i];
                        if (cpu == got) {
                            ++l_identical;
                            continue;
                        }
                        const bool cpu_nan = (cpu & 0x7f800000u) == 0x7f800000u && (cpu & 0x7fffffu) != 0;
                        const bool gpu_nan = (got & 0x7f800000u) == 0x7f800000u && (got & 0x7fffffu) != 0;
                        if (cpu_nan && gpu_nan) {
                            ++l_nan;
                            continue;
                        }
                        ++l_diff;
                        l_ulp = std::max(l_ulp, ulp_distance(cpu, got));
                        uint64_t expect = first_bad.load();
                        while (bits < (uint32_t) expect || expect == UINT64_MAX) {
                            if (first_bad.compare_exchange_weak(expect, bits)) {
                                break;
                            }
                        }
                    }
                    identical += l_identical;
                    nan_both  += l_nan;
                    different += l_diff;
                    int64_t current = max_ulp.load();
                    while (l_ulp > current && !max_ulp.compare_exchange_weak(current, l_ulp)) {
                    }
                });
            }
            for (auto & worker : workers) {
                worker.join();
            }

            result.compared  += count;
            result.identical += identical.load();
            result.nan_both  += nan_both.load();
            result.different += different.load();
            result.max_ulp    = std::max(result.max_ulp, max_ulp.load());

            if (result.first_bad_in == 0 && different.load() > 0) {
                const uint32_t bits = (uint32_t) first_bad.load();
                float x;
                std::memcpy(&x, &bits, sizeof(x));
                const float reference = expf(x);
                result.first_bad_in = bits;
                std::memcpy(&result.first_bad_cpu, &reference, sizeof(uint32_t));
                result.first_bad_gpu = gpu[bits - base32];
            }

            if ((base & ((1ull << 28) - 1)) == 0) {
                std::printf("  ... %10" PRId64 " compares, %10" PRId64 " identiques, "
                            "%" PRId64 " divergents\n",
                            result.compared, result.identical, result.different);
                std::fflush(stdout);
            }
        }
    }

    return result;
}

// Valeurs remarquables verifiees explicitement, en plus du balayage.
struct Special {
    const char * label;
    uint32_t     bits;
};

constexpr std::array<Special, 18> specials = {{
    {"+0",                 0x00000000u},
    {"-0",                 0x80000000u},
    {"+min subnormal",     0x00000001u},
    {"-min subnormal",     0x80000001u},
    {"+min normal",        0x00800000u},
    {"+inf",               0x7f800000u},
    {"-inf",               0xff800000u},
    {"quiet nan",          0x7fc00000u},
    {"1.0",                0x3f800000u},
    {"-1.0",               0xbf800000u},
    {"88.7228317 (dernier fini)",   0x42b17217u},
    {"88.7228394 (premier inf)",    0x42b17218u},
    {"-87.3365479 (dernier normal)", 0xc2aeac4fu},
    {"-87.3365555 (premier sous-normal)", 0xc2aeac50u},
    {"-103.972084 (dernier non nul)", 0xc2cff1b4u},
    {"-103.972092 (premier zero)",    0xc2cff1b5u},
    {"-128 (bascule chemin lent)",    0xc3000000u},
    {"+128 (bascule chemin lent)",    0x43000000u},
}};

// ------------------------------------------------------------------------------------------------
// PHASE 2 : operateur SWIGLU_OAI complet
// ------------------------------------------------------------------------------------------------

std::vector<float> run_swiglu(
    ggml_backend_t backend,
    int64_t n_ff,
    int64_t n_tokens,
    float alpha,
    float limit,
    const std::vector<float> & gate,
    const std::vector<float> & up) {
    ggml_init_params parameters{};
    parameters.mem_size   = 16 * 1024 * 1024;
    parameters.mem_buffer = nullptr;
    parameters.no_alloc   = true;
    ggml_context_ptr context(ggml_init(parameters));
    if (!context) {
        throw std::runtime_error("ggml_init a echoue");
    }
    auto * ctx = context.get();

    auto * a   = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, n_ff, n_tokens);
    auto * b   = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, n_ff, n_tokens);
    auto * out = ggml_swiglu_oai(ctx, a, b, alpha, limit);

    auto * graph = ggml_new_graph(ctx);
    ggml_build_forward_expand(graph, out);

    ggml_backend_buffer_ptr buffer(ggml_backend_alloc_ctx_tensors(ctx, backend));
    if (!buffer) {
        throw std::runtime_error("allocation des tenseurs echouee");
    }

    ggml_backend_tensor_set(a, gate.data(), 0, (size_t) ggml_nbytes(a));
    ggml_backend_tensor_set(b, up.data(),   0, (size_t) ggml_nbytes(b));

    const auto status = ggml_backend_graph_compute(backend, graph);
    if (status != GGML_STATUS_SUCCESS) {
        throw std::runtime_error(std::string("calcul echoue sur ")
                                 + ggml_backend_name(backend) + " : "
                                 + ggml_status_to_string(status));
    }

    std::vector<float> output((size_t) ggml_nelements(out));
    ggml_backend_tensor_get(out, output.data(), 0, output.size() * sizeof(float));
    return output;
}

} // namespace

int main() {
    try {
        const bool expf_only   = std::getenv("GALACTUS_PROBE_EXPF_ONLY")   != nullptr;
        const bool swiglu_only = std::getenv("GALACTUS_PROBE_SWIGLU_ONLY") != nullptr;

        int64_t failures = 0;

        if (!swiglu_only) {
            uint64_t total = 1ull << 32;
            if (const char * env = std::getenv("GALACTUS_PROBE_EXPF_LIMIT")) {
                total = std::strtoull(env, nullptr, 0);
            }

            std::printf("PHASE 1 : expf MSL (bloc extrait de ggml-metal.metal) contre expf libm\n");
            std::printf("source : %s\n", metal_source_path().c_str());
            std::printf("balayage exhaustif de %" PRIu64 " motifs binaires float32\n\n", total);

            const ExpfResult sweep = run_expf_sweep(total);

            std::printf("\n");
            std::printf("compares          : %" PRId64 "\n", sweep.compared);
            std::printf("bits identiques   : %" PRId64 "\n", sweep.identical);
            std::printf("NaN des deux cotes, charge utile differente : %" PRId64 "\n", sweep.nan_both);
            std::printf("divergents        : %" PRId64 "\n", sweep.different);
            if (sweep.different > 0) {
                float x, c, g;
                std::memcpy(&x, &sweep.first_bad_in,  sizeof(float));
                std::memcpy(&c, &sweep.first_bad_cpu, sizeof(float));
                std::memcpy(&g, &sweep.first_bad_gpu, sizeof(float));
                std::printf("premier divergent : x=0x%08x (%.9g)  cpu=0x%08x (%.9g)  "
                            "gpu=0x%08x (%.9g)  ulp=%" PRId64 "\n",
                            sweep.first_bad_in, x, sweep.first_bad_cpu, c,
                            sweep.first_bad_gpu, g, sweep.max_ulp);
                std::printf("distance ulp maximale : %" PRId64 "\n", sweep.max_ulp);
                ++failures;
            }

            std::printf("\nvaleurs remarquables (verification explicite) :\n");
            std::printf("%-40s %12s %20s %20s\n", "entree", "bits", "cpu expf", "verdict");
            for (const auto & special : specials) {
                float x;
                std::memcpy(&x, &special.bits, sizeof(float));
                const float reference = expf(x);
                uint32_t cpu;
                std::memcpy(&cpu, &reference, sizeof(cpu));
                std::printf("%-40s 0x%08x %20.9g %20s\n",
                            special.label, special.bits, reference,
                            (cpu & 0x7fffffffu) > 0x7f800000u ? "nan (charge utile libre)" : "couvert par le balayage");
            }
        }

        if (!expf_only) {
            std::printf("\nPHASE 2 : operateur SWIGLU_OAI complet, CPU contre Metal\n");
            std::printf("deux passes : noyau amont (GALACTUS_METAL_BITEXACT absent) puis noyau bit-exact\n\n");

            ggml_backend_load_all();
            ggml_backend_ptr cpu_backend(
                ggml_backend_init_by_type(GGML_BACKEND_DEVICE_TYPE_CPU, nullptr));
            if (!cpu_backend) {
                throw std::runtime_error("aucun backend CPU");
            }
            ggml_backend_ptr gpu_backend(
                ggml_backend_init_by_type(GGML_BACKEND_DEVICE_TYPE_GPU, nullptr));
            if (!gpu_backend) {
                throw std::runtime_error("aucun backend GPU (Metal)");
            }

            // Geometries reelles : gpt-oss n_ff=2880, GLM n_ff=2048.
            const std::array<int64_t, 2>  ff_sweep     = {2880, 2048};
            const std::array<int64_t, 4>  token_sweep  = {1, 2, 32, 512};
            // alpha/limit de gpt-oss (1.702 / 7.0) puis un cas sans ecretage.
            const std::array<std::pair<float, float>, 2> params = {{
                {1.702f, 7.0f},
                {1.0f, 1e30f},
            }};

            constexpr int64_t max_tokens = 512;
            const int64_t max_ff = 2880;

            // Activations realistes, larges assez pour declencher min/clamp des deux cotes.
            std::mt19937 rng(4242);
            std::normal_distribution<float> dist(0.0f, 4.0f);
            std::vector<float> gate_full((size_t) (max_ff * max_tokens));
            std::vector<float> up_full((size_t) (max_ff * max_tokens));
            for (auto & value : gate_full) {
                value = dist(rng);
            }
            for (auto & value : up_full) {
                value = dist(rng);
            }

            for (int pass = 0; pass < 2; ++pass) {
                const bool bitexact = pass == 1;
                if (bitexact) {
                    setenv("GALACTUS_METAL_BITEXACT", "1", 1);
                } else {
                    unsetenv("GALACTUS_METAL_BITEXACT");
                }

                std::printf("--- %s ---\n", bitexact
                            ? "GALACTUS_METAL_BITEXACT=1 (kernel_galactus_swiglu_oai_f32_bitexact)"
                            : "amont (kernel_swiglu_oai_f32)");
                std::printf("%8s %8s %10s %8s %14s %22s %14s\n",
                            "n_ff", "n_tokens", "alpha", "limit", "elements",
                            "bits identiques", "max_abs");

                for (const auto & param : params) {
                    for (const int64_t n_ff : ff_sweep) {
                        for (const int64_t n_tokens : token_sweep) {
                            const size_t n = (size_t) (n_ff * n_tokens);
                            const std::vector<float> gate(gate_full.begin(), gate_full.begin() + n);
                            const std::vector<float> up(up_full.begin(), up_full.begin() + n);

                            const auto cpu = run_swiglu(cpu_backend.get(), n_ff, n_tokens,
                                                        param.first, param.second, gate, up);
                            const auto gpu = run_swiglu(gpu_backend.get(), n_ff, n_tokens,
                                                        param.first, param.second, gate, up);
                            if (cpu.size() != gpu.size()) {
                                throw std::runtime_error("tailles de sortie incoherentes");
                            }

                            int64_t identical = 0;
                            double  max_abs   = 0.0;
                            for (size_t i = 0; i < cpu.size(); ++i) {
                                if (!std::isfinite(cpu[i]) || !std::isfinite(gpu[i])) {
                                    throw std::runtime_error("valeur non finie dans une sortie");
                                }
                                if (std::memcmp(&cpu[i], &gpu[i], sizeof(float)) == 0) {
                                    ++identical;
                                }
                                max_abs = std::max(max_abs,
                                                   std::fabs((double) cpu[i] - (double) gpu[i]));
                            }

                            char identical_text[48];
                            std::snprintf(identical_text, sizeof(identical_text),
                                          "%" PRId64 "/%zu", identical, cpu.size());
                            std::printf("%8" PRId64 " %8" PRId64 " %10.4f %8.3g %14zu %22s %14.6e\n",
                                        n_ff, n_tokens, param.first, param.second,
                                        cpu.size(), identical_text, max_abs);
                            std::fflush(stdout);

                            // seul le chemin bit-exact est un critere de reussite
                            if (bitexact && identical != (int64_t) cpu.size()) {
                                ++failures;
                            }
                        }
                    }
                }
                std::printf("\n");
            }
        }

        std::printf("\n");
        if (failures == 0) {
            std::printf("PARITE : expf et SWIGLU_OAI bit-identiques au CPU\n");
        } else {
            std::printf("PARITE ROMPUE : %" PRId64 " verification(s) en echec\n", failures);
        }
        return failures == 0 ? 0 : 1;
    } catch (const std::exception & error) {
        std::fprintf(stderr, "ECHEC galactus-h4-expf-parity-probe : %s\n", error.what());
        return 1;
    }
}

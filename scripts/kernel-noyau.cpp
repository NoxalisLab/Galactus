// Test de noyau natif (ARM) : mul_mat_id sur le MEME contenu MXFP4, une fois
// contigu (regime stock), une fois en vue a stride d'enregistrement
// (regime arene, nb[2] = 13 221 888). Vrais octets du pack gpt-oss
// (couche 0, experts 82 et 83). Toute difference incrimine le chemin de
// calcul du backend CPU de CE fork face au stride non naturel.
#include "ggml.h"
#include "ggml-cpu.h"

#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <cstring>
#include <cmath>
#include <vector>

static const size_t RECORD   = 13221888;
static const size_t ROW      = 1530;
static const int    N_EMBD   = 2880;
static const int    GU_ROWS  = 5760;
static const int    DN_ROWS  = 2880;
static const size_t DN_BYTES = (size_t) DN_ROWS * ROW;

static std::vector<unsigned char> read_file(const char * path) {
    FILE * f = std::fopen(path, "rb");
    if (!f) { std::perror(path); std::exit(2); }
    std::fseek(f, 0, SEEK_END);
    long n = std::ftell(f);
    std::fseek(f, 0, SEEK_SET);
    std::vector<unsigned char> v((size_t) n);
    if (std::fread(v.data(), 1, v.size(), f) != v.size()) { std::perror("fread"); std::exit(2); }
    std::fclose(f);
    return v;
}

static float frand(uint64_t & s) {
    s = s * 6364136223846793005ULL + 1442695040888963407ULL;
    return (float)((double)(s >> 33) / 2147483648.0 - 1.0);
}

static int compare_role(const char * label, const unsigned char * arena,
                        size_t role_offset, int rows, int n_threads) {
    const int64_t ne00 = N_EMBD, ne01 = rows, ne02 = 2;
    struct ggml_init_params params = { 512u * 1024 * 1024, nullptr, false };
    struct ggml_context * ctx = ggml_init(params);

    struct ggml_tensor * a_stock = ggml_new_tensor_3d(ctx, GGML_TYPE_MXFP4, ne00, ne01, ne02);
    for (int e = 0; e < 2; ++e) {
        std::memcpy((unsigned char *) a_stock->data + (size_t) e * rows * ROW,
                    arena + (size_t) e * RECORD + role_offset, (size_t) rows * ROW);
    }
    struct ggml_tensor * a_arena = ggml_new_tensor_3d(ctx, GGML_TYPE_MXFP4, ne00, ne01, ne02);
    a_arena->data  = (void *) (arena + role_offset);
    a_arena->nb[2] = RECORD;

    struct ggml_tensor * b = ggml_new_tensor_3d(ctx, GGML_TYPE_F32, ne00, 1, 2);
    uint64_t seed = 42;
    for (int64_t i = 0; i < ne00 * 2; ++i) ((float *) b->data)[i] = frand(seed);

    struct ggml_tensor * ids = ggml_new_tensor_2d(ctx, GGML_TYPE_I32, 1, 2);
    ((int32_t *) ids->data)[0] = 1;
    ((int32_t *) ids->data)[1] = 0;

    struct ggml_tensor * out_stock = ggml_mul_mat_id(ctx, a_stock, b, ids);
    struct ggml_tensor * out_arena = ggml_mul_mat_id(ctx, a_arena, b, ids);

    struct ggml_cgraph * gf = ggml_new_graph(ctx);
    ggml_build_forward_expand(gf, out_stock);
    ggml_build_forward_expand(gf, out_arena);
    ggml_graph_compute_with_ctx(ctx, gf, n_threads);

    const float * s = (const float *) out_stock->data;
    const float * v = (const float *) out_arena->data;
    const int64_t n = ggml_nelements(out_stock);
    double max_diff = 0; int64_t first = -1, diffs = 0;
    for (int64_t i = 0; i < n; ++i) {
        if (s[i] != v[i]) {
            ++diffs;
            if (first < 0) first = i;
            const double d = std::fabs((double) s[i] - (double) v[i]);
            if (d > max_diff) max_diff = d;
        }
    }
    double somme = 0; for (int64_t i = 0; i < n; ++i) somme += s[i];
    std::printf("%s (%d fils) : %lld elements, %lld differents",
                label, n_threads, (long long) n, (long long) diffs);
    if (diffs > 0) {
        std::printf(", premier a %lld (stock=%.9g arene=%.9g), ecart max %.3g",
                    (long long) first, s[first], v[first], max_diff);
    } else {
        std::printf(" -> BIT-IDENTIQUE (somme stock %.9g)", somme);
    }
    std::printf("\n");
    ggml_free(ctx);
    return diffs > 0 ? 1 : 0;
}

int main(int argc, char ** argv) {
    if (argc < 3) { std::fprintf(stderr, "usage: %s rec-82.bin rec-83.bin\n", argv[0]); return 2; }
    auto r82 = read_file(argv[1]);
    auto r83 = read_file(argv[2]);
    std::vector<unsigned char> arena(2 * RECORD);
    std::memcpy(arena.data(),          r82.data(), RECORD);
    std::memcpy(arena.data() + RECORD, r83.data(), RECORD);
    std::printf("arene factice : 2 enregistrements reels du pack (couche 0, experts 82 et 83)\n\n");
    int bad = 0;
    for (int threads : {1, 8}) {
        bad += compare_role("gate_up [2880 x 5760]", arena.data(), DN_BYTES, GU_ROWS, threads);
        bad += compare_role("down    [2880 x 2880]", arena.data(), 0,        DN_ROWS, threads);
    }
    std::printf("\nVERDICT NOYAU ARM : %s\n", bad == 0
        ? "stride transparent - le defaut n'est PAS dans le noyau CPU"
        : "LE STRIDE CHANGE LE RESULTAT - noyau CPU incrimine");
    return bad;
}

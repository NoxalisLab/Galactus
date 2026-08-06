// Reproducteur brutal ARM : mul_mat_id stock (ne02=128, contigu) contre arene
// (ne02=50, stride d'enregistrement 13 221 888), MEMES octets par expert via
// une bijection expert->emplacement. 2 tokens, k=4, experts partages
// frequents, milliers de motifs. Toute divergence bit a bit reproduit le
// defaut observe (colonne down deviante, ~1e-6, sporadique).
#include "ggml.h"
#include "ggml-cpu.h"

#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <cstring>
#include <cmath>
#include <vector>

static const size_t RECORD  = 13221888;
static const size_t ROW     = 1530;
static const int    N_EMBD  = 2880;
static const int    DN_ROWS = 2880;
static const size_t DN_BYTES = (size_t) DN_ROWS * ROW;
static const int    N_EXPERT = 128;
static const int    N_SLOT   = 50;
static const int    N_USED   = 4;
static const int    N_TOK    = 2;

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

static uint64_t rng_state = 42;
static uint32_t rnd() {
    rng_state = rng_state * 6364136223846793005ULL + 1442695040888963407ULL;
    return (uint32_t)(rng_state >> 33);
}
static float frnd() { return (float)((double) rnd() / 2147483648.0 - 1.0); }

int main(int argc, char ** argv) {
    if (argc < 3) { std::fprintf(stderr, "usage: %s rec82 rec83 [motifs] [fils]\n", argv[0]); return 2; }
    const int n_patterns = argc > 3 ? std::atoi(argv[3]) : 2000;
    const int n_threads  = argc > 4 ? std::atoi(argv[4]) : 8;

    auto r82 = read_file(argv[1]);
    auto r83 = read_file(argv[2]);

    std::vector<std::vector<unsigned char>> down_bytes(N_EXPERT);
    for (int e = 0; e < N_EXPERT; ++e) {
        const auto & base = (e % 2 == 0) ? r82 : r83;
        down_bytes[e].assign(base.begin(), base.begin() + DN_BYTES);
        uint64_t h = 0x9E3779B97F4A7C15ULL * (e + 1);
        for (int i = 0; i < 64; ++i) {
            h ^= h >> 33; h *= 0xFF51AFD7ED558CCDULL; h ^= h >> 29;
            const size_t block = (size_t)(h % (DN_BYTES / 17));
            down_bytes[e][block * 17 + 1 + (h % 16)] ^= (unsigned char)((h >> 40) & 0xFF);
        }
    }

    struct ggml_init_params params = { 1400u * 1024 * 1024, nullptr, false };
    struct ggml_context * ctx = ggml_init(params);
    struct ggml_init_params small_params = { 16u * 1024 * 1024, nullptr, false };

    struct ggml_tensor * a_stock = ggml_new_tensor_3d(ctx, GGML_TYPE_MXFP4, N_EMBD, DN_ROWS, N_EXPERT);
    for (int e = 0; e < N_EXPERT; ++e) {
        std::memcpy((unsigned char *) a_stock->data + (size_t) e * DN_BYTES,
                    down_bytes[e].data(), DN_BYTES);
    }

    std::vector<unsigned char> arena((size_t) N_SLOT * RECORD);
    struct ggml_tensor * a_arena = ggml_new_tensor_3d(ctx, GGML_TYPE_MXFP4, N_EMBD, DN_ROWS, N_SLOT);
    a_arena->data  = arena.data();
    a_arena->nb[2] = RECORD;

    struct ggml_tensor * b = ggml_new_tensor_3d(ctx, GGML_TYPE_F32, N_EMBD, N_USED, N_TOK);
    struct ggml_tensor * ids_stock = ggml_new_tensor_2d(ctx, GGML_TYPE_I32, N_USED, N_TOK);
    struct ggml_tensor * ids_arena = ggml_new_tensor_2d(ctx, GGML_TYPE_I32, N_USED, N_TOK);

    int bad_patterns = 0;
    for (int pat = 0; pat < n_patterns; ++pat) {
        int expert_of[N_TOK][N_USED];
        const int window = 1 + (int)(rnd() % 12);
        const int base_e = (int)(rnd() % N_EXPERT);
        for (int t = 0; t < N_TOK; ++t) {
            for (int k = 0; k < N_USED; ++k) {
                int e;
                bool dup;
                do {
                    e = (base_e + (int)(rnd() % (window + 4 * k + 1))) % N_EXPERT;
                    dup = false;
                    for (int j = 0; j < k; ++j) dup |= (expert_of[t][j] == e);
                } while (dup);
                expert_of[t][k] = e;
            }
        }
        int slot_of[N_EXPERT];
        for (int e = 0; e < N_EXPERT; ++e) slot_of[e] = -1;
        int next_slot = (int)(rnd() % N_SLOT);
        for (int t = 0; t < N_TOK; ++t)
        for (int k = 0; k < N_USED; ++k) {
            const int e = expert_of[t][k];
            if (slot_of[e] < 0) {
                slot_of[e] = next_slot;
                std::memcpy(arena.data() + (size_t) slot_of[e] * RECORD,
                            down_bytes[e].data(), DN_BYTES);
                next_slot = (next_slot + 7) % N_SLOT;
            }
        }
        for (int t = 0; t < N_TOK; ++t)
        for (int k = 0; k < N_USED; ++k) {
            ((int32_t *) ids_stock->data)[t * N_USED + k] = expert_of[t][k];
            ((int32_t *) ids_arena->data)[t * N_USED + k] = slot_of[expert_of[t][k]];
        }
        for (int64_t i = 0; i < (int64_t) N_EMBD * N_USED * N_TOK; ++i) {
            ((float *) b->data)[i] = frnd();
        }

        struct ggml_context * sctx = ggml_init(small_params);
        struct ggml_tensor * out_stock = ggml_mul_mat_id(sctx, a_stock, b, ids_stock);
        struct ggml_tensor * out_arena = ggml_mul_mat_id(sctx, a_arena, b, ids_arena);
        struct ggml_cgraph * gf = ggml_new_graph(sctx);
        ggml_build_forward_expand(gf, out_stock);
        ggml_build_forward_expand(gf, out_arena);
        ggml_graph_compute_with_ctx(sctx, gf, n_threads);

        const float * s = (const float *) out_stock->data;
        const float * v = (const float *) out_arena->data;
        const int64_t n = ggml_nelements(out_stock);
        int64_t diffs = 0, first = -1;
        double max_diff = 0;
        for (int64_t i = 0; i < n; ++i) {
            if (s[i] != v[i]) {
                ++diffs;
                if (first < 0) first = i;
                max_diff = std::fmax(max_diff, std::fabs((double) s[i] - (double) v[i]));
            }
        }
        if (diffs > 0) {
            ++bad_patterns;
            if (bad_patterns <= 8) {
                std::printf("motif %d DIVERGE : %lld/%lld elements, premier %lld, ecart max %.3g\n",
                            pat, (long long) diffs, (long long) n, (long long) first, max_diff);
                std::printf("  experts:");
                for (int t = 0; t < N_TOK; ++t) {
                    std::printf(" t%d[", t);
                    for (int k = 0; k < N_USED; ++k) std::printf("%d%s", expert_of[t][k], k+1<N_USED?" ":"");
                    std::printf("]");
                }
                std::printf("  emplacements:");
                for (int t = 0; t < N_TOK; ++t) {
                    std::printf(" t%d[", t);
                    for (int k = 0; k < N_USED; ++k) std::printf("%d%s", slot_of[expert_of[t][k]], k+1<N_USED?" ":"");
                    std::printf("]");
                }
                std::printf("\n");
                std::fflush(stdout);
            }
        }
        ggml_free(sctx);
        if ((pat + 1) % 200 == 0) {
            std::printf("  ... %d motifs, %d divergents\n", pat + 1, bad_patterns);
            std::fflush(stdout);
        }
    }

    std::printf("\nVERDICT ARM : %d motifs divergents sur %d (%d fils)\n",
                bad_patterns, n_patterns, n_threads);
    return bad_patterns > 0 ? 1 : 0;
}

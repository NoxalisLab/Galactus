// Sonde v4 : le noyau Metal juge sur de VRAIS poids.
//
// Lecon des v1-v3 : des octets aleatoires fabriquent des echelles de
// quantification invalides -> sorties inf/NaN -> |NaN| > max est toujours
// faux -> "ecart max = 0" etait VIDE DE SENS. Les verdicts v1-v3 sont annules.
//
// La v4 charge de vrais enregistrements depuis les packs (env
// GALACTUS_H4_INTERNAL / GALACTUS_H4_EXTERNAL), une couche par classe, les
// 119 emplacements remplis d'experts reels, puis compare TROIS jambes :
//   contigu-Metal, arene-Metal (pas d'enregistrement), contigu-CPU (la verite
//   de la voie -ncmoe saine). Tout NaN/inf dans une sortie est un ECHEC.

#include "h4-core.hpp"
#include "h4-reader.hpp"

#include "ggml.h"
#include "ggml-alloc.h"
#include "ggml-backend.h"
#include "ggml-cpp.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <stdexcept>
#include <string>
#include <unistd.h>
#include <vector>

namespace {

using namespace galactus::h4;

constexpr int64_t n_embd       = 6144;
constexpr int64_t n_ff_expert  = 2048;
constexpr int64_t experts_used = 8;
constexpr int64_t n_tokens     = 2;
constexpr int64_t slots        = 119;

struct ProbeClass { char name; int layer; ggml_type gate_up; ggml_type down; };
// une couche representative par classe (records geles : 9 732 096 / 11 304 960 / 13 172 736)
constexpr ProbeClass probe_classes[3] = {
    {'A', 3,  GGML_TYPE_IQ1_S,   GGML_TYPE_IQ3_XXS},
    {'B', 70, GGML_TYPE_IQ2_XXS, GGML_TYPE_IQ3_XXS},
    {'C', 75, GGML_TYPE_IQ2_XXS, GGML_TYPE_IQ4_XS},
};

void pread_exact(int descriptor, void * destination, std::uint64_t length, std::uint64_t offset) {
    auto * out = static_cast<unsigned char *>(destination);
    std::uint64_t done = 0;
    while (done < length) {
        const auto step = ::pread(descriptor, out + done, length - done,
                                  static_cast<off_t>(offset + done));
        if (step <= 0) throw std::runtime_error("pread pack");
        done += static_cast<std::uint64_t>(step);
    }
}

int count_bad(const std::vector<float> & values) {
    int bad = 0;
    for (const float v : values) if (!std::isfinite(v)) ++bad;
    return bad;
}

ggml_tensor * build_moe(ggml_context * ctx, ggml_tensor * gate, ggml_tensor * up,
                        ggml_tensor * down, ggml_tensor * ids, ggml_tensor * input) {
    auto * current = ggml_reshape_3d(ctx, input, n_embd, 1, n_tokens);
    auto * g = ggml_mul_mat_id(ctx, gate, current, ids);
    auto * u = ggml_mul_mat_id(ctx, up, current, ids);
    auto * activated = ggml_swiglu_split(ctx, g, u);
    return ggml_mul_mat_id(ctx, down, activated, ids);
}

std::uint64_t splitmix(std::uint64_t & state) {
    state += 0x9E3779B97F4A7C15ULL;
    std::uint64_t z = state;
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
    return z ^ (z >> 31);
}

}  // namespace

int main() try {
    const char * internal_path = std::getenv("GALACTUS_H4_INTERNAL");
    const char * external_path = std::getenv("GALACTUS_H4_EXTERNAL");
    if (internal_path == nullptr || external_path == nullptr) {
        throw std::runtime_error("GALACTUS_H4_INTERNAL et GALACTUS_H4_EXTERNAL sont requis");
    }
    const int internal_fd = ::open(internal_path, O_RDONLY);
    const int external_fd = ::open(external_path, O_RDONLY);
    if (internal_fd < 0 || external_fd < 0) throw std::runtime_error("packs illisibles");
    P0Layout layout(frozen_layer_record_bytes(), P0Profile::v2_7157_2843);

    ggml_backend_load_all();
    ggml_backend_ptr metal(ggml_backend_init_by_type(GGML_BACKEND_DEVICE_TYPE_GPU, nullptr));
    ggml_backend_ptr cpu(ggml_backend_init_by_type(GGML_BACKEND_DEVICE_TYPE_CPU, nullptr));
    if (!metal || !cpu) throw std::runtime_error("backend Metal ou CPU indisponible");
    ggml_backend_dev_t device = ggml_backend_get_device(metal.get());
    std::printf("backend GPU : %s — poids REELS depuis les packs\n", ggml_backend_name(metal.get()));

    int clean = 0;
    for (const auto & pc : probe_classes) {
        const std::uint32_t layer_index = static_cast<std::uint32_t>(pc.layer) - 3;
        const std::uint64_t record = frozen_layer_record_bytes()[layer_index];
        const size_t gate_bytes = ggml_row_size(pc.gate_up, n_embd) * n_ff_expert;
        const size_t up_bytes   = gate_bytes;
        const size_t down_bytes = ggml_row_size(pc.down, n_ff_expert) * n_embd;
        if (down_bytes + gate_bytes + up_bytes != record) {
            throw std::runtime_error(std::string("classe ") + pc.name + " : geometrie incoherente");
        }

        const size_t arena_bytes = record * slots;
        void * arena_memory = nullptr;
        if (posix_memalign(&arena_memory, 16384, arena_bytes) != 0) throw std::runtime_error("memalign");
        auto * arena = static_cast<unsigned char *>(arena_memory);
        // VRAIS experts : les emplacements 0..118 recoivent les experts 0..118
        for (int64_t s = 0; s < slots; ++s) {
            const auto key = (static_cast<std::uint32_t>(pc.layer) << 8) | static_cast<std::uint32_t>(s);
            const auto & location = layout.lookup(key);
            pread_exact(internal_fd, arena + s * record, location.internal_length, location.internal_offset);
            pread_exact(external_fd, arena + s * record + location.internal_length,
                        location.external_length, location.external_offset);
        }

        ggml_backend_buffer_t arena_buffer =
            ggml_backend_dev_buffer_from_host_ptr(device, arena, arena_bytes, record * slots);
        if (arena_buffer == nullptr) throw std::runtime_error("buffer_from_host_ptr");

        ggml_init_params params{};
        params.mem_size = 64 * 1024 * 1024;
        params.no_alloc = true;
        ggml_context_ptr ctx(ggml_init(params));
        auto make_arena_tensor = [&](ggml_type type, int64_t ne0, int64_t ne1, size_t offset) {
            auto * t = ggml_new_tensor_3d(ctx.get(), type, ne0, ne1, slots);
            t->nb[2] = record;
            if (ggml_backend_tensor_alloc(arena_buffer, t, arena + offset) != GGML_STATUS_SUCCESS) {
                throw std::runtime_error("tensor_alloc");
            }
            return t;
        };
        auto * arena_down = make_arena_tensor(pc.down, n_ff_expert, n_embd, 0);
        auto * arena_gate = make_arena_tensor(pc.gate_up, n_embd, n_ff_expert, down_bytes);
        auto * arena_up   = make_arena_tensor(pc.gate_up, n_embd, n_ff_expert, down_bytes + gate_bytes);

        auto * ref_gate = ggml_new_tensor_3d(ctx.get(), pc.gate_up, n_embd, n_ff_expert, slots);
        auto * ref_up   = ggml_new_tensor_3d(ctx.get(), pc.gate_up, n_embd, n_ff_expert, slots);
        auto * ref_down = ggml_new_tensor_3d(ctx.get(), pc.down, n_ff_expert, n_embd, slots);
        auto * input    = ggml_new_tensor_2d(ctx.get(), GGML_TYPE_F32, n_embd, n_tokens);
        auto * ids      = ggml_new_tensor_2d(ctx.get(), GGML_TYPE_I32, experts_used, n_tokens);
        ggml_backend_buffer_ptr side(ggml_backend_alloc_ctx_tensors(ctx.get(), metal.get()));
        if (!side) throw std::runtime_error("allocation reference Metal");
        for (int64_t s = 0; s < slots; ++s) {
            ggml_backend_tensor_set(ref_down, arena + s * record, s * ref_down->nb[2], down_bytes);
            ggml_backend_tensor_set(ref_gate, arena + s * record + down_bytes, s * ref_gate->nb[2], gate_bytes);
            ggml_backend_tensor_set(ref_up,   arena + s * record + down_bytes + gate_bytes, s * ref_up->nb[2], up_bytes);
        }
        std::uint64_t rng = 42;
        std::vector<float> input_values(n_embd * n_tokens);
        for (auto & v : input_values) {
            v = static_cast<float>(static_cast<int64_t>(splitmix(rng) % 2000) - 1000) / 1000.0f;
        }
        ggml_backend_tensor_set(input, input_values.data(), 0, input_values.size() * sizeof(float));
        const std::int32_t slot_ids[experts_used * n_tokens] = {
            117, 3, 63, 118, 42, 97, 0, 76, 5, 111, 29, 88, 118, 51, 14, 102};
        ggml_backend_tensor_set(ids, slot_ids, 0, sizeof(slot_ids));

        auto compute = [&](ggml_backend_t only, ggml_tensor * g, ggml_tensor * u,
                           ggml_tensor * d, ggml_tensor * id_t, ggml_tensor * in_t,
                           std::vector<float> & out) {
            auto * root = build_moe(ctx.get(), g, u, d, id_t, in_t);
            auto * graph = ggml_new_graph(ctx.get());
            ggml_build_forward_expand(graph, root);
            ggml_backend_t list[2] = {only, cpu.get()};
            ggml_backend_sched_ptr sched(
                ggml_backend_sched_new(list, nullptr, only == cpu.get() ? 1 : 2,
                                       GGML_DEFAULT_GRAPH_SIZE, false, true));
            ggml_backend_sched_reset(sched.get());
            if (ggml_backend_sched_graph_compute(sched.get(), graph) != GGML_STATUS_SUCCESS) {
                throw std::runtime_error("graphe en echec");
            }
            out.resize(static_cast<size_t>(ggml_nelements(root)));
            ggml_backend_tensor_get(root, out.data(), 0, out.size() * sizeof(float));
        };

        std::vector<float> metal_ref, metal_arena, cpu_truth;
        compute(metal.get(), ref_gate, ref_up, ref_down, ids, input, metal_ref);
        compute(metal.get(), arena_gate, arena_up, arena_down, ids, input, metal_arena);
        // jambe CPU : tenseurs en memoire CPU, memes octets
        {
            ggml_init_params cp{};
            cp.mem_size = 64 * 1024 * 1024;
            cp.no_alloc = true;
            ggml_context_ptr cctx(ggml_init(cp));
            auto * cg = ggml_new_tensor_3d(cctx.get(), pc.gate_up, n_embd, n_ff_expert, slots);
            auto * cu = ggml_new_tensor_3d(cctx.get(), pc.gate_up, n_embd, n_ff_expert, slots);
            auto * cd = ggml_new_tensor_3d(cctx.get(), pc.down, n_ff_expert, n_embd, slots);
            auto * ci = ggml_new_tensor_2d(cctx.get(), GGML_TYPE_F32, n_embd, n_tokens);
            auto * cid = ggml_new_tensor_2d(cctx.get(), GGML_TYPE_I32, experts_used, n_tokens);
            ggml_backend_buffer_ptr cb(ggml_backend_alloc_ctx_tensors(cctx.get(), cpu.get()));
            if (!cb) throw std::runtime_error("allocation CPU");
            for (int64_t s = 0; s < slots; ++s) {
                ggml_backend_tensor_set(cd, arena + s * record, s * cd->nb[2], down_bytes);
                ggml_backend_tensor_set(cg, arena + s * record + down_bytes, s * cg->nb[2], gate_bytes);
                ggml_backend_tensor_set(cu, arena + s * record + down_bytes + gate_bytes, s * cu->nb[2], up_bytes);
            }
            ggml_backend_tensor_set(ci, input_values.data(), 0, input_values.size() * sizeof(float));
            ggml_backend_tensor_set(cid, slot_ids, 0, sizeof(slot_ids));
            auto * root = build_moe(cctx.get(), cg, cu, cd, cid, ci);
            auto * graph = ggml_new_graph(cctx.get());
            ggml_build_forward_expand(graph, root);
            ggml_backend_t list[1] = {cpu.get()};
            ggml_backend_sched_ptr sched(
                ggml_backend_sched_new(list, nullptr, 1, GGML_DEFAULT_GRAPH_SIZE, false, true));
            if (ggml_backend_sched_graph_compute(sched.get(), graph) != GGML_STATUS_SUCCESS) {
                throw std::runtime_error("graphe CPU en echec");
            }
            cpu_truth.resize(static_cast<size_t>(ggml_nelements(root)));
            ggml_backend_tensor_get(root, cpu_truth.data(), 0, cpu_truth.size() * sizeof(float));
        }

        const int bad = count_bad(metal_ref) + count_bad(metal_arena) + count_bad(cpu_truth);
        double amplitude = 0.0, d_arena = 0.0, d_cpu = 0.0;
        for (size_t i = 0; i < cpu_truth.size(); ++i) {
            amplitude = std::max(amplitude, std::fabs(static_cast<double>(cpu_truth[i])));
            d_arena = std::max(d_arena, std::fabs(static_cast<double>(metal_arena[i] - metal_ref[i])));
            d_cpu = std::max(d_cpu, std::fabs(static_cast<double>(metal_arena[i] - cpu_truth[i])));
        }
        std::printf("classe %c (couche %d)  NaN/inf=%d  amplitude CPU=%.4g\n"
                    "    |Metal.arene - Metal.contigu| = %.6g\n"
                    "    |Metal.arene - CPU (verite)|  = %.6g   (relatif %.4g)\n",
                    pc.name, pc.layer, bad, amplitude, d_arena, d_cpu,
                    amplitude > 0 ? d_cpu / amplitude : 0.0);
        if (bad != 0) {
            std::printf("VERDICT classe %c : NaN/inf dans les sorties — ECHEC\n", pc.name);
        } else if (amplitude > 0 && d_cpu / amplitude > 0.05) {
            std::printf("VERDICT classe %c : le noyau Metal DIVERGE de la verite CPU\n", pc.name);
        } else {
            ++clean;
        }
        ggml_backend_buffer_free(arena_buffer);
        std::free(arena_memory);
    }
    ::close(internal_fd);
    ::close(external_fd);
    if (clean == 3) {
        std::printf("\nSONDE v4 : Metal == CPU sur poids reels, les trois classes. Le noyau est sain.\n");
        return 0;
    }
    return 1;
} catch (const std::exception & error) {
    std::fprintf(stderr, "erreur: %s\n", error.what());
    return 2;
}

#!/usr/bin/env python3
"""Hook MoE generique : une interception unique pour toutes les architectures.

Avant : branche specifique dans glm-dsa.cpp (ordre de creation down/gate/up
impose a la main). Apres : interception dans llama_model_base::create_tensor,
par ou passent tous les tenseurs de toutes les architectures ; les fichiers
d'architecture redeviennent STOCK. Les offsets de roles ne dependent plus de
l'ordre de creation : rang fixe (down=0, gate|gate_up=1, up=2), offsets
calcules et VALIDES contre le profil au moment de l'adossement (init).
"""
import pathlib, re, sys

root = pathlib.Path(sys.argv[1])  # third_party/llama.cpp

# ---------- 1. glm-dsa.cpp : retour au stock ----------
p = root / "src/models/glm-dsa.cpp"
t = p.read_text(encoding="utf-8")
old = t[t.index("            // MoE branch"):t.index("            }", t.index("layer.ffn_up_exps   = galactus_h4::create_exps")) + 14]
new = """            // MoE branch
            layer.ffn_gate_exps = create_tensor(tn(LLM_TENSOR_FFN_GATE_EXPS, "weight", i), {  n_embd, n_ff_exp, n_expert}, flags);
            layer.ffn_down_exps = create_tensor(tn(LLM_TENSOR_FFN_DOWN_EXPS, "weight", i), {n_ff_exp,   n_embd, n_expert}, flags);
            layer.ffn_up_exps   = create_tensor(tn(LLM_TENSOR_FFN_UP_EXPS,   "weight", i), {  n_embd, n_ff_exp, n_expert}, flags);"""
t = t.replace(old, new, 1)
t = t.replace('#include "models.h"\n#include "llama-galactus-h4.h"\n', '#include "models.h"\n', 1)
p.write_text(t, encoding="utf-8")
print("glm-dsa.cpp: stock retabli")

# ---------- 2. llama-model.cpp : interception generique + init sans gating d'arch ----------
p = root / "src/llama-model.cpp"
t = p.read_text(encoding="utf-8")
old = """ggml_tensor * llama_model_base::create_tensor(const LLM_TN_IMPL & tn, const std::initializer_list<int64_t> & ne, int flags) {
    GGML_ASSERT(ml != nullptr);
    return create_tensor(*ml, tn, ne, flags);
}"""
new = """ggml_tensor * llama_model_base::create_tensor(const LLM_TN_IMPL & tn, const std::initializer_list<int64_t> & ne, int flags) {
    GGML_ASSERT(ml != nullptr);
    // Galactus : interception generique des tenseurs d'experts routes, quelle
    // que soit l'architecture. Les fichiers de modeles restent stock ; tout
    // tenseur blk.N.ffn_{down,gate,up,gate_up}_exps.weight d'une couche sous
    // cablage nait a quota d'emplacements et sera adosse a l'arene (init).
    if (galactus_h4::active() && !ml->files.empty()) {
        const std::string name = tn.str();
        int bid = -1; char role[16] = {0};
        if (std::sscanf(name.c_str(), "blk.%d.ffn_%15[a-z_]", &bid, role) == 2) {
            std::string r(role);
            const auto pos = r.find("_exps");
            if (pos != std::string::npos && galactus_h4::wants_layer(bid)) {
                r.resize(pos);
                if (r == "down" || r == "gate" || r == "up" || r == "gate_up") {
                    const auto * meta = ml->get_tensor_meta(name.c_str());
                    if (meta != nullptr) {
                        create_tensor(*ml, tn, ne, flags | TENSOR_SKIP);
                        const auto dims = std::vector<int64_t>(ne);
                        return galactus_h4::create_exps(bid, r.c_str(), meta->type,
                                                        dims[0], dims[1]);
                    }
                }
            }
        }
    }
    return create_tensor(*ml, tn, ne, flags);
}"""
assert t.count(old) == 1
t = t.replace(old, new, 1)
old2 = """    if (galactus_h4::active() && arch == LLM_ARCH_GLM_DSA) {
        galactus_h4::init();
    }"""
new2 = """    if (galactus_h4::active()) {
        galactus_h4::init();   // sans effet si aucune couche n'est cablee
    }"""
assert t.count(old2) == 1
t = t.replace(old2, new2, 1)
p.write_text(t, encoding="utf-8")
print("llama-model.cpp: interception generique en place")

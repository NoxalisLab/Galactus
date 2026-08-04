#!/usr/bin/env python3
"""Sonde differentielle etendue : couche et cap choisis par l'environnement.

L'exhaustif couche 6 (768/768) innocente le contenu ; l'epingle innocente
l'eviction ; la deviation est deterministe. Reste UNE question : a quel
micro-lot, sur quel tenseur, le premier bit diverge. L'ancienne sonde ne
couvrait que 26 lignes de la couche 3 ; on la rend reglable :
  GALACTUS_H4_DUMP_LAYER=6   (defaut 3)
  GALACTUS_H4_DUMP_CAP=4000  (defaut 26)
"""
import pathlib, sys

path = pathlib.Path(sys.argv[1])  # third_party/llama.cpp/src/llama-galactus-h4.cpp
text = path.read_text(encoding="utf-8")

EDITS = [
    (
        """    static const char * wanted[] = {
        "ffn_moe_logits-3", "ffn_moe_probs-3", "ffn_moe_argsort-3",
        "ffn_moe_topk-3", "ffn_moe_topk_galactus-3", "ffn_moe_weights-3",
        "ffn_moe_weights_norm-3", "ffn_moe_gate-3", "ffn_moe_up-3",
        "ffn_moe_down-3", "ffn_moe_out-3", "ffn_out-3", "l_out-3",
    };
    bool match = false;
    for (const char * name : wanted) {
        if (std::strcmp(t->name, name) == 0) { match = true; break; }
    }
""",
        """    static const std::vector<std::string> wanted = [] {
        const char * layer = std::getenv("GALACTUS_H4_DUMP_LAYER");
        const std::string suffix = std::string("-") + (layer != nullptr && layer[0] != '\\0' ? layer : "3");
        const char * stems[] = {
            "ffn_moe_logits", "ffn_moe_probs", "ffn_moe_argsort",
            "ffn_moe_topk", "ffn_moe_topk_galactus", "ffn_moe_weights",
            "ffn_moe_weights_norm", "ffn_moe_gate", "ffn_moe_up",
            "ffn_moe_down", "ffn_moe_out", "ffn_out", "l_out",
        };
        std::vector<std::string> names;
        for (const char * stem : stems) names.push_back(stem + suffix);
        return names;
    }();
    bool match = false;
    for (const auto & name : wanted) {
        if (name == t->name) { match = true; break; }
    }
""",
    ),
    (
        """    static std::atomic<int> printed{0};
    if (printed.fetch_add(1) >= 26) return true;  // 2 micro-lots de 13 noms
""",
        """    static const int cap = [] {
        const char * value = std::getenv("GALACTUS_H4_DUMP_CAP");
        return value != nullptr && value[0] != '\\0' ? std::atoi(value) : 26;
    }();
    static std::atomic<int> printed{0};
    if (printed.fetch_add(1) >= cap) return true;
""",
    ),
]

for index, (old, new) in enumerate(EDITS, 1):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"edit {index}: anchor found {count} times, expected 1")
    text = text.replace(old, new, 1)
path.write_text(text, encoding="utf-8")
print("sonde etendue : couche et cap regles par l'environnement")

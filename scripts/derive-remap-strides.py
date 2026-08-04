#!/usr/bin/env python3
"""LE BUG DE PERPLEXITE (tour 238) : lecture lineaire d'une vue non contigue.

selected_experts est une VUE (ggml_top_k) : ne=[n_expert_used, n_tokens] mais
nb[1] = la rangee COMPLETE de l'argsort (n_expert entiers). remap_callback
lisait expert_ids[i] lineairement : juste pour le token 1, mais les elements
8..15 sont les rangs 9..16 du TOKEN 1, pas le top-8 du token 2. Chaque token
au-dela du premier de chaque micro-lot etait cable sur les MAUVAIS experts.
Preuve : differentiel integral 180643Z — topk/poids identiques, gate/up/down
divergents des le premier micro-lot, token 2 seulement (v0..3 et absmax
identiques, sommes decrochees). Correctif : lecture ET ecriture par strides.
"""
import pathlib, sys

path = pathlib.Path(sys.argv[1])
text = path.read_text(encoding="utf-8")

EDITS = [
    (
        """    const auto count = ggml_nelements(source);
    const auto * expert_ids = static_cast<const std::int32_t *>(source->data);
    auto * slot_ids = static_cast<std::int32_t *>(dst->data);

    std::vector<std::uint32_t> keys(static_cast<std::size_t>(count));
    for (int64_t i = 0; i < count; ++i) {
        keys[static_cast<std::size_t>(i)] = (static_cast<std::uint32_t>(layer) << 8)
                | (static_cast<std::uint32_t>(expert_ids[i]) & 0xFFu);
    }
""",
        """    const auto count = ggml_nelements(source);
    // LE BUG DE PERPLEXITE (tour 238) : selected_experts est une VUE non
    // contigue (ggml_top_k : ne=[8, n_tokens], nb[1] = rangee argsort
    // complete de n_expert). La lecture lineaire etait juste pour le premier
    // token du micro-lot et lisait, pour les suivants, les rangs 9+ du
    // PREMIER token : tout token au-dela du premier partait sur les mauvais
    // experts. Lecture par strides, rien d'autre ne change.
    const auto * source_bytes = static_cast<const unsigned char *>(source->data);
    auto * dst_bytes = static_cast<unsigned char *>(dst->data);
    std::vector<std::int32_t> expert_ids(static_cast<std::size_t>(count));
    {
        std::size_t flat = 0;
        for (int64_t i2 = 0; i2 < source->ne[2]; ++i2)
        for (int64_t i1 = 0; i1 < source->ne[1]; ++i1)
        for (int64_t i0 = 0; i0 < source->ne[0]; ++i0, ++flat) {
            expert_ids[flat] = *reinterpret_cast<const std::int32_t *>(
                source_bytes + i2 * source->nb[2] + i1 * source->nb[1] + i0 * source->nb[0]);
        }
    }

    std::vector<std::uint32_t> keys(static_cast<std::size_t>(count));
    for (int64_t i = 0; i < count; ++i) {
        keys[static_cast<std::size_t>(i)] = (static_cast<std::uint32_t>(layer) << 8)
                | (static_cast<std::uint32_t>(expert_ids[static_cast<std::size_t>(i)]) & 0xFFu);
    }
""",
    ),
    (
        """    for (int64_t i = 0; i < count; ++i) {
        const std::int16_t slot = s.store->slot_of(keys[i]);
        if (slot < 0) throw std::runtime_error("galactus_h4: cle servie sans emplacement");
        slot_ids[i] = slot;
    }
""",
        """    {
        std::size_t flat = 0;
        for (int64_t i2 = 0; i2 < dst->ne[2]; ++i2)
        for (int64_t i1 = 0; i1 < dst->ne[1]; ++i1)
        for (int64_t i0 = 0; i0 < dst->ne[0]; ++i0, ++flat) {
            const std::int16_t slot = s.store->slot_of(keys[flat]);
            if (slot < 0) throw std::runtime_error("galactus_h4: cle servie sans emplacement");
            *reinterpret_cast<std::int32_t *>(
                dst_bytes + i2 * dst->nb[2] + i1 * dst->nb[1] + i0 * dst->nb[0]) = slot;
        }
    }
""",
    ),
]

for index, (old, new) in enumerate(EDITS, 1):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"edit {index}: anchor found {count} times, expected 1")
    text = text.replace(old, new, 1)
path.write_text(text, encoding="utf-8")
print("remap par strides : chaque token du micro-lot lit SES experts")

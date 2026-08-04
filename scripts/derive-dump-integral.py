#!/usr/bin/env python3
"""Couverture TOTALE de la sonde differentielle.

Paradoxe du run 173725Z : l_out-6 "identique" sur 257 micro-lots mais PPL
2,6373 contre 2,5993 — impossible si l_out etait vraiment identique. Cause :
la sonde ne lisait que min(count, 4096) elements ; l_out fait 6144 x 2 =
12288, le token 2 de chaque micro-lot n'etait JAMAIS compare. On lit tout et
on imprime une empreinte fnv1a64 de tous les octets.
"""
import pathlib, sys

path = pathlib.Path(sys.argv[1])
text = path.read_text(encoding="utf-8")

EDITS = [
    (
        """    const auto count = ggml_nelements(t);
    std::vector<float> values(static_cast<std::size_t>(std::min<int64_t>(count, 4096)));
    if (t->type == GGML_TYPE_F32) {
        ggml_backend_tensor_get(t, values.data(), 0, values.size() * sizeof(float));
    } else if (t->type == GGML_TYPE_I32) {
        std::vector<std::int32_t> raw(values.size());
        ggml_backend_tensor_get(t, raw.data(), 0, raw.size() * sizeof(std::int32_t));
        for (std::size_t i = 0; i < raw.size(); ++i) values[i] = static_cast<float>(raw[i]);
    } else {
""",
        """    const auto count = ggml_nelements(t);
    // Lecture INTEGRALE : l'ancienne borne 4096 laissait le token 2 des
    // micro-lots (l_out = 6144 x 2 = 12288 elements) hors comparaison.
    std::vector<float> values(static_cast<std::size_t>(count));
    std::uint64_t digest = 0;
    if (t->type == GGML_TYPE_F32) {
        ggml_backend_tensor_get(t, values.data(), 0, values.size() * sizeof(float));
        digest = fnv1a64(reinterpret_cast<const unsigned char *>(values.data()),
                         values.size() * sizeof(float));
    } else if (t->type == GGML_TYPE_I32) {
        std::vector<std::int32_t> raw(values.size());
        ggml_backend_tensor_get(t, raw.data(), 0, raw.size() * sizeof(std::int32_t));
        digest = fnv1a64(reinterpret_cast<const unsigned char *>(raw.data()),
                         raw.size() * sizeof(std::int32_t));
        for (std::size_t i = 0; i < raw.size(); ++i) values[i] = static_cast<float>(raw[i]);
    } else {
""",
    ),
    (
        """    std::fprintf(stderr,
        "galactus_dump: %-26s ne=[%lld,%lld,%lld] absmax=%.9g somme=%.9g v0..3=[%.9g %.9g %.9g %.9g]\\n",
        t->name, (long long) t->ne[0], (long long) t->ne[1], (long long) t->ne[2],
        absmax, sum, values.size() > 0 ? values[0] : 0.0f, values.size() > 1 ? values[1] : 0.0f,
        values.size() > 2 ? values[2] : 0.0f, values.size() > 3 ? values[3] : 0.0f);
""",
        """    std::fprintf(stderr,
        "galactus_dump: %-26s ne=[%lld,%lld,%lld] empreinte=%016llx absmax=%.9g somme=%.9g v0..3=[%.9g %.9g %.9g %.9g]\\n",
        t->name, (long long) t->ne[0], (long long) t->ne[1], (long long) t->ne[2],
        (unsigned long long) digest,
        absmax, sum, values.size() > 0 ? values[0] : 0.0f, values.size() > 1 ? values[1] : 0.0f,
        values.size() > 2 ? values[2] : 0.0f, values.size() > 3 ? values[3] : 0.0f);
""",
    ),
]

for index, (old, new) in enumerate(EDITS, 1):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"edit {index}: anchor found {count} times, expected 1")
    text = text.replace(old, new, 1)
path.write_text(text, encoding="utf-8")
print("sonde integrale : tout le tenseur lu, empreinte sur tous les octets")

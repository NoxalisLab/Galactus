#include "h4-profile.hpp"
#include "h4-core.hpp"

#include <algorithm>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <stdexcept>

namespace galactus::h4 {

namespace {

ModelProfile builtin_glm52() {
    ModelProfile p;
    p.architecture = "glm-dsa";
    p.first_layer = 3;
    p.last_layer = 77;
    p.experts = 256;
    p.used = 8;
    // Classes gelees du packer GLM-5.2 : A=9 732 096, B=11 304 960, C=13 172 736.
    static constexpr std::uint32_t kB[] = {6, 9, 29, 39, 40, 41, 42, 43, 44, 45,
                                           46, 47, 48, 68, 70, 72, 73, 74};
    static constexpr std::uint32_t kC[] = {8, 75, 76, 77};
    for (std::uint32_t layer = 3; layer <= 77; ++layer) {
        std::uint64_t record = 9'732'096;
        for (auto b : kB) if (layer == b) record = 11'304'960;
        for (auto c : kC) if (layer == c) record = 13'172'736;
        p.record_bytes.push_back(record);
        p.record_bytes_raw.push_back(record);
    }
    return p;
}

void validate(const ModelProfile & p, const std::string & origin) {
    auto fail = [&](const std::string & why) {
        throw std::runtime_error("profil (" + origin + "): " + why);
    };
    if (p.first_layer > p.last_layer) fail("plage de couches inversee");
    if (p.experts == 0 || p.experts > key_expert_capacity)
        fail("experts hors [1," + std::to_string(key_expert_capacity) + "] (encodage des clefs)");
    if (p.used == 0 || p.used > p.experts) fail("experts actifs incoherents");
    if (p.record_bytes.size() != p.layer_count()) fail("nombre d'enregistrements != nombre de couches");
    if (p.record_bytes_raw.size() != p.record_bytes.size()) fail("tables raw/pad incoherentes");
    for (std::size_t i = 0; i < p.record_bytes.size(); ++i) {
        if (p.record_bytes[i] == 0 || p.record_bytes[i] % record_alignment_bytes != 0)
            fail("record non multiple de 16 KiB, couche " + std::to_string(p.first_layer + i));
        if (p.record_bytes_raw[i] == 0 || p.record_bytes_raw[i] > p.record_bytes[i])
            fail("record utile > record pad, couche " + std::to_string(p.first_layer + i));
    }
}

}  // namespace

std::uint64_t ModelProfile::max_record_bytes() const noexcept {
    return record_bytes.empty() ? 0
        : *std::max_element(record_bytes.begin(), record_bytes.end());
}

ModelProfile ModelProfile::load(const std::string & path) {
    std::ifstream in(path);
    if (!in) throw std::runtime_error("profil illisible: " + path);
    std::string magic; int version = 0;
    in >> magic >> version;
    if (magic != "galactus-profile" || version != 1)
        throw std::runtime_error("profil (" + path + "): en-tete inconnu");
    ModelProfile p;
    bool ended = false;
    std::string key;
    while (in >> key) {
        if (key == "arch") in >> p.architecture;
        else if (key == "first_layer") in >> p.first_layer;
        else if (key == "last_layer") in >> p.last_layer;
        else if (key == "experts") in >> p.experts;
        else if (key == "used") in >> p.used;
        else if (key == "align") {
            std::uint64_t a = 0; in >> a;
            if (a != record_alignment_bytes)
                throw std::runtime_error("profil (" + path + "): alignement != 16 KiB");
        } else if (key == "layer") {
            std::uint32_t layer = 0; std::string t1, t2;
            std::uint64_t rec = 0, raw = 0;
            in >> layer >> t1 >> rec >> t2 >> raw;
            if (t1 != "record" || t2 != "raw")
                throw std::runtime_error("profil (" + path + "): ligne layer malformee");
            const std::size_t expected = p.first_layer + p.record_bytes.size();
            if (layer != expected)
                throw std::runtime_error("profil (" + path + "): couches non contigues a "
                                         + std::to_string(layer));
            p.record_bytes.push_back(rec);
            p.record_bytes_raw.push_back(raw);
        } else if (key == "end") { ended = true; break; }
        else throw std::runtime_error("profil (" + path + "): clef inconnue " + key);
        if (!in) throw std::runtime_error("profil (" + path + "): lecture interrompue");
    }
    if (!ended) throw std::runtime_error("profil (" + path + "): fin de fichier sans 'end'");
    validate(p, path);
    return p;
}

const ModelProfile & ModelProfile::active() {
    static const ModelProfile instance = [] {
        const char * env = std::getenv("GALACTUS_PROFILE");
        if (env != nullptr && env[0] != '\0') {
            return load(env);
        }
        ModelProfile p = builtin_glm52();
        validate(p, "builtin glm-5.2");
        return p;
    }();
    return instance;
}

}  // namespace galactus::h4

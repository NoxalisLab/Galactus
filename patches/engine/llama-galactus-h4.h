// Cablage Galactus H4 : le magasin d'experts resident branche dans llama.cpp.
//
// Inactif par defaut : sans GALACTUS_H4=1 dans l'environnement, chaque
// fonction repond « non » et le binaire est strictement identique a l'amont.
//
// Variables d'environnement :
//   GALACTUS_H4=1                  activer
//   GALACTUS_H4_INTERNAL=<chemin>  pack interne  (h4-p0v2-internal.pack)
//   GALACTUS_H4_EXTERNAL=<chemin>  pack externe  (h4-p0v2-external.pack)
//   GALACTUS_H4_CACHE_BYTES=N      budget d'arene (defaut 99868171264)
//   GALACTUS_H4_QD=N               profondeur de file du lecteur (defaut 32)

#pragma once

#include "ggml.h"
#include "ggml-backend.h"

#include <cstdint>

namespace galactus_h4 {

// GALACTUS_H4=1 present dans l'environnement.
bool active();

// La couche est-elle sur le chemin MoE decode (3..77) ?
bool wants_layer(int layer);

// Cote chargeur : cree le tenseur d'experts d'une matrice (« down », « gate »,
// « up ») pour une couche, a ne[2] = quota, au pas de l'enregistrement du
// pack, dans le contexte prive du cablage. L'adossement a l'arene se fait
// dans init(). Lance si la geometrie contredit les constantes gelees.
ggml_tensor * create_exps(int layer, const char * role, ggml_type type,
                          int64_t ne0, int64_t ne1);

// Apres le chargement : allouer l'arene (via le magasin), l'envelopper en
// tampon Metal sans copie, adosser tous les tenseurs crees, construire le
// lecteur double-volume. Lance en cas d'echec — jamais de demi-etat.
void init();

// Cote graphe : insere le noeud CPU qui sert la couche (cache + lectures)
// et reecrit les identifiants d'experts en numeros d'emplacement.
ggml_tensor * remap_ids(ggml_context * ctx, ggml_tensor * selected_experts, int layer);

// Sonde de diagnostic : imprime une fois ce que le graphe voit vraiment.
void debug_probe(const ggml_tensor * gate, const ggml_tensor * up,
                 const ggml_tensor * down, int layer);

// Sonde differentielle (GALACTUS_H4_DUMP=1) : rappel d'evaluation qui imprime
// les tenseurs intermediaires du MoE de la couche 3. Active aussi sans cablage.
bool dump_requested();
bool dump_callback(ggml_tensor * t, bool ask, void * user_data);

// Observation only (GALACTUS_H4_ROUTES with GALACTUS_H4_ROUTES_RANKS=1): an
// evaluation callback that reads the full MoE argsort of each layer after it
// has been computed, so the ranks below the top-k cut can be studied. It writes
// to nothing the graph reads.
bool routes_ranks_requested();
bool routes_ranks_callback(ggml_tensor * t, bool ask, void * user_data);

// Statistiques cumulees, pour le rapport de fin de generation.
struct Stats {
    std::uint64_t served_layers;
    std::uint64_t hits;
    std::uint64_t misses;
    std::uint64_t bytes_read;
};
Stats stats();

}  // namespace galactus_h4

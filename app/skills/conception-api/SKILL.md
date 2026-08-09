---
name: conception-api
description: "Concevoir ou réviser une API HTTP : URLs, statuts, pagination, versions, OpenAPI."
---

Une API est un contrat que tu ne pourras plus casser. Le travail consiste à écrire ce contrat, à le rendre lisible par une machine, et à prouver qu'il tient.

## 0. Cadre en cinq lignes ; avant toute URL
Établis, et fais valider : qui appelle (client interne, partenaire, public), combien d'appels par jour, quelles ressources existent réellement dans le domaine, quelles opérations, et si l'API remplace une existante. Sans le consommateur, tu concevras une API pour toi et pas pour lui.
Une API existe déjà ? Lis-la avant de proposer : `find_files` pour trouver `openapi.yaml`, `swagger.json`, les fichiers de routes, puis `read_file`. Ne propose jamais une convention qui contredit celle du projet sans le dire.

## 1. Ressources et URLs
- Un nom de ressource au **pluriel**, en minuscules, tirets pour les mots composés : `/purchase-orders`, pas `/getPurchaseOrder`.
- Le verbe est dans la méthode HTTP, jamais dans l'URL. `GET /orders/42`, pas `POST /getOrder`.
- Deux niveaux d'imbrication au maximum : `/orders/42/items`. Au delà, expose la ressource à la racine avec un filtre : `/items?order_id=42`.
- Une action qui n'est pas un CRUD est une ressource d'action : `POST /orders/42/cancellation`, et non `POST /orders/42/cancel`. Si le domaine impose un verbe, assume-le et documente-le.
- Identifiants opaques. Un identifiant séquentiel révèle ton volume d'affaires et se devine.

## 2. Méthodes, statuts, idempotence
| Cas | Méthode | Statut | Corps |
|---|---|---|---|
| Lecture d'une collection | GET | 200 | objet avec `data` et `page`, jamais un tableau nu |
| Lecture absente | GET | 404 | erreur structurée |
| Création | POST | 201 + en-tête `Location` | la ressource créée |
| Remplacement complet | PUT | 200 | la ressource |
| Modification partielle | PATCH | 200 | la ressource |
| Suppression | DELETE | 204 | vide |
| Traitement différé | POST | 202 | l'URL de suivi |
| Entrée invalide | toutes | 400 ou 422 | erreur avec le champ fautif |
| Non authentifié / non autorisé | toutes | 401 / 403 | ne jamais confondre les deux |
| Conflit d'état | POST, PATCH | 409 | ce qui entre en conflit |
| Quota dépassé | toutes | 429 + `Retry-After` | |

GET, PUT et DELETE sont idempotents : c'est une obligation, pas un style. POST ne l'est pas : prévois un en-tête de clé d'idempotence sur tout POST qui déplace de l'argent ou crée un effet externe.

## 3. Erreurs ; un seul format pour toute l'API
```json
{"error":{"code":"order_already_shipped","message":"L'ordre 42 est deja expedie.","field":null,"request_id":"01J..."}}
```
- `code` est une chaîne stable, lisible par une machine, jamais un numéro. C'est ce sur quoi le client branchera sa logique.
- `message` est pour un humain et peut changer ; il ne doit JAMAIS contenir de trace d'exécution, de requête SQL, de chemin de fichier ni de nom de serveur.
- Erreur de validation : liste des champs fautifs, un objet par champ.
- `request_id` présent partout, et journalisé côté serveur : c'est ce qui rend une réclamation traitable.

## 4. Pagination, filtres, tri
- Pagination par curseur pour tout ce qui grossit : `?limit=50&cursor=OPAQUE`, réponse `{"data":[…],"next_cursor":"…"}`. La pagination par `offset` saute et duplique des lignes dès qu'il y a des écritures concurrentes.
- `limit` toujours plafonné côté serveur ; documente le plafond et la valeur par défaut.
- Filtres explicitement nommés, jamais un langage de requête libre exposé au client.
- Tri sur une liste blanche de champs indexés, sinon tu offres un déni de service.

## 5. Le contrat OpenAPI ; c'est le livrable
- Écris `openapi.yaml` avec `write_file`, avant l'implémentation. Chaque opération porte : `operationId`, paramètres, schéma de requête, schémas de réponse par code, et au moins un exemple.
- Valide la syntaxe, sans dépendance externe :
```
run_command("python3 -c \"import json,sys; sys.exit(0)\"")
run_command("python3 - <<'EOF'
import sys
try:
    import yaml
except ImportError:
    print('pyyaml absent, validation limitee'); sys.exit(0)
print('ok') if yaml.safe_load(open('openapi.yaml')) else None
EOF")
```
pyyaml n'est pas garanti dans le python3 embarqué. Absent : convertis en JSON et valide avec `python3 -m json.tool`, ou propose un venv local. Ne prétends jamais avoir validé un fichier que tu n'as pas fait relire par un outil.
- Deux exemples de bout en bout dans la doc : la requête `curl` complète et la réponse exacte. Une API sans exemple copiable ne sera pas adoptée.

## 6. Vérification contre le code
Quand une implémentation existe, prouve que le contrat correspond :
```
run_command("curl -sS -o /dev/null -w '%{http_code}\\n' -X GET 'http://127.0.0.1:PORT/v1/orders?limit=1'")
run_command("curl -sS -X POST 'http://127.0.0.1:PORT/v1/orders' -H 'Content-Type: application/json' -d '{}' | head -c 2000")
```
Teste au minimum : le cas nominal, un corps invalide, une ressource inexistante, et une requête sans authentification. Tout écart entre le contrat et l'observé est un défaut du contrat OU du code : signale-le, ne le corrige pas en silence.

## Garde-fous
- Versionne dès la première version : `/v1/` dans le chemin. Ajouter un champ optionnel n'est pas cassant ; retirer un champ, renommer, changer un type, restreindre une valeur ou changer un statut le sont, et exigent `/v2/`.
- Ne mets jamais de secret, de jeton ni de donnée personnelle dans une URL : les URLs finissent dans les logs, les référents et l'historique.
- N'invente jamais un endpoint existant. Si tu affirmes qu'une route existe, ouvre le fichier de routes et cite `chemin:ligne`.
- Ne conçois pas l'API depuis le schéma de base de données : exposer tes tables te condamne à ne plus pouvoir les changer.
- Restitution finale : le tableau des endpoints (méthode, chemin, statuts, idempotence), le chemin du fichier de contrat écrit, les points laissés ouverts, et ce qui n'a pas été vérifié contre du code réel.

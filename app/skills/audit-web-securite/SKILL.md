---
name: audit-web-securite
description: "Auditer une app web ou API que tu héberges : en-têtes, TLS, cookies, méthodes, fichiers exposés."
---

Tu audites un service que l'utilisateur possède. **C'est un constat en lecture seule, pas un test d'intrusion.** Chaque requête est passive : on lit ce que le serveur répond, on ne provoque rien. Aucune injection, aucun contournement, aucune charge utile hostile.

## 0. Confirme la cible et la portée
Une seule chose à établir avant la première requête : l'hôte appartient bien à l'utilisateur.
- Demande l'URL exacte (schéma, hôte, port) et fais confirmer que c'est SON service.
- Un hôte tiers, un sous-domaine loué, un CDN mutualisé : hors périmètre, arrête-toi.
- Travaille sur l'URL de production réelle, pas sur une supposition. Ne devine jamais un sous-domaine.

## 1. En-têtes de sécurité ; un seul aller-retour
```
run_command("curl -sSI -m 10 https://HOTE/ | tr -d '\\r'")
```
Cette réponse contient presque tout. Confronte-la à la liste, et pour chaque en-tête absent, dis ce que ça expose :
| En-tête attendu | Absence : ce que ça expose |
|---|---|
| `Strict-Transport-Security` | rétrogradation en HTTP, interception au premier appel ; vise `max-age>=31536000; includeSubDomains` |
| `Content-Security-Policy` | XSS non contenu, injection de scripts tiers ; une CSP même imparfaite vaut mieux qu'aucune |
| `X-Frame-Options` (ou `frame-ancestors` en CSP) | clickjacking par mise en cadre |
| `X-Content-Type-Options: nosniff` | interprétation MIME détournée d'un fichier uploadé |
| `Referrer-Policy` | fuite d'URL complète (jetons en query) vers les sites tiers |
| `Permissions-Policy` | caméra, micro, géoloc accessibles sans restriction aux scripts |
Signale aussi les en-têtes bavards : `Server:`, `X-Powered-By:`, `X-AspNet-Version:` divulguent la pile et sa version, ce qui oriente un attaquant vers les CVE connues.

## 2. TLS ; version, suite, expiration
```
run_command("echo | openssl s_client -connect HOTE:443 -servername HOTE 2>/dev/null | openssl x509 -noout -dates -subject -issuer")
```
Lis : la date `notAfter` (un certificat qui expire sous 21 jours est une alerte), le `subject` (correspond-il à l'hôte), l'`issuer`. Puis la version du protocole et la suite négociée :
```
run_command("curl -sS -m 10 -o /dev/null -w 'tls=%{ssl_version} cipher=%{ssl_cipher} code=%{http_code}\\n' https://HOTE/")
```
TLS 1.0 et 1.1 sont à proscrire ; vise TLS 1.2 au minimum, 1.3 de préférence. Une suite avec `RC4`, `3DES` ou `CBC` sur du 1.2 est faible.

## 3. Cookies ; les trois drapeaux
```
run_command("curl -sSI -m 10 https://HOTE/ | grep -i '^set-cookie'")
```
Pour chaque cookie de session, exige les trois : `Secure` (jamais transmis en clair), `HttpOnly` (hors de portée du JavaScript, donc du XSS), `SameSite=Lax` ou `Strict` (barrière CSRF). Un cookie de session sans `HttpOnly` est le plus grave : un seul XSS suffit alors à voler la session.

## 4. Méthodes autorisées et divulgation
```
run_command("curl -sSI -m 10 -X OPTIONS https://HOTE/ | grep -i '^allow'")
```
`PUT`, `DELETE`, `TRACE`, `PATCH` exposés sur une racine publique sont à questionner : `TRACE` ouvre le Cross-Site Tracing, les autres ne devraient pas être joignables sans authentification. Rappelle la version divulguée relevée à l'étape 1.

## 5. Fichiers sensibles exposés ; requêtes ciblées, non destructives
On vérifie l'exposition par un simple code de statut, sans jamais télécharger ni interpréter le contenu.
```
run_command("for p in .git/HEAD .env .env.local config.php.bak server-status .DS_Store backup.sql phpinfo.php; do code=$(curl -sS -m 8 -o /dev/null -w '%{http_code}' \"https://HOTE/$p\"); echo \"$code  /$p\"; done")
```
Un `200` sur `.git/HEAD`, `.env` ou `server-status` est une divulgation grave : le dépôt entier ou les secrets d'environnement sont potentiellement lisibles. Un `403` est acceptable mais signale que le fichier existe. **Ne récupère jamais le contenu de ces fichiers** : le code de statut suffit au constat. Si une réponse laisse fuir un secret dans ses en-têtes, masque-le.

## Restitution
Un tableau unique, trié par gravité : constat, niveau (critique / élevé / moyen / faible), recommandation concrète (la directive ou la ligne de configuration à poser). Termine par ce que l'audit ne couvre PAS : logique applicative, authentification, autorisation fine, qui exigent un test dédié et le consentement explicite.

## Garde-fous
- Uniquement les hôtes de l'utilisateur, confirmés à l'étape 0. Jamais un tiers, jamais « pour voir ».
- Tout est en lecture seule : `curl -I`, `OPTIONS`, un code de statut. Jamais d'injection, de fuzzing, de brute-force, de charge utile.
- Ne teste jamais une faille en l'exploitant. Tu constates l'absence d'un en-tête, tu ne montes pas l'attaque qu'elle permet.
- Ne télécharge ni ne recopie le contenu d'un fichier sensible : le seul statut HTTP est le constat.
- Un secret aperçu dans une réponse (jeton, clé, mot de passe) se masque immédiatement ; cite-le par nature, jamais par valeur.
- Restitution finale : la cible auditée, le tableau constat / niveau / recommandation, et le périmètre non couvert.

---
name: kubernetes
description: "Kubernetes : pod qui ne démarre pas, manifeste, service injoignable, déploiement."
---

Sur un cluster, une commande n'affecte pas ta machine mais un environnement partagé. **Lecture d'abord, écriture ensuite, jamais dans le même appel.**

## 0. Le contexte, avant la première commande
```
run_command("kubectl config current-context; kubectl config get-contexts -o name")
```
- `kubectl` absent : dis-le et arrête-toi.
- **Lis le contexte à voix haute à l'utilisateur et fais-le confirmer** avant toute action d'écriture. La cause n°1 d'incident est une commande juste envoyée au mauvais cluster.
- Fixe le namespace explicitement dans CHAQUE commande (`-n NAMESPACE`). Ne t'appuie jamais sur le namespace par défaut.
- 120 s de plafond, aucune interactivité : pas de `kubectl exec -it`, pas de `logs -f`, pas de `port-forward` (ils ne rendent jamais la main). `kubectl exec` sans `-it`, oui.
- Ajoute `--request-timeout=20s` : une commande contre un cluster injoignable échoue proprement au lieu d'attendre.

## 1. Diagnostic d'état ; un seul aller-retour
```
run_command("kubectl -n NS --request-timeout=20s get pods -o wide; echo '== events'; kubectl -n NS get events --sort-by=.lastTimestamp | tail -20")
```
Restitue un tableau : pod, état, redémarrages, âge, noeud. Signale tout pod qui n'est pas `Running`, tout compteur de redémarrages non nul, tout `Ready` incomplet (`1/2`).
Les `events` répondent à la majorité des questions : lis-les avant d'ouvrir le moindre log.

## 2. Un pod ne démarre pas ; la table de décision
```
run_command("kubectl -n NS describe pod NOM | tail -40")
```
| État | Cause | Ce qu'il faut regarder |
|---|---|---|
| `Pending` | aucun noeud ne peut l'accueillir | `describe`, section Events : ressources insuffisantes, `nodeSelector`, `taint`, PVC non lié |
| `ImagePullBackOff` | image introuvable ou registre non autorisé | le tag exact, et le `imagePullSecrets` du namespace |
| `CrashLoopBackOff` | le conteneur sort tout de suite | `kubectl -n NS logs NOM --previous --tail=60` (le `--previous` est la clé, les logs actuels sont vides) |
| `OOMKilled` | dépassement de `resources.limits.memory` | `describe`, `Last State`. Augmenter la limite, ou corriger la fuite |
| `CreateContainerConfigError` | une ConfigMap ou un Secret référencé n'existe pas | `kubectl -n NS get configmap,secret` |
| `Running` mais `0/1 Ready` | la readiness probe échoue | le chemin, le port et le délai de la sonde ; le service ne reçoit rien tant qu'elle échoue |
| `Terminating` bloqué | un finalizer, ou un `terminationGracePeriodSeconds` long | `describe`, ne force la suppression qu'en dernier recours et avec accord |

## 3. Un service n'est pas joignable ; dans cet ordre
```
run_command("kubectl -n NS get svc NOM -o wide; kubectl -n NS get endpoints NOM")
```
1. **Endpoints vides** : le sélecteur du Service ne correspond à aucun pod prêt. Compare `spec.selector` du Service et les labels du pod. C'est la cause de loin la plus fréquente.
2. Endpoints présents mais rien ne répond : le `targetPort` ne correspond pas au port réel du conteneur.
3. Ça marche dans le cluster mais pas dehors : regarde l'Ingress (`kubectl -n NS describe ingress`), l'hôte, le chemin, le certificat.
4. Test depuis l'intérieur, sans interactivité :
```
run_command("kubectl -n NS run diag-$RANDOM --rm --restart=Never --image=curlimages/curl --command -- curl -sS -m 5 -o /dev/null -w '%{http_code}' http://SERVICE:PORT/health")
```
Ce pod jetable crée une ressource : annonce-le avant.

## 4. Relire un manifeste
Vérifie, dans cet ordre, et signale chaque manque :
1. `resources.requests` ET `resources.limits` sur chaque conteneur. Sans `requests`, l'ordonnanceur travaille à l'aveugle ; sans `limits`, un pod peut affamer son noeud.
2. `livenessProbe` et `readinessProbe` distinctes. Les confondre fait redémarrer un pod simplement lent à démarrer ; ajoute une `startupProbe` si le démarrage est long.
3. `securityContext` : `runAsNonRoot: true`, `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`.
4. Image épinglée par tag immuable ou par digest, jamais `latest`.
5. Aucun secret en clair. Un `Secret` Kubernetes est encodé en base64, pas chiffré : ce n'est pas un coffre.
6. `replicas` cohérent avec un `PodDisruptionBudget`, et anti-affinité si la disponibilité compte.
Validation sans toucher au cluster :
```
run_command("kubectl apply --dry-run=client -f CHEMIN.yaml")
run_command("kubectl -n NS diff -f CHEMIN.yaml 2>&1 | head -60")
```
`kubectl diff` montre exactement ce qui changerait. Montre cette sortie et fais-la valider avant tout `apply`.

## 5. Déployer et revenir en arrière
- Montre le `diff`, obtiens l'accord, puis applique. Une action = un appel.
- Suivi du déploiement, borné pour ne pas atteindre les 120 s :
```
run_command("kubectl -n NS rollout status deploy/NOM --timeout=90s")
```
- Preuve fonctionnelle après coup : pods `Ready`, endpoints peuplés, et un appel de santé. Sans preuve, le déploiement n'est pas terminé.
- Retour arrière, à donner AVANT de déployer : `kubectl -n NS rollout undo deploy/NOM`. Historique : `kubectl -n NS rollout history deploy/NOM`.

## Garde-fous
- Jamais de `delete` sur un namespace, un PVC, un StatefulSet ou un CRD. Un PVC supprimé emporte les données.
- Jamais de `kubectl edit` (interactif, impossible ici) ni de `--force --grace-period=0` sans accord explicite et motif écrit.
- Ne recopie jamais le contenu d'un Secret dans le fil, même décodé « pour vérifier ».
- `kubectl apply` sur un dossier entier : montre d'abord la liste des ressources touchées (`kubectl diff -f dossier/`), jamais à l'aveugle.
- Plusieurs namespaces ou clusters à inspecter avec le même diagnostic : `spawn_agent` un coéquipier par cible, brief autonome (contexte, namespace, commandes exactes, format du tableau), puis `ask_agent` ; fusionne les tableaux toi-même.
- Restitution finale : le contexte et le namespace utilisés, ce qui a été constaté, ce qui a été modifié, la commande de retour arrière, et ce qui reste à vérifier par un humain.

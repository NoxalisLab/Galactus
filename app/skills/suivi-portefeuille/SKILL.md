---
name: suivi-portefeuille
description: "Portefeuille d'investissement en local : transactions, cours, performance, allocation."
---

## Garde-fous
- Suivi et analyse uniquement : jamais de conseil en investissement personnalisé, jamais d'ordre exécuté.
- Cours Yahoo indicatifs, parfois différés de 15 min. Échec réseau ou donnée absente : annonce-le, n'invente JAMAIS un cours.
- Aucun calcul mental sur les montants : tout passe par python3.
- Après chaque écriture : `run_command` → `python3 -m json.tool ~/Documents/Galactus/portefeuille.json` ; si erreur, corrige avant de continuer.

## 1. Fichier de positions
- Chemin : `~/Documents/Galactus/portefeuille.json`, lu avec read_file. S'il n'existe pas, demande devise et allocation cible, puis crée-le VIDE avec write_file :
```json
{"devise":"EUR","cash":0,
 "allocation_cible":{"actions":60,"obligations":30,"cash":10},
 "positions":[],"journal":[]}
```
- Position : `{"ticker","classe","qte","pru"}` ; `pru` = prix de revient unitaire, frais inclus. Toute écriture réécrit le JSON complet via write_file.

## 2. Enregistrer un achat / une vente
1. Demande : ticker, quantité, prix, frais, date (AAAA-MM-JJ), motif ; le motif est obligatoire, c'est le journal des décisions.
2. Achat : `pru` = (pru×qte_anc + prix×qte_ach + frais) / qte_totale ; `cash` −= prix×qte + frais.
3. Vente : `qte` −= qte vendue (supprime la ligne à 0) ; `cash` += prix×qte − frais ; plus-value = (prix − pru)×qte − frais.
4. Ajoute au `journal` : `{"date","type":"achat|vente","ticker","qte","prix","frais","motif"}`.

## 3. Cours actuels
Un seul run_command, boucle zsh, extraction Python (ne lis jamais le JSON Yahoo brut : il gaspille ton contexte) :
```
for T in AAPL MC.PA; do curl -s -m 15 -H "User-Agent: Mozilla/5.0" "https://query1.finance.yahoo.com/v8/finance/chart/$T?interval=1d&range=1d" | python3 -c 'import sys,json;m=json.load(sys.stdin)["chart"]["result"][0]["meta"];print(m["symbol"],m["regularMarketPrice"],m["currency"])'; done
```
Devise ≠ portefeuille : ajoute le ticker du taux (`EURUSD=X`…) à la boucle et convertis à l'étape 4.

## 4. Performance et allocation
Un script python3 stdlib en heredoc (`python3 <<'EOF' … EOF`) qui recalcule tout d'un coup :
- Par position : valeur = qte×cours ; plus/moins-value latente = (cours − pru)×qte, en % : cours/pru − 1.
- Global : valeur totale (cash inclus), plus/moins-value totale, poids % par position et par `classe`.
Restitue un tableau markdown trié par poids décroissant, puis les poids par classe face à `allocation_cible`.

## 5. Rééquilibrage
1. Écart par classe = poids actuel − cible, en points ET en devise.
2. Propose des mouvements chiffrés (« vendre ~X € de…, acheter ~Y € de… »), écarts > 5 points d'abord ; signale frais et fiscalité comme points d'attention, sans les estimer si inconnus.
3. N'exécute rien : c'est une proposition. Si l'utilisateur tranche, enregistre-le au `journal` (type `"décision"`, motif inclus).

## 6. Restitution
Termine chaque session par : valeur totale, plus/moins-value globale, meilleures et pires positions, écarts vs cible, puis exactement : « Ceci n'est pas un conseil en investissement. »

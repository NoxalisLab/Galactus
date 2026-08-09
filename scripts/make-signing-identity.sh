#!/bin/bash
# Cree, une fois pour toutes, une identite de signature locale stable.
#
# Pourquoi : signee ad hoc, l'app a pour exigence designee le cdhash de son
# propre binaire. Chaque reconstruction change ce hash, donc macOS voit une
# application differente et redemande toutes les autorisations (volume
# amovible, Documents, micro, ecran). Avec un certificat, l'exigence devient
# l'identifiant de bundle plus l'empreinte du certificat : elle ne bouge plus
# d'un build a l'autre et les autorisations sont accordees une seule fois.
#
# Ce n'est PAS une signature Apple Developer : rien ici ne remplace la
# notarisation pour une diffusion publique. C'est du confort de developpement,
# strictement local a cette machine.
#
# Idempotent : relancer le script ne recree rien si l'identite existe deja.
set -euo pipefail

CN="${GALACTUS_SIGN_CN:-Galactus Local Signing}"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if security find-identity -v -p codesigning 2>/dev/null | grep -qF "$CN"; then
  echo "identite deja presente : $CN"
  security find-identity -v -p codesigning | grep -F "$CN" | sed 's/^/  /'
  exit 0
fi

echo "creation de l'identite « $CN »"

# Le certificat doit porter extendedKeyUsage=codeSigning, sinon codesign le
# refuse ; et CA:false, sinon le trousseau le classe comme autorite.
cat > "$WORK/openssl.cnf" <<EOF
[ req ]
distinguished_name = dn
x509_extensions    = v3
prompt             = no
[ dn ]
CN = $CN
[ v3 ]
basicConstraints       = critical,CA:false
keyUsage               = critical,digitalSignature
extendedKeyUsage       = critical,codeSigning
subjectKeyIdentifier   = hash
EOF

openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" -config "$WORK/openssl.cnf" 2>/dev/null

# OpenSSL 3 chiffre par defaut le PKCS#12 en AES-256 avec un MAC SHA-256, que
# le trousseau macOS ne sait pas lire : l'import echoue sur un « MAC
# verification failed » trompeur, qui n'a rien a voir avec le mot de passe.
# Les algorithmes historiques sont donc imposes explicitement.
# Un mot de passe vide fait echouer l'import du trousseau sur le meme message
# trompeur. Il est transitoire : le fichier vit dans un dossier temporaire
# efface a la sortie du script.
P12PASS="galactus-local"
openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
  -name "$CN" -out "$WORK/id.p12" -passout "pass:$P12PASS" \
  -legacy -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 2>/dev/null

# -T autorise codesign a se servir de la cle sans redemander le mot de passe a
# chaque signature ; sans lui, chaque build ouvrirait une boite de dialogue.
security import "$WORK/id.p12" -k "$KEYCHAIN" -P "$P12PASS" \
  -T /usr/bin/codesign -T /usr/bin/security >/dev/null

# Sans reglage de confiance, `security find-identity -p codesigning` ne liste
# pas le certificat et codesign echoue. Le domaine utilisateur suffit : macOS
# demande le mot de passe de session une fois.
echo "macOS va demander ton mot de passe de session pour faire confiance au certificat."
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$WORK/cert.pem"

# Debloque l'acces de codesign a la cle privee sans invite ulterieure.
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "" "$KEYCHAIN" >/dev/null 2>&1 || true

if security find-identity -v -p codesigning | grep -qF "$CN"; then
  echo "identite prete :"
  security find-identity -v -p codesigning | grep -F "$CN" | sed 's/^/  /'
else
  echo "ECHEC: l'identite n'est pas utilisable pour la signature de code" >&2
  exit 1
fi

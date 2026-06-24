#!/usr/bin/env bash
# ===========================================================================
# Active le CHIFFREMENT des données au repos (AES-256-GCM) sur une install
# EXISTANTE d'INTER COLIS SERVICES.
#
# À lancer EN SUDO depuis le dossier de l'application :
#     sudo bash deploy/enable-encryption.sh
#
# Le script :
#   1. SAUVEGARDE la base (au cas où),
#   2. génère et affiche une clé (À CONSERVER absolument),
#   3. ajoute la clé au .env,
#   4. chiffre immédiatement database.json,
#   5. redémarre le service et vérifie.
# ===========================================================================
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_USER="ics"
ENV_FILE="$APP_DIR/.env"
DB_FILE="$APP_DIR/data/database.json"
STAMP="$(date +%Y%m%d-%H%M%S)"

echo "==> Application : $APP_DIR"

# 0. Vérifications
if [ ! -f "$ENV_FILE" ]; then echo "❌ .env introuvable ($ENV_FILE)."; exit 1; fi
if grep -qE '^DATA_ENCRYPTION_KEY=.+' "$ENV_FILE"; then
  echo "ℹ️  Une clé DATA_ENCRYPTION_KEY est DÉJÀ présente dans .env."
  echo "    Le chiffrement est probablement déjà actif. Arrêt (rien à faire)."
  [ -f "$DB_FILE" ] && { echo -n "    En-tête base : "; head -c 8 "$DB_FILE"; echo; }
  exit 0
fi

# 1. Sauvegarde de sécurité (base en clair)
if [ -f "$DB_FILE" ]; then
  BACKUP="$APP_DIR/data/database.before-encryption-$STAMP.json"
  cp "$DB_FILE" "$BACKUP"
  echo "==> Sauvegarde créée : $BACKUP"
fi

# 2. Génération de la clé (32 octets hex)
KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
echo
echo "============================================================"
echo " 🔑 VOTRE CLÉ DE CHIFFREMENT (à sauvegarder HORS du serveur,"
echo "    ex. gestionnaire de mots de passe). SANS ELLE, LES DONNÉES"
echo "    CHIFFRÉES SERONT IRRÉCUPÉRABLES :"
echo
echo "    DATA_ENCRYPTION_KEY=$KEY"
echo "============================================================"
echo

# 3. Ajout au .env
printf '\n# Chiffrement des données au repos (ne pas perdre cette clé !)\nDATA_ENCRYPTION_KEY=%s\n' "$KEY" >> "$ENV_FILE"
grep -q '^NODE_ENV=' "$ENV_FILE" || echo 'NODE_ENV=production' >> "$ENV_FILE"
chown "$APP_USER:$APP_USER" "$ENV_FILE" 2>/dev/null || true
chmod 600 "$ENV_FILE"
echo "==> Clé ajoutée au .env (permissions 600)."

# 4. Chiffrement immédiat de la base (chargement puis ré-enregistrement chiffré)
if [ -f "$DB_FILE" ]; then
  echo "==> Chiffrement de la base existante…"
  sudo -u "$APP_USER" env DATA_ENCRYPTION_KEY="$KEY" DATA_DIR="$APP_DIR/data" \
    node -e "const db=require('$APP_DIR/lib/db'); db.load().then(()=>db.save()).then(()=>console.log('   base chiffrée.')).catch(e=>{console.error(e);process.exit(1)})"
fi

# 5. Redémarrage + vérification
echo "==> Redémarrage du service…"
systemctl restart inter-colis || true
sleep 2
if [ -f "$DB_FILE" ]; then
  HEAD="$(head -c 8 "$DB_FILE")"
  if [ "$HEAD" = "ICSENC1:" ]; then
    echo "✅ Chiffrement ACTIF (database.json commence par ICSENC1:)."
  else
    echo "⚠️  La base ne semble pas encore chiffrée (en-tête: $HEAD)."
    echo "    Elle le sera au prochain enregistrement. Vérifiez le service :"
    echo "    systemctl status inter-colis"
  fi
fi
echo
echo "Terminé. Conservez précieusement la clé affichée ci-dessus."
echo "La sauvegarde en clair ($APP_DIR/data/database.before-encryption-$STAMP.json)"
echo "peut être supprimée une fois le chiffrement vérifié."

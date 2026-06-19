#!/usr/bin/env bash
# ===========================================================================
# Mise à jour d'INTER COLIS SERVICES (récupère le code GitHub et redémarre)
# À lancer EN ROOT depuis le dossier de l'application :
#     sudo bash deploy/update.sh
#
# Les données (data/database.json) ne sont JAMAIS touchées : seul le code change.
# ===========================================================================
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_USER="ics"

cd "$APP_DIR"
echo "==> Récupération de la dernière version (git pull)..."
git pull --ff-only

echo "==> Mise à jour des dépendances..."
npm install --omit=dev

echo "==> Permissions..."
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "==> Redémarrage du service..."
systemctl restart inter-colis
sleep 2
systemctl --no-pager status inter-colis | head -n 5

echo
echo "✅ Mise à jour terminée."

#!/usr/bin/env bash
# ===========================================================================
# Installation automatique d'INTER COLIS SERVICES sur un VPS OVH (Ubuntu/Debian)
# À lancer EN ROOT depuis le dossier de l'application :
#     sudo bash deploy/install-ovh.sh
# ===========================================================================
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_USER="ics"
NODE_MAJOR="20"

echo "==> Dossier application : $APP_DIR"

# 1. Node.js (dépôt NodeSource) si absent
if ! command -v node >/dev/null 2>&1; then
  echo "==> Installation de Node.js ${NODE_MAJOR}..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
echo "==> Node $(node -v)"

# 2. Utilisateur système dédié
if ! id "$APP_USER" >/dev/null 2>&1; then
  echo "==> Création de l'utilisateur système '$APP_USER'..."
  adduser --system --group "$APP_USER"
fi

# 3. Dépendances de l'application
echo "==> Installation des dépendances npm..."
cd "$APP_DIR"
npm install --omit=dev

# 4. Fichier .env
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")"
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${SECRET}|" "$APP_DIR/.env"
  sed -i "s|^DATA_DIR=.*|DATA_DIR=${APP_DIR}/data|" "$APP_DIR/.env"
  echo "==> Fichier .env créé (JWT_SECRET généré automatiquement)."
fi

# 5. Dossier data + permissions
mkdir -p "$APP_DIR/data"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# 6. Service systemd
echo "==> Installation du service systemd..."
sed "s|/home/ics/inter-colis|${APP_DIR}|g" "$APP_DIR/deploy/inter-colis.service" > /etc/systemd/system/inter-colis.service
systemctl daemon-reload
systemctl enable --now inter-colis

echo
echo "============================================================"
echo " ✅ Installation terminée."
echo " L'application tourne sur http://127.0.0.1:3000"
echo " Vérifiez :  systemctl status inter-colis"
echo " Logs     :  journalctl -u inter-colis -f"
echo
echo " Étape suivante : configurer nginx + HTTPS (voir DEPLOIEMENT-OVH.md)."
echo "============================================================"

#!/usr/bin/env bash
# ===========================================================================
# Installation TOUT-EN-UN d'INTER COLIS SERVICES sur un VPS OVH (Ubuntu/Debian)
#
# Installe : Node.js 22, l'application, le service systemd, nginx (reverse-proxy)
#            ET le certificat HTTPS Let's Encrypt pour inter-colis-services.com.
#
# À lancer EN ROOT depuis le dossier de l'application :
#     sudo bash deploy/install-ovh.sh
#
# Vous pouvez personnaliser le domaine / l'email sans modifier le script :
#     sudo DOMAIN=inter-colis-services.com EMAIL=vous@exemple.fr bash deploy/install-ovh.sh
# ===========================================================================
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_USER="ics"
NODE_MAJOR="22"

# --- Domaine + email (pour le certificat HTTPS) ----------------------------
DOMAIN="${DOMAIN:-inter-colis-services.com}"
DOMAIN_WWW="${DOMAIN_WWW:-www.${DOMAIN}}"
EMAIL="${EMAIL:-jacostetcl@gmail.com}"

echo "==> Dossier application : $APP_DIR"
echo "==> Domaine             : $DOMAIN (+ $DOMAIN_WWW)"

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
  ENCKEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${SECRET}|" "$APP_DIR/.env"
  sed -i "s|^DATA_ENCRYPTION_KEY=.*|DATA_ENCRYPTION_KEY=${ENCKEY}|" "$APP_DIR/.env"
  sed -i "s|^DATA_DIR=.*|DATA_DIR=${APP_DIR}/data|" "$APP_DIR/.env"
  # Production : active HSTS / avertissements de sécurité.
  grep -q '^NODE_ENV=' "$APP_DIR/.env" || echo 'NODE_ENV=production' >> "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "==> Fichier .env créé (JWT_SECRET + DATA_ENCRYPTION_KEY générés, chiffrement des données ACTIVÉ)."
  echo "    ⚠️  Sauvegardez la clé DATA_ENCRYPTION_KEY : sans elle, les données chiffrées sont irrécupérables."
fi

# 5. Dossier data + permissions
mkdir -p "$APP_DIR/data"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# 6. Service systemd
echo "==> Installation du service systemd..."
sed "s|/home/ics/inter-colis|${APP_DIR}|g" "$APP_DIR/deploy/inter-colis.service" > /etc/systemd/system/inter-colis.service
systemctl daemon-reload
systemctl enable --now inter-colis
echo "==> Service démarré (http://127.0.0.1:3000)."

# 7. nginx (reverse-proxy)
echo "==> Installation et configuration de nginx..."
apt-get install -y nginx
sed "s|inter-colis-services.com www.inter-colis-services.com|${DOMAIN} ${DOMAIN_WWW}|g" \
    "$APP_DIR/deploy/nginx-inter-colis.conf" > /etc/nginx/sites-available/inter-colis
ln -sf /etc/nginx/sites-available/inter-colis /etc/nginx/sites-enabled/inter-colis
# Désactive le site par défaut pour éviter les conflits
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
echo "==> nginx configuré pour $DOMAIN."

# 8. HTTPS (Let's Encrypt via certbot)
echo "==> Tentative d'obtention du certificat HTTPS pour $DOMAIN..."
apt-get install -y certbot python3-certbot-nginx
if certbot --nginx \
      -d "$DOMAIN" -d "$DOMAIN_WWW" \
      --non-interactive --agree-tos -m "$EMAIL" --redirect; then
  HTTPS_OK=1
else
  HTTPS_OK=0
fi

echo
echo "============================================================"
echo " ✅ Installation terminée."
if [ "$HTTPS_OK" = "1" ]; then
  echo "   🌐 Votre site est en ligne : https://${DOMAIN}"
else
  echo "   ⚠️  Le certificat HTTPS n'a pas pu être obtenu."
  echo "      C'est NORMAL si le DNS ne pointe pas encore vers ce serveur."
  echo "      → Vérifiez que les enregistrements A de '${DOMAIN}' et"
  echo "        '${DOMAIN_WWW}' pointent vers l'IP de ce VPS, puis relancez :"
  echo "        sudo certbot --nginx -d ${DOMAIN} -d ${DOMAIN_WWW} --redirect"
  echo "      En attendant, le site répond déjà en HTTP : http://${DOMAIN}"
fi
echo
echo "   Commandes utiles :"
echo "     Statut :  systemctl status inter-colis"
echo "     Logs   :  journalctl -u inter-colis -f"
echo "     MAJ    :  sudo bash deploy/update.sh"
echo
echo "   ⚠️  Premier réflexe : créez votre compte via le formulaire."
echo "       Le tout premier compte créé devient ADMINISTRATEUR."
echo "============================================================"

#!/usr/bin/env bash
# ===========================================================================
# Configure le DÉPLOIEMENT AUTOMATIQUE (GitHub Actions -> ce VPS).
# À lancer UNE SEULE FOIS, EN SUDO, avec votre utilisateur SSH habituel
# (ex. « ubuntu ») depuis le dossier de l'application :
#     sudo bash deploy/setup-autodeploy.sh
#
# Le script :
#   1. autorise cet utilisateur à lancer la mise à jour sans mot de passe,
#   2. génère une clé SSH de déploiement,
#   3. affiche les 3 secrets à copier dans GitHub.
# ===========================================================================
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Utilisateur SSH humain (celui qui a lancé sudo), ex. « ubuntu »
DEPLOY_USER="${SUDO_USER:-$(whoami)}"
USER_HOME="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"

echo "==> Utilisateur de déploiement : $DEPLOY_USER ($USER_HOME)"
echo "==> Dossier application        : $APP_DIR"

# 1. Autoriser la mise à jour via sudo SANS mot de passe (uniquement update.sh)
RULE="/etc/sudoers.d/ics-autodeploy"
cat > "$RULE" <<EOF
${DEPLOY_USER} ALL=(root) NOPASSWD: /usr/bin/bash ${APP_DIR}/deploy/update.sh, /bin/bash ${APP_DIR}/deploy/update.sh
EOF
chmod 440 "$RULE"
visudo -cf "$RULE" >/dev/null && echo "==> Règle sudo installée ($RULE)."

# 2. Clé SSH de déploiement (ed25519)
SSH_DIR="${USER_HOME}/.ssh"
KEY="${SSH_DIR}/ics_deploy"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$SSH_DIR"
if [ ! -f "$KEY" ]; then
  sudo -u "$DEPLOY_USER" ssh-keygen -t ed25519 -N "" -f "$KEY" -C "github-actions-deploy" >/dev/null
  echo "==> Clé de déploiement générée."
fi

# Autoriser cette clé à se connecter
AUTH="${SSH_DIR}/authorized_keys"
touch "$AUTH"; chown "$DEPLOY_USER:$DEPLOY_USER" "$AUTH"; chmod 600 "$AUTH"
if ! grep -qF "$(cat "${KEY}.pub")" "$AUTH"; then
  cat "${KEY}.pub" >> "$AUTH"
  echo "==> Clé autorisée (authorized_keys)."
fi

# 3. Afficher les secrets à copier dans GitHub
PUBIP="$(curl -fsSL https://api.ipify.org 2>/dev/null || echo 'VOTRE_IP_VPS')"
echo
echo "============================================================"
echo " ✅ Déploiement automatique prêt côté serveur."
echo
echo " Dans GitHub : dépôt -> Settings -> Secrets and variables ->"
echo " Actions -> « New repository secret », créez ces 3 secrets :"
echo
echo "   OVH_SSH_HOST = ${PUBIP}"
echo "   OVH_SSH_USER = ${DEPLOY_USER}"
echo "   OVH_SSH_KEY  = (collez la clé PRIVÉE affichée ci-dessous, en entier)"
echo "------------------------------------------------------------"
echo "   ↓↓↓  CLÉ PRIVÉE  OVH_SSH_KEY  ↓↓↓"
echo
cat "$KEY"
echo
echo "   ↑↑↑  (copiez de -----BEGIN à -----END inclus)  ↑↑↑"
echo "============================================================"
echo " (Facultatif) OVH_SSH_PORT si votre SSH n'est pas sur le port 22."
echo
echo " Ensuite, chaque push sur 'main' mettra le site à jour tout seul."
echo "============================================================"

# Installation sur un serveur OVH

Ce guide explique comment héberger **INTER COLIS SERVICES** sur un serveur OVH.

> ⚠️ **Type d'offre OVH nécessaire**
> L'application est un **serveur Node.js** : elle a besoin d'un serveur où vous
> avez les droits d'administration (root).
> - ✅ **VPS OVH** (recommandé, à partir de ~5 €/mois) — *le plus simple*.
> - ✅ **Serveur dédié** OVH.
> - ❌ **Hébergement Web mutualisé** OVH (offre « Perso/Pro/Performance ») : il
>   ne fait tourner que du PHP, **pas** de serveur Node.js permanent. Il ne
>   convient donc pas.

Vous obtenez à la fin une adresse type **https://portail.votre-domaine.fr**.

---

## A. Méthode rapide (tout automatique) — VPS Ubuntu/Debian

Le domaine **inter-colis-services.com** est déjà pré-configuré dans le script :
une seule commande installe **tout** (Node.js, l'app, le service, nginx **et le
HTTPS**).

### Étape 0 — DNS (à faire AVANT, pour que le HTTPS s'installe tout seul)
Dans l'espace OVH (« Domaines » → `inter-colis-services.com` → zone DNS), créez
**2 enregistrements A** pointant vers l'IP de votre VPS :

| Type | Sous-domaine | Cible |
|------|--------------|-------|
| A | `` (vide / `@`) | IP de votre VPS |
| A | `www` | IP de votre VPS |

(Comptez quelques minutes à 1 h de propagation DNS.)

### Étapes 1 à 4

1. **Commandez un VPS OVH** — **Ubuntu 24.04 LTS recommandé** (ou 26.04 LTS,
   également compatible). OVH vous envoie l'IP et un accès SSH (`ubuntu` ou
   `root`). Le script installe **Node.js 22 LTS**, compatible avec les deux.

2. **Connectez-vous en SSH** depuis votre ordinateur :
   ```bash
   ssh ubuntu@VOTRE_IP        # ou root@VOTRE_IP
   ```

3. **Récupérez l'application** depuis GitHub :
   ```bash
   sudo apt update && sudo apt install -y git
   sudo mkdir -p /home/ics && cd /home/ics
   sudo git clone https://github.com/Jacoste35/Icscalandar.git inter-colis
   cd inter-colis
   ```

4. **Lancez l'installation tout-en-un** :
   ```bash
   sudo bash deploy/install-ovh.sh
   ```
   Le script installe Node.js, les dépendances, crée le fichier `.env` (avec un
   `JWT_SECRET` généré), crée l'utilisateur système `ics`, démarre le service,
   **configure nginx pour `inter-colis-services.com`** et **obtient le
   certificat HTTPS** automatiquement.

   ✅ À la fin, le site est en ligne sur **https://inter-colis-services.com**.

   > Si le DNS ne pointe pas encore au moment de l'installation, le HTTPS
   > échoue (sans bloquer le reste). Une fois le DNS propagé, relancez juste :
   > ```bash
   > sudo certbot --nginx -d inter-colis-services.com -d www.inter-colis-services.com --redirect
   > ```

> ⚠️ **Premier réflexe** : ouvrez le site et créez votre compte via le
> formulaire d'inscription. Le **tout premier compte créé devient
> automatiquement l'administrateur**.

### Mettre à jour le site plus tard
```bash
cd /home/ics/inter-colis && sudo bash deploy/update.sh
```
(Récupère la dernière version GitHub et redémarre — vos données sont conservées.)

---

## B. Méthode manuelle (étape par étape)

```bash
# 1. Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt install -y nodejs

# 2. Récupérer le code
sudo mkdir -p /home/ics && cd /home/ics
sudo git clone https://github.com/Jacoste35/Icscalandar.git inter-colis
cd inter-colis

# 3. Dépendances
sudo npm install --omit=dev

# 4. Fichier de configuration
sudo cp .env.example .env
# Générer un secret :
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
sudo nano .env       # collez le secret dans JWT_SECRET, ajustez DATA_DIR=/home/ics/inter-colis/data

# 5. Utilisateur dédié + permissions
sudo adduser --system --group ics
sudo mkdir -p /home/ics/inter-colis/data
sudo chown -R ics:ics /home/ics/inter-colis

# 6. Service systemd (démarrage auto + redémarrage en cas de crash)
sudo cp deploy/inter-colis.service /etc/systemd/system/inter-colis.service
# (le fichier suppose le chemin /home/ics/inter-colis — adaptez si besoin)
sudo systemctl daemon-reload
sudo systemctl enable --now inter-colis
sudo systemctl status inter-colis      # doit être "active (running)"
```

> Alternative à systemd : **PM2**
> ```bash
> sudo npm install -g pm2
> pm2 start ecosystem.config.js && pm2 save && pm2 startup
> ```

---

## C. Nom de domaine + HTTPS (nginx + Let's Encrypt)

1. **DNS** : dans l'espace OVH (« Domaines » → zone DNS), créez un enregistrement
   **A** pointant `portail` vers l'IP de votre VPS
   (→ `portail.votre-domaine.fr`).

2. **nginx** :
   ```bash
   sudo apt install -y nginx
   sudo cp deploy/nginx-inter-colis.conf /etc/nginx/sites-available/inter-colis
   sudo nano /etc/nginx/sites-available/inter-colis   # remplacez server_name par votre domaine
   sudo ln -s /etc/nginx/sites-available/inter-colis /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   ```

3. **Certificat HTTPS gratuit** :
   ```bash
   sudo apt install -y certbot python3-certbot-nginx
   sudo certbot --nginx -d portail.votre-domaine.fr
   ```
   Certbot configure le HTTPS et le renouvellement automatique.

4. Ouvrez **https://portail.votre-domaine.fr** 🎉

> ⚠️ **Premier réflexe** : créez votre compte via le formulaire d'inscription.
> Le **tout premier compte créé devient automatiquement l'administrateur**.

---

## D. Emails (facultatif)

Pour activer l'envoi des identifiants et des confirmations de congés, renseignez
les variables `SMTP_*` dans `.env` (un exemple OVH MX Plan est fourni), puis
redémarrez : `sudo systemctl restart inter-colis`.

---

## E. Exploitation au quotidien

| Action | Commande |
|--------|----------|
| État du service | `sudo systemctl status inter-colis` |
| Voir les logs | `sudo journalctl -u inter-colis -f` |
| Redémarrer | `sudo systemctl restart inter-colis` |
| Mettre à jour le code | `cd /home/ics/inter-colis && sudo git pull && sudo npm install --omit=dev && sudo systemctl restart inter-colis` |

### Sauvegarde des données
Toutes les données vivent dans **`data/database.json`**. Sauvegardez ce fichier
régulièrement, par exemple chaque nuit :
```bash
# Exemple de cron quotidien (à 2h du matin) gardant 30 jours d'archives
sudo crontab -e
0 2 * * * cp /home/ics/inter-colis/data/database.json /home/ics/backups/db-$(date +\%F).json && find /home/ics/backups -name 'db-*.json' -mtime +30 -delete
```
(Pensez à `sudo mkdir -p /home/ics/backups`.)

### Pare-feu (recommandé)
```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```
Le port **3000 reste interne** (non exposé) : seul nginx (80/443) est public.

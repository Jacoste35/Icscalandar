# Mettre le site en ligne (guide pas à pas)

Le code est sur GitHub. Pour obtenir une **adresse web** que vous (et vos
salariés) pouvez ouvrir depuis n'importe quel navigateur, il faut héberger
l'application. Voici la méthode la plus simple, **gratuite**, sans rien
installer.

---

## Option 0 — Vercel (si vous y êtes déjà) + base de données gratuite

Vercel fonctionne en mode *serverless* : il faut une base de données externe
pour conserver les comptes et les congés (sinon l'inscription ne marche pas).
Le code est déjà adapté ; il reste **2 choses à faire** dans Vercel.

### Étape 1 — Brancher une base Redis gratuite (Upstash), ~2 minutes
1. Ouvrez votre projet sur **https://vercel.com**.
2. Onglet **Storage** (en haut) → **Create Database** → choisissez **Upstash
   for Redis** (gratuit) → **Continue**.
3. Donnez un nom, validez, puis **connectez la base au projet** quand Vercel
   le propose (« Connect Project »). Cela ajoute automatiquement les variables
   d'environnement `KV_REST_API_URL` et `KV_REST_API_TOKEN`.

### Étape 2 — Redéployer
1. Onglet **Deployments** → sur le dernier déploiement, menu **…** →
   **Redeploy** (pour qu'il prenne en compte la base et la nouvelle version).
2. Une fois terminé, ouvrez votre adresse `https://...vercel.app`.

> ⚠️ **Premier réflexe** : créez votre compte via le formulaire d'inscription.
> **Le tout premier compte créé devient automatiquement l'administrateur.**
> Faites-le avant de communiquer l'adresse à vos salariés.

L'inscription, la connexion et toutes les données fonctionnent alors
normalement et sont **conservées durablement** dans Upstash.

> 💡 Vercel ajoute parfois les variables sous le préfixe `UPSTASH_REDIS_REST_*`
> au lieu de `KV_REST_API_*` : le code reconnaît les deux, rien à changer.

---

## Option 1 — Render.com (gratuit, ~5 minutes)

1. Allez sur **https://render.com** et créez un compte
   (bouton « Get Started » → « Sign in with GitHub » pour aller plus vite).
2. Autorisez Render à accéder à votre dépôt GitHub **`Jacoste35/Icscalandar`**.
3. Cliquez sur **New +** (en haut à droite) → **Blueprint**.
4. Sélectionnez le dépôt **Icscalandar**. Render détecte automatiquement le
   fichier `render.yaml` et propose de créer le service.
5. Cliquez **Apply** / **Create**. Render installe et démarre le site.
6. Au bout de 1–2 minutes, vous obtenez une adresse du type
   **`https://inter-colis-services.onrender.com`**. C'est votre site ! 🎉

> ⚠️ **À faire en premier sur le site en ligne** : créez votre compte via le
> formulaire d'inscription. **Le tout premier compte créé devient
> automatiquement l'administrateur.** Faites-le avant de communiquer l'adresse
> à vos salariés.

### Bon à savoir sur le plan gratuit Render
- Le site se **met en veille** après 15 min d'inactivité : la première
  ouverture après une pause peut prendre ~30 secondes à charger, c'est normal.
- En plan gratuit, le disque est temporaire : les données peuvent être
  réinitialisées lors d'un redéploiement. Pour **conserver durablement** les
  données, activez un disque persistant (voir le bloc `disk:` commenté dans
  `render.yaml`) — cela nécessite un petit plan payant Render.

---

## Option 2 — Railway.app

1. Compte sur **https://railway.app** (connexion via GitHub).
2. **New Project** → **Deploy from GitHub repo** → choisissez `Icscalandar`.
3. Railway détecte Node.js, installe et démarre automatiquement.
4. Dans l'onglet **Variables**, ajoutez `JWT_SECRET` avec une longue valeur
   aléatoire de votre choix.
5. Dans **Settings → Networking → Generate Domain** pour obtenir l'adresse web.

---

## Option 3 — Avec Docker (sur votre propre serveur)

```bash
docker build -t inter-colis .
docker run -d -p 80:3000 \
  -e JWT_SECRET="mettez-ici-un-secret-long-et-aleatoire" \
  -v ics-data:/app/data \
  --name inter-colis inter-colis
```

Le volume `ics-data` conserve toutes les données (`data/database.json`).

---

## Option 4 — L'essayer sur votre ordinateur (test rapide)

Nécessite [Node.js](https://nodejs.org) (version 18+).

```bash
git clone https://github.com/Jacoste35/Icscalandar.git
cd Icscalandar
npm install
npm start
```

Ouvrez ensuite **http://localhost:3000** dans votre navigateur. Accessible
uniquement depuis votre machine.

---

## En production : définissez `JWT_SECRET`

Pour la sécurité des connexions, définissez une variable d'environnement
`JWT_SECRET` avec une longue valeur aléatoire. Sur Render (Option 1), c'est
**déjà automatique** grâce à `render.yaml`.

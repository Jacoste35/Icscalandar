# Audit de sécurité — INTER COLIS SERVICES

Date : 2026-06. Périmètre : application Node/Express + SPA, hébergée sur VPS OVH
derrière nginx + HTTPS (Let's Encrypt).

## 1. Contrôle d'accès (autorisation)

- **Authentification** : JWT (Bearer) signé avec `JWT_SECRET`, expiration 30 j ;
  mots de passe **hachés bcrypt** (jamais renvoyés — `publicUser()` retire
  `passwordHash`).
- **Toutes les routes `/api/*`** exigent `authRequired` (sauf `login` /
  `register`, publiques par nécessité).
- **Routes `/api/admin/*`** : `adminRequired` (administrateur uniquement).
  Seule exception **volontaire** : `POST /api/admin/requests` en `staffRequired`
  (les responsables peuvent *proposer* une absence ; l'admin valide).
- **Routes `/api/staff/*`** : `staffRequired` (admin + responsable).
- **« Contrôle & gestion »** réservé aux administrateurs côté menu **et** côté
  page (garde de rôle dans chaque vue) : Administration, Gestion des heures,
  Gestion des stocks, Gestion de la flotte, Contrôle financier, Estimation,
  Contrats. **Gestion des absences** et **Gestion des véhicules** restent
  accessibles aux responsables (besoins opérationnels).
- **Exposition de données graduée** : emails visibles seulement de la direction ;
  soldes et indisponibilités exposés uniquement à l'encadrement (`/api/team`).

## 2. Chiffrement des données au repos

- Si `DATA_ENCRYPTION_KEY` est défini, `database.json` est chiffré en
  **AES-256-GCM** (clé dérivée SHA-256). Le fichier est illisible sans la clé.
- **Sécurité d'intégrité** : si la base est chiffrée et la clé absente/incorrecte,
  l'application **refuse de démarrer/charger** et **ne réinitialise jamais** la
  base (pas d'effacement accidentel).
- Permissions fichier `.env` et `database.json` en `600` (propriétaire seul).
- Le script d'installation génère la clé automatiquement et active le chiffrement.
- ⚠️ La clé doit être **sauvegardée hors serveur** : sans elle, données chiffrées
  irrécupérables.

## 3. En-têtes et durcissement HTTP

- `Content-Security-Policy` (sources limitées à `self`, `object-src 'none'`,
  `frame-ancestors 'self'`), `X-Frame-Options: SAMEORIGIN`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Strict-Transport-Security` (HSTS 1 an), `x-powered-by` désactivé.
- **Limite de taille du corps JSON** : 3 Mo (anti-déni de service).
- **Anti-bruteforce** : `login` / `register` limités à 20 tentatives / 15 min / IP
  (429 au-delà), avec `trust proxy` pour l'IP réelle derrière nginx.

## 4. Recommandations d'exploitation (VPS)

- **Pare-feu** : `ufw` n'autorise que SSH + nginx (port 3000 interne, non exposé).
- **HTTPS** obligatoire (certbot + redirection 80→443) — déjà en place.
- **SSH** : préférer l'authentification par clé, désactiver le login root par
  mot de passe (`PermitRootLogin prohibit-password`).
- **Sauvegardes chiffrées** : sauvegarder `database.json` (déjà chiffré si la clé
  est active) ET conserver la clé séparément.
- **Chiffrement disque** (optionnel, défense en profondeur) : LUKS au niveau OVH.
- **Mises à jour** système régulières (`apt upgrade`).
- Garder `JWT_SECRET` et `DATA_ENCRYPTION_KEY` hors du dépôt (déjà : `.env`
  est git-ignoré, comme `data/`).

## 5. Points déjà sains

- Pas de secret en dur dans le code ; `.env` et `data/` exclus de Git.
- Échappement HTML systématique côté client (`esc()`), CSP en complément.
- Stockage atomique (`.tmp` + `rename`) pour éviter la corruption.

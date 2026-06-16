# INTER COLIS SERVICES — Portail RH

Application web de suivi des **congés payés**, **absences** et **heures de
récupération** des salariés d'INTER COLIS SERVICES.

## Fonctionnalités

- **Inscription des salariés** : chaque salarié crée son compte. La demande est
  envoyée à l'administrateur, qui valide manuellement et attribue les soldes
  (congés N, congés N-1, RCC, heures supplémentaires dues).
- **Groupes de travail** : GLS, FedEx, Ciblex, Joker, Secrétaire — chacun avec
  une couleur affichée sur le calendrier (couleurs modifiables par l'admin).
- **Calendrier d'équipe** visible de tous les inscrits, avec vues **jour /
  semaine / mois / année**. Les chauffeurs travaillent du lundi au samedi ;
  dimanches et **jours fériés français** (calculés automatiquement, Pâques
  inclus) sont exclus.
- **Tableau de bord** à la connexion : affiche la semaine en cours (ou à venir
  le dimanche) et indique qui sera absent, ainsi que vos soldes.
- **Demandes de congé en ligne** : dépôt par les salariés, validation/refus par
  l'admin. La validation décompte automatiquement le bon solde.
- **Mes données** : soldes en temps réel, profil, historique des congés validés.
- **Panneau Droits & Devoirs** consultable par tous et éditable par l'admin.

## Démarrage

```bash
npm install
npm start
```

Le site est disponible sur http://localhost:3000 (port configurable via la
variable d'environnement `PORT`).

## Premier compte = administrateur

⚠️ **Le tout premier compte créé via le formulaire d'inscription devient
automatiquement l'administrateur** (compte actif immédiatement). Créez donc
votre compte de direction en premier, puis les salariés s'inscrivent à leur
tour et vous validez leurs demandes depuis l'onglet **Administration**.

## Stack technique

- **Backend** : Node.js + Express, authentification JWT, mots de passe hachés
  (bcrypt). Persistance double :
  - **Fichier `data/database.json`** en local / sur serveur permanent (Render,
    Docker) — aucune base externe nécessaire ;
  - **Redis (Upstash / Vercel KV)** automatiquement utilisé en environnement
    *serverless* (Vercel) dès que les variables `KV_REST_API_URL` /
    `KV_REST_API_TOKEN` (ou `UPSTASH_REDIS_REST_*`) sont présentes.
  - Compatible Vercel via `api/index.js` + `vercel.json`.
- **Frontend** : application monopage en HTML/CSS/JavaScript natif (aucun build,
  aucune dépendance front).

## Configuration

| Variable     | Défaut                | Description                          |
|--------------|-----------------------|--------------------------------------|
| `PORT`       | `3000`                | Port d'écoute du serveur             |
| `JWT_SECRET` | *(valeur de dev)*     | Secret de signature des jetons JWT — **à définir en production** |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | — | Base Redis (Upstash/Vercel KV) pour la persistance en serverless |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | — | Serveur SMTP pour l'envoi des identifiants par email (facultatif) |
| `SMTP_SECURE` | `false` | `true` pour TLS direct (port 465) |
| `MAIL_FROM` | `SMTP_USER` | Adresse expéditeur des emails |
| `APP_URL` | — | URL du site, incluse dans les emails |

> **Envoi d'emails** : si les variables `SMTP_*` ne sont pas définies, l'envoi
> est simplement ignoré (l'application continue de fonctionner normalement).
> Pour activer l'email, utilisez un fournisseur SMTP (Brevo, SendGrid, Gmail
> avec mot de passe d'application, etc.).

## Sauvegarde des données

Toutes les données vivent dans `data/database.json`. Sauvegardez ce fichier
régulièrement. Il est ignoré par git (voir `.gitignore`).

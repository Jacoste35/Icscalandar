# Bot WhatsApp — INTER COLIS SERVICES

Bot **non officiel** (librairie [Baileys](https://github.com/WhiskeySockets/Baileys)) qui
tourne **en processus séparé** sur le VPS, à côté de l'application. Il permet aux
salariés de consulter leurs soldes, poser un congé, signaler un véhicule,
consulter leurs documents et écrire à la direction — et il pousse les
notifications (congés validés, documents, atelier…) sur WhatsApp.

> ⚠️ Usage **interne**. Un bot non officiel est contraire aux CGU de WhatsApp :
> utilisez un **numéro dédié** (pas un numéro personnel), en volume raisonnable.
> En cas de blocage du numéro, il suffit d'en relier un autre.

## Architecture

- Le bot **n'écrit jamais la base**. Il parle à l'app via :
  - l'API interne `/api/bot/*` protégée par le secret partagé **`BOT_TOKEN`** ;
  - les endpoints existants (au nom du salarié, via un jeton obtenu à la liaison).
- L'app dépose les messages sortants dans une file ; le bot les relève et les envoie.

## Prérequis

1. L'application tourne (ex. `http://localhost:3000` sur le VPS).
2. Variables d'environnement communes à l'app **et** au bot :
   ```
   BOT_TOKEN=un-secret-long-et-aleatoire      # identique app + bot
   WA_BOT_NUMBER=+33 6 12 34 56 78            # (app) affiché aux salariés, facultatif
   ```
   Générer un token :
   `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
3. Installer les dépendances du bot (déjà en `optionalDependencies`) :
   ```
   npm install
   ```

## Lancer le bot

```
# variables pour le PROCESSUS bot
export APP_URL=http://localhost:3000
export BOT_TOKEN=le-meme-que-dans-l-app
export WA_SESSION_DIR=/home/ics/inter-colis/wa-session   # persistant, hors dépôt

npm run bot
```

Au premier lancement, un **QR code** s'affiche dans le terminal :
sur le téléphone du **numéro dédié** → WhatsApp → *Appareils connectés* →
*Connecter un appareil* → scannez. La session est ensuite conservée dans
`WA_SESSION_DIR` (plus besoin de rescanner).

### En service permanent (pm2)

```
pm2 start npm --name ics-wabot -- run bot
pm2 save
```

(ou un service `systemd` dédié — mêmes variables d'environnement.)

## Liaison d'un salarié

1. Le salarié ouvre l'app → **Mon profil → Lier mon WhatsApp** → obtient un
   **code à 6 chiffres** (valable 15 min).
2. Il envoie ce code par WhatsApp au numéro du bot.
3. C'est lié : le bot répond et affiche le menu. Les notifications le concernant
   arrivent désormais aussi sur WhatsApp.

## Côté direction

Les messages « Contacter la direction » arrivent dans l'app :
**Ressources Humaines → Messages WhatsApp**. La réponse de la direction est
renvoyée automatiquement au salarié sur WhatsApp.

## Menu du bot

```
1  Mes soldes de congés
2  Mes demandes / congés
3  Poser un congé      (type → solde → dates → confirmation)
4  Signaler un véhicule (véhicule → km → description)
5  Mes documents à lire
6  Contacter la direction
menu  revenir au menu
```

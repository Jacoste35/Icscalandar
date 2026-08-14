# Brancher OSRM (temps de trajet routiers réels)

L'optimisateur de tournée fonctionne sans OSRM (estimation à vol d'oiseau).
En branchant OSRM, il utilise les **temps de route réels** : meilleur ordre de
tournée, heures d'arrivée plus justes, et **vrai tracé** sur la carte.

Le code applicatif est déjà prêt : il s'active dès que la variable
d'environnement `OSRM_URL` est renseignée, et retombe automatiquement sur
l'estimation si OSRM ne répond pas.

## Installation sur le VPS OVH (une seule fois, ~15 min)

Pré-requis : **Docker** installé sur le VPS.

```bash
# 1. Récupérer le dépôt sur le VPS (si ce n'est pas déjà le cas), puis :
cd deploy/osrm

# 2. Préparer les données (Calvados 14 + Orne 61 = région basse-normandie)
./prepare.sh
#    (télécharge ~150 Mo puis prétraite ; quelques minutes de calcul)

# 3. Démarrer le serveur OSRM (redémarre tout seul au reboot du VPS)
docker compose up -d

# 4. Vérifier que ça répond
curl "http://127.0.0.1:5000/route/v1/driving/-0.37,49.18;-0.45,49.14?overview=false"
#    → doit renvoyer un JSON avec "code":"Ok"
```

## Activer côté application

Ajoutez dans le fichier `.env` de l'application (même VPS) :

```
OSRM_URL=http://127.0.0.1:5000
```

Puis redémarrez l'application. Au prochain « Optimiser la tournée », le message
de confirmation affichera **« (temps routiers réels) »** et la carte tracera la
vraie route.

> OSRM sur un autre serveur ? Voir `nginx-osrm.conf.example` pour l'exposer en
> HTTPS, et mettez `OSRM_URL=https://osrm.mon-domaine.fr`.

## Mettre à jour la carte plus tard

```bash
cd deploy/osrm
./prepare.sh                 # re-télécharge les données à jour
docker compose restart
```

## Test rapide sans rien installer (non destiné à la production)

Pour juste voir l'effet avant d'installer, vous pouvez pointer temporairement
vers le serveur public de démonstration (limité, interdit en usage réel) :

```
OSRM_URL=https://router.project-osrm.org
```

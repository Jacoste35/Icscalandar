#!/usr/bin/env bash
# Prépare les données OSRM (télécharge + extract/partition/customize).
# Usage :  ./prepare.sh [region]
#   region par défaut : basse-normandie  (couvre Calvados 14 + Orne 61)
#   autres exemples   : normandie, bretagne, pays-de-la-loire…
# Nécessite Docker. À relancer pour mettre à jour la carte (données Geofabrik).
set -euo pipefail

REGION="${1:-basse-normandie}"
BASE="https://download.geofabrik.de/europe/france"
PBF="${REGION}-latest.osm.pbf"
OSRM="${REGION}-latest.osrm"

cd "$(dirname "$0")/data"

echo "▶ Téléchargement de ${PBF}…"
wget -N -O "${PBF}" "${BASE}/${PBF}"

echo "▶ Extraction (profil voiture)…"
docker run --rm -t -v "${PWD}:/data" osrm/osrm-backend osrm-extract -p /opt/car.lua "/data/${PBF}"

echo "▶ Partition…"
docker run --rm -t -v "${PWD}:/data" osrm/osrm-backend osrm-partition "/data/${OSRM}"

echo "▶ Customize…"
docker run --rm -t -v "${PWD}:/data" osrm/osrm-backend osrm-customize "/data/${OSRM}"

echo ""
echo "✅ Données prêtes (${OSRM})."
echo "   Démarrez le serveur :   REGION=${REGION} docker compose up -d"
echo "   Puis dans le .env :     OSRM_URL=http://127.0.0.1:5000"

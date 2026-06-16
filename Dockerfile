FROM node:20-alpine
WORKDIR /app

# Dépendances (cache optimisé)
COPY package*.json ./
RUN npm install --omit=dev

# Code de l'application
COPY . .

ENV PORT=3000
EXPOSE 3000

# Les données vivent dans /app/data — montez un volume ici pour les conserver.
VOLUME ["/app/data"]

CMD ["node", "server.js"]

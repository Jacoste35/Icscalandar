// Configuration PM2 (alternative à systemd) pour INTER COLIS SERVICES.
// Démarrage :  pm2 start ecosystem.config.js && pm2 save && pm2 startup
// Les variables sensibles sont lues depuis le fichier .env (via dotenv,
// chargé au démarrage de server.js).
module.exports = {
  apps: [
    {
      name: 'inter-colis',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};

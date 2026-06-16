'use strict';

// Envoi d'emails (identifiants de connexion). Utilise nodemailer via SMTP,
// configuré par variables d'environnement. Si la configuration SMTP est
// absente, l'envoi est ignoré silencieusement (l'app continue de fonctionner).
//
// Variables attendues :
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
//   SMTP_SECURE = "true" pour TLS direct (port 465), sinon STARTTLS
//   MAIL_FROM   = adresse expéditeur (ex. "Inter Colis Services <no-reply@…>")
//   APP_URL     = adresse du site, incluse dans l'email (facultatif)

let transporter = null;
let nodemailer = null;

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const MAIL_ENABLED = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);

if (MAIL_ENABLED) {
  try {
    nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: String(process.env.SMTP_SECURE) === 'true',
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      // Évite de bloquer la création de compte si le SMTP ne répond pas.
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 10000,
    });
  } catch (e) {
    console.error('Initialisation email impossible:', e.message);
    transporter = null;
  }
}

function mailEnabled() {
  return Boolean(transporter);
}

// Envoie les identifiants de connexion à un utilisateur. Ne lève jamais
// d'exception : renvoie true/false selon le succès.
async function sendCredentials({ to, firstName, login, password }) {
  if (!transporter || !to) return false;
  const appUrl = process.env.APP_URL || '';
  const from = process.env.MAIL_FROM || SMTP_USER;
  const text =
    `Bonjour ${firstName || ''},\n\n` +
    `Votre compte sur le portail INTER COLIS SERVICES a été créé.\n\n` +
    `Identifiant (nom de compte) : ${login}\n` +
    `Mot de passe : ${password}\n\n` +
    (appUrl ? `Connectez-vous ici : ${appUrl}\n\n` : '') +
    `Pour votre sécurité, pensez à ne pas communiquer ces informations.\n\n` +
    `L'équipe INTER COLIS SERVICES`;
  const html =
    `<p>Bonjour ${firstName || ''},</p>` +
    `<p>Votre compte sur le portail <strong>INTER COLIS SERVICES</strong> a été créé.</p>` +
    `<ul><li><strong>Identifiant (nom de compte)</strong> : ${login}</li>` +
    `<li><strong>Mot de passe</strong> : ${password}</li></ul>` +
    (appUrl ? `<p><a href="${appUrl}">Se connecter au portail</a></p>` : '') +
    `<p style="color:#64748b">Pour votre sécurité, ne communiquez pas ces informations.</p>` +
    `<p>L'équipe INTER COLIS SERVICES</p>`;
  try {
    await transporter.sendMail({ from, to, subject: 'Vos identifiants — Portail INTER COLIS SERVICES', text, html });
    return true;
  } catch (e) {
    console.error('Échec envoi email à', to, ':', e.message);
    return false;
  }
}

module.exports = { sendCredentials, mailEnabled };

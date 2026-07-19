// niche-finder/mailer.js
// Envoi d'email via SMTP Brevo. Aucun quota YouTube, aucun token IA.

import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import nodemailer from 'nodemailer';

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const user = process.env.BREVO_SMTP_USER;
  const pass = process.env.BREVO_SMTP_KEY;
  if (!user || !pass) {
    throw new Error('BREVO_SMTP_USER / BREVO_SMTP_KEY manquants dans .env');
  }

  transporter = nodemailer.createTransport({
    host: 'smtp-relay.brevo.com',
    port: 587,
    secure: false,          // STARTTLS sur 587
    auth: { user, pass },
  });

  return transporter;
}

// Envoie un email. { subject, html, text } — text optionnel (fallback).
export async function sendMail({ subject, html, text }) {
  const from = process.env.MAIL_FROM;
  const to = process.env.MAIL_TO;
  if (!from || !to) throw new Error('MAIL_FROM / MAIL_TO manquants dans .env');

  const info = await getTransporter().sendMail({
    from: `"Niche Finder" <${from}>`,
    to,
    subject,
    text: text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    html,
  });

  return { messageId: info.messageId, accepted: info.accepted };
}

// Vérifie la connexion SMTP sans envoyer.
export async function verifyMail() {
  await getTransporter().verify();
  return true;
}
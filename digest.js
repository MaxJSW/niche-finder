// niche-finder/digest.js
// Digest quotidien : lit les gems du jour non notifiées, fait rédiger un
// résumé par Claude, envoie par mail, marque comme notifiées.

import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import Anthropic from '@anthropic-ai/sdk';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';
import { sendMail } from './mailer.js';

const __filename = fileURLToPath(import.meta.url);
const MODEL = 'claude-sonnet-4-5';
const MAX_GEMS = 25;   // plafond envoyé à l'IA

function today() {
  return new Date().toISOString().slice(0, 10);
}

function fmt(n) {
  if (n == null) return '—';
  n = Number(n);
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}

// --- Lecture ---

async function pendingGems() {
  const [rows] = await pool.query(
    `SELECT id, kind, entity_id, label, handle, metric,
            base_value, current_value, previous_delta, recent_delta, score
     FROM gems
     WHERE detected_date = ? AND notified = 0
     ORDER BY score DESC
     LIMIT ?`,
    [today(), MAX_GEMS]
  );
  return rows;
}

async function markNotified(ids) {
  if (!ids.length) return;
  await pool.query('UPDATE gems SET notified = 1 WHERE id IN (?)', [ids]);
}

// --- Mise en forme ---

function gemUrl(g) {
  if (g.kind === 'scan_discovery' || g.kind === 'video_views' || g.kind === 'target_video_views') {
    return `https://www.youtube.com/watch?v=${g.entity_id}`;
  }
  return `https://www.youtube.com/channel/${g.entity_id}`;
}

// Résumé compact pour le prompt (pas de HTML, pas d'URL : l'IA n'en a pas besoin).
function toPromptLines(gems) {
  return gems.map((g, i) => {
    if (g.kind === 'scan_discovery') {
      return `${i + 1}. [DÉCOUVERTE] "${g.label}" — chaîne ${g.handle} · ${fmt(g.current_value)} vues · ${fmt(g.base_value)} abonnés · ratio ${g.recent_delta} · mot-clé "${g.metric}" · score ${g.score}`;
    }
    const what = g.kind === 'channel_subs' ? 'chaîne suivie'
               : g.kind === 'target_subs' ? 'chaîne cible'
               : g.kind === 'target_video_views' ? 'vidéo concurrente'
               : 'vidéo épinglée';
    return `${i + 1}. [ACCÉLÉRATION · ${what}] "${g.label}" — +${fmt(g.recent_delta)} ${g.metric} sur la période récente contre +${fmt(g.previous_delta)} sur la précédente · total ${fmt(g.current_value)} · score ${g.score}`;
  }).join('\n');
}

// --- Rédaction IA ---

async function writeSummary(gems) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY manquante dans .env');

  const client = new Anthropic({ apiKey });

  const prompt = `Tu rédiges le résumé quotidien d'un outil de veille YouTube destiné à un créateur qui cherche des niches exploitables pour lancer des chaînes.

Voici les signaux détectés aujourd'hui :

${toPromptLines(gems)}

Rédige un résumé en français, 4 à 6 lignes maximum, en texte brut (pas de markdown, pas de titres).

Consignes :
- Dis d'emblée si ça vaut le coup d'aller voir le dashboard ou non.
- Distingue les découvertes (vidéos repérées par scan) des accélérations (chaînes déjà suivies qui décollent).
- Signale ce qui ressemble à une niche exploitable et ce qui n'est que du contenu grand public sans intérêt pour un créateur solo (films, clips musicaux, chaînes de célébrités).
- Sois direct et concret. Pas de formule d'introduction, pas de conclusion polie.`;

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }],
  });

  return res.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();
}

// --- HTML ---

function buildHtml(summary, gems) {
  const rows = gems.map(g => {
    const badge = g.kind === 'scan_discovery' ? '🔎 Découverte'
                : g.kind === 'channel_subs' ? '📈 Chaîne suivie'
                : g.kind === 'target_subs' ? '🎯 Chaîne cible'
                : g.kind === 'target_video_views' ? '⚔️ Vidéo concurrente'
                : '📌 Vidéo épinglée';

    const detail = g.kind === 'scan_discovery'
      ? `${fmt(g.current_value)} vues · ${fmt(g.base_value)} abo · ratio ${g.recent_delta} · "${g.metric}"`
      : `+${fmt(g.recent_delta)} ${g.metric} (avant : +${fmt(g.previous_delta)}) · total ${fmt(g.current_value)}`;

    return `<tr>
      <td style="padding:10px 8px;border-bottom:1px solid #eee;font-size:13px;color:#666;white-space:nowrap">${badge}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #eee;font-size:14px">
        <a href="${gemUrl(g)}" style="color:#1a1a1a;text-decoration:none;font-weight:600">${escapeHtml(g.label || g.entity_id)}</a>
        ${g.handle ? `<div style="color:#888;font-size:12px;margin-top:2px">${escapeHtml(g.handle)}</div>` : ''}
        <div style="color:#666;font-size:12px;margin-top:4px">${detail}</div>
      </td>
      <td style="padding:10px 8px;border-bottom:1px solid #eee;text-align:right;font-size:15px;font-weight:600;color:#0a7c3a">${Math.round(g.score)}</td>
    </tr>`;
  }).join('');

  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:680px;margin:0 auto;color:#1a1a1a">
    <h2 style="font-size:19px;margin:0 0 4px">🔍 Niche Finder — ${today()}</h2>
    <div style="color:#888;font-size:13px;margin-bottom:18px">${gems.length} signal${gems.length > 1 ? 'aux' : ''} détecté${gems.length > 1 ? 's' : ''}</div>
    <div style="background:#f6f7f9;border-left:3px solid #0a7c3a;padding:14px 16px;font-size:14px;line-height:1.6;white-space:pre-wrap;margin-bottom:22px">${escapeHtml(summary)}</div>
    <table style="width:100%;border-collapse:collapse">${rows}</table>
    <div style="color:#aaa;font-size:12px;margin-top:22px">Niche Finder · digest automatique</div>
  </div>`;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- Orchestration ---

export async function run({ dryRun = false } = {}) {
  const gems = await pendingGems();

  if (!gems.length) {
    console.log('[digest] aucun signal nouveau aujourd\'hui — pas d\'envoi.');
    return { sent: false, count: 0 };
  }

  console.log(`[digest] ${gems.length} signal(aux) à traiter.`);

  const summary = await writeSummary(gems);
  const html = buildHtml(summary, gems);

  if (dryRun) {
    console.log('\n--- RÉSUMÉ IA ---\n' + summary + '\n');
    console.log('[digest] dry-run : rien envoyé, rien marqué.');
    return { sent: false, count: gems.length, summary };
  }

  const info = await sendMail({
    subject: `🔍 Niche Finder — ${gems.length} signal${gems.length > 1 ? 'aux' : ''} · ${today()}`,
    html,
  });

  await markNotified(gems.map(g => g.id));

  console.log(`[digest] envoyé à ${info.accepted.join(', ')} · ${gems.length} signal(aux) marqué(s) notifié(s).`);
  return { sent: true, count: gems.length };
}

if (process.argv[1] === __filename) {
  process.loadEnvFile(new URL('./.env', import.meta.url));
  const dryRun = process.argv.includes('--dry');
  run({ dryRun })
    .then(() => pool.end())
    .catch(err => { console.error('\n💥', err.message); pool.end(); process.exit(1); });
}
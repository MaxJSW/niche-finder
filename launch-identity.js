// niche-finder/launch-identity.js
// Génère un rapport « identité de chaîne » à partir du groupe de modèles
// d'un lancement (seed + concurrents). Sert à créer la chaîne YouTube
// manuellement : noms, bio, tags prêts à coller, + ligne éditoriale et
// format recommandés. Stocké dans launch_reports avec kind = 'identity'.
// Aucun crawl, aucune conso de quota : exploite les données déjà en base.

import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import Anthropic from '@anthropic-ai/sdk';
import { pool } from './db.js';

const MODEL = 'claude-sonnet-4-5';
const TOP_VIDEOS_PER_CHANNEL = 8;   // échantillon de contenu par chaîne modèle

// --- Collecte des données du groupe ---

async function loadGroup(launchId) {
  const [[launch]] = await pool.query(
    'SELECT id, name, seed_channel_id, target_language FROM launches WHERE id = ?',
    [launchId]);
  if (!launch) throw new Error('Lancement introuvable.');

  const [channels] = await pool.query(`
    SELECT lc.channel_id, lc.role,
           tc.channel_title, tc.handle, tc.subscribers, tc.video_count
    FROM launch_channels lc
    LEFT JOIN target_channels tc ON tc.channel_id = lc.channel_id
    WHERE lc.launch_id = ?
    ORDER BY FIELD(lc.role, 'seed', 'competitor', 'extra'), tc.subscribers DESC
  `, [launchId]);
  if (!channels.length) throw new Error('Aucune chaîne dans ce lancement.');

  // Vidéos du groupe avec leurs dernières vues connues.
  const [videos] = await pool.query(`
    SELECT v.channel_id, v.title, v.duration_seconds, v.published_at, v.tags, s.views
    FROM launch_channels lc
    JOIN target_videos v ON v.channel_id = lc.channel_id
    LEFT JOIN target_video_stats s ON s.id = (
      SELECT id FROM target_video_stats
      WHERE video_id = v.video_id
      ORDER BY captured_date DESC LIMIT 1
    )
    WHERE lc.launch_id = ?
  `, [launchId]);

  return { launch, channels, videos };
}

// --- Mise en forme du contexte pour Claude ---

function buildGroupBlock(channels, videos) {
  // Regroupe les vidéos par chaîne, top N par vues.
  const byChannel = new Map();
  for (const v of videos) {
    if (!byChannel.has(v.channel_id)) byChannel.set(v.channel_id, []);
    byChannel.get(v.channel_id).push(v);
  }

  const blocks = [];
  for (const ch of channels) {
    const all = byChannel.get(ch.channel_id) || [];

    // Cadence moyenne estimée sur les vidéos en base (nb / étendue en semaines).
    let rhythm = '';
    const dated = all.filter(v => v.published_at).map(v => new Date(v.published_at).getTime());
    if (dated.length >= 2) {
      const spanWeeks = (Math.max(...dated) - Math.min(...dated)) / (7 * 86400000);
      if (spanWeeks >= 1) {
        const perWeek = dated.length / spanWeeks;
        rhythm = perWeek >= 1
          ? ` · ~${perWeek.toFixed(1)} vidéos/semaine`
          : ` · ~1 vidéo/${Math.round(1 / perWeek)} semaines`;
      }
    }

    const meta = [];
    if (ch.subscribers != null) meta.push(`${ch.subscribers} abonnés`);
    if (ch.video_count != null) meta.push(`${ch.video_count} vidéos`);
    const header = `### ${ch.channel_title || ch.channel_id}`
      + ` (${ch.role}${meta.length ? ' · ' + meta.join(' · ') : ''}${rhythm})`;

    const vids = [...all]
      .filter(v => v.views != null)
      .sort((a, b) => b.views - a.views)
      .slice(0, TOP_VIDEOS_PER_CHANNEL);

    const lines = vids.map(v => {
      const mins = v.duration_seconds ? `${Math.round(v.duration_seconds / 60)} min` : '—';
      const when = v.published_at
        ? new Date(v.published_at).toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' })
        : '—';
      return `- "${v.title}" · ${mins} · ${v.views} vues · ${when}`;
    });

    blocks.push(header + '\n' + (lines.length ? lines.join('\n') : '- (pas de contenu crawlé)'));
  }
  return blocks.join('\n\n');
}

// --- Appel Claude ---

async function askClaude({ seedTitle, targetLanguage, groupBlock }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY manquante dans .env');
  const client = new Anthropic({ apiKey });

  const prompt = `Tu aides un créateur solo à définir l'identité d'une NOUVELLE chaîne YouTube, en t'inspirant d'un groupe de chaînes modèles qui réussissent sur ce créneau (chaîne principale de référence : "${seedTitle}").

La chaîne à lancer publiera en langue "${targetLanguage}". Les chaînes modèles peuvent être dans une autre langue.

Voici le groupe de modèles et un échantillon de leurs vidéos les plus vues (pour saisir le format, le ton et les sujets qui marchent) :

${groupBlock}

Analyse ce groupe et propose une identité de chaîne cohérente, différenciée (ne copie pas une chaîne existante, synthétise le meilleur du créneau pour le public "${targetLanguage}").

RÈGLE DE LANGUE, impérative :
- Ce qui sera collé publiquement sur YouTube — "channel_names", "bio", "tags" — DOIT être rédigé en "${targetLanguage}".
- Ce qui guide le créateur — "editorial_line", "format", "publishing_rhythm", "tone" — DOIT être rédigé en FRANÇAIS.

Réponds UNIQUEMENT avec un objet JSON, sans aucun texte autour, sans backticks, avec exactement ces clés :
{
  "channel_names": ["3 noms de chaîne possibles, en ${targetLanguage}"],
  "bio": "description/bio YouTube prête à coller, développée (7-8 phrases : accroche, ce qu'on couvre, ce qui rend la chaîne unique, promesse au spectateur, invitation à s'abonner), en ${targetLanguage}",
  "tags": ["20 à 30 tags SEO en ${targetLanguage}, mots-clés du créneau"],
  "editorial_line": {
    "covers": "ce que la chaîne couvre (en français)",
    "avoids": "ce qu'elle ne couvre PAS, pour rester nette (en français)"
  },
  "format": {
    "target_duration": "durée cible d'une vidéo (en français)",
    "structure": "structure type d'une vidéo : hook, corps, fin (en français)"
  },
  "publishing_rhythm": "cadence de publication recommandée pour démarrer (en français). IMPORTANT : la production de cette chaîne est en grande partie AUTOMATISÉE (voix off IA, montage automatisé) — le temps de production humain n'est PAS le facteur limitant, ne recommande donc pas un rythme lent au motif que le créateur est seul. Cale-toi plutôt sur ce que publient réellement la chaîne modèle et ses concurrents (voir la cadence indiquée pour chaque chaîne du groupe ci-dessus) : vise un rythme au moins comparable, quitte à le dépasser légèrement si le créneau n'est pas saturé. Donne un chiffre concret (vidéos par semaine) et une durée cible cohérente avec les formats qui performent dans le groupe.",
  "tone": "ton et style narratif (en français)"
}`;

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 3000,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = res.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  const clean = raw.replace(/```json|```/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    throw new Error(`Réponse IA non parsable : ${clean.slice(0, 200)}`);
  }

  // Validation souple : les clés structurantes doivent être présentes.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Réponse IA : objet JSON attendu.');
  }
  if (!Array.isArray(parsed.channel_names) || !parsed.channel_names.length) {
    throw new Error('Réponse IA : "channel_names" manquant ou vide.');
  }
  if (!parsed.bio || !Array.isArray(parsed.tags)) {
    throw new Error('Réponse IA : "bio" ou "tags" manquant.');
  }

  return parsed;
}

// --- Orchestration ---

async function generateIdentity(launchId) {
  const { launch, channels, videos } = await loadGroup(launchId);

  const seedTitle = channels.find(c => c.role === 'seed')?.channel_title || '—';
  const targetLanguage = launch.target_language || 'en';
  const groupBlock = buildGroupBlock(channels, videos);

  const identity = await askClaude({ seedTitle, targetLanguage, groupBlock });

  const [r] = await pool.query(
    `INSERT INTO launch_reports (launch_id, kind, content) VALUES (?, 'identity', ?)`,
    [launchId, JSON.stringify(identity)]);

  return {
    launchId: Number(launchId),
    reportId: r.insertId,
    channelsUsed: channels.length,
    videosSampled: videos.length,
    identity,
  };
}

export { generateIdentity };
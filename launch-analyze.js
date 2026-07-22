// niche-finder/launch-analyze.js
// Analyse d'un lancement : crawl des chaînes du groupe si nécessaire,
// pré-filtre des meilleures vidéos longues, appel Claude pour sélectionner
// et ordonner les vidéos à reproduire, insertion des picks par vague.
// Les helpers de quota (readQuota/addQuota/limit) sont injectés par la route.

import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import Anthropic from '@anthropic-ai/sdk';
import { pool } from './db.js';
import { crawlChannel } from './channel.js';
import { saveChannelCrawl } from './save-target.js';

const MODEL = 'claude-sonnet-4-5';
const MIN_DURATION = 180;      // vidéos longues uniquement (≥ 3 min)
const PER_CHANNEL = 20;        // top N par chaîne dans le panier candidats
const CRAWL_MAX_AGE_DAYS = 7;  // au-delà, on re-crawle
const CRAWL_MAX_PAGES = 5;     // 250 vidéos max par chaîne au crawl

// --- Étape 1 : crawl des chaînes manquantes ou périmées ---

async function crawlStaleChannels(channels, { readQuota, addQuota, quotaLimit }) {
  const perChannelEstimate = 1 + CRAWL_MAX_PAGES * 2;
  const crawled = [];
  const skipped = [];

  for (const ch of channels) {
    const ageDays = ch.last_crawled_at
      ? (Date.now() - new Date(ch.last_crawled_at).getTime()) / 86400000
      : Infinity;
    if (ageDays < CRAWL_MAX_AGE_DAYS && ch.crawled_videos > 0) continue;

    const q = await readQuota();
    if (q.used + perChannelEstimate > quotaLimit) {
      skipped.push({ channelId: ch.channel_id, reason: 'quota' });
      continue;
    }

    try {
      const crawl = await crawlChannel(ch.channel_id, { maxPages: CRAWL_MAX_PAGES });
      await saveChannelCrawl(crawl, { isSeed: false });
      await addQuota(crawl.quotaUsed);
      crawled.push({ channelId: ch.channel_id, channelTitle: crawl.channel.channelTitle,
                     videos: crawl.count, quotaUsed: crawl.quotaUsed });
    } catch (err) {
      skipped.push({ channelId: ch.channel_id, reason: err.message });
    }
  }

  return { crawled, skipped };
}

// --- Étape 2 : panier de candidats ---

function monthsSince(date) {
  return Math.round((Date.now() - new Date(date).getTime()) / (30.44 * 86400000) * 10) / 10;
}

async function buildCandidates(launchId, channelIds) {
  const [rows] = await pool.query(`
    SELECT
      v.video_id, v.channel_id, v.title, v.duration_seconds, v.published_at, v.tags,
      tc.channel_title,
      s.views
    FROM target_videos v
    JOIN target_channels tc ON tc.channel_id = v.channel_id
    LEFT JOIN target_video_stats s ON s.id = (
      SELECT id FROM target_video_stats
      WHERE video_id = v.video_id
      ORDER BY captured_date DESC LIMIT 1
    )
    WHERE v.channel_id IN (?)
      AND v.duration_seconds >= ?
      AND v.video_id NOT IN (
        SELECT video_id FROM launch_picks WHERE launch_id = ?
      )
  `, [channelIds, MIN_DURATION, launchId]);

  // Médiane des vues par chaîne (sur toutes ses vidéos longues remontées).
  const byChannel = new Map();
  for (const r of rows) {
    if (r.views == null) continue;
    if (!byChannel.has(r.channel_id)) byChannel.set(r.channel_id, []);
    byChannel.get(r.channel_id).push(r);
  }

  const candidates = [];
  for (const [, vids] of byChannel) {
    const sorted = [...vids].sort((a, b) => a.views - b.views);
    const median = sorted[Math.floor(sorted.length / 2)].views || 1;

    for (const v of vids) {
      const ratio = Math.round((v.views / Math.max(median, 1)) * 100) / 100;
      v.ratio = ratio;
      v.score = ratio * Math.log10(v.views + 10);
    }
    vids.sort((a, b) => b.score - a.score);
    candidates.push(...vids.slice(0, PER_CHANNEL));
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

// --- Étape 3 : appel Claude ---

function candidateLines(candidates, idMap) {
  return candidates.map((c, i) => {
    const id = `v${i}`;
    idMap.set(id, c);
    const tags = Array.isArray(c.tags) ? c.tags.slice(0, 6).join(', ')
               : c.tags ? String(c.tags).slice(0, 80) : '—';
    return `${id} | ${c.channel_title} | "${c.title}" | ${Math.round(c.duration_seconds / 60)} min | ${monthsSince(c.published_at)} mois | ${c.views} vues | ratio x${c.ratio} | tags: ${tags}`;
  }).join('\n');
}

async function pickWithClaude({ candidates, batchSize, batch, donePicks, rejectedPicks, lastReport, seedTitle, targetLanguage }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY manquante dans .env');
  const client = new Anthropic({ apiKey });

  const idMap = new Map();
  const lines = candidateLines(candidates, idMap);

  let context = '';
  if (batch > 1) {
    context = `\nCONTEXTE — la chaîne est déjà lancée, ceci est la vague ${batch} :\n`;
    if (donePicks.length) {
      context += `\nVidéos déjà publiées (ligne éditoriale établie — reste cohérent, pas de doublon thématique) :\n`
        + donePicks.map(p => `- "${p.title}" (angle : ${p.angle || '—'})`).join('\n') + '\n';
    }
    if (rejectedPicks.length) {
      context += `\nDirections écartées par le créateur (n'y reviens pas) :\n`
        + rejectedPicks.map(p => `- "${p.title}"`).join('\n') + '\n';
    }
    if (lastReport) {
      context += `\nDernier bilan de la chaîne (suis ses recommandations) :\n${lastReport}\n`;
    }
  }

  const prompt = `Tu aides un créateur solo à lancer une chaîne YouTube automatisée en t'inspirant d'un groupe de chaînes modèles (chaîne principale : "${seedTitle}").

La chaîne à lancer sera en langue "${targetLanguage}" — les chaînes modèles peuvent être dans une autre langue. Prends-le en compte : un sujet déjà saturé en ${targetLanguage} vaut moins qu'un sujet validé ailleurs mais peu exploité en ${targetLanguage} ; et les angles que tu proposes doivent être pensés pour le public ${targetLanguage}.

Voici les vidéos candidates du groupe, avec leurs métriques (ratio = vues / médiane de leur chaîne, donc la sur-performance) :

${lines}
${context}
Sélectionne les ${batchSize} vidéos à reproduire en priorité, dans un ORDRE DE PUBLICATION stratégique pour une chaîne qui ${batch > 1 ? 'poursuit son développement' : 'démarre de zéro'} : commence par des sujets accessibles à forte demande prouvée, monte en complexité ensuite.

Critères, par importance :
1. Sur-performance (ratio élevé) — le sujet dépasse l'audience habituelle de sa chaîne
2. Vues brutes — la demande est validée en volume
3. Faisabilité pour une chaîne débutante — écarte ce qui ne marche que par la notoriété du créateur (face-cam, suites d'épisodes, formats à gros budget)
4. Diversité maîtrisée — pas ${batchSize} fois le même sujet, mais une ligne éditoriale cohérente

Réponds UNIQUEMENT avec un tableau JSON, sans aucun texte autour, sans backticks :
[{"id": "v12", "reason": "pourquoi cette vidéo, en une phrase", "angle": "comment l'adapter/différencier, en une phrase"}, ...]

Exactement ${batchSize} éléments, ordonnés du premier au dernier à publier. Le champ "id" doit reprendre exactement un identifiant de la liste.`;

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
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
  if (!Array.isArray(parsed)) throw new Error('Réponse IA : tableau JSON attendu.');

  // Validation stricte : id connu, pas de doublon, plafond batchSize.
  const picks = [];
  const seen = new Set();
  for (const p of parsed) {
    const cand = idMap.get(p?.id);
    if (!cand || seen.has(p.id)) continue;
    seen.add(p.id);
    picks.push({
      videoId: cand.video_id,
      channelId: cand.channel_id,
      reason: String(p.reason || '').slice(0, 1000),
      angle: String(p.angle || '').slice(0, 1000),
    });
    if (picks.length >= batchSize) break;
  }
  if (!picks.length) throw new Error('Réponse IA : aucun pick valide.');

  return picks;
}

// --- Orchestration ---

async function analyzeLaunch(launchId, { batchSize = 20, readQuota, addQuota, quotaLimit } = {}) {
  if (!readQuota || !addQuota || !quotaLimit) {
    throw new Error('Helpers quota requis (readQuota, addQuota, quotaLimit).');
  }

  // Verrou : refuse si une analyse est déjà en cours.
  const [[launch]] = await pool.query('SELECT * FROM launches WHERE id = ?', [launchId]);
  if (!launch) throw new Error('Lancement introuvable.');
  if (launch.status === 'analyzing') throw new Error('Analyse déjà en cours pour ce lancement.');
  const prevStatus = launch.status;
  await pool.query(`UPDATE launches SET status = 'analyzing' WHERE id = ?`, [launchId]);

  try {
    const [channels] = await pool.query(`
      SELECT lc.channel_id, lc.role, tc.channel_title, tc.last_crawled_at,
             (SELECT COUNT(*) FROM target_videos WHERE channel_id = lc.channel_id) AS crawled_videos
      FROM launch_channels lc
      LEFT JOIN target_channels tc ON tc.channel_id = lc.channel_id
      WHERE lc.launch_id = ?
    `, [launchId]);
    if (!channels.length) throw new Error('Aucune chaîne dans ce lancement.');

    // Vague courante + contexte des vagues précédentes.
    const [[{ maxBatch }]] = await pool.query(
      'SELECT MAX(batch) AS maxBatch FROM launch_picks WHERE launch_id = ?', [launchId]);
    const batch = (maxBatch || 0) + 1;

    const [prevPicks] = await pool.query(`
      SELECT p.status, p.angle, v.title
      FROM launch_picks p
      LEFT JOIN target_videos v ON v.video_id = p.video_id
      WHERE p.launch_id = ?
    `, [launchId]);
    const donePicks = prevPicks.filter(p => p.status === 'done');
    const rejectedPicks = prevPicks.filter(p => p.status === 'rejected');

    const [[report]] = await pool.query(
      `SELECT content FROM launch_reports
       WHERE launch_id = ? AND kind = 'bilan'
       ORDER BY created_at DESC LIMIT 1`,
      [launchId]);

    // 1. Crawls nécessaires.
    const crawlReport = await crawlStaleChannels(channels, { readQuota, addQuota, quotaLimit });

    // 2. Panier de candidats.
    const candidates = await buildCandidates(launchId, channels.map(c => c.channel_id));
    if (candidates.length < batchSize) {
      throw new Error(`Seulement ${candidates.length} candidats disponibles pour ${batchSize} picks demandés — crawle plus de chaînes ou réduis batchSize.`);
    }

    // 3. Sélection IA.
    const seedTitle = channels.find(c => c.role === 'seed')?.channel_title || '—';
    const picks = await pickWithClaude({
      candidates, batchSize, batch, donePicks, rejectedPicks,
      lastReport: report?.content || null, seedTitle,
      targetLanguage: launch.target_language || 'en',
    });

    // 4. Insertion en transaction.
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const values = picks.map((p, i) =>
        [launchId, batch, p.videoId, p.channelId, i + 1, p.reason, p.angle]);
      await conn.query(
        `INSERT INTO launch_picks
           (launch_id, batch, video_id, channel_id, rank_position, reason, angle)
         VALUES ?`,
        [values]);
      await conn.query(`UPDATE launches SET status = 'ready' WHERE id = ?`, [launchId]);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    return {
      launchId: Number(launchId),
      batch,
      picksInserted: picks.length,
      candidates: candidates.length,
      crawled: crawlReport.crawled,
      crawlSkipped: crawlReport.skipped,
    };
  } catch (err) {
    // Restaure l'état d'avant l'analyse (le verrou ne doit jamais rester collé).
    await pool.query('UPDATE launches SET status = ? WHERE id = ?', [prevStatus, launchId])
      .catch(() => {});
    throw err;
  }
}

export { analyzeLaunch };
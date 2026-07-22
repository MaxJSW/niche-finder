// niche-finder/server.js
// Étape 3a : route de scan déclenchée par l'interface + compteur de quota journalier.

import express from 'express';
import dns from 'node:dns';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { scanKeyword } from './scan.js';   // la fonction déjà exportée de scan.js
import { searchChannels } from './search-channels.js';
import { buildQueries, findCompetitors } from './competitors.js';
import { linkCompetitor, unlinkCompetitor, listCompetitors, listAllLinks, listCrawlCandidates } from './competitors-links.js';
import { competitorsOverview } from './competitors-overview.js';
import { addQuery, listQueries, updateQuery, deleteQuery, getResults, runQuery } from './queries.js';
import { pinVideo, followChannel, recordScan } from './save.js';
import { crawlChannel, resolveChannelId } from './channel.js';
import { createLaunch, listLaunches, getLaunch, updateLaunch,
         addLaunchChannel, removeLaunchChannel, deleteLaunch, updatePickStatus } from './launches.js';
import { analyzeLaunch } from './launch-analyze.js';
import { generateIdentity } from './launch-identity.js';
import { fetchMaterials } from './launch-materials.js';
import { saveChannelCrawl } from './save-target.js';
import { detectBreakouts } from './breakout.js';
import { videoHistory, channelHistory, targetChannelHistory, sparklines } from './history.js';
import { listScans, keywordSummary, globalStats } from './scans-log.js';
import { fetchTranscript, getTranscript } from './transcripts.js';
import { listThemes, createTheme, updateTheme, deleteTheme,
         addItem, removeItem, moveItem, reorderItems } from './themes.js';
import { themeContent, unclassified, themeBadges } from './themes-view.js';
import { pool } from './db.js';

dns.setDefaultResultOrder('ipv4first');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3100;
const QUOTA_FILE = path.join(__dirname, 'data', 'quota.json');
const QUOTA_LIMIT = 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Compteur de quota journalier (persistant, remis à zéro chaque jour) ---

function today() {
  return new Date().toISOString().slice(0, 10);  // ex. "2026-07-16"
}

async function readQuota() {
  try {
    const q = JSON.parse(await readFile(QUOTA_FILE, 'utf-8'));
    // Nouveau jour ? -> on repart de zéro.
    if (q.date !== today()) return { date: today(), used: 0 };
    return q;
  } catch {
    return { date: today(), used: 0 };  // fichier absent = première utilisation
  }
}

async function addQuota(cost) {
  const q = await readQuota();
  q.used += cost;
  await writeFile(QUOTA_FILE, JSON.stringify(q));
  return q;
}

// --- Routes ---

// Renvoie le dernier scan (inchangé).
app.get('/api/latest', async (req, res) => {
  try {
    const raw = await readFile(path.join(__dirname, 'data', 'latest.json'), 'utf-8');
    res.type('application/json').send(raw);
  } catch {
    res.status(404).json({ error: 'Aucun scan trouvé. Lance un scan.' });
  }
});

// Renvoie l'état du quota du jour (pour l'affichage).
app.get('/api/quota', async (req, res) => {
  const q = await readQuota();
  res.json({ ...q, limit: QUOTA_LIMIT, remaining: QUOTA_LIMIT - q.used });
});

// LA nouvelle route : lance un scan pour un mot-clé.
app.post('/api/scan', async (req, res) => {
  const keyword = (req.body?.keyword || '').trim();
  if (!keyword) return res.status(400).json({ error: 'Mot-clé manquant.' });

  // Options pilotées par l'UI (null/absent = mondial).
  const regionCode = req.body?.regionCode || null;
  const relevanceLanguage = req.body?.relevanceLanguage || null;
  const deep = req.body?.deep === true;

  // Garde-fou : refuse si le quota du jour est déjà au plafond.
  // Scan simple ~102 u, scan approfondi ~306 u (3 tris).
  const estimate = deep ? 310 : 105;
  const q = await readQuota();
  if (q.used + estimate > QUOTA_LIMIT) {
    return res.status(429).json({ error: `Quota journalier presque épuisé (${q.used}/${QUOTA_LIMIT}). Réessaie demain.` });
  }

  try {
    console.log(`🔍 Scan demandé : "${keyword}" (région: ${regionCode || 'mondial'}, langue: ${relevanceLanguage || 'toutes'})`);
    const output = await scanKeyword(keyword, { regionCode, relevanceLanguage, deep });

    // Sauvegarde comme le fait scan.js (historique + latest.json pour l'UI).
    const slug = keyword.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const stamp = output.fetchedAt.replace(/[:.]/g, '-');
    await writeFile(path.join(__dirname, 'data', `${slug}_${stamp}.json`), JSON.stringify(output, null, 2));
    await writeFile(path.join(__dirname, 'data', 'latest.json'), JSON.stringify(output, null, 2));

    const quota = await addQuota(output.quotaUsed);   // +102
    console.log(`✅ ${output.count} vidéos · quota jour : ${quota.used}/${QUOTA_LIMIT}`);

    // Trace le mot-clé + le scan en base, uniquement si le scan a donné des résultats.
    if (output.count > 0) {
      try {
        await recordScan(keyword, { quotaUsed: output.quotaUsed, videoCount: output.count });
        console.log(`🗄️  Scan tracé en base : "${keyword}" (scan_count++)`);
      } catch (dbErr) {
        console.error('⚠️  Traçage scan en base échoué (scan quand même renvoyé) :', dbErr.message);
      }
    }

    res.json({ ...output, quota });
  } catch (err) {
    console.error('💥 Scan échoué :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Épingle une vidéo (+ suit sa chaîne d'office) — enregistrement sélectif en base.
app.post('/api/pin', async (req, res) => {
  const { video, keyword } = req.body || {};
  if (!video?.videoId || !keyword) {
    return res.status(400).json({ error: 'Champs "video" (avec videoId) et "keyword" requis.' });
  }
  try {
    const result = await pinVideo(video, keyword);
    console.log(`📌 Vidéo épinglée : ${result.pinned}`);
    res.json(result);
  } catch (err) {
    console.error('💥 Épinglage échoué :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Suit une chaîne seule (source 'manual').
app.post('/api/follow', async (req, res) => {
  const { channel } = req.body || {};
  if (!channel?.channelId) {
    return res.status(400).json({ error: 'Champ "channel" (avec channelId) requis.' });
  }
  try {
    const result = await followChannel(channel);
    console.log(`👁️ Chaîne suivie : ${result.followed}`);
    res.json(result);
  } catch (err) {
    console.error('💥 Suivi échoué :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Arrête de suivre une chaîne (supprime + son historique via CASCADE).
app.post('/api/unfollow', async (req, res) => {
  const { channelId } = req.body || {};
  if (!channelId) return res.status(400).json({ error: 'channelId requis.' });
  try {
    await pool.query('DELETE FROM channels WHERE channel_id = ?', [channelId]);
    console.log(`🙈 Chaîne désuivie : ${channelId}`);
    res.json({ unfollowed: channelId });
  } catch (err) {
    console.error('💥 /api/unfollow :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Liste les vidéos épinglées, avec leur dernier relevé de stats connu.
app.get('/api/pins', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        v.video_id, v.title, v.channel_id, v.channel_title,
        v.published_at, v.duration_seconds, v.thumbnail, v.first_seen,
        vs.views, vs.subscribers, vs.ratio, vs.captured_at
      FROM videos v
      LEFT JOIN video_stats vs ON vs.id = (
        SELECT id FROM video_stats
        WHERE video_id = v.video_id
        ORDER BY captured_at DESC
        LIMIT 1
      )
      WHERE v.pinned = 1
      ORDER BY v.first_seen DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('💥 /api/pins :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Liste les vidéos archivées (désépinglées mais conservées).
app.get('/api/pins/archived', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        v.video_id, v.title, v.channel_id, v.channel_title,
        v.published_at, v.duration_seconds, v.thumbnail, v.first_seen,
        vs.views, vs.subscribers, vs.ratio, vs.captured_at
      FROM videos v
      LEFT JOIN video_stats vs ON vs.id = (
        SELECT id FROM video_stats
        WHERE video_id = v.video_id
        ORDER BY captured_at DESC
        LIMIT 1
      )
      WHERE v.pinned = 0
      ORDER BY v.first_seen DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('💥 /api/pins/archived :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Désépingle une vidéo (archive : pinned -> 0, garde les données).
app.post('/api/unpin', async (req, res) => {
  const { videoId } = req.body || {};
  if (!videoId) return res.status(400).json({ error: 'videoId requis.' });
  try {
    await pool.query('UPDATE videos SET pinned = 0 WHERE video_id = ?', [videoId]);
    console.log(`📎 Vidéo désépinglée (archivée) : ${videoId}`);
    res.json({ unpinned: videoId });
  } catch (err) {
    console.error('💥 /api/unpin :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Ré-épingle une vidéo archivée (pinned -> 1).
app.post('/api/repin', async (req, res) => {
  const { videoId } = req.body || {};
  if (!videoId) return res.status(400).json({ error: 'videoId requis.' });
  try {
    await pool.query('UPDATE videos SET pinned = 1 WHERE video_id = ?', [videoId]);
    console.log(`📌 Vidéo ré-épinglée : ${videoId}`);
    res.json({ repinned: videoId });
  } catch (err) {
    console.error('💥 /api/repin :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Supprime définitivement une vidéo (+ ses stats via ON DELETE CASCADE).
app.delete('/api/pins/:videoId', async (req, res) => {
  const { videoId } = req.params;
  try {
    await pool.query('DELETE FROM videos WHERE video_id = ?', [videoId]);
    console.log(`🗑️ Vidéo supprimée : ${videoId}`);
    res.json({ deleted: videoId });
  } catch (err) {
    console.error('💥 DELETE /api/pins :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Liste les chaînes suivies, avec leur dernier relevé d'abonnés connu.
app.get('/api/follows', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        c.channel_id, c.channel_title, c.handle, c.channel_url, c.source, c.followed_at,
        cs.subscribers, cs.captured_at
      FROM channels c
      LEFT JOIN channel_stats cs ON cs.id = (
        SELECT id FROM channel_stats
        WHERE channel_id = c.channel_id
        ORDER BY captured_at DESC
        LIMIT 1
      )
      ORDER BY c.followed_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('💥 /api/follows :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Liste les mots-clés déjà recherchés (les 15 plus scannés), pour les badges cliquables.
app.get('/api/keywords', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT keyword, scan_count, first_seen, auto_scan
      FROM keywords
      ORDER BY scan_count DESC, first_seen DESC
      LIMIT 100
    `);
    res.json(rows);
  } catch (err) {
    console.error('💥 /api/keywords :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Enregistre un mot-clé manuellement (sans scan, sans quota). scan_count=1 à la création.
app.post('/api/keyword', async (req, res) => {
  const keyword = (req.body?.keyword || '').trim();
  if (!keyword) return res.status(400).json({ error: 'Mot-clé manquant.' });
  try {
    // Crée avec scan_count=1 ; si déjà présent, on ne touche à rien (no-op).
    await pool.query(
      `INSERT INTO keywords (keyword, scan_count) VALUES (?, 1)
       ON DUPLICATE KEY UPDATE id = id`,
      [keyword]
    );
    console.log(`➕ Mot-clé mémorisé : "${keyword}"`);
    res.json({ saved: keyword });
  } catch (err) {
    console.error('💥 /api/keyword :', err.message);
    res.status(500).json({ error: err.message });
  }
});


// Bascule le flag auto_scan d'un mot-clé (inclusion dans le scan automatique nocturne).
app.post('/api/keyword/auto', async (req, res) => {
  const keyword = (req.body?.keyword || '').trim();
  const auto = req.body?.auto === true ? 1 : 0;
  if (!keyword) return res.status(400).json({ error: 'Mot-clé manquant.' });
  try {
    const [r] = await pool.query(
      'UPDATE keywords SET auto_scan = ? WHERE keyword = ?',
      [auto, keyword]
    );
    if (!r.affectedRows) return res.status(404).json({ error: 'Mot-clé inconnu.' });
    console.log(`${auto ? '🌙' : '⭕'} auto_scan ${auto ? 'activé' : 'désactivé'} : "${keyword}"`);
    res.json({ keyword, auto_scan: auto });
  } catch (err) {
    console.error('💥 /api/keyword/auto :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Supprime définitivement un mot-clé (+ ses scans associés via FK).
app.delete('/api/keyword/:keyword', async (req, res) => {
  const keyword = decodeURIComponent(req.params.keyword).trim();
  if (!keyword) return res.status(400).json({ error: 'Mot-clé manquant.' });
  try {
    const [r] = await pool.query('DELETE FROM keywords WHERE keyword = ?', [keyword]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Mot-clé introuvable.' });
    console.log(`🗑️ Mot-clé supprimé : "${keyword}"`);
    res.json({ deleted: keyword });
  } catch (err) {
    console.error('💥 DELETE /api/keyword :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Détection de chaînes breakout sur les profils remontés par un scan.
// Appelée en arrière-plan par l'UI juste après le rendu du tableau.
// Coût : ~3 u par candidat inspecté (8 max), soit ~24 u.
app.post('/api/breakouts', async (req, res) => {
  const channels = req.body?.channels;
  if (!Array.isArray(channels)) {
    return res.status(400).json({ error: 'Champ "channels" (tableau) requis.' });
  }

  const q = await readQuota();
  if (q.used + 30 > QUOTA_LIMIT) {
    // Pas d'erreur bloquante : le scan a déjà réussi, on renonce juste à la détection.
    return res.json({ breakouts: [], skipped: 'quota', quota: q });
  }

  try {
    const result = await detectBreakouts(channels, {
      thresholds: req.body?.thresholds || undefined,
    });

    const quota = await addQuota(result.quotaUsed);
    if (result.breakouts.length) {
      console.log(`🚀 ${result.breakouts.length} breakout(s) : ${result.breakouts.map(b => b.channelTitle).join(', ')}`);
    }

    res.json({
      breakouts: result.breakouts,
      candidatesChecked: result.candidatesChecked,
      quotaUsed: result.quotaUsed,
      quota,
    });
  } catch (err) {
    console.error('💥 /api/breakouts :', err.message);
    res.status(500).json({ error: err.message });
  }
});


// Recherche de chaînes par nom (search.list type=channel).
// Coût : 100u par page (2 pages max) + 1u par lot de 50 → ~202u.
// Affichage volatil : rien n'est écrit en base, le bouton 🎯 renvoie vers targets.html.
app.post('/api/search/channels', async (req, res) => {
  const keyword = (req.body?.keyword || '').trim();
  if (!keyword) return res.status(400).json({ error: 'Mot-clé manquant.' });

  const regionCode = req.body?.regionCode || null;
  const relevanceLanguage = req.body?.relevanceLanguage || null;
  const maxPages = Number(req.body?.maxPages) === 1 ? 1 : 2;

  const estimate = maxPages === 1 ? 105 : 210;
  const q = await readQuota();
  if (q.used + estimate > QUOTA_LIMIT) {
    return res.status(429).json({ error: `Quota journalier presque épuisé (${q.used}/${QUOTA_LIMIT}). Réessaie demain.` });
  }

  try {
    console.log(`📺 Recherche de chaînes : "${keyword}" (${maxPages} page${maxPages > 1 ? 's' : ''})`);
    const output = await searchChannels(keyword, { regionCode, relevanceLanguage, maxPages });

    const quota = await addQuota(output.quotaUsed);
    console.log(`✅ ${output.count} chaînes · quota jour : ${quota.used}/${QUOTA_LIMIT}`);

    res.json({ ...output, quota });
  } catch (err) {
    console.error('💥 Recherche de chaînes échouée :', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ============================================================
//  BLOC CONCURRENTIEL — chaînes cibles (distinct de la watchlist)
// ============================================================

// Crawl complet d'une chaîne : métadonnées + toutes ses vidéos + relevés datés.
app.post('/api/target/crawl', async (req, res) => {
  const channelId = (req.body?.channelId || '').trim();
  if (!channelId) return res.status(400).json({ error: 'channelId requis.' });

  const maxPages = Number(req.body?.maxPages) || undefined;

  // Estimation haute du coût avant de lancer (garde-fou quota).
  const q = await readQuota();
  const estimate = 1 + (maxPages ?? 20) * 2;
  if (q.used + estimate > QUOTA_LIMIT) {
    return res.status(429).json({ error: `Quota insuffisant (${q.used}/${QUOTA_LIMIT}).` });
  }

  try {
    console.log(`🎯 Crawl chaîne : ${channelId}`);
    const crawl = await crawlChannel(channelId, { maxPages });
    const saved = await saveChannelCrawl(crawl, { isSeed: false });

    const quota = await addQuota(crawl.quotaUsed);
    console.log(`✅ ${saved.videosSaved} vidéos · quota jour : ${quota.used}/${QUOTA_LIMIT}`);

    res.json({
      channel: crawl.channel,
      videosSaved: saved.videosSaved,
      truncated: crawl.truncated,
      quotaUsed: crawl.quotaUsed,
      quota,
    });
  } catch (err) {
    console.error('💥 Crawl échoué :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Liste les chaînes cibles crawlées.
app.get('/api/target/channels', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        tc.channel_id, tc.channel_title, tc.handle, tc.subscribers,
        tc.video_count, tc.total_views, tc.is_seed, tc.last_crawled_at,
        (SELECT COUNT(*) FROM target_videos WHERE channel_id = tc.channel_id) AS crawled_videos
      FROM target_channels tc
      ORDER BY tc.last_crawled_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('💥 /api/target/channels :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Vidéos d'une chaîne cible, avec dernier relevé + delta de vues sur la période.
// ?days=30 -> compare au relevé le plus proche d'il y a 30 jours.
app.get('/api/target/videos/:channelId', async (req, res) => {
  const { channelId } = req.params;
  const days = Number(req.query.days) || 30;
  const minDuration = Number(req.query.minDuration) || 120;

  try {
    // Comptage par format (sur TOUTES les vidéos stockées, filtre ou non).
    const [[counts]] = await pool.query(`
      SELECT
        COUNT(*) AS total,
        SUM(duration_seconds <= 60) AS shorts,
        SUM(duration_seconds > 60 AND duration_seconds < ?) AS courtes,
        SUM(duration_seconds >= ?) AS longues
      FROM target_videos
      WHERE channel_id = ?
    `, [minDuration, minDuration, channelId]);

    const [rows] = await pool.query(`
      SELECT
        v.video_id, v.title, v.published_at, v.duration_seconds,
        v.thumbnail, v.tags,
        last.views, last.likes, last.comments, last.captured_date,
        prev.views AS prev_views, prev.captured_date AS prev_date,
        (last.views - prev.views) AS views_delta
      FROM target_videos v
      LEFT JOIN target_video_stats last ON last.id = (
        SELECT id FROM target_video_stats
        WHERE video_id = v.video_id
        ORDER BY captured_date DESC LIMIT 1
      )
      LEFT JOIN target_video_stats prev ON prev.id = (
        SELECT id FROM target_video_stats
        WHERE video_id = v.video_id
          AND captured_date <= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        ORDER BY captured_date DESC LIMIT 1
      )
      WHERE v.channel_id = ? AND v.duration_seconds >= ?
      ORDER BY last.views DESC
    `, [days, channelId, minDuration]);

    res.json({
      counts: {
        total:   Number(counts.total   || 0),
        shorts:  Number(counts.shorts  || 0),
        courtes: Number(counts.courtes || 0),
        longues: Number(counts.longues || 0),
      },
      minDuration,
      videos: rows,
    });
  } catch (err) {
    console.error('💥 /api/target/videos :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Supprime une chaîne cible et tout son historique (CASCADE).
app.delete('/api/target/channels/:channelId', async (req, res) => {
  const { channelId } = req.params;
  try {
    await pool.query('DELETE FROM target_channels WHERE channel_id = ?', [channelId]);
    console.log(`🗑️ Chaîne cible supprimée : ${channelId}`);
    res.json({ deleted: channelId });
  } catch (err) {
    console.error('💥 DELETE /api/target/channels :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Marque / démarque une chaîne comme cible stratégique. Décision 100% manuelle.
app.post('/api/target/seed', async (req, res) => {
  const channelId = (req.body?.channelId || '').trim();
  const seed = req.body?.seed === true ? 1 : 0;
  if (!channelId) return res.status(400).json({ error: 'channelId requis.' });
  try {
    const [r] = await pool.query(
      'UPDATE target_channels SET is_seed = ? WHERE channel_id = ?',
      [seed, channelId]
    );
    if (!r.affectedRows) return res.status(404).json({ error: 'Chaîne inconnue.' });
    console.log(`${seed ? '🎯' : '⭕'} Cible ${seed ? 'activée' : 'retirée'} : ${channelId}`);
    res.json({ channelId, is_seed: seed });
  } catch (err) {
    console.error('💥 /api/target/seed :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Propose les requêtes de recherche à partir des vidéos d'une chaîne cible. Gratuit.
// mode: 'titles' (titres des top vidéos) | 'lexical' (vocabulaire récurrent).
app.post('/api/competitors/queries', async (req, res) => {
  const channelId = (req.body?.channelId || '').trim();
  if (!channelId) return res.status(400).json({ error: 'channelId requis.' });

  const count = Math.min(Math.max(Number(req.body?.count) || 5, 1), 10);
  const mode = req.body?.mode === 'segments' ? 'segments' : 'titles';

  try {
    const out = await buildQueries(channelId, { count, mode });
    res.json(out);
  } catch (err) {
    console.error('💥 /api/competitors/queries :', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Lance les recherches sur les requêtes validées et agrège les chaînes candidates.
// Coût : 100u par requête + ~2u d'enrichissement.
app.post('/api/competitors/find', async (req, res) => {
  const channelId = (req.body?.channelId || '').trim();
  const queries = Array.isArray(req.body?.queries)
    ? req.body.queries.map(q => String(q).trim()).filter(Boolean).slice(0, 10)
    : [];

  if (!channelId) return res.status(400).json({ error: 'channelId requis.' });
  if (!queries.length) return res.status(400).json({ error: 'Aucune requête sélectionnée.' });

  const regionCode = req.body?.regionCode || null;
  const relevanceLanguage = req.body?.relevanceLanguage || null;
  const minQueryCount = Number(req.body?.minQueryCount) === 1 ? 1 : 2;

  const estimate = queries.length * 100 + 10;
  const q = await readQuota();
  if (q.used + estimate > QUOTA_LIMIT) {
    return res.status(429).json({ error: `Quota insuffisant : ${estimate} u nécessaires, ${QUOTA_LIMIT - q.used} restants.` });
  }

  try {
    console.log(`🔎 Concurrents de ${channelId} · ${queries.length} requête(s)`);
    const out = await findCompetitors(channelId, { queries, regionCode, relevanceLanguage, minQueryCount });

    const quota = await addQuota(out.quotaUsed);
    console.log(`✅ ${out.candidatesFound} candidats · quota jour : ${quota.used}/${QUOTA_LIMIT}`);

    res.json({ ...out, quota });
  } catch (err) {
    console.error('💥 /api/competitors/find :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Lie manuellement (ou après validation d'une suggestion) un concurrent à une chaîne source.
app.post('/api/competitors/link', async (req, res) => {
  try {
    const out = await linkCompetitor({
      sourceChannelId: (req.body?.sourceChannelId || '').trim(),
      competitorChannelId: (req.body?.competitorChannelId || '').trim(),
      competitorTitle: req.body?.competitorTitle || null,
      via: req.body?.via || 'manual',
      score: req.body?.score != null ? Number(req.body.score) : null,
    });
    console.log(`🔗 Concurrent lié : ${out.competitorChannelId} -> ${out.sourceTitle}${out.created ? '' : ' (mise à jour)'}`);
    res.json(out);
  } catch (err) {
    console.error('💥 /api/competitors/link :', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Délie un concurrent (ne supprime rien d'autre).
app.delete('/api/competitors/link', async (req, res) => {
  try {
    const out = await unlinkCompetitor({
      sourceChannelId: (req.body?.sourceChannelId || '').trim(),
      competitorChannelId: (req.body?.competitorChannelId || '').trim(),
    });
    console.log(`✂️ Concurrent délié : ${out.unlinked}`);
    res.json(out);
  } catch (err) {
    console.error('💥 DELETE /api/competitors/link :', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Vue d'ensemble par groupes concurrentiels (page concurrence.html). Gratuit.
app.get('/api/competitors/overview', async (req, res) => {
  try {
    res.json(await competitorsOverview());
  } catch (err) {
    console.error('💥 /api/competitors/overview :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Toutes les paires source -> concurrent (état initial des boutons 🔗).
app.get('/api/competitors/links', async (req, res) => {
  try {
    res.json(await listAllLinks());
  } catch (err) {
    console.error('💥 /api/competitors/links (all) :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Liste les concurrents liés d'une chaîne source (enrichis si crawlés).
app.get('/api/competitors/links/:channelId', async (req, res) => {
  try {
    res.json(await listCompetitors(req.params.channelId));
  } catch (err) {
    console.error('💥 /api/competitors/links :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Crawl en lot des concurrents liés (jamais crawlés ou trop anciens).
// { sourceChannelId? } limite aux concurrents d'une seule source ; absent = tous.
// Séquentiel, avec garde-fou quota AVANT chaque chaîne : la boucle s'arrête
// proprement si le quota ne suffit plus, et renvoie un rapport détaillé.
app.post('/api/competitors/crawl', async (req, res) => {
  const sourceChannelId = (req.body?.sourceChannelId || '').trim() || null;
  const maxAgeDays = Number(req.body?.maxAgeDays) || 7;
  const maxPages = Math.min(Math.max(Number(req.body?.maxPages) || 5, 1), 20);
  const perChannelEstimate = 1 + maxPages * 2;

  try {
    const candidates = await listCrawlCandidates({ sourceChannelId, maxAgeDays });
    if (!candidates.length) {
      return res.json({ candidates: 0, crawled: [], skipped: [], failed: [], quota: await readQuota() });
    }

    console.log(`🕸️ Crawl concurrents : ${candidates.length} candidat(s)${sourceChannelId ? ` (source ${sourceChannelId})` : ''}`);

    const crawled = [];
    const skipped = [];
    const failed = [];

    for (const cand of candidates) {
      const q = await readQuota();
      if (q.used + perChannelEstimate > QUOTA_LIMIT) {
        skipped.push({ channelId: cand.channel_id, channelTitle: cand.channel_title, reason: 'quota' });
        continue;
      }

      try {
        const crawl = await crawlChannel(cand.channel_id, { maxPages });
        const saved = await saveChannelCrawl(crawl, { isSeed: false });
        await addQuota(crawl.quotaUsed);
        console.log(`  ✅ ${crawl.channel.channelTitle} : ${saved.videosSaved} vidéos · ${crawl.quotaUsed} u`);
        crawled.push({
          channelId: cand.channel_id,
          channelTitle: crawl.channel.channelTitle,
          videosSaved: saved.videosSaved,
          quotaUsed: crawl.quotaUsed,
          truncated: crawl.truncated,
        });
      } catch (err) {
        console.error(`  💥 ${cand.channel_id} : ${err.message}`);
        failed.push({ channelId: cand.channel_id, channelTitle: cand.channel_title, error: err.message });
      }
    }

    const quota = await readQuota();
    console.log(`🕸️ Terminé : ${crawled.length} crawlée(s), ${skipped.length} sautée(s), ${failed.length} échec(s) · quota ${quota.used}/${QUOTA_LIMIT}`);
    res.json({ candidates: candidates.length, crawled, skipped, failed, quota: { ...quota, limit: QUOTA_LIMIT } });
  } catch (err) {
    console.error('💥 /api/competitors/crawl :', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ============================================================
//  TRANSCRIPTIONS — récupération yt-dlp à la demande (gratuit côté quota YouTube)
// ============================================================

// Récupère et stocke la transcription d'une vidéo. Aucun coût de quota API
// (yt-dlp, pas YouTube Data API), mais ~10-30 s d'exécution.
app.post('/api/transcripts/fetch', async (req, res) => {
  const videoId = (req.body?.videoId || '').trim();
  const channelId = (req.body?.channelId || '').trim();
  if (!videoId || !channelId) {
    return res.status(400).json({ error: 'videoId et channelId requis.' });
  }

  try {
    console.log(`📝 Transcription demandée : ${videoId}`);
    const out = await fetchTranscript(videoId, channelId);

    if (!out.ok) {
      console.log(`⚠️  Pas de transcription pour ${videoId} (${out.reason})`);
      return res.status(404).json({ error: `Aucune transcription disponible (${out.reason}).`, ...out });
    }

    console.log(`✅ Transcription ${videoId} : ${out.language}${out.isOriginal ? ' (originale)' : ' (traduction)'} · ${out.wordCount} mots`);
    res.json(out);
  } catch (err) {
    console.error('💥 /api/transcripts/fetch :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Lit une transcription déjà en base. Gratuit.
app.get('/api/transcripts/:videoId', async (req, res) => {
  try {
    const row = await getTranscript(req.params.videoId);
    if (!row) return res.status(404).json({ error: 'Transcription introuvable.' });
    res.json(row);
  } catch (err) {
    console.error('💥 GET /api/transcripts :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// État des transcriptions pour un lot de vidéos — pour afficher 📝 ou ✅ sur les boutons.
app.post('/api/transcripts/status', async (req, res) => {
  const videoIds = Array.isArray(req.body?.videoIds)
    ? req.body.videoIds.map(v => String(v).trim()).filter(Boolean).slice(0, 500)
    : [];
  if (!videoIds.length) return res.status(400).json({ error: 'videoIds (tableau) requis.' });

  try {
    const [rows] = await pool.query(
      `SELECT video_id, language, is_original, word_count, fetched_at
         FROM transcripts
        WHERE video_id IN (?)`,
      [videoIds]
    );
    res.json(rows);
  } catch (err) {
    console.error('💥 /api/transcripts/status :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  LANCEMENTS — projets de création de chaîne (module Lancements)
// ============================================================

// Crée un lancement (nom + seed + concurrents cochés + extras déjà résolus).
app.post('/api/launches', async (req, res) => {
  try {
    const out = await createLaunch({
      name: req.body?.name,
      seedChannelId: req.body?.seedChannelId,
      competitorIds: Array.isArray(req.body?.competitorIds) ? req.body.competitorIds : [],
      extraIds: Array.isArray(req.body?.extraIds) ? req.body.extraIds : [],
    });
    console.log(`🚀 Lancement créé : "${out.name}" (${out.channels} chaînes)`);
    res.json(out);
  } catch (err) {
    console.error('💥 POST /api/launches :', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Liste des lancements.
app.get('/api/launches', async (req, res) => {
  try {
    res.json(await listLaunches());
  } catch (err) {
    console.error('💥 GET /api/launches :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Pré-remplissage du formulaire de création : concurrents déjà liés à un seed.
// (Déclarée AVANT /api/launches/:id pour ne pas être capturée par elle.)
app.get('/api/launches/setup/:seedChannelId', async (req, res) => {
  try {
    res.json(await listCompetitors(req.params.seedChannelId));
  } catch (err) {
    console.error('💥 /api/launches/setup :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Détail complet d'un lancement (groupe, picks par vague, bilans).
app.get('/api/launches/:id', async (req, res) => {
  try {
    res.json(await getLaunch(Number(req.params.id)));
  } catch (err) {
    console.error('💥 GET /api/launches/:id :', err.message);
    res.status(404).json({ error: err.message });
  }
});

// Modifie nom / notes / own_channel_id / statut.
app.patch('/api/launches/:id', async (req, res) => {
  try {
    res.json(await updateLaunch(Number(req.params.id), req.body || {}));
  } catch (err) {
    console.error('💥 PATCH /api/launches :', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Supprime un lancement (groupe, picks, bilans via CASCADE).
app.delete('/api/launches/:id', async (req, res) => {
  try {
    const out = await deleteLaunch(Number(req.params.id));
    console.log(`🗑️ Lancement supprimé : ${req.params.id}`);
    res.json(out);
  } catch (err) {
    console.error('💥 DELETE /api/launches :', err.message);
    res.status(404).json({ error: err.message });
  }
});

// Ajoute une chaîne au groupe — accepte ID UC..., @handle ou URL (résolution auto, 0-1u).
app.post('/api/launches/:id/channels', async (req, res) => {
  const input = (req.body?.channel || '').trim();
  const role = req.body?.role === 'extra' ? 'extra' : 'competitor';
  if (!input) return res.status(400).json({ error: 'Champ "channel" requis (ID, @handle ou URL).' });

  try {
    const { channelId, quotaUsed } = await resolveChannelId(input);
    if (quotaUsed) await addQuota(quotaUsed);

    const out = await addLaunchChannel(Number(req.params.id), channelId, role);
    console.log(`➕ Chaîne ajoutée au lancement ${req.params.id} : ${channelId} (${role})`);
    res.json(out);
  } catch (err) {
    console.error('💥 POST /api/launches/channels :', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Retire une chaîne du groupe (le seed est protégé côté module).
app.delete('/api/launches/:id/channels/:channelId', async (req, res) => {
  try {
    const out = await removeLaunchChannel(Number(req.params.id), req.params.channelId);
    console.log(`➖ Chaîne retirée du lancement ${req.params.id} : ${req.params.channelId}`);
    res.json(out);
  } catch (err) {
    console.error('💥 DELETE /api/launches/channels :', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Lance l'analyse d'un lancement : crawls nécessaires + sélection IA d'une vague.
// Synchrone — peut prendre 1 à 3 minutes si des crawls sont nécessaires.
app.post('/api/launches/:id/analyze', async (req, res) => {
  const batchSize = Math.min(Math.max(Number(req.body?.batchSize) || 20, 3), 40);

  try {
    console.log(`🧠 Analyse du lancement ${req.params.id} (vague de ${batchSize})`);
    const out = await analyzeLaunch(Number(req.params.id), {
      batchSize,
      readQuota,
      addQuota,
      quotaLimit: QUOTA_LIMIT,
    });
    console.log(`✅ Vague ${out.batch} : ${out.picksInserted} picks (${out.candidates} candidats)`);
    res.json(out);
  } catch (err) {
    console.error('💥 /api/launches/analyze :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Récupère le matériel des picks (transcriptions + miniatures physiques).
// Synchrone — ~15 s par vidéo non transcrite. { batch: N } limite à une vague.
app.post('/api/launches/:id/materials', async (req, res) => {
  const batch = Number(req.body?.batch) || null;

  try {
    console.log(`📦 Matériel du lancement ${req.params.id}${batch ? ` (vague ${batch})` : ''}`);
    const out = await fetchMaterials(Number(req.params.id), { batch });
    console.log(`✅ ${out.summary.transcriptsOk}/${out.summary.total} transcriptions · ${out.summary.thumbnailsOk}/${out.summary.total} miniatures`);
    res.json(out);
  } catch (err) {
    console.error('💥 /api/launches/materials :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Génère le rapport « identité de chaîne » à partir du groupe de modèles seul.
// Synchrone — un seul appel Claude, aucun crawl, aucun quota YouTube. Régénérable :
// chaque appel insère un nouveau rapport kind='identity', le front affiche le dernier.
app.post('/api/launches/:id/identity', async (req, res) => {
  try {
    console.log(`📋 Identité de chaîne — lancement ${req.params.id}`);
    const out = await generateIdentity(Number(req.params.id));
    console.log(`✅ Identité générée (report ${out.reportId}) · ${out.channelsUsed} chaînes, ${out.videosSampled} vidéos`);
    res.json(out);
  } catch (err) {
    console.error('💥 /api/launches/identity :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Change le statut d'un pick (proposed / kept / rejected / done).
app.patch('/api/launches/picks/:pickId', async (req, res) => {
  try {
    const out = await updatePickStatus(Number(req.params.pickId), req.body?.status);
    console.log(`🏷️ Pick ${req.params.pickId} → ${out.status}`);
    res.json(out);
  } catch (err) {
    console.error('💥 PATCH /api/launches/picks :', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ============================================================
//  LISTE DE TITRES À EXPLORER (saved_queries + query_results)
// ============================================================

// Ajoute un titre à la liste. Gratuit.
app.post('/api/queries', async (req, res) => {
  try {
    const out = await addQuery(req.body || {});
    console.log(`➕ Titre ajouté : "${out.query}"${out.duplicate ? ' (déjà présent)' : ''}`);
    res.json(out);
  } catch (err) {
    console.error('💥 POST /api/queries :', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Liste les titres, avec le nombre de résultats stockés.
app.get('/api/queries', async (req, res) => {
  try {
    res.json(await listQueries(req.query.status || null));
  } catch (err) {
    console.error('💥 GET /api/queries :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Résultats stockés d'un titre. Gratuit — pas de nouvel appel YouTube.
app.get('/api/queries/:id/results', async (req, res) => {
  try {
    res.json(await getResults(Number(req.params.id)));
  } catch (err) {
    console.error('💥 GET /api/queries/results :', err.message);
    res.status(404).json({ error: err.message });
  }
});

// Lance la recherche YouTube sur un titre. ~102u.
app.post('/api/queries/:id/run', async (req, res) => {
  const id = Number(req.params.id);

  const q = await readQuota();
  if (q.used + 110 > QUOTA_LIMIT) {
    return res.status(429).json({ error: `Quota insuffisant (${q.used}/${QUOTA_LIMIT}).` });
  }

  try {
    const out = await runQuery(id, {
      regionCode: req.body?.regionCode || null,
      relevanceLanguage: req.body?.relevanceLanguage || null,
      minDuration: Number(req.body?.minDuration) || 120,
    });

    const quota = await addQuota(out.quotaUsed);
    console.log(`🔎 "${out.query}" → ${out.resultCount} chaînes · quota : ${quota.used}/${QUOTA_LIMIT}`);

    res.json({ ...out, quota });
  } catch (err) {
    console.error('💥 POST /api/queries/run :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Modifie le statut ou la note d'un titre.
app.patch('/api/queries/:id', async (req, res) => {
  try {
    res.json(await updateQuery(Number(req.params.id), req.body || {}));
  } catch (err) {
    console.error('💥 PATCH /api/queries :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Supprime un titre et ses résultats (CASCADE).
app.delete('/api/queries/:id', async (req, res) => {
  try {
    res.json(await deleteQuery(Number(req.params.id)));
  } catch (err) {
    console.error('💥 DELETE /api/queries :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  HISTORIQUE DES RELEVÉS (lecture seule, gratuit)
// ============================================================

// Toutes les séries d'un coup, pour les sparklines de pins.html. ?days=30
app.get('/api/history/sparklines', async (req, res) => {
  try {
    const days = Number(req.query.days) || 30;
    res.json(await sparklines(days));
  } catch (err) {
    console.error('💥 /api/history/sparklines :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Série détaillée d'une vidéo épinglée. ?days=90
app.get('/api/history/video/:videoId', async (req, res) => {
  try {
    const days = Number(req.query.days) || 90;
    res.json(await videoHistory(req.params.videoId, days));
  } catch (err) {
    console.error('💥 /api/history/video :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Série détaillée d'une chaîne suivie. ?days=90
app.get('/api/history/channel/:channelId', async (req, res) => {
  try {
    const days = Number(req.query.days) || 90;
    res.json(await channelHistory(req.params.channelId, days));
  } catch (err) {
    console.error('💥 /api/history/channel :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Série détaillée d'une chaîne cible (bloc concurrentiel). ?days=90
app.get('/api/history/target/:channelId', async (req, res) => {
  try {
    const days = Number(req.query.days) || 90;
    res.json(await targetChannelHistory(req.params.channelId, days));
  } catch (err) {
    console.error('💥 /api/history/target :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  JOURNAL D'ACTIVITÉ (scans + mots-clés) — lecture seule
// ============================================================

app.get('/api/log/scans', async (req, res) => {
  try {
    res.json(await listScans({
      limit: Number(req.query.limit) || 200,
      keyword: req.query.keyword || null,
    }));
  } catch (err) {
    console.error('💥 /api/log/scans :', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/log/keywords', async (req, res) => {
  try {
    res.json(await keywordSummary());
  } catch (err) {
    console.error('💥 /api/log/keywords :', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/log/stats', async (req, res) => {
  try {
    res.json(await globalStats());
  } catch (err) {
    console.error('💥 /api/log/stats :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  THÈMES — groupement manuel (lecture/écriture en base, gratuit)
// ============================================================

app.get('/api/themes', async (req, res) => {
  try {
    res.json(await listThemes());
  } catch (err) {
    console.error('💥 GET /api/themes :', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/themes', async (req, res) => {
  try {
    const out = await createTheme(req.body || {});
    console.log(`🏷️  Thème créé : "${out.name}"`);
    res.json(out);
  } catch (err) {
    console.error('💥 POST /api/themes :', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/themes/:id', async (req, res) => {
  try {
    res.json(await updateTheme(req.params.id, req.body || {}));
  } catch (err) {
    console.error('💥 PATCH /api/themes :', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/themes/:id', async (req, res) => {
  try {
    const out = await deleteTheme(req.params.id);
    console.log(`🗑️  Thème supprimé : ${req.params.id}`);
    res.json(out);
  } catch (err) {
    console.error('💥 DELETE /api/themes :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Contenu détaillé d'un thème (chaînes + cibles + titres).
app.get('/api/themes/:id/content', async (req, res) => {
  try {
    res.json(await themeContent(req.params.id));
  } catch (err) {
    console.error('💥 /api/themes/content :', err.message);
    res.status(404).json({ error: err.message });
  }
});

// Éléments non encore rangés — panneau source du drag and drop.
app.get('/api/themes/unclassified', async (req, res) => {
  try {
    res.json(await unclassified());
  } catch (err) {
    console.error('💥 /api/themes/unclassified :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Badges : { itemId: [{id, name, color}] } pour un type donné.
app.get('/api/themes/badges/:itemType', async (req, res) => {
  try {
    res.json(await themeBadges(req.params.itemType));
  } catch (err) {
    console.error('💥 /api/themes/badges :', err.message);
    res.status(400).json({ error: err.message });
  }
});

// --- Éléments ---

app.post('/api/themes/items', async (req, res) => {
  try {
    res.json(await addItem(req.body || {}));
  } catch (err) {
    console.error('💥 POST /api/themes/items :', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/themes/items', async (req, res) => {
  try {
    res.json(await removeItem(req.body || {}));
  } catch (err) {
    console.error('💥 DELETE /api/themes/items :', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/themes/items/move', async (req, res) => {
  try {
    res.json(await moveItem(req.body || {}));
  } catch (err) {
    console.error('💥 /api/themes/items/move :', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/themes/:id/reorder', async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    res.json(await reorderItems(req.params.id, items));
  } catch (err) {
    console.error('💥 /api/themes/reorder :', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`✅ Serveur prêt sur http://127.0.0.1:${PORT}`);
});
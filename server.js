// niche-finder/server.js
// Étape 3a : route de scan déclenchée par l'interface + compteur de quota journalier.

import express from 'express';
import dns from 'node:dns';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { scanKeyword } from './scan.js';   // la fonction déjà exportée de scan.js
import { pinVideo, followChannel, recordScan } from './save.js';
import { crawlChannel } from './channel.js';
import { saveChannelCrawl } from './save-target.js';
import { detectBreakouts } from './breakout.js';
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
      SELECT keyword, scan_count, first_seen
      FROM keywords
      ORDER BY scan_count DESC, first_seen DESC
      LIMIT 15
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
    const saved = await saveChannelCrawl(crawl, { isSeed: true });

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

app.listen(PORT, '127.0.0.1', () => {
  console.log(`✅ Serveur prêt sur http://127.0.0.1:${PORT}`);
});
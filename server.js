// niche-finder/server.js
// Étape 3a : route de scan déclenchée par l'interface + compteur de quota journalier.

import express from 'express';
import dns from 'node:dns';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { scanKeyword } from './scan.js';   // la fonction déjà exportée de scan.js
import { pinVideo, followChannel, recordScan } from './save.js';
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

  // Garde-fou : refuse si le quota du jour est déjà au plafond.
  const q = await readQuota();
  if (q.used + 102 > QUOTA_LIMIT) {
    return res.status(429).json({ error: `Quota journalier presque épuisé (${q.used}/${QUOTA_LIMIT}). Réessaie demain.` });
  }

  try {
    console.log(`🔍 Scan demandé : "${keyword}" (région: ${regionCode || 'mondial'}, langue: ${relevanceLanguage || 'toutes'})`);
    const output = await scanKeyword(keyword, { regionCode, relevanceLanguage });

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
        c.channel_id, c.channel_title, c.channel_url, c.source, c.followed_at,
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

app.listen(PORT, '127.0.0.1', () => {
  console.log(`✅ Serveur prêt sur http://127.0.0.1:${PORT}`);
});
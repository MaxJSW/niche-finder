// niche-finder/launch-materials.js
// Récupération du matériel de production pour les picks d'un lancement :
// transcription (via transcripts.js) + miniature téléchargée physiquement.
// Chemin miniatures : data/thumbs/{videoId}.jpg (déterministe, pas stocké en base).

import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';
import { fetchTranscript, getTranscript } from './transcripts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const THUMBS_DIR = path.join(__dirname, 'data', 'thumbs');

// Télécharge la miniature d'un pick si pas déjà sur disque.
async function downloadThumbnail(videoId, url) {
  if (!url) return { ok: false, reason: 'no_thumbnail_url' };

  const dest = path.join(THUMBS_DIR, `${videoId}.jpg`);
  try {
    await fs.access(dest);
    return { ok: true, skipped: true };          // déjà téléchargée
  } catch { /* absente -> on télécharge */ }

  const res = await fetch(url);
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };

  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
  return { ok: true, bytes: buf.length };
}

// --- Point d'entrée ---
// batch : limite à une vague précise ; absent = tous les picks du lancement.
async function fetchMaterials(launchId, { batch = null } = {}) {
  await fs.mkdir(THUMBS_DIR, { recursive: true });

  const [picks] = await pool.query(`
    SELECT p.video_id, p.channel_id, p.batch, v.thumbnail
    FROM launch_picks p
    LEFT JOIN target_videos v ON v.video_id = p.video_id
    WHERE p.launch_id = ?
      AND p.status != 'rejected'
      ${batch ? 'AND p.batch = ?' : ''}
    ORDER BY p.batch, p.rank_position
  `, batch ? [launchId, batch] : [launchId]);

  if (!picks.length) throw new Error('Aucun pick à traiter pour ce lancement.');

  const results = [];
  for (const p of picks) {
    const item = { videoId: p.video_id, batch: p.batch };

    // 1. Transcription — sautée si déjà en base.
    try {
      const existing = await getTranscript(p.video_id);
      if (existing) {
        item.transcript = { ok: true, skipped: true, wordCount: existing.word_count };
      } else {
        const r = await fetchTranscript(p.video_id, p.channel_id);
        item.transcript = r.ok
          ? { ok: true, language: r.language, isOriginal: r.isOriginal, wordCount: r.wordCount }
          : { ok: false, reason: r.reason };
      }
    } catch (err) {
      item.transcript = { ok: false, reason: err.message.slice(0, 120) };
    }

    // 2. Miniature — sautée si déjà sur disque.
    try {
      item.thumbnail = await downloadThumbnail(p.video_id, p.thumbnail);
    } catch (err) {
      item.thumbnail = { ok: false, reason: err.message.slice(0, 120) };
    }

    results.push(item);
  }

  const summary = {
    launchId: Number(launchId),
    batch,
    total: results.length,
    transcriptsOk: results.filter(r => r.transcript?.ok).length,
    thumbnailsOk: results.filter(r => r.thumbnail?.ok).length,
    failures: results.filter(r => !r.transcript?.ok || !r.thumbnail?.ok),
  };

  return { summary, results };
}

export { fetchMaterials };
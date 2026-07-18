// niche-finder/save-target.js
// Persistance du crawl concurrentiel : target_channels / target_videos
// + relevés datés (target_video_stats / target_channel_stats).
// Volontairement séparé de save.js (watchlist perso) — ne jamais mélanger.

import { pool } from './db.js';

// ISO 8601 -> DATETIME MySQL.
function toMysqlDate(iso) {
  if (!iso) return null;
  return new Date(iso).toISOString().slice(0, 19).replace('T', ' ');
}

// Date du jour au format DATE MySQL.
function today() {
  return new Date().toISOString().slice(0, 10);
}

// Upsert de la chaîne cible. isSeed = true si choisie par l'utilisateur.
async function upsertTargetChannel(conn, ch, isSeed) {
  await conn.query(
    `INSERT INTO target_channels
       (channel_id, channel_title, handle, uploads_playlist_id,
        subscribers, video_count, total_views, is_seed, last_crawled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       channel_title       = VALUES(channel_title),
       handle              = COALESCE(VALUES(handle), handle),
       uploads_playlist_id = COALESCE(VALUES(uploads_playlist_id), uploads_playlist_id),
       subscribers         = VALUES(subscribers),
       video_count         = VALUES(video_count),
       total_views         = VALUES(total_views),
       is_seed             = GREATEST(is_seed, VALUES(is_seed)),
       last_crawled_at     = NOW()`,
    [ch.channelId, ch.channelTitle, ch.handle, ch.uploadsPlaylistId,
     ch.subscribers, ch.videoCount, ch.totalViews, isSeed ? 1 : 0]
  );
}

// Relevé daté de la chaîne — un seul par jour.
async function insertTargetChannelStat(conn, ch) {
  await conn.query(
    `INSERT INTO target_channel_stats
       (channel_id, subscribers, total_views, video_count, captured_at, captured_date)
     VALUES (?, ?, ?, ?, NOW(), ?)
     ON DUPLICATE KEY UPDATE
       subscribers = VALUES(subscribers),
       total_views = VALUES(total_views),
       video_count = VALUES(video_count),
       captured_at = VALUES(captured_at)`,
    [ch.channelId, ch.subscribers, ch.totalViews, ch.videoCount, today()]
  );
}

// Fiches vidéo (métadonnées stables) — insertion par lots.
async function upsertTargetVideos(conn, videos) {
  if (!videos.length) return;

  const CHUNK = 100;
  for (let i = 0; i < videos.length; i += CHUNK) {
    const batch = videos.slice(i, i + CHUNK);
    const values = batch.map(v => [
      v.videoId, v.channelId, v.title, v.description,
      toMysqlDate(v.publishedAt), v.durationSeconds, v.thumbnail,
      v.tags ? JSON.stringify(v.tags) : null,
    ]);

    await conn.query(
      `INSERT INTO target_videos
         (video_id, channel_id, title, description,
          published_at, duration_seconds, thumbnail, tags)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         title            = VALUES(title),
         description      = VALUES(description),
         duration_seconds = VALUES(duration_seconds),
         thumbnail        = VALUES(thumbnail),
         tags             = VALUES(tags)`,
      [values]
    );
  }
}

// Relevés datés des vidéos — un seul par vidéo et par jour.
async function insertTargetVideoStats(conn, videos) {
  if (!videos.length) return;

  const d = today();
  const CHUNK = 100;

  for (let i = 0; i < videos.length; i += CHUNK) {
    const batch = videos.slice(i, i + CHUNK);
    const values = batch.map(v => [v.videoId, v.views, v.likes, v.comments, d]);

    await conn.query(
      `INSERT INTO target_video_stats
         (video_id, views, likes, comments, captured_date)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         views       = VALUES(views),
         likes       = VALUES(likes),
         comments    = VALUES(comments),
         captured_at = NOW()`,
      [values]
    );
  }
}

// --- Point d'entrée : enregistre un crawl complet ---
// crawl = objet retourné par crawlChannel() dans channel.js
async function saveChannelCrawl(crawl, { isSeed = true } = {}) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await upsertTargetChannel(conn, crawl.channel, isSeed);
    await insertTargetChannelStat(conn, crawl.channel);
    await upsertTargetVideos(conn, crawl.videos);
    await insertTargetVideoStats(conn, crawl.videos);

    await conn.commit();
    return {
      channelId: crawl.channel.channelId,
      videosSaved: crawl.videos.length,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export { saveChannelCrawl };
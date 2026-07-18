// niche-finder/save.js
// Enregistrement sélectif : on n'insère QUE ce que l'utilisateur épingle/suit.
// pinVideo()      : épingle une vidéo + suit sa chaîne (source 'video')
// followChannel() : suit une chaîne seule (source 'manual')
// Règle : un seul relevé de stats par jour (contrainte uniq_*_day en base).

import { pool } from './db.js';

// Convertit un ISO 8601 ("2026-06-17T18:58:31Z") en DATETIME MySQL ("2026-06-17 18:58:31").
function toMysqlDate(iso) {
  if (!iso) return null;
  return new Date(iso).toISOString().slice(0, 19).replace('T', ' ');
}

// Date du jour au format DATE MySQL ("2026-07-17").
function today() {
  return new Date().toISOString().slice(0, 10);
}

// Récupère (ou crée) le mot-clé SANS toucher scan_count, renvoie son id.
// scan_count est géré uniquement par les scans réels (voir recordScan dans save.js).
async function upsertKeyword(conn, keyword) {
  await conn.query(
    `INSERT INTO keywords (keyword, scan_count) VALUES (?, 0)
     ON DUPLICATE KEY UPDATE id = id`,
    [keyword]
  );
  const [rows] = await conn.query('SELECT id FROM keywords WHERE keyword = ?', [keyword]);
  return rows[0].id;
}

// Crée une ligne de scan rattachée au mot-clé, renvoie son id.
async function insertScan(conn, keywordId) {
  const [res] = await conn.query(
    `INSERT INTO scans (keyword_id, fetched_at, quota_used, video_count)
     VALUES (?, NOW(), 0, 0)`,
    [keywordId]
  );
  return res.insertId;
}

// Suit une chaîne (upsert). source = 'video' ou 'manual'.
async function upsertChannel(conn, { channelId, channelTitle, handle, channelUrl }, source) {
  await conn.query(
    `INSERT INTO channels (channel_id, channel_title, handle, channel_url, source)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE channel_title = VALUES(channel_title),
                             handle        = COALESCE(VALUES(handle), handle),
                             channel_url   = VALUES(channel_url)`,
    [channelId, channelTitle, handle ?? null, channelUrl, source]
  );
}

// Relevé daté d'une chaîne — un seul par jour (upsert sur la contrainte uniq_channel_day).
async function insertChannelStat(conn, channelId, scanId, subscribers) {
  await conn.query(
    `INSERT INTO channel_stats (channel_id, scan_id, subscribers, captured_at, captured_date)
     VALUES (?, ?, ?, NOW(), ?)
     ON DUPLICATE KEY UPDATE subscribers = VALUES(subscribers),
                             captured_at = VALUES(captured_at),
                             scan_id     = VALUES(scan_id)`,
    [channelId, scanId, subscribers ?? null, today()]
  );
}

// --- Épingler une vidéo (+ suivre sa chaîne) ---
async function pinVideo(video, keyword) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const keywordId = await upsertKeyword(conn, keyword);
    const scanId = await insertScan(conn, keywordId);

    // La chaîne de la vidéo est suivie d'office (source 'video').
    await upsertChannel(conn, {
      channelId: video.channelId,
      channelTitle: video.channelTitle,
      handle: video.handle,
      channelUrl: video.channelUrl,
    }, 'video');

    // Fiche vidéo : upsert (rafraîchit titre/description/miniature si déjà connue).
    await conn.query(
      `INSERT INTO videos
         (video_id, title, channel_id, channel_title, published_at,
          duration_seconds, description, thumbnail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE title = VALUES(title),
                               description = VALUES(description),
                               thumbnail = VALUES(thumbnail),
                               duration_seconds = VALUES(duration_seconds)`,
      [video.videoId, video.title, video.channelId, video.channelTitle,
       toMysqlDate(video.publishedAt), video.durationSeconds,
       video.description, video.thumbnail]
    );

    // Métriques datées de la vidéo — un seul relevé par jour.
    await conn.query(
      `INSERT INTO video_stats
         (scan_id, video_id, views, subscribers, ratio, captured_at, captured_date)
       VALUES (?, ?, ?, ?, ?, NOW(), ?)
       ON DUPLICATE KEY UPDATE views = VALUES(views),
                               subscribers = VALUES(subscribers),
                               ratio = VALUES(ratio),
                               captured_at = VALUES(captured_at),
                               scan_id = VALUES(scan_id)`,
      [scanId, video.videoId, video.views, video.subscribers, video.ratio, today()]
    );

    // Relevé d'abonnés de la chaîne (on profite du scan).
    await insertChannelStat(conn, video.channelId, scanId, video.subscribers);

    await conn.commit();
    return { pinned: video.videoId, channel: video.channelId };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// --- Suivre une chaîne seule ---
async function followChannel(channel) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await upsertChannel(conn, {
      channelId: channel.channelId,
      channelTitle: channel.channelTitle,
      handle: channel.handle,
      channelUrl: channel.channelUrl,
    }, 'manual');

    // Relevé d'abonnés au moment du suivi (hors scan -> scan_id NULL).
    await insertChannelStat(conn, channel.channelId, null, channel.subscribers);

    await conn.commit();
    return { followed: channel.channelId };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// --- Tracer un scan réel (appelé par /api/scan) ---
// Incrémente scan_count du mot-clé ET insère une ligne scans avec les vrais chiffres.
async function recordScan(keyword, { quotaUsed, videoCount }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Le scan réel est le SEUL endroit qui incrémente scan_count.
    await conn.query(
      `INSERT INTO keywords (keyword, scan_count) VALUES (?, 1)
       ON DUPLICATE KEY UPDATE scan_count = scan_count + 1`,
      [keyword]
    );
    const [rows] = await conn.query('SELECT id FROM keywords WHERE keyword = ?', [keyword]);
    const keywordId = rows[0].id;

    const [res] = await conn.query(
      `INSERT INTO scans (keyword_id, fetched_at, quota_used, video_count)
       VALUES (?, NOW(), ?, ?)`,
      [keywordId, quotaUsed ?? 0, videoCount ?? 0]
    );

    await conn.commit();
    return { keywordId, scanId: res.insertId };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export { pinVideo, followChannel, recordScan };
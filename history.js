// niche-finder/history.js
// Lecture de l'historique des relevés (tables *_stats). Aucun appel API, gratuit.
// Alimente les sparklines de pins.html et la page history.html.

import { pool } from './db.js';

// Série complète d'une vidéo épinglée : vues + abonnés + ratio par jour.
async function videoHistory(videoId, days = 90) {
  const [rows] = await pool.query(
    `SELECT captured_date, views, subscribers, ratio
     FROM video_stats
     WHERE video_id = ?
       AND captured_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
     ORDER BY captured_date ASC`,
    [videoId, days]
  );
  return rows.map(r => ({
    date: r.captured_date.toISOString().slice(0, 10),
    views: r.views != null ? Number(r.views) : null,
    subscribers: r.subscribers != null ? Number(r.subscribers) : null,
    ratio: r.ratio != null ? Number(r.ratio) : null,
  }));
}

// Série complète d'une chaîne suivie : abonnés par jour.
async function channelHistory(channelId, days = 90) {
  const [rows] = await pool.query(
    `SELECT captured_date, subscribers
     FROM channel_stats
     WHERE channel_id = ?
       AND captured_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
     ORDER BY captured_date ASC`,
    [channelId, days]
  );
  return rows.map(r => ({
    date: r.captured_date.toISOString().slice(0, 10),
    subscribers: r.subscribers != null ? Number(r.subscribers) : null,
  }));
}

// Série d'une chaîne cible (bloc concurrentiel) : abonnés + vues totales.
async function targetChannelHistory(channelId, days = 90) {
  const [rows] = await pool.query(
    `SELECT captured_date, subscribers, total_views, video_count
     FROM target_channel_stats
     WHERE channel_id = ?
       AND captured_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
     ORDER BY captured_date ASC`,
    [channelId, days]
  );
  return rows.map(r => ({
    date: r.captured_date.toISOString().slice(0, 10),
    subscribers: r.subscribers != null ? Number(r.subscribers) : null,
    totalViews: r.total_views != null ? Number(r.total_views) : null,
    videoCount: r.video_count != null ? Number(r.video_count) : null,
  }));
}

// Toutes les séries d'un coup, pour les sparklines de pins.html.
// Deux requêtes seulement, regroupées côté JS.
async function sparklines(days = 30) {
  const [vRows] = await pool.query(
    `SELECT vs.video_id, vs.captured_date, vs.views, vs.ratio
     FROM video_stats vs
     JOIN videos v ON v.video_id = vs.video_id
     WHERE vs.captured_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
     ORDER BY vs.video_id, vs.captured_date ASC`,
    [days]
  );

  const [cRows] = await pool.query(
    `SELECT cs.channel_id, cs.captured_date, cs.subscribers
     FROM channel_stats cs
     JOIN channels c ON c.channel_id = cs.channel_id
     WHERE cs.captured_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
     ORDER BY cs.channel_id, cs.captured_date ASC`,
    [days]
  );

  const videos = {};
  for (const r of vRows) {
    (videos[r.video_id] ??= []).push({
      date: r.captured_date.toISOString().slice(0, 10),
      views: r.views != null ? Number(r.views) : null,
      ratio: r.ratio != null ? Number(r.ratio) : null,
    });
  }

  const channels = {};
  for (const r of cRows) {
    (channels[r.channel_id] ??= []).push({
      date: r.captured_date.toISOString().slice(0, 10),
      subscribers: r.subscribers != null ? Number(r.subscribers) : null,
    });
  }

  return { days, videos, channels };
}

export { videoHistory, channelHistory, targetChannelHistory, sparklines };
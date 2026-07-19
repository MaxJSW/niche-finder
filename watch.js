// niche-finder/watch.js
// Job de veille quotidien : rafraîchit les stats des chaînes suivies,
// des vidéos épinglées et des chaînes crawlées (target_channels).
// Aucune ligne 'scans' créée : ce n'est pas un scan (scan_id = NULL).

process.loadEnvFile(new URL('./.env', import.meta.url));

import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { pool } from './db.js';

const API_KEY = process.env.YT_API_KEY;
const API = 'https://www.googleapis.com/youtube/v3';

let quotaUsed = 0;

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Découpe un tableau en lots de n (l'API accepte 50 ids max par appel).
function chunk(arr, n = 50) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function ytGet(endpoint, params) {
  const url = new URL(`${API}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('key', API_KEY);

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube API ${endpoint} ${res.status} : ${body.slice(0, 200)}`);
  }
  quotaUsed += 1;
  return res.json();
}

// --- Lecture des cibles en base ---

async function getFollowedChannels() {
  const [rows] = await pool.query('SELECT channel_id FROM channels');
  return rows.map(r => r.channel_id);
}

async function getPinnedVideos() {
  const [rows] = await pool.query(
    'SELECT video_id, channel_id FROM videos WHERE pinned = 1'
  );
  return rows;
}

async function getTargetChannels() {
  const [rows] = await pool.query('SELECT channel_id FROM target_channels');
  return rows.map(r => r.channel_id);
}

// --- Récupération API ---

// Stats des chaînes : subscribers, total views, video count.
// 1u par lot de 50.
async function fetchChannelStats(channelIds) {
  const out = new Map();
  for (const batch of chunk(channelIds)) {
    const data = await ytGet('channels', {
      part: 'statistics',
      id: batch.join(','),
      maxResults: 50,
    });
    for (const item of data.items ?? []) {
      const s = item.statistics ?? {};
      out.set(item.id, {
        subscribers: s.hiddenSubscriberCount ? null : Number(s.subscriberCount ?? 0),
        totalViews: s.viewCount != null ? Number(s.viewCount) : null,
        videoCount: s.videoCount != null ? Number(s.videoCount) : null,
      });
    }
  }
  return out;
}

// Stats des vidéos : vues, likes, commentaires.
// 1u par lot de 50.
async function fetchVideoStats(videoIds) {
  const out = new Map();
  for (const batch of chunk(videoIds)) {
    const data = await ytGet('videos', {
      part: 'statistics',
      id: batch.join(','),
      maxResults: 50,
    });
    for (const item of data.items ?? []) {
      const s = item.statistics ?? {};
      out.set(item.id, {
        views: s.viewCount != null ? Number(s.viewCount) : null,
        likes: s.likeCount != null ? Number(s.likeCount) : null,
        comments: s.commentCount != null ? Number(s.commentCount) : null,
      });
    }
  }
  return out;
}

// --- Écritures en base ---
// Toutes les tables stats ont une contrainte uniq_*_day : un relevé par jour,
// donc ON DUPLICATE KEY UPDATE écrase le relevé du jour au lieu d'en créer un second.

// Relevé chaîne suivie (scan_id NULL : hors scan).
async function saveChannelStats(conn, channelId, stats) {
  await conn.query(
    `INSERT INTO channel_stats (channel_id, scan_id, subscribers, captured_at, captured_date)
     VALUES (?, NULL, ?, NOW(), ?)
     ON DUPLICATE KEY UPDATE subscribers = VALUES(subscribers),
                             captured_at = VALUES(captured_at)`,
    [channelId, stats.subscribers ?? null, today()]
  );
}

// Relevé vidéo épinglée : vues + abonnés de sa chaîne + ratio recalculé du jour.
async function saveVideoStats(conn, videoId, views, subscribers) {
  const ratio =
    views != null && subscribers != null && subscribers > 0
      ? Number((views / subscribers).toFixed(2))
      : null;

  await conn.query(
    `INSERT INTO video_stats
       (scan_id, video_id, views, subscribers, ratio, captured_at, captured_date)
     VALUES (NULL, ?, ?, ?, ?, NOW(), ?)
     ON DUPLICATE KEY UPDATE views = VALUES(views),
                             subscribers = VALUES(subscribers),
                             ratio = VALUES(ratio),
                             captured_at = VALUES(captured_at)`,
    [videoId, views ?? null, subscribers ?? null, ratio, today()]
  );
}

// Relevé chaîne crawlée (bloc concurrentiel).
async function saveTargetChannelStats(conn, channelId, stats) {
  await conn.query(
    `INSERT INTO target_channel_stats
       (channel_id, subscribers, total_views, video_count, captured_at, captured_date)
     VALUES (?, ?, ?, ?, NOW(), ?)
     ON DUPLICATE KEY UPDATE subscribers = VALUES(subscribers),
                             total_views = VALUES(total_views),
                             video_count = VALUES(video_count),
                             captured_at = VALUES(captured_at)`,
    [channelId, stats.subscribers ?? null, stats.totalViews ?? null,
     stats.videoCount ?? null, today()]
  );
}

// --- Orchestration ---

async function run() {
  const startedAt = Date.now();
  quotaUsed = 0;

  const followed = await getFollowedChannels();
  const pinned = await getPinnedVideos();
  const targets = await getTargetChannels();

  // Chaînes suivies + chaînes des vidéos épinglées : un seul appel API pour les deux.
  const channelIds = [...new Set([...followed, ...pinned.map(v => v.channel_id)])];
  const videoIds = pinned.map(v => v.video_id);

  const channelStats = channelIds.length ? await fetchChannelStats(channelIds) : new Map();
  const videoStats = videoIds.length ? await fetchVideoStats(videoIds) : new Map();
  const targetStats = targets.length ? await fetchChannelStats(targets) : new Map();

  const report = {
    channels: 0, channelsMissing: 0,
    videos: 0, videosMissing: 0,
    targets: 0, targetsMissing: 0,
  };

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    for (const id of followed) {
      const s = channelStats.get(id);
      if (!s) { report.channelsMissing++; continue; }
      await saveChannelStats(conn, id, s);
      report.channels++;
    }

    for (const v of pinned) {
      const s = videoStats.get(v.video_id);
      if (!s) { report.videosMissing++; continue; }
      const subs = channelStats.get(v.channel_id)?.subscribers ?? null;
      await saveVideoStats(conn, v.video_id, s.views, subs);
      report.videos++;
    }

    for (const id of targets) {
      const s = targetStats.get(id);
      if (!s) { report.targetsMissing++; continue; }
      await saveTargetChannelStats(conn, id, s);
      report.targets++;
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[watch] ${new Date().toISOString()} — ` +
    `${report.channels} chaînes, ${report.videos} vidéos, ${report.targets} targets ` +
    `| introuvables : ${report.channelsMissing} chaînes, ${report.videosMissing} vidéos, ` +
    `${report.targetsMissing} targets | ${quotaUsed}u | ${seconds}s`
  );

  return report;
}

// Exécution directe : node watch.js
if (import.meta.url === `file://${process.argv[1]}`) {
  run()
    .then(() => pool.end())
    .catch(err => {
      console.error('[watch] échec :', err.message);
      pool.end();
      process.exit(1);
    });
}

export { run };
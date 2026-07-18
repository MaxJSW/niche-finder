// niche-finder/queries.js
// Liste persistante de titres à explorer + recherche YouTube sur un titre.
// Une recherche = 100u (search.list) + ~2u (videos.list + channels.list).

import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

process.loadEnvFile(new URL('./.env', import.meta.url));

import { pool } from './db.js';

const API_KEY = process.env.YT_API_KEY;
const BASE = 'https://www.googleapis.com/youtube/v3';

async function ytGet(endpoint, params) {
  const url = new URL(`${BASE}/${endpoint}`);
  url.searchParams.set('key', API_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, v);
  }
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube API ${endpoint} ${res.status} : ${body.slice(0, 300)}`);
  }
  return res.json();
}

// L'API YouTube renvoie les titres avec des entités HTML (&#39; &amp; &quot;...).
function decodeEntities(str) {
  if (!str) return str;
  return String(str)
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');   // en dernier, sinon il ré-encode les autres
}

function isoToSeconds(iso) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || '');
  if (!m) return 0;
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}

// --- CRUD de la liste ---

export async function addQuery({ query, sourceVideoId, sourceChannelId, sourceChannelTitle, sourceViews, note }) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Requête vide.');

  const [r] = await pool.query(`
    INSERT INTO saved_queries
      (query, source_video_id, source_channel_id, source_channel_title, source_views, note)
    VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)
  `, [q, sourceVideoId || null, sourceChannelId || null, sourceChannelTitle || null,
      sourceViews ?? null, note || null]);

  return { id: r.insertId, query: q, duplicate: r.affectedRows === 2 };
}

export async function listQueries(status = null) {
  const where = status ? 'WHERE sq.status = ?' : '';
  const params = status ? [status] : [];

  const [rows] = await pool.query(`
    SELECT
      sq.*,
      (SELECT COUNT(*) FROM query_results WHERE query_id = sq.id) AS stored_results
    FROM saved_queries sq
    ${where}
    ORDER BY sq.searched_at IS NOT NULL, sq.created_at DESC
  `, params);

  return rows;
}

export async function updateQuery(id, { status, note }) {
  const sets = [];
  const params = [];
  if (status) { sets.push('status = ?'); params.push(status); }
  if (note !== undefined) { sets.push('note = ?'); params.push(note || null); }
  if (!sets.length) return { updated: 0 };

  params.push(id);
  const [r] = await pool.query(`UPDATE saved_queries SET ${sets.join(', ')} WHERE id = ?`, params);
  return { updated: r.affectedRows };
}

export async function deleteQuery(id) {
  const [r] = await pool.query('DELETE FROM saved_queries WHERE id = ?', [id]);
  return { deleted: r.affectedRows };
}

export async function getResults(queryId) {
  const [[query]] = await pool.query('SELECT * FROM saved_queries WHERE id = ?', [queryId]);
  if (!query) throw new Error('Requête introuvable.');

  const [results] = await pool.query(`
    SELECT * FROM query_results
    WHERE query_id = ?
    ORDER BY video_views DESC
  `, [queryId]);

  return { query, results };
}

// --- Recherche (payant) ---

export async function runQuery(queryId, { regionCode = null, relevanceLanguage = null, minDuration = 120 } = {}) {
  if (!API_KEY) throw new Error('YT_API_KEY manquante dans .env');

  const [[saved]] = await pool.query('SELECT * FROM saved_queries WHERE id = ?', [queryId]);
  if (!saved) throw new Error('Requête introuvable.');

  // 1. Recherche — 100u.
  const search = await ytGet('search', {
    part: 'snippet',
    type: 'video',
    q: saved.query,
    maxResults: 50,
    order: 'relevance',
    regionCode,
    relevanceLanguage,
  });
  let quotaUsed = 100;

  const items = (search.items || [])
    .map(it => ({
      videoId: it.id?.videoId,
      channelId: it.snippet?.channelId,
      channelTitle: decodeEntities(it.snippet?.channelTitle),
      title: decodeEntities(it.snippet?.title),
      publishedAt: it.snippet?.publishedAt,
    }))
    .filter(v => v.videoId && v.channelId);

  if (!items.length) {
    await pool.query(
      'UPDATE saved_queries SET searched_at = NOW(), result_count = 0 WHERE id = ?',
      [queryId]
    );
    return { queryId, query: saved.query, resultCount: 0, quotaUsed, results: [] };
  }

  // 2. Durées + vues réelles — 1u par lot de 50.
  const vidMeta = new Map();
  for (let i = 0; i < items.length; i += 50) {
    const json = await ytGet('videos', {
      part: 'contentDetails,statistics',
      id: items.slice(i, i + 50).map(v => v.videoId).join(','),
      maxResults: 50,
    });
    quotaUsed += 1;
    for (const v of json.items || []) {
      vidMeta.set(v.id, {
        durationSeconds: isoToSeconds(v.contentDetails?.duration),
        views: Number(v.statistics?.viewCount ?? 0),
      });
    }
  }

  // On ne garde que le format long, et une seule vidéo par chaîne (la plus vue).
  const byChannel = new Map();
  for (const v of items) {
    const meta = vidMeta.get(v.videoId);
    if (!meta || meta.durationSeconds < minDuration) continue;

    const prev = byChannel.get(v.channelId);
    if (!prev || meta.views > prev.views) {
      byChannel.set(v.channelId, { ...v, ...meta });
    }
  }

  const channelIds = [...byChannel.keys()];

  // 3. Profils des chaînes — 1u par lot de 50.
  const chanMeta = new Map();
  for (let i = 0; i < channelIds.length; i += 50) {
    const json = await ytGet('channels', {
      part: 'snippet,statistics',
      id: channelIds.slice(i, i + 50).join(','),
      maxResults: 50,
    });
    quotaUsed += 1;
    for (const c of json.items || []) {
      const subs = c.statistics?.hiddenSubscriberCount ? null : Number(c.statistics?.subscriberCount ?? 0);
      const createdAt = c.snippet?.publishedAt || null;
      chanMeta.set(c.id, {
        handle: c.snippet?.customUrl || null,
        subscribers: subs,
        videoCount: Number(c.statistics?.videoCount ?? 0),
        ageMonths: createdAt
          ? Math.round(((Date.now() - new Date(createdAt)) / (1000 * 60 * 60 * 24 * 30.44)) * 10) / 10
          : null,
      });
    }
  }

  // 4. Écriture : on remplace intégralement les résultats de cette requête.
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM query_results WHERE query_id = ?', [queryId]);

    const rows = [];
    for (const [channelId, v] of byChannel) {
      const c = chanMeta.get(channelId) || {};
      rows.push([
        queryId, channelId, v.channelTitle, c.handle ?? null,
        c.subscribers ?? null, c.videoCount ?? null, c.ageMonths ?? null,
        v.videoId, v.title, v.views ?? null, v.durationSeconds ?? null,
        v.publishedAt ? new Date(v.publishedAt) : null,
      ]);
    }

    if (rows.length) {
      await conn.query(`
        INSERT INTO query_results
          (query_id, channel_id, channel_title, handle, subscribers, video_count,
           channel_age_months, video_id, video_title, video_views, video_duration,
           video_published_at)
        VALUES ?
      `, [rows]);
    }

    await conn.query(
      'UPDATE saved_queries SET searched_at = NOW(), result_count = ?, status = ? WHERE id = ?',
      [rows.length, 'done', queryId]
    );

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  const { results } = await getResults(queryId);

  return { queryId, query: saved.query, resultCount: results.length, quotaUsed, results };
}
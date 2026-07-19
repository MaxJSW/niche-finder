// niche-finder/themes-view.js
// Lectures enrichies : contenu détaillé d'un thème, éléments non classés,
// et requête inverse (quels thèmes pour un élément donné) pour les badges.

import { pool } from './db.js';

// --- Contenu détaillé d'un thème ---
// Trois requêtes séparées plutôt qu'un UNION : les colonnes utiles diffèrent
// trop d'un type à l'autre pour être fusionnées proprement.
async function themeContent(themeId) {
  const id = Number(themeId);

  const [[theme]] = await pool.query('SELECT id, name, color FROM themes WHERE id = ?', [id]);
  if (!theme) throw new Error('Thème introuvable.');

  const [channels] = await pool.query(
    `SELECT ti.position, c.channel_id, c.channel_title, c.handle, c.channel_url,
            cs.subscribers
     FROM theme_items ti
     JOIN channels c ON c.channel_id = ti.item_id
     LEFT JOIN channel_stats cs ON cs.id = (
       SELECT id FROM channel_stats WHERE channel_id = c.channel_id
       ORDER BY captured_date DESC LIMIT 1
     )
     WHERE ti.theme_id = ? AND ti.item_type = 'channel'
     ORDER BY ti.position ASC`,
    [id]
  );

  const [targets] = await pool.query(
    `SELECT ti.position, tc.channel_id, tc.channel_title, tc.handle,
            tc.subscribers, tc.video_count, tc.last_crawled_at,
            (SELECT COUNT(*) FROM target_videos WHERE channel_id = tc.channel_id) AS crawled_videos
     FROM theme_items ti
     JOIN target_channels tc ON tc.channel_id = ti.item_id
     WHERE ti.theme_id = ? AND ti.item_type = 'target'
     ORDER BY ti.position ASC`,
    [id]
  );

  const [queries] = await pool.query(
    `SELECT ti.position, q.id, q.query, q.status, q.searched_at, q.result_count,
            q.source_channel_title
     FROM theme_items ti
     JOIN saved_queries q ON q.id = ti.item_id
     WHERE ti.theme_id = ? AND ti.item_type = 'query'
     ORDER BY ti.position ASC`,
    [id]
  );

  return {
    theme,
    channels: channels.map(r => ({
      itemType: 'channel', itemId: r.channel_id, position: r.position,
      title: r.channel_title, handle: r.handle, url: r.channel_url,
      subscribers: r.subscribers != null ? Number(r.subscribers) : null,
    })),
    targets: targets.map(r => ({
      itemType: 'target', itemId: r.channel_id, position: r.position,
      title: r.channel_title, handle: r.handle,
      subscribers: r.subscribers != null ? Number(r.subscribers) : null,
      videoCount: r.video_count != null ? Number(r.video_count) : null,
      crawledVideos: Number(r.crawled_videos),
      lastCrawledAt: r.last_crawled_at,
    })),
    queries: queries.map(r => ({
      itemType: 'query', itemId: String(r.id), position: r.position,
      title: r.query, status: r.status, searchedAt: r.searched_at,
      resultCount: r.result_count != null ? Number(r.result_count) : null,
      sourceChannel: r.source_channel_title,
    })),
  };
}

// --- Éléments non classés (panneau source du drag and drop) ---
// NOT EXISTS : un élément déjà rangé dans n'importe quel thème disparaît d'ici.
async function unclassified() {
  const [channels] = await pool.query(
    `SELECT c.channel_id, c.channel_title, c.handle, c.channel_url, cs.subscribers
     FROM channels c
     LEFT JOIN channel_stats cs ON cs.id = (
       SELECT id FROM channel_stats WHERE channel_id = c.channel_id
       ORDER BY captured_date DESC LIMIT 1
     )
     WHERE NOT EXISTS (
       SELECT 1 FROM theme_items ti
       WHERE ti.item_type = 'channel' AND ti.item_id = c.channel_id
     )
     ORDER BY c.followed_at DESC`
  );

  const [targets] = await pool.query(
    `SELECT tc.channel_id, tc.channel_title, tc.handle, tc.subscribers, tc.video_count
     FROM target_channels tc
     WHERE NOT EXISTS (
       SELECT 1 FROM theme_items ti
       WHERE ti.item_type = 'target' AND ti.item_id = tc.channel_id
     )
     ORDER BY tc.last_crawled_at DESC`
  );

  const [queries] = await pool.query(
    `SELECT q.id, q.query, q.status, q.searched_at, q.result_count
     FROM saved_queries q
     WHERE q.status <> 'archived'
       AND NOT EXISTS (
         SELECT 1 FROM theme_items ti
         WHERE ti.item_type = 'query' AND ti.item_id = q.id
       )
     ORDER BY q.created_at DESC`
  );

  return {
    channels: channels.map(r => ({
      itemType: 'channel', itemId: r.channel_id, title: r.channel_title,
      handle: r.handle, url: r.channel_url,
      subscribers: r.subscribers != null ? Number(r.subscribers) : null,
    })),
    targets: targets.map(r => ({
      itemType: 'target', itemId: r.channel_id, title: r.channel_title,
      handle: r.handle,
      subscribers: r.subscribers != null ? Number(r.subscribers) : null,
      videoCount: r.video_count != null ? Number(r.video_count) : null,
    })),
    queries: queries.map(r => ({
      itemType: 'query', itemId: String(r.id), title: r.query,
      status: r.status, searchedAt: r.searched_at,
      resultCount: r.result_count != null ? Number(r.result_count) : null,
    })),
  };
}

// --- Requête inverse : les thèmes de chaque élément d'un type donné ---
// Alimente les badges de pins.html, targets.html et queries.html en un seul appel.
async function themeBadges(itemType) {
  const [rows] = await pool.query(
    `SELECT ti.item_id, t.id, t.name, t.color
     FROM theme_items ti
     JOIN themes t ON t.id = ti.theme_id
     WHERE ti.item_type = ?
     ORDER BY t.position ASC`,
    [itemType]
  );

  const out = {};
  for (const r of rows) {
    (out[r.item_id] ??= []).push({ id: r.id, name: r.name, color: r.color });
  }
  return out;
}

export { themeContent, unclassified, themeBadges };
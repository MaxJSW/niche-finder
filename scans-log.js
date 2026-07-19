// niche-finder/scans-log.js
// Journal d'activité : historique des scans et agrégation par mot-clé.
// Lecture seule, aucun appel API.

import { pool } from './db.js';

// Liste chronologique des scans (le plus récent en premier).
// Ne remonte que les scans réels : ceux créés par pinVideo() ont quota_used = 0
// et video_count = 0, on les écarte pour ne pas polluer le journal.
async function listScans({ limit = 200, keyword = null } = {}) {
  const params = [];
  let where = 'WHERE s.quota_used > 0';

  if (keyword) {
    where += ' AND k.keyword = ?';
    params.push(keyword);
  }
  params.push(Number(limit));

  const [rows] = await pool.query(
    `SELECT s.id, s.fetched_at, s.quota_used, s.video_count, s.filters,
            k.keyword, k.id AS keyword_id
     FROM scans s
     JOIN keywords k ON k.id = s.keyword_id
     ${where}
     ORDER BY s.fetched_at DESC
     LIMIT ?`,
    params
  );

  return rows.map(r => ({
    id: r.id,
    keyword: r.keyword,
    keywordId: r.keyword_id,
    fetchedAt: r.fetched_at,
    quotaUsed: Number(r.quota_used),
    videoCount: Number(r.video_count),
    filters: r.filters ?? null,
  }));
}

// Agrégation par mot-clé : nombre de scans réels, quota cumulé, dates extrêmes.
async function keywordSummary() {
  const [rows] = await pool.query(
    `SELECT k.id, k.keyword, k.first_seen, k.scan_count,
            COUNT(s.id)                AS real_scans,
            COALESCE(SUM(s.quota_used), 0) AS quota_total,
            COALESCE(SUM(s.video_count), 0) AS videos_total,
            MIN(s.fetched_at)          AS first_scan,
            MAX(s.fetched_at)          AS last_scan
     FROM keywords k
     LEFT JOIN scans s ON s.keyword_id = k.id AND s.quota_used > 0
     GROUP BY k.id
     ORDER BY last_scan IS NULL, last_scan DESC`
  );

  return rows.map(r => ({
    id: r.id,
    keyword: r.keyword,
    firstSeen: r.first_seen,
    scanCount: Number(r.scan_count),
    realScans: Number(r.real_scans),
    quotaTotal: Number(r.quota_total),
    videosTotal: Number(r.videos_total),
    firstScan: r.first_scan,
    lastScan: r.last_scan,
  }));
}

// Totaux affichés en haut de page.
async function globalStats() {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS scans,
            COALESCE(SUM(quota_used), 0)  AS quota,
            COALESCE(SUM(video_count), 0) AS videos,
            MIN(fetched_at) AS since
     FROM scans WHERE quota_used > 0`
  );
  const [[kw]] = await pool.query('SELECT COUNT(*) AS n FROM keywords');

  return {
    scans: Number(row.scans),
    quota: Number(row.quota),
    videos: Number(row.videos),
    since: row.since,
    keywords: Number(kw.n),
  };
}

export { listScans, keywordSummary, globalStats };
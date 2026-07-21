// niche-finder/competitors-overview.js
// Vue d'ensemble concurrentielle : un groupe par chaîne cible (is_seed = 1),
// avec la cible + ses concurrents liés, leurs stats comparées, et les
// "top performers" du groupe (vidéos au plus fort ratio vues / médiane chaîne).
// Lecture seule, aucun appel YouTube.

import { pool } from './db.js';

const MIN_DURATION = 120;     // on ignore Shorts et vidéos courtes
const TOP_PERFORMERS = 8;     // vidéos affichées dans la section décision d'un groupe
const MIN_VIEWS = 1000;       // plancher : écarte les ratios gonflés par de tout petits chiffres

function median(sortedNumbers) {
  if (!sortedNumbers.length) return null;
  return sortedNumbers[Math.floor(sortedNumbers.length / 2)];
}

async function competitorsOverview() {
  // 1. Les cibles.
  const [seeds] = await pool.query(`
    SELECT channel_id, channel_title, handle, subscribers, last_crawled_at
    FROM target_channels
    WHERE is_seed = 1
    ORDER BY channel_title
  `);
  if (!seeds.length) return { groups: [], generatedAt: new Date().toISOString() };

  // 2. Les liens cible -> concurrent.
  const [links] = await pool.query(`
    SELECT cc.source_channel_id, cc.competitor_channel_id,
           COALESCE(tc.channel_title, cc.competitor_title) AS competitor_title,
           tc.handle, tc.subscribers, tc.last_crawled_at
    FROM channel_competitors cc
    LEFT JOIN target_channels tc ON tc.channel_id = cc.competitor_channel_id
  `);

  // 3. Vidéos longues + dernier relevé de vues, pour toutes les chaînes impliquées.
  const involved = [...new Set([
    ...seeds.map(s => s.channel_id),
    ...links.map(l => l.competitor_channel_id),
  ])];

  const [videos] = await pool.query(`
    SELECT v.video_id, v.channel_id, v.title, v.published_at,
           v.duration_seconds, v.thumbnail, s.views
    FROM target_videos v
    LEFT JOIN target_video_stats s ON s.id = (
      SELECT id FROM target_video_stats
      WHERE video_id = v.video_id
      ORDER BY captured_date DESC LIMIT 1
    )
    WHERE v.duration_seconds >= ? AND v.channel_id IN (?)
  `, [MIN_DURATION, involved]);

  // 4. Stats par chaîne (médiane, top vidéo, volume).
  const byChannel = new Map();
  for (const v of videos) {
    if (!byChannel.has(v.channel_id)) byChannel.set(v.channel_id, []);
    byChannel.get(v.channel_id).push(v);
  }

  const channelStats = new Map();
  for (const [channelId, vids] of byChannel) {
    const withViews = vids.filter(v => v.views !== null);
    const sortedViews = withViews.map(v => Number(v.views)).sort((a, b) => a - b);
    const med = median(sortedViews);
    const top = withViews.length
      ? withViews.reduce((a, b) => (Number(b.views) > Number(a.views) ? b : a))
      : null;

    channelStats.set(channelId, {
      videoCount: vids.length,
      medianViews: med,
      topVideo: top ? {
        videoId: top.video_id,
        title: top.title,
        views: Number(top.views),
        ratio: med ? Math.round((Number(top.views) / Math.max(med, 1)) * 10) / 10 : null,
      } : null,
    });
  }

  // 5. Assemblage des groupes.
  const groups = seeds.map(seed => {
    const comps = links.filter(l => l.source_channel_id === seed.channel_id);

    const channels = [
      { role: 'cible', channelId: seed.channel_id, channelTitle: seed.channel_title,
        handle: seed.handle, subscribers: seed.subscribers, lastCrawledAt: seed.last_crawled_at },
      ...comps.map(c => ({
        role: 'concurrent', channelId: c.competitor_channel_id, channelTitle: c.competitor_title,
        handle: c.handle, subscribers: c.subscribers, lastCrawledAt: c.last_crawled_at,
      })),
    ].map(ch => ({ ...ch, ...(channelStats.get(ch.channelId) || { videoCount: 0, medianViews: null, topVideo: null }) }));

    // Top performers du groupe : ratio vues / médiane de LEUR chaîne.
    const groupIds = new Set(channels.map(c => c.channelId));
    const titleOf = new Map(channels.map(c => [c.channelId, c.channelTitle]));
    const performers = [];
    for (const v of videos) {
      if (!groupIds.has(v.channel_id) || v.views === null) continue;
      const med = channelStats.get(v.channel_id)?.medianViews;
      if (!med || Number(v.views) < MIN_VIEWS) continue;
      performers.push({
        videoId: v.video_id,
        channelId: v.channel_id,
        channelTitle: titleOf.get(v.channel_id),
        title: v.title,
        thumbnail: v.thumbnail,
        publishedAt: v.published_at,
        views: Number(v.views),
        ratio: Math.round((Number(v.views) / med) * 10) / 10,
      });
    }
    performers.sort((a, b) => b.ratio - a.ratio);

    return {
      seed: { channelId: seed.channel_id, channelTitle: seed.channel_title },
      channels,
      topPerformers: performers.slice(0, TOP_PERFORMERS),
    };
  });

  return { groups, generatedAt: new Date().toISOString() };
}

export { competitorsOverview };
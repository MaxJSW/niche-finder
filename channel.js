// niche-finder/channel.js
// Crawl complet d'une chaîne cible : métadonnées + toutes ses vidéos.
// Distinct de scan.js (recherche par mot-clé) et de la watchlist perso (channels).
// Coût quota : 1u (channels.list) + 1u par page de 50 vidéos (playlistItems)
//              + 1u par page de 50 vidéos (videos.list pour stats/durée/tags)

import 'node:process';
process.loadEnvFile(new URL('./.env', import.meta.url));

import dns from 'node:dns';

// VPS OVH : IPv6 sortant cassé (timeout silencieux) -> on force IPv4.
dns.setDefaultResultOrder('ipv4first');

const API_KEY = process.env.YT_API_KEY;
const BASE = 'https://www.googleapis.com/youtube/v3';

// Garde-fou : évite de vider le quota sur une chaîne à 5000 vidéos.
const MAX_PAGES = 20;   // 20 x 50 = 1000 vidéos max par crawl

// Convertit une durée ISO 8601 ("PT1H2M10S") en secondes.
function isoDurationToSeconds(iso) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || '');
  if (!m) return 0;
  const [, h, min, s] = m;
  return Number(h || 0) * 3600 + Number(min || 0) * 60 + Number(s || 0);
}

// Appel générique : construit l'URL, ignore les params null, gère les erreurs.
async function ytGet(endpoint, params) {
  const url = new URL(`${BASE}/${endpoint}`);
  url.searchParams.set('key', API_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Appel ${endpoint} échoué (HTTP ${res.status}) : ${await res.text()}`);
  }
  return res.json();
}

// 1u max — Résout une entrée libre (ID UC..., @handle, ou URL de chaîne) en channelId.
// Gratuit si l'entrée est déjà un ID valide (aucun appel API).
async function resolveChannelId(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Entrée vide.');

  // Déjà un ID de chaîne ? (UC + 22 caractères)
  if (/^UC[\w-]{22}$/.test(raw)) return { channelId: raw, quotaUsed: 0 };

  // Extrait un @handle : "@MaChaine", "youtube.com/@MaChaine", avec ou sans https.
  const m = raw.match(/@([A-Za-z0-9._-]+)/);
  if (!m) {
    throw new Error(`Entrée non reconnue : "${raw}" (attendu : ID UC..., @handle ou URL de chaîne).`);
  }

  const data = await ytGet('channels', {
    part: 'id',
    forHandle: `@${m[1]}`,
  });
  const c = data.items?.[0];
  if (!c) throw new Error(`Chaîne introuvable pour le handle @${m[1]}.`);

  return { channelId: c.id, quotaUsed: 1 };
}

// 1u — Métadonnées de la chaîne + ID de sa playlist "uploads".
async function fetchChannelMeta(channelId) {
  const data = await ytGet('channels', {
    part: 'snippet,statistics,contentDetails',
    id: channelId,
  });
  const c = data.items?.[0];
  if (!c) throw new Error(`Chaîne introuvable : ${channelId}`);

  const custom = c.snippet?.customUrl || null;
  const handle = custom ? (custom.startsWith('@') ? custom : `@${custom}`) : null;

  return {
    channelId: c.id,
    channelTitle: c.snippet.title,
    handle,
    uploadsPlaylistId: c.contentDetails?.relatedPlaylists?.uploads || null,
    subscribers: c.statistics.hiddenSubscriberCount ? null : Number(c.statistics.subscriberCount || 0),
    videoCount: Number(c.statistics.videoCount || 0),
    totalViews: Number(c.statistics.viewCount || 0),
  };
}

// 1u par page — IDs des vidéos de la playlist uploads (ordre antéchronologique).
async function fetchUploadIds(playlistId, maxPages = MAX_PAGES) {
  const ids = [];
  let pageToken = null;
  let pages = 0;

  do {
    const data = await ytGet('playlistItems', {
      part: 'contentDetails',
      playlistId,
      maxResults: 50,
      pageToken,
    });
    for (const it of data.items || []) {
      const vid = it.contentDetails?.videoId;
      if (vid) ids.push(vid);
    }
    pageToken = data.nextPageToken || null;
    pages++;
  } while (pageToken && pages < maxPages);

  return { ids, pages, truncated: Boolean(pageToken) };
}

// 1u par lot de 50 — Détails complets (stats, durée, tags, description).
async function fetchVideoDetails(videoIds) {
  const out = [];

  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const data = await ytGet('videos', {
      part: 'snippet,statistics,contentDetails',
      id: batch.join(','),
    });

    for (const v of data.items || []) {
      const thumbs = v.snippet.thumbnails || {};
      out.push({
        videoId: v.id,
        channelId: v.snippet.channelId,
        title: v.snippet.title,
        description: v.snippet.description || '',
        publishedAt: v.snippet.publishedAt,
        durationSeconds: isoDurationToSeconds(v.contentDetails?.duration),
        thumbnail: (thumbs.high || thumbs.medium || thumbs.default || {}).url || null,
        tags: v.snippet.tags || null,
        views: Number(v.statistics.viewCount || 0),
        likes: v.statistics.likeCount != null ? Number(v.statistics.likeCount) : null,
        comments: v.statistics.commentCount != null ? Number(v.statistics.commentCount) : null,
      });
    }
  }

  return out;
}

// --- Orchestration : crawl complet d'une chaîne ---
// options : { maxPages } — limite le nombre de pages de 50 vidéos.
async function crawlChannel(channelId, options = {}) {
  const maxPages = options.maxPages ?? MAX_PAGES;

  const channel = await fetchChannelMeta(channelId);
  if (!channel.uploadsPlaylistId) {
    throw new Error(`Pas de playlist uploads pour ${channelId} (chaîne vide ou restreinte ?)`);
  }

  const { ids, pages, truncated } = await fetchUploadIds(channel.uploadsPlaylistId, maxPages);
  const videos = await fetchVideoDetails(ids);

  // 1 (channels) + N pages (playlistItems) + lots de 50 (videos)
  const quotaUsed = 1 + pages + Math.ceil(ids.length / 50);

  return {
    channel,
    videos,
    crawledAt: new Date().toISOString(),
    quotaUsed,
    count: videos.length,
    truncated,   // true si la chaîne a plus de vidéos que maxPages x 50
  };
}

export { crawlChannel, fetchChannelMeta, resolveChannelId };
// niche-finder/search-channels.js
// Recherche de chaînes par nom (search.list type=channel) + enrichissement channels.list.
// Coût : 100u par page de search + 1u par lot de 50 channels.list.

import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

process.loadEnvFile();

const API_KEY = process.env.YT_API_KEY;
const BASE = 'https://www.googleapis.com/youtube/v3';

const MAX_PAGES = 2;          // 2 pages = 100 chaînes max, 200u
const PER_PAGE = 50;

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

// Étape 1 — search.list type=channel, paginé.
async function fetchChannelIds(keyword, { regionCode, relevanceLanguage, maxPages }) {
  const ids = [];
  let pageToken = null;
  let pages = 0;
  let quotaUsed = 0;

  do {
    const json = await ytGet('search', {
      part: 'snippet',
      type: 'channel',
      q: keyword,
      maxResults: PER_PAGE,
      regionCode,
      relevanceLanguage,
      pageToken,
    });
    quotaUsed += 100;
    pages++;

    for (const item of json.items || []) {
      const id = item.snippet?.channelId || item.id?.channelId;
      if (id && !ids.includes(id)) ids.push(id);
    }

    pageToken = json.nextPageToken || null;
  } while (pageToken && pages < maxPages);

  return { ids, quotaUsed, pages };
}

// Étape 2 — channels.list par lots de 50 pour les vraies statistiques.
async function fetchChannelDetails(ids) {
  const out = [];
  let quotaUsed = 0;

  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const json = await ytGet('channels', {
      part: 'snippet,statistics,contentDetails',
      id: batch.join(','),
      maxResults: 50,
    });
    quotaUsed += 1;

    for (const c of json.items || []) {
      const subs = c.statistics?.hiddenSubscriberCount
        ? null
        : Number(c.statistics?.subscriberCount ?? 0);
      const videoCount = Number(c.statistics?.videoCount ?? 0);
      const totalViews = Number(c.statistics?.viewCount ?? 0);
      const createdAt = c.snippet?.publishedAt || null;

      const ageMonths = createdAt
        ? (Date.now() - new Date(createdAt)) / (1000 * 60 * 60 * 24 * 30.44)
        : null;

      out.push({
        channelId: c.id,
        channelTitle: c.snippet?.title || '',
        handle: c.snippet?.customUrl || null,
        description: c.snippet?.description || '',
        thumbnail: c.snippet?.thumbnails?.medium?.url
                || c.snippet?.thumbnails?.default?.url
                || null,
        country: c.snippet?.country || null,
        subscribers: subs,
        videoCount,
        totalViews,
        createdAt,
        ageMonths: ageMonths !== null ? Math.round(ageMonths * 10) / 10 : null,
        uploadsPlaylistId: c.contentDetails?.relatedPlaylists?.uploads || null,
        // Densité : abonnés par vidéo publiée (Shorts inclus — cf. leçon connue).
        density: videoCount > 0 && subs !== null ? Math.round(subs / videoCount) : null,
        viewsPerVideo: videoCount > 0 ? Math.round(totalViews / videoCount) : null,
      });
    }
  }

  return { channels: out, quotaUsed };
}

export async function searchChannels(keyword, options = {}) {
  if (!API_KEY) throw new Error('YT_API_KEY manquante dans .env');

  const {
    regionCode = null,
    relevanceLanguage = null,
    maxPages = MAX_PAGES,
  } = options;

  const search = await fetchChannelIds(keyword, {
    regionCode,
    relevanceLanguage,
    maxPages: Math.min(maxPages, MAX_PAGES),
  });

  if (!search.ids.length) {
    return {
      keyword,
      fetchedAt: new Date().toISOString(),
      count: 0,
      quotaUsed: search.quotaUsed,
      channels: [],
    };
  }

  const details = await fetchChannelDetails(search.ids);

  // Tri par défaut : densité abo/vidéo décroissante (null en dernier).
  details.channels.sort((a, b) => (b.density ?? -1) - (a.density ?? -1));

  return {
    keyword,
    fetchedAt: new Date().toISOString(),
    regionCode,
    relevanceLanguage,
    pagesFetched: search.pages,
    count: details.channels.length,
    quotaUsed: search.quotaUsed + details.quotaUsed,
    channels: details.channels,
  };
}
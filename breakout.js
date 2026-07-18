// niche-finder/breakout.js
// Détection de chaînes "breakout" : peu de vidéos, beaucoup d'abonnés, récentes.
// Cas d'école : 6 vidéos, 350k abonnés, quelques mois d'existence.
// Signal distinct de l'analyse concurrentielle — ici on repère une percée soudaine.
//
// Deux passes :
//   1. Filtrage gratuit sur les données déjà remontées par le scan (densité + videoCount)
//   2. Vérification de l'âge réel (1 u par candidat, seulement sur les rares retenus)

import 'node:process';
process.loadEnvFile(new URL('./.env', import.meta.url));

import dns from 'node:dns';

// VPS OVH : IPv6 sortant cassé (timeout silencieux) -> on force IPv4.
dns.setDefaultResultOrder('ipv4first');

const API_KEY = process.env.YT_API_KEY;
const BASE = 'https://www.googleapis.com/youtube/v3';

// --- Seuils (ajustables) ---
const THRESHOLDS = {
  maxVideos: 30,          
  minLongVideos: 3,  
  minDensity: 5000, 
  maxAgeMonths: 18,     
  minSubscribers: 1000,  
  minLongDuration: 120,
  preMaxVideos: 150,
  preMinDensity: 1500,
};

// Nombre max de candidats inspectés en détail (~3 u chacun).
const MAX_DEEP_CHECKS = 8;

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

// Convertit un channelId "UC..." en ID de playlist uploads "UU..." (2e caractère).
function uploadsPlaylistId(channelId) {
  return 'UU' + channelId.slice(2);
}

// ~3 u — Inventaire réel d'une chaîne : longues vs Shorts, date de la 1re longue.
// Indispensable car channels.list.videoCount agrège tout (une chaîne à 6 vidéos
// et 39 Shorts affiche 45, ce qui fausse densité et seuil de nombre).
async function inspectChannel(channelId, minLongDuration) {
  const playlistId = uploadsPlaylistId(channelId);
  const ids = [];
  let pageToken = null;
  let pages = 0;

  // 1 u par page de 50 — plafonné à 4 pages (200 vidéos), largement suffisant
  // pour une chaîne candidate au breakout.
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
  } while (pageToken && pages < 4);

  // 1 u par lot de 50 — durées + dates.
  let quotaUsed = pages;
  const durations = [];

for (let i = 0; i < ids.length; i += 50) {
    const data = await ytGet('videos', {
      part: 'contentDetails,snippet,statistics',
      id: ids.slice(i, i + 50).join(','),
    });
    quotaUsed++;
    for (const v of data.items || []) {
      durations.push({
        seconds: isoDurationToSeconds(v.contentDetails?.duration),
        publishedAt: v.snippet?.publishedAt || null,
        views: Number(v.statistics?.viewCount || 0),
      });
    }
  }

// Frontière unique : tout ce qui est sous minLongDuration (120 s) est "court".
  const longs = durations.filter(d => d.seconds >= minLongDuration);
  const shorts = durations.filter(d => d.seconds < minLongDuration);

  // Date de la plus ancienne vidéo LONGUE (c'est elle qui date la vraie activité).
  const firstLongAt = longs.length
    ? longs.map(d => d.publishedAt).filter(Boolean).sort()[0]
    : null;

// Vues des seules vidéos longues — channels.list.viewCount agrège les Shorts
  // et fausserait totalement le ratio sur une chaîne majoritairement Shorts.
  const longViews = longs.reduce((sum, d) => sum + (d.views || 0), 0);

  return {
    longCount: longs.length,
    shortCount: shorts.length,
    totalCount: durations.length,
    longViews,
    firstLongAt,
    truncated: Boolean(pageToken),
    quotaUsed,
  };
}

// Convertit une durée ISO 8601 en secondes.
function isoDurationToSeconds(iso) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || '');
  if (!m) return 0;
  const [, h, min, s] = m;
  return Number(h || 0) * 3600 + Number(min || 0) * 60 + Number(s || 0);
}

// Âge en mois entre une date ISO et aujourd'hui.
function ageInMonths(iso) {
  if (!iso) return null;
  return (Date.now() - new Date(iso)) / (1000 * 60 * 60 * 24 * 30.44);
}

// Passe 1 (gratuite, permissive) : videoCount inclut les Shorts, donc on filtre
// large. Le tri fin se fera en passe 2, une fois les longues comptées.
function preselect(channels, thresholds = THRESHOLDS) {
  return channels
    .filter(c =>
      c.subscribers != null &&
      c.subscribers >= thresholds.minSubscribers &&
      c.videoCount > 0 &&
      c.videoCount <= thresholds.preMaxVideos
    )
    .map(c => ({
      ...c,
      rawDensity: Math.round(c.subscribers / c.videoCount),
    }))
    .filter(c => c.rawDensity >= thresholds.preMinDensity)
    .sort((a, b) => b.rawDensity - a.rawDensity);
}

// Score 0-100 : densité réelle (60%) + jeunesse (25%) + vues par vidéo (15%).
function scoreBreakout(c, thresholds = THRESHOLDS) {
  const dScore = Math.min(100, (c.density / thresholds.minDensity) * 25);

  const age = c.ageMonths;
  const aScore = age == null
    ? 40                                     // âge inconnu : score neutre
    : age <= 6  ? 100
    : age >= thresholds.maxAgeMonths ? 20
    : Math.round(100 - ((age - 6) / (thresholds.maxAgeMonths - 6)) * 80);

  const vScore = Math.min(100, (c.viewsPerVideo / 100000) * 100);

  return Math.round(dScore * 0.60 + aScore * 0.25 + vScore * 0.15);
}

async function detectBreakouts(channels = [], options = {}) {
  const thresholds = { ...THRESHOLDS, ...(options.thresholds || {}) };
  const maxChecks = options.maxChecks ?? MAX_DEEP_CHECKS;

  const candidates = preselect(channels, thresholds);
  const inspected = [];
  let quotaUsed = 0;

  // Passe 2 : inventaire réel (longues vs Shorts) sur les meilleurs candidats.
  for (const c of candidates.slice(0, maxChecks)) {
    try {
      const info = await inspectChannel(c.channelId, thresholds.minLongDuration);
      quotaUsed += info.quotaUsed;

      // Une chaîne qui ne publie que des Shorts ne nous intéresse pas.
      if (info.longCount < thresholds.minLongVideos) continue;

      inspected.push({
        ...c,
        longCount: info.longCount,
        shortCount: info.shortCount,
        totalCount: info.totalCount,
        longViews: info.longViews,
        firstLongAt: info.firstLongAt,
        ageMonths: ageInMonths(info.firstLongAt) ?? ageInMonths(c.channelCreatedAt),
        density: Math.round(c.subscribers / info.longCount),
        viewsPerVideo: Math.round(info.longViews / info.longCount),
      });
    } catch {
      // Playlist inaccessible (chaîne restreinte) : on ignore ce candidat.
    }
  }

  // Filtre final sur les vraies valeurs : peu de longues, densité forte, récente.
  const breakouts = inspected
    .filter(c =>
      c.longCount >= thresholds.minLongVideos &&
      c.longCount <= thresholds.maxVideos &&
      c.density >= thresholds.minDensity &&
      (c.ageMonths == null || c.ageMonths <= thresholds.maxAgeMonths)
    )
    .map(c => ({ ...c, breakoutScore: scoreBreakout(c, thresholds) }))
    .sort((a, b) => b.breakoutScore - a.breakoutScore);

  return { breakouts, candidatesChecked: inspected.length, quotaUsed, thresholds };
}

export { detectBreakouts, preselect, inspectChannel, THRESHOLDS };
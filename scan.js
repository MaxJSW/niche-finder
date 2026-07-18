// niche-finder/scan.js
// Étape 1 : scan d'un mot-clé -> JSON structuré (le "contrat" que l'UI lira ensuite)
// Lancer : node scan.js "water slide"

import 'node:process';
process.loadEnvFile(new URL('./.env', import.meta.url));

import dns from 'node:dns';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// VPS OVH : IPv6 sortant cassé (timeout silencieux) -> on force IPv4.
dns.setDefaultResultOrder('ipv4first');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_KEY = process.env.YT_API_KEY;
const BASE = 'https://www.googleapis.com/youtube/v3';
const DATA_DIR = path.join(__dirname, 'data');

// --- Filtres "à la source" (appliqués par YouTube dans search.list) ---
// Réglés en dur pour l'instant ; l'UI les pilotera à l'étape 2.
// NB : plus de videoDuration ici -> on récupère toutes les durées et on
// filtrera la durée côté calculé (curseur min/max), comme décidé.
const SEARCH_PARAMS = {
  order: 'viewCount',            // viewCount | date | relevance
  publishedAfter: monthsAgo(3),  // fraîcheur : 3 derniers mois (ou null)
  regionCode: null,              // ex. 'FR' (ou null)
  relevanceLanguage: null,       // ex. 'fr' (ou null)
  maxResults: 50,                // max de l'API
};

function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString();
}

// Convertit une durée ISO 8601 (ex. "PT1H2M10S") en secondes.
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

// Le coeur : 1 search + 1 videos + 1 channels -> tableau de records.
// options : { regionCode, relevanceLanguage } — pilotés par l'UI, null = mondial.
async function scanKeyword(keyword, options = {}) {
  // Les options de l'UI priment ; sinon on retombe sur les valeurs par défaut.
  const regionCode = options.regionCode ?? SEARCH_PARAMS.regionCode;
  const relevanceLanguage = options.relevanceLanguage ?? SEARCH_PARAMS.relevanceLanguage;

  // 1) search.list — 100 u par tri.
  // Scan simple : viewCount seul (102 u).
  // Scan approfondi : viewCount + date + relevance (302 u) — attrape les chaînes
  // récentes qui percent et que le tri par vues seul ne fait pas remonter.
  const deep = options.deep === true;
  const orders = deep ? ['viewCount', 'date', 'relevance'] : [SEARCH_PARAMS.order];

  const seen = new Set();
  const foundBy = {};   // videoId -> ['viewCount', 'date'...] : sur quels tris il est sorti

  for (const order of orders) {
    const search = await ytGet('search', {
      part: 'snippet',
      q: keyword,
      type: 'video',
      order,
      maxResults: SEARCH_PARAMS.maxResults,
      publishedAfter: SEARCH_PARAMS.publishedAfter,
      regionCode,
      relevanceLanguage,
    });

    for (const i of search.items || []) {
      const vid = i.id?.videoId;
      if (!vid) continue;
      seen.add(vid);
      (foundBy[vid] ||= []).push(order);
    }
  }

  const videoIds = [...seen];
  const searchQuota = orders.length * 100;
  if (videoIds.length === 0) return buildOutput(keyword, [], { regionCode, relevanceLanguage, deep, orders }, searchQuota);

  // 2) videos.list — 1 u par lot de 50 (stats + durée)
  const videoItems = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const data = await ytGet('videos', {
      part: 'snippet,statistics,contentDetails',
      id: videoIds.slice(i, i + 50).join(','),
    });
    videoItems.push(...(data.items || []));
  }
  const videos = { items: videoItems };

  // 3) channels.list — 1 u par lot de 50 (abonnés + handle + date de création)
  const channelIds = [...new Set(videos.items.map(v => v.snippet.channelId))];
  const channelItems = [];
  for (let i = 0; i < channelIds.length; i += 50) {
    const data = await ytGet('channels', {
      part: 'snippet,statistics',
      id: channelIds.slice(i, i + 50).join(','),
    });
    channelItems.push(...(data.items || []));
  }
  const channels = { items: channelItems };

// Table channelId -> abonnés (null si masqué par la chaîne)
  const subsByChannel = {};
  // Table channelId -> handle "@xxx" (null si la chaîne n'en a pas)
  const handleByChannel = {};
  // Table channelId -> profil complet, consommé par la détection de breakout.
  const channelInfo = {};

  for (const c of channels.items) {
    const subs = c.statistics.hiddenSubscriberCount
      ? null
      : Number(c.statistics.subscriberCount || 0);
    subsByChannel[c.id] = subs;

    const custom = c.snippet?.customUrl || null;
    const handle = custom ? (custom.startsWith('@') ? custom : `@${custom}`) : null;
    handleByChannel[c.id] = handle;

    channelInfo[c.id] = {
      channelId: c.id,
      channelTitle: c.snippet?.title || null,
      handle,
      subscribers: subs,
      videoCount: Number(c.statistics.videoCount || 0),
      totalViews: Number(c.statistics.viewCount || 0),
      channelCreatedAt: c.snippet?.publishedAt || null,
    };
  }

  const records = videos.items.map(v => {
    const views = Number(v.statistics.viewCount || 0);
    const subs = subsByChannel[v.snippet.channelId] ?? null;
    const ratio = (subs && subs > 0) ? Number((views / subs).toFixed(2)) : null;
    const handle = handleByChannel[v.snippet.channelId] ?? null;

    // Miniature : on prend la meilleure dispo (high -> medium -> default).
    const thumbs = v.snippet.thumbnails || {};
    const thumbnail = (thumbs.high || thumbs.medium || thumbs.default || {}).url || null;

    return {
      videoId: v.id,
      title: v.snippet.title,
      channelId: v.snippet.channelId,
      channelTitle: v.snippet.channelTitle,
      publishedAt: v.snippet.publishedAt,
      views,
      subscribers: subs,
      durationSeconds: isoDurationToSeconds(v.contentDetails.duration),
      ratio,
      thumbnail,                          // URL de la vignette (pour l'affichage)
      description: v.snippet.description || '', // description COMPLÈTE (via videos.list)
      videoUrl: `https://www.youtube.com/watch?v=${v.id}`,
      handle,                                      // "@xxx" ou null
      channelUrl: handle
        ? `https://www.youtube.com/${handle}`      // URL native si dispo
        : `https://www.youtube.com/channel/${v.snippet.channelId}`,
      foundBy: foundBy[v.id] || [],                // tris qui l'ont fait remonter
    };
  });

  const quotaUsed = searchQuota
    + Math.ceil(videoIds.length / 50)
    + Math.ceil(channelIds.length / 50);

  return buildOutput(
    keyword,
    records,
    { regionCode, relevanceLanguage, deep, orders },
    quotaUsed,
    Object.values(channelInfo)
  );
}

// Enveloppe le résultat avec les métadonnées (le schéma figé).
// quotaUsed est désormais calculé (variable selon le nombre de tris et de lots).
function buildOutput(keyword, videos, used = {}, quotaUsed = 102, channels = []) {
  return {
    keyword,
    fetchedAt: new Date().toISOString(),
    filters: { ...SEARCH_PARAMS, ...used },
    quotaUsed,
    count: videos.length,
    videos,
    channels,   // profils de chaîne, pour la détection de breakout
  };
}

async function main() {
  if (!API_KEY) {
    console.error('❌ YT_API_KEY manquante. Lance : node --env-file=.env scan.js "mot-clé"');
    process.exit(1);
  }
  const keyword = process.argv[2];
  if (!keyword) {
    console.error('Usage : node --env-file=.env scan.js "mot-clé"');
    process.exit(1);
  }
  const output = await scanKeyword(keyword);

  await mkdir(DATA_DIR, { recursive: true });
  const slug = keyword.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const stamp = output.fetchedAt.replace(/[:.]/g, '-');
  const file = path.join(DATA_DIR, `${slug}_${stamp}.json`);

  await writeFile(file, JSON.stringify(output, null, 2));                 // historique
  await writeFile(path.join(DATA_DIR, 'latest.json'), JSON.stringify(output, null, 2));
}

// Exporté pour que l'Express l'appelle à l'étape 2, sans relancer le CLI.
export { scanKeyword };

// Ne lance main() que si le fichier est exécuté directement (pas si importé).
if (process.argv[1] === __filename) {
  main().catch(err => { console.error('\n💥', err.message); process.exit(1); });
}

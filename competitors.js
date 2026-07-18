// niche-finder/competitors.js
// V1 — Identification de chaînes du même créneau par recherche sur les sujets de la cible.
// Étape A : buildQueries()    -> lit target_videos, propose des requêtes. Gratuit.
// Étape B : findCompetitors() -> search.list (100u/requête) + channels.list (1u/50).

import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

process.loadEnvFile(new URL('./.env', import.meta.url));

import { pool } from './db.js';
import { inspectChannel } from './breakout.js';

const API_KEY = process.env.YT_API_KEY;
const BASE = 'https://www.googleapis.com/youtube/v3';

const DEFAULT_QUERIES = 5;
const TOP_VIDEOS = 20;        // vidéos de la cible analysées pour détecter la formule
const MIN_DURATION = 120;     // on ignore les Shorts de la cible

// Bruit fréquent dans les titres : suffixes techniques et marketing.
const NOISE = /\b(4k|8k|hd|full hd|uhd|documentary|documentaire|official|hq|remastered|part \d+|episode \d+|ep\.? ?\d+)\b/gi;

const STOP = new Set([
  'the','a','an','of','in','on','at','to','for','and','or','but','is','are',
  'was','were','be','been','it','its','this','that','these','those','with',
  'from','by','as','how','why','what','when','where','who','you','your','i',
  'my','we','our','they','their','he','she','his','her','do','does','did',
  'can','will','would','should','not','no','so','if','than','then','there',
  'here','all','more','most','very','just','about','into','out','up','down',
]);

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

// --- Nettoyage d'un titre pour en faire une requête ---

function cleanTitle(title) {
  return title
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ')   // emojis
    .replace(/[|•·—–]+/g, ' ')                                   // séparateurs décoratifs
    .replace(NOISE, ' ')
    .replace(/\s*[:\-]\s*$/, '')                                 // ponctuation orpheline en fin
    .replace(/\s+/g, ' ')
    .trim();
}

// --- Détection de la formule récurrente (pour info : ce qui n'est PAS discriminant) ---

function tokenize(t) {
  return t.toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1);
}

export function detectTemplate(titles, { min = 2, max = 4 } = {}) {
  const counts = new Map();
  for (const title of titles) {
    const words = tokenize(title);
    for (let n = min; n <= max; n++) {
      for (let i = 0; i + n <= words.length; i++) {
        const gram = words.slice(i, i + n).join(' ');
        counts.set(gram, (counts.get(gram) || 0) + 1);
      }
    }
  }
  const best = [...counts.entries()]
    .filter(([, c]) => c >= Math.max(2, Math.floor(titles.length * 0.3)))
    .sort((a, b) => (b[1] * b[0].split(' ').length) - (a[1] * a[0].split(' ').length));

  return best.length ? { gram: best[0][0], count: best[0][1] } : null;
}

// Retire la formule d'un titre pour isoler le sujet réel.
function extractSubject(title, template) {
  if (!template) return null;
  const lower = title.toLowerCase();
  const idx = lower.indexOf(template.gram);
  if (idx === -1) return null;
  const rest = (title.slice(0, idx) + ' ' + title.slice(idx + template.gram.length))
    .replace(/\s+/g, ' ').trim()
    .replace(/^[:\-–—,\s]+|[:\-–—,\s]+$/g, '');
  const meaningful = tokenize(rest).filter(w => !STOP.has(w));
  return meaningful.length ? rest : null;
}

// Similarité de Jaccard sur les mots significatifs : 0 = rien en commun, 1 = identiques.
function similarity(a, b) {
  const wa = new Set(tokenize(a).filter(w => !STOP.has(w)));
  const wb = new Set(tokenize(b).filter(w => !STOP.has(w)));
  if (!wa.size || !wb.size) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter);
}

// --- Étape A : proposer les requêtes (gratuit) ---

export async function buildQueries(channelId, { count = DEFAULT_QUERIES } = {}) {
  const [rows] = await pool.query(`
    SELECT v.video_id, v.title, v.published_at, s.views
    FROM target_videos v
    LEFT JOIN target_video_stats s ON s.id = (
      SELECT id FROM target_video_stats
      WHERE video_id = v.video_id
      ORDER BY captured_date DESC LIMIT 1
    )
    WHERE v.channel_id = ? AND v.duration_seconds >= ?
    ORDER BY s.views DESC
    LIMIT ?
  `, [channelId, MIN_DURATION, TOP_VIDEOS]);

  if (rows.length < 3) {
    throw new Error(`Chaîne insuffisamment crawlée (${rows.length} vidéos longues). Lance un crawl d'abord.`);
  }

  const titles = rows.map(r => r.title);
  const template = detectTemplate(titles);

// Toutes les vidéos deviennent des requêtes candidates, ordonnées par vues.
  const all = rows.map(r => ({
    videoId: r.video_id,
    sourceTitle: r.title,
    views: r.views === null || r.views === undefined ? null : Number(r.views),
    query: cleanTitle(r.title),
    subject: extractSubject(r.title, template),
    selected: false,
    similarTo: null,
  }));

  // Présélection : on descend la liste et on écarte ce qui recoupe une requête déjà retenue.
  const SIM_THRESHOLD = 0.35;
  let picked = 0;

  for (const cand of all) {
    if (picked >= count) break;
    const clash = all.find(o => o.selected && similarity(o.query, cand.query) >= SIM_THRESHOLD);
    if (clash) { cand.similarTo = clash.videoId; continue; }
    cand.selected = true;
    picked++;
  }

  return {
    channelId,
    videosAnalyzed: rows.length,
    template,          // null si la chaîne n'a pas de formule récurrente
    queries: all,      // toutes les candidates ; `selected` marque la présélection
    selectedCount: picked,
    estimatedQuota: picked * 100 + 2,
  };
}

// --- Étape B : recherches + agrégation (payant) ---

async function searchQuery(q, { regionCode, relevanceLanguage }) {
  const json = await ytGet('search', {
    part: 'snippet',
    type: 'video',
    q,
    maxResults: 50,
    order: 'relevance',
    regionCode,
    relevanceLanguage,
  });

  return (json.items || []).map(it => ({
    videoId: it.id?.videoId,
    channelId: it.snippet?.channelId,
    channelTitle: it.snippet?.channelTitle,
    title: it.snippet?.title,
    publishedAt: it.snippet?.publishedAt,
  })).filter(v => v.channelId);
}

// Durées + vues réelles des vidéos remontées par les recherches (1u par lot de 50).
async function fetchVideoDetails(ids) {
  const out = new Map();
  let quotaUsed = 0;

  for (let i = 0; i < ids.length; i += 50) {
    const json = await ytGet('videos', {
      part: 'contentDetails,statistics',
      id: ids.slice(i, i + 50).join(','),
      maxResults: 50,
    });
    quotaUsed += 1;

    for (const v of json.items || []) {
      const iso = v.contentDetails?.duration || 'PT0S';
      const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
      const seconds = m ? (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0)) : 0;

      out.set(v.id, {
        durationSeconds: seconds,
        views: Number(v.statistics?.viewCount ?? 0),
      });
    }
  }

  return { details: out, quotaUsed };
}

async function fetchChannelDetails(ids) {
  const out = new Map();
  let quotaUsed = 0;

  for (let i = 0; i < ids.length; i += 50) {
    const json = await ytGet('channels', {
      part: 'snippet,statistics',
      id: ids.slice(i, i + 50).join(','),
      maxResults: 50,
    });
    quotaUsed += 1;

    for (const c of json.items || []) {
      const subs = c.statistics?.hiddenSubscriberCount ? null : Number(c.statistics?.subscriberCount ?? 0);
      const videoCount = Number(c.statistics?.videoCount ?? 0);
      const totalViews = Number(c.statistics?.viewCount ?? 0);
      const createdAt = c.snippet?.publishedAt || null;
      const ageMonths = createdAt ? (Date.now() - new Date(createdAt)) / (1000 * 60 * 60 * 24 * 30.44) : null;

      out.set(c.id, {
        channelId: c.id,
        channelTitle: c.snippet?.title || '',
        handle: c.snippet?.customUrl || null,
        description: c.snippet?.description || '',
        thumbnail: c.snippet?.thumbnails?.default?.url || null,
        subscribers: subs,
        videoCount,
        totalViews,
        createdAt,
        ageMonths: ageMonths !== null ? Math.round(ageMonths * 10) / 10 : null,
        density: videoCount > 0 && subs !== null ? Math.round(subs / videoCount) : null,
        viewsPerVideo: videoCount > 0 ? Math.round(totalViews / videoCount) : null,
      });
    }
  }

  return { details: out, quotaUsed };
}

export async function findCompetitors(channelId, options = {}) {
  if (!API_KEY) throw new Error('YT_API_KEY manquante dans .env');

  const {
    queries,                       // tableau de chaînes de caractères, validé par l'UI
    regionCode = null,
    relevanceLanguage = null,
  } = options;

  if (!Array.isArray(queries) || !queries.length) {
    throw new Error('Aucune requête fournie. Appelle buildQueries() d\'abord.');
  }

  const agg = new Map();
  let quotaUsed = 0;
  const queryReport = [];

  for (const q of queries) {
    const results = await searchQuery(q, { regionCode, relevanceLanguage });
    quotaUsed += 100;
    queryReport.push({ query: q, resultCount: results.length });

    const seenThisQuery = new Set();

    for (const v of results) {
      if (v.channelId === channelId) continue;   // on s'exclut soi-même

      if (!agg.has(v.channelId)) {
        agg.set(v.channelId, { channelId: v.channelId, channelTitle: v.channelTitle, queries: [], videos: [] });
      }
      const entry = agg.get(v.channelId);
      entry.videos.push({ videoId: v.videoId, title: v.title, publishedAt: v.publishedAt, query: q });

      if (!seenThisQuery.has(v.channelId)) {
        entry.queries.push(q);
        seenThisQuery.add(v.channelId);
      }
    }
  }

 // Filtre 1 : une seule apparition ne prouve rien. On écarte avant de payer l'enrichissement.
  const MIN_QUERY_COUNT = 2;
  const retained = [...agg.values()].filter(e => e.queries.length >= MIN_QUERY_COUNT);
  const rejectedSingle = agg.size - retained.length;

  if (!retained.length) {
    return {
      sourceChannelId: channelId,
      queriesUsed: queryReport,
      candidatesFound: 0,
      rejectedSingle,
      rejectedShorts: 0,
      quotaUsed,
      competitors: [],
      fetchedAt: new Date().toISOString(),
    };
  }

  // Durées + vues réelles des vidéos remontées par ces chaînes.
  const videoIds = [...new Set(retained.flatMap(e => e.videos.map(v => v.videoId)).filter(Boolean))];
  const { details: vidDetails, quotaUsed: vidCost } = await fetchVideoDetails(videoIds);
  quotaUsed += vidCost;

  const { details, quotaUsed: enrichCost } = await fetchChannelDetails(retained.map(e => e.channelId));
  quotaUsed += enrichCost;

 const MIN_DURATION_LONG = 120;
  const MAX_INSPECTIONS = 20;        // ~3u chacune
  const maxQueries = queries.length;
  const competitors = [];
  let rejectedShorts = 0;
  let inspectionsDone = 0;

  // Ordre d'inspection : co-occurrence d'abord, le budget va aux plus prometteuses.
  const ordered = [...retained].sort((a, b) => b.queries.length - a.queries.length);

  for (const entry of ordered) {
    const d = details.get(entry.channelId);
    if (!d) continue;

    // Vidéos remontées, enrichies (durée + vues réelles) — sert à l'affichage.
    const enriched = entry.videos.map(v => ({ ...v, ...(vidDetails.get(v.videoId) || {}) }));
    const longsFound = enriched.filter(v => (v.durationSeconds ?? 0) >= MIN_DURATION_LONG);

    // Inventaire réel de la chaîne : le seul verdict fiable sur le format.
    let inv = null;
    if (inspectionsDone < MAX_INSPECTIONS) {
      try {
        inv = await inspectChannel(entry.channelId, MIN_DURATION_LONG);
        quotaUsed += inv.quotaUsed;
        inspectionsDone++;
      } catch {
        // Playlist inaccessible : on garde la chaîne, sans verdict de format.
      }
    }

    // Filtre 2 : format. Une chaîne à Shorts n'est pas un concurrent sur le long.
    // Deux conditions cumulatives : assez de vidéos longues, et pas noyées sous les Shorts.
    const MIN_LONG_VIDEOS = 3;
    const MAX_SHORT_RATIO = 0.80;
    if (inv) {
      const ratio = inv.totalCount > 0 ? inv.shortCount / inv.totalCount : 0;
      if (inv.longCount < MIN_LONG_VIDEOS || ratio > MAX_SHORT_RATIO) {
        rejectedShorts++;
        continue;
      }
    }

    const longViews = longsFound.map(v => v.views ?? 0).sort((a, b) => a - b);
    const medianLongViews = longViews.length ? longViews[Math.floor(longViews.length / 2)] : null;

    const ages = enriched
      .map(v => v.publishedAt ? (Date.now() - new Date(v.publishedAt)) / 86400000 : null)
      .filter(a => a !== null)
      .sort((a, b) => a - b);
    const medianAgeDays = ages.length ? Math.round(ages[Math.floor(ages.length / 2)]) : null;

    // Densité sur les vraies vidéos longues. Les chaînes Shorts étant déjà écartées,
    // ce ratio reflète maintenant la performance réelle du format long.
    const realDensity = inv && inv.longCount >= MIN_LONG_VIDEOS && d.subscribers != null
      ? Math.round(d.subscribers / inv.longCount)
      : d.density;

    // Score 0-100 : co-occurrence 60% + jeunesse 25% + densité 15%.
    const coScore = Math.round((entry.queries.length / maxQueries) * 100);
    const youthScore = d.ageMonths === null ? 30
      : d.ageMonths <= 6 ? 100
      : d.ageMonths >= 60 ? 0
      : Math.round(100 - ((d.ageMonths - 6) / 54) * 100);
    const densScore = Math.min(100, Math.round((realDensity ?? 0) / 50));

    // Pénalité de taille adoucie : une grosse chaîne du créneau reste informative.
    const subs = d.subscribers ?? 0;
    const sizePenalty = subs > 2000000 ? 0.7 : subs > 500000 ? 0.85 : 1;

    competitors.push({
      ...d,
      channelTitle: d.channelTitle || entry.channelTitle,
      queryCount: entry.queries.length,
      matchedQueries: entry.queries,
      videosFound: enriched.length,
      longVideosFound: longsFound.length,
      medianLongViews,
      // Inventaire réel de la chaîne (null si non inspectée).
      longCount: inv ? inv.longCount : null,
      shortCount: inv ? inv.shortCount : null,
      shortRatio: inv && inv.totalCount > 0 ? Math.round((inv.shortCount / inv.totalCount) * 100) : null,
      realDensity,
      sampleVideos: longsFound
        .sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
        .slice(0, 5)
        .map(v => ({ videoId: v.videoId, title: v.title, views: v.views ?? null, durationSeconds: v.durationSeconds ?? null })),
      medianAgeDays,
      score: Math.round((coScore * 0.60 + youthScore * 0.25 + densScore * 0.15) * sizePenalty),
    });
  }

  competitors.sort((a, b) => b.score - a.score || b.queryCount - a.queryCount);

  return {
    sourceChannelId: channelId,
    queriesUsed: queryReport,
    candidatesFound: competitors.length,
    rejectedSingle,       
    rejectedShorts,     
    inspectionsDone,  
    quotaUsed,
    competitors,
    fetchedAt: new Date().toISOString(),
  };
}
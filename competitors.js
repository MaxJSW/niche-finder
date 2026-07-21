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

// Mots vides FR — utilisés uniquement par le mode lexical, pour ne pas altérer
// le comportement de similarity() et extractSubject() en mode titres.
const STOP_FR = new Set([
  'le','la','les','un','une','des','du','de','au','aux','et','ou','mais','donc',
  'car','que','qui','quoi','dont','ce','cet','cette','ces','son','sa','ses',
  'leur','leurs','mon','ma','mes','ton','ta','tes','notre','nos','votre','vos',
  'je','tu','il','elle','on','nous','vous','ils','elles','me','te','se','lui',
  'dans','sur','sous','pour','par','avec','sans','chez','vers','entre','apres',
  'avant','est','sont','etait','etaient','etre','avoir','fait','faire','plus',
  'moins','tres','tout','tous','toute','toutes','pas','non','oui','comme',
  'quand','comment','pourquoi','aussi','encore','deja','ici','cela','ans','ete',
]);

// Mots vides ES — plusieurs chaînes cibles sont hispanophones.
const STOP_ES = new Set([
  'el','la','los','las','un','una','unos','unas','del','al','de','y','o','pero',
  'porque','que','quien','cual','cuyo','este','esta','estos','estas','ese','esa',
  'esos','esas','aquel','su','sus','mi','mis','tu','tus','nuestro','nuestra',
  'yo','tu','el','ella','nosotros','vosotros','ellos','ellas','me','te','se',
  'en','con','sin','sobre','bajo','para','por','entre','hacia','desde','hasta',
  'es','son','era','eran','ser','estar','esta','estan','hay','tiene','tienen',
  'mas','menos','muy','todo','todos','toda','todas','no','si','como','cuando',
  'donde','porque','tambien','aun','ya','aqui','alli','eso','esto','ano','anos',
]);

const MIN_TERM_LEN = 3;         // "un", "le", "go" : trop courts pour discriminer
const NUMERIC = /^\d+$/;        // "2024", "10" : bruit de titre

// Accents retirés pour que "déjà" et "deja" tombent sur la même entrée.
function isStop(w) {
  const flat = w.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return STOP.has(w) || STOP.has(flat) || STOP_FR.has(flat) || STOP_ES.has(flat);
}

// Racine approximative : rapproche singulier et pluriel (EN/FR/ES partagent la
// marque en -s / -es). Volontairement naïf — il ne sert qu'à dédupliquer, jamais
// à l'affichage, donc une racine bancale n'a aucune conséquence visible.
function stem(w) {
  const flat = w.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  let s = flat;
  if (s.length > 4 && s.endsWith('es')) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith('s')) s = s.slice(0, -1);
  // Genre roman : "prehistorico" et "prehistorica" doivent converger.
  // Seuil à 5 pour ne pas raboter "mundo" ou "vida" en bouillie.
  if (s.length > 5 && (s.endsWith('a') || s.endsWith('o'))) s = s.slice(0, -1);
  return s;
}

// --- Découpage d'un titre en fragments recherchables ---

const MIN_SEG_WORDS = 2;
const MAX_SEG_WORDS = 5;
const MAX_SEGMENT_QUERIES = 60;   // plafond d'affichage : au-delà c'est illisible

// Séparateurs éditoriaux. Le tiret n'est une coupure QUE s'il est entouré
// d'espaces — sinon "D-Rex" et "t-rex" seraient massacrés.
const SEG_SPLIT = /[|•·:;!?()\[\]"“”«»]+|\s[—–-]\s|\.{2,}/;

// Le découpage doit voir les séparateurs : on ne passe donc PAS par cleanTitle(),
// qui les remplace par des espaces. On reprend seulement ses autres nettoyages.
function splitSegments(title) {
  return title
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ')   // emojis
    .replace(/#\S+/g, ' ')                                       // hashtags
    .replace(NOISE, ' ')                                         // 4K, FULL EPISODE…
    .split(SEG_SPLIT)
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// Mots d'un segment, ponctuation de bord retirée, casse d'origine conservée
// (la requête part telle quelle vers YouTube et s'affiche dans l'UI).
function segWords(text) {
  return text.split(/\s+/)
    .map(w => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean);
}

// Rogne les bords : "I Found a Dinosaur Zoo" -> "Found a Dinosaur Zoo".
// Le "a" interne reste : c'est la phrase réelle qu'on veut chercher.
// Mots qui ne sont pas vides au sens strict mais qui ne peuvent pas terminer
// ni commencer une recherche : "Tiny Predators vs" appelle une suite.
const EDGE_WEAK = new Set(['vs', 'versus', 'contre', 'feat', 'ft', 'et', 'con']);

function trimEdges(ws) {
  const weak = w => {
    const l = w.toLowerCase();
    return l.length < 2 || NUMERIC.test(l) || isStop(l) || EDGE_WEAK.has(l);
  };
  let i = 0, j = ws.length;
  while (i < j && weak(ws[i])) i++;
  while (j > i && weak(ws[j - 1])) j--;
  return ws.slice(i, j);
}

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

// L'API YouTube renvoie les titres avec entités HTML encodées ("World&#39;s").
// Sans ça, l'échappement côté UI les ré-encode et l'utilisateur voit le code.
function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');   // en dernier : sinon "&amp;#39;" se décode deux fois
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

// --- Mode segments : fragments porteurs des titres qui performent ---
// Le titre entier est trop spécifique (il ne ramène que la cible), le
// vocabulaire global trop générique. Le bon grain est entre les deux :
// "Found a Dinosaur Zoo", "Jurassic World Rebirth". On extrait ces fragments,
// on écarte ceux qui sont la signature de la chaîne, et on pondère par les
// vues de la vidéo dont ils viennent.

function buildSegmentQueries(rows, { brandTerms = [] } = {}) {
  const brandStems = new Set(brandTerms.map(stem));
  const maxViews = Math.max(1, ...rows.map(r => Number(r.views) || 0));

  // Prime de longueur en cloche : un fragment de 3-4 mots est assez spécifique
  // pour cibler un sujet, assez court pour que d'autres l'aient formulé pareil.
  const lenScore = n => n === 2 ? 0.70 : n === 3 ? 0.92 : n === 4 ? 1 : 0.98;

  // Passe 1 : fenêtres glissantes de chaque titre + fréquence documentaire.
  const docFreq = new Map();
  const perVideo = [];

  for (const r of rows) {
    const frags = new Map();   // clé stemmée -> { text, seg, start, end }
    const segs = splitSegments(r.title);

    segs.forEach((seg, segIdx) => {
      const ws = trimEdges(segWords(seg));
      if (ws.length < MIN_SEG_WORDS) return;

      const hi = Math.min(ws.length, MAX_SEG_WORDS);
      for (let n = MIN_SEG_WORDS; n <= hi; n++) {
        for (let i = 0; i + n <= ws.length; i++) {
          const slice = trimEdges(ws.slice(i, i + n));
          if (slice.length < MIN_SEG_WORDS) continue;
          // L'ordre des mots compte : c'est une phrase, pas un sac de termes.
          const key = slice.map(w => stem(w.toLowerCase())).join(' ');
          if (!frags.has(key)) {
            frags.set(key, { text: slice.join(' '), seg: segIdx, start: i, end: i + n });
          }
        }
      }
    });

    for (const key of frags.keys()) docFreq.set(key, (docFreq.get(key) || 0) + 1);
    perVideo.push({ row: r, frags });
  }

  // Un fragment présent dans 30% des titres est la signature du créateur
  // ("| Nature Animal Documentary"), pas un sujet : il ne ramènerait que la cible.
  const SIGNATURE_DF = Math.max(2, Math.ceil(rows.length * 0.3));
  const MAX_PER_VIDEO = 2;

  const out = [];
  const seen = new Set();

  for (const { row, frags } of perVideo) {
    const views = Number(row.views) || 0;
    const vScore = 0.15 + 0.85 * (views / maxViews);

    // Candidats de cette vidéo, triés par intérêt décroissant.
    const cands = [];
    for (const [key, f] of frags) {
      if (seen.has(key)) continue;
      const df = docFreq.get(key) || 1;
      if (df >= SIGNATURE_DF) continue;

      const stems = key.split(' ');
      if (stems.every(s => brandStems.has(s))) continue;   // nom de la chaîne

      cands.push({ key, f, df, score: vScore * (1 / df) * lenScore(stems.length) });
    }
    cands.sort((a, b) => b.score - a.score);

    // Un seul fragment par zone du titre : les fenêtres voisines décrivent le
    // même sujet et coûteraient 100 u chacune pour le même résultat.
    const taken = [];
    for (const c of cands) {
      if (taken.length >= MAX_PER_VIDEO) break;
      const overlaps = taken.some(t =>
        t.f.seg === c.f.seg && c.f.start < t.f.end && t.f.start < c.f.end
      );
      if (overlaps) continue;
      taken.push(c);
      seen.add(c.key);
      out.push({
        query: c.f.text,
        videoId: row.video_id,
        sourceTitle: row.title,
        views: views || null,
        docFreq: c.df,
        weight: c.score,
      });
    }
  }

  return out.sort((a, b) => b.weight - a.weight).slice(0, MAX_SEGMENT_QUERIES);
}

// --- Étape A : proposer les requêtes (gratuit) ---

export async function buildQueries(channelId, { count = DEFAULT_QUERIES, mode = 'titles' } = {}) {
  if (mode !== 'titles' && mode !== 'segments') {
    throw new Error(`Mode inconnu : "${mode}". Attendu "titles" ou "segments".`);
  }

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

  // En mode segments, un seul titre performant suffit à produire des fragments
  // (cas d'une chaîne à 2 vidéos dont une qui a explosé). Le mode titres a
  // besoin de plus de matière pour que la déduplication ait un sens.
  const minRows = mode === 'segments' ? 1 : 3;
  if (rows.length < minRows) {
    throw new Error(`Chaîne insuffisamment crawlée (${rows.length} vidéos longues). Lance un crawl d'abord.`);
  }

  const titles = rows.map(r => r.title);
  const template = detectTemplate(titles);

  let all;

  if (mode === 'segments') {
    // Le nom de la chaîne, apposé à chaque titre, produirait des fragments qui
    // ne ramènent que la cible : on le neutralise en amont.
    const [[brand]] = await pool.query(
      'SELECT channel_title FROM target_channels WHERE channel_id = ?',
      [channelId]
    );
    const brandTerms = brand?.channel_title ? tokenize(brand.channel_title) : [];

    all = buildSegmentQueries(rows, { brandTerms }).map(c => ({
      videoId: c.videoId,
      sourceTitle: c.sourceTitle,
      views: c.views,
      query: c.query,
      subject: null,
      terms: null,
      docFreq: c.docFreq,
      selected: false,
      similarTo: null,
    }));
    if (!all.length) {
      throw new Error('Aucun fragment exploitable : les titres sont trop courts ou tous identiques. Essaie le mode « titres ».');
    }
  } else {
    // Toutes les vidéos deviennent des requêtes candidates, ordonnées par vues.
    all = rows.map(r => ({
      videoId: r.video_id,
      sourceTitle: r.title,
      views: r.views === null || r.views === undefined ? null : Number(r.views),
      query: cleanTitle(r.title),
      subject: extractSubject(r.title, template),
      terms: null,
      selected: false,
      similarTo: null,
    }));
  }

  // Présélection : on descend la liste et on écarte ce qui recoupe une requête déjà retenue.
  const SIM_THRESHOLD = 0.35;

// En mode segments, plusieurs fragments viennent du même titre. Jaccard en
  // écarte une partie, mais deux fragments disjoints d'un même titre passeraient
  // ("Found a Dinosaur Zoo" et "Jurassic World Rebirth"). On plafonne donc à un
  // fragment par vidéo source, pour que la présélection couvre plusieurs sujets.
  const MAX_PER_VIDEO = mode === 'segments' ? 1 : Infinity;
  const videoCount = new Map();
  let picked = 0;

  for (const cand of all) {
    if (picked >= count) break;
    const clash = all.find(o => o.selected && similarity(o.query, cand.query) >= SIM_THRESHOLD);
    if (clash) { cand.similarTo = clash.videoId ?? clash.query; continue; }

    const src = cand.videoId || '';
    if ((videoCount.get(src) || 0) >= MAX_PER_VIDEO) continue;
    videoCount.set(src, (videoCount.get(src) || 0) + 1);

    cand.selected = true;
    picked++;
  }

  return {
    channelId,
    mode,
    videosAnalyzed: rows.length,
    template,          // null si la chaîne n'a pas de formule récurrente
    queries: all,      // toutes les candidates ; `selected` marque la présélection
    selectedCount: picked,
    // Plancher : recherches + enrichissement. Plafond : + inspections de format
    // (jusqu'à 20 chaînes à ~6 u). L'UI affiche la fourchette.
    estimatedQuota: picked * 100 + 2,
    estimatedQuotaMax: picked * 101 + 121,
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
    channelTitle: decodeEntities(it.snippet?.channelTitle),
    title: decodeEntities(it.snippet?.title),
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
        channelTitle: decodeEntities(c.snippet?.title) || '',
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
    // Filtres durs, réglables depuis l'UI. Ils écartent les mastodontes établis
    // et les usines à contenu, qui remontent toujours mais n'apprennent rien.
    maxSubscribers = 1000000,
    maxAgeMonths = 60,
    maxLongVideos = 80,
    minRatio = 1,
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
        agg.set(v.channelId, {
          channelId: v.channelId, channelTitle: v.channelTitle,
          queries: [], videos: [], videoIds: new Set(),
        });
      }
      const entry = agg.get(v.channelId);
      // Une même vidéo remonte souvent sur plusieurs requêtes : sans ce garde-fou
      // elle apparaît en double dans les échantillons affichés.
      if (v.videoId && !entry.videoIds.has(v.videoId)) {
        entry.videoIds.add(v.videoId);
        entry.videos.push({ videoId: v.videoId, title: v.title, publishedAt: v.publishedAt, query: q });
      }

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
  const MAX_INSPECTIONS = 20;        // ~6u chacune
  const maxQueries = queries.length;
  const competitors = [];
  let rejectedShorts = 0;
  let rejectedFilters = 0;
  let notInspected = 0;
  let inspectionsDone = 0;

  // Ordre d'inspection : co-occurrence d'abord, le budget va aux plus prometteuses.
  const ordered = [...retained].sort((a, b) => b.queries.length - a.queries.length);

  for (const entry of ordered) {
    const d = details.get(entry.channelId);
    if (!d) continue;

    // Vidéos remontées, enrichies (durée + vues réelles) — sert à l'affichage.
    const enriched = entry.videos.map(v => ({ ...v, ...(vidDetails.get(v.videoId) || {}) }));
    const longsFound = enriched.filter(v => (v.durationSeconds ?? 0) >= MIN_DURATION_LONG);

    // Inventaire réel de la chaîne : le seul verdict fiable sur le format ET
    // sur la performance. Sans lui, aucun filtre ne peut s'appliquer.
    let inv = null;
    if (inspectionsDone < MAX_INSPECTIONS) {
      try {
        inv = await inspectChannel(entry.channelId, MIN_DURATION_LONG);
        quotaUsed += inv.quotaUsed;
        inspectionsDone++;
      } catch {
        // Playlist inaccessible : chaîne non vérifiable.
      }
    }
    if (!inv) { notInspected++; continue; }

    // Filtre 2 : format. Une chaîne à Shorts n'est pas un concurrent sur le long.
    const MIN_LONG_VIDEOS = 3;
    const MAX_SHORT_RATIO = 0.80;
    const shortRatio = inv.totalCount > 0 ? inv.shortCount / inv.totalCount : 0;
    if (inv.longCount < MIN_LONG_VIDEOS || shortRatio > MAX_SHORT_RATIO) {
      rejectedShorts++;
      continue;
    }

    // Performance réelle : moyenne sur TOUT l'inventaire long de la chaîne, pas
    // sur les seules vidéos remontées par la recherche (qui sont ses meilleures).
    const avgLongViews = Math.round(inv.longViews / inv.longCount);
    const perfRatio = d.subscribers > 0
      ? Math.round((avgLongViews / d.subscribers) * 100) / 100
      : null;

    // Filtre 3 : profil. Trop grosse, trop vieille, trop prolifique, ou portée
    // par son stock d'abonnés plutôt que par l'algorithme.
    if ((d.subscribers ?? 0) > maxSubscribers) { rejectedFilters++; continue; }
    if (d.ageMonths !== null && d.ageMonths > maxAgeMonths) { rejectedFilters++; continue; }
    if (inv.longCount > maxLongVideos) { rejectedFilters++; continue; }
    if (perfRatio !== null && perfRatio < minRatio) { rejectedFilters++; continue; }

    const longViews = longsFound.map(v => v.views ?? 0).sort((a, b) => a - b);
    const medianLongViews = longViews.length ? longViews[Math.floor(longViews.length / 2)] : null;

    const ages = enriched
      .map(v => v.publishedAt ? (Date.now() - new Date(v.publishedAt)) / 86400000 : null)
      .filter(a => a !== null)
      .sort((a, b) => a - b);
    const medianAgeDays = ages.length ? Math.round(ages[Math.floor(ages.length / 2)]) : null;

    const realDensity = d.subscribers != null ? Math.round(d.subscribers / inv.longCount) : null;

    // Score 0-100 : performance 45% + jeunesse 20% + co-occurrence 20% + densité 15%.
    // La co-occurrence prouve qu'on est dans le bon créneau ; elle ne dit rien de
    // la qualité de la chaîne, d'où son poids réduit.
    const perfScore = perfRatio === null ? 20
      : Math.min(100, Math.round((Math.log10(1 + perfRatio) / Math.log10(21)) * 100));
    const coScore = Math.round((entry.queries.length / maxQueries) * 100);
    const youthScore = d.ageMonths === null ? 30
      : d.ageMonths <= 6 ? 100
      : d.ageMonths >= 60 ? 0
      : Math.round(100 - ((d.ageMonths - 6) / 54) * 100);
    const densScore = Math.min(100, Math.round((realDensity ?? 0) / 50));

    competitors.push({
      ...d,
      channelTitle: d.channelTitle || entry.channelTitle,
      queryCount: entry.queries.length,
      matchedQueries: entry.queries,
      videosFound: enriched.length,
      longVideosFound: longsFound.length,
      medianLongViews,
      avgLongViews,
      perfRatio,
      longCount: inv.longCount,
      shortCount: inv.shortCount,
      shortRatio: inv.totalCount > 0 ? Math.round(shortRatio * 100) : null,
      realDensity,
      sampleVideos: longsFound
        .sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
        .slice(0, 5)
        .map(v => ({ videoId: v.videoId, title: v.title, views: v.views ?? null, durationSeconds: v.durationSeconds ?? null })),
      medianAgeDays,
      score: Math.round(perfScore * 0.45 + youthScore * 0.20 + coScore * 0.20 + densScore * 0.15),
    });
  }

  competitors.sort((a, b) => b.score - a.score || b.queryCount - a.queryCount);

  return {
    sourceChannelId: channelId,
    queriesUsed: queryReport,
    candidatesFound: competitors.length,
    rejectedSingle,
    rejectedShorts,
    rejectedFilters,
    notInspected,
    inspectionsDone,
    filters: { maxSubscribers, maxAgeMonths, maxLongVideos, minRatio },
    quotaUsed,
    competitors,
    fetchedAt: new Date().toISOString(),
  };
}
// niche-finder/gems.js
// Détection de percées d'algo sur l'existant : compare le gain de la fenêtre
// récente au gain de la fenêtre précédente. Lecture seule + écriture en base.
// Aucun appel API. Lancé par cron après watch.js et scan-auto.js.

process.loadEnvFile(new URL('./.env', import.meta.url));

import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

const __filename = fileURLToPath(import.meta.url);

// --- Réglages de détection ---
const WINDOW = 7;             // taille de chaque fenêtre, en jours
const MIN_ACCEL = 0.5;        // +50 % de gain vs fenêtre précédente
const MIN_ABS_SUBS = 500;     // OU 5 % du total (voir MIN_REL)
const MIN_ABS_VIEWS = 10000;
const MIN_REL = 0.05;         // 5 % de la valeur de départ

// --- Réglages découverte (scan-auto) ---
const DISCOVERY_MIN_DURATION = 180;   // exclut Shorts et formats courts
const DISCOVERY_TOP_N = 5;            // par mot-clé
const DISCOVERY_MIN_SCORE = 45;       // score composite plancher
const DAMPING_K = 5000;               // identique à index.html
const WEIGHTS = { ratio: 0.60, fresh: 0.25, density: 0.15 };

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Un signal est retenu si l'accélération dépasse le seuil ET que le gain
// récent est significatif en absolu OU en relatif.
function isSignificant(recent, previous, base, minAbs) {
  if (recent == null || previous == null) return false;
  if (recent <= 0) return false;
  const accel = previous > 0 ? (recent - previous) / previous : (recent >= minAbs ? 1 : 0);
  if (accel < MIN_ACCEL) return false;
  const absOk = recent >= minAbs;
  const relOk = base > 0 && recent / base >= MIN_REL;
  return absOk || relOk;
}

function score(recent, previous, base) {
  const accel = previous > 0 ? (recent - previous) / previous : 1;
  const rel = base > 0 ? recent / base : 0;
  return Number((accel * 60 + rel * 400).toFixed(2));
}

// Récupère, pour chaque entité, trois relevés : t0 (début), t1 (milieu), t2 (dernier).
// Générique : marche pour channel_stats, target_channel_stats et video_stats.
async function windowedDeltas(table, idCol, metric, joinTable, joinIdCol) {
  const span = WINDOW * 2;
  const [rows] = await pool.query(
    `SELECT s.${idCol} AS entity_id, s.captured_date, s.${metric} AS metric
     FROM ${table} s
     JOIN ${joinTable} j ON j.${joinIdCol} = s.${idCol}
     WHERE s.captured_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       AND s.${metric} IS NOT NULL
     ORDER BY s.${idCol}, s.captured_date ASC`,
    [span]
  );

  const byEntity = {};
  for (const r of rows) {
    (byEntity[r.entity_id] ??= []).push({
      date: r.captured_date.toISOString().slice(0, 10),
      value: Number(r.metric),
    });
  }

  const out = [];
  const midDate = new Date(Date.now() - WINDOW * 86400000).toISOString().slice(0, 10);

  for (const [entityId, series] of Object.entries(byEntity)) {
    if (series.length < 3) continue;               // pas assez d'historique

    const first = series[0];
    const last = series[series.length - 1];

    // Point pivot : le relevé le plus proche de la frontière des deux fenêtres.
    let mid = series[0];
    for (const p of series) {
      if (p.date <= midDate) mid = p; else break;
    }
    if (mid === first || mid === last) continue;   // pivot dégénéré

    const previous = mid.value - first.value;
    const recent = last.value - mid.value;

    out.push({
      entityId,
      base: first.value,
      current: last.value,
      previous,
      recent,
      points: series.length,
      firstDate: first.date,
      midDate: mid.date,
      lastDate: last.date,
    });
  }

  return out;
}

// --- Les trois détecteurs ---

async function channelGems() {
  const deltas = await windowedDeltas(
    'channel_stats', 'channel_id', 'subscribers', 'channels', 'channel_id'
  );
  const ids = deltas.map(d => d.entityId);
  if (!ids.length) return [];

  const [titles] = await pool.query(
    'SELECT channel_id, channel_title, handle FROM channels WHERE channel_id IN (?)',
    [ids]
  );
  const meta = Object.fromEntries(titles.map(t => [t.channel_id, t]));

  return deltas
    .filter(d => isSignificant(d.recent, d.previous, d.base, MIN_ABS_SUBS))
    .map(d => ({
      kind: 'channel_subs',
      entityId: d.entityId,
      label: meta[d.entityId]?.channel_title || d.entityId,
      handle: meta[d.entityId]?.handle || null,
      metric: 'subscribers',
      base: d.base,
      current: d.current,
      previous: d.previous,
      recent: d.recent,
      score: score(d.recent, d.previous, d.base),
    }));
}

async function targetGems() {
  const deltas = await windowedDeltas(
    'target_channel_stats', 'channel_id', 'subscribers', 'target_channels', 'channel_id'
  );
  const ids = deltas.map(d => d.entityId);
  if (!ids.length) return [];

  const [titles] = await pool.query(
    'SELECT channel_id, channel_title, handle FROM target_channels WHERE channel_id IN (?)',
    [ids]
  );
  const meta = Object.fromEntries(titles.map(t => [t.channel_id, t]));

  return deltas
    .filter(d => isSignificant(d.recent, d.previous, d.base, MIN_ABS_SUBS))
    .map(d => ({
      kind: 'target_subs',
      entityId: d.entityId,
      label: meta[d.entityId]?.channel_title || d.entityId,
      handle: meta[d.entityId]?.handle || null,
      metric: 'subscribers',
      base: d.base,
      current: d.current,
      previous: d.previous,
      recent: d.recent,
      score: score(d.recent, d.previous, d.base),
    }));
}

async function videoGems() {
  const deltas = await windowedDeltas(
    'video_stats', 'video_id', 'views', 'videos', 'video_id'
  );
  const ids = deltas.map(d => d.entityId);
  if (!ids.length) return [];

  const [titles] = await pool.query(
    'SELECT video_id, title, channel_title FROM videos WHERE video_id IN (?)',
    [ids]
  );
  const meta = Object.fromEntries(titles.map(t => [t.video_id, t]));

  return deltas
    .filter(d => isSignificant(d.recent, d.previous, d.base, MIN_ABS_VIEWS))
    .map(d => ({
      kind: 'video_views',
      entityId: d.entityId,
      label: meta[d.entityId]?.title || d.entityId,
      handle: meta[d.entityId]?.channel_title || null,
      metric: 'views',
      base: d.base,
      current: d.current,
      previous: d.previous,
      recent: d.recent,
      score: score(d.recent, d.previous, d.base),
    }));
}

// --- Découverte : signaux issus du scan nocturne ---
// Même score composite que index.html, pour rester cohérent avec l'affichage.

function ampRatio(v) {
  return v.views / ((v.subscribers ?? 0) + DAMPING_K);
}

function freshScore(publishedAt) {
  const days = (Date.now() - new Date(publishedAt)) / 86400000;
  if (days <= 7) return 100;
  if (days >= 90) return 10;
  return Math.round(100 - ((days - 7) / (90 - 7)) * 90);
}

// scanOutputs : [{ keyword, videos: [...] }] fourni par scan-auto.js
export function discoveryGems(scanOutputs) {
  const out = [];

  for (const { keyword, videos } of scanOutputs) {
    const eligible = (videos || []).filter(v => v.durationSeconds >= DISCOVERY_MIN_DURATION);
    if (!eligible.length) continue;

    const distinctChannels = new Set(eligible.map(v => v.channelId)).size;
    const densityScore = Math.min(100, distinctChannels * 8);

    const scored = eligible.map(v => {
      const rScore = Math.min(100, Math.round(ampRatio(v)));
      const fScore = freshScore(v.publishedAt);
      return {
        ...v,
        composite: Math.round(
          rScore * WEIGHTS.ratio + fScore * WEIGHTS.fresh + densityScore * WEIGHTS.density
        ),
      };
    });

    scored
      .filter(v => v.composite >= DISCOVERY_MIN_SCORE)
      .sort((a, b) => b.composite - a.composite)
      .slice(0, DISCOVERY_TOP_N)
      .forEach(v => {
        out.push({
          kind: 'scan_discovery',
          entityId: v.videoId,
          label: v.title,
          handle: v.channelTitle,
          metric: keyword,                      // le mot-clé qui l'a fait remonter
          base: v.subscribers ?? 0,
          current: v.views,
          previous: v.durationSeconds,
          recent: v.ratio != null ? Math.round(v.ratio) : 0,
          score: v.composite,
        });
      });
  }

  return out.sort((a, b) => b.score - a.score);
}

// --- Persistance ---
// uniq_gem (kind, entity_id, detected_date) : un signal par entité et par jour.

async function saveGems(gems) {
  if (!gems.length) return 0;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const g of gems) {
      await conn.query(
        `INSERT INTO gems
           (kind, entity_id, label, handle, metric, base_value, current_value,
            previous_delta, recent_delta, score, detected_at, detected_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)
         ON DUPLICATE KEY UPDATE label = VALUES(label),
                                 current_value = VALUES(current_value),
                                 previous_delta = VALUES(previous_delta),
                                 recent_delta = VALUES(recent_delta),
                                 score = VALUES(score),
                                 detected_at = VALUES(detected_at)`,
        [g.kind, g.entityId, g.label, g.handle, g.metric,
         g.base, g.current, g.previous, g.recent, g.score, today()]
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return gems.length;
}

// --- Orchestration ---

export async function run(scanOutputs = []) {
  const started = Date.now();

  const [chans, targets, vids] = await Promise.all([
    channelGems(),
    targetGems(),
    videoGems(),
  ]);

  const discovered = discoveryGems(scanOutputs);

  const gems = [...chans, ...targets, ...vids, ...discovered].sort((a, b) => b.score - a.score);
  const saved = await saveGems(gems);

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `[gems] ${new Date().toISOString()} — ` +
    `${chans.length} chaînes suivies, ${targets.length} cibles, ${vids.length} vidéos, ` +
    `${discovered.length} découvertes ` +
    `| ${saved} signal(aux) enregistré(s) | fenêtre ${WINDOW}j | ${secs}s`
  );

  for (const g of gems.slice(0, 10)) {
    const detail = g.kind === 'scan_discovery'
      ? `ratio ${g.recent} · ${g.current} vues · ${g.base} abo · "${g.metric}"`
      : `+${g.recent} ${g.metric} (vs +${g.previous} avant)`;
    console.log(`   ${g.score.toFixed(0).padStart(4)} · ${g.kind} · ${g.label.slice(0, 60)} : ${detail}`);
  }

  return gems;
}

if (process.argv[1] === __filename) {
  run()
    .then(() => pool.end())
    .catch(err => { console.error('\n💥', err.message); pool.end(); process.exit(1); });
}
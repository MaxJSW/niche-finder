// niche-finder/transcripts.js
// Récupération de transcriptions YouTube à la demande (yt-dlp --write-auto-sub)
// Piste originale (*-orig) en priorité, repli sur la traduction anglaise.
// Stockage en base dans la table transcripts (une ligne par vidéo, écrasée au re-fetch).

import { pool } from './db.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const YT_DLP = '/usr/local/bin/yt-dlp';
const COOKIES = process.env.YT_COOKIES_PATH;
const TMP_ROOT = '/tmp/niche-transcripts';
const TIMEOUT_MS = 60_000;

// Lance yt-dlp pour un pattern de langue donné, dans un dossier dédié.
// Retourne la liste des fichiers .vtt produits (souvent 0 ou 1).
async function runYtDlp(videoId, langPattern, outDir) {
  const args = [
    '--skip-download',
    '--write-auto-sub',
    '--sub-lang', langPattern,
    '--sub-format', 'vtt',
    '--ignore-no-formats-error',
    '--force-ipv4',                      // bug IPv6 OVH : yt-dlp est un sous-process, le patch Node ne le couvre pas
    '--cookies', COOKIES,
    '-o', path.join(outDir, '%(id)s'),
    `https://www.youtube.com/watch?v=${videoId}`,
  ];

  await execFileAsync(YT_DLP, args, { timeout: TIMEOUT_MS });

  const files = await fs.readdir(outDir);
  return files.filter(f => f.endsWith('.vtt'));
}

// "00:03:27.966" -> 207 (secondes entières)
function vttTimeToSeconds(t) {
  const [h, m, s] = t.split(':');
  return Math.floor(Number(h) * 3600 + Number(m) * 60 + parseFloat(s));
}

// VTT auto-sub YouTube -> { content, markers }.
// content : texte brut nettoyé.
// markers : marqueurs sonores ([música], [risas]...) avec leurs timestamps
//           de début en secondes, ex. { "música": [3, 27, 158] }.
function cleanVtt(raw) {
  const lines = raw.split('\n');
  const out = [];
  const markers = {};
  let prev = '';
  let currentTime = 0;

  for (let line of lines) {
    // En-tête et métadonnées
    if (/^WEBVTT/.test(line) || /^Kind:/.test(line) || /^Language:/.test(line)) continue;

    // Ligne de timing : on retient le début du cue courant, puis on saute
    const timing = line.match(/^(\d{2}:\d{2}:\d{2}\.\d{3})\s+-->/);
    if (timing) {
      currentTime = vttTimeToSeconds(timing[1]);
      continue;
    }

    // Marqueurs sonores : comptés avec leur timestamp, puis retirés du texte.
    // Dédup : le double cue des auto-subs capte chaque marqueur deux fois
    // à quelques secondes d'écart -> on ignore une répétition à moins de 3 s.
    for (const m of line.matchAll(/\[([^\]]{1,30})\]/g)) {
      const key = m[1].trim().toLowerCase();
      if (!markers[key]) markers[key] = [];
      const last = markers[key][markers[key].length - 1];
      if (last !== undefined && currentTime - last < 3) continue;
      markers[key].push(currentTime);
    }

    // Balises incrustées + marqueurs sonores
    line = line
      .replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, '')
      .replace(/<\/?c[^>]*>/g, '')
      .replace(/\[[^\]]{1,30}\]/g, '')
      .trim();

    if (!line) continue;
    // Doublon consécutif (ligne "en cours de frappe" puis figée)
    if (line === prev) continue;

    out.push(line);
    prev = line;
  }

  return {
    content: out.join(' ').replace(/\s+/g, ' ').trim(),
    markers,
  };
}

// Extrait langue + drapeau original depuis le nom de fichier yt-dlp.
// Ex. "Qs4FqYTtXBU.es-orig.vtt" -> { language: 'es', isOriginal: 1 }
//     "Qs4FqYTtXBU.en.vtt"      -> { language: 'en', isOriginal: 0 }
function parseSubFilename(filename) {
  const parts = filename.split('.');            // [videoId, 'es-orig', 'vtt']
  const tag = parts.length >= 3 ? parts[parts.length - 2] : '';
  const isOriginal = tag.endsWith('-orig') ? 1 : 0;
  const language = tag.replace(/-orig$/, '');
  return { language, isOriginal };
}

// --- Point d'entrée : récupère, nettoie et stocke la transcription ---
async function fetchTranscript(videoId, channelId) {
  const outDir = path.join(TMP_ROOT, `${videoId}-${Date.now()}`);
  await fs.mkdir(outDir, { recursive: true });

  try {
    // 1. Piste originale en priorité
    let files = await runYtDlp(videoId, '.*-orig', outDir);

    // 2. Repli : traduction anglaise
    if (!files.length) {
      files = await runYtDlp(videoId, 'en.*', outDir);
    }

    if (!files.length) {
      return { ok: false, videoId, reason: 'no_subtitles' };
    }

    const filename = files[0];
    const raw = await fs.readFile(path.join(outDir, filename), 'utf8');
    const { content, markers } = cleanVtt(raw);

    if (!content) {
      return { ok: false, videoId, reason: 'empty_after_clean' };
    }

    const { language, isOriginal } = parseSubFilename(filename);
    const wordCount = content.split(' ').length;

    await pool.query(
      `INSERT INTO transcripts
         (video_id, channel_id, language, is_original, content, word_count, audio_markers)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         language      = VALUES(language),
         is_original   = VALUES(is_original),
         content       = VALUES(content),
         word_count    = VALUES(word_count),
         audio_markers = VALUES(audio_markers),
         fetched_at    = CURRENT_TIMESTAMP`,
      [videoId, channelId, language, isOriginal, content, wordCount,
       Object.keys(markers).length ? JSON.stringify(markers) : null]
    );

    return { ok: true, videoId, language, isOriginal, wordCount,
             markerTypes: Object.keys(markers).length };
  } finally {
    // Nettoyage du dossier temporaire dans tous les cas
    await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Lecture d'une transcription en base (pour la route GET).
async function getTranscript(videoId) {
  const [rows] = await pool.query(
    `SELECT video_id, channel_id, language, is_original, content, word_count, fetched_at
       FROM transcripts
      WHERE video_id = ?`,
    [videoId]
  );
  return rows[0] || null;
}

export { fetchTranscript, getTranscript };
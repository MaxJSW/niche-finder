// niche-finder/launch-script.js
// Génération du script narratif d'un pick kept.
// Deux passes : plan (structure) puis rédaction unité par unité.
// Sortie : JSON strict inséré dans la table scripts (régénérable, on lit la plus récente).

import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import Anthropic from '@anthropic-ai/sdk';
import { pool } from './db.js';
import { getTranscript } from './transcripts.js';

const MODEL = 'claude-sonnet-4-5';
const MAX_ATTEMPTS = 3;
const DEFAULT_DURATION_MIN = 12;
const MIN_DURATION = 8;
const MAX_DURATION = 15;
const MAX_TRANSCRIPT_WORDS = 12000;   // garde-fou coût sur vidéos très longues

// Part de la durée occupée par la narration. Le reste (20 %) = respirations :
// musique, plans d'action ou de contemplation sans voix off.
const NARRATION_RATIO = 0.80;

// Bornes de sécurité sur les respirations proposées par l'IA.
const BEAT_TYPES = ['musique', 'action', 'contemplation'];
const BEAT_MIN_S = 4;
const BEAT_MAX_S = 20;

// Débit de narration documentaire, pauses dramatiques incluses.
// Volontairement plus lent qu'une lecture neutre (~160-170).
const WPM = { fr: 140, en: 140, es: 150, de: 132, pt: 145 };

// Nom explicite de la langue : un code ISO seul ne suffit pas,
// le modèle suit la langue dominante du contexte.
const LANG_NAME = {
  fr: 'French', en: 'English', es: 'Spanish', de: 'German', pt: 'Portuguese',
};
function langName(code) { return LANG_NAME[code] || code; }

// Client instancié à la demande : évite de lire process.env avant loadEnvFile().
let _client = null;
function client() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

const usage = { input: 0, output: 0 };

// Appel Claude -> texte brut concaténé. Cumule les tokens consommés.
async function ask(system, user, maxTokens) {
  const res = await client().messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });
  usage.input += res.usage?.input_tokens || 0;
  usage.output += res.usage?.output_tokens || 0;
  return res.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

// Extrait le premier objet JSON du texte (tolère les backticks et le préambule).
function parseJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Réponse IA sans JSON exploitable.');
  return JSON.parse(text.slice(start, end + 1));
}

// Réessaie une fonction async jusqu'à MAX_ATTEMPTS, puis remonte l'erreur nommée.
async function withRetry(label, fn) {
  let last;
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    try { return await fn(); }
    catch (err) { last = err; }
  }
  throw new Error(`Échec sur « ${label} » après ${MAX_ATTEMPTS} tentatives : ${last.message.slice(0, 160)}`);
}

function countWords(t) { return String(t || '').trim().split(/\s+/).filter(Boolean).length; }
function lastWords(t, n) { return String(t || '').trim().split(/\s+/).slice(-n).join(' '); }

// "10-12 minutes" -> 11 ; "environ 9 min" -> 9 ; absent -> défaut.
function parseTargetMinutes(txt) {
  const nums = String(txt || '').match(/\d+/g);
  if (!nums) return DEFAULT_DURATION_MIN;
  const v = nums.length >= 2
    ? Math.round((Number(nums[0]) + Number(nums[1])) / 2)
    : Number(nums[0]);
  if (!Number.isFinite(v)) return DEFAULT_DURATION_MIN;
  return Math.min(MAX_DURATION, Math.max(MIN_DURATION, v));
}

// --- Chargement du contexte ---
async function loadContext(pickId) {
  const [rows] = await pool.query(`
    SELECT p.id, p.launch_id, p.video_id, p.channel_id, p.angle, p.reason, p.status,
           v.title           AS video_title,
           l.name            AS launch_name,
           l.target_language AS lang
      FROM launch_picks p
      LEFT JOIN target_videos v ON v.video_id = p.video_id
      JOIN launches l           ON l.id = p.launch_id
     WHERE p.id = ?`, [pickId]);

  const pick = rows[0];
  if (!pick) throw new Error('Pick introuvable.');
  if (pick.status === 'rejected') throw new Error('Ce pick est rejeté — restaure-le avant de générer un script.');

  const tr = await getTranscript(pick.video_id);
  if (!tr || !tr.content) {
    throw new Error('Pas de transcription pour cette vidéo — lance « 📦 Récupérer le matériel » d\'abord.');
  }

  const [idRows] = await pool.query(`
    SELECT content FROM launch_reports
     WHERE launch_id = ? AND kind = 'identity'
     ORDER BY created_at DESC LIMIT 1`, [pick.launch_id]);

  let identity = null;
  if (idRows[0]) { try { identity = JSON.parse(idRows[0].content); } catch { /* corrompu -> ignoré */ } }

  const words = tr.content.split(/\s+/);
  const transcript = words.length > MAX_TRANSCRIPT_WORDS
    ? words.slice(0, MAX_TRANSCRIPT_WORDS).join(' ') + ' […]'
    : tr.content;

  return { pick, transcript, transcriptLang: tr.language, identity };
}

// --- Bloc de contexte partagé par les deux passes ---
function identityBlock(identity) {
  if (!identity) return 'Aucune identité de chaîne définie — adopte un ton documentaire clair et accessible.';
  const el = identity.editorial_line || {};
  const fm = identity.format || {};
  return [
    `Ton & style : ${identity.tone || '—'}`,
    `La chaîne couvre : ${el.covers || '—'}`,
    `La chaîne évite : ${el.avoids || '—'}`,
    `Structure type attendue : ${fm.structure || '—'}`,
  ].join('\n');
}

// --- PASSE 1 : le plan ---
async function buildPlan(ctx, budget) {
  const { pick, transcript, identity } = ctx;

const system = `You are a scriptwriter for a long-form narrative YouTube channel.
You output ONLY valid JSON — no backticks, no preamble, no commentary.`;

  const user = `Below is the transcript of a high-performing video.
Your script covers THE SAME SUBJECT as this video, treated from a different angle.
Same subject, new treatment — never a different topic.
The facts, names, events and details in this transcript are your source material:
build on them. Do not reuse its structure, its wording or its order.

SOURCE VIDEO TITLE: ${pick.video_title || pick.video_id}
ASSIGNED ANGLE: ${pick.angle || '—'}
WHY THIS TOPIC: ${pick.reason || '—'}

CHANNEL IDENTITY
${identityBlock(identity)}

BUDGET
- Narration language: ${langName(budget.lang)}
- Total video length: ${budget.minutes} minutes
- Narration: ~${budget.totalWords} words (about 80% of the runtime)
- Breathing room: ~${budget.breathingSeconds} seconds total with no narration —
  music, action or contemplation shots. Part of this is absorbed by natural
  pacing; the rest goes into the explicit beats you define below.
- Hook: ~${budget.hookWords} words · Outro: ~${budget.outroWords} words
- Between ${budget.minSegments} and ${budget.maxSegments} segments, ~${budget.perSegment} words each

SOURCE TRANSCRIPT
"""
${transcript}
"""

Return exactly this JSON:
{
  "title": "YouTube title in ${langName(budget.lang)}, compelling, no misleading clickbait",
  "hook_note": "in French: what the hook must achieve",
  "segments": [
    { "heading": "section title in French (internal use)",
      "note": "in French: what this segment covers and why it belongs here",
      "target_words": ${budget.perSegment},
      "beat": { "type": "musique | action | contemplation",
                "duration_s": 8,
                "intent": "in French: why the narration stops here" } }
  ],
  "outro_note": "in French: what the conclusion must achieve"
}

IMPORTANT: "title" is in ${langName(budget.lang)}. "heading", "note", "hook_note"
and "outro_note" are in French — they are internal notes for the creator.

Constraints: real narrative progression from one segment to the next (not a list of
juxtaposed facts). Each segment must make the viewer want to stay for the next one.

BEATS: a beat is a pause AFTER a segment where the narration stops and the visuals
carry the moment. Set "beat" to null when the next segment should follow immediately —
not every transition deserves a pause. Use them where they earn their place: after a
revelation, before a tonal shift, at the peak of an action sequence. Each beat lasts
between ${BEAT_MIN_S} and ${BEAT_MAX_S} seconds. The last segment's beat should
usually be null, since the outro follows.`;

  const plan = parseJson(await ask(system, user, 2000));
  if (!Array.isArray(plan.segments) || !plan.segments.length) {
    throw new Error('Plan invalide : aucun segment.');
  }
  return plan;
}

// --- PASSE 2 : rédaction d'une unité ---
async function writeUnit(ctx, budget, plan, unit, previousText) {
  const { pick, transcript, identity } = ctx;

const system = `You are the narrator for a YouTube channel.

You write pure VOICE-OVER narration, entirely in ${langName(budget.lang)}.
Some instructions you receive are in French — your output must nevertheless be
100% in ${langName(budget.lang)}.

Strictly forbidden: stage directions, visual cues, camera or shot references,
section titles, bullet lists, markdown. Only the words that will be read aloud.
Reply with the narration text and nothing else.`;

  const outline = plan.segments
    .map((s, i) => `${i + 1}. ${s.heading} — ${s.note}`)
    .join('\n');

  const target =
    unit.kind === 'hook'  ? `the HOOK (~${budget.hookWords} words). Goal: ${plan.hook_note || 'grab attention within 20 seconds'}.`
  : unit.kind === 'outro' ? `the CONCLUSION (~${budget.outroWords} words). Goal: ${plan.outro_note || 'wrap up and invite subscription'}.
Do not restate how the story ended — the viewer just heard it. Open on a different note.`
  : `SEGMENT ${unit.index + 1} — « ${unit.seg.heading} » (~${unit.seg.target_words || budget.perSegment} words).
Goal: ${unit.seg.note}`;

  const user = `VIDEO ANGLE: ${pick.angle || '—'}
TITLE: ${plan.title}

CHANNEL IDENTITY
${identityBlock(identity)}

FULL VIDEO OUTLINE
${outline}

${previousText ? `END OF THE PRECEDING TEXT (flow naturally from it, do not repeat it):\n"""${lastWords(previousText, unit.kind === 'outro' ? 400 : 150)}"""\n` : ''}
SOURCE MATERIAL (same subject as your script — use these facts, never this phrasing).
Do not invent names, dates, codenames or specimen numbers that are absent from it.
"""
${transcript}
"""

Now write ${target}`;

  const text = (await ask(system, user, 2000)).replace(/\s+/g, ' ').trim();
  if (countWords(text) < 30) throw new Error('Sortie trop courte.');
  return text;
}

// Sécurise le beat renvoyé par l'IA : type dans la liste, durée bornée.
// Renvoie null si le beat est absent, invalide ou explicitement nul.
function normalizeBeat(beat) {
  if (!beat || typeof beat !== 'object') return null;
  const type = String(beat.type || '').toLowerCase().trim();
  if (!BEAT_TYPES.includes(type)) return null;
  const d = Number(beat.duration_s);
  if (!Number.isFinite(d) || d <= 0) return null;
  return {
    type,
    duration_s: Math.min(BEAT_MAX_S, Math.max(BEAT_MIN_S, Math.round(d))),
    intent: String(beat.intent || '').slice(0, 300) || null,
  };
}

// --- Point d'entrée ---
async function generateScript(pickId) {
  usage.input = 0; usage.output = 0;

  const ctx = await loadContext(pickId);
  const { pick, identity } = ctx;

  const lang = pick.lang || 'en';
  const minutes = parseTargetMinutes(identity?.format?.target_duration);
  // 80 % de la durée en narration, 20 % en respirations.
  const totalWords = Math.round(minutes * (WPM[lang] || 150) * NARRATION_RATIO);
  const breathingSeconds = Math.round(minutes * 60 * (1 - NARRATION_RATIO));
  const hookWords = 70;
  const outroWords = 90;
  const body = Math.max(400, totalWords - hookWords - outroWords);
  // Nombre de segments d'abord, puis longueur ajustée pour couvrir le budget.
  const nSeg = Math.min(12, Math.max(4, Math.round(body / 250)));
  const perSegment = Math.round(body / nSeg);

  const budget = {
    lang, minutes, totalWords, breathingSeconds, hookWords, outroWords, perSegment,
    minSegments: Math.max(4, nSeg - 1),
    maxSegments: Math.min(12, nSeg + 1),
  };

  // Passe 1
  const plan = await withRetry('plan', () => buildPlan(ctx, budget));

  // Passe 2 — hook, segments, outro
  const units = [
    { kind: 'hook' },
    ...plan.segments.map((seg, index) => ({ kind: 'segment', seg, index })),
    { kind: 'outro' },
  ];

  const written = [];
  let previous = '';
  for (const unit of units) {
    const label = unit.kind === 'segment' ? `segment ${unit.index + 1} — ${unit.seg.heading}` : unit.kind;
    const text = await withRetry(label, () => writeUnit(ctx, budget, plan, unit, previous));
    written.push({ unit, text });
    // Le hook n'est pas passé en contexte : le premier segment le recopiait.
    previous = unit.kind === 'hook' ? '' : text;
  }

  const hook  = written.find(w => w.unit.kind === 'hook').text;
  const outro = written.find(w => w.unit.kind === 'outro').text;
  const segments = written
    .filter(w => w.unit.kind === 'segment')
    .map(w => ({
      heading: w.unit.seg.heading,
      note: w.unit.seg.note,
      narration: w.text,
      word_count: countWords(w.text),
      beat: normalizeBeat(w.unit.seg.beat),
    }));

  const wordCount = countWords(hook) + countWords(outro) + segments.reduce((s, x) => s + x.word_count, 0);
  const beatSeconds = segments.reduce((s, x) => s + (x.beat?.duration_s || 0), 0);

  const content = {
    title: plan.title,
    hook,
    segments,
    outro,
    estimated_duration_min: Math.round((wordCount / (WPM[lang] || 150) * 60 + beatSeconds) / 60),
    narration_duration_min: Math.round(wordCount / (WPM[lang] || 150)),
    beat_seconds: beatSeconds,
    beat_count: segments.filter(s => s.beat).length,
    target_duration_min: minutes,
    source_video_id: pick.video_id,
    source_video_title: pick.video_title || null,
    identity_used: Boolean(identity),
  };

  const [res] = await pool.query(
    `INSERT INTO scripts (pick_id, launch_id, content, language, angle, word_count, status)
     VALUES (?, ?, ?, ?, ?, ?, 'draft')`,
    [pick.id, pick.launch_id, JSON.stringify(content), lang, pick.angle || null, wordCount]
  );

  const warnings = [];
  if (!identity) warnings.push('Aucune identité de chaîne trouvée — script généré avec un ton par défaut.');

  return {
    scriptId: res.insertId,
    script: content,
    wordCount,
    calls: units.length + 1,
    usage: { ...usage },
    warnings,
  };
}

// Lecture du script le plus récent d'un pick (pour rouvrir sans rappeler l'IA).
async function getLatestScript(pickId) {
  const [rows] = await pool.query(
    `SELECT id, content, language, angle, word_count, status, created_at
       FROM scripts WHERE pick_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    [pickId]
  );
  if (!rows[0]) return null;
  const row = rows[0];
  try { row.content = JSON.parse(row.content); } catch { /* laissé brut */ }
  return row;
}

// Bascule draft <-> validated (le découpage en plans ne traitera que les validated).
async function setScriptStatus(scriptId, status) {
  if (!['draft', 'validated'].includes(status)) throw new Error('Statut invalide.');
  await pool.query(`UPDATE scripts SET status = ? WHERE id = ?`, [status, scriptId]);
  return { scriptId: Number(scriptId), status };
}

export { generateScript, getLatestScript, setScriptStatus };
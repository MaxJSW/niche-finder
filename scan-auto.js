// niche-finder/scan-auto.js
// Scan nocturne des mots-clés marqués auto_scan=1.
// Lancé par cron après watch.js. Coût : ~102 u par mot-clé.

process.loadEnvFile(new URL('./.env', import.meta.url));

import dns from 'node:dns';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { scanKeyword } from './scan.js';
import { recordScan } from './save.js';
import { pool } from './db.js';

dns.setDefaultResultOrder('ipv4first');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const QUOTA_FILE = path.join(__dirname, 'data', 'quota.json');
const QUOTA_LIMIT = 10000;
const RESERVE = 2000;          // marge laissée pour les scans manuels de la journée
const COST_PER_KEYWORD = 105;  // estimation haute d'un scan simple

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function readQuota() {
  try {
    const q = JSON.parse(await readFile(QUOTA_FILE, 'utf-8'));
    if (q.date !== today()) return { date: today(), used: 0 };
    return q;
  } catch {
    return { date: today(), used: 0 };
  }
}

async function addQuota(cost) {
  const q = await readQuota();
  q.used += cost;
  await writeFile(QUOTA_FILE, JSON.stringify(q));
  return q;
}

// Renvoie la liste des mots-clés à scanner automatiquement.
async function autoKeywords() {
  const [rows] = await pool.query(
    'SELECT keyword FROM keywords WHERE auto_scan = 1 ORDER BY keyword'
  );
  return rows.map(r => r.keyword);
}

export async function run() {
  const started = Date.now();
  const keywords = await autoKeywords();

  if (!keywords.length) {
    console.log('🌙 scan-auto : aucun mot-clé marqué auto_scan. Rien à faire.');
    return { scanned: 0, skipped: 0, quotaUsed: 0 };
  }

  console.log(`🌙 scan-auto : ${keywords.length} mot(s)-clé(s) à scanner.`);

  let scanned = 0, skipped = 0, quotaUsed = 0, failed = 0;
  const outputs = [];

  for (const keyword of keywords) {
    const q = await readQuota();
    if (q.used + COST_PER_KEYWORD > QUOTA_LIMIT - RESERVE) {
      console.warn(`⏸️  Quota de sécurité atteint (${q.used}/${QUOTA_LIMIT}). ${keywords.length - scanned - failed} mot(s)-clé(s) non scanné(s).`);
      skipped = keywords.length - scanned - failed;
      break;
    }

    try {
      const output = await scanKeyword(keyword, {
        regionCode: null,
        relevanceLanguage: null,
        deep: false,
      });

      await addQuota(output.quotaUsed);
      quotaUsed += output.quotaUsed;

      if (output.count > 0) {
        await recordScan(keyword, {
          quotaUsed: output.quotaUsed,
          videoCount: output.count,
        });
      }

      outputs.push({ keyword, videos: output.videos });

      // Archive brute du scan nocturne (latest.json est écrasé par les scans manuels).
      try {
        const slug = keyword.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        await writeFile(
          path.join(__dirname, 'data', `auto_${today()}_${slug}.json`),
          JSON.stringify(output, null, 2)
        );
      } catch (e) {
        console.warn(`   ⚠️  archive non écrite pour "${keyword}" : ${e.message}`);
      }

      scanned++;
      console.log(`   ✓ "${keyword}" → ${output.count} vidéos (${output.quotaUsed} u)`);
    } catch (err) {
      failed++;
      console.error(`   ✗ "${keyword}" : ${err.message}`);
    }
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`🌙 scan-auto terminé : ${scanned} scanné(s), ${failed} échec(s), ${skipped} ignoré(s) · ${quotaUsed} u · ${secs}s`);

  return { scanned, failed, skipped, quotaUsed, outputs };
}

if (process.argv[1] === __filename) {
  run()
    .then(() => pool.end())
    .catch(err => { console.error('\n💥', err.message); process.exit(1); });
}
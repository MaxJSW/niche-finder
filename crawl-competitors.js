// niche-finder/crawl-competitors.js
// Crawl des concurrents liés (channel_competitors) dont les données sont
// absentes ou périmées. Appelable par la route serveur ET par le cron nocturne.
// Coût : ~11 u par chaîne (1 channels + 5 playlistItems + 5 videos).

process.loadEnvFile(new URL('./.env', import.meta.url));

import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { crawlChannel } from './channel.js';
import { saveChannelCrawl } from './save-target.js';
import { listCrawlCandidates } from './competitors-links.js';
import { pool } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const QUOTA_FILE = path.join(__dirname, 'data', 'quota.json');
const QUOTA_LIMIT = 10000;

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

// reserve : marge de quota à ne pas entamer (2000 la nuit, 0 en manuel).
export async function run({
  sourceChannelId = null,
  maxAgeDays = 7,
  maxPages = 5,
  reserve = 0,
} = {}) {
  const started = Date.now();
  const perChannel = 1 + maxPages * 2;
  const ceiling = QUOTA_LIMIT - reserve;

  const candidates = await listCrawlCandidates({ sourceChannelId, maxAgeDays });
  if (!candidates.length) {
    console.log('🕸️ crawl-competitors : aucun concurrent à rafraîchir.');
    return { candidates: 0, crawled: [], skipped: [], failed: [], quota: await readQuota() };
  }

  console.log(`🕸️ crawl-competitors : ${candidates.length} candidat(s).`);

  const crawled = [];
  const skipped = [];
  const failed = [];

  for (const cand of candidates) {
    const q = await readQuota();
    if (q.used + perChannel > ceiling) {
      skipped.push({ channelId: cand.channel_id, channelTitle: cand.channel_title, reason: 'quota' });
      continue;
    }

    try {
      const crawl = await crawlChannel(cand.channel_id, { maxPages });
      const saved = await saveChannelCrawl(crawl, { isSeed: false });
      await addQuota(crawl.quotaUsed);
      console.log(`   ✓ ${crawl.channel.channelTitle} : ${saved.videosSaved} vidéos (${crawl.quotaUsed} u)`);
      crawled.push({
        channelId: cand.channel_id,
        channelTitle: crawl.channel.channelTitle,
        videosSaved: saved.videosSaved,
        quotaUsed: crawl.quotaUsed,
        truncated: crawl.truncated,
      });
    } catch (err) {
      console.error(`   ✗ ${cand.channel_id} : ${err.message}`);
      failed.push({ channelId: cand.channel_id, channelTitle: cand.channel_title, error: err.message });
    }
  }

  const quota = await readQuota();
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (skipped.length) console.warn(`   ⏸️  ${skipped.length} chaîne(s) non crawlée(s) : quota de sécurité.`);
  console.log(`🕸️ terminé : ${crawled.length} crawlée(s), ${failed.length} échec(s) · quota ${quota.used}/${QUOTA_LIMIT} · ${secs}s`);

  return { candidates: candidates.length, crawled, skipped, failed, quota: { ...quota, limit: QUOTA_LIMIT } };
}

// Exécution directe : node crawl-competitors.js
if (process.argv[1] === __filename) {
  run({ reserve: 2000 })
    .then(() => pool.end())
    .catch(err => { console.error('\n💥', err.message); pool.end(); process.exit(1); });
}
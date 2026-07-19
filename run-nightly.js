// niche-finder/run-nightly.js
// Enchaînement nocturne : watch → scan-auto → gems.
// Un seul point d'entrée pour le cron, une seule sortie dans watch.log.

process.loadEnvFile(new URL('./.env', import.meta.url));

import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { run as runWatch } from './watch.js';
import { run as runScanAuto } from './scan-auto.js';
import { run as runGems } from './gems.js';
import { run as runDigest } from './digest.js';
import { pool } from './db.js';

async function main() {
  console.log(`\n===== Nightly ${new Date().toISOString()} =====`);

  try {
    await runWatch();
  } catch (err) {
    console.error('[nightly] watch échoué :', err.message);
  }

  let outputs = [];
  try {
    const res = await runScanAuto();
    outputs = res.outputs || [];
  } catch (err) {
    console.error('[nightly] scan-auto échoué :', err.message);
  }

try {
    await runGems(outputs);
  } catch (err) {
    console.error('[nightly] gems échoué :', err.message);
  }

  try {
    await runDigest();
  } catch (err) {
    console.error('[nightly] digest échoué :', err.message);
  }

  console.log('===== Nightly terminé =====\n');
}

main()
  .then(() => pool.end())
  .catch(err => { console.error('💥', err.message); pool.end(); process.exit(1); });
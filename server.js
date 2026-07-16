// niche-finder/server.js
// Étape 3a : route de scan déclenchée par l'interface + compteur de quota journalier.

import express from 'express';
import dns from 'node:dns';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { scanKeyword } from './scan.js';   // la fonction déjà exportée de scan.js

dns.setDefaultResultOrder('ipv4first');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3100;
const QUOTA_FILE = path.join(__dirname, 'data', 'quota.json');
const QUOTA_LIMIT = 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Compteur de quota journalier (persistant, remis à zéro chaque jour) ---

function today() {
  return new Date().toISOString().slice(0, 10);  // ex. "2026-07-16"
}

async function readQuota() {
  try {
    const q = JSON.parse(await readFile(QUOTA_FILE, 'utf-8'));
    // Nouveau jour ? -> on repart de zéro.
    if (q.date !== today()) return { date: today(), used: 0 };
    return q;
  } catch {
    return { date: today(), used: 0 };  // fichier absent = première utilisation
  }
}

async function addQuota(cost) {
  const q = await readQuota();
  q.used += cost;
  await writeFile(QUOTA_FILE, JSON.stringify(q));
  return q;
}

// --- Routes ---

// Renvoie le dernier scan (inchangé).
app.get('/api/latest', async (req, res) => {
  try {
    const raw = await readFile(path.join(__dirname, 'data', 'latest.json'), 'utf-8');
    res.type('application/json').send(raw);
  } catch {
    res.status(404).json({ error: 'Aucun scan trouvé. Lance un scan.' });
  }
});

// Renvoie l'état du quota du jour (pour l'affichage).
app.get('/api/quota', async (req, res) => {
  const q = await readQuota();
  res.json({ ...q, limit: QUOTA_LIMIT, remaining: QUOTA_LIMIT - q.used });
});

// LA nouvelle route : lance un scan pour un mot-clé.
app.post('/api/scan', async (req, res) => {
  const keyword = (req.body?.keyword || '').trim();
  if (!keyword) return res.status(400).json({ error: 'Mot-clé manquant.' });

  // Garde-fou : refuse si le quota du jour est déjà au plafond.
  const q = await readQuota();
  if (q.used + 102 > QUOTA_LIMIT) {
    return res.status(429).json({ error: `Quota journalier presque épuisé (${q.used}/${QUOTA_LIMIT}). Réessaie demain.` });
  }

  try {
    console.log(`🔍 Scan demandé : "${keyword}"`);
    const output = await scanKeyword(keyword);

    // Sauvegarde comme le fait scan.js (historique + latest.json pour l'UI).
    const slug = keyword.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const stamp = output.fetchedAt.replace(/[:.]/g, '-');
    await writeFile(path.join(__dirname, 'data', `${slug}_${stamp}.json`), JSON.stringify(output, null, 2));
    await writeFile(path.join(__dirname, 'data', 'latest.json'), JSON.stringify(output, null, 2));

    const quota = await addQuota(output.quotaUsed);   // +102
    console.log(`✅ ${output.count} vidéos · quota jour : ${quota.used}/${QUOTA_LIMIT}`);

    res.json({ ...output, quota });
  } catch (err) {
    console.error('💥 Scan échoué :', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`✅ Serveur prêt sur http://127.0.0.1:${PORT}`);
});
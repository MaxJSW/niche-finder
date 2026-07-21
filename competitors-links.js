// niche-finder/competitors-links.js
// Gestion des liens source -> concurrent dans channel_competitors.
// Aucun appel YouTube : lecture/écriture MySQL uniquement (gratuit).
// La sélection des concurrents reste une décision manuelle de l'utilisateur ;
// findCompetitors() (competitors.js) ne fait que suggérer.

import { pool } from './db.js';

const ALLOWED_VIA = new Set(['related_video', 'keyword_overlap', 'manual']);

// Crée (ou met à jour) un lien source -> concurrent.
// La dédup est garantie par UNIQUE KEY uniq_pair (source, competitor).
async function linkCompetitor({ sourceChannelId, competitorChannelId, competitorTitle = null, via = 'manual', score = null }) {
  if (!sourceChannelId || !competitorChannelId) {
    throw new Error('sourceChannelId et competitorChannelId requis.');
  }
  if (sourceChannelId === competitorChannelId) {
    throw new Error('Une chaîne ne peut pas être son propre concurrent.');
  }
  if (!ALLOWED_VIA.has(via)) {
    throw new Error(`discovered_via invalide : "${via}".`);
  }

  // Vérification amont : message clair plutôt qu'une erreur FK brute.
  const [[src]] = await pool.query(
    'SELECT channel_id, channel_title FROM target_channels WHERE channel_id = ?',
    [sourceChannelId]
  );
  if (!src) {
    throw new Error(`Chaîne source inconnue : ${sourceChannelId}. Crawle-la d'abord (elle doit exister dans target_channels).`);
  }

  const [r] = await pool.query(
    `INSERT INTO channel_competitors
       (source_channel_id, competitor_channel_id, competitor_title, discovered_via, score)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       competitor_title = COALESCE(VALUES(competitor_title), competitor_title),
       discovered_via   = VALUES(discovered_via),
       score            = COALESCE(VALUES(score), score)`,
    [sourceChannelId, competitorChannelId, competitorTitle, via, score]
  );

  // affectedRows : 1 = créé, 2 = mis à jour (comportement MySQL documenté).
  return {
    sourceChannelId,
    sourceTitle: src.channel_title,
    competitorChannelId,
    created: r.affectedRows === 1,
  };
}

// Supprime un lien. Ne touche ni target_channels ni les vidéos déjà crawlées.
async function unlinkCompetitor({ sourceChannelId, competitorChannelId }) {
  if (!sourceChannelId || !competitorChannelId) {
    throw new Error('sourceChannelId et competitorChannelId requis.');
  }
  const [r] = await pool.query(
    'DELETE FROM channel_competitors WHERE source_channel_id = ? AND competitor_channel_id = ?',
    [sourceChannelId, competitorChannelId]
  );
  if (!r.affectedRows) throw new Error('Lien introuvable.');
  return { unlinked: competitorChannelId };
}

// Concurrents d'une chaîne source, enrichis si déjà crawlés.
// crawled_videos = 0 et last_crawled_at = NULL -> candidat pour l'étape crawl.
async function listCompetitors(sourceChannelId) {
  if (!sourceChannelId) throw new Error('sourceChannelId requis.');

  const [rows] = await pool.query(`
    SELECT
      cc.competitor_channel_id                    AS channel_id,
      COALESCE(tc.channel_title, cc.competitor_title) AS channel_title,
      cc.discovered_via,
      cc.score,
      cc.discovered_at,
      tc.handle,
      tc.subscribers,
      tc.last_crawled_at,
      (SELECT COUNT(*) FROM target_videos tv
        WHERE tv.channel_id = cc.competitor_channel_id) AS crawled_videos
    FROM channel_competitors cc
    LEFT JOIN target_channels tc ON tc.channel_id = cc.competitor_channel_id
    WHERE cc.source_channel_id = ?
    ORDER BY cc.discovered_at DESC
  `, [sourceChannelId]);

  return rows;
}

// Toutes les paires existantes, pour l'état initial des boutons 🔗 dans l'UI.
// Renvoie aussi le titre de la source pour un survol informatif.
async function listAllLinks() {
  const [rows] = await pool.query(`
    SELECT
      cc.source_channel_id,
      tc.channel_title AS source_title,
      cc.competitor_channel_id,
      cc.discovered_via
    FROM channel_competitors cc
    JOIN target_channels tc ON tc.channel_id = cc.source_channel_id
    ORDER BY cc.discovered_at DESC
  `);
  return rows;
}

// Concurrents à crawler : jamais crawlés, ou crawlés il y a plus de maxAgeDays jours.
// DISTINCT : un concurrent lié à plusieurs sources ne doit être crawlé qu'une fois.
async function listCrawlCandidates({ sourceChannelId = null, maxAgeDays = 7 } = {}) {
  const params = [maxAgeDays];
  let sourceFilter = '';
  if (sourceChannelId) {
    sourceFilter = 'AND cc.source_channel_id = ?';
    params.push(sourceChannelId);
  }

  const [rows] = await pool.query(`
    SELECT DISTINCT
      cc.competitor_channel_id AS channel_id,
      COALESCE(tc.channel_title, cc.competitor_title) AS channel_title,
      tc.last_crawled_at
    FROM channel_competitors cc
    LEFT JOIN target_channels tc ON tc.channel_id = cc.competitor_channel_id
    WHERE (tc.last_crawled_at IS NULL
           OR tc.last_crawled_at < DATE_SUB(NOW(), INTERVAL ? DAY))
      ${sourceFilter}
    ORDER BY tc.last_crawled_at IS NULL DESC, tc.last_crawled_at ASC
  `, params);

  return rows;
}

export { linkCompetitor, unlinkCompetitor, listCompetitors, listAllLinks, listCrawlCandidates };
// niche-finder/launches.js
// CRUD des projets de lancement de chaîne (module Lancements).
// Un lancement = une chaîne modèle (seed) + concurrents + ajouts libres,
// des vagues de picks proposés par l'IA, et des bilans de la chaîne lancée.
// Les métadonnées vidéo restent dans target_videos/transcripts — jamais dupliquées ici.

import { pool } from './db.js';

// Crée un lancement et compose son groupe en une transaction.
// competitorIds : concurrents retenus (rôle 'competitor').
// extraIds : chaînes hors groupes existants (rôle 'extra'), channelId déjà résolus.
async function createLaunch({ name, seedChannelId, competitorIds = [], extraIds = [] }) {
  if (!name?.trim()) throw new Error('Nom du lancement requis.');
  if (!seedChannelId?.trim()) throw new Error('Chaîne modèle (seed) requise.');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [r] = await conn.query(
      'INSERT INTO launches (name, seed_channel_id) VALUES (?, ?)',
      [name.trim(), seedChannelId.trim()]
    );
    const launchId = r.insertId;

    // Groupe : seed + concurrents + extras, dédoublonnés (le seed prime).
    const rows = [[launchId, seedChannelId.trim(), 'seed']];
    const seen = new Set([seedChannelId.trim()]);
    for (const id of competitorIds.map(s => String(s).trim()).filter(Boolean)) {
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push([launchId, id, 'competitor']);
    }
    for (const id of extraIds.map(s => String(s).trim()).filter(Boolean)) {
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push([launchId, id, 'extra']);
    }

    await conn.query(
      'INSERT INTO launch_channels (launch_id, channel_id, role) VALUES ?',
      [rows]
    );

    await conn.commit();
    return { launchId, name: name.trim(), channels: rows.length };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Liste des lancements pour la page d'accueil du module.
async function listLaunches() {
  const [rows] = await pool.query(`
    SELECT
      l.id, l.name, l.status, l.own_channel_id, l.created_at,
      tc.channel_title AS seed_title,
      (SELECT COUNT(*) FROM launch_channels WHERE launch_id = l.id) AS channel_count,
      (SELECT COUNT(*) FROM launch_picks WHERE launch_id = l.id) AS pick_count,
      (SELECT COUNT(*) FROM launch_picks WHERE launch_id = l.id AND status = 'done') AS done_count,
      (SELECT MAX(batch) FROM launch_picks WHERE launch_id = l.id) AS last_batch
    FROM launches l
    LEFT JOIN target_channels tc ON tc.channel_id = l.seed_channel_id
    ORDER BY l.created_at DESC
  `);
  return rows;
}

// Détail complet d'un lancement : groupe, picks par vague, bilans.
async function getLaunch(id) {
  const [[launch]] = await pool.query('SELECT * FROM launches WHERE id = ?', [id]);
  if (!launch) throw new Error('Lancement introuvable.');

  // Le groupe, enrichi des infos de crawl si disponibles.
  const [channels] = await pool.query(`
    SELECT
      lc.channel_id, lc.role,
      tc.channel_title, tc.handle, tc.subscribers, tc.video_count, tc.last_crawled_at,
      (SELECT COUNT(*) FROM target_videos WHERE channel_id = lc.channel_id) AS crawled_videos
    FROM launch_channels lc
    LEFT JOIN target_channels tc ON tc.channel_id = lc.channel_id
    WHERE lc.launch_id = ?
    ORDER BY FIELD(lc.role, 'seed', 'competitor', 'extra'), tc.channel_title
  `, [id]);

  // Les picks, avec les métadonnées vidéo, l'état de transcription
  // et le script le plus récent s'il existe.
  const [picks] = await pool.query(`
    SELECT
      p.id, p.batch, p.video_id, p.channel_id, p.rank_position,
      p.reason, p.angle, p.status, p.publish_order,
      v.title, v.thumbnail, v.duration_seconds, v.published_at,
      tc.channel_title,
      (t.video_id IS NOT NULL) AS has_transcript,
      ls.id         AS script_id,
      ls.status     AS script_status,
      ls.word_count AS script_words,
      ls.created_at AS script_created_at
    FROM launch_picks p
    LEFT JOIN target_videos v ON v.video_id = p.video_id
    LEFT JOIN target_channels tc ON tc.channel_id = p.channel_id
    LEFT JOIN transcripts t ON t.video_id = p.video_id
    LEFT JOIN scripts ls ON ls.id = (
      SELECT id FROM scripts
      WHERE pick_id = p.id
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    )
    WHERE p.launch_id = ?
    ORDER BY p.batch, p.rank_position
  `, [id]);

  // Les bilans, du plus récent au plus ancien.
  const [reports] = await pool.query(`
    SELECT id, kind, content, created_at
    FROM launch_reports
    WHERE launch_id = ?
    ORDER BY created_at DESC
  `, [id]);

  return { launch, channels, picks, reports };
}

// Modifie un lancement — liste blanche de champs autorisés.
async function updateLaunch(id, fields = {}) {
  const allowed = ['name', 'notes', 'own_channel_id', 'status', 'target_language'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(fields[k] === '' ? null : fields[k]);
    }
  }
  if (!sets.length) throw new Error('Aucun champ à modifier.');

  vals.push(id);
  const [r] = await pool.query(`UPDATE launches SET ${sets.join(', ')} WHERE id = ?`, vals);
  if (!r.affectedRows) throw new Error('Lancement introuvable.');
  return { id: Number(id), updated: sets.length };
}

// Ajoute une chaîne au groupe d'un lancement existant.
async function addLaunchChannel(launchId, channelId, role = 'competitor') {
  if (!['competitor', 'extra'].includes(role)) throw new Error('Rôle invalide.');
  await pool.query(
    `INSERT INTO launch_channels (launch_id, channel_id, role) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE role = VALUES(role)`,
    [launchId, String(channelId).trim(), role]
  );
  return { launchId: Number(launchId), channelId: String(channelId).trim(), role };
}

// Retire une chaîne du groupe (jamais le seed).
async function removeLaunchChannel(launchId, channelId) {
  const [r] = await pool.query(
    `DELETE FROM launch_channels WHERE launch_id = ? AND channel_id = ? AND role != 'seed'`,
    [launchId, String(channelId).trim()]
  );
  if (!r.affectedRows) throw new Error('Chaîne introuvable dans ce lancement (ou seed non retirable).');
  return { removed: String(channelId).trim() };
}

// Change le statut d'un pick (proposed / kept / rejected / done).
// C'est l'interrupteur central du suivi de production : l'IA propose,
// toi tu décides (kept), tu écartes (rejected) ou tu marques publié (done).
// Ces statuts nourrissent les vagues suivantes : done = ligne éditoriale
// établie, rejected = directions à ne pas reproposer.
async function updatePickStatus(pickId, status) {
  const allowed = ['proposed', 'kept', 'rejected', 'done'];
  if (!allowed.includes(status)) throw new Error(`Statut invalide : ${status}`);

  const [r] = await pool.query(
    'UPDATE launch_picks SET status = ? WHERE id = ?',
    [status, pickId]
  );
  if (!r.affectedRows) throw new Error('Pick introuvable.');
  return { pickId: Number(pickId), status };
}

// Réordonne la file de production d'un lancement (après glisser-déposer).
// pickIds : tableau d'ids dans l'ordre voulu. Les picks absents de la liste
// sortent de la file (publish_order remis à NULL).
async function reorderPicks(launchId, pickIds = []) {
  const ids = pickIds.map(Number).filter(Number.isFinite);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Tout sortir de la file, puis replacer ceux qui y sont.
    await conn.query(
      'UPDATE launch_picks SET publish_order = NULL WHERE launch_id = ?',
      [Number(launchId)]
    );

    for (let i = 0; i < ids.length; i++) {
      await conn.query(
        'UPDATE launch_picks SET publish_order = ? WHERE id = ? AND launch_id = ?',
        [i, ids[i], Number(launchId)]
      );
    }

    await conn.commit();
    return { launchId: Number(launchId), ordered: ids.length };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Supprime un lancement (picks, groupe et bilans via CASCADE).
async function deleteLaunch(id) {
  const [r] = await pool.query('DELETE FROM launches WHERE id = ?', [id]);
  if (!r.affectedRows) throw new Error('Lancement introuvable.');
  return { deleted: Number(id) };
}

export { createLaunch, listLaunches, getLaunch, updateLaunch,
         addLaunchChannel, removeLaunchChannel, deleteLaunch,
         updatePickStatus, reorderPicks };
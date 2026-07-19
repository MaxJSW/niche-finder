// niche-finder/themes.js
// Groupement thématique : themes + theme_items (liaison polymorphe).
// item_type : 'channel' (watchlist), 'target' (crawlée), 'query' (titre).
// Lecture/écriture en base uniquement — aucun appel API, gratuit.

import { pool } from './db.js';

// --- Thèmes ---

async function listThemes() {
  const [rows] = await pool.query(
    `SELECT t.id, t.name, t.color, t.position, t.created_at,
            COUNT(ti.id) AS item_count
     FROM themes t
     LEFT JOIN theme_items ti ON ti.theme_id = t.id
     GROUP BY t.id
     ORDER BY t.position ASC, t.id ASC`
  );
  return rows.map(r => ({
    id: r.id, name: r.name, color: r.color,
    position: r.position, createdAt: r.created_at,
    itemCount: Number(r.item_count),
  }));
}

async function createTheme({ name, color = null }) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Nom de thème requis.');

  const [[max]] = await pool.query('SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM themes');
  const [res] = await pool.query(
    `INSERT INTO themes (name, color, position) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
    [clean, color, max.pos]
  );
  return { id: res.insertId, name: clean, color };
}

async function updateTheme(id, { name, color, position }) {
  const sets = [], params = [];
  if (name !== undefined)     { sets.push('name = ?');     params.push(String(name).trim()); }
  if (color !== undefined)    { sets.push('color = ?');    params.push(color); }
  if (position !== undefined) { sets.push('position = ?'); params.push(Number(position)); }
  if (!sets.length) return { updated: 0 };

  params.push(Number(id));
  const [res] = await pool.query(`UPDATE themes SET ${sets.join(', ')} WHERE id = ?`, params);
  return { updated: res.affectedRows };
}

async function deleteTheme(id) {
  // CASCADE supprime les theme_items associés.
  const [res] = await pool.query('DELETE FROM themes WHERE id = ?', [Number(id)]);
  return { deleted: res.affectedRows };
}

// --- Éléments ---

const TYPES = ['channel', 'target', 'query'];

// Une chaîne peut exister dans channels ET target_channels sous le même id.
// Ranger l'une range l'autre : l'UI les présente comme une seule carte.
async function siblingTypes(itemType, itemId) {
  if (itemType === 'query') return ['query'];
  const out = [];
  const [[c]] = await pool.query(
    'SELECT 1 AS ok FROM channels WHERE channel_id = ?', [String(itemId)]
  );
  const [[t]] = await pool.query(
    'SELECT 1 AS ok FROM target_channels WHERE channel_id = ?', [String(itemId)]
  );
  if (c) out.push('channel');
  if (t) out.push('target');
  return out.length ? out : [itemType];
}

async function addItem({ themeId, itemType, itemId, position = 0 }) {
  if (!TYPES.includes(itemType)) throw new Error(`item_type invalide : ${itemType}`);

  const types = await siblingTypes(itemType, itemId);
  for (const t of types) {
    await pool.query(
      `INSERT INTO theme_items (theme_id, item_type, item_id, position)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE position = VALUES(position)`,
      [Number(themeId), t, String(itemId), Number(position)]
    );
  }
  return { added: true, types };
}

async function removeItem({ themeId, itemType, itemId }) {
  const types = await siblingTypes(itemType, itemId);
  const [res] = await pool.query(
    `DELETE FROM theme_items
     WHERE theme_id = ? AND item_id = ? AND item_type IN (?)`,
    [Number(themeId), String(itemId), types]
  );
  return { removed: res.affectedRows };
}

// Déplace un élément d'un thème à un autre (drag and drop entre colonnes).
async function moveItem({ fromThemeId, toThemeId, itemType, itemId, position = 0 }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const types = await siblingTypes(itemType, itemId);
    await conn.query(
      `DELETE FROM theme_items
       WHERE theme_id = ? AND item_id = ? AND item_type IN (?)`,
      [Number(fromThemeId), String(itemId), types]
    );
    for (const t of types) {
      await conn.query(
        `INSERT INTO theme_items (theme_id, item_type, item_id, position)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE position = VALUES(position)`,
        [Number(toThemeId), t, String(itemId), Number(position)]
      );
    }
    await conn.commit();
    return { moved: true };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Réordonne les éléments d'un thème (après un glisser-déposer interne).
async function reorderItems(themeId, orderedItems) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (let i = 0; i < orderedItems.length; i++) {
      const it = orderedItems[i];
      await conn.query(
        'UPDATE theme_items SET position = ? WHERE theme_id = ? AND item_type = ? AND item_id = ?',
        [i, Number(themeId), it.itemType, String(it.itemId)]
      );
    }
    await conn.commit();
    return { reordered: orderedItems.length };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export {
  listThemes, createTheme, updateTheme, deleteTheme,
  addItem, removeItem, moveItem, reorderItems,
};
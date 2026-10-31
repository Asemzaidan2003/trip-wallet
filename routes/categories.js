const express = require('express');
const { HttpError, parseId, parseText, bodyOf } = require('../lib/validate');

// Two levels only: top-level categories and their sub-categories.
module.exports = (pool) => {
  const router = express.Router();

  const duplicateAs409 = (err) => {
    if (err.code === '23505') throw new HttpError(409, 'A category with this name already exists here', 'name_taken');
    throw err;
  };

  router.get('/', async (req, res) => {
    const { rows } = await pool.query('SELECT id, parent_id, name FROM categories ORDER BY lower(name)');
    const tree = rows.filter((c) => !c.parent_id).map((c) => ({ id: c.id, name: c.name, children: [] }));
    const byId = new Map(tree.map((c) => [c.id, c]));
    for (const c of rows) if (c.parent_id) byId.get(c.parent_id).children.push({ id: c.id, name: c.name });
    res.json(tree);
  });

  router.post('/', async (req, res) => {
    const body = bodyOf(req);
    const name = parseText(body.name, 'name', 50);
    let parentId = null;
    if (body.parentId !== undefined && body.parentId !== null && body.parentId !== '') {
      parentId = parseId(body.parentId, 'parentId');
      const { rows } = await pool.query('SELECT parent_id FROM categories WHERE id = $1', [parentId]);
      if (!rows.length) throw new HttpError(400, 'parentId does not exist', 'invalid_parentId');
      if (rows[0].parent_id) throw new HttpError(400, 'Sub-categories cannot have their own sub-categories', 'too_deep');
    }
    const { rows } = await pool
      .query('INSERT INTO categories (parent_id, name) VALUES ($1, $2) RETURNING id, parent_id AS "parentId", name', [parentId, name])
      .catch(duplicateAs409);
    res.status(201).json(rows[0]);
  });

  router.patch('/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const name = parseText(bodyOf(req).name, 'name', 50);
    const { rows } = await pool
      .query('UPDATE categories SET name = $2 WHERE id = $1 RETURNING id, parent_id AS "parentId", name', [id, name])
      .catch(duplicateAs409);
    if (!rows.length) throw new HttpError(404, 'Category not found', 'not_found');
    res.json(rows[0]);
  });

  // ponytail: in-use categories can't be deleted; add "move expenses to another category" if that gets annoying.
  router.delete('/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const { rowCount } = await pool.query('DELETE FROM categories WHERE id = $1', [id]).catch((err) => {
      if (err.code === '23503') throw new HttpError(409, 'Category (or one of its sub-categories) is used by expenses', 'category_in_use');
      throw err;
    });
    if (!rowCount) throw new HttpError(404, 'Category not found', 'not_found');
    res.sendStatus(204);
  });

  return router;
};

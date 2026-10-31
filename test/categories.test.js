const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useTestServer } = require('./helpers');

const t = useTestServer();
const tree = async () => (await t.call('GET', '/api/categories')).body;

test('categories are listed as a sorted two-level tree', async () => {
  const food = (await t.category('food')).body;
  await t.category('Transport');
  await t.category('Lunch', food.id);
  await t.category('breakfast', food.id);
  assert.deepEqual(await tree(), [
    { id: 1, name: 'food', children: [{ id: 4, name: 'breakfast' }, { id: 3, name: 'Lunch' }] },
    { id: 2, name: 'Transport', children: [] },
  ]);
});

test('sub-categories cannot be nested deeper', async () => {
  const food = (await t.category('Food')).body;
  const lunch = (await t.category('Lunch', food.id)).body;
  assert.equal(lunch.parentId, food.id);
  assert.equal((await t.category('Starter', lunch.id)).status, 400);
  assert.equal((await t.category('Orphan', 999)).status, 400);
});

test('names are unique per level, ignoring case', async () => {
  const food = (await t.category('Food')).body;
  const transport = (await t.category('Transport')).body;
  assert.equal((await t.category('FOOD')).status, 409);
  assert.equal((await t.category('Other', food.id)).status, 201);
  assert.equal((await t.category('Other', transport.id)).status, 201);
  assert.equal((await t.category('Other')).status, 201);
  assert.equal((await t.category('other', food.id)).status, 409);
});

test('categories can be renamed', async () => {
  const food = (await t.category('Food')).body;
  await t.category('Drinks');
  const res = await t.call('PATCH', `/api/categories/${food.id}`, { name: '  Meals ' });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Meals');
  assert.equal((await t.call('PATCH', `/api/categories/${food.id}`, { name: 'drinks' })).status, 409);
  assert.equal((await t.call('PATCH', `/api/categories/${food.id}`, { name: '' })).status, 400);
  assert.equal((await t.call('PATCH', `/api/categories/${food.id}`, { name: 'x'.repeat(51) })).status, 400);
  assert.equal((await t.call('PATCH', '/api/categories/999', { name: 'X' })).status, 404);
});

test('deleting an unused category removes its sub-categories', async () => {
  const food = (await t.category('Food')).body;
  await t.category('Lunch', food.id);
  assert.equal((await t.call('DELETE', `/api/categories/${food.id}`)).status, 204);
  assert.deepEqual(await tree(), []);
  assert.equal((await t.call('DELETE', `/api/categories/${food.id}`)).status, 404);
});

test('a category in use (directly or through a sub-category) cannot be deleted', async () => {
  const food = (await t.category('Food')).body;
  const lunch = (await t.category('Lunch', food.id)).body;
  await t.expense({ categoryId: lunch.id });
  for (const id of [food.id, lunch.id]) {
    const res = await t.call('DELETE', `/api/categories/${id}`);
    assert.equal(res.status, 409);
    assert.match(res.body.error, /used by expenses/);
  }
});

test('expenses carry their category and parent names', async () => {
  const food = (await t.category('Food')).body;
  const lunch = (await t.category('Lunch', food.id)).body;
  const sub = (await t.expense({ categoryId: lunch.id })).body;
  assert.deepEqual([sub.categoryId, sub.categoryName, sub.parentCategoryName], [lunch.id, 'Lunch', 'Food']);
  const top = (await t.expense({ categoryId: String(food.id) })).body;
  assert.deepEqual([top.categoryName, top.parentCategoryName], ['Food', null]);
});

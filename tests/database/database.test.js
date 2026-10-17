const mockDatabaseName = `jwt_pizza_test_${process.pid}`;

jest.mock('../../src/config.js', () => {
  const config = jest.requireActual('../../src/config.js');
  return {
    ...config,
    db: {
      ...config.db,
      connection: { ...config.db.connection, database: mockDatabaseName },
    },
  };
});

const mysql = require('mysql2/promise');
const config = require('../../src/config.js');
const { DB, Role } = require('../../src/database/database.js');

let connection;

async function execute(sql, params) {
  const result = await connection.execute(sql, params);
  return result[0];
}

async function clearTables() {
  await connection.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const table of ['auth', 'orderItem', 'dinerOrder', 'userRole', 'store', 'franchise', 'menu', 'user']) {
    await connection.query(`TRUNCATE TABLE ${table}`);
  }
  await connection.query('SET FOREIGN_KEY_CHECKS = 1');
}

describe('database component', () => {
  beforeAll(async () => {
    await DB.initialized;
    connection = await mysql.createConnection(config.db.connection);
  });

  beforeEach(async () => {
    await clearTables();
  });

  afterAll(async () => {
    try {
      if (connection) await connection.end();
    } finally {
      await DB.dropDatabase();
    }
  });

  test('persists and retrieves menu items', async () => {
    const item = { title: 'Pepperoni', description: 'Spicy', image: 'pepperoni.png', price: 12.5 };

    const created = await DB.addMenuItem(item);
    const menu = await DB.getMenu();

    expect(created).toMatchObject({ ...item, id: expect.any(Number) });
    expect(menu).toEqual([expect.objectContaining({ ...item, id: created.id, price: 12.5 })]);
  });

  test('stores hashed passwords and returns roles without exposing the password', async () => {
    const user = await DB.addUser({
      name: 'Diner',
      email: 'diner-component@test.com',
      password: 'secret',
      roles: [{ role: Role.Diner }],
    });

    const storedPassword = await execute('SELECT password FROM user WHERE id=?', [user.id]);
    const retrieved = await DB.getUser(user.email, 'secret');

    expect(storedPassword[0].password).not.toBe('secret');
    expect(retrieved).toMatchObject({ id: user.id, name: 'Diner', email: user.email, password: undefined });
    expect(retrieved.roles).toEqual([{ role: Role.Diner, objectId: undefined }]);
    await expect(DB.getUser(user.email, 'wrong')).rejects.toMatchObject({ message: 'unknown user', statusCode: 404 });
  });

  test('assigns a franchisee role to the matching franchise', async () => {
    const franchise = await DB.createFranchise({ name: 'Pizza Pocket', admins: [] });
    const user = await DB.addUser({
      name: 'Franchise Admin',
      email: 'franchisee-component@test.com',
      password: 'secret',
      roles: [{ role: Role.Franchisee, object: franchise.name }],
    });

    const retrieved = await DB.getUser(user.email);

    expect(retrieved.roles).toEqual([{ role: Role.Franchisee, objectId: franchise.id }]);
  });

  test('updates user fields and allows the new password to log in', async () => {
    const user = await DB.addUser({
      name: 'Old Name',
      email: 'old-component@test.com',
      password: 'old-password',
      roles: [{ role: Role.Diner }],
    });

    const updated = await DB.updateUser(user.id, 'New Name', 'new-component@test.com', 'new-password');

    expect(updated).toMatchObject({ id: user.id, name: 'New Name', email: 'new-component@test.com' });
    await expect(DB.getUser('new-component@test.com', 'new-password')).resolves.toMatchObject({ id: user.id });
    await expect(DB.getUser('old-component@test.com', 'old-password')).rejects.toMatchObject({ statusCode: 404 });
  });

  test('tracks login tokens by their JWT signature', async () => {
    const user = await DB.addUser({
      name: 'Diner',
      email: 'token-component@test.com',
      password: 'secret',
      roles: [{ role: Role.Diner }],
    });
    const token = 'header.payload.signature';

    await DB.loginUser(user.id, token);
    await expect(DB.isLoggedIn(token)).resolves.toBe(true);
    await DB.logoutUser(token);
    await expect(DB.isLoggedIn(token)).resolves.toBe(false);
  });

  test('persists orders and their items, then retrieves them by page', async () => {
    const franchise = await DB.createFranchise({ name: 'Order Franchise', admins: [] });
    const store = await DB.createStore(franchise.id, { name: 'Downtown' });
    const menuItem = await DB.addMenuItem({ title: 'Veggie', description: 'Garden', image: 'veggie.png', price: 9.5 });
    const diner = await DB.addUser({
      name: 'Diner',
      email: 'order-component@test.com',
      password: 'secret',
      roles: [{ role: Role.Diner }],
    });
    const order = {
      franchiseId: franchise.id,
      storeId: store.id,
      items: [{ menuId: menuItem.id, description: 'Garden', price: 9.5 }],
    };

    const created = await DB.addDinerOrder(diner, order);
    const page = await DB.getOrders(diner, 1);

    expect(created).toMatchObject({ ...order, id: expect.any(Number) });
    expect(page).toMatchObject({ dinerId: diner.id, page: 1 });
    expect(page.orders).toHaveLength(1);
    expect(page.orders[0]).toMatchObject({ franchiseId: franchise.id, storeId: store.id });
    expect(page.orders[0].items).toEqual([expect.objectContaining({ menuId: menuItem.id, description: 'Garden', price: 9.5 })]);
  });

  test('creates franchises with administrators and exposes their stores', async () => {
    const admin = await DB.addUser({
      name: 'Admin',
      email: 'admin-component@test.com',
      password: 'secret',
      roles: [{ role: Role.Diner }],
    });

    const franchise = await DB.createFranchise({
      name: 'Franchise Component',
      admins: [{ email: admin.email }],
    });
    await DB.createStore(franchise.id, { name: 'Campus' });
    const loaded = await DB.getFranchise({ id: franchise.id, name: franchise.name });

    expect(franchise.admins).toEqual([{ email: admin.email, id: admin.id, name: admin.name }]);
    expect(loaded.admins).toEqual([{ id: admin.id, name: admin.name, email: admin.email }]);
    expect(loaded.stores).toEqual([expect.objectContaining({ name: 'Campus', totalRevenue: 0 })]);
  });

  test('lists franchises with filtering, pagination, and user-specific enrichment', async () => {
    const first = await DB.createFranchise({ name: 'Alpha Pizza', admins: [] });
    await DB.createFranchise({ name: 'Beta Pizza', admins: [] });
    await DB.createFranchise({ name: 'Other Restaurant', admins: [] });

    const [franchises, more] = await DB.getFranchises(null, 0, 1, '*Pizza*');

    expect(franchises).toHaveLength(1);
    expect(franchises[0]).toMatchObject({ id: first.id, name: 'Alpha Pizza', stores: [] });
    expect(more).toBe(true);
  });

  test('lists users with roles, filtering, and pagination', async () => {
    const alice = await DB.addUser({ name: 'Alice List', email: 'alice-list@test.com', password: 'secret', roles: [{ role: Role.Admin }] });
    const bob = await DB.addUser({ name: 'Bob List', email: 'bob-list@test.com', password: 'secret', roles: [{ role: Role.Diner }] });
    await DB.addUser({ name: 'Carol Other', email: 'carol-list@test.com', password: 'secret', roles: [{ role: Role.Diner }] });

    const [firstPage, more] = await DB.getUsers(1, 1, '*List*');
    expect(firstPage).toEqual([{ id: alice.id, name: 'Alice List', email: 'alice-list@test.com', roles: [{ role: Role.Admin }] }]);
    expect(more).toBe(true);

    const [secondPage, moreAfter] = await DB.getUsers(2, 1, '*List*');
    expect(secondPage).toMatchObject([{ id: bob.id, name: 'Bob List' }]);
    expect(moreAfter).toBe(false);
    expect(firstPage[0]).not.toHaveProperty('password');
  });

  describe('user list pagination', () => {
    let ids;

    beforeEach(async () => {
      ids = [];
      for (let i = 1; i <= 5; i++) {
        const user = await DB.addUser({ name: `Paged ${i}`, email: `paged-${i}@test.com`, password: 'secret', roles: [{ role: Role.Diner }] });
        ids.push(user.id);
      }
    });

    test('splits users across pages in id order and reports whether more remain', async () => {
      const [first, firstMore] = await DB.getUsers(1, 2, '*');
      const [second, secondMore] = await DB.getUsers(2, 2, '*');
      const [third, thirdMore] = await DB.getUsers(3, 2, '*');

      expect(first.map((u) => u.id)).toEqual([ids[0], ids[1]]);
      expect(firstMore).toBe(true);
      expect(second.map((u) => u.id)).toEqual([ids[2], ids[3]]);
      expect(secondMore).toBe(true);
      expect(third.map((u) => u.id)).toEqual([ids[4]]);
      expect(thirdMore).toBe(false);
    });

    test('reports no more users when the result count equals the limit', async () => {
      const [users, more] = await DB.getUsers(1, 5, '*');

      expect(users.map((u) => u.id)).toEqual(ids);
      expect(more).toBe(false);
    });

    test('returns an empty page past the end of the results', async () => {
      const [users, more] = await DB.getUsers(4, 2, '*');

      expect(users).toEqual([]);
      expect(more).toBe(false);
    });

    test('paginates within a name filter', async () => {
      const [users, more] = await DB.getUsers(2, 2, 'Paged*');

      expect(users.map((u) => u.id)).toEqual([ids[2], ids[3]]);
      expect(more).toBe(true);
    });

    test('uses page 1, limit 10, and no name filter by default', async () => {
      const [users, more] = await DB.getUsers();

      expect(users.map((u) => u.id)).toEqual(ids);
      expect(more).toBe(false);
    });

    test.each([
      ['non-numeric', 'abc', 'xyz'],
      ['zero', 0, 0],
      ['negative', -3, -2],
    ])('falls back to page 1 and limit 10 for %s page and limit', async (_label, page, limit) => {
      const [users, more] = await DB.getUsers(page, limit, '*');

      expect(users.map((u) => u.id)).toEqual(ids);
      expect(more).toBe(false);
    });

    test('accepts page and limit as query-string values', async () => {
      const [users, more] = await DB.getUsers('2', '2', '*');

      expect(users.map((u) => u.id)).toEqual([ids[2], ids[3]]);
      expect(more).toBe(true);
    });
  });

  describe('deleteUser', () => {
    async function addDiner(name, email) {
      return DB.addUser({ name, email, password: 'secret', roles: [{ role: Role.Diner }] });
    }

    test('removes the user so they can no longer be found or log in', async () => {
      const user = await addDiner('Delete Me', 'delete-me@test.com');

      await expect(DB.deleteUser(user.id)).resolves.toBeUndefined();

      expect(await execute('SELECT id FROM user WHERE id=?', [user.id])).toEqual([]);
      await expect(DB.getUser(user.email, 'secret')).rejects.toMatchObject({ statusCode: 404 });
    });

    test('removes the roles of the deleted user, including franchise roles', async () => {
      const user = await addDiner('Franchisee Delete', 'franchisee-delete@test.com');
      const franchise = await DB.createFranchise({ name: 'Delete Roles Franchise', admins: [{ email: user.email }] });

      await DB.deleteUser(user.id);

      expect(await execute('SELECT id FROM userRole WHERE userId=?', [user.id])).toEqual([]);
      expect(await execute('SELECT id FROM franchise WHERE id=?', [franchise.id])).toHaveLength(1);
    });

    test('removes the sessions of the deleted user', async () => {
      const user = await addDiner('Session Delete', 'session-delete@test.com');
      await DB.loginUser(user.id, 'header.payload.signature-delete');
      expect(await DB.isLoggedIn('header.payload.signature-delete')).toBe(true);

      await DB.deleteUser(user.id);

      expect(await DB.isLoggedIn('header.payload.signature-delete')).toBe(false);
      expect(await execute('SELECT token FROM auth WHERE userId=?', [user.id])).toEqual([]);
    });

    test('keeps the order history of the deleted user', async () => {
      const user = await addDiner('Order Delete', 'order-delete@test.com');
      await execute('INSERT INTO dinerOrder (dinerId, franchiseId, storeId, date) VALUES (?, 1, 1, NOW())', [user.id]);

      await DB.deleteUser(user.id);

      expect(await execute('SELECT id FROM dinerOrder WHERE dinerId=?', [user.id])).toHaveLength(1);
    });

    test('rejects with a 404 when the user does not exist', async () => {
      await expect(DB.deleteUser(99999)).rejects.toMatchObject({ message: 'unknown user', statusCode: 404 });
    });

    test('rejects with a 404 when the user was already deleted', async () => {
      const user = await addDiner('Twice Delete', 'twice-delete@test.com');
      await DB.deleteUser(user.id);

      await expect(DB.deleteUser(user.id)).rejects.toMatchObject({ statusCode: 404 });
    });

    test('refuses to delete the last admin', async () => {
      const admin = await DB.addUser({ name: 'Only Admin', email: 'only-admin@test.com', password: 'secret', roles: [{ role: Role.Admin }] });

      await expect(DB.deleteUser(admin.id)).rejects.toMatchObject({ message: 'unable to delete the last admin', statusCode: 403 });

      await expect(DB.getUser(admin.email, 'secret')).resolves.toMatchObject({ id: admin.id, roles: [{ role: Role.Admin }] });
    });

    test('keeps the last admin sessions when deletion is refused', async () => {
      const admin = await DB.addUser({ name: 'Session Admin', email: 'session-admin@test.com', password: 'secret', roles: [{ role: Role.Admin }] });
      await DB.loginUser(admin.id, 'header.payload.signature-admin');

      await expect(DB.deleteUser(admin.id)).rejects.toMatchObject({ statusCode: 403 });

      expect(await DB.isLoggedIn('header.payload.signature-admin')).toBe(true);
    });

    test('allows deleting an admin when another admin remains', async () => {
      const first = await DB.addUser({ name: 'First Admin', email: 'first-admin@test.com', password: 'secret', roles: [{ role: Role.Admin }] });
      const second = await DB.addUser({ name: 'Second Admin', email: 'second-admin@test.com', password: 'secret', roles: [{ role: Role.Admin }] });

      await expect(DB.deleteUser(first.id)).resolves.toBeUndefined();

      await expect(DB.getUser(second.email, 'secret')).resolves.toMatchObject({ id: second.id });
      await expect(DB.deleteUser(second.id)).rejects.toMatchObject({ statusCode: 403 });
    });

    test('allows deleting a non-admin when only one admin exists', async () => {
      await DB.addUser({ name: 'Lone Admin', email: 'lone-admin@test.com', password: 'secret', roles: [{ role: Role.Admin }] });
      const diner = await addDiner('Plain Diner', 'plain-diner@test.com');

      await expect(DB.deleteUser(diner.id)).resolves.toBeUndefined();
    });

    test('removes the user from the user list', async () => {
      const user = await addDiner('Listed Delete', 'listed-delete@test.com');
      await DB.deleteUser(user.id);

      const [users] = await DB.getUsers(1, 10, '*');

      expect(users.map((u) => u.id)).not.toContain(user.id);
    });
  });

  test('returns franchises assigned to a user', async () => {
    const admin = await DB.addUser({
      name: 'Franchisee',
      email: 'assigned-component@test.com',
      password: 'secret',
      roles: [{ role: Role.Diner }],
    });
    const franchise = await DB.createFranchise({ name: 'Assigned Franchise', admins: [{ email: admin.email }] });

    const franchises = await DB.getUserFranchises(admin.id);

    expect(franchises).toHaveLength(1);
    expect(franchises[0]).toMatchObject({ id: franchise.id, name: franchise.name });
    expect(franchises[0].admins).toEqual([expect.objectContaining({ id: admin.id, email: admin.email })]);
  });

  test('deletes a franchise and its dependent records in a transaction', async () => {
    const franchise = await DB.createFranchise({ name: 'Delete Franchise', admins: [] });
    await DB.createStore(franchise.id, { name: 'Delete Store' });

    await expect(DB.deleteFranchise(franchise.id)).resolves.toBeUndefined();
    const stores = await execute('SELECT * FROM store WHERE franchiseId=?', [franchise.id]);

    expect(stores).toEqual([]);
  });

  test('deletes a store only from the requested franchise', async () => {
    const first = await DB.createFranchise({ name: 'First Store Franchise', admins: [] });
    const second = await DB.createFranchise({ name: 'Second Store Franchise', admins: [] });
    const firstStore = await DB.createStore(first.id, { name: 'First Store' });
    const secondStore = await DB.createStore(second.id, { name: 'Second Store' });

    await DB.deleteStore(first.id, firstStore.id);

    const remaining = await execute('SELECT id FROM store WHERE id=?', [secondStore.id]);
    expect(remaining).toEqual([{ id: secondStore.id }]);
  });

  test('rejects an unknown ID lookup', async () => {
    await expect(DB.getID(connection, 'name', 'Missing Franchise', 'franchise')).rejects.toThrow('No ID found');
  });

  test('calculates offsets and extracts JWT signatures', () => {
    expect(DB.getOffset(3, 10)).toBe(20);
    expect(DB.getTokenSignature('header.payload.signature')).toBe('signature');
    expect(DB.getTokenSignature('not-a-jwt')).toBe('');
  });
});

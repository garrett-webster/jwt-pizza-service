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
    await connection.end();
    const adminConnection = await mysql.createConnection(config.db.connection);
    await adminConnection.query(`DROP DATABASE IF EXISTS ${mockDatabaseName}`);
    await adminConnection.end();
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

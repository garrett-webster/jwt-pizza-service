const request = require('supertest');

jest.mock('../../src/database/database.js', () => require('./mockDatabase'));

const app = require('../../src/service');
const { DB } = require('./mockDatabase');
const config = require('../../src/config.js');
const originalFetch = global.fetch;
let dinerToken;
let adminToken;

beforeAll(async () => {
    const diner = await request(app).post('/api/auth').send({ name: 'Diner', email: 'diner-order@test.com', password: 'diner' });
    dinerToken = diner.body.token;
    const { users } = require('./mockDatabase');
    await request(app).post('/api/auth').send({ name: 'Admin', email: 'admin-order@test.com', password: 'admin' });
    users.get('admin-order@test.com').roles = [{ role: 'admin' }];
    const loggedInAdmin = await request(app).put('/api/auth').send({ email: 'admin-order@test.com', password: 'admin' });
    adminToken = loggedInAdmin.body.token;
});

beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = undefined;
});

afterEach(() => {
    global.fetch = originalFetch;
});

test('gets the menu without authentication', async () => {
    const response = await request(app).get('/api/order/menu');
    expect(response.status).toBe(200);
    expect(response.body).toEqual([{ id: 1, title: 'Veggie', price: 0.05 }]);
    expect(DB.getMenu).toHaveBeenCalledTimes(1);
});

test('prevents diners from adding menu items', async () => {
    const diner = await request(app).put('/api/order/menu').set('Authorization', `Bearer ${dinerToken}`).send({ title: 'Nope' });
    expect(diner.status).toBe(403);
    expect(diner.body.message).toBe('unable to add menu item');
    expect(DB.addMenuItem).not.toHaveBeenCalled();
});

test('allows admins to add menu items', async () => {
    const item = { title: 'Pepperoni' };
    const admin = await request(app).put('/api/order/menu').set('Authorization', `Bearer ${adminToken}`).send(item);
    expect(admin.status).toBe(200);
    expect(DB.addMenuItem).toHaveBeenCalledWith(item);
    expect(DB.getMenu).toHaveBeenCalledTimes(1);
});

test('gets orders for the authenticated user', async () => {
    const response = await request(app).get('/api/order?page=2').set('Authorization', `Bearer ${dinerToken}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ dinerId: 1, page: '2' });
    expect(DB.getOrders).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), '2');
});

test('returns the factory result after creating an order', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ reportUrl: '/report/1', jwt: 'factory-jwt' }) });
    const orderRequest = { items: [] };
    const response = await request(app).post('/api/order').set('Authorization', `Bearer ${dinerToken}`).send(orderRequest);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ jwt: 'factory-jwt', followLinkToEndChaos: '/report/1' });
    expect(DB.addDinerOrder).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), orderRequest);
    expect(global.fetch).toHaveBeenCalledWith(`${config.factory.url}/api/order`, expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
    }));
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toMatchObject({
        diner: { id: 1, name: 'Diner', email: 'diner-order@test.com' },
        order: { items: [], id: 3, dinerId: 1 },
    });
});

test('reports a factory failure', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, json: async () => ({ reportUrl: '/report/2' }) });
    const response = await request(app).post('/api/order').set('Authorization', `Bearer ${dinerToken}`).send({ items: [] });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ message: 'Failed to fulfill order at factory', followLinkToEndChaos: '/report/2' });
    expect(DB.addDinerOrder).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), { items: [] });
});

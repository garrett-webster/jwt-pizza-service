const request = require('supertest');

jest.mock('../../src/database/database.js', () => require('./mockDatabase'));

const app = require('../../src/service');
let dinerToken;
let adminToken;

beforeAll(async () => {
    const diner = await request(app).post('/api/auth').send({ name: 'Diner', email: 'diner-order@test.com', password: 'diner' });
    dinerToken = diner.body.token;
    const { users } = require('./mockDatabase');
    users.get('admin-order@test.com').roles = [{ role: 'admin' }];
    const loggedInAdmin = await request(app).put('/api/auth').send({ email: 'admin-order@test.com', password: 'admin' });
    adminToken = loggedInAdmin.body.token;
});

test('gets the menu without authentication', async () => {
    const response = await request(app).get('/api/order/menu');
    expect(response.status).toBe(200);
    expect(response.body).toEqual([{ id: 1, title: 'Veggie', price: 0.05 }]);
});

test('prevents diners from adding menu items', async () => {
    const diner = await request(app).put('/api/order/menu').set('Authorization', `Bearer ${dinerToken}`).send({ title: 'Nope' });
    expect(diner.status).toBe(403);
    expect(diner.body.message).toBe('unable to add menu item');
});

test('allows admins to add menu items', async () => {
    const admin = await request(app).put('/api/order/menu').set('Authorization', `Bearer ${adminToken}`).send({ title: 'Pepperoni' });
    expect(admin.status).toBe(200);
});

test('gets orders for the authenticated user', async () => {
    const response = await request(app).get('/api/order?page=2').set('Authorization', `Bearer ${dinerToken}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ dinerId: 1, page: '2' });
});

test('returns the factory result after creating an order', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ reportUrl: '/report/1', jwt: 'factory-jwt' }) });
    const response = await request(app).post('/api/order').set('Authorization', `Bearer ${dinerToken}`).send({ items: [] });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ jwt: 'factory-jwt', followLinkToEndChaos: '/report/1' });
});

test('reports a factory failure', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, json: async () => ({ reportUrl: '/report/2' }) });
    const response = await request(app).post('/api/order').set('Authorization', `Bearer ${dinerToken}`).send({ items: [] });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ message: 'Failed to fulfill order at factory', followLinkToEndChaos: '/report/2' });
});

afterAll(() => delete global.fetch);

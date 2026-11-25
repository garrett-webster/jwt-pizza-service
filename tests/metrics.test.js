const request = require('supertest');

jest.mock('../src/database/database.js', () => require('./routes/mockDatabase'));

const app = require('../src/service');
const { buildMetrics } = require('../src/metrics.js');
const originalFetch = global.fetch;
let dinerToken;
let adminToken;

// Current value of the metric with this name whose attributes include attrs (0 if not reported)
function metricValue(name, attrs = {}) {
    const metric = buildMetrics().find((m) => {
        if (m.name !== name) return false;
        const point = (m.sum ?? m.gauge).dataPoints[0];
        return Object.entries(attrs).every(([key, value]) => point.attributes.some((a) => a.key === key && a.value.stringValue === value));
    });
    if (!metric) return 0;
    const point = (metric.sum ?? metric.gauge).dataPoints[0];
    return point.asInt ?? point.asDouble;
}

const order = () => request(app).post('/api/order').set('Authorization', `Bearer ${dinerToken}`).send({ items: [] });
const setChaos = (state) => request(app).put(`/api/order/chaos/${state}`).set('Authorization', `Bearer ${adminToken}`);

beforeAll(async () => {
    const diner = await request(app).post('/api/auth').send({ name: 'Diner', email: 'diner-metrics@test.com', password: 'diner' });
    dinerToken = diner.body.token;
    const { users } = require('./routes/mockDatabase');
    await request(app).post('/api/auth').send({ name: 'Admin', email: 'admin-metrics@test.com', password: 'admin' });
    users.get('admin-metrics@test.com').roles = [{ role: 'admin' }];
    adminToken = (await request(app).put('/api/auth').send({ email: 'admin-metrics@test.com', password: 'admin' })).body.token;
});

afterEach(async () => {
    jest.restoreAllMocks();
    global.fetch = originalFetch;
    await setChaos(false);
});

test('counts responses by method, route and status class', async () => {
    const before = metricValue('httpResponses', { method: 'GET', route: '/api/order/menu', status: '2xx' });
    await request(app).get('/api/order/menu');
    expect(metricValue('httpResponses', { method: 'GET', route: '/api/order/menu', status: '2xx' })).toBe(before + 1);
});

test('collapses numeric IDs in the route', async () => {
    await request(app).delete('/api/franchise/42');
    expect(metricValue('httpResponses', { method: 'DELETE', route: '/api/franchise/:id', status: '4xx' })).toBeGreaterThan(0);
});

test('groups unknown endpoints under one route', async () => {
    await request(app).get('/api/no/such/thing/123');
    expect(metricValue('httpResponses', { method: 'GET', route: 'unmatched', status: '4xx' })).toBeGreaterThan(0);
});

test('counts successful orders', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ reportUrl: '/r', jwt: 'j' }) });
    const before = metricValue('orders', { result: 'success' });
    expect((await order()).status).toBe(200);
    expect(metricValue('orders', { result: 'success' })).toBe(before + 1);
});

test('counts factory failures', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ reportUrl: '/r' }) });
    const before = metricValue('orders', { result: 'factory' });
    expect((await order()).status).toBe(500);
    expect(metricValue('orders', { result: 'factory' })).toBe(before + 1);
});

test('counts chaos failures and reports the chaos state', async () => {
    expect(metricValue('chaosEnabled')).toBe(0);
    await setChaos(true);
    expect(metricValue('chaosEnabled')).toBe(1);

    jest.spyOn(Math, 'random').mockReturnValue(0.1);
    const before = metricValue('orders', { result: 'chaos' });
    expect((await order()).status).toBe(500);
    expect(metricValue('orders', { result: 'chaos' })).toBe(before + 1);
    expect(metricValue('httpResponses', { method: 'POST', route: '/api/order', status: '5xx' })).toBeGreaterThan(0);
});

test('counts unexpected order errors and rejected orders', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('factory unreachable'));
    const errors = metricValue('orders', { result: 'error' });
    expect((await order()).status).toBe(500);
    expect(metricValue('orders', { result: 'error' })).toBe(errors + 1);

    const rejected = metricValue('orders', { result: 'rejected' });
    expect((await request(app).post('/api/order').send({ items: [] })).status).toBe(401);
    expect(metricValue('orders', { result: 'rejected' })).toBe(rejected + 1);
});

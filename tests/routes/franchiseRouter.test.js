const request = require('supertest');

jest.mock('../../src/database/database.js', () => require('./mockDatabase'));

const app = require('../../src/service');
const { DB, users } = require('./mockDatabase');
let dinerToken;
let adminToken;

beforeAll(async () => {
    const diner = await request(app).post('/api/auth').send({ name: 'Diner', email: 'diner-franchise@test.com', password: 'diner' });
    dinerToken = diner.body.token;
    await request(app).post('/api/auth').send({ name: 'Admin', email: 'admin-franchise@test.com', password: 'admin' });
    users.get('admin-franchise@test.com').roles = [{ role: 'admin' }];
    const admin = await request(app).put('/api/auth').send({ email: 'admin-franchise@test.com', password: 'admin' });
    adminToken = admin.body.token;
});

test('lists franchises publicly', async () => {
    const response = await request(app).get('/api/franchise?page=1&limit=5&name=Pocket');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ franchises: [{ id: 1, name: 'Pizza Pocket' }], more: false });
});

test('returns franchises for the authenticated user', async () => {
    const own = await request(app).get('/api/franchise/1').set('Authorization', `Bearer ${dinerToken}`);
    expect(own.body).toEqual([{ id: 1, adminId: 1 }]);
});

test('forbids a non-admin from requesting another user’s franchises', async () => {
    const other = await request(app).get('/api/franchise/2').set('Authorization', `Bearer ${dinerToken}`);
    expect(other.status).toBe(403);
    expect(other.body).toEqual({ message: 'unauthorized' });
});

test('allows an admin to request another user’s franchises', async () => {
    const admin = await request(app).get('/api/franchise/2').set('Authorization', `Bearer ${adminToken}`);
    expect(admin.status).toBe(200);
    expect(Array.isArray(admin.body)).toBe(true);
});

test('prevents diners from creating a franchise', async () => {
    const diner = await request(app).post('/api/franchise').set('Authorization', `Bearer ${dinerToken}`).send({ name: 'Nope' });
    expect(diner.status).toBe(403);
    expect(diner.body.message).toBe('unable to create a franchise');
});

test('allows admins to create a franchise', async () => {
    const admin = await request(app).post('/api/franchise').set('Authorization', `Bearer ${adminToken}`).send({ name: 'New' });
    expect(admin.status).toBe(200);
    expect(admin.body).toEqual({ name: 'New', id: 2 });
});

test('requires authentication to delete a franchise', async () => {
    const unauthorized = await request(app).delete('/api/franchise/7');
    expect(unauthorized.status).toBe(401);
});

test('allows an authenticated user to delete a franchise', async () => {
    const response = await request(app).delete('/api/franchise/7').set('Authorization', `Bearer ${adminToken}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: 'franchise deleted' });
});

test('allows an admin to create a store', async () => {
    const create = await request(app).post('/api/franchise/1/store').set('Authorization', `Bearer ${adminToken}`).send({ name: 'SLC' });
    expect(create.body).toMatchObject({ id: 4, name: 'SLC', franchiseId: 1 });
});

test('allows an admin to delete a store', async () => {
    const remove = await request(app).delete('/api/franchise/1/store/4').set('Authorization', `Bearer ${adminToken}`);
    expect(remove.body).toEqual({ message: 'store deleted' });
});

test('prevents an unauthorized diner from creating a store', async () => {
    DB.getFranchise.mockResolvedValueOnce(null);
    const create = await request(app).post('/api/franchise/1/store').set('Authorization', `Bearer ${dinerToken}`).send({ name: 'Nope' });
    expect(create.status).toBe(403);
    expect(create.body.message).toBe('unable to create a store');
});

test('prevents an unauthorized diner from deleting a store', async () => {
    const remove = await request(app).delete('/api/franchise/1/store/4').set('Authorization', `Bearer ${dinerToken}`);
    expect(remove.status).toBe(403);
    expect(remove.body.message).toBe('unable to delete a store');
});

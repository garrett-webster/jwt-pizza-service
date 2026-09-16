const request = require('supertest');

jest.mock('../../src/database/database.js', () => require('./mockDatabase'));

const app = require('../../src/service');
const { users } = require('./mockDatabase');

let dinerToken;
let adminToken;

beforeAll(async () => {
    const diner = await request(app).post('/api/auth').send({ name: 'Diner', email: 'diner-user@test.com', password: 'diner' });
    dinerToken = diner.body.token;
    await request(app).post('/api/auth').send({ name: 'Admin', email: 'admin-user@test.com', password: 'admin' });
    users.get('admin-user@test.com').roles = [{ role: 'admin' }];
    const admin = await request(app).put('/api/auth').send({ email: 'admin-user@test.com', password: 'admin' });
    adminToken = admin.body.token;
});

test('returns the authenticated user data from /me', async () => {
    const response = await request(app).get('/api/user/me').set('Authorization', `Bearer ${dinerToken}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
        email: 'diner-user@test.com',
        roles: [{ role: 'diner' }],
    });
});

test('requires authentication', async () => {
    expect((await request(app).get('/api/user/me')).status).toBe(401);
});

test('allows a user to update their own account', async () => {
    const response = await request(app).put('/api/user/1').set('Authorization', `Bearer ${dinerToken}`).send({ name: 'Updated' });
    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({ id: 1, name: 'Updated' });
    expect(response.body.token).toEqual(expect.any(String));
});

test('allows an admin to update another account', async () => {
    const response = await request(app).put('/api/user/99').set('Authorization', `Bearer ${adminToken}`).send({ name: 'Updated' });
    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({ id: 99, name: 'Updated' });
});

test('prevents a diner from updating another account', async () => {
    const response = await request(app).put('/api/user/99').set('Authorization', `Bearer ${dinerToken}`).send({ name: 'Nope' });
    expect(response.status).toBe(403);
    expect(response.body.message).toBe('unauthorized');
});

test('returns the user list placeholder', async () => {
    const list = await request(app).get('/api/user').set('Authorization', `Bearer ${dinerToken}`);
    expect(list.body).toEqual({ message: 'not implemented', users: [], more: false });
});

test('returns the delete user placeholder', async () => {
    const deleted = await request(app).delete('/api/user/99').set('Authorization', `Bearer ${dinerToken}`);
    expect(deleted.body).toEqual({ message: 'not implemented' });
});

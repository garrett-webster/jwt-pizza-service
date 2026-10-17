const request = require('supertest');

jest.mock('../../src/database/database.js', () => require('./mockDatabase'));

const app = require('../../src/service');
const { DB, users } = require('./mockDatabase');

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

beforeEach(() => jest.clearAllMocks());

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
    expect(DB.updateUser).toHaveBeenCalledWith(1, 'Updated', undefined, undefined);
});

test('allows an admin to update another account', async () => {
    const response = await request(app).put('/api/user/99').set('Authorization', `Bearer ${adminToken}`).send({ name: 'Updated' });
    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({ id: 99, name: 'Updated' });
    expect(DB.updateUser).toHaveBeenCalledWith(99, 'Updated', undefined, undefined);
});

test('prevents a diner from updating another account', async () => {
    const response = await request(app).put('/api/user/99').set('Authorization', `Bearer ${dinerToken}`).send({ name: 'Nope' });
    expect(response.status).toBe(403);
    expect(response.body.message).toBe('unauthorized');
    expect(DB.updateUser).not.toHaveBeenCalled();
});

describe('delete user', () => {
    test('requires authentication', async () => {
        const response = await request(app).delete('/api/user/1');
        expect(response.status).toBe(401);
        expect(response.body.message).toBe('unauthorized');
        expect(DB.deleteUser).not.toHaveBeenCalled();
    });

    test('allows a user to delete their own account', async () => {
        const response = await request(app).delete('/api/user/1').set('Authorization', `Bearer ${dinerToken}`);
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ message: 'user deleted' });
        expect(DB.deleteUser).toHaveBeenCalledWith(1);
    });

    test('allows an admin to delete another account', async () => {
        const response = await request(app).delete('/api/user/99').set('Authorization', `Bearer ${adminToken}`);
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ message: 'user deleted' });
        expect(DB.deleteUser).toHaveBeenCalledWith(99);
    });

    test('prevents a diner from deleting another account', async () => {
        const response = await request(app).delete('/api/user/99').set('Authorization', `Bearer ${dinerToken}`);
        expect(response.status).toBe(403);
        expect(response.body.message).toBe('unauthorized');
        expect(DB.deleteUser).not.toHaveBeenCalled();
    });

    test('returns 404 when the user does not exist', async () => {
        DB.deleteUser.mockRejectedValueOnce(Object.assign(new Error('unknown user'), { statusCode: 404 }));
        const response = await request(app).delete('/api/user/12345').set('Authorization', `Bearer ${adminToken}`);
        expect(response.status).toBe(404);
        expect(response.body.message).toBe('unknown user');
    });

    test('returns 403 when the user is the last admin', async () => {
        DB.deleteUser.mockRejectedValueOnce(Object.assign(new Error('unable to delete the last admin'), { statusCode: 403 }));
        const response = await request(app).delete('/api/user/2').set('Authorization', `Bearer ${adminToken}`);
        expect(response.status).toBe(403);
        expect(response.body.message).toBe('unable to delete the last admin');
    });

    test('rejects a non-numeric user id', async () => {
        const response = await request(app).delete('/api/user/abc').set('Authorization', `Bearer ${adminToken}`);
        expect(response.status).toBe(400);
        expect(DB.deleteUser).not.toHaveBeenCalled();
    });
});

test('list users returns the users for an admin', async () => {
    const listUsersRes = await request(app).get('/api/user?page=2&limit=5&name=Di*').set('Authorization', `Bearer ${adminToken}`);
    expect(listUsersRes.status).toBe(200);
    expect(listUsersRes.body).toEqual({
        users: [{ id: 1, name: 'Diner', email: 'diner-user@test.com', roles: [{ role: 'diner' }] }],
        more: false,
    });
    expect(DB.getUsers).toHaveBeenCalledWith('2', '5', 'Di*');
});

test('list users forbids a non-admin', async () => {
    const listUsersRes = await request(app).get('/api/user').set('Authorization', `Bearer ${dinerToken}`);
    expect(listUsersRes.status).toBe(403);
    expect(listUsersRes.body.message).toBe('unauthorized');
    expect(DB.getUsers).not.toHaveBeenCalled();
});

test('list users fails without authentication', async () => {
    const listUsersRes = await request(app).get('/api/user');
    expect(listUsersRes.status).toBe(401);
    expect(listUsersRes.body.message).toBe('unauthorized');
    expect(DB.getUsers).not.toHaveBeenCalled();
});

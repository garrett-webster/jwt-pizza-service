const request = require('supertest');
const app = require('../../src/service');
const { setAuthUser } = require('../../src/routes/authRouter.js');

const testUser = { name: 'pizza diner', email: 'reg@test.com', password: 'a' };
let testUserAuthToken;

beforeAll(async () => {
    testUser.email = Math.random().toString(36).substring(2, 12) + '@test.com';
    const registerRes = await request(app).post('/api/auth').send(testUser);
    testUserAuthToken = registerRes.body.token;
    expectValidJwt(testUserAuthToken);
});

test('logs in a registered user', async () => {
    const loginRes = await request(app).put('/api/auth').send(testUser);
    expect(loginRes.status).toBe(200);
    expectValidJwt(loginRes.body.token);

    const expectedUser = { ...testUser, roles: [{ role: 'diner' }] };
    delete expectedUser.password;
    expect(loginRes.body.user).toMatchObject(expectedUser);
});

test.each([
    { email: testUser.email, password: testUser.password },
    { name: testUser.name, password: testUser.password },
    { name: testUser.name, email: testUser.email },
])('registration requires name, email, and password: %o', async (body) => {
    const registerRes = await request(app).post('/api/auth').send(body);

    expect(registerRes.status).toBe(400);
    expect(registerRes.body).toEqual({ message: 'name, email, and password are required' });
});

test('login rejects an unknown user', async () => {
    const loginRes = await request(app).put('/api/auth').send({
        email: `missing-${Date.now()}@test.com`,
        password: 'wrong',
    });

    expect(loginRes.status).toBe(404);
    expect(loginRes.body.message).toBe('unknown user');
});

test('rejects logout without an authentication token', async () => {
    const logoutRes = await request(app).delete('/api/auth');

    expect(logoutRes.status).toBe(401);
    expect(logoutRes.body).toEqual({ message: 'unauthorized' });
});

test('rejects a token that is not logged in', async () => {
    const logoutRes = await request(app).delete('/api/auth').set('Authorization', 'Bearer not-a-real-token');

    expect(logoutRes.status).toBe(401);
    expect(logoutRes.body).toEqual({ message: 'unauthorized' });
});

test('role helper identifies matching and non-matching roles', async () => {
    const req = { headers: { authorization: `Bearer ${testUserAuthToken}` } };
    const next = jest.fn();

    await setAuthUser(req, {}, next);

    expect(req.user.isRole('diner')).toBe(true);
    expect(req.user.isRole('admin')).toBe(false);
});

test('rejects a logged-in token with an invalid JWT signature', async () => {
    const invalidTokenParts = testUserAuthToken.split('.');
    invalidTokenParts[1] = 'invalid-payload';
    const invalidToken = invalidTokenParts.join('.');
    const loginRes = await request(app).delete('/api/auth').set('Authorization', `Bearer ${invalidToken}`);

    expect(loginRes.status).toBe(401);
    expect(loginRes.body).toEqual({ message: 'unauthorized' });
});

test('logs out a user and invalidates the token', async () => {
    const logoutRes = await request(app).delete('/api/auth').set('Authorization', `Bearer ${testUserAuthToken}`);
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body).toEqual({ message: 'logout successful' });

    const afterLogoutRes = await request(app).delete('/api/auth').set('Authorization', `Bearer ${testUserAuthToken}`);
    expect(afterLogoutRes.status).toBe(401);
    expect(afterLogoutRes.body).toEqual({ message: 'unauthorized' });
});

function expectValidJwt(potentialJwt) {
    expect(potentialJwt).toMatch(/^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/);
}

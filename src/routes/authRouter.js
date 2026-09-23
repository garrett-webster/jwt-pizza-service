const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config.js');
const { asyncHandler } = require('../endpointHelper.js');
const { DB, Role } = require('../database/database.js');

const docs = [
  { method: 'POST', path: '/api/auth', description: 'Register a new user', example: `curl -X POST localhost:3000/api/auth -d '{"name":"pizza diner", "email":"d@jwt.com", "password":"diner"}' -H 'Content-Type: application/json'`, response: { user: { id: 2, name: 'pizza diner', email: 'd@jwt.com', roles: [{ role: 'diner' }] }, token: 'tttttt' } },
  { method: 'PUT', path: '/api/auth', description: 'Login existing user', example: `curl -X PUT localhost:3000/api/auth -d '{"email":"a@jwt.com", "password":"admin"}' -H 'Content-Type: application/json'`, response: { user: { id: 1, name: '常用名字', email: 'a@jwt.com', roles: [{ role: 'admin' }] }, token: 'tttttt' } },
  { method: 'DELETE', path: '/api/auth', requiresAuth: true, description: 'Logout a user', example: `curl -X DELETE localhost:3000/api/auth -H 'Authorization: Bearer tttttt'`, response: { message: 'logout successful' } },
];

function createAuthRouter(database = DB, appConfig = config) {
  const authRouter = express.Router();
  authRouter.docs = docs;

  async function setAuthUser(req, res, next) {
    const token = readAuthToken(req);
    if (token) {
      try {
        if (await database.isLoggedIn(token)) {
          req.user = jwt.verify(token, appConfig.jwtSecret);
          req.user.isRole = (role) => !!req.user.roles.find((r) => r.role === role);
        }
      } catch {
        req.user = null;
      }
    }
    next();
  }

  authRouter.authenticateToken = (req, res, next) => {
    if (!req.user) return res.status(401).send({ message: 'unauthorized' });
    next();
  };

  authRouter.post('/', asyncHandler(async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: 'name, email, and password are required' });
    const user = await database.addUser({ name, email, password, roles: [{ role: Role.Diner }] });
    res.json({ user, token: await setAuth(user) });
  }));

  authRouter.put('/', asyncHandler(async (req, res) => {
    const user = await database.getUser(req.body.email, req.body.password);
    res.json({ user, token: await setAuth(user) });
  }));

  authRouter.delete('/', authRouter.authenticateToken, asyncHandler(async (req, res) => {
    await clearAuth(req);
    res.json({ message: 'logout successful' });
  }));

  async function setAuth(user) {
    const token = jwt.sign(user, appConfig.jwtSecret);
    await database.loginUser(user.id, token);
    return token;
  }

  async function clearAuth(req) {
    const token = readAuthToken(req);
    if (token) await database.logoutUser(token);
  }

  return { authRouter, setAuthUser, setAuth };
}

function readAuthToken(req) {
  const authHeader = req.headers.authorization;
  return authHeader ? authHeader.split(' ')[1] : null;
}

const defaultAuth = createAuthRouter();
module.exports = { ...defaultAuth, createAuthRouter };

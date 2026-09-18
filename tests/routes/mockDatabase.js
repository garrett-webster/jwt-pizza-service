const users = new Map();
const tokens = new Set();
let nextUserId = 1;

const DB = {
    addUser: jest.fn(async (user) => {
        const saved = { ...user, id: nextUserId++, password: undefined };
        users.set(saved.email, { ...saved, password: user.password });
        return saved;
    }),
    getUser: jest.fn(async (email, password) => {
        const saved = users.get(email);
        if (!saved || saved.password !== password) throw Object.assign(new Error('unknown user'), { statusCode: 404 });
        const user = { ...saved };
        delete user.password;
        return user;
    }),
    loginUser: jest.fn(async (userId, token) => tokens.add(token)),
    isLoggedIn: jest.fn(async (token) => tokens.has(token)),
    logoutUser: jest.fn(async (token) => tokens.delete(token)),
    updateUser: jest.fn(async (userId, name, email) => ({ id: userId, name, email, roles: [{ role: 'diner' }] })),
    getMenu: jest.fn(async () => [{ id: 1, title: 'Veggie', price: 0.05 }]),
    addMenuItem: jest.fn(async (item) => ({ ...item, id: 2 })),
    getOrders: jest.fn(async (user, page) => ({ dinerId: user.id, orders: [], page })),
    addDinerOrder: jest.fn(async (user, order) => ({ ...order, id: 3, dinerId: user.id })),
    getFranchises: jest.fn(async () => [[{ id: 1, name: 'Pizza Pocket' }], false]),
    getUserFranchises: jest.fn(async (userId) => [{ id: 1, adminId: userId }]),
    createFranchise: jest.fn(async (franchise) => ({ ...franchise, id: 2 })),
    deleteFranchise: jest.fn(async () => {}),
    getFranchise: jest.fn(async () => ({ id: 1, admins: [{ id: 2 }] })),
    createStore: jest.fn(async (franchiseId, store) => ({ ...store, franchiseId, id: 4, totalRevenue: 0 })),
    deleteStore: jest.fn(async () => {}),
};

module.exports = {
    DB,
    Role: { Diner: 'diner', Admin: 'admin', Franchisee: 'franchisee' },
    users,
};

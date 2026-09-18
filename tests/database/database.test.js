const mockHash = jest.fn();
const mockCompare = jest.fn();
const mockCreateConnection = jest.fn();

jest.mock('bcrypt', () => ({ hash: mockHash, compare: mockCompare }));
jest.mock('mysql2/promise', () => ({ createConnection: mockCreateConnection }));

mockCreateConnection.mockResolvedValue({
  execute: jest.fn().mockResolvedValue([[{ SCHEMA_NAME: 'jwtpizza' }], []]),
  query: jest.fn().mockResolvedValue([[], []]),
  end: jest.fn(),
});

const { DB, Role } = require('../../src/database/database.js');

const makeConnection = () => ({
  execute: jest.fn(),
  query: jest.fn(),
  end: jest.fn(),
  beginTransaction: jest.fn(),
  commit: jest.fn(),
  rollback: jest.fn(),
});

describe('database access', () => {
  let connection;

  beforeEach(() => {
    connection = makeConnection();
    DB.initialized = Promise.resolve();
    DB._getConnection = jest.fn().mockResolvedValue(connection);
    mockHash.mockReset();
    mockCompare.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('menu operations', () => {
    test('gets the menu and closes the connection', async () => {
      const menu = [{ id: 1, title: 'Veggie' }];
      connection.execute.mockResolvedValue([menu, []]);

      await expect(DB.getMenu()).resolves.toBe(menu);
      expect(connection.execute).toHaveBeenCalledWith('SELECT * FROM menu', undefined);
      expect(connection.end).toHaveBeenCalled();
    });

    test('adds a menu item using all item fields', async () => {
      connection.execute.mockResolvedValue([{ insertId: 9 }, []]);
      const item = { title: 'Pepperoni', description: 'Spicy', image: 'pepperoni.png', price: 12.5 };

      await expect(DB.addMenuItem(item)).resolves.toEqual({ ...item, id: 9 });
      expect(connection.execute).toHaveBeenCalledWith(
        'INSERT INTO menu (title, description, image, price) VALUES (?, ?, ?, ?)',
        ['Pepperoni', 'Spicy', 'pepperoni.png', 12.5],
      );
      expect(connection.end).toHaveBeenCalled();
    });
  });

  describe('user operations', () => {
    test('hashes a password and creates each user role', async () => {
      mockHash.mockResolvedValue('hashed-password');
      connection.execute
        .mockResolvedValueOnce([{ insertId: 4 }, []])
        .mockResolvedValueOnce([{}, []])
        .mockResolvedValueOnce([[{ id: 12 }], []])
        .mockResolvedValueOnce([{}, []]);
      const user = {
        name: 'Diner',
        email: 'diner@test.com',
        password: 'secret',
        roles: [{ role: Role.Diner }, { role: Role.Franchisee, object: 'Pizza Pocket' }],
      };

      await expect(DB.addUser(user)).resolves.toEqual({ ...user, id: 4, password: undefined });
      expect(mockHash).toHaveBeenCalledWith('secret', 10);
      expect(connection.execute).toHaveBeenNthCalledWith(1,
        'INSERT INTO user (name, email, password) VALUES (?, ?, ?)',
        ['Diner', 'diner@test.com', 'hashed-password'],
      );
      expect(connection.execute).toHaveBeenNthCalledWith(2,
        'INSERT INTO userRole (userId, role, objectId) VALUES (?, ?, ?)',
        [4, Role.Diner, 0],
      );
      expect(connection.execute).toHaveBeenNthCalledWith(3, 'SELECT id FROM franchise WHERE name=?', ['Pizza Pocket']);
      expect(connection.execute).toHaveBeenNthCalledWith(4,
        'INSERT INTO userRole (userId, role, objectId) VALUES (?, ?, ?)',
        [4, Role.Franchisee, 12],
      );
      expect(connection.end).toHaveBeenCalled();
    });

    test('returns a user with roles and hides the stored password', async () => {
      const storedUser = { id: 4, name: 'Diner', email: 'diner@test.com', password: 'hashed' };
      connection.execute
        .mockResolvedValueOnce([[storedUser], []])
        .mockResolvedValueOnce([[{ role: 'diner', objectId: 0 }, { role: 'franchisee', objectId: 7 }], []]);
      mockCompare.mockResolvedValue(true);

      await expect(DB.getUser('diner@test.com', 'secret')).resolves.toMatchObject({
        id: 4,
        email: 'diner@test.com',
        password: undefined,
        roles: [{ role: 'diner', objectId: undefined }, { role: 'franchisee', objectId: 7 }],
      });
      expect(mockCompare).toHaveBeenCalledWith('secret', 'hashed');
    });

    test.each([
      ['missing user', []],
      ['wrong password', [{ id: 4, password: 'hashed' }]],
    ])('rejects an %s with a 404 error', async (_reason, users) => {
      connection.execute.mockResolvedValueOnce([users, []]);
      mockCompare.mockResolvedValue(false);

      await expect(DB.getUser('unknown@test.com', 'secret')).rejects.toMatchObject({ message: 'unknown user', statusCode: 404 });
      expect(connection.end).toHaveBeenCalled();
    });

    test('updates selected fields and reloads the user', async () => {
      mockHash.mockResolvedValue('new-hash');
      connection.execute.mockResolvedValue([{}, []]);
      const refreshedUser = { id: 4, email: 'new@test.com' };
      const getUser = jest.spyOn(DB, 'getUser').mockResolvedValue(refreshedUser);

      await expect(DB.updateUser(4, 'New Name', 'new@test.com', 'new-password')).resolves.toBe(refreshedUser);
      expect(connection.execute).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE user SET password=\'new-hash\', email=\'new@test.com\', name=\'New Name\' WHERE id=4'),
        undefined,
      );
      expect(getUser).toHaveBeenCalledWith('new@test.com', 'new-password');
    });

    test('does not issue an update when no fields are provided', async () => {
      const getUser = jest.spyOn(DB, 'getUser').mockResolvedValue({ id: 4 });

      await DB.updateUser(4);
      expect(connection.execute).not.toHaveBeenCalled();
      expect(getUser).toHaveBeenCalledWith(undefined, undefined);
    });
  });

  describe('authentication tokens', () => {
    test('stores and checks the token signature', async () => {
      connection.execute
        .mockResolvedValueOnce([{}, []])
        .mockResolvedValueOnce([[{ userId: 4 }], []]);
      const token = 'header.payload.signature';

      await DB.loginUser(4, token);
      await expect(DB.isLoggedIn(token)).resolves.toBe(true);
      expect(connection.execute).toHaveBeenNthCalledWith(1,
        'INSERT INTO auth (token, userId) VALUES (?, ?) ON DUPLICATE KEY UPDATE token=token',
        ['signature', 4],
      );
      expect(connection.execute).toHaveBeenNthCalledWith(2, 'SELECT userId FROM auth WHERE token=?', ['signature']);
    });

    test('reports absent tokens as logged out and deletes them', async () => {
      connection.execute.mockResolvedValue([[], []]);

      await expect(DB.isLoggedIn('not-a-jwt')).resolves.toBe(false);
      await DB.logoutUser('not-a-jwt');
      expect(connection.execute).toHaveBeenLastCalledWith('DELETE FROM auth WHERE token=?', ['']);
    });
  });

  describe('orders', () => {
    test('gets orders with paginated items', async () => {
      connection.execute
        .mockResolvedValueOnce([[{ id: 8, franchiseId: 2, storeId: 3, date: 'today' }], []])
        .mockResolvedValueOnce([[{ id: 11, menuId: 1, price: 10 }], []]);

      await expect(DB.getOrders({ id: 4 }, 2)).resolves.toEqual({
        dinerId: 4,
        page: 2,
        orders: [{ id: 8, franchiseId: 2, storeId: 3, date: 'today', items: [{ id: 11, menuId: 1, price: 10 }] }],
      });
      expect(connection.execute).toHaveBeenNthCalledWith(1,
        'SELECT id, franchiseId, storeId, date FROM dinerOrder WHERE dinerId=? LIMIT 10,10', [4]);
    });

    test('creates an order and resolves menu IDs for its items', async () => {
      connection.execute
        .mockResolvedValueOnce([{ insertId: 8 }, []])
        .mockResolvedValueOnce([[{ id: 3 }], []])
        .mockResolvedValueOnce([{}, []]);
      const order = { franchiseId: 2, storeId: 3, items: [{ menuId: 1, description: 'Large', price: 15 }] };

      await expect(DB.addDinerOrder({ id: 4 }, order)).resolves.toEqual({ ...order, id: 8 });
      expect(connection.execute).toHaveBeenNthCalledWith(3,
        'INSERT INTO orderItem (orderId, menuId, description, price) VALUES (?, ?, ?, ?)',
        [8, 3, 'Large', 15],
      );
    });
  });

  describe('franchises and stores', () => {
    test('rejects a franchise with an unknown administrator', async () => {
      connection.execute.mockResolvedValueOnce([[], []]);
      const franchise = { name: 'Pizza Pocket', admins: [{ email: 'missing@test.com' }] };

      await expect(DB.createFranchise(franchise)).rejects.toMatchObject({
        message: 'unknown user for franchise admin missing@test.com provided',
        statusCode: 404,
      });
      expect(connection.end).toHaveBeenCalled();
    });

    test('creates a franchise and assigns its administrators', async () => {
      connection.execute
        .mockResolvedValueOnce([[{ id: 4, name: 'Admin' }], []])
        .mockResolvedValueOnce([{ insertId: 9 }, []])
        .mockResolvedValueOnce([{}, []]);
      const franchise = { name: 'Pizza Pocket', admins: [{ email: 'admin@test.com' }] };

      await expect(DB.createFranchise(franchise)).resolves.toEqual({
        id: 9,
        name: 'Pizza Pocket',
        admins: [{ email: 'admin@test.com', id: 4, name: 'Admin' }],
      });
      expect(connection.execute).toHaveBeenLastCalledWith(
        'INSERT INTO userRole (userId, role, objectId) VALUES (?, ?, ?)',
        [4, Role.Franchisee, 9],
      );
    });

    test('rolls back all franchise deletes when one query fails', async () => {
      connection.execute.mockRejectedValue(new Error('database failure'));

      await expect(DB.deleteFranchise(9)).rejects.toMatchObject({ message: 'unable to delete franchise', statusCode: 500 });
      expect(connection.beginTransaction).toHaveBeenCalled();
      expect(connection.rollback).toHaveBeenCalled();
      expect(connection.commit).not.toHaveBeenCalled();
    });

    test('commits all franchise deletes as one transaction', async () => {
      connection.execute.mockResolvedValue([{}, []]);

      await expect(DB.deleteFranchise(9)).resolves.toBeUndefined();
      expect(connection.beginTransaction).toHaveBeenCalledTimes(1);
      expect(connection.execute).toHaveBeenNthCalledWith(1, 'DELETE FROM store WHERE franchiseId=?', [9]);
      expect(connection.execute).toHaveBeenNthCalledWith(2, 'DELETE FROM userRole WHERE objectId=?', [9]);
      expect(connection.execute).toHaveBeenNthCalledWith(3, 'DELETE FROM franchise WHERE id=?', [9]);
      expect(connection.commit).toHaveBeenCalledTimes(1);
      expect(connection.rollback).not.toHaveBeenCalled();
      expect(connection.end).toHaveBeenCalledTimes(1);
    });

    test('returns a limited franchise page and marks additional results', async () => {
      const franchises = [{ id: 1, name: 'One' }, { id: 2, name: 'Two' }, { id: 3, name: 'Three' }];
      connection.execute.mockResolvedValueOnce([franchises, []]);
      jest.spyOn(DB, 'getFranchise').mockResolvedValue(undefined);

      await expect(DB.getFranchises({ isRole: () => true }, 1, 2, '*Pizza*')).resolves.toEqual([[franchises[0], franchises[1]], true]);
      expect(connection.execute).toHaveBeenCalledWith(
        'SELECT id, name FROM franchise WHERE name LIKE ? LIMIT 3 OFFSET 2', ['%Pizza%']);
    });

    test('adds stores to public franchise results for non-admins', async () => {
      connection.execute
        .mockResolvedValueOnce([[{ id: 1, name: 'One' }], []])
        .mockResolvedValueOnce([[{ id: 3, name: 'Main' }], []]);

      await expect(DB.getFranchises(null)).resolves.toEqual([[{
        id: 1,
        name: 'One',
        stores: [{ id: 3, name: 'Main' }],
      }], false]);
    });

    test('loads a user’s franchises and delegates enrichment', async () => {
      connection.execute
        .mockResolvedValueOnce([[{ objectId: 9 }], []])
        .mockResolvedValueOnce([[{ id: 9, name: 'Pizza Pocket' }], []]);
      const franchise = { id: 9, name: 'Pizza Pocket' };
      const getFranchise = jest.spyOn(DB, 'getFranchise').mockResolvedValue(undefined);

      await expect(DB.getUserFranchises(4)).resolves.toEqual([franchise]);
      expect(connection.execute).toHaveBeenNthCalledWith(2,
        'SELECT id, name FROM franchise WHERE id in (9)', undefined);
      expect(getFranchise).toHaveBeenCalledWith(franchise);
    });

    test('returns no franchises when the user has no franchise roles', async () => {
      connection.execute.mockResolvedValueOnce([[], []]);

      await expect(DB.getUserFranchises(4)).resolves.toEqual([]);
      expect(connection.execute).toHaveBeenCalledTimes(1);
    });

    test('creates and deletes stores within the requested franchise', async () => {
      connection.execute
        .mockResolvedValueOnce([{ insertId: 6 }, []])
        .mockResolvedValueOnce([{}, []]);
      await expect(DB.createStore(9, { name: 'Downtown' })).resolves.toEqual({ id: 6, franchiseId: 9, name: 'Downtown' });

      await DB.deleteStore(9, 6);
      expect(connection.execute).toHaveBeenLastCalledWith('DELETE FROM store WHERE franchiseId=? AND id=?', [9, 6]);
    });

    test('loads franchise administrators and store revenue', async () => {
      connection.execute
        .mockResolvedValueOnce([[{ id: 4, name: 'Admin', email: 'admin@test.com' }], []])
        .mockResolvedValueOnce([[{ id: 6, name: 'Downtown', totalRevenue: 42 }], []]);
      const franchise = { id: 9, name: 'Pizza Pocket' };

      await expect(DB.getFranchise(franchise)).resolves.toEqual({
        ...franchise,
        admins: [{ id: 4, name: 'Admin', email: 'admin@test.com' }],
        stores: [{ id: 6, name: 'Downtown', totalRevenue: 42 }],
      });
    });
  });

  describe('helpers', () => {
    test('calculates offsets and extracts JWT signatures', () => {
      expect(DB.getOffset(3, 10)).toBe(20);
      expect(DB.getTokenSignature('header.payload.signature')).toBe('signature');
      expect(DB.getTokenSignature('not-a-jwt')).toBe('');
    });

    test('query returns the first result from execute', async () => {
      connection.execute.mockResolvedValue([[{ id: 1 }], ['metadata']]);

      await expect(DB.query(connection, 'SELECT 1', [1])).resolves.toEqual([{ id: 1 }]);
    });

    test('getID returns an ID or rejects when no row exists', async () => {
      connection.execute.mockResolvedValueOnce([[{ id: 7 }], []]);
      await expect(DB.getID(connection, 'name', 'Pizza Pocket', 'franchise')).resolves.toBe(7);

      connection.execute.mockResolvedValueOnce([[], []]);
      await expect(DB.getID(connection, 'name', 'Missing', 'franchise')).rejects.toThrow('No ID found');
    });
  });
});

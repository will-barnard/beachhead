const db = require('../db');
const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 12;

const Users = {
  async create({ username, password, role }) {
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const { rows } = await db.query(
      `INSERT INTO users (username, password_hash, role)
       VALUES ($1, $2, $3)
       RETURNING id, username, role, created_at`,
      [username, passwordHash, role || 'admin']
    );
    return rows[0];
  },

  async findByUsername(username) {
    const { rows } = await db.query('SELECT * FROM users WHERE username = $1', [username]);
    return rows[0] || null;
  },

  async findById(id) {
    const { rows } = await db.query(
      'SELECT id, username, role, created_at FROM users WHERE id = $1',
      [id]
    );
    return rows[0] || null;
  },

  async findAll() {
    const { rows } = await db.query(
      'SELECT id, username, role, created_at FROM users ORDER BY created_at ASC'
    );
    return rows;
  },

  async count() {
    const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM users');
    return rows[0].count;
  },

  async delete(id) {
    const { rows } = await db.query(
      'DELETE FROM users WHERE id = $1 RETURNING id, username, role',
      [id]
    );
    return rows[0] || null;
  },

  async verifyPassword(user, password) {
    return bcrypt.compare(password, user.password_hash);
  },
};

module.exports = Users;

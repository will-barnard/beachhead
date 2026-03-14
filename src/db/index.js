const { Pool } = require('pg');
const config = require('../config');
const logger = require('../logger');

const pool = new Pool({
  connectionString: config.db.connectionString,
  max: 10,
});

pool.on('error', (err) => {
  logger.error('Unexpected database pool error', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};

const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'construction_suite',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  // AGREGA ESTO AQUÍ ABAJO:
  ssl: process.env.DB_HOST ? { rejectUnauthorized: false } : false
});

module.exports = pool;
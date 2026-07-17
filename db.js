// niche-finder/db.js
// Pool de connexions MySQL, partagé par scan.js et server.js.

process.loadEnvFile(new URL('./.env', import.meta.url));

import dns from 'node:dns';
import mysql from 'mysql2/promise';

// VPS OVH : IPv6 sortant cassé -> IPv4 forcé (comme partout ailleurs).
dns.setDefaultResultOrder('ipv4first');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
  charset: 'utf8mb4',
});

export { pool };
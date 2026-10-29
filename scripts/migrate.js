/**
 * @file Database Migration Runner for Practitioner Protocols (PostgreSQL).
 * 
 * Applies DDL migrations sequentially with an audit ledger table (_pp_migrations)
 * and transaction rollback on error using the Node.js pg driver.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import pg from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, '..');

export const MIGRATION_FILES = [
  join(ROOT_DIR, 'prisma/migrations/20261021_init/migration.sql'),
  join(ROOT_DIR, 'prisma/migrations/20261022_add_currency_to_stat_unique_and_idempotency/migration.sql'),
];

/**
 * Resolves TLS/SSL configuration for PostgreSQL connections.
 * 
 * - Defaults to OFF (false) for localhost, 127.0.0.1, and *.railway.internal.
 * - Set DATABASE_SSL=require for verified TLS (public cloud URLs).
 * - Set DATABASE_SSL=no-verify for unverified TLS (opt-in only).
 *
 * @param {string} databaseUrl
 * @param {Record<string, string | undefined>} [env=process.env]
 * @returns {boolean | { rejectUnauthorized: boolean }}
 */
export function getDatabaseSslConfig(databaseUrl, env = process.env) {
  if (!databaseUrl) return false;

  try {
    const parsed = new URL(databaseUrl);
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.railway.internal')) {
      return false;
    }
  } catch {
    // If URL parsing fails, continue to env evaluation
  }

  const sslMode = (env.DATABASE_SSL || '').toLowerCase().trim();
  if (sslMode === 'require' || sslMode === 'true') {
    return { rejectUnauthorized: true };
  }
  if (sslMode === 'no-verify') {
    return { rejectUnauthorized: false };
  }

  return false;
}

/**
 * Runs pending DDL migrations against target PostgreSQL database with ledger tracking.
 *
 * @param {{ databaseUrl?: string, client?: any, env?: Record<string, string | undefined> }} [options={}]
 * @returns {Promise<{ applied: number, files: string[], skipped: number }>}
 */
export async function runMigrations(options = {}) {
  const env = options.env || process.env;
  const databaseUrl = (options.databaseUrl || env.DATABASE_URL || '').trim();
  if (!databaseUrl && !options.client) {
    throw new Error('DATABASE_URL is required to run database migrations.');
  }

  const client = options.client || new pg.Client({
    connectionString: databaseUrl,
    ssl: getDatabaseSslConfig(databaseUrl, env),
  });

  const shouldClose = !options.client;

  if (shouldClose) {
    await client.connect();
  }

  const appliedFiles = [];
  let skippedCount = 0;

  try {
    // 1. Ensure migration ledger table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS "_pp_migrations" (
        "id" TEXT PRIMARY KEY,
        "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 2. Fetch already applied migration IDs
    const existingRes = await client.query('SELECT "id" FROM "_pp_migrations"');
    const appliedSet = new Set(existingRes.rows.map(r => r.id));

    // 3. Sequentially apply unapplied migrations inside transaction
    for (const file of MIGRATION_FILES) {
      const migrationId = basename(dirname(file));
      if (appliedSet.has(migrationId)) {
        skippedCount++;
        continue;
      }

      await client.query('BEGIN');
      try {
        const sql = readFileSync(file, 'utf-8');
        await client.query(sql);
        await client.query('INSERT INTO "_pp_migrations" ("id") VALUES ($1)', [migrationId]);
        await client.query('COMMIT');
        appliedFiles.push(migrationId);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    if (shouldClose) {
      await client.end();
    }
  }

  return { applied: appliedFiles.length, files: appliedFiles, skipped: skippedCount };
}

// Execute directly if run via CLI
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrations()
    .then((result) => {
      console.log(`[Database Migrations] Applied: ${result.applied}, Skipped: ${result.skipped}.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`[Database Migrations FATAL] ${err.message}`);
      process.exit(1);
    });
}

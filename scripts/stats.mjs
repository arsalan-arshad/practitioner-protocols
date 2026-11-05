#!/usr/bin/env node

/**
 * @file CLI Script for aggregate-only platform metrics and adoption stats.
 * Pure aggregate counts only: zero PII, zero emails, zero customer data.
 * Usage: node scripts/stats.mjs
 */

import pg from 'pg';
import { getDatabaseSslConfig } from './migrate.js';

const arg = process.argv[2];
if (arg === '--help' || arg === '-h') {
  console.log(`
Usage: node scripts/stats.mjs

Displays high-level platform health, install totals, and adoption stats.
Strictly aggregate metrics only (zero personal or customer data).

Environment:
  DATABASE_URL  Postgres connection string (required)
`);
  process.exit(0);
}

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('Error: DATABASE_URL environment variable is required.');
  process.exit(1);
}

async function main() {
  const sslConfig = getDatabaseSslConfig(databaseUrl);
  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: sslConfig
  });

  try {
    await client.connect();

    console.log('='.repeat(80));
    console.log('PRACTITIONER PROTOCOLS — PLATFORM ADOPTION & HEALTH STATS');
    console.log('='.repeat(80));
    console.log(`Report generated at: ${new Date().toISOString()}\n`);

    // 1. Store Counts (Total installed, active, uninstalled)
    let totalStores = 0;
    let activeStores = 0;
    let uninstalledStores = 0;
    let optedInStores = 0;

    try {
      const storeRes = await client.query(`
        SELECT
          COUNT(*)::int as "total",
          COUNT(*) FILTER (WHERE "uninstalledAt" IS NULL)::int as "active",
          COUNT(*) FILTER (WHERE "uninstalledAt" IS NOT NULL)::int as "uninstalled",
          COUNT(*) FILTER (WHERE "marketingOptIn" = true AND "uninstalledAt" IS NULL)::int as "optedIn"
        FROM "ShopProfile"
      `);
      if (storeRes.rows.length > 0) {
        totalStores = storeRes.rows[0].total;
        activeStores = storeRes.rows[0].active;
        uninstalledStores = storeRes.rows[0].uninstalled;
        optedInStores = storeRes.rows[0].optedIn;
      }
    } catch (err) {
      console.warn(`[Notice] Could not query ShopProfile stats: ${err.message}`);
    }

    console.log('1. MERCHANT STORES');
    console.log(`   - Total Stores Installed: ${totalStores}`);
    console.log(`   - Currently Active:       ${activeStores}`);
    console.log(`   - Uninstalled:            ${uninstalledStores}`);
    console.log(`   - Marketing Opt-Ins:      ${optedInStores} (${activeStores > 0 ? ((optedInStores / activeStores) * 100).toFixed(1) : 0}% of active)\n`);

    // 2. Feedback Submissions & Average Rating
    let feedbackCount = 0;
    let customRequestsCount = 0;
    let avgRating = null;

    try {
      const fbRes = await client.query(`
        SELECT
          COUNT(*) FILTER (WHERE "kind" = 'feedback')::int as "feedbackCount",
          COUNT(*) FILTER (WHERE "kind" = 'custom_request')::int as "requestsCount",
          AVG("rating") FILTER (WHERE "kind" = 'feedback' AND "rating" IS NOT NULL)::numeric(3,2) as "avgRating"
        FROM "MerchantFeedback"
      `);
      if (fbRes.rows.length > 0) {
        feedbackCount = fbRes.rows[0].feedbackCount || 0;
        customRequestsCount = fbRes.rows[0].requestsCount || 0;
        avgRating = fbRes.rows[0].avgRating || null;
      }
    } catch (err) {
      console.warn(`[Notice] Could not query MerchantFeedback stats: ${err.message}`);
    }

    console.log('2. MERCHANT FEEDBACK & FEATURE REQUESTS');
    console.log(`   - Feedback Submissions:   ${feedbackCount}`);
    console.log(`   - Average Rating (1–5):   ${avgRating ? `${avgRating} / 5.0` : 'No ratings yet'}`);
    console.log(`   - Custom Feature Asks:    ${customRequestsCount}\n`);

    // 3. Shopper Contacts Count
    let shopperContactsCount = 0;
    try {
      const scRes = await client.query(`SELECT COUNT(*)::int as "count" FROM "ShopperContact"`);
      shopperContactsCount = scRes.rows?.[0]?.count || 0;
    } catch (err) {
      console.warn(`[Notice] Could not query ShopperContact stats: ${err.message}`);
    }

    console.log('3. SHOPPER OPT-IN CONTACTS ("Stay in touch")');
    console.log(`   - Total Opted-In Contacts: ${shopperContactsCount}\n`);

    // 4. Installs Per Week Trend
    console.log('4. WEEKLY INSTALLATION TREND');
    try {
      const trendRes = await client.query(`
        SELECT
          TO_CHAR(DATE_TRUNC('week', "installedAt"), 'YYYY-MM-DD') as "weekStart",
          COUNT(*)::int as "installs"
        FROM "ShopProfile"
        GROUP BY DATE_TRUNC('week', "installedAt")
        ORDER BY DATE_TRUNC('week', "installedAt") DESC
        LIMIT 8
      `);
      if (trendRes.rows.length === 0) {
        console.log('   No weekly installation history available.\n');
      } else {
        for (const row of trendRes.rows) {
          console.log(`   - Week of ${row.weekStart}: ${row.installs} install(s)`);
        }
        console.log('');
      }
    } catch (err) {
      console.warn(`[Notice] Could not query weekly install trend: ${err.message}\n`);
    }

    console.log('='.repeat(80));
    console.log('END OF STATS');
    console.log('='.repeat(80));
  } catch (err) {
    console.error('Database connection error:', err);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();

#!/usr/bin/env node

/**
 * @file CLI Script for listing Opted-In Merchants, Custom Feature Requests, and Shopper Contacts.
 * Usage: node scripts/contacts.mjs [shop]
 */

import pg from 'pg';
import { getDatabaseSslConfig } from './migrate.js';

const arg = process.argv[2];
if (arg === '--help' || arg === '-h') {
  console.log(`
Usage: node scripts/contacts.mjs [shop]

Lists:
  1. Opted-in, currently-installed shops (marketingOptIn = true, uninstalledAt IS NULL)
  2. Custom feature requests from merchants
  3. Opted-in shopper contacts ("Stay in touch")

Arguments:
  [shop]    Optional shop domain filter (e.g. store.myshopify.com)

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

const shopFilter = arg || null;

async function main() {
  const sslConfig = getDatabaseSslConfig(databaseUrl);
  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: sslConfig
  });

  try {
    await client.connect();

    console.log('='.repeat(80));
    console.log('PRACTITIONER PROTOCOLS — OPTED-IN MERCHANTS, REQUESTS & SHOPPER CONTACTS');
    console.log('='.repeat(80));
    console.log(`Database connected. Shop filter: ${shopFilter || 'ALL SHOPS'}\n`);

    // 1. Opted-In Currently-Installed Merchants
    // Privacy safeguard: never print shops that did not opt in, except custom requests
    console.log('-'.repeat(80));
    console.log('1. OPTED-IN INSTALLED SHOPS (marketingOptIn = true, uninstalledAt IS NULL)');
    console.log('-'.repeat(80));

    let shopSql = `
      SELECT "shop", "shopName", "ownerName", "email", "planName", "country", "installedAt", "marketingOptInAt"
      FROM "ShopProfile"
      WHERE "marketingOptIn" = true AND "uninstalledAt" IS NULL
    `;
    const shopParams = [];
    if (shopFilter) {
      shopSql += ' AND "shop" = $1';
      shopParams.push(shopFilter);
    }
    shopSql += ' ORDER BY "installedAt" DESC';

    let shopRows = [];
    try {
      const sRes = await client.query(shopSql, shopParams);
      shopRows = sRes.rows || [];
    } catch (err) {
      console.warn(`[Warning] Could not query ShopProfile: ${err.message}`);
    }

    if (shopRows.length === 0) {
      console.log('  No opted-in, currently-installed shops found.\n');
    } else {
      console.log(`  Found ${shopRows.length} opted-in installed shop(s):\n`);
      for (const s of shopRows) {
        console.log(`  [Shop: ${s.shop}] Store: ${s.shopName || '—'} | Owner: ${s.ownerName || '—'}`);
        console.log(`    Contact Email: ${s.email || '—'}`);
        console.log(`    Plan: ${s.planName || '—'} | Country: ${s.country || '—'}`);
        console.log(`    Installed: ${new Date(s.installedAt).toISOString()}`);
        if (s.marketingOptInAt) {
          console.log(`    Opted In At: ${new Date(s.marketingOptInAt).toISOString()}`);
        }
        console.log('');
      }
    }

    // 2. Custom Feature Requests
    console.log('-'.repeat(80));
    console.log('2. MERCHANT CUSTOM FEATURE REQUESTS (kind = \'custom_request\')');
    console.log('-'.repeat(80));

    let feedbackSql = `
      SELECT "shop", "shopName", "ownerName", "replyEmail", "planName", "country", "message", "createdAt"
      FROM "MerchantFeedback"
      WHERE "kind" = 'custom_request'
    `;
    const feedbackParams = [];
    if (shopFilter) {
      feedbackSql += ' AND "shop" = $1';
      feedbackParams.push(shopFilter);
    }
    feedbackSql += ' ORDER BY "createdAt" DESC';

    let feedbackRows = [];
    try {
      const fbRes = await client.query(feedbackSql, feedbackParams);
      feedbackRows = fbRes.rows || [];
    } catch (err) {
      console.warn(`[Warning] Could not query MerchantFeedback: ${err.message}`);
    }

    if (feedbackRows.length === 0) {
      console.log('  No custom feature requests found.\n');
    } else {
      console.log(`  Found ${feedbackRows.length} custom request(s):\n`);
      for (const req of feedbackRows) {
        console.log(`  [Shop: ${req.shop}] (${new Date(req.createdAt).toISOString()})`);
        if (req.shopName || req.ownerName) {
          console.log(`    Merchant: ${req.ownerName || '—'} (Store: ${req.shopName || '—'})`);
        }
        if (req.replyEmail) {
          console.log(`    Reply Email: ${req.replyEmail}`);
        }
        if (req.planName || req.country) {
          console.log(`    Plan: ${req.planName || '—'} | Country: ${req.country || '—'}`);
        }
        console.log(`    Request: ${req.message}`);
        console.log('');
      }
    }

    // 3. Opted-In Shopper Contacts
    console.log('-'.repeat(80));
    console.log('3. OPTED-IN SHOPPER CONTACTS ("Stay in touch")');
    console.log('-'.repeat(80));

    let contactsSql = `
      SELECT c."shop", c."ownerId", c."email", c."firstName",
             c."consentText", c."consentVersion", c."consentedAt", c."createdAt",
             COALESCE(p."practiceName", 'Individual Practitioner') as "practiceName"
      FROM "ShopperContact" c
      LEFT JOIN "PractitionerProfile" p ON c."shop" = p."shop" AND c."ownerId" = p."ownerGid"
    `;
    const contactsParams = [];
    if (shopFilter) {
      contactsSql += ' WHERE c."shop" = $1';
      contactsParams.push(shopFilter);
    }
    contactsSql += ' ORDER BY c."createdAt" DESC';

    let contactRows = [];
    try {
      const cRes = await client.query(contactsSql, contactsParams);
      contactRows = cRes.rows || [];
    } catch (err) {
      console.warn(`[Warning] Could not query ShopperContact: ${err.message}`);
    }

    if (contactRows.length === 0) {
      console.log('  No opted-in shopper contacts found.\n');
    } else {
      console.log(`  Found ${contactRows.length} opted-in shopper contact(s):\n`);
      for (const c of contactRows) {
        console.log(`  [Shop: ${c.shop}] Practice: ${c.practiceName} (${c.ownerId})`);
        console.log(`    Contact: ${c.email}${c.firstName ? ` (${c.firstName})` : ''}`);
        console.log(`    Consented: ${new Date(c.consentedAt).toISOString()} (v${c.consentVersion || 1})`);
        console.log(`    Consent Text: "${c.consentText}"`);
        console.log('');
      }
    }

    console.log('='.repeat(80));
    console.log('END OF REPORT');
    console.log('='.repeat(80));
  } catch (err) {
    console.error('Database connection error:', err);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();

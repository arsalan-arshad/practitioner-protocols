#!/usr/bin/env node

/**
 * @file CLI Script for listing Custom Feature Requests and Opted-In Shopper Contacts.
 * Usage: node scripts/contacts.mjs [shop]
 */

import pg from 'pg';
import { getDatabaseSslConfig } from './migrate.js';

const arg = process.argv[2];
if (arg === '--help' || arg === '-h') {
  console.log(`
Usage: node scripts/contacts.mjs [shop]

Lists custom feature requests from merchants (listed first) and
opted-in shopper contacts (listed second) from the database.

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
    console.log('PRACTITIONER PROTOCOLS — CUSTOM REQUESTS & OPTED-IN CONTACTS');
    console.log('='.repeat(80));
    console.log(`Database connected. Shop filter: ${shopFilter || 'ALL SHOPS'}\n`);

    // 1. Custom Feature Requests (listed first)
    console.log('-'.repeat(80));
    console.log('1. MERCHANT CUSTOM FEATURE REQUESTS (kind = \'custom_request\')');
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

    // 2. Opted-In Shopper Contacts
    console.log('-'.repeat(80));
    console.log('2. OPTED-IN SHOPPER CONTACTS ("Stay in touch")');
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

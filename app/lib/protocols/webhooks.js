import crypto from 'node:crypto';
import { extractAttributionFromOrder } from './attribution.js';
import { recordOrderAttribution } from './service.js';

/**
 * Verifies Shopify's X-Shopify-Hmac-Sha256 base64 digest using timing-safe comparison.
 *
 * @param {string | Buffer} rawBody - Raw HTTP request body
 * @param {string} hmacHeader - Value of X-Shopify-Hmac-Sha256 header
 * @param {string} apiSecret - Shopify App API secret
 * @returns {boolean}
 */
export function verifyWebhookHmac(rawBody, hmacHeader, apiSecret) {
  if (!rawBody || !hmacHeader || !apiSecret) {
    return false;
  }

  try {
    const rawBuffer = Buffer.isBuffer(rawBody)
      ? rawBody
      : Buffer.from(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody), 'utf8');

    const generated = crypto
      .createHmac('sha256', apiSecret)
      .update(rawBuffer)
      .digest();

    const provided = Buffer.from(String(hmacHeader).trim(), 'base64');

    if (generated.length !== provided.length) {
      return false;
    }

    return crypto.timingSafeEqual(generated, provided);
  } catch {
    return false;
  }
}

/**
 * Extracts shop domain from various payload structures.
 *
 * @param {any} payload
 * @returns {string}
 */
export function extractShopDomain(payload) {
  if (!payload || typeof payload !== 'object') return '';
  return (
    payload.shop_domain ||
    payload.myshopify_domain ||
    payload.shop ||
    payload.domain ||
    payload.order?.shop_domain ||
    ''
  ).trim();
}

/**
 * Normalizes customer ID or GID to gid://shopify/Customer/... format.
 *
 * @param {string | number} idOrGid
 * @returns {string}
 */
export function toCustomerGid(idOrGid) {
  if (!idOrGid) return '';
  const str = String(idOrGid).trim();
  if (str.startsWith('gid://shopify/Customer/')) {
    return str;
  }
  const numericOnly = str.replace(/\D/g, '');
  return numericOnly ? `gid://shopify/Customer/${numericOnly}` : str;
}

/**
 * Extracts customer ID string from various webhook payload structures.
 *
 * @param {any} payload
 * @returns {string}
 */
export function extractCustomerId(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const raw =
    payload.customer?.id ??
    payload.customer_id ??
    payload.customerId ??
    payload.id ??
    '';
  return String(raw).trim();
}

/**
 * Records and checks webhook idempotency using a short-retention ProcessedWebhook table (zero PII).
 * Returns true if this is the first time the webhook is seen, or false if already processed.
 *
 * @param {any} db Database client with query(sql, params) interface
 * @param {{ shop: string, webhookId: string, topic?: string }} params
 * @returns {Promise<boolean>} True if newly recorded, false if duplicate
 */
export async function recordWebhookIdempotency(db, { shop, webhookId, topic = 'unknown' }) {
  if (!db || !shop || !webhookId) {
    return true;
  }

  try {
    const res = await db.query(`
      INSERT INTO "ProcessedWebhook" ("id", "shop", "webhookId", "topic", "processedAt")
      VALUES (gen_random_uuid()::text, $1, $2, $3, NOW())
      ON CONFLICT ("shop", "webhookId") DO NOTHING
      RETURNING "id"
    `, [shop, String(webhookId).trim(), topic]);

    const isNew = Boolean((res.rowCount && res.rowCount > 0) || (res.rows && res.rows.length > 0));
    return isNew;
  } catch {
    // If table does not exist or db query fails in test mock, fallback gracefully
    return true;
  }
}

/**
 * Handles customers/data_request webhook (SPEC §10).
 * Reports practitioner profile and protocol references for the specified customer ID.
 *
 * --- NOTE ON CUSTOMERS/DATA_REQUEST REALITY ---
 * Under GDPR/Shopify mandatory compliance, when a customer requests their data,
 * an app must return all personal data held for that customer.
 * In Practitioner Protocols, by architectural design (SPEC §6 & Privacy Rule 2):
 * 1. Zero shopper, client, or patient PII is ever accepted, stored, or processed.
 *    Individual orders are only aggregated into monthly protocol counters without customer IDs.
 * 2. The only customers who have records in this database are registered practitioners
 *    who author protocols.
 * 3. Therefore, for ordinary shoppers/patients, no record exists (clientPii: null, clientDataStored: false).
 *    For practitioners, only their professional profile and authored protocols are returned.
 *
 * @param {any} db - Database client with query(sql, params) interface
 * @param {any} payload - Shopify customers/data_request webhook payload
 * @returns {Promise<{
 *   success: boolean,
 *   shop: string,
 *   customer: { id: string, gid: string },
 *   practitionerProfile: object | null,
 *   protocols: Array<object>,
 *   clientPii: null,
 *   clientDataStored: boolean,
 *   message: string
 * }>}
 */
export async function handleCustomersDataRequest(db, payload) {
  const shop = extractShopDomain(payload);
  const rawId = extractCustomerId(payload);
  const customerGid = toCustomerGid(rawId);
  const numericId = String(rawId).replace(/^gid:\/\/shopify\/Customer\//, '');

  if (!shop || !customerGid) {
    return {
      success: false,
      reason: 'MISSING_REQUIRED_FIELDS',
      shop,
      customer: { id: numericId, gid: customerGid },
      practitionerProfile: null,
      protocols: [],
      clientPii: null,
      clientDataStored: false,
      message: 'Shop or customer identifier missing.'
    };
  }

  // 1. Query practitioner profile if present
  const profileSql = `
    SELECT "id", "shop", "ownerType", "ownerGid", "practiceName", "logoUrl", "isApproved", "createdAt", "updatedAt"
    FROM "PractitionerProfile"
    WHERE "shop" = $1 AND ("ownerGid" = $2 OR "ownerGid" = $3)
  `;
  const profileRes = await db.query(profileSql, [shop, customerGid, numericId]);
  const practitionerProfile = profileRes.rows?.[0] || null;

  // 2. Query protocol references owned or created by this customer
  const protocolsSql = `
    SELECT "id", "shop", "token", "name", "introNote", "displayName",
           "ownerType", "ownerId", "createdBy", "updatedBy", "status",
           "isStarter", "sourceProtocolId", "createdAt", "updatedAt"
    FROM "Protocol"
    WHERE "shop" = $1 AND (
      "ownerId" = $2 OR "ownerId" = $3 OR
      "createdBy" = $2 OR "createdBy" = $3
    )
    ORDER BY "createdAt" DESC
  `;
  const protocolsRes = await db.query(protocolsSql, [shop, customerGid, numericId]);
  const protocols = protocolsRes.rows || [];

  return {
    success: true,
    shop,
    customer: {
      id: numericId,
      gid: customerGid
    },
    practitionerProfile,
    protocols,
    clientPii: null,
    clientDataStored: false,
    message: 'Zero client or patient PII is accepted or stored by Practitioner Protocols.'
  };
}

/**
 * Handles customers/redact webhook (SPEC §10).
 * - Tag mode: deletes practitioner profile, archives or deletes their protocols.
 * - Company mode: preserves company protocols, clears creator/updater references.
 *
 * @param {any} db - Database client with query(sql, params) interface
 * @param {any} payload - Shopify customers/redact webhook payload
 * @param {{
 *   mode?: 'tag' | 'company',
 *   archiveOnly?: boolean,
 *   action?: 'delete' | 'archive'
 * }} [options]
 * @returns {Promise<{
 *   success: boolean,
 *   shop: string,
 *   customerGid: string,
 *   mode: string,
 *   profileDeleted: boolean,
 *   protocolsDeleted: number,
 *   protocolsArchived: number,
 *   protocolsPreserved?: number,
 *   referencesCleared?: number
 * }>}
 */
export async function handleCustomersRedact(db, payload, options = {}) {
  const shop = extractShopDomain(payload);
  const rawId = extractCustomerId(payload);
  const customerGid = toCustomerGid(rawId);
  const numericId = String(rawId).replace(/^gid:\/\/shopify\/Customer\//, '');

  if (!shop || !customerGid) {
    throw new Error('Redaction failed: shop and customer identifier are required');
  }

  // Determine identity mode: options/payload override, or check Setting table, fallback to 'tag'
  let mode = options.mode || payload.mode || payload.identityMode;
  if (!mode) {
    try {
      const settingRes = await db.query(
        'SELECT "identityMode" FROM "Setting" WHERE "shop" = $1',
        [shop]
      );
      if (settingRes.rows?.length > 0 && settingRes.rows[0].identityMode) {
        mode = settingRes.rows[0].identityMode;
      }
    } catch {
      // Fallback to default tag mode
    }
  }
  mode = (mode || 'tag').toLowerCase();

  const isCompanyMode = mode === 'company';

  if (isCompanyMode) {
    // --- COMPANY MODE ---
    // Preserves company protocols, clears creator/updater reference

    // Clear createdBy references
    const clearCreatedSql = `
      UPDATE "Protocol"
      SET "createdBy" = NULL, "updatedAt" = NOW()
      WHERE "shop" = $1 AND ("createdBy" = $2 OR "createdBy" = $3)
      RETURNING "id"
    `;
    const clearCreatedRes = await db.query(clearCreatedSql, [shop, customerGid, numericId]);

    // Clear updatedBy references
    const clearUpdatedSql = `
      UPDATE "Protocol"
      SET "updatedBy" = NULL, "updatedAt" = NOW()
      WHERE "shop" = $1 AND ("updatedBy" = $2 OR "updatedBy" = $3)
      RETURNING "id"
    `;
    const clearUpdatedRes = await db.query(clearUpdatedSql, [shop, customerGid, numericId]);

    // Delete personal customer profile if exists (company profile is preserved)
    const deleteProfileSql = `
      DELETE FROM "PractitionerProfile"
      WHERE "shop" = $1 AND "ownerType" = 'customer' AND ("ownerGid" = $2 OR "ownerGid" = $3)
      RETURNING "id"
    `;
    const deleteProfileRes = await db.query(deleteProfileSql, [shop, customerGid, numericId]);

    let preservedCount = 0;
    try {
      const countRes = await db.query(
        'SELECT COUNT(*)::int as count FROM "Protocol" WHERE "shop" = $1 AND "ownerType" = \'company\'',
        [shop]
      );
      preservedCount = Number(countRes.rows?.[0]?.count) || 0;
    } catch {
      // Optional count
    }

    const referencesCleared =
      (clearCreatedRes.rowCount ?? clearCreatedRes.rows?.length ?? 0) +
      (clearUpdatedRes.rowCount ?? clearUpdatedRes.rows?.length ?? 0);

    return {
      success: true,
      shop,
      customerGid,
      mode: 'company',
      protocolsPreserved: preservedCount,
      protocolsDeleted: 0,
      protocolsArchived: 0,
      referencesCleared,
      profileDeleted: (deleteProfileRes.rowCount ?? deleteProfileRes.rows?.length ?? 0) > 0
    };
  } else {
    // --- TAG MODE ---
    // Deletes practitioner profile, archives or deletes their protocols

    // 1. Delete practitioner profile
    const deleteProfileSql = `
      DELETE FROM "PractitionerProfile"
      WHERE "shop" = $1 AND ("ownerGid" = $2 OR "ownerGid" = $3)
      RETURNING "id"
    `;
    const profileRes = await db.query(deleteProfileSql, [shop, customerGid, numericId]);
    const profileDeleted = (profileRes.rowCount ?? profileRes.rows?.length ?? 0) > 0;

    // 2. Protocols: archive or delete
    const shouldArchive = Boolean(
      options.archiveOnly ||
      payload.archiveOnly ||
      options.action === 'archive' ||
      payload.action === 'archive'
    );

    let protocolsArchived = 0;
    let protocolsDeleted = 0;

    if (shouldArchive) {
      const archiveSql = `
        UPDATE "Protocol"
        SET "status" = 'archived',
            "createdBy" = NULL,
            "updatedBy" = NULL,
            "displayName" = NULL,
            "updatedAt" = NOW()
        WHERE "shop" = $1 AND ("ownerId" = $2 OR "ownerId" = $3)
        RETURNING "id"
      `;
      const archiveRes = await db.query(archiveSql, [shop, customerGid, numericId]);
      protocolsArchived = archiveRes.rowCount ?? archiveRes.rows?.length ?? 0;
    } else {
      // Delete lines first (safe cascade)
      await db.query(`
        DELETE FROM "ProtocolLine"
        WHERE "protocolId" IN (
          SELECT "id" FROM "Protocol"
          WHERE "shop" = $1 AND "ownerType" = 'customer' AND ("ownerId" = $2 OR "ownerId" = $3)
        )
      `, [shop, customerGid, numericId]);

      const deleteProtoSql = `
        DELETE FROM "Protocol"
        WHERE "shop" = $1 AND "ownerType" = 'customer' AND ("ownerId" = $2 OR "ownerId" = $3)
        RETURNING "id"
      `;
      const deleteRes = await db.query(deleteProtoSql, [shop, customerGid, numericId]);
      protocolsDeleted = deleteRes.rowCount ?? deleteRes.rows?.length ?? 0;
    }

    // 3. Clear creator/updater references in any other protocols
    await db.query(
      'UPDATE "Protocol" SET "createdBy" = NULL WHERE "shop" = $1 AND ("createdBy" = $2 OR "createdBy" = $3)',
      [shop, customerGid, numericId]
    );
    await db.query(
      'UPDATE "Protocol" SET "updatedBy" = NULL WHERE "shop" = $1 AND ("updatedBy" = $2 OR "updatedBy" = $3)',
      [shop, customerGid, numericId]
    );

    return {
      success: true,
      shop,
      customerGid,
      mode: 'tag',
      profileDeleted,
      protocolsDeleted,
      protocolsArchived
    };
  }
}

/**
 * Handles shop/redact webhook (SPEC §10).
 * Deletes all shop protocols, lines, stats, profiles, settings, and sessions.
 *
 * @param {any} db - Database client with query(sql, params) interface
 * @param {any} payload - Shopify shop/redact webhook payload
 * @returns {Promise<{
 *   success: boolean,
 *   shop: string,
 *   deleted: {
 *     lines: number,
 *     stats: number,
 *     protocols: number,
 *     profiles: number,
 *     settings: number,
 *     sessions: number
 *   }
 * }>}
 */
export async function handleShopRedact(db, payload) {
  const shop = extractShopDomain(payload);
  if (!shop) {
    throw new Error('Redaction failed: shop identifier is required');
  }

  // 1. Delete ProtocolLines
  const linesRes = await db.query(`
    DELETE FROM "ProtocolLine"
    WHERE "protocolId" IN (
      SELECT "id" FROM "Protocol" WHERE "shop" = $1
    )
    RETURNING "id"
  `, [shop]);

  // 2. Delete ProtocolOrderStats
  const statsRes = await db.query(`
    DELETE FROM "ProtocolOrderStat"
    WHERE "shop" = $1
    RETURNING "id"
  `, [shop]);

  // 3. Delete Protocols
  const protocolsRes = await db.query(`
    DELETE FROM "Protocol"
    WHERE "shop" = $1
    RETURNING "id"
  `, [shop]);

  // 4. Delete PractitionerProfiles
  const profilesRes = await db.query(`
    DELETE FROM "PractitionerProfile"
    WHERE "shop" = $1
    RETURNING "id"
  `, [shop]);

  // 5. Delete Settings
  const settingsRes = await db.query(`
    DELETE FROM "Setting"
    WHERE "shop" = $1
    RETURNING "shop"
  `, [shop]);

  // 6. Delete Sessions
  const sessionsRes = await db.query(`
    DELETE FROM "Session"
    WHERE "shop" = $1
    RETURNING "id"
  `, [shop]);

  return {
    success: true,
    shop,
    deleted: {
      lines: linesRes.rowCount ?? linesRes.rows?.length ?? 0,
      stats: statsRes.rowCount ?? statsRes.rows?.length ?? 0,
      protocols: protocolsRes.rowCount ?? protocolsRes.rows?.length ?? 0,
      profiles: profilesRes.rowCount ?? profilesRes.rows?.length ?? 0,
      settings: settingsRes.rowCount ?? settingsRes.rows?.length ?? 0,
      sessions: sessionsRes.rowCount ?? sessionsRes.rows?.length ?? 0
    }
  };
}

/**
 * Handles app/uninstalled webhook (SPEC §10).
 * Revokes/cleans up active shop sessions and records uninstallation timestamp.
 *
 * @param {any} db - Database client with query(sql, params) interface
 * @param {any} payload - Shopify app/uninstalled webhook payload
 * @returns {Promise<{
 *   success: boolean,
 *   shop: string,
 *   uninstalledAt: string,
 *   sessionsRevoked: number,
 *   settingUpdated: boolean
 * }>}
 */
export async function handleAppUninstalled(db, payload) {
  const shop = extractShopDomain(payload);
  if (!shop) {
    return {
      success: false,
      reason: 'MISSING_SHOP',
      shop: '',
      uninstalledAt: new Date().toISOString(),
      sessionsRevoked: 0,
      settingUpdated: false
    };
  }

  // Revoke/clean up active shop sessions
  const sessionsRes = await db.query(
    'DELETE FROM "Session" WHERE "shop" = $1 RETURNING "id"',
    [shop]
  ).catch(() => ({ rowCount: 0, rows: [] }));
  const sessionsRevoked = sessionsRes.rowCount ?? sessionsRes.rows?.length ?? 0;

  // Record uninstallation timestamp
  const uninstalledAt = new Date().toISOString();
  let settingUpdated = false;
  try {
    const settingRes = await db.query(
      'UPDATE "Setting" SET "updatedAt" = NOW() WHERE "shop" = $1 RETURNING "shop"',
      [shop]
    );
    settingUpdated = (settingRes.rowCount ?? settingRes.rows?.length ?? 0) > 0;
  } catch {
    // Non-fatal if setting table or row does not exist
  }

  return {
    success: true,
    shop,
    uninstalledAt,
    sessionsRevoked,
    settingUpdated
  };
}

/**
 * Handles orders/paid webhook attribution (SPEC §9).
 * Extracts protocol attributions using extractAttributionFromOrder and records monthly aggregate stats.
 *
 * @param {any} db - Database client with query(sql, params) interface
 * @param {any} payload - Shopify orders/paid webhook payload
 * @param {{
 *   shop?: string,
 *   month?: string,
 *   currency?: string
 * }} [options]
 * @returns {Promise<{
 *   success: boolean,
 *   shop: string,
 *   month: string,
 *   currency: string,
 *   attributions: Array<any>,
 *   updatedCount: number
 * }>}
 */
export async function handleOrdersPaid(db, payload, options = {}) {
  const shop = options.shop || extractShopDomain(payload) || '';
  const order = payload?.order || payload;

  // Extract webhook ID from options, payload or order
  const webhookId =
    options.webhookId ||
    options.webhook_id ||
    payload?.webhook_id ||
    payload?.webhookId ||
    order?.id ||
    '';

  // Check idempotency if webhook ID and shop are present
  if (shop && webhookId) {
    const isNew = await recordWebhookIdempotency(db, {
      shop,
      webhookId: String(webhookId),
      topic: 'orders/paid'
    });

    if (!isNew) {
      return {
        success: true,
        duplicate: true,
        shop,
        month: options.month || '',
        currency: options.currency || order?.currency || order?.presentment_currency || 'USD',
        attributions: [],
        updatedCount: 0
      };
    }
  }

  const attributions = extractAttributionFromOrder(order);

  // Month format: YYYY-MM
  let month = options.month;
  if (!month) {
    const rawDate = order?.created_at || order?.processed_at;
    const dateObj = rawDate ? new Date(rawDate) : new Date();
    const validDate = !isNaN(dateObj.getTime()) ? dateObj : new Date();
    const yyyy = validDate.getUTCFullYear();
    const mm = String(validDate.getUTCMonth() + 1).padStart(2, '0');
    month = `${yyyy}-${mm}`;
  }

  const currency = options.currency || order?.currency || order?.presentment_currency || 'USD';

  if (!shop) {
    return {
      success: false,
      reason: 'MISSING_SHOP',
      shop: '',
      month,
      currency,
      attributions,
      updatedCount: 0
    };
  }

  if (attributions.length === 0) {
    return {
      success: true,
      shop,
      month,
      currency,
      attributions: [],
      updatedCount: 0
    };
  }

  const result = await recordOrderAttribution(db, {
    shop,
    attributions,
    month,
    currency
  });

  return {
    success: true,
    shop,
    month,
    currency,
    attributions,
    updatedCount: result.updatedCount
  };
}

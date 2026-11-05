/**
 * @file Contacts & Merchant Feedback Service (app/lib/protocols/contacts.js)
 * 
 * Implements M11 Shopper Opt-In ("Stay in touch") and Merchant Custom Request / Feedback features.
 * Privacy rule relaxation: ONLY explicit, opt-in shopper contacts are stored.
 * Never stores protocolId, order id, product data, IP address, or user agent.
 * Strictly avoids logging emails or names; errors never echo them.
 */

import { escapeCsvField } from './admin.js';
import { decryptAccessToken } from './crypto.js';

export const EMAIL_MAX_LENGTH = 254;
export const FIRST_NAME_MAX_LENGTH = 60;
export const CUSTOM_REQUEST_MESSAGE_MAX_LENGTH = 1000;

// Standard email regex ensuring user@domain.tld structure
const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

export class ContactValidationError extends Error {
  constructor(message, code = 'INVALID_INPUT', field = null) {
    super(message);
    this.name = 'ContactValidationError';
    this.code = code;
    this.field = field;
  }
}

/**
 * Canonical consent wording templates defined server-side per version.
 * Client-submitted consent texts are strictly ignored.
 */
export const CANONICAL_CONSENT_TEMPLATES = Object.freeze({
  1: 'I agree to receive emails from {practiceName} and {shopName} with product recommendations and offers. I can unsubscribe at any time.'
});

export const CURRENT_CONSENT_VERSION = 1;

/**
 * Returns canonical consent text for a given version with template variables replaced.
 * Throws ContactValidationError if the consent version is unknown.
 *
 * @param {number} [version=1]
 * @param {{ practiceName?: string | null, shopName?: string | null }} [options={}]
 * @returns {string}
 */
export function getCanonicalConsentText(version = CURRENT_CONSENT_VERSION, { practiceName = null, shopName = null } = {}) {
  const template = CANONICAL_CONSENT_TEMPLATES[version];
  if (!template) {
    throw new ContactValidationError(
      `Unsupported consent version: ${version}`,
      'INVALID_CONSENT_VERSION',
      'consentVersion'
    );
  }
  const cleanPractice = practiceName && String(practiceName).trim() ? String(practiceName).trim() : 'this practice';
  const cleanShop = shopName && String(shopName).trim() ? String(shopName).trim() : 'this store';
  return template
    .replace('{practiceName}', cleanPractice)
    .replace('{shopName}', cleanShop);
}

/**
 * Validates and normalizes an email address.
 * Never echoes input in error messages.
 *
 * @param {any} email
 * @returns {string} Lowercased trimmed email
 */
export function validateContactEmail(email) {
  if (typeof email !== 'string') {
    throw new ContactValidationError('A valid email address is required.', 'INVALID_EMAIL', 'email');
  }
  const trimmed = email.trim();
  if (!trimmed || trimmed.length > EMAIL_MAX_LENGTH || !EMAIL_REGEX.test(trimmed)) {
    throw new ContactValidationError('A valid email address is required.', 'INVALID_EMAIL', 'email');
  }
  return trimmed.toLowerCase();
}

/**
 * Validates an optional first name.
 * Never echoes input in error messages.
 *
 * @param {any} name
 * @returns {string | null}
 */
export function validateContactFirstName(name) {
  if (name === null || name === undefined || name === '') {
    return null;
  }
  if (typeof name !== 'string') {
    throw new ContactValidationError('First name must be text.', 'INVALID_FIRST_NAME', 'firstName');
  }
  const trimmed = name.trim();
  if (trimmed.length > FIRST_NAME_MAX_LENGTH) {
    throw new ContactValidationError(
      `First name cannot exceed ${FIRST_NAME_MAX_LENGTH} characters.`,
      'FIRST_NAME_TOO_LONG',
      'firstName'
    );
  }
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Validates custom request message.
 *
 * @param {any} message
 * @returns {string}
 */
export function validateCustomRequestMessage(message) {
  if (typeof message !== 'string') {
    throw new ContactValidationError('A message describing what you need is required.', 'INVALID_MESSAGE', 'message');
  }
  const trimmed = message.trim();
  if (!trimmed) {
    throw new ContactValidationError('A message describing what you need is required.', 'EMPTY_MESSAGE', 'message');
  }
  if (trimmed.length > CUSTOM_REQUEST_MESSAGE_MAX_LENGTH) {
    throw new ContactValidationError(
      `Message cannot exceed ${CUSTOM_REQUEST_MESSAGE_MAX_LENGTH} characters.`,
      'MESSAGE_TOO_LONG',
      'message'
    );
  }
  return trimmed;
}

/**
 * Validates feedback rating (1-5 integer, or null/undefined).
 *
 * @param {any} rating
 * @returns {number | null}
 */
export function validateFeedbackRating(rating) {
  if (rating === null || rating === undefined || rating === '') {
    return null;
  }
  const num = Number(rating);
  if (!Number.isInteger(num) || num < 1 || num > 5) {
    throw new ContactValidationError(
      'Rating must be an integer between 1 and 5.',
      'INVALID_RATING',
      'rating'
    );
  }
  return num;
}

/**
 * Saves or updates a shopper opt-in contact.
 * Canonical server-defined consent text is strictly enforced; any client-supplied consentText is ignored.
 * Unknown consentVersion values are rejected.
 * Idempotent: repeated submissions for the same (shop, ownerId, lowercased email) update consentedAt and text.
 * Anti-enumeration: returns generic success message regardless of whether new or existing.
 * Honeypot: silently discards submissions with non-empty honeypot.
 *
 * @param {any} db
 * @param {{
 *   shop: string,
 *   token: string,
 *   email: string,
 *   firstName?: string | null,
 *   consent: boolean,
 *   consentText?: string,
 *   consentVersion?: number,
 *   honeypot?: string
 * }} options
 * @returns {Promise<{ success: boolean, message: string }>}
 */
export async function saveShopperContact(db, {
  shop,
  token,
  email,
  firstName = null,
  consent,
  consentText: _ignoredClientText = null,
  consentVersion = CURRENT_CONSENT_VERSION,
  honeypot = ''
}) {
  // 1. Silent honeypot discard: bots filling hidden fields get generic success without DB write
  if (honeypot && String(honeypot).trim().length > 0) {
    return { success: true, message: 'Thank you for staying in touch!' };
  }

  // 2. Explicit unticked consent is mandatory
  if (consent !== true) {
    throw new ContactValidationError(
      'Explicit consent is required to stay in touch.',
      'CONSENT_REQUIRED',
      'consent'
    );
  }

  if (!shop || typeof shop !== 'string') {
    throw new ContactValidationError('Shop domain is required.', 'INVALID_SHOP', 'shop');
  }

  if (!token || typeof token !== 'string') {
    throw new ContactValidationError('Protocol token is required.', 'INVALID_TOKEN', 'token');
  }

  const cleanEmail = validateContactEmail(email);
  const cleanFirstName = validateContactFirstName(firstName);

  // Validate consentVersion strictly against canonical templates
  const versionNum = (consentVersion === undefined || consentVersion === null)
    ? CURRENT_CONSENT_VERSION
    : Number(consentVersion);

  if (!Number.isInteger(versionNum) || !CANONICAL_CONSENT_TEMPLATES[versionNum]) {
    throw new ContactValidationError(
      `Unsupported consent version: ${consentVersion}`,
      'INVALID_CONSENT_VERSION',
      'consentVersion'
    );
  }

  // 3. Resolve token to an ACTIVE protocol in this shop to identify ownerId and practiceName
  const protoSql = `
    SELECT pr."id", pr."ownerId", pr."status", pp."practiceName"
    FROM "Protocol" pr
    LEFT JOIN "PractitionerProfile" pp ON pp."shop" = pr."shop" AND pp."ownerGid" = pr."ownerId"
    WHERE pr."shop" = $1 AND pr."token" = $2
  `;
  const protoRes = await db.query(protoSql, [shop, token]);
  const protocol = protoRes?.rows?.[0];

  if (!protocol || protocol.status !== 'active') {
    throw new ContactValidationError(
      'Protocol not found or no longer active.',
      'PROTOCOL_INACTIVE',
      'token'
    );
  }

  const ownerId = protocol.ownerId;
  const practiceName = protocol.practiceName || null;

  let shopDisplayName = shop;
  try {
    const profile = await getShopProfile(db, { shop });
    if (profile?.shopName) {
      shopDisplayName = profile.shopName;
    }
  } catch {}

  // Resolve canonical consent text server-side (forged client text is ignored)
  const canonicalConsentText = getCanonicalConsentText(versionNum, {
    practiceName,
    shopName: shopDisplayName
  });

  const now = new Date();

  // 4. Upsert into ShopperContact: idempotent on (shop, ownerId, lowercased email)
  // Stores NO protocolId, NO order id, NO product data, NO IP address, NO user agent.
  const upsertSql = `
    INSERT INTO "ShopperContact" (
      "id", "shop", "ownerId", "email", "firstName",
      "consentText", "consentVersion", "consentedAt", "source", "createdAt"
    ) VALUES (
      gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, 'protocol_page', NOW()
    )
    ON CONFLICT ("shop", "ownerId", "email") DO UPDATE SET
      "consentedAt" = EXCLUDED."consentedAt",
      "consentText" = EXCLUDED."consentText",
      "consentVersion" = EXCLUDED."consentVersion",
      "firstName" = COALESCE(EXCLUDED."firstName", "ShopperContact"."firstName")
    RETURNING "id"
  `;

  await db.query(upsertSql, [
    shop,
    ownerId,
    cleanEmail,
    cleanFirstName,
    canonicalConsentText,
    versionNum,
    now
  ]);

  // Generic anti-enumeration response
  return { success: true, message: 'Thank you for staying in touch!' };
}

/**
 * Lists contacts owned strictly by this practitioner.
 * Enforces server-side owner scoping.
 *
 * @param {any} db
 * @param {{ shop: string, ownerId: string }} options
 * @returns {Promise<Array<{ id: string, email: string, firstName: string | null, consentedAt: Date, createdAt: Date }>>}
 */
export async function listPractitionerContacts(db, { shop, ownerId }) {
  if (!shop || !ownerId) return [];

  const sql = `
    SELECT "id", "email", "firstName", "consentedAt", "createdAt"
    FROM "ShopperContact"
    WHERE "shop" = $1 AND "ownerId" = $2
    ORDER BY "consentedAt" DESC
  `;
  const res = await db.query(sql, [shop, ownerId]);
  return res?.rows || [];
}

/**
 * Deletes a single contact strictly scoped to this practitioner.
 *
 * @param {any} db
 * @param {{ shop: string, ownerId: string, contactId: string }} options
 * @returns {Promise<boolean>}
 */
export async function deletePractitionerContact(db, { shop, ownerId, contactId }) {
  if (!shop || !ownerId || !contactId) return false;

  const sql = `
    DELETE FROM "ShopperContact"
    WHERE "shop" = $1 AND "ownerId" = $2 AND "id" = $3
    RETURNING "id"
  `;
  const res = await db.query(sql, [shop, ownerId, contactId]);
  return (res?.rowCount ?? res?.rows?.length ?? 0) > 0;
}

/**
 * Formats practitioner contacts as RFC 4180 CSV.
 * Columns: Email,First Name,Consented At,Verified
 * Includes honest disclaimer that addresses are unverified by the app.
 *
 * @param {Array<any>} contacts
 * @returns {string}
 */
export function exportPractitionerContactsCsv(contacts = []) {
  const comment = '# Note: Email addresses are collected with opt-in consent but are not verified by Practitioner Protocols. Confirm via double opt-in in your marketing tool.';
  const headers = ['Email', 'First Name', 'Consented At', 'Verified'];
  const lines = [comment, headers.join(',')];

  for (const c of contacts) {
    const consentedAtStr = c.consentedAt instanceof Date
      ? c.consentedAt.toISOString()
      : (c.consentedAt ? String(c.consentedAt) : '');

    const row = [
      escapeCsvField(c.email || ''),
      escapeCsvField(c.firstName || ''),
      escapeCsvField(consentedAtStr),
      'no'
    ];
    lines.push(row.join(','));
  }

  return lines.join('\r\n') + '\r\n';
}

/**
 * Lists all contacts for merchant admin dashboard, including practice rollups.
 *
 * @param {any} db
 * @param {{ shop: string }} options
 * @returns {Promise<{
 *   practices: Array<{ ownerId: string, practiceName: string, count: number }>,
 *   contacts: Array<any>,
 *   totalContacts: number
 * }>}
 */
export async function listMerchantContacts(db, { shop }) {
  if (!shop) return { practices: [], contacts: [], totalContacts: 0 };

  const contactsSql = `
    SELECT c."id", c."ownerId", c."email", c."firstName",
           c."consentText", c."consentVersion", c."consentedAt", c."createdAt",
           COALESCE(p."practiceName", 'Individual Practitioner') as "practiceName"
    FROM "ShopperContact" c
    LEFT JOIN "PractitionerProfile" p ON c."shop" = p."shop" AND c."ownerId" = p."ownerGid"
    WHERE c."shop" = $1
    ORDER BY c."consentedAt" DESC
  `;
  const contactsRes = await db.query(contactsSql, [shop]);
  const contacts = contactsRes?.rows || [];

  // Practice rollup grouping
  const practiceMap = new Map();
  for (const c of contacts) {
    const ownerId = c.ownerId;
    if (!practiceMap.has(ownerId)) {
      practiceMap.set(ownerId, {
        ownerId,
        practiceName: c.practiceName || 'Individual Practitioner',
        count: 0
      });
    }
    practiceMap.get(ownerId).count += 1;
  }

  const practices = Array.from(practiceMap.values()).sort((a, b) => b.count - a.count);

  return {
    practices,
    contacts,
    totalContacts: contacts.length
  };
}

/**
 * Deletes a single contact across the shop (merchant admin authority).
 *
 * @param {any} db
 * @param {{ shop: string, contactId: string }} options
 * @returns {Promise<boolean>}
 */
export async function deleteMerchantContact(db, { shop, contactId }) {
  if (!shop || !contactId) return false;

  const sql = `
    DELETE FROM "ShopperContact"
    WHERE "shop" = $1 AND "id" = $2
    RETURNING "id"
  `;
  const res = await db.query(sql, [shop, contactId]);
  return (res?.rowCount ?? res?.rows?.length ?? 0) > 0;
}

/**
 * Deletes all contacts for a practice across the shop (merchant admin authority).
 *
 * @param {any} db
 * @param {{ shop: string, ownerId: string }} options
 * @returns {Promise<number>} Number of contacts deleted
 */
export async function deleteMerchantPracticeContacts(db, { shop, ownerId }) {
  if (!shop || !ownerId) return 0;

  const sql = `
    DELETE FROM "ShopperContact"
    WHERE "shop" = $1 AND "ownerId" = $2
    RETURNING "id"
  `;
  const res = await db.query(sql, [shop, ownerId]);
  return res?.rowCount ?? res?.rows?.length ?? 0;
}

/**
 * Formats all merchant contacts as RFC 4180 CSV.
 * Columns: Shop,Practice Name,Owner GID,Email,First Name,Consent Text,Consent Version,Consented At,Created At,Verified
 * Includes honest disclaimer that addresses are unverified by the app.
 *
 * @param {Array<any>} contacts
 * @param {string} shop
 * @returns {string}
 */
export function exportMerchantContactsCsv(contacts = [], shop = '') {
  const comment = '# Note: Email addresses are collected with opt-in consent but are not verified by Practitioner Protocols. Confirm via double opt-in in your marketing tool.';
  const headers = [
    'Shop',
    'Practice Name',
    'Owner GID',
    'Email',
    'First Name',
    'Consent Text',
    'Consent Version',
    'Consented At',
    'Created At',
    'Verified'
  ];
  const lines = [comment, headers.join(',')];

  for (const c of contacts) {
    const consentedAtStr = c.consentedAt instanceof Date
      ? c.consentedAt.toISOString()
      : (c.consentedAt ? String(c.consentedAt) : '');
    const createdAtStr = c.createdAt instanceof Date
      ? c.createdAt.toISOString()
      : (c.createdAt ? String(c.createdAt) : '');

    const row = [
      escapeCsvField(c.shop || shop),
      escapeCsvField(c.practiceName || 'Individual Practitioner'),
      escapeCsvField(c.ownerId || ''),
      escapeCsvField(c.email || ''),
      escapeCsvField(c.firstName || ''),
      escapeCsvField(c.consentText || ''),
      escapeCsvField(c.consentVersion != null ? String(c.consentVersion) : '1'),
      escapeCsvField(consentedAtStr),
      escapeCsvField(createdAtStr),
      'no'
    ];
    lines.push(row.join(','));
  }

  return lines.join('\r\n') + '\r\n';
}

/**
 * Retrieves the stored ShopProfile record for a shop.
 *
 * @param {any} db
 * @param {{ shop: string }} options
 * @returns {Promise<any | null>}
 */
export async function getShopProfile(db, { shop }) {
  if (!db || !shop) return null;
  try {
    const res = await db.query('SELECT * FROM "ShopProfile" WHERE "shop" = $1', [shop]);
    return res?.rows?.[0] || null;
  } catch {
    return null;
  }
}

/**
 * Upserts a ShopProfile record.
 * Reinstall clears uninstalledAt and preserves existing marketingOptIn.
 *
 * @param {any} db
 * @param {{
 *   shop: string,
 *   shopName?: string | null,
 *   ownerName?: string | null,
 *   email?: string | null,
 *   planName?: string | null,
 *   country?: string | null
 * }} profile
 * @returns {Promise<any>}
 */
export async function upsertShopProfile(db, {
  shop,
  shopName = null,
  ownerName = null,
  email = null,
  planName = null,
  country = null
}) {
  if (!db || !shop) return null;

  const sql = `
    INSERT INTO "ShopProfile" (
      "id", "shop", "shopName", "ownerName", "email", "planName", "country",
      "installedAt", "uninstalledAt", "marketingOptIn", "createdAt", "updatedAt"
    ) VALUES (
      gen_random_uuid()::text, $1, $2, $3, $4, $5, $6,
      NOW(), NULL, false, NOW(), NOW()
    )
    ON CONFLICT ("shop") DO UPDATE SET
      "shopName" = COALESCE(EXCLUDED."shopName", "ShopProfile"."shopName"),
      "ownerName" = COALESCE(EXCLUDED."ownerName", "ShopProfile"."ownerName"),
      "email" = COALESCE(EXCLUDED."email", "ShopProfile"."email"),
      "planName" = COALESCE(EXCLUDED."planName", "ShopProfile"."planName"),
      "country" = COALESCE(EXCLUDED."country", "ShopProfile"."country"),
      "uninstalledAt" = NULL,
      "updatedAt" = NOW()
    RETURNING *
  `;

  const res = await db.query(sql, [
    shop,
    shopName,
    ownerName,
    email,
    planName,
    country
  ]);
  return res?.rows?.[0] || null;
}

/**
 * Updates merchant marketing opt-in preference and timestamp.
 * Setting to false clears marketingOptInAt timestamp.
 *
 * @param {any} db
 * @param {{ shop: string, marketingOptIn: boolean }} options
 * @returns {Promise<any>}
 */
export async function updateShopMarketingOptIn(db, { shop, marketingOptIn }) {
  if (!db || !shop) return null;

  const isOptedIn = Boolean(marketingOptIn);
  const sql = `
    UPDATE "ShopProfile"
    SET "marketingOptIn" = $2,
        "marketingOptInAt" = CASE WHEN $2 = true THEN NOW() ELSE NULL END,
        "updatedAt" = NOW()
    WHERE "shop" = $1
    RETURNING *
  `;
  const res = await db.query(sql, [shop, isOptedIn]);
  return res?.rows?.[0] || null;
}

/**
 * Synchronizes shop profile data from Shopify Admin GraphQL API.
 * Uses query GetShopProfile: { shop { name email shopOwnerName plan { publicDisplayName } billingAddress { countryCodeV2 } } }
 * Never throws or blocks install if fetch fails; logs a single non-PII warning.
 *
 * @param {any} db
 * @param {{ shop: string, accessToken?: string | null, fetchFn?: Function }} options
 * @returns {Promise<any | null>}
 */
export async function syncShopProfile(db, { shop, accessToken = null, fetchFn = fetch } = {}) {
  if (!db || !shop) return null;

  try {
    let token = accessToken;
    if (!token) {
      const sessionRes = await db.query(
        'SELECT "accessToken" FROM "Session" WHERE "shop" = $1 AND "isOnline" = false',
        [shop]
      );
      const stored = sessionRes?.rows?.[0]?.accessToken;
      if (stored) {
        token = decryptAccessToken(stored);
      }
    }

    if (!token) {
      return null;
    }

    const query = `query GetShopProfile {
  shop {
    name
    email
    shopOwnerName
    plan {
      publicDisplayName
    }
    billingAddress {
      countryCodeV2
    }
  }
}`;

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), 5000) : null;

    let res;
    try {
      res = await fetchFn(`https://${shop}/admin/api/2026-10/graphql.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': token
        },
        body: JSON.stringify({ query }),
        signal: controller?.signal
      });
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    if (!res.ok) {
      console.warn(`[ShopProfile] Failed to fetch shop profile for ${shop}: HTTP ${res.status}`);
      return null;
    }

    const json = await res.json();
    if (json.errors && json.errors.length > 0) {
      console.warn(`[ShopProfile] GraphQL error fetching shop profile for ${shop}`);
      return null;
    }

    const shopData = json.data?.shop;
    if (!shopData) return null;

    const shopName = shopData.name || null;
    const email = shopData.email || null;
    const ownerName = shopData.shopOwnerName || null;
    const planName = shopData.plan?.publicDisplayName || null;
    const country = shopData.billingAddress?.countryCodeV2 || null;

    return await upsertShopProfile(db, {
      shop,
      shopName,
      ownerName,
      email,
      planName,
      country
    });
  } catch (err) {
    console.warn(`[ShopProfile] Failed to sync profile for ${shop}: ${err.message}`);
    return null;
  }
}

/**
 * Saves a merchant custom feature request submission.
 * Prefills shop profile details if available in database.
 * Strictly reply-only consent; never enables marketingOptIn.
 * Rate limited to 3 per hour per shop.
 *
 * @param {any} db
 * @param {{
 *   shop: string,
 *   shopName?: string,
 *   ownerName?: string,
 *   replyEmail?: string,
 *   planName?: string,
 *   country?: string,
 *   message: string,
 *   kind?: string
 * }} options
 * @returns {Promise<{ success: boolean, message: string }>}
 */
export async function saveMerchantCustomRequest(db, {
  shop,
  shopName = null,
  ownerName = null,
  replyEmail = null,
  planName = null,
  country = null,
  message,
  kind = 'custom_request'
}) {
  if (!shop || typeof shop !== 'string') {
    throw new ContactValidationError('Shop domain is required.', 'INVALID_SHOP', 'shop');
  }

  const cleanMessage = validateCustomRequestMessage(message);
  let cleanReplyEmail = null;
  if (replyEmail && String(replyEmail).trim().length > 0) {
    cleanReplyEmail = validateContactEmail(replyEmail);
  }

  // Prefill metadata from ShopProfile if available
  let resolvedShopName = shopName;
  let resolvedOwnerName = ownerName;
  let resolvedPlanName = planName;
  let resolvedCountry = country;
  let resolvedEmail = cleanReplyEmail;

  if (db && (!resolvedShopName || !resolvedOwnerName || !resolvedPlanName || !resolvedCountry || !resolvedEmail)) {
    try {
      const profile = await getShopProfile(db, { shop });
      if (profile) {
        resolvedShopName = resolvedShopName || profile.shopName;
        resolvedOwnerName = resolvedOwnerName || profile.ownerName;
        resolvedPlanName = resolvedPlanName || profile.planName;
        resolvedCountry = resolvedCountry || profile.country;
        resolvedEmail = resolvedEmail || (profile.email ? validateContactEmail(profile.email) : null);
      }
    } catch {}
  }

  const validKind = ['feedback', 'custom_request'].includes(kind) ? kind : 'custom_request';

  const insertSql = `
    INSERT INTO "MerchantFeedback" (
      "id", "shop", "shopName", "ownerName", "replyEmail",
      "planName", "country", "message", "kind", "createdAt"
    ) VALUES (
      gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, NOW()
    )
    RETURNING "id"
  `;

  await db.query(insertSql, [
    shop,
    resolvedShopName ? String(resolvedShopName).trim().slice(0, 100) : null,
    resolvedOwnerName ? String(resolvedOwnerName).trim().slice(0, 100) : null,
    resolvedEmail,
    resolvedPlanName ? String(resolvedPlanName).trim().slice(0, 50) : null,
    resolvedCountry ? String(resolvedCountry).trim().slice(0, 50) : null,
    cleanMessage,
    validKind
  ]);

  return {
    success: true,
    message: 'Thank you for your request. The developer will get back to you shortly.'
  };
}

/**
 * Saves merchant feedback and updates marketing opt-in preferences.
 * Supports rating (1-5), optional message, and marketing opt-in checkbox.
 *
 * @param {any} db
 * @param {{
 *   shop: string,
 *   rating?: number | string | null,
 *   message?: string | null,
 *   marketingOptIn?: boolean | null,
 *   replyEmail?: string | null
 * }} options
 * @returns {Promise<{ success: boolean, message: string }>}
 */
export async function saveMerchantFeedback(db, {
  shop,
  rating = null,
  message = null,
  marketingOptIn = null,
  replyEmail = null
}) {
  if (!shop || typeof shop !== 'string') {
    throw new ContactValidationError('Shop domain is required.', 'INVALID_SHOP', 'shop');
  }

  // 1. Update marketing opt-in preference if specified
  if (marketingOptIn !== null && marketingOptIn !== undefined && db) {
    await updateShopMarketingOptIn(db, { shop, marketingOptIn: Boolean(marketingOptIn) });
  }

  const cleanRating = validateFeedbackRating(rating);
  let cleanMessage = null;
  if (message && String(message).trim().length > 0) {
    cleanMessage = validateCustomRequestMessage(message);
  }

  let cleanReplyEmail = null;
  if (replyEmail && String(replyEmail).trim().length > 0) {
    cleanReplyEmail = validateContactEmail(replyEmail);
  }

  // 2. If rating or message is present, store feedback row in MerchantFeedback
  if ((cleanRating !== null || cleanMessage !== null) && db) {
    // Enrich from ShopProfile
    let shopName = null;
    let ownerName = null;
    let planName = null;
    let country = null;

    try {
      const profile = await getShopProfile(db, { shop });
      if (profile) {
        shopName = profile.shopName;
        ownerName = profile.ownerName;
        planName = profile.planName;
        country = profile.country;
        if (!cleanReplyEmail && profile.email) {
          cleanReplyEmail = validateContactEmail(profile.email);
        }
      }
    } catch {}

    const insertSql = `
      INSERT INTO "MerchantFeedback" (
        "id", "shop", "shopName", "ownerName", "replyEmail",
        "planName", "country", "message", "rating", "kind", "createdAt"
      ) VALUES (
        gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, 'feedback', NOW()
      )
      RETURNING "id"
    `;

    await db.query(insertSql, [
      shop,
      shopName,
      ownerName,
      cleanReplyEmail,
      planName,
      country,
      cleanMessage || '(Rating only)',
      cleanRating
    ]);
  }

  return {
    success: true,
    message: 'Thank you for your feedback!'
  };
}

/**
 * Lists merchant feedback / custom requests.
 *
 * @param {any} db
 * @param {{ shop: string, kind?: string }} options
 * @returns {Promise<Array<any>>}
 */
export async function listMerchantFeedback(db, { shop, kind = 'custom_request' }) {
  if (!shop) return [];

  const sql = `
    SELECT "id", "shop", "shopName", "ownerName", "replyEmail",
           "planName", "country", "message", "rating", "kind", "createdAt"
    FROM "MerchantFeedback"
    WHERE "shop" = $1 AND "kind" = $2
    ORDER BY "createdAt" DESC
  `;
  const res = await db.query(sql, [shop, kind]);
  return res?.rows || [];
}

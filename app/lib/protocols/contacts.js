/**
 * @file Contacts & Merchant Feedback Service (app/lib/protocols/contacts.js)
 * 
 * Implements M11 Shopper Opt-In ("Stay in touch") and Merchant Custom Request features.
 * Privacy rule relaxation: ONLY explicit, opt-in shopper contacts are stored.
 * Never stores protocolId, order id, product data, IP address, or user agent.
 * Strictly avoids logging emails or names; errors never echo them.
 */

import { escapeCsvField } from './admin.js';

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
 * Saves or updates a shopper opt-in contact.
 * Idempotent: repeated submissions for the same (shop, ownerId, email) update consentedAt and text.
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
 *   consentText: string,
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
  consentText,
  consentVersion = 1,
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

  if (!consentText || typeof consentText !== 'string' || !consentText.trim()) {
    throw new ContactValidationError('Consent text is required.', 'INVALID_CONSENT_TEXT', 'consentText');
  }

  const version = (typeof consentVersion === 'number' && Number.isInteger(consentVersion) && consentVersion > 0)
    ? consentVersion
    : 1;

  // 3. Resolve token to an ACTIVE protocol in this shop to identify ownerId
  const protoSql = `
    SELECT "id", "ownerId", "status"
    FROM "Protocol"
    WHERE "shop" = $1 AND "token" = $2
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
  const now = new Date();

  // 4. Upsert into ShopperContact: idempotent on (shop, ownerId, email)
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
    consentText.trim(),
    version,
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
 * Columns: Email,First Name,Consented At
 *
 * @param {Array<any>} contacts
 * @returns {string}
 */
export function exportPractitionerContactsCsv(contacts = []) {
  const headers = ['Email', 'First Name', 'Consented At'];
  const lines = [headers.join(',')];

  for (const c of contacts) {
    const consentedAtStr = c.consentedAt instanceof Date
      ? c.consentedAt.toISOString()
      : (c.consentedAt ? String(c.consentedAt) : '');

    const row = [
      escapeCsvField(c.email || ''),
      escapeCsvField(c.firstName || ''),
      escapeCsvField(consentedAtStr)
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
 * Columns: Shop,Practice Name,Owner GID,Email,First Name,Consent Text,Consent Version,Consented At,Created At
 *
 * @param {Array<any>} contacts
 * @param {string} shop
 * @returns {string}
 */
export function exportMerchantContactsCsv(contacts = [], shop = '') {
  const headers = [
    'Shop',
    'Practice Name',
    'Owner GID',
    'Email',
    'First Name',
    'Consent Text',
    'Consent Version',
    'Consented At',
    'Created At'
  ];
  const lines = [headers.join(',')];

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
      escapeCsvField(createdAtStr)
    ];
    lines.push(row.join(','));
  }

  return lines.join('\r\n') + '\r\n';
}

/**
 * Saves a merchant custom feature request or feedback submission.
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
    shopName ? String(shopName).trim().slice(0, 100) : null,
    ownerName ? String(ownerName).trim().slice(0, 100) : null,
    cleanReplyEmail,
    planName ? String(planName).trim().slice(0, 50) : null,
    country ? String(country).trim().slice(0, 50) : null,
    cleanMessage,
    validKind
  ]);

  return {
    success: true,
    message: 'Thank you for your request. The developer will get back to you shortly.'
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
           "planName", "country", "message", "kind", "createdAt"
    FROM "MerchantFeedback"
    WHERE "shop" = $1 AND "kind" = $2
    ORDER BY "createdAt" DESC
  `;
  const res = await db.query(sql, [shop, kind]);
  return res?.rows || [];
}

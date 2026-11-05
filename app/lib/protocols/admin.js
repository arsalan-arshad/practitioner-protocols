import crypto from 'node:crypto';
import { createProtocol, updateProtocol } from './service.js';

/**
 * Custom error class for merchant admin operations.
 */
export class ProtocolAdminError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {string} [field]
   */
  constructor(message, code, field) {
    super(message);
    this.name = 'ProtocolAdminError';
    this.code = code;
    this.field = field;
  }
}

export const ADMIN_ERROR_CODES = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  INVALID_INPUT: 'INVALID_INPUT',
  NOT_FOUND: 'NOT_FOUND',
  NOT_STARTER: 'NOT_STARTER',
  PII_NOT_ALLOWED: 'PII_NOT_ALLOWED'
};

export const SHOPIFY_DOMAIN_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/;

const PII_FORBIDDEN_KEY_PATTERN = /(?:patient|client|ssn|health|medical|diagnosis|condition)/i;
const PII_TEXT_PATTERN = /(?:patient\s*(?:name|id|email|phone|diagnosis|condition)|client\s*(?:name|id|email|phone|diagnosis)|patient\s+diagnosis|client\s+diagnosis|\bssn\b)/i;
const ALLOWED_IDENTITY_MODES = new Set(['tag', 'company']);

/**
 * Validates that an input object or string contains no client/patient PII.
 *
 * @param {any} data
 * @throws {ProtocolAdminError}
 */
export function assertNoPii(data) {
  if (!data) return;

  if (typeof data === 'string') {
    if (PII_TEXT_PATTERN.test(data)) {
      throw new ProtocolAdminError(
        'PII or clinical diagnostic terms are not allowed in app data.',
        ADMIN_ERROR_CODES.PII_NOT_ALLOWED
      );
    }
    return;
  }

  if (typeof data === 'object') {
    for (const [key, value] of Object.entries(data)) {
      if (PII_FORBIDDEN_KEY_PATTERN.test(key)) {
        throw new ProtocolAdminError(
          `Field '${key}' is strictly forbidden. Protocols and admin data must contain zero client PII.`,
          ADMIN_ERROR_CODES.PII_NOT_ALLOWED,
          key
        );
      }
      if (typeof value === 'string' && PII_TEXT_PATTERN.test(value)) {
        throw new ProtocolAdminError(
          'PII or clinical diagnostic terms are not allowed in app data.',
          ADMIN_ERROR_CODES.PII_NOT_ALLOWED,
          key
        );
      }
      if (typeof value === 'object' && value !== null) {
        assertNoPii(value);
      }
    }
  }
}

/**
 * Validates a practice name.
 * Merchant controls practice names to prevent impersonation.
 *
 * @param {string} name
 * @returns {string} Sanitized practice name
 */
export function validatePracticeName(name) {
  if (typeof name !== 'string') {
    throw new ProtocolAdminError('Practice name must be a string', ADMIN_ERROR_CODES.INVALID_INPUT, 'practiceName');
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new ProtocolAdminError('Practice name cannot be empty', ADMIN_ERROR_CODES.INVALID_INPUT, 'practiceName');
  }
  if (trimmed.length > 100) {
    throw new ProtocolAdminError('Practice name cannot exceed 100 characters', ADMIN_ERROR_CODES.INVALID_INPUT, 'practiceName');
  }
  assertNoPii(trimmed);
  return trimmed;
}

/**
 * Formats minor currency units (cents) into a 2-decimal string.
 *
 * @param {number | bigint | string} revenueMinor
 * @returns {string}
 */
export function formatRevenue(revenueMinor) {
  if (revenueMinor === null || revenueMinor === undefined) return '0.00';
  const val = Number(revenueMinor);
  if (isNaN(val)) return '0.00';
  return (val / 100).toFixed(2);
}

/**
 * Escapes a single field according to RFC 4180 rules.
 *
 * @param {any} val
 * @returns {string}
 */
export function escapeCsvField(val) {
  if (val === null || val === undefined) {
    return '';
  }
  const str = String(val);
  // RFC 4180: If field contains comma, quote, CR, or LF, wrap in double quotes and escape quotes as ""
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// ==========================================
// 1. Practitioner Approvals & Practice Names
// ==========================================

/**
 * Lists practitioner profiles for a shop with optional filtering.
 *
 * @param {any} db
 * @param {{
 *   shop: string,
 *   isApproved?: boolean,
 *   ownerType?: string,
 *   limit?: number,
 *   offset?: number
 * }} options
 */
export async function listPractitionerProfiles(db, { shop, isApproved, ownerType, limit = 50, offset = 0 }) {
  if (!shop) {
    throw new ProtocolAdminError('Shop domain is required', ADMIN_ERROR_CODES.INVALID_INPUT, 'shop');
  }

  let sql = `
    SELECT
      id,
      shop,
      "ownerType",
      "ownerGid",
      "practiceName",
      "logoUrl",
      "isApproved",
      "createdAt",
      "updatedAt"
    FROM "PractitionerProfile"
    WHERE shop = $1
  `;
  const params = [shop];

  if (typeof isApproved === 'boolean') {
    params.push(isApproved);
    sql += ` AND "isApproved" = $${params.length}`;
  }

  if (ownerType) {
    params.push(ownerType);
    sql += ` AND "ownerType" = $${params.length}`;
  }

  sql += ` ORDER BY "createdAt" DESC`;

  const countSql = `SELECT COUNT(*) as total FROM (${sql}) as filtered`;
  const countRes = await db.query(countSql, params);
  const total = parseInt(countRes.rows[0]?.total || 0, 10);

  params.push(limit);
  sql += ` LIMIT $${params.length}`;
  params.push(offset);
  sql += ` OFFSET $${params.length}`;

  const res = await db.query(sql, params);
  return {
    profiles: res.rows,
    total
  };
}

/**
 * Gets a practitioner profile by shop and ownerGid.
 *
 * @param {any} db
 * @param {{ shop: string, ownerGid: string }} options
 */
export async function getPractitionerProfile(db, { shop, ownerGid }) {
  if (!shop || !ownerGid) {
    throw new ProtocolAdminError('Shop and ownerGid are required', ADMIN_ERROR_CODES.INVALID_INPUT);
  }

  const sql = `
    SELECT
      id,
      shop,
      "ownerType",
      "ownerGid",
      "practiceName",
      "logoUrl",
      "isApproved",
      "createdAt",
      "updatedAt"
    FROM "PractitionerProfile"
    WHERE shop = $1 AND "ownerGid" = $2
  `;
  const res = await db.query(sql, [shop, ownerGid]);
  return res.rows[0] || null;
}

/**
 * Updates a practitioner's practice name. Merchant-controlled to prevent impersonation.
 *
 * @param {any} db
 * @param {{ shop: string, ownerGid: string, practiceName: string }} options
 */
export async function updatePracticeName(db, { shop, ownerGid, practiceName }) {
  if (!shop || !ownerGid) {
    throw new ProtocolAdminError('Shop and ownerGid are required', ADMIN_ERROR_CODES.INVALID_INPUT);
  }

  const sanitizedName = validatePracticeName(practiceName);

  const sql = `
    UPDATE "PractitionerProfile"
    SET "practiceName" = $1, "updatedAt" = NOW()
    WHERE shop = $2 AND "ownerGid" = $3
    RETURNING *
  `;
  const res = await db.query(sql, [sanitizedName, shop, ownerGid]);
  if (res.rows.length === 0) {
    throw new ProtocolAdminError('Practitioner profile not found', ADMIN_ERROR_CODES.NOT_FOUND);
  }
  return res.rows[0];
}

/**
 * Sets the approval status of a practitioner profile.
 *
 * @param {any} db
 * @param {{ shop: string, ownerGid: string, isApproved: boolean }} options
 */
export async function setPractitionerApproval(db, { shop, ownerGid, isApproved }) {
  if (!shop || !ownerGid) {
    throw new ProtocolAdminError('Shop and ownerGid are required', ADMIN_ERROR_CODES.INVALID_INPUT);
  }
  if (typeof isApproved !== 'boolean') {
    throw new ProtocolAdminError('isApproved must be a boolean', ADMIN_ERROR_CODES.INVALID_INPUT, 'isApproved');
  }

  const sql = `
    UPDATE "PractitionerProfile"
    SET "isApproved" = $1, "updatedAt" = NOW()
    WHERE shop = $2 AND "ownerGid" = $3
    RETURNING *
  `;
  const res = await db.query(sql, [isApproved, shop, ownerGid]);
  if (res.rows.length === 0) {
    throw new ProtocolAdminError('Practitioner profile not found', ADMIN_ERROR_CODES.NOT_FOUND);
  }
  return res.rows[0];
}

/**
 * Approves a practitioner profile.
 *
 * @param {any} db
 * @param {{ shop: string, ownerGid: string }} options
 */
export async function approvePractitioner(db, { shop, ownerGid }) {
  return setPractitionerApproval(db, { shop, ownerGid, isApproved: true });
}

/**
 * Revokes approval from a practitioner profile.
 *
 * @param {any} db
 * @param {{ shop: string, ownerGid: string }} options
 */
export async function revokePractitioner(db, { shop, ownerGid }) {
  return setPractitionerApproval(db, { shop, ownerGid, isApproved: false });
}

/**
 * Upserts a practitioner profile (create or update).
 *
 * @param {any} db
 * @param {{
 *   shop: string,
 *   ownerGid: string,
 *   practiceName: string,
 *   ownerType?: string,
 *   isApproved?: boolean,
 *   logoUrl?: string | null
 * }} options
 */
export async function upsertPractitionerProfile(db, {
  shop,
  ownerGid,
  practiceName,
  ownerType = 'customer',
  isApproved = true,
  logoUrl = null
}) {
  if (!shop || !ownerGid) {
    throw new ProtocolAdminError('Shop and ownerGid are required', ADMIN_ERROR_CODES.INVALID_INPUT);
  }
  const sanitizedName = validatePracticeName(practiceName);
  const sanitizedType = ownerType === 'company' ? 'company' : 'customer';

  const sql = `
    INSERT INTO "PractitionerProfile" (
      "id", "shop", "ownerType", "ownerGid", "practiceName", "logoUrl", "isApproved", "createdAt", "updatedAt"
    ) VALUES (
      gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, NOW(), NOW()
    )
    ON CONFLICT ("shop", "ownerGid")
    DO UPDATE SET
      "practiceName" = EXCLUDED."practiceName",
      "ownerType" = EXCLUDED."ownerType",
      "logoUrl" = COALESCE(EXCLUDED."logoUrl", "PractitionerProfile"."logoUrl"),
      "isApproved" = EXCLUDED."isApproved",
      "updatedAt" = NOW()
    RETURNING *
  `;

  const res = await db.query(sql, [
    shop,
    sanitizedType,
    ownerGid,
    sanitizedName,
    logoUrl,
    Boolean(isApproved)
  ]);
  return res.rows[0];
}

// ==========================================
// 2. Starter Templates Management
// ==========================================

/**
 * Lists starter templates for a given shop.
 *
 * @param {any} db
 * @param {{ shop: string, status?: string | null }} options
 */
export async function listStarterTemplates(db, { shop, status = null }) {
  if (!shop) {
    throw new ProtocolAdminError('Shop domain is required', ADMIN_ERROR_CODES.INVALID_INPUT, 'shop');
  }

  let sql = `
    SELECT p.*,
      COALESCE(
        json_agg(
          json_build_object(
            'id', pl.id,
            'position', pl.position,
            'variantGid', pl."variantGid",
            'quantity', pl.quantity,
            'usageNote', pl."usageNote"
          ) ORDER BY pl.position ASC
        ) FILTER (WHERE pl.id IS NOT NULL), '[]'
      ) as lines
    FROM "Protocol" p
    LEFT JOIN "ProtocolLine" pl ON p.id = pl."protocolId"
    WHERE p.shop = $1 AND p."isStarter" = true
  `;
  const params = [shop];

  if (status && status !== 'all') {
    params.push(status);
    sql += ` AND p.status = $${params.length}`;
  }

  sql += ` GROUP BY p.id ORDER BY p."createdAt" DESC`;

  const res = await db.query(sql, params);
  return res.rows;
}

/**
 * Creates a brand starter template (isStarter = true).
 *
 * @param {any} db
 * @param {{
 *   shop: string,
 *   adminUser?: { id: string, role?: string },
 *   input: any
 * }} options
 */
export async function createStarterTemplate(db, { shop, adminUser, input }) {
  if (adminUser && adminUser.role !== 'admin') {
    throw new ProtocolAdminError('Admin privileges required to create starter templates', ADMIN_ERROR_CODES.UNAUTHORIZED);
  }

  assertNoPii(input);

  const effectiveAdmin = adminUser || { id: 'admin', role: 'admin' };
  const starterInput = {
    ...input,
    isStarter: true,
    ownerType: input.ownerType || 'company',
    ownerId: input.ownerId || 'brand'
  };

  return createProtocol(db, {
    shop,
    user: {
      id: effectiveAdmin.id,
      role: 'admin',
      ownerType: starterInput.ownerType,
      ownerId: starterInput.ownerId
    },
    input: starterInput
  });
}

/**
 * Updates an existing starter template.
 *
 * @param {any} db
 * @param {{
 *   shop: string,
 *   adminUser?: { id: string, role?: string },
 *   protocolId: string,
 *   input: any
 * }} options
 */
export async function updateStarterTemplate(db, { shop, adminUser, protocolId, input }) {
  if (adminUser && adminUser.role !== 'admin') {
    throw new ProtocolAdminError('Admin privileges required to update starter templates', ADMIN_ERROR_CODES.UNAUTHORIZED);
  }

  assertNoPii(input);

  const protoRes = await db.query(
    'SELECT id, "isStarter" FROM "Protocol" WHERE shop = $1 AND id = $2',
    [shop, protocolId]
  );

  if (protoRes.rows.length === 0) {
    throw new ProtocolAdminError('Starter template not found', ADMIN_ERROR_CODES.NOT_FOUND);
  }

  if (!protoRes.rows[0].isStarter) {
    throw new ProtocolAdminError('Target protocol is not a starter template', ADMIN_ERROR_CODES.NOT_STARTER);
  }

  const effectiveAdmin = adminUser || { id: 'admin', role: 'admin' };
  return updateProtocol(db, {
    shop,
    user: { id: effectiveAdmin.id, role: 'admin' },
    protocolId,
    input
  });
}

// ==========================================
// 3. Storewide Emergency Disable Control
// ==========================================

/**
 * Emergency disables a specific protocol.
 * Overrides everything and immediately cuts off client access.
 *
 * @param {any} db
 * @param {{ shop: string, protocolId: string, adminUser?: { id: string, role?: string } }} options
 */
export async function emergencyDisableProtocol(db, { shop, protocolId, adminUser }) {
  if (adminUser && adminUser.role !== 'admin') {
    throw new ProtocolAdminError('Admin privileges required to disable protocols', ADMIN_ERROR_CODES.UNAUTHORIZED);
  }

  const updatedBy = adminUser?.id || 'admin';
  const sql = `
    UPDATE "Protocol"
    SET "status" = 'disabled', "updatedBy" = $1, "updatedAt" = NOW()
    WHERE shop = $2 AND id = $3
    RETURNING *
  `;
  const res = await db.query(sql, [updatedBy, shop, protocolId]);
  if (res.rows.length === 0) {
    throw new ProtocolAdminError('Protocol not found', ADMIN_ERROR_CODES.NOT_FOUND);
  }
  return res.rows[0];
}

/**
 * Storewide emergency disable: disables ALL protocols for a shop immediately.
 *
 * @param {any} db
 * @param {{ shop: string, adminUser?: { id: string, role?: string } }} options
 */
export async function emergencyDisableAllProtocols(db, { shop, adminUser }) {
  if (adminUser && adminUser.role !== 'admin') {
    throw new ProtocolAdminError('Admin privileges required for storewide emergency disable', ADMIN_ERROR_CODES.UNAUTHORIZED);
  }

  const updatedBy = adminUser?.id || 'admin';
  const sql = `
    UPDATE "Protocol"
    SET "status" = 'disabled', "updatedBy" = $1, "updatedAt" = NOW()
    WHERE shop = $2 AND "status" != 'disabled'
    RETURNING id
  `;
  const res = await db.query(sql, [updatedBy, shop]);
  return {
    disabledCount: res.rowCount ?? res.rows.length
  };
}

/**
 * Restores a disabled protocol back to active.
 *
 * @param {any} db
 * @param {{ shop: string, protocolId: string, adminUser?: { id: string, role?: string } }} options
 */
export async function restoreDisabledProtocol(db, { shop, protocolId, adminUser }) {
  if (adminUser && adminUser.role !== 'admin') {
    throw new ProtocolAdminError('Admin privileges required to restore disabled protocols', ADMIN_ERROR_CODES.UNAUTHORIZED);
  }

  const updatedBy = adminUser?.id || 'admin';
  const sql = `
    UPDATE "Protocol"
    SET "status" = 'active', "updatedBy" = $1, "updatedAt" = NOW()
    WHERE shop = $2 AND id = $3
    RETURNING *
  `;
  const res = await db.query(sql, [updatedBy, shop, protocolId]);
  if (res.rows.length === 0) {
    throw new ProtocolAdminError('Protocol not found', ADMIN_ERROR_CODES.NOT_FOUND);
  }
  return res.rows[0];
}

// ==========================================
// 4. Settings Management
// ==========================================

/**
 * Retrieves shop-level settings, returning defaults if not yet configured.
 *
 * @param {any} db
 * @param {{ shop: string }} options
 */
export async function getSettings(db, { shop }) {
  if (!shop) {
    throw new ProtocolAdminError('Shop domain is required', ADMIN_ERROR_CODES.INVALID_INPUT, 'shop');
  }

  const sql = `
    SELECT "shop", "identityMode", "allowSelfEnrol", "footerDisclaimer", "handoutText", "createdAt", "updatedAt"
    FROM "Setting"
    WHERE "shop" = $1
  `;
  const res = await db.query(sql, [shop]);
  if (res.rows.length > 0) {
    const row = res.rows[0];
    return {
      ...row,
      allowSelfEnrol: Boolean(row.allowSelfEnrol)
    };
  }

  return {
    shop,
    identityMode: 'tag',
    allowSelfEnrol: false,
    footerDisclaimer: null,
    handoutText: null
  };
}

/**
 * Updates shop-level settings (identity mode, footer disclaimer, handout instructions).
 *
 * @param {any} db
 * @param {{
 *   shop: string,
 *   settings: {
 *     identityMode?: string,
 *     footerDisclaimer?: string | null,
 *     handoutText?: string | null
 *   },
 *   adminUser?: { id: string, role?: string }
 * }} options
 */
export async function updateSettings(db, { shop, settings, adminUser }) {
  if (!shop) {
    throw new ProtocolAdminError('Shop domain is required', ADMIN_ERROR_CODES.INVALID_INPUT, 'shop');
  }
  if (adminUser && adminUser.role !== 'admin') {
    throw new ProtocolAdminError('Admin privileges required to update settings', ADMIN_ERROR_CODES.UNAUTHORIZED);
  }
  if (!settings || typeof settings !== 'object') {
    throw new ProtocolAdminError('Settings must be an object', ADMIN_ERROR_CODES.INVALID_INPUT, 'settings');
  }

  assertNoPii(settings);

  // 1. identityMode
  const rawMode = settings.identityMode !== undefined ? settings.identityMode : settings.mode;
  const hasMode = rawMode !== undefined;
  let modeVal = null;
  if (hasMode) {
    if (!ALLOWED_IDENTITY_MODES.has(rawMode)) {
      throw new ProtocolAdminError(
        `Invalid identityMode '${rawMode}'. Must be 'tag' or 'company'.`,
        ADMIN_ERROR_CODES.INVALID_INPUT,
        'identityMode'
      );
    }
    modeVal = rawMode;
  }

  // 2. allowSelfEnrol
  const hasAllowSelfEnrol = settings.allowSelfEnrol !== undefined;
  let selfEnrolVal = null;
  if (hasAllowSelfEnrol) {
    if (typeof settings.allowSelfEnrol === 'boolean') {
      selfEnrolVal = settings.allowSelfEnrol;
    } else if (Array.isArray(settings.allowSelfEnrol)) {
      const lastVal = settings.allowSelfEnrol[settings.allowSelfEnrol.length - 1];
      const lower = String(lastVal).trim().toLowerCase();
      selfEnrolVal = ['true', '1', 'on'].includes(lower);
    } else {
      const lower = String(settings.allowSelfEnrol).trim().toLowerCase();
      selfEnrolVal = ['true', '1', 'on'].includes(lower);
    }
  }

  // 3. footerDisclaimer
  const rawFooter = settings.footerDisclaimer !== undefined ? settings.footerDisclaimer : settings.disclaimer;
  const hasFooter = rawFooter !== undefined;
  let footerVal = null;
  if (hasFooter) {
    footerVal = rawFooter ? String(rawFooter).trim() : null;
    if (footerVal && footerVal.length > 1000) {
      throw new ProtocolAdminError('Footer disclaimer cannot exceed 1000 characters', ADMIN_ERROR_CODES.INVALID_INPUT, 'footerDisclaimer');
    }
  }

  // 4. handoutText
  const rawHandout = settings.handoutText;
  const hasHandout = rawHandout !== undefined;
  let handoutVal = null;
  if (hasHandout) {
    handoutVal = rawHandout ? String(rawHandout).trim() : null;
    if (handoutVal && handoutVal.length > 1000) {
      throw new ProtocolAdminError('Handout text cannot exceed 1000 characters', ADMIN_ERROR_CODES.INVALID_INPUT, 'handoutText');
    }
  }

  const sql = `
    INSERT INTO "Setting" (
      "shop", "identityMode", "allowSelfEnrol", "footerDisclaimer", "handoutText", "createdAt", "updatedAt"
    ) VALUES (
      $1,
      COALESCE($2, 'tag'),
      COALESCE($4, false),
      $6,
      $8,
      NOW(),
      NOW()
    )
    ON CONFLICT ("shop")
    DO UPDATE SET
      "identityMode" = CASE WHEN $3 THEN $2 ELSE "Setting"."identityMode" END,
      "allowSelfEnrol" = CASE WHEN $5 THEN $4 ELSE "Setting"."allowSelfEnrol" END,
      "footerDisclaimer" = CASE WHEN $7 THEN $6 ELSE "Setting"."footerDisclaimer" END,
      "handoutText" = CASE WHEN $9 THEN $8 ELSE "Setting"."handoutText" END,
      "updatedAt" = NOW()
    RETURNING *
  `;

  const res = await db.query(sql, [
    shop,
    modeVal,
    hasMode,
    selfEnrolVal,
    hasAllowSelfEnrol,
    footerVal,
    hasFooter,
    handoutVal,
    hasHandout
  ]);
  const row = res.rows[0];
  return {
    ...row,
    allowSelfEnrol: Boolean(row?.allowSelfEnrol)
  };
}

// ==========================================
// 5. Attribution Reports & RFC 4180 CSV Export
// ==========================================

/**
 * Queries aggregate monthly attribution stats with practice and protocol rollups.
 * Strictly aggregate data with zero client PII.
 *
 * @param {any} db
 * @param {{
 *   shop: string,
 *   month?: string,
 *   ownerId?: string,
 *   protocolId?: string
 * }} options
 */
export async function getAttributionReport(db, { shop, month, ownerId, protocolId }) {
  if (!shop) {
    throw new ProtocolAdminError('Shop domain is required', ADMIN_ERROR_CODES.INVALID_INPUT, 'shop');
  }

  let sql = `
    SELECT
      s.month,
      s."protocolId",
      COALESCE(p.name, 'Unknown Protocol') as "protocolName",
      COALESCE(p."isStarter", false) as "isStarter",
      p."sourceProtocolId",
      s."ownerId",
      COALESCE(prof."practiceName", 'Unknown Practice') as "practiceName",
      s.orders,
      s.units,
      s."revenueMinor",
      s.currency
    FROM "ProtocolOrderStat" s
    LEFT JOIN "Protocol" p ON (s.shop = p.shop AND s."protocolId" = p.id)
    LEFT JOIN "PractitionerProfile" prof ON (s.shop = prof.shop AND s."ownerId" = prof."ownerGid")
    WHERE s.shop = $1
  `;
  const params = [shop];

  if (month) {
    params.push(month);
    sql += ` AND s.month = $${params.length}`;
  }
  if (ownerId) {
    params.push(ownerId);
    sql += ` AND s."ownerId" = $${params.length}`;
  }
  if (protocolId) {
    params.push(protocolId);
    sql += ` AND s."protocolId" = $${params.length}`;
  }

  sql += ` ORDER BY s.month DESC, s."revenueMinor" DESC`;

  const res = await db.query(sql, params);
  const rows = res.rows;

  let totalOrders = 0;
  let totalUnits = 0;
  let totalRevenueMinor = 0;
  const currency = rows[0]?.currency || 'USD';

  const practiceMap = new Map();
  const protocolMap = new Map();

  for (const row of rows) {
    const orders = Number(row.orders) || 0;
    const units = Number(row.units) || 0;
    const revenueMinor = Number(row.revenueMinor) || 0;

    totalOrders += orders;
    totalUnits += units;
    totalRevenueMinor += revenueMinor;

    // Rollup by Practice
    const practiceKey = row.ownerId || 'unknown';
    const practiceStat = practiceMap.get(practiceKey) || {
      ownerId: row.ownerId,
      practiceName: row.practiceName,
      orders: 0,
      units: 0,
      revenueMinor: 0
    };
    practiceStat.orders += orders;
    practiceStat.units += units;
    practiceStat.revenueMinor += revenueMinor;
    practiceMap.set(practiceKey, practiceStat);

    // Rollup by Protocol
    const protoKey = row.protocolId || 'unknown';
    const protoStat = protocolMap.get(protoKey) || {
      protocolId: row.protocolId,
      protocolName: row.protocolName,
      isStarter: row.isStarter,
      sourceProtocolId: row.sourceProtocolId,
      orders: 0,
      units: 0,
      revenueMinor: 0
    };
    protoStat.orders += orders;
    protoStat.units += units;
    protoStat.revenueMinor += revenueMinor;
    protocolMap.set(protoKey, protoStat);
  }

  const byPractice = Array.from(practiceMap.values()).map(p => ({
    ...p,
    revenueFormatted: formatRevenue(p.revenueMinor),
    currency
  }));

  const byProtocol = Array.from(protocolMap.values()).map(p => ({
    ...p,
    revenueFormatted: formatRevenue(p.revenueMinor),
    currency
  }));

  return {
    rows,
    summary: {
      totalOrders,
      totalUnits,
      totalRevenueMinor,
      totalRevenueFormatted: formatRevenue(totalRevenueMinor),
      currency
    },
    byPractice,
    byProtocol
  };
}

/**
 * Formats attribution report rows into an RFC 4180 compliant CSV string.
 *
 * @param {Array<any> | { rows: Array<any> }} reportData
 * @returns {string} RFC 4180 formatted CSV
 */
export function formatAttributionCsv(reportData) {
  const rows = Array.isArray(reportData) ? reportData : (reportData?.rows || []);

  const headers = [
    'Month',
    'Practice Name',
    'Owner GID',
    'Protocol ID',
    'Protocol Name',
    'Is Starter',
    'Orders',
    'Units',
    'Revenue',
    'Currency'
  ];

  const headerLine = headers.map(escapeCsvField).join(',');
  const lines = [headerLine];

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;

    // Strict PII Barrier Check
    assertNoPii(row);

    const month = row.month || '';
    const practiceName = row.practiceName || '';
    const ownerId = row.ownerId || '';
    const protocolId = row.protocolId || '';
    const protocolName = row.protocolName || '';
    const isStarter = row.isStarter ? 'true' : 'false';
    const orders = typeof row.orders === 'number' ? row.orders : (parseInt(row.orders, 10) || 0);
    const units = typeof row.units === 'number' ? row.units : (parseInt(row.units, 10) || 0);

    let revenue = '0.00';
    if (row.revenueMinor !== undefined && row.revenueMinor !== null) {
      revenue = formatRevenue(row.revenueMinor);
    } else if (row.revenueFormatted !== undefined) {
      revenue = String(row.revenueFormatted);
    } else if (row.revenue !== undefined) {
      const parsed = parseFloat(row.revenue);
      revenue = isNaN(parsed) ? '0.00' : parsed.toFixed(2);
    }

    const currency = row.currency || 'USD';

    const line = [
      escapeCsvField(month),
      escapeCsvField(practiceName),
      escapeCsvField(ownerId),
      escapeCsvField(protocolId),
      escapeCsvField(protocolName),
      escapeCsvField(isStarter),
      escapeCsvField(orders),
      escapeCsvField(units),
      escapeCsvField(revenue),
      escapeCsvField(currency)
    ].join(',');

    lines.push(line);
  }

  // RFC 4180 standard CRLF record separator
  return lines.join('\r\n') + '\r\n';
}

/**
 * Fetches and exports aggregate monthly attribution as an RFC 4180 CSV string.
 *
 * @param {any} db
 * @param {{
 *   shop: string,
 *   month?: string,
 *   ownerId?: string,
 *   protocolId?: string
 * }} options
 * @returns {Promise<string>}
 */
export async function exportAttributionCsv(db, options) {
  const report = await getAttributionReport(db, options);
  return formatAttributionCsv(report);
}

/**
 * Escapes HTML characters in a string.
 *
 * @param {string} str
 * @returns {string}
 */
export function escapeAdminText(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ==========================================
// 6. Shopify Admin Session Token Verification
// ==========================================

/**
 * Creates a signed HS256 admin session token (JWT) for testing or session issuance.
 * Format follows Shopify App Bridge session token specification.
 *
 * @param {{
 *   userId?: string,
 *   shop: string,
 *   apiKey?: string,
 *   expiresInSec?: number
 * }} claims
 * @param {string} apiSecret
 * @returns {string} Signed JWT
 */
export function createAdminSessionToken(claims, apiSecret) {
  if (!apiSecret || typeof apiSecret !== 'string') {
    throw new Error('apiSecret required to create session token');
  }
  const {
    userId = 'gid://shopify/User/1',
    shop,
    apiKey = 'test_api_key',
    expiresInSec = 3600,
    iss,
    aud
  } = claims;

  if (!shop) {
    throw new Error('shop is required to create session token');
  }

  const cleanShop = shop.replace(/^https?:\/\//, '').split('/')[0];
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: iss !== undefined ? iss : `https://${cleanShop}/admin`,
    dest: `https://${cleanShop}`,
    aud: aud !== undefined ? aud : apiKey,
    sub: userId,
    exp: now + expiresInSec,
    nbf: now,
    iat: now,
    jti: crypto.randomBytes(16).toString('hex')
  };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${headerB64}.${payloadB64}`;
  const signatureB64 = crypto.createHmac('sha256', apiSecret).update(signingInput).digest('base64url');

  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

/**
 * Verifies a Shopify App Bridge Admin session token (JWT signed with HS256).
 * Validates cryptographic signature, expiry, active window, destination shop, and audience.
 *
 * @param {string} token
 * @param {{
 *   apiSecret: string,
 *   apiKey?: string,
 *   expectedShop?: string,
 *   clockToleranceSec?: number
 * }} options
 * @returns {{ userId: string, shop: string, role: string, payload: any }}
 * @throws {ProtocolAdminError}
 */
export function verifyAdminSessionToken(token, options = {}) {
  const { apiSecret, apiKey, expectedShop, clockToleranceSec = 10 } = options;

  if (!apiSecret || typeof apiSecret !== 'string') {
    throw new ProtocolAdminError(
      'Server configuration error: missing API secret for admin verification',
      ADMIN_ERROR_CODES.UNAUTHORIZED
    );
  }

  if (!token || typeof token !== 'string') {
    throw new ProtocolAdminError(
      'Unauthorized: Missing or empty admin session token',
      ADMIN_ERROR_CODES.UNAUTHORIZED
    );
  }

  const parts = token.trim().split('.');
  if (parts.length !== 3) {
    throw new ProtocolAdminError(
      'Unauthorized: Malformed JWT token structure',
      ADMIN_ERROR_CODES.UNAUTHORIZED
    );
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // 1. Verify HS256 HMAC signature using crypto.timingSafeEqual
  const signingInput = `${headerB64}.${payloadB64}`;
  const expectedSigB64 = crypto.createHmac('sha256', apiSecret).update(signingInput).digest('base64url');

  const expectedSigBuf = Buffer.from(expectedSigB64);
  const actualSigBuf = Buffer.from(signatureB64);

  if (expectedSigBuf.length !== actualSigBuf.length || !crypto.timingSafeEqual(expectedSigBuf, actualSigBuf)) {
    throw new ProtocolAdminError(
      'Unauthorized: Invalid session token signature',
      ADMIN_ERROR_CODES.UNAUTHORIZED
    );
  }

  // 2. Decode header and payload
  let header, payload;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    throw new ProtocolAdminError(
      'Unauthorized: Failed to decode session token payload',
      ADMIN_ERROR_CODES.UNAUTHORIZED
    );
  }

  if (header?.alg !== 'HS256') {
    throw new ProtocolAdminError(
      `Unauthorized: Unsupported token algorithm '${header?.alg}'`,
      ADMIN_ERROR_CODES.UNAUTHORIZED
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);

  // 3. Expiration checks
  if (typeof payload.exp !== 'number' || nowSec > payload.exp + clockToleranceSec) {
    throw new ProtocolAdminError(
      'Unauthorized: Admin session token has expired',
      ADMIN_ERROR_CODES.UNAUTHORIZED
    );
  }

  if (typeof payload.nbf === 'number' && nowSec < payload.nbf - clockToleranceSec) {
    throw new ProtocolAdminError(
      'Unauthorized: Admin session token is not active yet',
      ADMIN_ERROR_CODES.UNAUTHORIZED
    );
  }

  // 4. Shop / Dest and Issuer verification
  let shopFromDest = '';
  if (payload.dest) {
    try {
      shopFromDest = new URL(payload.dest).hostname;
    } catch {
      shopFromDest = String(payload.dest).replace(/^https?:\/\//, '').split('/')[0];
    }
  }

  let hostFromIss = '';
  if (payload.iss) {
    try {
      hostFromIss = new URL(payload.iss).hostname;
    } catch {
      hostFromIss = String(payload.iss).replace(/^https?:\/\//, '').split('/')[0];
    }
  }

  const normDestHost = (shopFromDest || '').toLowerCase().trim();
  const normIssHost = (hostFromIss || '').toLowerCase().trim();

  if (!normIssHost || !normDestHost || normIssHost !== normDestHost) {
    throw new ProtocolAdminError(
      `Unauthorized: Token issuer host '${normIssHost}' does not match destination host '${normDestHost}'`,
      ADMIN_ERROR_CODES.UNAUTHORIZED
    );
  }

  if (expectedShop) {
    const normExpected = expectedShop.toLowerCase().replace(/^https?:\/\//, '').split('/')[0].trim();
    if (normDestHost && normDestHost !== normExpected) {
      throw new ProtocolAdminError(
        `Forbidden: Token destination '${normDestHost}' does not match expected shop '${normExpected}'`,
        ADMIN_ERROR_CODES.FORBIDDEN
      );
    }
  }

  // 5. Audience verification: when apiKey is configured, require payload.aud to be present and match apiKey
  if (apiKey) {
    if (!payload.aud || payload.aud !== apiKey) {
      throw new ProtocolAdminError(
        `Unauthorized: Token audience '${payload.aud || ''}' does not match expected client ID`,
        ADMIN_ERROR_CODES.UNAUTHORIZED
      );
    }
  }

  return {
    userId: payload.sub || 'gid://shopify/User/admin',
    shop: shopFromDest || expectedShop || '',
    role: 'admin',
    payload
  };
}

/**
 * Extracts and verifies the admin session from an incoming Request, URL, or headers container.
 * Inspects Authorization: Bearer <jwt>, query parameters (id_token, session), or permits demo preview.
 *
 * @param {any} req
 * @param {{
 *   apiSecret?: string,
 *   apiKey?: string,
 *   expectedShop?: string,
 *   isDemoMode?: boolean
 * }} [options={}]
 * @returns {{ userId: string, shop: string, role: string, isDemo?: boolean }}
 */
export function extractAdminSession(req, options = {}) {
  const { apiSecret, apiKey, expectedShop, isDemoMode = false } = options;

  let authHeader = null;
  let queryToken = null;
  let shopParam = expectedShop || null;

  if (req) {
    // Check headers
    if (req.headers) {
      if (typeof req.headers.get === 'function') {
        authHeader = req.headers.get('authorization') || req.headers.get('Authorization');
      } else {
        for (const [k, v] of Object.entries(req.headers)) {
          if (k.toLowerCase() === 'authorization') {
            authHeader = Array.isArray(v) ? v[0] : String(v);
            break;
          }
        }
      }
    }

    // Check query params
    let urlObj = null;
    if (typeof req === 'string') {
      try { urlObj = new URL(req, 'https://admin.test'); } catch {}
    } else if (req.url && typeof req.url === 'string') {
      try { urlObj = new URL(req.url, 'https://admin.test'); } catch {}
    } else if (req instanceof URL) {
      urlObj = req;
    }

    if (urlObj) {
      queryToken = urlObj.searchParams.get('id_token') || urlObj.searchParams.get('session');
      if (!shopParam) {
        shopParam = urlObj.searchParams.get('shop');
      }
    } else if (req.query) {
      queryToken = req.query.id_token || req.query.session;
      if (!shopParam) shopParam = req.query.shop;
    }
  }

  let rawToken = null;
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    rawToken = authHeader.slice(7).trim();
  } else if (queryToken) {
    rawToken = queryToken.trim();
  }

  if (rawToken) {
    if (!apiSecret) {
      throw new ProtocolAdminError(
        'Server configuration error: missing API secret for admin verification',
        ADMIN_ERROR_CODES.UNAUTHORIZED
      );
    }
    return verifyAdminSessionToken(rawToken, {
      apiSecret,
      apiKey,
      expectedShop: shopParam || expectedShop
    });
  }

  // Demo fallback
  if (isDemoMode) {
    return {
      userId: 'gid://shopify/User/demo_admin',
      shop: shopParam || expectedShop || 'practitioner-store.myshopify.com',
      role: 'admin',
      isDemo: true
    };
  }

  throw new ProtocolAdminError(
    'Unauthorized: Missing required Shopify Admin session token (Bearer token or id_token parameter)',
    ADMIN_ERROR_CODES.UNAUTHORIZED
  );
}

// ==========================================
// 7. Embedded Polaris Admin UI (Milestone M6 / M9a)
// ==========================================

/**
 * Renders the minimal Shopify App Bridge bootstrap page for embedded apps.
 * In production mode inside the Shopify admin iframe, this page loads App Bridge from CDN,
 * retrieves an ID token via window.shopify.idToken(), and reloads the current URL with ?id_token=<token>.
 *
 * @param {{ apiKey?: string, shop?: string }} [options={}]
 * @returns {string}
 */
export function renderAdminBootstrapHtml(options = {}) {
  const { apiKey = '', shop = '' } = options;
  const safeApiKey = escapeAdminText(apiKey);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="shopify-api-key" content="${safeApiKey}">
  <title>Practitioner Protocols</title>
  <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
  <style>
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      color: #6d7175;
      background: #f6f6f7;
    }
    .spinner {
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="spinner">
    <p id="bootstrap-message">Loading Practitioner Protocols...</p>
  </div>
  <script>
    (async function() {
      var msgEl = document.getElementById('bootstrap-message');
      var params = new URLSearchParams(window.location.search);
      if (params.has('id_token')) {
        if (msgEl) {
          msgEl.textContent = 'Unable to start the app session. Please reopen the app from your Shopify admin.';
        }
        return;
      }

      var timeoutId = setTimeout(function() {
        if (msgEl) {
          msgEl.textContent = 'Unable to start the app session. Please reopen the app from your Shopify admin.';
        }
      }, 5000);

      try {
        if (window.shopify && typeof window.shopify.idToken === 'function') {
          var token = await window.shopify.idToken();
          if (token) {
            clearTimeout(timeoutId);
            var url = new URL(window.location.href);
            url.searchParams.set('id_token', token);
            window.location.replace(url.toString());
            return;
          }
        }
      } catch (err) {
        console.error('Failed to obtain App Bridge session token:', err);
      }
    })();
  </script>
</body>
</html>`;
}

/**
 * Renders the full Merchant Admin embedded Polaris HTML UI (Milestone M6 / M9a).
 *
 * @param {{
 *   shop?: string,
 *   apiKey?: string,
 *   profiles?: Array<any>,
 *   starters?: Array<any>,
 *   report?: any,
 *   settings?: any,
 *   activeTab?: string
 * }} options
 * @returns {string} Complete Polaris HTML document
 */
export function renderAdminHtml(options = {}) {
  const {
    shop = '',
    apiKey = '',
    profiles = [],
    starters = [],
    report = null,
    settings = null,
    activeTab = 'practitioners'
  } = options;

  // Enforce zero PII barrier on all inputs
  assertNoPii(profiles);
  assertNoPii(starters);
  if (report) assertNoPii(report);
  if (settings) assertNoPii(settings);

  const safeShop = escapeAdminText(shop);
  const currentTab = ['practitioners', 'starters', 'attribution', 'settings'].includes(activeTab)
    ? activeTab
    : 'practitioners';

  const styles = `
<style>
  :root {
    --p-color-bg: #f6f6f7;
    --p-color-bg-surface: #ffffff;
    --p-color-text: #202223;
    --p-color-text-subdued: #6d7175;
    --p-color-border: #e1e3e5;
    --p-color-primary: #008060;
    --p-color-primary-hover: #006e52;
    --p-color-critical: #d72c0d;
    --p-color-critical-hover: #bc2200;
  }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background-color: var(--p-color-bg);
    color: var(--p-color-text);
    line-height: 1.5;
  }
  .Polaris-Page {
    max-width: 1040px;
    margin: 2rem auto;
    padding: 0 1rem;
  }
  .Polaris-Header {
    margin-bottom: 1.5rem;
  }
  .Polaris-Header-Title {
    font-size: 1.75rem;
    font-weight: 700;
    margin: 0 0 0.25rem 0;
  }
  .Polaris-Header-Subdued {
    color: var(--p-color-text-subdued);
    font-size: 0.875rem;
  }
  .Polaris-Tabs {
    display: flex;
    gap: 0.5rem;
    border-bottom: 1px solid var(--p-color-border);
    margin-bottom: 1.5rem;
  }
  .Polaris-Tab {
    padding: 0.75rem 1rem;
    font-weight: 600;
    font-size: 0.875rem;
    color: var(--p-color-text-subdued);
    text-decoration: none;
    border-bottom: 2px solid transparent;
  }
  .Polaris-Tab--selected {
    color: var(--p-color-primary);
    border-bottom-color: var(--p-color-primary);
  }
  .Polaris-Card {
    background: var(--p-color-bg-surface);
    border-radius: 8px;
    box-shadow: 0 0 0 1px rgba(63, 63, 68, 0.05), 0 1px 3px 0 rgba(63, 63, 68, 0.15);
    padding: 1.5rem;
    margin-bottom: 1.5rem;
  }
  .Polaris-Card-Title {
    font-size: 1.125rem;
    font-weight: 600;
    margin: 0 0 1rem 0;
  }
  .Polaris-Button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.5rem 1rem;
    font-size: 0.875rem;
    font-weight: 600;
    border-radius: 4px;
    border: 1px solid var(--p-color-border);
    background: #ffffff;
    color: var(--p-color-text);
    cursor: pointer;
    text-decoration: none;
  }
  .Polaris-Button--primary {
    background: var(--p-color-primary);
    color: #ffffff;
    border-color: var(--p-color-primary);
  }
  .Polaris-Button--critical {
    background: var(--p-color-critical);
    color: #ffffff;
    border-color: var(--p-color-critical);
  }
  .Polaris-Badge {
    display: inline-block;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 600;
  }
  .Polaris-Badge--success {
    background: #e4fbf5;
    color: #007f5f;
  }
  .Polaris-Badge--attention {
    background: #fff5ea;
    color: #914400;
  }
  table.Polaris-Table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
  }
  table.Polaris-Table th, table.Polaris-Table td {
    padding: 0.75rem;
    border-bottom: 1px solid var(--p-color-border);
    text-align: left;
  }
  table.Polaris-Table th {
    font-weight: 600;
    color: var(--p-color-text-subdued);
  }
  .Polaris-Metrics-Grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1rem;
    margin-bottom: 1.5rem;
  }
  .Polaris-Metric-Box {
    background: #f9fafb;
    border: 1px solid var(--p-color-border);
    border-radius: 6px;
    padding: 1rem;
    text-align: center;
  }
  .Polaris-Metric-Val {
    font-size: 1.75rem;
    font-weight: 700;
    color: var(--p-color-text);
  }
  .Polaris-Metric-Label {
    font-size: 0.8125rem;
    color: var(--p-color-text-subdued);
    margin-top: 0.25rem;
  }
</style>`;

  // Tab 1: Practitioners List
  const renderPractitionersTab = () => {
    const rows = profiles.map((p) => {
      const rawGid = p.ownerGid || '';
      const gid = escapeAdminText(rawGid);
      const practice = escapeAdminText(p.practiceName || 'Not Set');
      const isApproved = Boolean(p.isApproved);
      const statusBadge = isApproved
        ? `<span class="Polaris-Badge Polaris-Badge--success">Approved</span>`
        : `<span class="Polaris-Badge Polaris-Badge--attention">Pending Approval</span>`;
      const actionBtn = isApproved
        ? `<button type="submit" class="Polaris-Button">Revoke</button>`
        : `<button type="submit" class="Polaris-Button Polaris-Button--primary">Approve</button>`;

      const numericCustomerId = rawGid.startsWith('gid://shopify/Customer/')
        ? rawGid.replace(/^gid:\/\/shopify\/Customer\//, '')
        : (rawGid.match(/\/Customer\/(\d+)/)?.[1] || (/^\d+$/.test(rawGid) ? rawGid : ''));
      const safeNumericId = escapeAdminText(numericCustomerId);

      const customerLinkHtml = (!isApproved && safeNumericId && safeShop)
        ? `<div style="font-size:0.75rem; margin-top:0.25rem;"><a href="https://${safeShop}/admin/customers/${safeNumericId}" target="_blank" rel="noopener noreferrer">https://${safeShop}/admin/customers/${safeNumericId}</a></div>`
        : '';

      const practiceDisplay = practice === 'Not Set'
        ? practice
        : `${practice}${!isApproved ? ' (requested, unverified)' : ''}`;

      return `
      <tr>
        <td>
          <code>${gid}</code>
          ${customerLinkHtml}
        </td>
        <td>
          <form method="POST" action="/api/admin/practitioners/practice-name" style="display:flex; align-items:center; gap:0.5rem; margin:0;">
            <input type="hidden" name="ownerGid" value="${gid}">
            <input type="text" name="practiceName" value="${practice === 'Not Set' ? '' : practice}" placeholder="Set Practice Name" style="padding:0.35rem 0.5rem; font-size:0.875rem; border:1px solid var(--p-color-border); border-radius:4px; max-width:220px;">
            <button type="submit" class="Polaris-Button" style="padding:0.35rem 0.6rem; font-size:0.75rem;">Save Name</button>
          </form>
          <div style="font-size:0.75rem; color:var(--p-color-text-subdued); margin-top:0.25rem;">Current: <strong>${practiceDisplay}</strong></div>
        </td>
        <td>${statusBadge}</td>
        <td>
          <form method="POST" action="/api/admin/practitioners/status" style="display:inline;">
            <input type="hidden" name="ownerGid" value="${gid}">
            <input type="hidden" name="action" value="${isApproved ? 'revoke' : 'approve'}">
            ${actionBtn}
          </form>
        </td>
      </tr>`;
    }).join('');

    return `
    <div class="Polaris-Card">
      <h2 class="Polaris-Card-Title">Practitioner Directory &amp; Approvals</h2>
      <p style="color: var(--p-color-text-subdued); margin-bottom: 1rem;">Manage approved practitioners and configure practice display names.</p>
      <table class="Polaris-Table">
        <thead>
          <tr>
            <th>Practitioner GID</th>
            <th>Practice Name (Merchant Controlled)</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${rows || '<tr><td colspan="4" style="text-align:center; color:#6d7175;">No practitioner profiles registered.</td></tr>'}
        </tbody>
      </table>
    </div>`;
  };

  // Tab 2: Starters Management
  const renderStartersTab = () => {
    const rows = starters.map((s) => {
      const name = escapeAdminText(s.name || 'Untitled Starter');
      const items = s.linesCount || s.lines?.length || 0;
      return `
      <tr>
        <td><strong>${name}</strong></td>
        <td>${items} ${items === 1 ? 'item' : 'items'}</td>
        <td><span class="Polaris-Badge Polaris-Badge--success">Active Template</span></td>
      </tr>`;
    }).join('');

    return `
    <div class="Polaris-Card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 1rem;">
        <div>
          <h2 class="Polaris-Card-Title" style="margin:0;">Brand Starter Templates</h2>
          <p style="color: var(--p-color-text-subdued); margin: 0.25rem 0 0 0;">Curated protocols practitioners can duplicate and recommend to clients.</p>
        </div>
        <button type="button" class="Polaris-Button Polaris-Button--primary" onclick="document.getElementById('create-starter-modal').style.display='flex'">Create Starter Template</button>
      </div>
      <table class="Polaris-Table">
        <thead>
          <tr>
            <th>Template Name</th>
            <th>Items</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${rows || '<tr><td colspan="3" style="text-align:center; color:#6d7175;">No brand starter templates created yet.</td></tr>'}
        </tbody>
      </table>
    </div>

    <!-- Create Starter Template Modal -->
    <div id="create-starter-modal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:9999; align-items:center; justify-content:center;">
      <div class="Polaris-Card" style="max-width:540px; width:90%; max-height:90vh; overflow-y:auto; margin:0;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem; border-bottom:1px solid var(--p-color-border); padding-bottom:0.75rem;">
          <h3 style="margin:0; font-size:1.125rem;">Create Brand Starter Template</h3>
          <button type="button" onclick="document.getElementById('create-starter-modal').style.display='none'" style="background:none; border:none; font-size:1.25rem; cursor:pointer;">&times;</button>
        </div>
        <form method="POST" action="/api/admin/starters/create" id="admin-create-starter-form">
          <div style="margin-bottom:1rem;">
            <label style="display:block; font-weight:600; margin-bottom:0.25rem; font-size:0.875rem;">Template Name (Required, max 60 chars)</label>
            <input type="text" name="name" maxlength="60" required placeholder="e.g. Daily Essentials Routine" style="width:100%; padding:0.5rem; border:1px solid var(--p-color-border); border-radius:4px; box-sizing:border-box;">
          </div>
          <div style="margin-bottom:1rem;">
            <label style="display:block; font-weight:600; margin-bottom:0.25rem; font-size:0.875rem;">Intro Note (Optional, max 500 chars)</label>
            <textarea name="introNote" rows="2" maxlength="500" placeholder="Brand guidance for specialists..." style="width:100%; padding:0.5rem; border:1px solid var(--p-color-border); border-radius:4px; box-sizing:border-box;"></textarea>
          </div>
          <div style="margin-bottom:1rem;">
            <label style="display:block; font-weight:600; margin-bottom:0.5rem; font-size:0.875rem;">Add Products to Starter</label>
            <div style="display:flex; gap:0.5rem; position:relative;">
              <input type="text" id="admin-starter-search-input" placeholder="Search catalog by product name..." style="flex:1; padding:0.5rem; border:1px solid var(--p-color-border); border-radius:4px; font-size:0.875rem; box-sizing:border-box;">
              <button type="button" id="admin-starter-search-btn" class="Polaris-Button">Search</button>
              <div id="admin-starter-search-dropdown" style="display:none; position:absolute; top:100%; left:0; right:0; background:#fff; border:1px solid var(--p-color-border); border-radius:4px; max-height:220px; overflow-y:auto; z-index:10000; box-shadow:0 4px 6px -1px rgba(0,0,0,0.1); margin-top:2px;"></div>
            </div>
          </div>
          <div style="margin-bottom:1rem;">
            <label style="display:block; font-weight:600; margin-bottom:0.5rem; font-size:0.875rem;">Selected Items (<span id="starter-lines-count">0</span>/20)</label>
            <div id="starter-lines-container" style="display:flex; flex-direction:column; gap:0.5rem;">
              <div id="starter-lines-empty" style="color:var(--p-color-text-subdued); font-size:0.875rem; padding:0.5rem; background:#f9fafb; border-radius:4px; text-align:center;">No products added yet. Use the search above to add products.</div>
            </div>
          </div>
          <div style="display:flex; justify-content:flex-end; gap:0.5rem; margin-top:1.5rem; border-top:1px solid var(--p-color-border); padding-top:1rem;">
            <button type="button" class="Polaris-Button" onclick="document.getElementById('create-starter-modal').style.display='none'">Cancel</button>
            <button type="submit" class="Polaris-Button Polaris-Button--primary">Save Starter Template</button>
          </div>
        </form>
      </div>
    </div>`;
  };

  // Tab 3: Monthly Attribution Reports
  const renderAttributionTab = () => {
    const totalRev = report?.totalRevenueFormatted || '$0.00';
    const totalOrders = report?.totalOrders ?? 0;
    const totalUnits = report?.totalUnits ?? 0;
    const month = escapeAdminText(report?.month || new Date().toISOString().slice(0, 7));

    const rows = (report?.items || []).map((item) => {
      const practice = escapeAdminText(item.practiceName || 'Direct');
      const protocol = escapeAdminText(item.protocolName || 'General');
      const orders = item.orders ?? 0;
      const units = item.units ?? 0;
      const rev = escapeAdminText(item.revenueFormatted || '$0.00');

      return `
      <tr>
        <td><strong>${practice}</strong></td>
        <td>${protocol}</td>
        <td>${orders}</td>
        <td>${units}</td>
        <td><strong>${rev}</strong></td>
      </tr>`;
    }).join('');

    return `
    <div class="Polaris-Card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 1.5rem; flex-wrap:wrap; gap:1rem;">
        <div>
          <h2 class="Polaris-Card-Title" style="margin:0;">Attribution &amp; Sales Reports (${month})</h2>
          <p style="color: var(--p-color-text-subdued); margin: 0.25rem 0 0 0;">Monthly aggregate order volume and attributed retail revenue by practice.</p>
        </div>
        <div style="display:flex; align-items:center; gap:0.75rem;">
          <form method="GET" action="" style="display:inline-flex; align-items:center; gap:0.5rem;">
            <input type="hidden" name="tab" value="attribution">
            <input type="month" name="month" value="${month}" style="padding:0.35rem 0.5rem; font-size:0.875rem; border:1px solid var(--p-color-border); border-radius:4px;">
            <button type="submit" class="Polaris-Button" style="padding:0.35rem 0.75rem;">Filter</button>
          </form>
          <a href="/api/admin/attribution.csv${month ? `?month=${encodeURIComponent(month)}` : ''}" class="Polaris-Button Polaris-Button--primary">Export CSV (RFC 4180)</a>
        </div>
      </div>

      <div class="Polaris-Metrics-Grid">
        <div class="Polaris-Metric-Box">
          <div class="Polaris-Metric-Val">${totalRev}</div>
          <div class="Polaris-Metric-Label">Attributed Revenue</div>
        </div>
        <div class="Polaris-Metric-Box">
          <div class="Polaris-Metric-Val">${totalOrders}</div>
          <div class="Polaris-Metric-Label">Attributed Orders</div>
        </div>
        <div class="Polaris-Metric-Box">
          <div class="Polaris-Metric-Val">${totalUnits}</div>
          <div class="Polaris-Metric-Label">Total Units Sold</div>
        </div>
      </div>

      <table class="Polaris-Table">
        <thead>
          <tr>
            <th>Practice Name</th>
            <th>Protocol</th>
            <th>Orders</th>
            <th>Units</th>
            <th>Revenue</th>
          </tr>
        </thead>
        <tbody>
          ${rows || '<tr><td colspan="5" style="text-align:center; color:#6d7175;">No attributed orders recorded this month.</td></tr>'}
        </tbody>
      </table>
    </div>`;
  };

  // Tab 4: Settings & Emergency Controls
  const renderSettingsTab = () => {
    const mode = settings?.mode === 'company' || settings?.identityMode === 'company' ? 'company' : 'tag';
    const isSelfEnrol = Boolean(settings?.allowSelfEnrol);
    const disclaimer = escapeAdminText(settings?.disclaimer || settings?.footerDisclaimer || '');
    const handout = escapeAdminText(settings?.handoutText || '');

    return `
    <div class="Polaris-Card">
      <h2 class="Polaris-Card-Title">App Settings</h2>
      <form method="POST" action="/api/admin/settings">
        <div style="margin-bottom: 1rem;">
          <label style="display:block; font-weight:600; margin-bottom:0.25rem;">Identity Mode</label>
          <select name="mode" style="padding:0.5rem; width:100%; max-width:320px; border-radius:4px; border:1px solid var(--p-color-border);">
            <option value="tag" ${mode === 'tag' ? 'selected' : ''}>Individual Mode (Customer Account)</option>
            <option value="company" ${mode === 'company' ? 'selected' : ''}>Company Mode (B2B Company Contact)</option>
          </select>
        </div>
        <div style="margin-bottom: 1rem;">
          <input type="hidden" name="allowSelfEnrol" value="false">
          <label style="display:flex; align-items:flex-start; gap:0.5rem; cursor:pointer;">
            <input type="checkbox" name="allowSelfEnrol" value="true" ${isSelfEnrol ? 'checked' : ''} style="margin-top:0.2rem; width:1.125rem; height:1.125rem;">
            <div>
              <span style="font-weight:600; display:block;">Allow Practitioner Self-Enrolment</span>
              <span style="color:var(--p-color-text-subdued); font-size:0.8125rem;">
                When enabled, signed-in customers visiting the protocol portal can submit an enrolment request for review. (Tag mode only).
              </span>
            </div>
          </label>
        </div>
        <div style="margin-bottom: 1rem;">
          <label style="display:block; font-weight:600; margin-bottom:0.25rem;">Storefront Footer Disclaimer</label>
          <textarea name="disclaimer" rows="3" style="width:100%; border-radius:4px; border:1px solid var(--p-color-border); padding:0.5rem;">${disclaimer}</textarea>
        </div>
        <div style="margin-bottom: 1.5rem;">
          <label style="display:block; font-weight:600; margin-bottom:0.25rem;">Printable Handout Notice</label>
          <textarea name="handoutText" rows="2" style="width:100%; border-radius:4px; border:1px solid var(--p-color-border); padding:0.5rem;">${handout}</textarea>
        </div>
        <button type="submit" class="Polaris-Button Polaris-Button--primary">Save Settings</button>
      </form>
    </div>

    <div class="Polaris-Card" style="border-left: 4px solid var(--p-color-critical);">
      <h2 class="Polaris-Card-Title" style="color: var(--p-color-critical);">Emergency Controls</h2>
      <p style="color: var(--p-color-text-subdued); margin-bottom: 1rem;">
        In the event of an urgent regulatory inquiry, brand recall, or policy violation, you can immediately disable all protocol sharing links storewide.
      </p>
      <form method="POST" action="/api/admin/emergency/disable-all">
        <button type="submit" class="Polaris-Button Polaris-Button--critical">Disable All Protocols Storewide</button>
      </form>
    </div>`;
  };

  let tabContent = '';
  if (currentTab === 'starters') tabContent = renderStartersTab();
  else if (currentTab === 'attribution') tabContent = renderAttributionTab();
  else if (currentTab === 'settings') tabContent = renderSettingsTab();
  else tabContent = renderPractitionersTab();

  const appBridgeHead = apiKey
    ? `  <meta name="shopify-api-key" content="${escapeAdminText(apiKey)}">\n  <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>\n`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
${appBridgeHead}  <title>Practitioner Protocols &mdash; Admin</title>
  ${styles}
</head>
<body>
  <div class="Polaris-Page">
    <header class="Polaris-Header">
      <h1 class="Polaris-Header-Title">Practitioner Protocols</h1>
      <div class="Polaris-Header-Subdued">Connected Store: ${safeShop || 'Shopify Store'}</div>
    </header>

    <nav class="Polaris-Tabs">
      <a href="?tab=practitioners" class="Polaris-Tab ${currentTab === 'practitioners' ? 'Polaris-Tab--selected' : ''}">Practitioners</a>
      <a href="?tab=starters" class="Polaris-Tab ${currentTab === 'starters' ? 'Polaris-Tab--selected' : ''}">Starter Templates</a>
      <a href="?tab=attribution" class="Polaris-Tab ${currentTab === 'attribution' ? 'Polaris-Tab--selected' : ''}">Attribution &amp; Reports</a>
      <a href="?tab=settings" class="Polaris-Tab ${currentTab === 'settings' ? 'Polaris-Tab--selected' : ''}">Settings &amp; Emergency</a>
    </nav>

    <main>
      ${tabContent}
    </main>
  </div>

  <script>
    (function() {
      async function getToken() {
        if (window.shopify && typeof window.shopify.idToken === 'function') {
          try {
            return await window.shopify.idToken();
          } catch (e) {
            console.warn('App Bridge idToken error:', e);
          }
        }
        const params = new URLSearchParams(window.location.search);
        return params.get('id_token') || '';
      }

      // Preserve query params and session token across Polaris tabs
      document.querySelectorAll('a.Polaris-Tab').forEach(function(link) {
        link.addEventListener('click', async function(e) {
          e.preventDefault();
          const currentUrl = new URL(window.location.href);
          const targetUrl = new URL(link.getAttribute('href'), window.location.href);
          ['shop', 'host', 'embedded'].forEach(function(key) {
            const val = currentUrl.searchParams.get(key);
            if (val && !targetUrl.searchParams.has(key)) {
              targetUrl.searchParams.set(key, val);
            }
          });
          const token = await getToken();
          if (token) {
            targetUrl.searchParams.set('id_token', token);
          }
          window.location.href = targetUrl.toString();
        });
      });

      // Intercept forms
      document.querySelectorAll('form').forEach(function(form) {
        form.addEventListener('submit', async function(e) {
          const action = form.getAttribute('action') || '';
          const method = (form.getAttribute('method') || 'GET').toUpperCase();

          if (method === 'GET') {
            e.preventDefault();
            const currentUrl = new URL(window.location.href);
            const formUrl = new URL(action || window.location.href, window.location.href);
            new FormData(form).forEach(function(val, key) {
              formUrl.searchParams.set(key, val);
            });
            ['shop', 'host', 'embedded'].forEach(function(key) {
              const val = currentUrl.searchParams.get(key);
              if (val && !formUrl.searchParams.has(key)) {
                formUrl.searchParams.set(key, val);
              }
            });
            const token = await getToken();
            if (token) {
              formUrl.searchParams.set('id_token', token);
            }
            window.location.href = formUrl.toString();
            return;
          }

          if (action.startsWith('/api/admin/')) {
            e.preventDefault();
            const token = await getToken();
            const formData = new FormData(form);
            const submitBtn = form.querySelector('button[type="submit"]');
            if (submitBtn) submitBtn.disabled = true;

            try {
              const headers = { 'Accept': 'application/json' };
              if (token) {
                headers['Authorization'] = 'Bearer ' + token;
              }
              const urlParams = new URLSearchParams();
              formData.forEach(function(v, k) { urlParams.append(k, v); });
              headers['Content-Type'] = 'application/x-www-form-urlencoded';

              const res = await fetch(action, {
                method: 'POST',
                headers: headers,
                body: urlParams.toString()
              });

              if (res.ok) {
                const freshToken = await getToken();
                const nextUrl = new URL(window.location.href);
                if (freshToken) {
                  nextUrl.searchParams.set('id_token', freshToken);
                }
                window.location.href = nextUrl.toString();
              } else {
                const err = await res.json().catch(function() { return {}; });
                alert(err.error || 'Action failed');
                if (submitBtn) submitBtn.disabled = false;
              }
            } catch (err) {
              console.error(err);
              alert('Request failed');
              if (submitBtn) submitBtn.disabled = false;
            }
          }
        });
      });

      // Intercept CSV export link
      document.querySelectorAll('a[href*="/api/admin/attribution.csv"]').forEach(function(link) {
        link.addEventListener('click', async function(e) {
          e.preventDefault();
          const token = await getToken();
          const targetUrl = new URL(link.getAttribute('href'), window.location.href);
          if (token) {
            targetUrl.searchParams.set('id_token', token);
          }
          const currentUrl = new URL(window.location.href);
          const shop = currentUrl.searchParams.get('shop');
          if (shop && !targetUrl.searchParams.has('shop')) {
            targetUrl.searchParams.set('shop', shop);
          }
          window.location.href = targetUrl.toString();
        });
      });

      // Admin Starter Product Search & Selection
      const starterSearchInput = document.getElementById('admin-starter-search-input');
      const starterSearchBtn = document.getElementById('admin-starter-search-btn');
      const starterSearchDropdown = document.getElementById('admin-starter-search-dropdown');
      const starterLinesContainer = document.getElementById('starter-lines-container');
      const starterLinesCount = document.getElementById('starter-lines-count');
      const starterLinesEmpty = document.getElementById('starter-lines-empty');
      const starterForm = document.getElementById('admin-create-starter-form');

      let starterItems = [];

      function updateStarterRows() {
        if (!starterLinesContainer) return;
        starterLinesContainer.querySelectorAll('.starter-line-row').forEach(function(el) { el.remove(); });
        if (starterItems.length === 0) {
          if (starterLinesEmpty) starterLinesEmpty.style.display = 'block';
        } else {
          if (starterLinesEmpty) starterLinesEmpty.style.display = 'none';
        }
        if (starterLinesCount) starterLinesCount.textContent = String(starterItems.length);

        starterItems.forEach(function(item, idx) {
          const row = document.createElement('div');
          row.className = 'starter-line-row';
          row.style.cssText = 'display:flex; gap:0.5rem; align-items:center; background:#f9fafb; padding:0.5rem; border-radius:4px; border:1px solid var(--p-color-border);';

          const gidInput = document.createElement('input');
          gidInput.type = 'hidden';
          gidInput.name = 'lines[' + idx + '][variantGid]';
          gidInput.value = item.variantGid;
          row.appendChild(gidInput);

          if (item.productHandle) {
            const handleInput = document.createElement('input');
            handleInput.type = 'hidden';
            handleInput.name = 'lines[' + idx + '][productHandle]';
            handleInput.value = item.productHandle;
            row.appendChild(handleInput);
          }

          const titleDiv = document.createElement('div');
          titleDiv.style.cssText = 'flex:2; font-size:0.8125rem; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
          titleDiv.textContent = item.title;
          row.appendChild(titleDiv);

          const qtyInput = document.createElement('input');
          qtyInput.type = 'number';
          qtyInput.name = 'lines[' + idx + '][quantity]';
          qtyInput.value = String(item.quantity || 1);
          qtyInput.min = '1';
          qtyInput.max = '10';
          qtyInput.required = true;
          qtyInput.style.cssText = 'width:55px; padding:0.35rem; border:1px solid var(--p-color-border); border-radius:4px; font-size:0.8125rem;';
          qtyInput.addEventListener('change', function(e) {
            const v = parseInt(e.target.value, 10);
            if (v >= 1 && v <= 10) item.quantity = v;
          });
          row.appendChild(qtyInput);

          const noteInput = document.createElement('input');
          noteInput.type = 'text';
          noteInput.name = 'lines[' + idx + '][usageNote]';
          noteInput.value = item.usageNote || '';
          noteInput.placeholder = 'Usage instructions';
          noteInput.maxLength = 200;
          noteInput.style.cssText = 'flex:2; padding:0.35rem; border:1px solid var(--p-color-border); border-radius:4px; font-size:0.8125rem;';
          noteInput.addEventListener('input', function(e) {
            item.usageNote = e.target.value;
          });
          row.appendChild(noteInput);

          const removeBtn = document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.style.cssText = 'background:none; border:none; color:#dc2626; cursor:pointer; font-size:1.25rem; padding:0 0.25rem;';
          removeBtn.innerHTML = '&times;';
          removeBtn.title = 'Remove item';
          removeBtn.addEventListener('click', function() {
            starterItems.splice(idx, 1);
            updateStarterRows();
          });
          row.appendChild(removeBtn);

          starterLinesContainer.appendChild(row);
        });
      }

      function performStarterSearch() {
        const q = (starterSearchInput ? starterSearchInput.value : '').trim();
        if (q.length < 2 || !starterSearchDropdown) return;
        starterSearchDropdown.style.display = 'block';
        starterSearchDropdown.innerHTML = '<div style="padding:0.75rem; color:#6b7280; font-size:0.875rem;">Searching...</div>';

        const searchUrl = '/search/suggest.json?resources[type]=product&resources[limit]=10&resources[options][unavailable_products]=show&q=' + encodeURIComponent(q);
        fetch(searchUrl, { headers: { Accept: 'application/json' } })
          .then(function(r) { return r.ok ? r.json() : Promise.reject(new Error('Search failed')); })
          .then(function(data) {
            let products = (data && data.resources && data.resources.results && data.resources.results.products) || data.products || [];
            if (!products.length) {
              starterSearchDropdown.innerHTML = '<div style="padding:0.75rem; color:#6b7280; font-size:0.875rem;">No products found</div>';
              return;
            }
            starterSearchDropdown.innerHTML = '';
            products.forEach(function(p) {
              const itemDiv = document.createElement('div');
              itemDiv.style.cssText = 'padding:0.5rem 0.75rem; cursor:pointer; border-bottom:1px solid #f3f4f6; display:flex; justify-content:space-between; align-items:center;';
              itemDiv.innerHTML = '<div><div style="font-weight:500; font-size:0.875rem;">' + (p.title || 'Untitled') + '</div><div style="font-size:0.75rem; color:#6b7280;">' + (p.price ? '$' + p.price : '') + '</div></div>';
              itemDiv.addEventListener('click', function() {
                const handle = p.handle || '';
                if (!handle && p.variants && p.variants.length > 0) {
                  addVariantToStarter(p, p.variants[0], handle);
                  return;
                }
                fetch('/products/' + encodeURIComponent(handle) + '.js', { headers: { Accept: 'application/json' } })
                  .then(function(res) { return res.json(); })
                  .then(function(fullProd) {
                    const vars = fullProd.variants || [];
                    if (vars.length <= 1) {
                      addVariantToStarter(fullProd, vars[0] || {}, handle);
                    } else {
                      showVariantPicker(fullProd, vars, handle);
                    }
                  })
                  .catch(function() {
                    if (p.variants && p.variants.length > 0) {
                      addVariantToStarter(p, p.variants[0], handle);
                    } else {
                      alert('Could not load product variants');
                    }
                  });
              });
              starterSearchDropdown.appendChild(itemDiv);
            });
          })
          .catch(function() {
            fetch('/apps/protocols?action=search&q=' + encodeURIComponent(q))
              .then(function(r) { return r.ok ? r.json() : Promise.reject(); })
              .then(function(demoData) {
                let products = demoData.products || [];
                if (!products.length) {
                  starterSearchDropdown.innerHTML = '<div style="padding:0.75rem; color:#6b7280; font-size:0.875rem;">No products found</div>';
                  return;
                }
                starterSearchDropdown.innerHTML = '';
                products.forEach(function(p) {
                  const itemDiv = document.createElement('div');
                  itemDiv.style.cssText = 'padding:0.5rem 0.75rem; cursor:pointer; border-bottom:1px solid #f3f4f6;';
                  itemDiv.textContent = p.title;
                  itemDiv.addEventListener('click', function() {
                    if (p.variants && p.variants.length > 0) {
                      addVariantToStarter(p, p.variants[0], '');
                    }
                  });
                  starterSearchDropdown.appendChild(itemDiv);
                });
              })
              .catch(function() {
                starterSearchDropdown.innerHTML = '<div style="padding:0.75rem; color:#dc2626; font-size:0.875rem;">Search error</div>';
              });
          });
      }

      function addVariantToStarter(prod, variant, handle) {
        if (starterItems.length >= 20) {
          alert('Maximum 20 lines allowed per starter template.');
          return;
        }
        const vGid = variant.id ? (String(variant.id).startsWith('gid://') ? String(variant.id) : 'gid://shopify/ProductVariant/' + variant.id) : '';
        if (!vGid) {
          alert('Invalid variant');
          return;
        }
        if (starterItems.some(function(i) { return i.variantGid === vGid; })) {
          alert('This product variant is already in the starter template.');
          return;
        }
        const title = variant.title && variant.title !== 'Default Title' ? (prod.title + ' - ' + variant.title) : (prod.title || 'Product');
        starterItems.push({
          variantGid: vGid,
          productHandle: handle || '',
          title: title,
          quantity: 1,
          usageNote: '',
        });
        if (starterSearchDropdown) starterSearchDropdown.style.display = 'none';
        if (starterSearchInput) starterSearchInput.value = '';
        updateStarterRows();
      }

      function showVariantPicker(prod, variants, handle) {
        if (!starterSearchDropdown) return;
        starterSearchDropdown.innerHTML = '<div style="padding:0.5rem 0.75rem; font-weight:600; font-size:0.8125rem; background:#f9fafb; border-bottom:1px solid #e5e7eb;">Select variant for ' + prod.title + '</div>';
        variants.forEach(function(v) {
          const vDiv = document.createElement('div');
          vDiv.style.cssText = 'padding:0.5rem 0.75rem; cursor:pointer; border-bottom:1px solid #f3f4f6; font-size:0.8125rem;';
          vDiv.textContent = v.title + (v.price ? ' ($' + (parseFloat(v.price)/100).toFixed(2) + ')' : '');
          vDiv.addEventListener('click', function() {
            addVariantToStarter(prod, v, handle);
          });
          starterSearchDropdown.appendChild(vDiv);
        });
      }

      if (starterSearchBtn) {
        starterSearchBtn.addEventListener('click', performStarterSearch);
      }
      if (starterSearchInput) {
        let debounceTimer;
        starterSearchInput.addEventListener('input', function() {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(performStarterSearch, 300);
        });
      }
      if (starterForm) {
        starterForm.addEventListener('submit', function(e) {
          if (starterItems.length === 0) {
            e.preventDefault();
            alert('Please add at least one product line item to the starter template.');
          }
        });
      }
    })();
  </script>
</body>
</html>`;
}

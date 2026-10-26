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
  INVALID_INPUT: 'INVALID_INPUT',
  NOT_FOUND: 'NOT_FOUND',
  NOT_STARTER: 'NOT_STARTER',
  PII_NOT_ALLOWED: 'PII_NOT_ALLOWED'
};

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
    SELECT "shop", "identityMode", "footerDisclaimer", "handoutText", "createdAt", "updatedAt"
    FROM "Setting"
    WHERE "shop" = $1
  `;
  const res = await db.query(sql, [shop]);
  if (res.rows.length > 0) {
    return res.rows[0];
  }

  return {
    shop,
    identityMode: 'tag',
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

  let identityMode = settings.identityMode;
  if (identityMode !== undefined) {
    if (!ALLOWED_IDENTITY_MODES.has(identityMode)) {
      throw new ProtocolAdminError(
        `Invalid identityMode '${identityMode}'. Must be 'tag' or 'company'.`,
        ADMIN_ERROR_CODES.INVALID_INPUT,
        'identityMode'
      );
    }
  } else {
    identityMode = 'tag';
  }

  const footerDisclaimer = settings.footerDisclaimer !== undefined
    ? (settings.footerDisclaimer ? String(settings.footerDisclaimer).trim() : null)
    : null;
  if (footerDisclaimer && footerDisclaimer.length > 1000) {
    throw new ProtocolAdminError('Footer disclaimer cannot exceed 1000 characters', ADMIN_ERROR_CODES.INVALID_INPUT, 'footerDisclaimer');
  }

  const handoutText = settings.handoutText !== undefined
    ? (settings.handoutText ? String(settings.handoutText).trim() : null)
    : null;
  if (handoutText && handoutText.length > 1000) {
    throw new ProtocolAdminError('Handout text cannot exceed 1000 characters', ADMIN_ERROR_CODES.INVALID_INPUT, 'handoutText');
  }

  const sql = `
    INSERT INTO "Setting" (
      "shop", "identityMode", "footerDisclaimer", "handoutText", "createdAt", "updatedAt"
    ) VALUES (
      $1, $2, $3, $4, NOW(), NOW()
    )
    ON CONFLICT ("shop")
    DO UPDATE SET
      "identityMode" = COALESCE(EXCLUDED."identityMode", "Setting"."identityMode"),
      "footerDisclaimer" = EXCLUDED."footerDisclaimer",
      "handoutText" = EXCLUDED."handoutText",
      "updatedAt" = NOW()
    RETURNING *
  `;

  const res = await db.query(sql, [shop, identityMode, footerDisclaimer, handoutText]);
  return res.rows[0];
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
function escapeAdminText(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Renders the full Merchant Admin embedded Polaris HTML UI (Milestone M6).
 *
 * @param {{
 *   shop?: string,
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
      const gid = escapeAdminText(p.ownerGid || '');
      const practice = escapeAdminText(p.practiceName || 'Not Set');
      const isApproved = Boolean(p.isApproved);
      const statusBadge = isApproved
        ? `<span class="Polaris-Badge Polaris-Badge--success">Approved</span>`
        : `<span class="Polaris-Badge Polaris-Badge--attention">Pending Approval</span>`;
      const actionBtn = isApproved
        ? `<button type="submit" class="Polaris-Button">Revoke</button>`
        : `<button type="submit" class="Polaris-Button Polaris-Button--primary">Approve</button>`;

      return `
      <tr>
        <td><code>${gid}</code></td>
        <td><strong>${practice}</strong></td>
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
        <button type="button" class="Polaris-Button Polaris-Button--primary">Create Starter Template</button>
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
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 1.5rem;">
        <div>
          <h2 class="Polaris-Card-Title" style="margin:0;">Attribution &amp; Sales Reports (${month})</h2>
          <p style="color: var(--p-color-text-subdued); margin: 0.25rem 0 0 0;">Monthly aggregate order volume and attributed retail revenue by practice.</p>
        </div>
        <a href="/api/admin/attribution.csv" class="Polaris-Button Polaris-Button--primary">Export CSV (RFC 4180)</a>
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
    const mode = settings?.mode === 'company' ? 'company' : 'tag';
    const disclaimer = escapeAdminText(settings?.disclaimer || '');
    const handout = escapeAdminText(settings?.handoutText || '');

    return `
    <div class="Polaris-Card">
      <h2 class="Polaris-Card-Title">App Settings</h2>
      <form method="POST" action="/api/admin/settings">
        <div style="margin-bottom: 1rem;">
          <label style="display:block; font-weight:600; margin-bottom:0.25rem;">Identity Mode</label>
          <select name="mode" style="padding:0.5rem; width:100%; max-width:320px; border-radius:4px; border:1px solid var(--p-color-border);">
            <option value="tag" ${mode === 'tag' ? 'selected' : ''}>Tag Mode (Customer Tag "practitioner")</option>
            <option value="company" ${mode === 'company' ? 'selected' : ''}>Company Mode (B2B Company Contact)</option>
          </select>
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

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Practitioner Protocols &mdash; Admin</title>
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
</body>
</html>`;
}

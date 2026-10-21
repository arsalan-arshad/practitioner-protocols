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

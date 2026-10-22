import { generateShareToken } from './token.js';
import { validateProtocolInput, ProtocolValidationError } from './validation.js';
import { canAccessProtocol, DENIAL_REASONS } from './permissions.js';

/**
 * Service error class for application/protocol layer exceptions.
 */
export class ProtocolServiceError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {any} [details]
   */
  constructor(message, code, details = null) {
    super(message);
    this.name = 'ProtocolServiceError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Executes a function within a single-client database transaction.
 * If `db` is a connection pool (has `.connect()` function), checks out a single client,
 * begins a transaction, runs `fn(client)`, commits, and releases the client in a finally block.
 * If `db` is already a single client, begins a transaction on `db`, runs `fn(db)`, and commits.
 * In case of error, executes rollback and rethrows the error.
 *
 * @template T
 * @param {any} db Database pool or client with query() interface
 * @param {(tx: any) => Promise<T>} fn Transaction callback
 * @returns {Promise<T>}
 */
export async function withTransaction(db, fn) {
  if (!db || typeof db.query !== 'function') {
    throw new TypeError('Database client or pool with query() method is required');
  }

  const isPool = typeof db.connect === 'function';
  const client = isPool ? await db.connect() : db;

  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // rollback error does not supersede the primary transaction error
    }
    throw error;
  } finally {
    if (isPool && typeof client.release === 'function') {
      client.release();
    }
  }
}

/**
 * Lists protocols accessible to a given user context.
 *
 * @param {any} db Client with query(sql, params) interface
 * @param {{
 *   shop: string,
 *   user: { id: string, role: string, ownerType: string, ownerId: string },
 *   status?: string | null,
 *   includeStarters?: boolean
 * }} options
 */
export async function listProtocols(db, { shop, user, status = 'active', includeStarters = true }) {
  if (!user) {
    throw new ProtocolServiceError('User is unauthenticated', DENIAL_REASONS.UNAUTHENTICATED);
  }

  const isAdmin = user.role === 'admin';

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
    WHERE p.shop = $1
  `;
  const params = [shop];

  if (!isAdmin) {
    // Non-admin practitioners can see their own protocols and starter templates
    params.push(user.ownerType);
    params.push(user.ownerId);
    const ownerTypeIdx = params.length - 1;
    const ownerIdIdx = params.length;

    if (includeStarters) {
      sql += ` AND ((p."ownerType" = $${ownerTypeIdx} AND p."ownerId" = $${ownerIdIdx}) OR (p."isStarter" = true AND p.status != 'disabled'))`;
    } else {
      sql += ` AND (p."ownerType" = $${ownerTypeIdx} AND p."ownerId" = $${ownerIdIdx})`;
    }

    // Never return disabled protocols to non-admins
    sql += ` AND p.status != 'disabled'`;
  }

  if (status) {
    params.push(status);
    sql += ` AND p.status = $${params.length}`;
  }

  sql += ` GROUP BY p.id ORDER BY p."createdAt" DESC`;

  const result = await db.query(sql, params);
  return result.rows;
}

/**
 * Retrieves a protocol by its public share token.
 *
 * @param {any} db
 * @param {{ shop: string, token: string }} options
 */
export async function getProtocolByToken(db, { shop, token }) {
  if (!token || typeof token !== 'string') {
    return null;
  }

  const sql = `
    SELECT p.*,
      prof."practiceName",
      prof."logoUrl",
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
    LEFT JOIN "PractitionerProfile" prof ON (p.shop = prof.shop AND p."ownerId" = prof."ownerGid")
    WHERE p.shop = $1 AND p.token = $2
    GROUP BY p.id, prof."practiceName", prof."logoUrl"
  `;

  const result = await db.query(sql, [shop, token.trim()]);
  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}

/**
 * Retrieves a protocol by ID and enforces access permissions.
 *
 * @param {any} db
 * @param {{
 *   shop: string,
 *   user: { id: string, role: string, ownerType: string, ownerId: string },
 *   protocolId: string,
 *   action?: string
 * }} options
 */
export async function getProtocolById(db, { shop, user, protocolId, action = 'read' }) {
  const sql = `
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
    WHERE p.shop = $1 AND p.id = $2
    GROUP BY p.id
  `;

  const result = await db.query(sql, [shop, protocolId]);
  if (result.rows.length === 0) {
    return null;
  }

  const protocol = result.rows[0];
  const access = canAccessProtocol(user, protocol, action);
  if (!access.allowed) {
    throw new ProtocolServiceError(`Access denied: ${access.reason}`, access.reason);
  }

  return protocol;
}

/**
 * Creates a new protocol with validation and transaction.
 *
 * @param {any} db
 * @param {{
 *   shop: string,
 *   user: { id: string, role: string, ownerType: string, ownerId: string },
 *   input: any
 * }} options
 */
export async function createProtocol(db, { shop, user, input }) {
  const access = canAccessProtocol(user, input, 'create');
  if (!access.allowed) {
    throw new ProtocolServiceError(`Cannot create protocol: ${access.reason}`, access.reason);
  }

  const validation = validateProtocolInput(input, {
    isAdmin: user.role === 'admin'
  });

  if (!validation.isValid) {
    throw new ProtocolValidationError(
      validation.errors.map(e => e.message).join('; '),
      validation.errors[0]?.code || 'VALIDATION_FAILED',
      validation.errors[0]?.field
    );
  }

  const sanitized = validation.sanitized;
  const token = generateShareToken();
  const ownerType = input.ownerType || user.ownerType || (user.role === 'admin' ? 'company' : 'customer');
  const ownerId = input.ownerId || user.ownerId || (user.role === 'admin' ? 'brand' : user.id);
  const isStarter = Boolean(user.role === 'admin' && sanitized.isStarter);

  // Execute in single-client transaction
  return withTransaction(db, async (tx) => {
    const insertProtocolSql = `
      INSERT INTO "Protocol" (
        "id", "shop", "token", "name", "introNote", "displayName",
        "ownerType", "ownerId", "createdBy", "updatedBy", "status",
        "isStarter", "sourceProtocolId", "createdAt", "updatedAt"
      ) VALUES (
        gen_random_uuid()::text, $1, $2, $3, $4, $5,
        $6, $7, $8, $8, $9,
        $10, $11, NOW(), NOW()
      ) RETURNING *
    `;

    const protoRes = await tx.query(insertProtocolSql, [
      shop,
      token,
      sanitized.name,
      sanitized.introNote || null,
      sanitized.displayName || null,
      ownerType,
      ownerId,
      user.id,
      sanitized.status,
      isStarter,
      sanitized.sourceProtocolId || null
    ]);

    const createdProtocol = protoRes.rows[0];

    // Insert lines
    const lines = [];
    if (Array.isArray(sanitized.lines)) {
      for (let pos = 0; pos < sanitized.lines.length; pos++) {
        const line = sanitized.lines[pos];
        const insertLineSql = `
          INSERT INTO "ProtocolLine" (
            "id", "protocolId", "position", "variantGid", "quantity", "usageNote", "createdAt", "updatedAt"
          ) VALUES (
            gen_random_uuid()::text, $1, $2, $3, $4, $5, NOW(), NOW()
          ) RETURNING *
        `;
        const lineRes = await tx.query(insertLineSql, [
          createdProtocol.id,
          pos,
          line.variantGid,
          line.quantity,
          line.usageNote || null
        ]);
        lines.push(lineRes.rows[0]);
      }
    }

    return { ...createdProtocol, lines };
  });
}

/**
 * Duplicates a protocol (starter or existing protocol) into the practitioner's library.
 *
 * @param {any} db
 * @param {{
 *   shop: string,
 *   user: { id: string, role: string, ownerType: string, ownerId: string },
 *   protocolId: string
 * }} options
 */
export async function duplicateProtocol(db, { shop, user, protocolId }) {
  const existing = await getProtocolById(db, { shop, user, protocolId, action: 'duplicate' });
  if (!existing) {
    throw new ProtocolServiceError('Protocol not found', 'NOT_FOUND');
  }

  const copyInput = {
    name: `${existing.name} (Copy)`.slice(0, 60),
    introNote: existing.introNote || '',
    displayName: existing.displayName || '',
    sourceProtocolId: existing.id,
    lines: (existing.lines || []).map(l => ({
      variantGid: l.variantGid,
      quantity: l.quantity,
      usageNote: l.usageNote || ''
    }))
  };

  return createProtocol(db, { shop, user, input: copyInput });
}

/**
 * Updates an existing protocol.
 *
 * @param {any} db
 * @param {{
 *   shop: string,
 *   user: { id: string, role: string, ownerType: string, ownerId: string },
 *   protocolId: string,
 *   input: any
 * }} options
 */
export async function updateProtocol(db, { shop, user, protocolId, input }) {
  const validation = validateProtocolInput(input, {
    isUpdate: true,
    isAdmin: user.role === 'admin'
  });

  if (!validation.isValid) {
    throw new ProtocolValidationError(
      validation.errors.map(e => e.message).join('; '),
      validation.errors[0]?.code || 'VALIDATION_FAILED',
      validation.errors[0]?.field
    );
  }

  const sanitized = validation.sanitized;

  return withTransaction(db, async (tx) => {
    const existing = await getProtocolById(tx, { shop, user, protocolId, action: 'edit' });
    if (!existing) {
      throw new ProtocolServiceError('Protocol not found', 'NOT_FOUND');
    }

    const updateSql = `
      UPDATE "Protocol"
      SET
        "name" = COALESCE($1, "name"),
        "introNote" = COALESCE($2, "introNote"),
        "displayName" = COALESCE($3, "displayName"),
        "status" = COALESCE($4, "status"),
        "updatedBy" = $5,
        "updatedAt" = NOW()
      WHERE "id" = $6 AND "shop" = $7
      RETURNING *
    `;

    const res = await tx.query(updateSql, [
      sanitized.name ?? null,
      sanitized.introNote !== undefined ? (sanitized.introNote || null) : null,
      sanitized.displayName !== undefined ? (sanitized.displayName || null) : null,
      sanitized.status ?? null,
      user.id,
      protocolId,
      shop
    ]);

    const updatedProtocol = res.rows[0];

    // If lines array was explicitly provided in update, replace lines
    let lines = existing.lines;
    if (sanitized.lines) {
      await tx.query('DELETE FROM "ProtocolLine" WHERE "protocolId" = $1', [protocolId]);
      lines = [];
      for (let pos = 0; pos < sanitized.lines.length; pos++) {
        const line = sanitized.lines[pos];
        const insertLineSql = `
          INSERT INTO "ProtocolLine" (
            "id", "protocolId", "position", "variantGid", "quantity", "usageNote", "createdAt", "updatedAt"
          ) VALUES (
            gen_random_uuid()::text, $1, $2, $3, $4, $5, NOW(), NOW()
          ) RETURNING *
        `;
        const lineRes = await tx.query(insertLineSql, [
          protocolId,
          pos,
          line.variantGid,
          line.quantity,
          line.usageNote || null
        ]);
        lines.push(lineRes.rows[0]);
      }
    }

    return { ...updatedProtocol, lines };
  });
}

/**
 * Changes protocol status to archived.
 *
 * @param {any} db
 * @param {{
 *   shop: string,
 *   user: { id: string, role: string, ownerType: string, ownerId: string },
 *   protocolId: string
 * }} options
 */
export async function archiveProtocol(db, { shop, user, protocolId }) {
  const existing = await getProtocolById(db, { shop, user, protocolId, action: 'archive' });
  if (!existing) {
    throw new ProtocolServiceError('Protocol not found', 'NOT_FOUND');
  }

  const sql = `
    UPDATE "Protocol"
    SET "status" = 'archived', "updatedBy" = $1, "updatedAt" = NOW()
    WHERE "id" = $2 AND "shop" = $3
    RETURNING *
  `;
  const res = await db.query(sql, [user.id, protocolId, shop]);
  return res.rows[0];
}

/**
 * Restores an archived protocol back to active.
 *
 * @param {any} db
 * @param {{
 *   shop: string,
 *   user: { id: string, role: string, ownerType: string, ownerId: string },
 *   protocolId: string
 * }} options
 */
export async function restoreProtocol(db, { shop, user, protocolId }) {
  const existing = await getProtocolById(db, { shop, user, protocolId, action: 'restore' });
  if (!existing) {
    throw new ProtocolServiceError('Protocol not found', 'NOT_FOUND');
  }

  const sql = `
    UPDATE "Protocol"
    SET "status" = 'active', "updatedBy" = $1, "updatedAt" = NOW()
    WHERE "id" = $2 AND "shop" = $3
    RETURNING *
  `;
  const res = await db.query(sql, [user.id, protocolId, shop]);
  return res.rows[0];
}

/**
 * Atomically records order attribution in monthly aggregate counters.
 *
 * @param {any} db
 * @param {{
 *   shop: string,
 *   attributions: Array<{
 *     protocolToken: string,
 *     protocolId?: string,
 *     quantity: number,
 *     priceMinor: number
 *   }>,
 *   month: string,
 *   currency?: string
 * }} options
 */
export async function recordOrderAttribution(db, { shop, attributions, month, currency = 'USD' }) {
  if (!Array.isArray(attributions) || attributions.length === 0) {
    return { updatedCount: 0 };
  }

  // Group attributions by protocol token / id
  const grouped = new Map();
  for (const attr of attributions) {
    const key = attr.protocolToken;
    if (!key) continue;
    const existing = grouped.get(key) || { units: 0, revenueMinor: 0 };
    existing.units += attr.quantity || 1;
    existing.revenueMinor += attr.priceMinor || 0;
    grouped.set(key, existing);
  }

  return withTransaction(db, async (tx) => {
    let updatedCount = 0;

    for (const [token, agg] of grouped.entries()) {
      // Find protocol and its owner
      const protoRes = await tx.query(
        'SELECT id, "ownerId" FROM "Protocol" WHERE shop = $1 AND token = $2',
        [shop, token]
      );

      if (protoRes.rows.length === 0) continue;
      const proto = protoRes.rows[0];

      const upsertSql = `
        INSERT INTO "ProtocolOrderStat" (
          "id", "shop", "protocolId", "ownerId", "month",
          "orders", "units", "revenueMinor", "currency", "createdAt", "updatedAt"
        ) VALUES (
          gen_random_uuid()::text, $1, $2, $3, $4,
          1, $5, $6, $7, NOW(), NOW()
        )
        ON CONFLICT ("shop", "protocolId", "month", "currency")
        DO UPDATE SET
          "orders" = "ProtocolOrderStat"."orders" + 1,
          "units" = "ProtocolOrderStat"."units" + EXCLUDED.units,
          "revenueMinor" = "ProtocolOrderStat"."revenueMinor" + EXCLUDED."revenueMinor",
          "updatedAt" = NOW()
      `;

      await tx.query(upsertSql, [
        shop,
        proto.id,
        proto.ownerId,
        month,
        agg.units,
        agg.revenueMinor,
        currency
      ]);

      updatedCount++;
    }

    return { updatedCount };
  });
}

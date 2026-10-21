import { validateProtocolInput, ProtocolValidationError } from './validation.js';
import { canAccessProtocol } from './permissions.js';
import { generateQrSvg } from './qr.js';
import { renderHandoutHtml, escapeHtml } from './handout.js';

export { ProtocolValidationError };

/**
 * Formats a minor currency amount (e.g. 2999 cents) into a standard formatted currency string.
 *
 * @param {number} minorAmount - Amount in cents/minor units (e.g. 2999)
 * @param {string} [currency='USD'] - ISO 4217 currency code
 * @returns {string} Formatted string, e.g. "$29.99"
 */
export function formatMoney(minorAmount, currency = 'USD') {
  const safeMinor = Number.isFinite(minorAmount) ? Math.round(minorAmount) : 0;
  const major = safeMinor / 100;

  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase()
    }).format(major);
  } catch {
    return `$${major.toFixed(2)}`;
  }
}

/**
 * Normalizes an arbitrary price representation into minor currency units (cents).
 *
 * @param {unknown} priceVal
 * @returns {number}
 */
function normalizeToMinorUnits(priceVal) {
  if (priceVal === null || priceVal === undefined) return 0;
  if (typeof priceVal === 'object' && priceVal !== null) {
    if (typeof priceVal.priceMinor === 'number') return Math.round(priceVal.priceMinor);
    if (typeof priceVal.amount === 'string' || typeof priceVal.amount === 'number') {
      return Math.round(parseFloat(priceVal.amount) * 100);
    }
    if (typeof priceVal.price === 'string' || typeof priceVal.price === 'number') {
      return Math.round(parseFloat(priceVal.price) * 100);
    }
  }
  if (typeof priceVal === 'number') {
    // If it's already an integer, check if it's meant to be cents or dollars.
    // If priceVal is non-integer, definitely major units (dollars).
    if (!Number.isInteger(priceVal)) {
      return Math.round(priceVal * 100);
    }
    return priceVal;
  }
  if (typeof priceVal === 'string') {
    const parsed = parseFloat(priceVal.replace(/[^0-9.-]+/g, ''));
    return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
  }
  return 0;
}

/**
 * Calculates the total retail price for an array of protocol lines.
 *
 * @param {Array<{ variantGid?: string, quantity?: number, price?: any, priceMinor?: number }>} [lines=[]]
 * @param {Record<string, any>} [variantCatalogMap={}] - Map of variantGid to variant object or price
 * @param {string} [currency='USD']
 * @returns {{
 *   totalMinor: number,
 *   currency: string,
 *   formattedTotal: string,
 *   itemsPriced: number,
 *   totalItems: number,
 *   isComplete: boolean
 * }}
 */
export function calculateProtocolRetailTotal(lines = [], variantCatalogMap = {}, currency = 'USD') {
  if (!Array.isArray(lines) || lines.length === 0) {
    return {
      totalMinor: 0,
      currency,
      formattedTotal: formatMoney(0, currency),
      itemsPriced: 0,
      totalItems: 0,
      isComplete: true
    };
  }

  let totalMinor = 0;
  let itemsPriced = 0;

  for (const line of lines) {
    if (!line) continue;
    const qty = Number.isInteger(line.quantity) && line.quantity >= 1 ? line.quantity : 1;
    const gid = line.variantGid;

    let minor = 0;
    let hasPrice = false;

    // Check direct line price attributes first
    if (typeof line.priceMinor === 'number') {
      minor = line.priceMinor;
      hasPrice = true;
    } else if (line.price !== undefined && line.price !== null) {
      minor = normalizeToMinorUnits(line.price);
      hasPrice = true;
    } else if (gid && variantCatalogMap[gid] !== undefined) {
      const catalogItem = variantCatalogMap[gid];
      if (typeof catalogItem?.priceMinor === 'number') {
        minor = catalogItem.priceMinor;
        hasPrice = true;
      } else if (catalogItem?.price !== undefined) {
        minor = normalizeToMinorUnits(catalogItem.price);
        hasPrice = true;
      } else {
        minor = normalizeToMinorUnits(catalogItem);
        hasPrice = true;
      }
    }

    if (hasPrice) {
      itemsPriced++;
      totalMinor += minor * qty;
    }
  }

  return {
    totalMinor,
    currency,
    formattedTotal: formatMoney(totalMinor, currency),
    itemsPriced,
    totalItems: lines.length,
    isComplete: itemsPriced === lines.length
  };
}

/**
 * Formats a protocol into a clean presentation card for the Practitioner Library.
 * Flags out-of-stock or deleted variants per SPEC §5.
 *
 * @param {any} protocol
 * @param {{
 *   variantCatalogMap?: Record<string, any>,
 *   practiceName?: string,
 *   user?: { id: string, role: string, ownerType: string, ownerId: string } | null,
 *   currency?: string
 * }} [options={}]
 */
export function formatProtocolCard(protocol, {
  variantCatalogMap = {},
  practiceName = '',
  user = null,
  currency = 'USD'
} = {}) {
  if (!protocol || typeof protocol !== 'object') {
    throw new TypeError('Protocol must be a valid object');
  }

  const lines = Array.isArray(protocol.lines) ? protocol.lines : [];
  let unavailableCount = 0;

  const catalogProvided = Object.keys(variantCatalogMap).length > 0;

  const formattedLines = lines.map((line, idx) => {
    const gid = line.variantGid || '';
    const catalogItem = catalogProvided ? variantCatalogMap[gid] : null;

    let isDeleted = false;
    let isOutOfStock = false;
    let itemTitle = line.title || line.productTitle || '';

    if (catalogProvided) {
      if (!catalogItem || catalogItem.isDeleted === true || catalogItem.status === 'ARCHIVED') {
        isDeleted = true;
        unavailableCount++;
      } else if (catalogItem.availableForSale === false) {
        isOutOfStock = true;
        unavailableCount++;
      }

      if (catalogItem?.title && !itemTitle) {
        itemTitle = catalogItem.title;
      }
    }

    return {
      id: line.id || `line-${idx}`,
      position: typeof line.position === 'number' ? line.position : idx,
      variantGid: gid,
      quantity: Number.isInteger(line.quantity) && line.quantity >= 1 ? line.quantity : 1,
      usageNote: line.usageNote || '',
      title: itemTitle,
      isUnavailable: isDeleted || isOutOfStock,
      isDeleted,
      isOutOfStock
    };
  });

  const retailTotal = calculateProtocolRetailTotal(lines, variantCatalogMap, currency);
  const isStarter = Boolean(protocol.isStarter);

  let canEdit = !isStarter;
  let canDuplicate = true;
  let canArchive = !isStarter && protocol.status === 'active';
  let canRestore = !isStarter && protocol.status === 'archived';

  if (user) {
    canEdit = canAccessProtocol(user, protocol, 'edit').allowed;
    canDuplicate = canAccessProtocol(user, protocol, 'duplicate').allowed;
    canArchive = canAccessProtocol(user, protocol, 'archive').allowed;
    canRestore = canAccessProtocol(user, protocol, 'restore').allowed;
  }

  let unavailableNotice = null;
  if (unavailableCount === 1) {
    unavailableNotice = '1 product no longer available';
  } else if (unavailableCount > 1) {
    unavailableNotice = `${unavailableCount} products no longer available`;
  }

  return {
    id: protocol.id,
    token: protocol.token || '',
    name: protocol.name || 'Untitled Protocol',
    displayName: protocol.displayName || practiceName || '',
    introNote: protocol.introNote || '',
    status: protocol.status || 'active',
    isStarter,
    isReadOnly: isStarter,
    ownerType: protocol.ownerType || 'customer',
    ownerId: protocol.ownerId || '',
    createdBy: protocol.createdBy || '',
    updatedBy: protocol.updatedBy || '',
    sourceProtocolId: protocol.sourceProtocolId || null,
    createdAt: protocol.createdAt || null,
    updatedAt: protocol.updatedAt || null,
    lineCount: lines.length,
    totalUnits: lines.reduce((acc, l) => acc + (Number.isInteger(l.quantity) ? l.quantity : 1), 0),
    retailTotal,
    lines: formattedLines,
    unavailableCount,
    hasUnavailableItems: unavailableCount > 0,
    unavailableNotice,
    canEdit,
    canDuplicate,
    canArchive,
    canRestore
  };
}

/**
 * Formats, filters, and searches a list of protocols for the Practitioner Library.
 *
 * @param {{
 *   protocols: any[],
 *   variantCatalogMap?: Record<string, any>,
 *   practiceName?: string,
 *   user?: any,
 *   currency?: string,
 *   filter?: {
 *     status?: string | 'all',
 *     type?: 'all' | 'mine' | 'starters' | 'company'
 *   },
 *   search?: string,
 *   sortBy?: 'updatedAt_desc' | 'updatedAt_asc' | 'name_asc' | 'name_desc' | 'retailTotal_desc'
 * }} options
 */
export function formatProtocolLibrary({
  protocols = [],
  variantCatalogMap = {},
  practiceName = '',
  user = null,
  currency = 'USD',
  filter = { status: 'active', type: 'all' },
  search = '',
  sortBy = 'updatedAt_desc'
} = {}) {
  if (!Array.isArray(protocols)) {
    throw new TypeError('Protocols must be an array');
  }

  let formatted = protocols.map(p => formatProtocolCard(p, {
    variantCatalogMap,
    practiceName,
    user,
    currency
  }));

  // 1. Filter by status
  if (filter?.status && filter.status !== 'all') {
    formatted = formatted.filter(p => p.status === filter.status);
  }

  // 2. Filter by type (starters vs mine)
  if (filter?.type === 'starters') {
    formatted = formatted.filter(p => p.isStarter);
  } else if (filter?.type === 'mine') {
    formatted = formatted.filter(p => !p.isStarter);
  }

  // 3. Search query
  const query = (search || '').trim().toLowerCase();
  if (query) {
    formatted = formatted.filter(p => {
      const matchName = p.name.toLowerCase().includes(query);
      const matchIntro = p.introNote.toLowerCase().includes(query);
      const matchDisplayName = p.displayName.toLowerCase().includes(query);
      const matchLines = p.lines.some(l =>
        l.title.toLowerCase().includes(query) ||
        l.usageNote.toLowerCase().includes(query)
      );
      return matchName || matchIntro || matchDisplayName || matchLines;
    });
  }

  // 4. Sorting
  formatted.sort((a, b) => {
    switch (sortBy) {
      case 'updatedAt_asc': {
        const tA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const tB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return tA - tB;
      }
      case 'name_asc':
        return a.name.localeCompare(b.name);
      case 'name_desc':
        return b.name.localeCompare(a.name);
      case 'retailTotal_desc':
        return b.retailTotal.totalMinor - a.retailTotal.totalMinor;
      case 'updatedAt_desc':
      default: {
        const tA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const tB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return tB - tA;
      }
    }
  });

  const starters = formatted.filter(p => p.isStarter);
  const userProtocols = formatted.filter(p => !p.isStarter);

  return {
    protocols: formatted,
    starters,
    userProtocols,
    summary: {
      totalProtocols: formatted.length,
      activeCount: formatted.filter(p => p.status === 'active').length,
      archivedCount: formatted.filter(p => p.status === 'archived').length,
      starterCount: starters.length,
      withUnavailableCount: formatted.filter(p => p.hasUnavailableItems).length
    }
  };
}

/**
 * Reorders protocol lines either by fromIndex/toIndex or by an explicit array of variantGids.
 * Normalizes positions to 0-based sequential integers.
 *
 * @param {Array<{ variantGid: string, quantity: number, usageNote?: string, position?: number }>} lines
 * @param {{ fromIndex?: number, toIndex?: number, order?: string[] } | string[]} orderConfig
 * @returns {Array<{ variantGid: string, quantity: number, usageNote?: string, position: number }>}
 */
export function reorderProtocolLines(lines, orderConfig) {
  if (!Array.isArray(lines)) {
    throw new TypeError('Lines must be an array');
  }
  if (lines.length <= 1) {
    return lines.map((line, idx) => ({ ...line, position: idx }));
  }

  const result = lines.map(line => ({ ...line }));

  // Case A: Explicit array of variantGid strings
  const explicitOrder = Array.isArray(orderConfig) ? orderConfig : orderConfig?.order;
  if (Array.isArray(explicitOrder)) {
    const lineMap = new Map();
    for (const line of result) {
      lineMap.set(line.variantGid, line);
    }

    const ordered = [];
    const usedGids = new Set();

    for (const gid of explicitOrder) {
      if (lineMap.has(gid)) {
        ordered.push(lineMap.get(gid));
        usedGids.add(gid);
      }
    }

    // Append any lines that weren't in the explicit order list
    for (const line of result) {
      if (!usedGids.has(line.variantGid)) {
        ordered.push(line);
      }
    }

    return ordered.map((line, idx) => ({ ...line, position: idx }));
  }

  // Case B: fromIndex and toIndex
  if (typeof orderConfig === 'object' && orderConfig !== null) {
    const { fromIndex, toIndex } = orderConfig;
    if (typeof fromIndex !== 'number' || typeof toIndex !== 'number') {
      throw new TypeError('Both fromIndex and toIndex must be numbers');
    }
    if (fromIndex < 0 || fromIndex >= result.length || toIndex < 0 || toIndex >= result.length) {
      throw new RangeError(`Indices out of range: fromIndex ${fromIndex}, toIndex ${toIndex}, length ${result.length}`);
    }

    const [moved] = result.splice(fromIndex, 1);
    result.splice(toIndex, 0, moved);

    return result.map((line, idx) => ({ ...line, position: idx }));
  }

  throw new TypeError('Invalid order configuration. Provide { fromIndex, toIndex } or an array of variantGids.');
}

/**
 * Appends a new line to a protocol's line items with validation.
 *
 * @param {Array<any>} lines
 * @param {{ variantGid: string, quantity?: number, usageNote?: string }} newLine
 * @returns {Array<any>}
 */
export function addProtocolLine(lines = [], newLine) {
  if (!Array.isArray(lines)) {
    throw new TypeError('Lines must be an array');
  }
  if (lines.length >= 20) {
    throw new ProtocolValidationError('Protocol cannot exceed 20 product lines', 'MAX_ITEMS', 'lines');
  }
  if (!newLine || typeof newLine !== 'object' || !newLine.variantGid || !newLine.variantGid.trim()) {
    throw new ProtocolValidationError('Variant GID is required', 'REQUIRED', 'variantGid');
  }

  const trimmedGid = newLine.variantGid.trim();
  if (lines.some(l => l.variantGid === trimmedGid)) {
    throw new ProtocolValidationError(
      `Variant '${trimmedGid}' is duplicated. A protocol cannot include duplicate variants.`,
      'DUPLICATE_VARIANT',
      'variantGid'
    );
  }

  const qty = newLine.quantity !== undefined ? newLine.quantity : 1;
  if (!Number.isInteger(qty) || qty < 1 || qty > 10) {
    throw new ProtocolValidationError('Quantity must be an integer between 1 and 10', 'INVALID_QUANTITY', 'quantity');
  }

  let usageNote = '';
  if (newLine.usageNote !== undefined && newLine.usageNote !== null) {
    if (typeof newLine.usageNote !== 'string') {
      throw new ProtocolValidationError('Usage note must be a string', 'INVALID_TYPE', 'usageNote');
    }
    const trimmed = newLine.usageNote.trim();
    if (trimmed.length > 200) {
      throw new ProtocolValidationError('Usage note cannot exceed 200 characters', 'INVALID_LENGTH', 'usageNote');
    }
    usageNote = trimmed;
  }

  const appended = [
    ...lines.map((l, idx) => ({ ...l, position: idx })),
    {
      variantGid: trimmedGid,
      quantity: qty,
      usageNote,
      position: lines.length
    }
  ];

  return appended;
}

/**
 * Updates an existing line in a protocol.
 *
 * @param {Array<any>} lines
 * @param {string | number} variantGidOrIndex
 * @param {{ quantity?: number, usageNote?: string }} updates
 * @returns {Array<any>}
 */
export function updateProtocolLine(lines = [], variantGidOrIndex, updates = {}) {
  if (!Array.isArray(lines)) {
    throw new TypeError('Lines must be an array');
  }

  const targetIdx = typeof variantGidOrIndex === 'number'
    ? variantGidOrIndex
    : lines.findIndex(l => l.variantGid === variantGidOrIndex);

  if (targetIdx < 0 || targetIdx >= lines.length) {
    throw new ProtocolValidationError('Protocol line not found', 'NOT_FOUND', 'variantGid');
  }

  const current = lines[targetIdx];
  let qty = current.quantity;
  if (updates.quantity !== undefined) {
    if (!Number.isInteger(updates.quantity) || updates.quantity < 1 || updates.quantity > 10) {
      throw new ProtocolValidationError('Quantity must be an integer between 1 and 10', 'INVALID_QUANTITY', 'quantity');
    }
    qty = updates.quantity;
  }

  let usageNote = current.usageNote || '';
  if (updates.usageNote !== undefined && updates.usageNote !== null) {
    if (typeof updates.usageNote !== 'string') {
      throw new ProtocolValidationError('Usage note must be a string', 'INVALID_TYPE', 'usageNote');
    }
    const trimmed = updates.usageNote.trim();
    if (trimmed.length > 200) {
      throw new ProtocolValidationError('Usage note cannot exceed 200 characters', 'INVALID_LENGTH', 'usageNote');
    }
    usageNote = trimmed;
  }

  const updated = lines.map((l, idx) => {
    if (idx === targetIdx) {
      return {
        ...l,
        quantity: qty,
        usageNote,
        position: idx
      };
    }
    return { ...l, position: idx };
  });

  return updated;
}

/**
 * Removes a line from a protocol and re-indexes remaining lines sequentially.
 *
 * @param {Array<any>} lines
 * @param {string | number} variantGidOrIndex
 * @returns {Array<any>}
 */
export function removeProtocolLine(lines = [], variantGidOrIndex) {
  if (!Array.isArray(lines)) {
    throw new TypeError('Lines must be an array');
  }

  const targetIdx = typeof variantGidOrIndex === 'number'
    ? variantGidOrIndex
    : lines.findIndex(l => l.variantGid === variantGidOrIndex);

  if (targetIdx < 0 || targetIdx >= lines.length) {
    return lines.map((l, idx) => ({ ...l, position: idx }));
  }

  const filtered = lines.filter((_, idx) => idx !== targetIdx);
  return filtered.map((line, idx) => ({ ...line, position: idx }));
}

/**
 * Validates and prepares the payload for creating or editing protocols in the Protocol Editor.
 * Enforces zero client PII, line limits (1-20), position indexing, and status rules.
 *
 * @param {any} input
 * @param {{ isUpdate?: boolean, isAdmin?: boolean, currentUserId?: string }} [options={}]
 * @returns {{
 *   isValid: boolean,
 *   errors: Array<{ field: string, code: string, message: string }>,
 *   payload: any | null
 * }}
 */
export function prepareProtocolEditorPayload(input, { isUpdate = false, isAdmin = false, currentUserId = null } = {}) {
  const validation = validateProtocolInput(input, { isUpdate, isAdmin });

  if (!validation.isValid) {
    return {
      isValid: false,
      errors: validation.errors,
      payload: null
    };
  }

  const sanitized = validation.sanitized;
  const payload = { ...sanitized };

  if (Array.isArray(payload.lines)) {
    payload.lines = payload.lines.map((line, idx) => ({
      variantGid: line.variantGid,
      quantity: line.quantity,
      usageNote: line.usageNote || '',
      position: idx
    }));
  }

  if (currentUserId) {
    payload.updatedBy = currentUserId;
  }

  return {
    isValid: true,
    errors: [],
    payload
  };
}

/**
 * Detects whether a protocol was edited concurrently by another practitioner
 * in the same company/practice (SPEC §5).
 *
 * @param {{
 *   openedAt: string | Date | number,
 *   protocolUpdatedAt: string | Date | number,
 *   lastUpdatedBy?: string | null,
 *   currentUserId?: string | null
 * }} params
 * @returns {{
 *   hasConflict: boolean,
 *   conflictType: 'PEER_PRACTITIONER_EDIT' | 'SELF_CONCURRENT_EDIT' | 'CONCURRENT_EDIT' | null,
 *   warningMessage: string | null,
 *   openedAt: string | null,
 *   protocolUpdatedAt: string | null,
 *   lastUpdatedBy: string | null
 * }}
 */
export function detectConcurrentEdit({
  openedAt,
  protocolUpdatedAt,
  lastUpdatedBy = null,
  currentUserId = null
} = {}) {
  if (!openedAt || !protocolUpdatedAt) {
    return {
      hasConflict: false,
      conflictType: null,
      warningMessage: null,
      openedAt: openedAt ? new Date(openedAt).toISOString() : null,
      protocolUpdatedAt: protocolUpdatedAt ? new Date(protocolUpdatedAt).toISOString() : null,
      lastUpdatedBy
    };
  }

  const openedTime = new Date(openedAt).getTime();
  const updatedTime = new Date(protocolUpdatedAt).getTime();

  if (Number.isNaN(openedTime) || Number.isNaN(updatedTime)) {
    return {
      hasConflict: false,
      conflictType: null,
      warningMessage: null,
      openedAt: null,
      protocolUpdatedAt: null,
      lastUpdatedBy
    };
  }

  // If protocol was updated after the current practitioner opened the editor
  if (updatedTime > openedTime) {
    let conflictType = 'CONCURRENT_EDIT';
    let warningMessage = 'This protocol was updated by another session since you opened it. Saving now will overwrite those changes.';

    if (lastUpdatedBy && currentUserId) {
      if (String(lastUpdatedBy) !== String(currentUserId)) {
        conflictType = 'PEER_PRACTITIONER_EDIT';
        warningMessage = 'Another practitioner in your practice updated this protocol while you were editing. Saving now will overwrite their changes (last save wins).';
      } else {
        conflictType = 'SELF_CONCURRENT_EDIT';
        warningMessage = 'This protocol was updated in another window or session while you were editing.';
      }
    }

    return {
      hasConflict: true,
      conflictType,
      warningMessage,
      openedAt: new Date(openedTime).toISOString(),
      protocolUpdatedAt: new Date(updatedTime).toISOString(),
      lastUpdatedBy
    };
  }

  return {
    hasConflict: false,
    conflictType: null,
    warningMessage: null,
    openedAt: new Date(openedTime).toISOString(),
    protocolUpdatedAt: new Date(updatedTime).toISOString(),
    lastUpdatedBy
  };
}

/**
 * Builds the complete Practitioner Share Kit for a protocol:
 * share link, vector QR SVG, QR data URI, and printable US Letter / A4 HTML handout (SPEC §8).
 *
 * @param {{
 *   protocol: {
 *     token: string,
 *     name: string,
 *     introNote?: string,
 *     displayName?: string,
 *     lines?: Array<any>
 *   },
 *   shopDomain: string,
 *   practiceName?: string,
 *   pathPrefix?: string,
 *   qrSize?: number
 * }} params
 * @returns {{
 *   token: string,
 *   shareUrl: string,
 *   qrSvg: string,
 *   qrDataUri: string,
 *   handoutHtml: string,
 *   practiceName: string
 * }}
 */
export function generateProtocolShareKit({
  protocol,
  shopDomain,
  practiceName = '',
  pathPrefix = '/apps/protocols',
  qrSize = 200
}) {
  if (!protocol || typeof protocol !== 'object') {
    throw new TypeError('Protocol must be a valid object');
  }
  if (!protocol.token || typeof protocol.token !== 'string' || !protocol.token.trim()) {
    throw new TypeError('Protocol must have a valid share token');
  }
  if (!shopDomain || typeof shopDomain !== 'string' || !shopDomain.trim()) {
    throw new TypeError('shopDomain must be a non-empty string');
  }

  // Normalize shop domain (remove https://, http://, and trailing slashes)
  const cleanDomain = shopDomain.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const cleanPrefix = ('/' + pathPrefix.trim().replace(/^\/+/, '').replace(/\/+$/, '')).replace(/\/+$/, '');
  const shareUrl = `https://${cleanDomain}${cleanPrefix}/${protocol.token.trim()}`;

  const resolvedPractice = practiceName || protocol.displayName || '';
  const qrSvg = generateQrSvg(shareUrl, { size: qrSize });
  const qrDataUri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg)}`;

  const handoutHtml = renderHandoutHtml({
    protocol,
    practiceName: resolvedPractice,
    shareUrl,
    qrSvg
  });

  return {
    token: protocol.token.trim(),
    shareUrl,
    qrSvg,
    qrDataUri,
    handoutHtml,
    practiceName: resolvedPractice
  };
}

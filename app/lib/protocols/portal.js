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

/**
 * Neutralizes Liquid delimiters to prevent template injection on Shopify App Proxy.
 *
 * @param {string} str
 * @returns {string}
 */
function neutralizeLiquid(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/\{\{/g, '&#123;&#123;')
    .replace(/\}\}/g, '&#125;&#125;')
    .replace(/\{%/g, '&#123;%')
    .replace(/%\}/g, '%&#125;');
}

/**
 * Safely HTML-escapes and neutralizes text.
 *
 * @param {string} str
 * @returns {string}
 */
function safePortalText(str) {
  return neutralizeLiquid(escapeHtml(str || ''));
}

/**
 * Renders the full Practitioner Portal Liquid page for Shopify App Proxy (Milestone M3).
 *
 * @param {{
 *   shop?: string,
 *   isLoggedIn?: boolean,
 *   isApproved?: boolean,
 *   practiceName?: string,
 *   activeProtocols?: Array<any>,
 *   archivedProtocols?: Array<any>,
 *   starterProtocols?: Array<any>,
 *   mode?: string
 * }} options
 * @returns {string} Liquid markup string
 */
export function renderPortalLiquid(options = {}) {
  const {
    shop = '',
    isLoggedIn = false,
    isApproved = false,
    practiceName = '',
    activeProtocols = [],
    archivedProtocols = [],
    starterProtocols = [],
    mode = 'tag'
  } = options;

  const robotsMeta = '<meta name="robots" content="noindex, nofollow">';
  const safePractice = safePortalText(practiceName);

  const styles = `
<style>
  .portal-container {
    max-width: 960px;
    margin: 2rem auto;
    padding: 0 1.25rem;
    font-family: inherit;
    color: #1f2937;
    line-height: 1.5;
  }
  .portal-header {
    border-bottom: 1px solid #e5e7eb;
    padding-bottom: 1.5rem;
    margin-bottom: 2rem;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    flex-wrap: wrap;
    gap: 1rem;
  }
  .portal-practice-badge {
    display: inline-block;
    font-size: 0.8125rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #047857;
    background: #ecfdf5;
    padding: 0.25rem 0.625rem;
    border-radius: 9999px;
    margin-bottom: 0.5rem;
  }
  .portal-title {
    font-size: 1.875rem;
    font-weight: 700;
    color: #111827;
    margin: 0 0 0.5rem 0;
  }
  .portal-subtitle {
    font-size: 1rem;
    color: #4b5563;
    margin: 0;
  }
  .portal-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.625rem 1.25rem;
    border-radius: 6px;
    font-weight: 600;
    font-size: 0.875rem;
    cursor: pointer;
    text-decoration: none;
    border: 1px solid transparent;
    transition: all 0.15s ease;
  }
  .portal-btn-primary {
    background-color: #047857;
    color: #ffffff;
  }
  .portal-btn-primary:hover {
    background-color: #065f46;
  }
  .portal-btn-secondary {
    background-color: #ffffff;
    color: #374151;
    border-color: #d1d5db;
  }
  .portal-btn-secondary:hover {
    background-color: #f9fafb;
    border-color: #9ca3af;
  }
  .portal-card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 1.25rem;
    margin-bottom: 2.5rem;
  }
  .portal-card {
    background: #ffffff;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    padding: 1.25rem;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
  }
  .portal-card-title {
    font-size: 1.125rem;
    font-weight: 600;
    color: #111827;
    margin: 0 0 0.5rem 0;
  }
  .portal-card-meta {
    font-size: 0.875rem;
    color: #6b7280;
    margin-bottom: 1rem;
  }
  .portal-card-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-top: 1rem;
    padding-top: 0.875rem;
    border-top: 1px solid #f3f4f6;
  }
  .portal-status-box {
    text-align: center;
    padding: 4rem 1.5rem;
    background: #ffffff;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    margin: 2rem auto;
    max-width: 520px;
  }
  .portal-status-title {
    font-size: 1.5rem;
    font-weight: 700;
    color: #111827;
    margin: 1rem 0 0.5rem 0;
  }
  .portal-status-desc {
    font-size: 1rem;
    color: #6b7280;
    margin: 0 0 1.5rem 0;
    line-height: 1.5;
  }
  .portal-section-heading {
    font-size: 1.25rem;
    font-weight: 700;
    color: #111827;
    margin: 2rem 0 1rem 0;
  }
  /* Protocol Editor Modal */
  .portal-modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background: rgba(0, 0, 0, 0.5);
    display: none;
    align-items: center;
    justify-content: center;
    z-index: 9999;
    padding: 1rem;
    box-sizing: border-box;
  }
  .portal-modal-backdrop.is-active {
    display: flex;
  }
  .portal-modal {
    background: #ffffff;
    border-radius: 12px;
    max-width: 680px;
    width: 100%;
    max-height: 90vh;
    overflow-y: auto;
    box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
    display: flex;
    flex-direction: column;
  }
  .portal-modal-header {
    padding: 1.25rem 1.5rem;
    border-bottom: 1px solid #e5e7eb;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .portal-modal-title {
    font-size: 1.25rem;
    font-weight: 700;
    color: #111827;
    margin: 0;
  }
  .portal-modal-close {
    background: none;
    border: none;
    font-size: 1.5rem;
    cursor: pointer;
    color: #6b7280;
    line-height: 1;
    padding: 0.25rem;
  }
  .portal-modal-close:hover {
    color: #111827;
  }
  .portal-modal-body {
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }
  .portal-form-group {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }
  .portal-form-label {
    font-size: 0.875rem;
    font-weight: 600;
    color: #374151;
  }
  .portal-form-input, .portal-form-textarea {
    width: 100%;
    box-sizing: border-box;
    padding: 0.625rem 0.75rem;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    font-size: 0.9375rem;
    font-family: inherit;
    color: #111827;
  }
  .portal-form-input:focus, .portal-form-textarea:focus {
    outline: none;
    border-color: #047857;
    box-shadow: 0 0 0 1px #047857;
  }
  .portal-search-box {
    display: flex;
    gap: 0.5rem;
    position: relative;
  }
  .portal-search-dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    background: #ffffff;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
    max-height: 240px;
    overflow-y: auto;
    z-index: 10;
    margin-top: 0.25rem;
  }
  .portal-search-item {
    padding: 0.625rem 0.875rem;
    border-bottom: 1px solid #f3f4f6;
    cursor: pointer;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .portal-search-item:hover {
    background-color: #f9fafb;
  }
  .portal-search-item-title {
    font-size: 0.875rem;
    font-weight: 600;
    color: #111827;
  }
  .portal-search-item-meta {
    font-size: 0.75rem;
    color: #6b7280;
  }
  .portal-selected-lines {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .portal-line-item {
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    padding: 0.875rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .portal-line-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .portal-line-title {
    font-weight: 600;
    font-size: 0.9375rem;
    color: #111827;
  }
  .portal-line-remove-btn {
    background: none;
    border: none;
    color: #ef4444;
    cursor: pointer;
    font-size: 1.25rem;
    line-height: 1;
    padding: 0 0.25rem;
  }
  .portal-line-remove-btn:hover {
    color: #b91c1c;
  }
  .portal-line-inputs {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    flex-wrap: wrap;
  }
  .portal-line-qty {
    width: 80px;
  }
  .portal-line-note {
    flex: 1;
    min-width: 160px;
  }
  .portal-modal-footer {
    padding: 1.25rem 1.5rem;
    border-top: 1px solid #e5e7eb;
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: #f9fafb;
    border-bottom-left-radius: 12px;
    border-bottom-right-radius: 12px;
    flex-wrap: wrap;
    gap: 0.75rem;
  }
  .portal-editor-error {
    background-color: #fee2e2;
    border: 1px solid #fca5a5;
    color: #991b1b;
    padding: 0.625rem 0.875rem;
    border-radius: 6px;
    font-size: 0.875rem;
    width: 100%;
    box-sizing: border-box;
  }
</style>`;

  // 1. Unauthenticated state
  if (!isLoggedIn) {
    return `${robotsMeta}${styles}
<div class="portal-container">
  <div class="portal-status-box">
    <svg width="48" height="48" fill="none" viewBox="0 0 24 24" stroke="#047857" style="margin: 0 auto;">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
    </svg>
    <h1 class="portal-status-title">Practitioner Sign In Required</h1>
    <p class="portal-status-desc">Please log in to your customer account to access your protocols library, create recommendations, and generate client share links.</p>
    <a href="/account/login" class="portal-btn portal-btn-primary">Sign In to Account</a>
  </div>
</div>`;
  }

  // 2. Unapproved practitioner state
  if (!isApproved) {
    return `${robotsMeta}${styles}
<div class="portal-container">
  <div class="portal-status-box">
    <svg width="48" height="48" fill="none" viewBox="0 0 24 24" stroke="#d97706" style="margin: 0 auto;">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
    </svg>
    <h1 class="portal-status-title">Account Pending Approval</h1>
    ${safePractice ? `<div class="portal-practice-badge">${safePractice}</div>` : ''}
    <p class="portal-status-desc">Your practitioner account is currently being reviewed by the store administrator. You will be able to create and share client recommendation protocols once your account is approved.</p>
  </div>
</div>`;
  }

  // 3. Approved practitioner: render full portal library
  const renderCards = (protocols, isStarter = false) => {
    if (!protocols || protocols.length === 0) {
      return `<p style="color: #6b7280; font-style: italic;">No protocols found.</p>`;
    }
    return `
    <div class="portal-card-grid">
      ${protocols.map((p) => {
        const title = safePortalText(p.name || 'Untitled Protocol');
        const token = safePortalText(p.token || '');
        const protoId = safePortalText(p.id || '');
        const items = typeof p.linesCount === 'number' ? p.linesCount : (p.lines?.length || 0);
        const retail = safePortalText(p.retailTotal || '$0.00');
        const shareUrl = `/apps/protocols/${token}`;
        const handoutUrl = `/apps/protocols/${token}?handout=1`;

        return `
        <div class="portal-card" data-protocol-id="${protoId}">
          <div>
            <h3 class="portal-card-title">${title}</h3>
            <div class="portal-card-meta">
              <div>${items} ${items === 1 ? 'item' : 'items'} &middot; Total: ${retail}</div>
              <div style="font-size: 0.75rem; margin-top: 0.25rem;">Share token: <code>${token}</code></div>
            </div>
          </div>
          <div class="portal-card-actions">
            <a href="${shareUrl}" class="portal-btn portal-btn-secondary" style="font-size: 0.8125rem; padding: 0.375rem 0.75rem;">Copy Link</a>
            <a href="${handoutUrl}" target="_blank" rel="noopener" class="portal-btn portal-btn-secondary" style="font-size: 0.8125rem; padding: 0.375rem 0.75rem;">Print Handout</a>
            ${!isStarter ? `<button type="button" class="portal-btn portal-btn-secondary portal-edit-btn" data-protocol-id="${protoId}" style="font-size: 0.8125rem; padding: 0.375rem 0.75rem;">Edit</button>` : ''}
          </div>
        </div>`;
      }).join('\n')}
    </div>`;
  };

  const protocolsJson = JSON.stringify([...activeProtocols, ...starterProtocols])
    .replace(/</g, '\\u003c')
    .replace(/\{\{/g, '\\u007b\\u007b')
    .replace(/\}\}/g, '\\u007d\\u007d')
    .replace(/\{%/g, '\\u007b\\u0025')
    .replace(/%\}/g, '\\u0025\\u007d')
    .replace(/%/g, '\\u0025');

  return `${robotsMeta}${styles}
<div class="portal-container">
  <header class="portal-header">
    <div>
      ${safePractice ? `<div class="portal-practice-badge">${safePractice}</div>` : ''}
      <h1 class="portal-title">Practitioner Protocols</h1>
      <p class="portal-subtitle">Create and share curated product recommendation lists with your clients.</p>
    </div>
    <div>
      <button type="button" class="portal-btn portal-btn-primary" id="open-create-protocol-btn">Create Protocol</button>
    </div>
  </header>

  <section>
    <h2 class="portal-section-heading">My Active Protocols (${activeProtocols.length})</h2>
    ${renderCards(activeProtocols, false)}
  </section>

  ${starterProtocols.length > 0 ? `
  <section>
    <h2 class="portal-section-heading">Brand Starter Templates (${starterProtocols.length})</h2>
    ${renderCards(starterProtocols, true)}
  </section>` : ''}

  ${archivedProtocols.length > 0 ? `
  <section>
    <h2 class="portal-section-heading">Archived Protocols (${archivedProtocols.length})</h2>
    ${renderCards(archivedProtocols, false)}
  </section>` : ''}
</div>

<!-- Protocol Editor Modal -->
<div class="portal-modal-backdrop" id="protocol-editor-modal" role="dialog" aria-modal="true" aria-labelledby="protocol-modal-title">
  <div class="portal-modal">
    <div class="portal-modal-header">
      <h2 class="portal-modal-title" id="protocol-modal-title">Create Protocol</h2>
      <button type="button" class="portal-modal-close" id="protocol-editor-close" aria-label="Close">&times;</button>
    </div>
    <div class="portal-modal-body">
      <div id="protocol-editor-error" class="portal-editor-error" style="display:none;" role="alert"></div>

      <div class="portal-form-group">
        <label class="portal-form-label" for="protocol-name-input">Protocol Name * (Max 60 chars)</label>
        <input type="text" id="protocol-name-input" class="portal-form-input" maxlength="60" placeholder="e.g. Daily Essentials Protocol" required>
      </div>

      <div class="portal-form-group">
        <label class="portal-form-label" for="protocol-intro-input">Intro Note / Client Message (Optional, Max 500 chars)</label>
        <textarea id="protocol-intro-input" class="portal-form-textarea" maxlength="500" rows="3" placeholder="Instructions or guidance for your client..."></textarea>
      </div>

      <div class="portal-form-group">
        <label class="portal-form-label" for="product-search-input">Search & Add Products</label>
        <div class="portal-search-box">
          <input type="text" id="product-search-input" class="portal-form-input" placeholder="Search catalog by product name...">
          <button type="button" id="product-search-btn" class="portal-btn portal-btn-secondary">Search</button>
          <div id="product-search-dropdown" class="portal-search-dropdown" style="display:none;"></div>
        </div>
      </div>

      <div class="portal-form-group">
        <label class="portal-form-label">Recommended Products (1 - 20 items)</label>
        <div id="protocol-selected-lines" class="portal-selected-lines">
          <p id="protocol-empty-lines-msg" style="color: #6b7280; font-size: 0.875rem; font-style: italic; margin: 0.5rem 0;">No products added yet. Use the search above to add products.</p>
        </div>
      </div>
    </div>
    <div class="portal-modal-footer">
      <div id="protocol-editor-summary" style="font-size: 0.875rem; color: #4b5563; font-weight: 500;">
        <span id="protocol-editor-count">0 / 20 items</span> &middot; <span id="protocol-editor-total">$0.00</span>
      </div>
      <div style="display: flex; gap: 0.5rem;">
        <button type="button" class="portal-btn portal-btn-secondary" id="protocol-editor-cancel-btn">Cancel</button>
        <button type="button" class="portal-btn portal-btn-primary" id="protocol-save-btn">Save Protocol</button>
      </div>
    </div>
  </div>
</div>

<script type="application/json" id="portal-protocols-data">
${protocolsJson}
</script>

<script>
(function() {
  var protocolsDataEl = document.getElementById('portal-protocols-data');
  var existingProtocols = protocolsDataEl ? JSON.parse(protocolsDataEl.textContent || '[]') : [];

  var modal = document.getElementById('protocol-editor-modal');
  var modalTitle = document.getElementById('protocol-modal-title');
  var nameInput = document.getElementById('protocol-name-input');
  var introInput = document.getElementById('protocol-intro-input');
  var searchInput = document.getElementById('product-search-input');
  var searchBtn = document.getElementById('product-search-btn');
  var searchDropdown = document.getElementById('product-search-dropdown');
  var linesContainer = document.getElementById('protocol-selected-lines');
  var emptyMsg = document.getElementById('protocol-empty-lines-msg');
  var countEl = document.getElementById('protocol-editor-count');
  var totalEl = document.getElementById('protocol-editor-total');
  var saveBtn = document.getElementById('protocol-save-btn');
  var errorBox = document.getElementById('protocol-editor-error');

  var currentEditingProtocolId = null;
  var selectedLines = [];

  function showError(msg) {
    if (!errorBox) return;
    errorBox.textContent = msg;
    errorBox.style.display = 'block';
  }

  function clearError() {
    if (!errorBox) return;
    errorBox.textContent = '';
    errorBox.style.display = 'none';
  }

  function openEditor(proto) {
    clearError();
    currentEditingProtocolId = proto ? (proto.id || null) : null;
    modalTitle.textContent = proto ? 'Edit Protocol' : 'Create Protocol';
    nameInput.value = proto ? (proto.name || '') : '';
    introInput.value = proto ? (proto.introNote || '') : '';
    searchInput.value = '';
    searchDropdown.style.display = 'none';
    searchDropdown.innerHTML = '';

    selectedLines = [];
    if (proto && Array.isArray(proto.lines)) {
      selectedLines = proto.lines.map(function(l) {
        return {
          variantGid: l.variantGid,
          title: l.title || l.productTitle || 'Product',
          price: parseFloat(l.price || '0') || 0,
          quantity: l.quantity || 1,
          usageNote: l.usageNote || ''
        };
      });
    }

    renderSelectedLines();
    modal.classList.add('is-active');
  }

  function closeEditor() {
    modal.classList.remove('is-active');
    clearError();
  }

  function renderSelectedLines() {
    if (selectedLines.length === 0) {
      linesContainer.innerHTML = '';
      if (emptyMsg) {
        linesContainer.appendChild(emptyMsg);
        emptyMsg.style.display = 'block';
      }
    } else {
      linesContainer.innerHTML = '';
      selectedLines.forEach(function(line, idx) {
        var card = document.createElement('div');
        card.className = 'portal-line-item';
        card.setAttribute('data-variant-gid', line.variantGid);

        card.innerHTML = 
          '<div class="portal-line-header">' +
            '<span class="portal-line-title">' + (line.title || 'Product') + ' - $' + (line.price ? line.price.toFixed(2) : '0.00') + '</span>' +
            '<button type="button" class="portal-line-remove-btn" data-index="' + idx + '" aria-label="Remove item">&times;</button>' +
          '</div>' +
          '<div class="portal-line-inputs">' +
            '<div style="display:flex; align-items:center; gap:0.25rem;">' +
              '<label style="font-size:0.75rem; color:#6b7280;">Qty:</label>' +
              '<input type="number" min="1" max="10" value="' + (line.quantity || 1) + '" class="portal-form-input portal-line-qty" data-index="' + idx + '">' +
            '</div>' +
            '<input type="text" maxlength="200" value="' + (line.usageNote || '') + '" class="portal-form-input portal-line-note" data-index="' + idx + '" placeholder="Instructions (e.g. 1 with food)">' +
          '</div>';

        linesContainer.appendChild(card);
      });
    }

    updateSummary();
  }

  function updateSummary() {
    var count = selectedLines.length;
    countEl.textContent = count + ' / 20 items';

    var total = 0;
    selectedLines.forEach(function(l) {
      total += (l.price || 0) * (l.quantity || 1);
    });
    totalEl.textContent = '$' + total.toFixed(2);
  }

  // Open Create Protocol
  var createBtn = document.getElementById('open-create-protocol-btn');
  if (createBtn) {
    createBtn.addEventListener('click', function() {
      openEditor(null);
    });
  }

  // Close modal handlers
  var closeBtn = document.getElementById('protocol-editor-close');
  if (closeBtn) closeBtn.addEventListener('click', closeEditor);
  var cancelBtn = document.getElementById('protocol-editor-cancel-btn');
  if (cancelBtn) cancelBtn.addEventListener('click', closeEditor);

  // Edit Protocol handlers
  var editButtons = document.querySelectorAll('.portal-edit-btn');
  editButtons.forEach(function(btn) {
    btn.addEventListener('click', function() {
      var id = btn.getAttribute('data-protocol-id');
      var found = existingProtocols.find(function(p) { return p.id === id; });
      openEditor(found || { id: id });
    });
  });

  // Remove line handler
  linesContainer.addEventListener('click', function(e) {
    if (e.target && e.target.classList.contains('portal-line-remove-btn')) {
      var idx = parseInt(e.target.getAttribute('data-index'), 10);
      if (!isNaN(idx) && idx >= 0 && idx < selectedLines.length) {
        selectedLines.splice(idx, 1);
        renderSelectedLines();
      }
    }
  });

  // Quantity and Usage Note change handlers
  linesContainer.addEventListener('input', function(e) {
    if (!e.target) return;
    var idx = parseInt(e.target.getAttribute('data-index'), 10);
    if (isNaN(idx) || idx < 0 || idx >= selectedLines.length) return;

    if (e.target.classList.contains('portal-line-qty')) {
      var val = parseInt(e.target.value, 10);
      if (val >= 1 && val <= 10) {
        selectedLines[idx].quantity = val;
        updateSummary();
      }
    } else if (e.target.classList.contains('portal-line-note')) {
      selectedLines[idx].usageNote = e.target.value.substring(0, 200);
    }
  });

  // Product Search handler
  function performSearch() {
    var query = (searchInput.value || '').trim();
    if (!query) return;

    searchBtn.disabled = true;
    searchBtn.textContent = '...';

    fetch('/apps/protocols?action=search&q=' + encodeURIComponent(query), {
      headers: { 'Accept': 'application/json' }
    })
    .then(function(res) {
      if (!res.ok) throw new Error('Search failed');
      return res.json();
    })
    .then(function(data) {
      searchBtn.disabled = false;
      searchBtn.textContent = 'Search';
      var products = data.products || [];

      if (products.length === 0) {
        searchDropdown.innerHTML = '<div style="padding:0.75rem; color:#6b7280; font-size:0.875rem;">No matching products found.</div>';
        searchDropdown.style.display = 'block';
        return;
      }

      searchDropdown.innerHTML = '';
      products.forEach(function(prod) {
        (prod.variants || []).forEach(function(v) {
          var item = document.createElement('div');
          item.className = 'portal-search-item';
          item.innerHTML = 
            '<div>' +
              '<div class="portal-search-item-title">' + (v.displayTitle || prod.title) + '</div>' +
              '<div class="portal-search-item-meta">' + (v.priceFormatted || ('$' + v.price)) + '</div>' +
            '</div>' +
            '<button type="button" class="portal-btn portal-btn-secondary" style="font-size:0.75rem; padding:0.25rem 0.5rem;">+ Add</button>';

          item.addEventListener('click', function() {
            addVariant(v, prod.title);
          });

          searchDropdown.appendChild(item);
        });
      });

      searchDropdown.style.display = 'block';
    })
    .catch(function(err) {
      searchBtn.disabled = false;
      searchBtn.textContent = 'Search';
      console.error('[Protocol Portal] Search error:', err);
    });
  }

  if (searchBtn) searchBtn.addEventListener('click', performSearch);
  if (searchInput) {
    searchInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        performSearch();
      }
    });
  }

  function addVariant(v, prodTitle) {
    clearError();
    if (selectedLines.length >= 20) {
      showError('A protocol cannot exceed 20 product lines.');
      return;
    }
    var exists = selectedLines.some(function(l) { return l.variantGid === v.id; });
    if (exists) {
      showError('This variant is already in the protocol.');
      return;
    }

    selectedLines.push({
      variantGid: v.id,
      title: v.displayTitle || prodTitle,
      price: parseFloat(v.price || '0') || 0,
      quantity: 1,
      usageNote: ''
    });

    searchDropdown.style.display = 'none';
    searchInput.value = '';
    renderSelectedLines();
  }

  // Save Protocol handler
  if (saveBtn) {
    saveBtn.addEventListener('click', function() {
      clearError();
      var name = (nameInput.value || '').trim();
      var intro = (introInput.value || '').trim();

      if (!name) {
        showError('Protocol name is required.');
        nameInput.focus();
        return;
      }
      if (name.length > 60) {
        showError('Protocol name cannot exceed 60 characters.');
        return;
      }
      if (intro.length > 500) {
        showError('Intro note cannot exceed 500 characters.');
        return;
      }
      if (selectedLines.length === 0) {
        showError('Please add at least one product line to the protocol.');
        return;
      }
      if (selectedLines.length > 20) {
        showError('A protocol cannot exceed 20 product lines.');
        return;
      }

      var payload = {
        name: name,
        introNote: intro,
        lines: selectedLines.map(function(l) {
          return {
            variantGid: l.variantGid,
            quantity: l.quantity || 1,
            usageNote: (l.usageNote || '').trim()
          };
        })
      };

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';

      var endpoint = '/apps/protocols';
      var method = currentEditingProtocolId ? 'PUT' : 'POST';
      var url = currentEditingProtocolId ? (endpoint + '?action=update&id=' + encodeURIComponent(currentEditingProtocolId)) : (endpoint + '?action=create');

      fetch(url, {
        method: method,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      })
      .then(function(res) {
        return res.json().catch(function() { return null; }).then(function(data) {
          if (!res.ok) {
            var msg = (data && (data.error || data.message)) || ('Save failed (' + res.status + ')');
            throw new Error(msg);
          }
          return data;
        });
      })
      .then(function() {
        closeEditor();
        window.location.reload();
      })
      .catch(function(err) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Protocol';
        showError(err.message || 'Unable to save protocol. Please try again.');
      });
    });
  }
})();
</script>`;
}

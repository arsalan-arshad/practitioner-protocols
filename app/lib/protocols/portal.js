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
 * @returns {string} Formatted string, e.g. "29.99"
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
    return major.toFixed(2);
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
      productHandle: line.productHandle || null,
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
    hasProfile,
    practiceName = '',
    activeProtocols = [],
    archivedProtocols = [],
    starterProtocols = [],
    contacts = [],
    mode = 'tag',
    allowSelfEnrol = false,
    identityMode = 'tag'
  } = options;

  const robotsMeta = '<meta name="robots" content="noindex, nofollow">';
  const safePractice = safePortalText(practiceName);
  const safeShop = safePortalText(shop);

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
  .portal-form-label {
    display: block;
    font-size: 0.875rem;
    font-weight: 600;
    color: #374151;
    margin-bottom: 0.375rem;
  }
  .portal-form-input {
    width: 100%;
    box-sizing: border-box;
    padding: 0.625rem 0.75rem;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    font-size: 0.9375rem;
    color: #111827;
    background: #ffffff;
    transition: border-color 0.15s ease;
  }
  .portal-form-input:focus {
    outline: none;
    border-color: #047857;
    box-shadow: 0 0 0 3px rgba(4, 120, 87, 0.1);
  }
  .portal-status-region {
    font-size: 0.875rem;
    min-height: 1.25rem;
    margin-top: 0.5rem;
    font-weight: 500;
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
<div class="portal-container" data-shop="${safeShop}">
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

  // 2. Logged-in customer without a practitioner profile
  if (hasProfile === false) {
    if (allowSelfEnrol && identityMode === 'tag') {
      // 2a. Request Practitioner Access Form (Tag mode, open)
      return `${robotsMeta}${styles}
<div class="portal-container" data-shop="${safeShop}">
  <div class="portal-status-box" style="text-align: left; max-width: 540px;">
    <div style="text-align: center; margin-bottom: 1.5rem;">
      <svg width="48" height="48" fill="none" viewBox="0 0 24 24" stroke="#047857" style="margin: 0 auto 0.75rem auto;">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
      </svg>
      <h1 class="portal-status-title" style="margin-top: 0;">Request Practitioner Access</h1>
      <p class="portal-status-desc" style="margin-bottom: 0;">Apply to create and share custom product recommendations with your clients.</p>
    </div>

    <form id="practitioner-enrol-form" method="POST" action="/apps/protocols?action=enrol" style="display: flex; flex-direction: column; gap: 1rem;">
      <div>
        <label for="practice-name-input" class="portal-form-label">
          Practice or Business Name (optional)
        </label>
        <input
          type="text"
          id="practice-name-input"
          name="practiceName"
          class="portal-form-input"
          maxlength="60"
          placeholder="e.g. Acme Wellness"
          autocomplete="organization"
        />
        <div style="font-size: 0.75rem; color: #6b7280; margin-top: 0.25rem;">
          Maximum 60 characters. Displayed as unverified until approved.
        </div>
      </div>

      <div id="enrol-status-message" aria-live="polite" role="status" class="portal-status-region"></div>

      <div style="display: flex; justify-content: flex-end; gap: 0.75rem; margin-top: 0.5rem;">
        <button type="submit" id="enrol-submit-btn" class="portal-btn portal-btn-primary" style="width: 100%;">
          Request Access
        </button>
      </div>
    </form>
  </div>
</div>
<script>
(function() {
  var form = document.getElementById('practitioner-enrol-form');
  if (!form) return;
  var btn = document.getElementById('enrol-submit-btn');
  var statusEl = document.getElementById('enrol-status-message');
  var input = document.getElementById('practice-name-input');

  form.addEventListener('submit', function(e) {
    e.preventDefault();
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = 'Submitting...';
    statusEl.textContent = '';
    statusEl.style.color = '#374151';

    var practiceName = (input && input.value ? input.value : '').trim();

    fetch(form.action || '/apps/protocols?action=enrol', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ practiceName: practiceName })
    })
    .then(function(res) {
      return res.json().then(function(data) {
        return { status: res.status, data: data };
      }).catch(function() {
        return { status: res.status, data: {} };
      });
    })
    .then(function(result) {
      if (result.status === 200 || result.status === 201) {
        statusEl.style.color = '#047857';
        statusEl.textContent = 'Your request has been submitted for review. Please check back soon.';
        setTimeout(function() {
          window.location.reload();
        }, 1500);
      } else if (result.status === 429) {
        statusEl.style.color = '#dc2626';
        statusEl.textContent = result.data.error || 'Enrolment is temporarily at capacity. Please try again later.';
        btn.disabled = false;
        btn.textContent = 'Request Access';
      } else if (result.status === 403) {
        statusEl.style.color = '#dc2626';
        statusEl.textContent = result.data.error || 'Self-enrolment is not available.';
        btn.disabled = false;
        btn.textContent = 'Request Access';
      } else {
        statusEl.style.color = '#dc2626';
        statusEl.textContent = result.data.error || 'Unable to submit request. Please try again.';
        btn.disabled = false;
        btn.textContent = 'Request Access';
      }
    })
    .catch(function() {
      statusEl.style.color = '#dc2626';
      statusEl.textContent = 'Network error. Please try again.';
      btn.disabled = false;
      btn.textContent = 'Request Access';
    });
  });
})();
</script>`;
    }

    // 2b. Invite-Only Notice (Tag mode closed or Company mode)
    return `${robotsMeta}${styles}
<div class="portal-container" data-shop="${safeShop}">
  <div class="portal-status-box">
    <svg width="48" height="48" fill="none" viewBox="0 0 24 24" stroke="#6b7280" style="margin: 0 auto;">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
    </svg>
    <h1 class="portal-status-title">Practitioner Program (Invite Only)</h1>
    <p class="portal-status-desc">Enrolment in the practitioner program is currently by invitation only. If you are an active practitioner, please contact the store administrator for access.</p>
  </div>
</div>`;
  }

  // 3. Unapproved practitioner state (has profile row, but isApproved is false)
  if (!isApproved) {
    return `${robotsMeta}${styles}
<div class="portal-container" data-shop="${safeShop}">
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
  const renderCards = (protocols, isStarter = false, isArchived = false) => {
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
        const shareUrl = `/apps/protocols/${token}`;
        const absoluteShareUrl = shop ? `https://${shop}/apps/protocols/${token}` : shareUrl;
        const handoutUrl = `/apps/protocols/${token}?handout=1`;

        let actionButtons = '';
        let confirmHtml = '';

        if (isStarter) {
          actionButtons = `
            <a href="${shareUrl}" data-share-url="${absoluteShareUrl}" class="portal-btn portal-btn-secondary portal-copy-link-btn" style="font-size: 0.8125rem; padding: 0.375rem 0.75rem;">Copy Link</a>
            <a href="${handoutUrl}" target="_blank" rel="noopener" class="portal-btn portal-btn-secondary" style="font-size: 0.8125rem; padding: 0.375rem 0.75rem;">Print Handout</a>
            <button type="button" class="portal-btn portal-btn-secondary portal-duplicate-btn" data-protocol-id="${protoId}" style="font-size: 0.8125rem; padding: 0.375rem 0.75rem;">Use as template</button>`;
        } else if (isArchived) {
          actionButtons = `
            <button type="button" class="portal-btn portal-btn-secondary portal-restore-btn" data-protocol-id="${protoId}" style="font-size: 0.8125rem; padding: 0.375rem 0.75rem;">Restore</button>`;
        } else {
          actionButtons = `
            <a href="${shareUrl}" data-share-url="${absoluteShareUrl}" class="portal-btn portal-btn-secondary portal-copy-link-btn" style="font-size: 0.8125rem; padding: 0.375rem 0.75rem;">Copy Link</a>
            <a href="${handoutUrl}" target="_blank" rel="noopener" class="portal-btn portal-btn-secondary" style="font-size: 0.8125rem; padding: 0.375rem 0.75rem;">Print Handout</a>
            <button type="button" class="portal-btn portal-btn-secondary portal-edit-btn" data-protocol-id="${protoId}" style="font-size: 0.8125rem; padding: 0.375rem 0.75rem;">Edit</button>
            <button type="button" class="portal-btn portal-btn-secondary portal-archive-btn" data-protocol-id="${protoId}" style="font-size: 0.8125rem; padding: 0.375rem 0.75rem; color: #dc2626;">Archive</button>`;
          confirmHtml = `
          <div class="portal-archive-confirm" style="display: none; margin-top: 0.75rem; padding: 0.5rem; background: #fef2f2; border: 1px solid #fecaca; border-radius: 0.375rem; font-size: 0.8125rem; color: #991b1b; align-items: center; justify-content: space-between; gap: 0.5rem;">
            <span>Archive this protocol?</span>
            <div style="display: flex; gap: 0.25rem;">
              <button type="button" class="portal-btn portal-btn-secondary portal-cancel-archive-btn" data-protocol-id="${protoId}" style="font-size: 0.75rem; padding: 0.25rem 0.5rem;">Cancel</button>
              <button type="button" class="portal-btn portal-confirm-archive-btn" data-protocol-id="${protoId}" style="font-size: 0.75rem; padding: 0.25rem 0.5rem; background: #dc2626; color: #fff; border: 1px solid #dc2626;">Confirm</button>
            </div>
          </div>`;
        }

        return `
        <div class="portal-card" data-protocol-id="${protoId}">
          <div>
            <h3 class="portal-card-title">${title}</h3>
            <div class="portal-card-meta">
              <div>${items} ${items === 1 ? 'item' : 'items'}</div>
              <div style="font-size: 0.75rem; margin-top: 0.25rem;">Share token: <code>${token}</code></div>
            </div>
          </div>
          <div class="portal-card-actions">
            ${actionButtons}
          </div>
          ${confirmHtml}
        </div>`;
      }).join('\n')}
    </div>`;
  };

  const protocolsJson = JSON.stringify([...activeProtocols, ...starterProtocols, ...archivedProtocols])
    .replace(/</g, '\\u003c')
    .replace(/\{\{/g, '\\u007b\\u007b')
    .replace(/\}\}/g, '\\u007d\\u007d')
    .replace(/\{%/g, '\\u007b\\u0025')
    .replace(/%\}/g, '\\u0025\\u007d')
    .replace(/%/g, '\\u0025');

  return `${robotsMeta}${styles}
<div class="portal-container">
  <div id="portal-global-error" class="portal-editor-error" style="display:none; margin-bottom: 1rem;" role="alert"></div>

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
    ${renderCards(activeProtocols, false, false)}
  </section>

  ${starterProtocols.length > 0 ? `
  <section>
    <h2 class="portal-section-heading">Brand Starter Templates (${starterProtocols.length})</h2>
    ${renderCards(starterProtocols, true, false)}
  </section>` : ''}

  ${archivedProtocols.length > 0 ? `
  <section>
    <h2 class="portal-section-heading">Archived Protocols (${archivedProtocols.length})</h2>
    ${renderCards(archivedProtocols, false, true)}
  </section>` : ''}

  <section class="portal-contacts-section" style="margin-top:2.5rem;">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem; flex-wrap:wrap; gap:0.5rem;">
      <h2 class="portal-section-heading" style="margin:0;">My Contacts (${contacts.length})</h2>
      ${contacts.length > 0 ? `
      <a href="/apps/protocols?action=contacts_csv" class="portal-btn portal-btn-secondary" style="font-size:0.8125rem; padding:0.375rem 0.75rem;">
        Export CSV
      </a>` : ''}
    </div>
    ${contacts.length === 0 ? `
    <div class="portal-empty-card" style="padding:1.5rem; text-align:center; background:#ffffff; border:1px solid #e5e7eb; border-radius:8px; color:#6b7280;">
      No contacts yet. Shoppers who opt in via your recommendation links will appear here.
    </div>` : `
    <div style="background:#ffffff; border:1px solid #e5e7eb; border-radius:8px; overflow-x:auto;">
      <table style="width:100%; border-collapse:collapse; font-size:0.875rem;">
        <thead>
          <tr style="background:#f9fafb; border-bottom:1px solid #e5e7eb; text-align:left;">
            <th style="padding:0.75rem 1rem; font-weight:600; color:#374151;">Email</th>
            <th style="padding:0.75rem 1rem; font-weight:600; color:#374151;">First Name</th>
            <th style="padding:0.75rem 1rem; font-weight:600; color:#374151;">Consented</th>
            <th style="padding:0.75rem 1rem; font-weight:600; color:#374151; text-align:right;">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${contacts.map(c => `
          <tr style="border-bottom:1px solid #e5e7eb;" data-contact-row="${safePortalText(c.id)}">
            <td style="padding:0.75rem 1rem; color:#111827;">${safePortalText(c.email)}</td>
            <td style="padding:0.75rem 1rem; color:#4b5563;">${c.firstName ? safePortalText(c.firstName) : '—'}</td>
            <td style="padding:0.75rem 1rem; color:#6b7280;">${safePortalText(c.consentedAt ? new Date(c.consentedAt).toLocaleDateString() : '')}</td>
            <td style="padding:0.75rem 1rem; text-align:right;">
              <button type="button" class="portal-btn portal-btn-secondary portal-delete-contact-btn" data-contact-id="${safePortalText(c.id)}" style="padding:0.25rem 0.625rem; font-size:0.75rem; color:#dc2626; border-color:#fca5a5;">
                Delete
              </button>
            </td>
          </tr>
          `).join('')}
        </tbody>
      </table>
    </div>`}
  </section>
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
        <span id="protocol-editor-count">0 / 20 items</span> &middot; <span id="protocol-editor-total"></span>
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
  var searchDebounceTimer = null;

  var liquidCurrency = (function() {
    var raw = '{{ cart.currency.iso_code | json }}';
    if (raw && raw.indexOf('{') === -1) {
      try { return JSON.parse(raw); } catch (e) { return raw; }
    }
    return '';
  })();

  function formatMoney(minorUnits) {
    var num = typeof minorUnits === 'number' ? minorUnits : parseFloat(minorUnits);
    if (isNaN(num)) return '';
    var major = num / 100;
    var cur = (window.Shopify && window.Shopify.currency && window.Shopify.currency.active) || liquidCurrency || '';
    if (cur) {
      try {
        var lang = (document.documentElement && document.documentElement.lang) || undefined;
        return new Intl.NumberFormat(lang, { style: 'currency', currency: cur }).format(major);
      } catch (e) {}
    }
    return major.toFixed(2);
  }

  if (totalEl) {
    totalEl.textContent = formatMoney(0);
  }

  function clearElement(el) {
    if (!el) return;
    while (el.firstChild) {
      el.removeChild(el.firstChild);
    }
  }

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

  var globalErrorBox = document.getElementById('portal-global-error');
  function showGlobalError(msg) {
    if (!globalErrorBox) return;
    globalErrorBox.textContent = msg;
    globalErrorBox.style.display = 'block';
    try {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {}
  }

  function openEditor(proto) {
    clearError();
    currentEditingProtocolId = proto ? (proto.id || null) : null;
    modalTitle.textContent = proto ? 'Edit Protocol' : 'Create Protocol';
    nameInput.value = proto ? (proto.name || '') : '';
    introInput.value = proto ? (proto.introNote || '') : '';
    searchInput.value = '';
    searchDropdown.style.display = 'none';
    clearElement(searchDropdown);

    selectedLines = [];
    if (proto && Array.isArray(proto.lines)) {
      selectedLines = proto.lines.map(function(l) {
        return {
          variantGid: l.variantGid,
          productHandle: l.productHandle || null,
          title: l.title || l.productTitle || (l.productHandle ? l.productHandle : 'Product'),
          price: typeof l.price === 'number' ? l.price : (parseFloat(l.price || '0') || 0),
          quantity: l.quantity || 1,
          usageNote: l.usageNote || ''
        };
      });

      // Hydrate missing line details in editor if productHandle is available
      selectedLines.forEach(function(line) {
        if (line.productHandle && (!line.title || line.title === 'Product' || line.title === line.productHandle)) {
          fetch('/products/' + encodeURIComponent(line.productHandle) + '.js', {
            headers: { 'Accept': 'application/json' }
          })
          .then(function(res) { return res.ok ? res.json() : null; })
          .then(function(prod) {
            if (!prod) return;
            var normId = String(line.variantGid).replace('gid://shopify/ProductVariant/', '');
            var v = (prod.variants || []).find(function(item) {
              return String(item.id) === normId || ('gid://shopify/ProductVariant/' + item.id) === line.variantGid;
            });
            if (v) {
              var vTitle = v.title && v.title !== 'Default Title' ? v.title : '';
              line.title = (prod.title || 'Product') + (vTitle ? ' - ' + vTitle : '');
              var priceCents = typeof v.price === 'number' ? v.price : (parseFloat(v.price || '0') * 100);
              line.price = priceCents / 100;
              renderSelectedLines();
            }
          })
          .catch(function() {});
        }
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
    clearElement(linesContainer);
    if (selectedLines.length === 0) {
      if (emptyMsg) {
        linesContainer.appendChild(emptyMsg);
        emptyMsg.style.display = 'block';
      }
    } else {
      selectedLines.forEach(function(line, idx) {
        var card = document.createElement('div');
        card.className = 'portal-line-item';
        card.setAttribute('data-variant-gid', line.variantGid);

        var header = document.createElement('div');
        header.className = 'portal-line-header';

        var titleSpan = document.createElement('span');
        titleSpan.className = 'portal-line-title';
        var priceStr = typeof line.price === 'number' ? ' - ' + formatMoney(Math.round(line.price * 100)) : '';
        titleSpan.textContent = (line.title || 'Product') + priceStr;
        header.appendChild(titleSpan);

        var removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'portal-line-remove-btn';
        removeBtn.setAttribute('data-index', String(idx));
        removeBtn.setAttribute('aria-label', 'Remove item');
        removeBtn.textContent = '×';
        header.appendChild(removeBtn);
        card.appendChild(header);

        var inputsDiv = document.createElement('div');
        inputsDiv.className = 'portal-line-inputs';

        var qtyWrap = document.createElement('div');
        qtyWrap.style.cssText = 'display:flex; align-items:center; gap:0.25rem;';
        var qtyLabel = document.createElement('label');
        qtyLabel.style.cssText = 'font-size:0.75rem; color:#6b7280;';
        qtyLabel.textContent = 'Qty:';
        qtyWrap.appendChild(qtyLabel);

        var qtyInput = document.createElement('input');
        qtyInput.type = 'number';
        qtyInput.min = '1';
        qtyInput.max = '10';
        qtyInput.value = String(line.quantity || 1);
        qtyInput.className = 'portal-form-input portal-line-qty';
        qtyInput.setAttribute('data-index', String(idx));
        qtyWrap.appendChild(qtyInput);
        inputsDiv.appendChild(qtyWrap);

        var noteInput = document.createElement('input');
        noteInput.type = 'text';
        noteInput.maxLength = 200;
        noteInput.value = line.usageNote || '';
        noteInput.className = 'portal-form-input portal-line-note';
        noteInput.setAttribute('data-index', String(idx));
        noteInput.placeholder = 'Instructions (e.g. 1 with food)';
        inputsDiv.appendChild(noteInput);

        card.appendChild(inputsDiv);
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
    totalEl.textContent = formatMoney(Math.round(total * 100));
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

  // Copy Link handlers (copies absolute share URL with fallback and visual feedback)
  function copyTextToClipboard(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function(resolve, reject) {
      try {
        var textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.top = '0';
        document.body.appendChild(textarea);
        textarea.select();
        var successful = document.execCommand('copy');
        document.body.removeChild(textarea);
        if (successful) {
          resolve();
        } else {
          reject(new Error('execCommand copy failed'));
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  var copyButtons = document.querySelectorAll('.portal-copy-link-btn');
  copyButtons.forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      var targetUrl = btn.getAttribute('data-share-url') || btn.getAttribute('href');
      if (!targetUrl) return;
      if (targetUrl.indexOf('http://') !== 0 && targetUrl.indexOf('https://') !== 0) {
        if (typeof window !== 'undefined' && window.location && window.location.origin) {
          targetUrl = window.location.origin + targetUrl;
        }
      }
      e.preventDefault();
      var originalText = btn.textContent;
      copyTextToClipboard(targetUrl).then(function() {
        btn.textContent = 'Copied!';
        setTimeout(function() {
          btn.textContent = originalText;
        }, 2000);
      }).catch(function() {
        window.location.href = btn.getAttribute('href') || targetUrl;
      });
    });
  });

  // Edit Protocol handlers
  var editButtons = document.querySelectorAll('.portal-edit-btn');
  editButtons.forEach(function(btn) {
    btn.addEventListener('click', function() {
      var id = btn.getAttribute('data-protocol-id');
      var found = existingProtocols.find(function(p) { return p.id === id; });
      openEditor(found || { id: id });
    });
  });

  // Archive button handlers (toggle inline confirmation)
  var archiveButtons = document.querySelectorAll('.portal-archive-btn');
  archiveButtons.forEach(function(btn) {
    btn.addEventListener('click', function() {
      var card = btn.closest('.portal-card');
      if (!card) return;
      var confirmBox = card.querySelector('.portal-archive-confirm');
      if (confirmBox) {
        confirmBox.style.display = 'flex';
      }
    });
  });

  // Cancel archive button handlers
  var cancelArchiveButtons = document.querySelectorAll('.portal-cancel-archive-btn');
  cancelArchiveButtons.forEach(function(btn) {
    btn.addEventListener('click', function() {
      var card = btn.closest('.portal-card');
      if (!card) return;
      var confirmBox = card.querySelector('.portal-archive-confirm');
      if (confirmBox) {
        confirmBox.style.display = 'none';
      }
    });
  });

  // Confirm archive button handlers
  var confirmArchiveButtons = document.querySelectorAll('.portal-confirm-archive-btn');
  confirmArchiveButtons.forEach(function(btn) {
    btn.addEventListener('click', function() {
      var protoId = btn.getAttribute('data-protocol-id');
      if (!protoId) return;
      btn.disabled = true;
      btn.textContent = '...';
      fetch('/apps/protocols?action=archive&id=' + encodeURIComponent(protoId), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: '{}'
      })
      .then(function(res) {
        return res.json().catch(function() { return null; }).then(function(data) {
          if (!res.ok) {
            var msg = (data && (data.error || data.message)) || ('Archive failed (' + res.status + ')');
            throw new Error(msg);
          }
          return data;
        });
      })
      .then(function() {
        window.location.reload();
      })
      .catch(function(err) {
        btn.disabled = false;
        btn.textContent = 'Confirm';
        showGlobalError(err.message || 'Unable to archive protocol.');
      });
    });
  });

  // Restore protocol handlers
  var restoreButtons = document.querySelectorAll('.portal-restore-btn');
  restoreButtons.forEach(function(btn) {
    btn.addEventListener('click', function() {
      var protoId = btn.getAttribute('data-protocol-id');
      if (!protoId) return;
      btn.disabled = true;
      btn.textContent = '...';
      fetch('/apps/protocols?action=restore&id=' + encodeURIComponent(protoId), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: '{}'
      })
      .then(function(res) {
        return res.json().catch(function() { return null; }).then(function(data) {
          if (!res.ok) {
            var msg = (data && (data.error || data.message)) || ('Restore failed (' + res.status + ')');
            throw new Error(msg);
          }
          return data;
        });
      })
      .then(function() {
        window.location.reload();
      })
      .catch(function(err) {
        btn.disabled = false;
        btn.textContent = 'Restore';
        showGlobalError(err.message || 'Unable to restore protocol.');
      });
    });
  });

  // Duplicate protocol handlers ("Use as template")
  var duplicateButtons = document.querySelectorAll('.portal-duplicate-btn');
  duplicateButtons.forEach(function(btn) {
    btn.addEventListener('click', function() {
      var protoId = btn.getAttribute('data-protocol-id');
      if (!protoId) return;
      btn.disabled = true;
      btn.textContent = '...';
      fetch('/apps/protocols?action=duplicate&id=' + encodeURIComponent(protoId), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: '{}'
      })
      .then(function(res) {
        return res.json().catch(function() { return null; }).then(function(data) {
          if (!res.ok) {
            var msg = (data && (data.error || data.message)) || ('Duplicate failed (' + res.status + ')');
            throw new Error(msg);
          }
          return data;
        });
      })
      .then(function() {
        window.location.reload();
      })
      .catch(function(err) {
        btn.disabled = false;
        btn.textContent = 'Use as template';
        showGlobalError(err.message || 'Unable to duplicate protocol.');
      });
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

  // Product Search handler with debounce and suggest.json
  function performSearch(query) {
    var q = (typeof query === 'string' ? query : (searchInput.value || '')).trim();
    if (q.length < 2) {
      searchDropdown.style.display = 'none';
      clearElement(searchDropdown);
      return;
    }

    if (searchBtn) {
      searchBtn.disabled = true;
      searchBtn.textContent = '...';
    }

    clearElement(searchDropdown);
    var loadingDiv = document.createElement('div');
    loadingDiv.style.cssText = 'padding:0.75rem; color:#6b7280; font-size:0.875rem;';
    loadingDiv.textContent = 'Searching...';
    searchDropdown.appendChild(loadingDiv);
    searchDropdown.style.display = 'block';

    var suggestUrl = '/search/suggest.json?resources[type]=product&resources[limit]=10&resources[options][unavailable_products]=show&q=' + encodeURIComponent(q);

    fetch(suggestUrl, {
      headers: { 'Accept': 'application/json' }
    })
    .then(function(res) {
      if (!res.ok) {
        throw new Error('Search failed');
      }
      return res.json();
    })
    .then(function(data) {
      if (searchBtn) {
        searchBtn.disabled = false;
        searchBtn.textContent = 'Search';
      }
      clearElement(searchDropdown);

      var products = [];
      if (data && data.resources && data.resources.results && Array.isArray(data.resources.results.products)) {
        products = data.resources.results.products;
      } else if (data && Array.isArray(data.products)) {
        products = data.products;
      }

      if (products.length === 0) {
        var emptyDiv = document.createElement('div');
        emptyDiv.style.cssText = 'padding:0.75rem; color:#6b7280; font-size:0.875rem;';
        emptyDiv.textContent = 'No matching products found.';
        searchDropdown.appendChild(emptyDiv);
        searchDropdown.style.display = 'block';
        return;
      }

      products.forEach(function(prod) {
        var item = document.createElement('div');
        item.className = 'portal-search-item';
        item.style.cursor = 'pointer';

        var infoDiv = document.createElement('div');
        var titleDiv = document.createElement('div');
        titleDiv.className = 'portal-search-item-title';
        titleDiv.textContent = prod.title || 'Untitled Product';
        infoDiv.appendChild(titleDiv);

        if (prod.price) {
          var metaDiv = document.createElement('div');
          metaDiv.className = 'portal-search-item-meta';
          var minor = typeof prod.price === 'string' ? Math.round(parseFloat(prod.price) * 100) : prod.price;
          metaDiv.textContent = formatMoney(minor);
          infoDiv.appendChild(metaDiv);
        }

        item.appendChild(infoDiv);

        var selectBtn = document.createElement('button');
        selectBtn.type = 'button';
        selectBtn.className = 'portal-btn portal-btn-secondary';
        selectBtn.style.cssText = 'font-size:0.75rem; padding:0.25rem 0.5rem;';
        selectBtn.textContent = 'Select';
        item.appendChild(selectBtn);

        item.addEventListener('click', function() {
          selectProduct(prod);
        });

        searchDropdown.appendChild(item);
      });

      searchDropdown.style.display = 'block';
    })
    .catch(function(err) {
      if (searchBtn) {
        searchBtn.disabled = false;
        searchBtn.textContent = 'Search';
      }
      clearElement(searchDropdown);
      var errDiv = document.createElement('div');
      errDiv.style.cssText = 'padding:0.75rem; color:#dc2626; font-size:0.875rem;';
      errDiv.textContent = 'Search failed. Please try again.';
      searchDropdown.appendChild(errDiv);
      searchDropdown.style.display = 'block';
      console.error('[Protocol Portal] Search error:', err);
    });
  }

  function selectProduct(prod) {
    clearElement(searchDropdown);
    var loadingDiv = document.createElement('div');
    loadingDiv.style.cssText = 'padding:0.75rem; color:#6b7280; font-size:0.875rem;';
    loadingDiv.textContent = 'Loading variants...';
    searchDropdown.appendChild(loadingDiv);

    var handle = prod.handle;
    if (!handle) {
      if (prod.variants && prod.variants.length > 0) {
        displayVariants(prod, prod.variants, '');
        return;
      }
      showError('Product handle not found.');
      searchDropdown.style.display = 'none';
      return;
    }

    fetch('/products/' + encodeURIComponent(handle) + '.js', {
      headers: { 'Accept': 'application/json' }
    })
    .then(function(res) {
      if (!res.ok) throw new Error('Failed to load product details');
      return res.json();
    })
    .then(function(fullProd) {
      displayVariants(fullProd, fullProd.variants || [], handle);
    })
    .catch(function() {
      // Fallback: if product had variants attached
      if (prod.variants && prod.variants.length > 0) {
        displayVariants(prod, prod.variants, handle);
      } else {
        clearElement(searchDropdown);
        var errDiv = document.createElement('div');
        errDiv.style.cssText = 'padding:0.75rem; color:#dc2626; font-size:0.875rem;';
        errDiv.textContent = 'Could not load variants for this product.';
        searchDropdown.appendChild(errDiv);
      }
    });
  }

  function displayVariants(fullProd, variants, handle) {
    clearElement(searchDropdown);

    var header = document.createElement('div');
    header.style.cssText = 'padding:0.5rem 0.875rem; font-weight:600; font-size:0.8125rem; color:#374151; background:#f9fafb; border-bottom:1px solid #e5e7eb; display:flex; justify-content:space-between; align-items:center;';
    var headerTitle = document.createElement('span');
    headerTitle.textContent = fullProd.title || 'Select Variant';
    header.appendChild(headerTitle);

    var backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.style.cssText = 'background:none; border:none; color:#047857; cursor:pointer; font-size:0.75rem; padding:0;';
    backBtn.textContent = '← Back';
    backBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      performSearch((searchInput.value || '').trim());
    });
    header.appendChild(backBtn);
    searchDropdown.appendChild(header);

    if (!variants || variants.length === 0) {
      var noVarDiv = document.createElement('div');
      noVarDiv.style.cssText = 'padding:0.75rem; color:#6b7280; font-size:0.875rem;';
      noVarDiv.textContent = 'No variants found for this product.';
      searchDropdown.appendChild(noVarDiv);
      return;
    }

    variants.forEach(function(v) {
      var item = document.createElement('div');
      item.className = 'portal-search-item';

      var info = document.createElement('div');
      var vTitle = document.createElement('div');
      vTitle.className = 'portal-search-item-title';
      var titleText = v.title && v.title !== 'Default Title' ? v.title : (fullProd.title || 'Default');
      vTitle.textContent = titleText;
      info.appendChild(vTitle);

      var meta = document.createElement('div');
      meta.className = 'portal-search-item-meta';
      var priceCents = typeof v.price === 'number' ? v.price : Math.round(parseFloat(v.price || '0') * 100);
      var priceFormatted = formatMoney(priceCents);
      meta.textContent = priceFormatted + (v.available === false ? ' (Out of stock)' : '');
      info.appendChild(meta);

      item.appendChild(info);

      var addBtn = document.createElement('button');
      addBtn.type = 'button';
      var isAvail = v.available !== false;
      addBtn.className = 'portal-btn ' + (isAvail ? 'portal-btn-secondary' : 'portal-btn-disabled');
      addBtn.style.cssText = 'font-size:0.75rem; padding:0.25rem 0.5rem;';
      addBtn.textContent = isAvail ? '+ Add' : 'Unavailable';
      if (!isAvail) {
        addBtn.disabled = true;
        addBtn.setAttribute('aria-disabled', 'true');
      } else {
        addBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          var gid = typeof v.id === 'string' && v.id.startsWith('gid://')
            ? v.id
            : ('gid://shopify/ProductVariant/' + v.id);
          var lineTitle = (fullProd.title || 'Product') + (v.title && v.title !== 'Default Title' ? ' - ' + v.title : '');
          addVariant({
            id: gid,
            productHandle: handle || fullProd.handle || null,
            title: lineTitle,
            price: priceCents / 100
          });
        });
      }

      item.appendChild(addBtn);
      searchDropdown.appendChild(item);
    });
  }

  // Debounced input search (min 2 chars, 300ms)
  if (searchInput) {
    searchInput.addEventListener('input', function() {
      clearTimeout(searchDebounceTimer);
      var q = (searchInput.value || '').trim();
      if (q.length < 2) {
        searchDropdown.style.display = 'none';
        clearElement(searchDropdown);
        return;
      }
      searchDebounceTimer = setTimeout(function() {
        performSearch(q);
      }, 300);
    });

    searchInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(searchDebounceTimer);
        performSearch((searchInput.value || '').trim());
      }
    });
  }

  if (searchBtn) {
    searchBtn.addEventListener('click', function() {
      clearTimeout(searchDebounceTimer);
      performSearch((searchInput.value || '').trim());
    });
  }

  function addVariant(v) {
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
      productHandle: v.productHandle || null,
      title: v.title,
      price: v.price || 0,
      quantity: 1,
      usageNote: ''
    });

    searchDropdown.style.display = 'none';
    clearElement(searchDropdown);
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
            productHandle: l.productHandle || null,
            quantity: l.quantity || 1,
            usageNote: (l.usageNote || '').trim()
          };
        })
      };

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';

      var endpoint = '/apps/protocols';
      var method = 'POST';
      var url = currentEditingProtocolId
        ? (endpoint + '?action=update&id=' + encodeURIComponent(currentEditingProtocolId))
        : (endpoint + '?action=create');

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

  // Delete contact handler
  document.addEventListener('click', function(e) {
    var btn = e.target && e.target.closest('.portal-delete-contact-btn');
    if (!btn) return;
    var contactId = btn.getAttribute('data-contact-id');
    if (!contactId) return;

    if (btn.getAttribute('data-confirming') !== 'true') {
      btn.setAttribute('data-confirming', 'true');
      btn.textContent = 'Confirm?';
      btn.style.background = '#dc2626';
      btn.style.color = '#ffffff';
      setTimeout(function() {
        if (btn && btn.getAttribute('data-confirming') === 'true') {
          btn.removeAttribute('data-confirming');
          btn.textContent = 'Delete';
          btn.style.background = '';
          btn.style.color = '#dc2626';
        }
      }, 4000);
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Deleting...';

    fetch('/apps/protocols?action=delete_contact', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ contactId: contactId })
    })
    .then(function(res) {
      if (!res.ok) throw new Error('Failed to delete contact');
      return res.json();
    })
    .then(function() {
      var row = document.querySelector('tr[data-contact-row="' + contactId + '"]');
      if (row) row.remove();
    })
    .catch(function(err) {
      btn.disabled = false;
      btn.removeAttribute('data-confirming');
      btn.textContent = 'Delete';
      btn.style.background = '';
      btn.style.color = '#dc2626';
      console.error('[Portal] Unable to delete contact:', err);
    });
  });
})();
</script>`;
}

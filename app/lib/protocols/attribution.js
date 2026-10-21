/**
 * Normalizes a variant GID to its numeric ID string if possible.
 * e.g. "gid://shopify/ProductVariant/12345" -> "12345"
 *
 * @param {string | number} idOrGid
 * @returns {string}
 */
export function normalizeVariantId(idOrGid) {
  if (idOrGid === null || idOrGid === undefined) {
    return '';
  }
  const str = String(idOrGid).trim();
  const match = str.match(/^gid:\/\/shopify\/ProductVariant\/(\d+)$/);
  return match ? match[1] : str;
}

/**
 * Normalizes an ID to Shopify ProductVariant GID format.
 *
 * @param {string | number} idOrGid
 * @returns {string}
 */
export function toVariantGid(idOrGid) {
  if (!idOrGid) return '';
  const str = String(idOrGid).trim();
  if (str.startsWith('gid://shopify/ProductVariant/')) {
    return str;
  }
  const numericOnly = str.replace(/\D/g, '');
  return numericOnly ? `gid://shopify/ProductVariant/${numericOnly}` : str;
}

/**
 * Normalizes an ID to Shopify LineItem GID format.
 *
 * @param {string | number} idOrGid
 * @returns {string}
 */
export function toLineItemGid(idOrGid) {
  if (!idOrGid) return '';
  const str = String(idOrGid).trim();
  if (str.startsWith('gid://shopify/LineItem/')) {
    return str;
  }
  const numericOnly = str.replace(/\D/g, '');
  return numericOnly ? `gid://shopify/LineItem/${numericOnly}` : str;
}

/**
 * Constructs the POST /cart/add.js payload for 1-tap "Add all to cart"
 *
 * @param {{
 *   protocol: {
 *     id?: string | number,
 *     shareToken?: string,
 *     token?: string,
 *     lines?: Array<{ variantGid: string, quantity: number, usageNote?: string }>
 *   },
 *   availableVariantIds?: Array<string | number> | Set<string | number> | null
 * }} params
 * @returns {{
 *   items: Array<{
 *     id: string,
 *     quantity: number,
 *     properties: {
 *       _protocol_token: string,
 *       _protocol_id: string,
 *       _protocol_usage?: string
 *     }
 *   }>,
 *   skippedLines: Array<{ variantGid: string, reason: string }>
 * }}
 */
export function buildCartAddPayload({ protocol, availableVariantIds = null } = {}) {
  if (!protocol || !Array.isArray(protocol.lines)) {
    return { items: [], skippedLines: [] };
  }

  const protocolToken = String(protocol.shareToken || protocol.token || protocol.id || '');
  const protocolId = String(protocol.id || '');

  // Build lookup set of available variant IDs if provided
  let availabilitySet = null;
  if (availableVariantIds !== null && availableVariantIds !== undefined) {
    availabilitySet = new Set();
    const list = Array.isArray(availableVariantIds)
      ? availableVariantIds
      : availableVariantIds instanceof Set
        ? Array.from(availableVariantIds)
        : [];

    for (const item of list) {
      if (item !== null && item !== undefined) {
        const raw = String(item).trim();
        const norm = normalizeVariantId(raw);
        availabilitySet.add(raw);
        if (norm) {
          availabilitySet.add(norm);
          availabilitySet.add(`gid://shopify/ProductVariant/${norm}`);
        }
      }
    }
  }

  const items = [];
  const skippedLines = [];

  for (const line of protocol.lines) {
    if (!line || !line.variantGid) {
      continue;
    }

    const rawGid = String(line.variantGid).trim();
    const normId = normalizeVariantId(rawGid);

    // If availability filter is active, check whether variant is present
    if (availabilitySet !== null) {
      const isAvailable = availabilitySet.has(rawGid) || (normId && availabilitySet.has(normId));
      if (!isAvailable) {
        skippedLines.push({
          variantGid: rawGid,
          reason: 'OUT_OF_STOCK'
        });
        continue;
      }
    }

    const quantity = (typeof line.quantity === 'number' && Number.isInteger(line.quantity) && line.quantity >= 1)
      ? line.quantity
      : 1;

    const properties = {
      _protocol_token: protocolToken,
      _protocol_id: protocolId
    };

    if (line.usageNote && typeof line.usageNote === 'string' && line.usageNote.trim()) {
      properties._protocol_usage = line.usageNote.trim();
    }

    items.push({
      id: normId || rawGid,
      quantity,
      properties
    });
  }

  return { items, skippedLines };
}

/**
 * Extracts line item properties from either Array or Key-Value Object format.
 *
 * @param {any} properties
 * @returns {Record<string, string>}
 */
function normalizeProperties(properties) {
  const result = {};
  if (!properties) return result;

  if (Array.isArray(properties)) {
    for (const prop of properties) {
      if (prop && typeof prop === 'object') {
        const key = prop.name || prop.key;
        if (key && typeof key === 'string') {
          result[key] = String(prop.value ?? '');
        }
      }
    }
  } else if (typeof properties === 'object') {
    for (const [key, val] of Object.entries(properties)) {
      result[key] = String(val ?? '');
    }
  }

  return result;
}

/**
 * Parses an orders/paid webhook line items to extract protocol attribution.
 *
 * @param {any} order
 * @returns {Array<{
 *   protocolToken: string,
 *   protocolId: string,
 *   lineItemGid: string,
 *   variantGid: string,
 *   quantity: number,
 *   priceMinor: number
 * }>}
 */
export function extractAttributionFromOrder(order) {
  if (!order || typeof order !== 'object') {
    return [];
  }

  // Handle both REST webhook (line_items) and GraphQL (lineItems.nodes / lineItems)
  let rawLineItems = [];
  if (Array.isArray(order.line_items)) {
    rawLineItems = order.line_items;
  } else if (order.lineItems) {
    if (Array.isArray(order.lineItems.nodes)) {
      rawLineItems = order.lineItems.nodes;
    } else if (Array.isArray(order.lineItems.edges)) {
      rawLineItems = order.lineItems.edges.map(e => e.node).filter(Boolean);
    } else if (Array.isArray(order.lineItems)) {
      rawLineItems = order.lineItems;
    }
  }

  const attributions = [];

  for (const item of rawLineItems) {
    if (!item || typeof item !== 'object') continue;

    const props = normalizeProperties(item.properties || item.customAttributes);

    // Look for _protocol_token / _protocol_id or protocol_token / protocol_id
    const protocolToken = props._protocol_token || props.protocol_token || '';
    const protocolId = props._protocol_id || props.protocol_id || '';

    // If both token and id are missing, this line has no protocol attribution
    if (!protocolToken && !protocolId) {
      continue;
    }

    const lineItemId = item.admin_graphql_api_id || item.id || '';
    const lineItemGid = toLineItemGid(lineItemId);

    const variantId = item.variant_id || (item.variant && item.variant.id) || '';
    const variantGid = toVariantGid(variantId);

    const quantity = (typeof item.quantity === 'number' && item.quantity >= 1)
      ? item.quantity
      : 1;

    // Calculate priceMinor: price in cents/minor units
    // Handles item.price ("24.50"), item.priceMinor (2450), or GraphQL discountedTotalSet
    let unitPriceMinor = 0;
    if (typeof item.priceMinor === 'number') {
      unitPriceMinor = item.priceMinor;
    } else if (item.price !== undefined && item.price !== null) {
      const parsedFloat = parseFloat(String(item.price).replace(/[^0-9.-]/g, ''));
      unitPriceMinor = isNaN(parsedFloat) ? 0 : Math.round(parsedFloat * 100);
    } else if (item.discountedTotalSet?.shopMoney?.amount) {
      const parsedFloat = parseFloat(item.discountedTotalSet.shopMoney.amount);
      unitPriceMinor = isNaN(parsedFloat) ? 0 : Math.round((parsedFloat * 100) / quantity);
    }

    const priceMinor = unitPriceMinor * quantity;

    attributions.push({
      protocolToken,
      protocolId,
      lineItemGid,
      variantGid,
      quantity,
      priceMinor
    });
  }

  return attributions;
}

/**
 * Increments aggregate monthly stats (pure calculation)
 *
 * @param {{
 *   ordersCount?: number,
 *   unitsCount?: number,
 *   revenueMinor?: number
 * } | null | undefined} currentStat
 * @param {Array<{
 *   quantity?: number,
 *   priceMinor?: number
 * }>} newAttributions
 * @returns {{
 *   ordersIncrement: number,
 *   unitsIncrement: number,
 *   revenueMinorIncrement: number,
 *   nextOrdersCount: number,
 *   nextUnitsCount: number,
 *   nextRevenueMinor: number
 * }}
 */
export function aggregateMonthlyStats(currentStat, newAttributions = []) {
  const currentOrders = Number(currentStat?.ordersCount) || 0;
  const currentUnits = Number(currentStat?.unitsCount) || 0;
  const currentRevenueMinor = Number(currentStat?.revenueMinor) || 0;

  if (!Array.isArray(newAttributions) || newAttributions.length === 0) {
    return {
      ordersIncrement: 0,
      unitsIncrement: 0,
      revenueMinorIncrement: 0,
      nextOrdersCount: currentOrders,
      nextUnitsCount: currentUnits,
      nextRevenueMinor: currentRevenueMinor
    };
  }

  // 1 order increment if newAttributions contains attributed lines
  const ordersIncrement = 1;

  let unitsIncrement = 0;
  let revenueMinorIncrement = 0;

  for (const attr of newAttributions) {
    if (attr && typeof attr === 'object') {
      const qty = typeof attr.quantity === 'number' && !isNaN(attr.quantity) ? attr.quantity : 0;
      const rev = typeof attr.priceMinor === 'number' && !isNaN(attr.priceMinor) ? attr.priceMinor : 0;
      unitsIncrement += qty;
      revenueMinorIncrement += rev;
    }
  }

  return {
    ordersIncrement,
    unitsIncrement,
    revenueMinorIncrement,
    nextOrdersCount: currentOrders + ordersIncrement,
    nextUnitsCount: currentUnits + unitsIncrement,
    nextRevenueMinor: currentRevenueMinor + revenueMinorIncrement
  };
}

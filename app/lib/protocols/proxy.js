import crypto from 'node:crypto';

/**
 * Normalizes query parameters into a standard key-value map.
 * Supports plain objects, URLSearchParams, and query strings.
 * Multi-value keys (arrays or duplicate search params) are grouped into arrays.
 *
 * @param {Record<string, unknown> | URLSearchParams | string} queryParams
 * @returns {Record<string, string | string[]> | null}
 */
export function normalizeQueryParams(queryParams) {
  if (!queryParams) return null;

  const result = {};

  if (queryParams instanceof URLSearchParams) {
    for (const [key, value] of queryParams.entries()) {
      if (key in result) {
        if (Array.isArray(result[key])) {
          result[key].push(value);
        } else {
          result[key] = [result[key], value];
        }
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  if (typeof queryParams === 'string') {
    const raw = queryParams.startsWith('?') ? queryParams.slice(1) : queryParams;
    const searchParams = new URLSearchParams(raw);
    return normalizeQueryParams(searchParams);
  }

  if (typeof queryParams === 'object') {
    for (const [key, val] of Object.entries(queryParams)) {
      result[key] = val;
    }
    return result;
  }

  return null;
}

/**
 * Calculates Shopify App Proxy SHA-256 HMAC signature.
 * 
 * Sorts all query parameters alphabetically by key (excluding 'signature'),
 * joins array values with commas, concatenates key=value pairs with empty string,
 * and hashes the result with the app's apiSecret using HMAC-SHA256.
 *
 * @param {Record<string, unknown> | URLSearchParams | string} queryParams
 * @param {string} apiSecret
 * @returns {string} Hexadecimal HMAC signature
 */
export function calculateAppProxySignature(queryParams, apiSecret) {
  if (!queryParams || !apiSecret || typeof apiSecret !== 'string') {
    return '';
  }

  const params = normalizeQueryParams(queryParams);
  if (!params) return '';

  const sortedKeys = Object.keys(params)
    .filter((k) => k !== 'signature')
    .sort();

  const message = sortedKeys
    .map((key) => {
      const val = params[key];
      const strVal = Array.isArray(val)
        ? val.join(',')
        : (val !== null && val !== undefined ? String(val) : '');
      return `${key}=${strVal}`;
    })
    .join('');

  return crypto.createHmac('sha256', apiSecret).update(message).digest('hex');
}

/**
 * Verifies Shopify's HMAC signature query parameter on App Proxy requests.
 * Uses SHA-256 HMAC of sorted query params (excluding signature) and constant-time comparison.
 *
 * @param {Record<string, unknown> | URLSearchParams | string} queryParams
 * @param {string} apiSecret App shared secret
 * @returns {boolean} True if signature is valid and authentic
 */
export function verifyAppProxyHmac(queryParams, apiSecret) {
  if (!queryParams || !apiSecret || typeof apiSecret !== 'string') {
    return false;
  }

  const params = normalizeQueryParams(queryParams);
  if (!params) return false;

  const rawSignature = params.signature;
  if (!rawSignature || typeof rawSignature !== 'string') {
    return false;
  }

  const expectedSignature = calculateAppProxySignature(params, apiSecret);
  if (!expectedSignature) return false;

  const expectedBuf = Buffer.from(expectedSignature, 'utf8');
  const actualBuf = Buffer.from(rawSignature.toLowerCase().trim(), 'utf8');

  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}

/**
 * Extracts logged_in_customer_id from App Proxy query params and formats as Shopify Customer GID.
 *
 * @param {Record<string, unknown> | URLSearchParams | string} queryParams
 * @returns {string | null} Formatted gid://shopify/Customer/${id} or null if not logged in
 */
export function getLoggedInCustomerGid(queryParams) {
  if (!queryParams) return null;

  let rawId = null;
  if (queryParams instanceof URLSearchParams) {
    rawId = queryParams.get('logged_in_customer_id');
  } else if (typeof queryParams === 'string') {
    const raw = queryParams.startsWith('?') ? queryParams.slice(1) : queryParams;
    const searchParams = new URLSearchParams(raw);
    rawId = searchParams.get('logged_in_customer_id');
  } else if (typeof queryParams === 'object') {
    rawId = queryParams.logged_in_customer_id;
  }

  if (rawId === null || rawId === undefined) {
    return null;
  }

  const str = String(rawId).trim();
  if (!str) {
    return null;
  }

  if (str.startsWith('gid://shopify/Customer/')) {
    return str;
  }

  const numericOnly = str.replace(/\D/g, '');
  if (!numericOnly) {
    return null;
  }

  return `gid://shopify/Customer/${numericOnly}`;
}

/**
 * Neutralizes Liquid syntax to prevent template injection attacks.
 * Replaces Liquid delimiters with HTML entities.
 *
 * @param {unknown} str
 * @returns {string}
 */
export function neutralizeLiquid(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;')
    .replace(/%/g, '&#37;');
}

/**
 * Escapes characters for safe HTML and Liquid output.
 * Neutralizes HTML tags/entities and Liquid interpolation/tag delimiters ({, }, %).
 *
 * @param {unknown} str
 * @returns {string}
 */
export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;')
    .replace(/%/g, '&#37;');
}

/**
 * Normalizes a variant GID to its numeric ID string.
 *
 * @param {string | number} idOrGid
 * @returns {string}
 */
export function normalizeVariantId(idOrGid) {
  if (idOrGid === null || idOrGid === undefined) return '';
  const str = String(idOrGid).trim();
  const match = str.match(/^gid:\/\/shopify\/ProductVariant\/(\d+)$/);
  return match ? match[1] : str;
}

/**
 * Renders full Liquid markup (application/liquid) compatible with theme.liquid.
 * Handles all 4 states: Active, Archived, Disabled, Not Found.
 * Always includes `<meta name="robots" content="noindex, nofollow">`.
 * Includes 1-tap "Add all to cart" and per-line add buttons using Cart AJAX POST /cart/add.js
 * with hidden properties _protocol_token and _protocol_id.
 * Shows banner if isLoggedInPractitioner is true:
 * "You're signed in as a professional. Clients will see retail prices."
 *
 * @param {{
 *   protocol?: {
 *     id?: string | number,
 *     token?: string,
 *     shareToken?: string,
 *     name?: string,
 *     introNote?: string,
 *     displayName?: string,
 *     status?: 'active' | 'archived' | 'disabled' | string,
 *     lines?: Array<{
 *       id?: string,
 *       variantGid?: string,
 *       variantId?: string | number,
 *       quantity?: number,
 *       usageNote?: string,
 *       title?: string,
 *       productTitle?: string,
 *       variantTitle?: string,
 *       price?: string,
 *       priceFormatted?: string,
 *       available?: boolean,
 *       inStock?: boolean
 *     }>
 *   } | null,
 *   practiceName?: string,
 *   isLoggedInPractitioner?: boolean
 * }} options
 * @returns {string} Liquid markup string
 */
export function renderProtocolLiquid({ protocol, practiceName = '', isLoggedInPractitioner = false } = {}) {
  // Determine protocol state: 'active' | 'archived' | 'disabled' | 'not_found'
  let state = 'not_found';
  if (protocol && typeof protocol === 'object' && protocol.name) {
    const rawStatus = (protocol.status || 'active').toLowerCase().trim();
    if (rawStatus === 'active') {
      state = 'active';
    } else if (rawStatus === 'archived') {
      state = 'archived';
    } else if (rawStatus === 'disabled') {
      state = 'disabled';
    } else {
      state = 'not_found';
    }
  }

  // Common robots meta tag required on all states
  const robotsMeta = '<meta name="robots" content="noindex, nofollow">';

  // Practitioner banner when signed in as professional
  const practitionerBanner = isLoggedInPractitioner
    ? `
  <div class="protocol-practitioner-banner" role="status">
    <div class="protocol-banner-content">
      <svg class="protocol-banner-icon" viewBox="0 0 20 20" fill="currentColor" width="18" height="18" aria-hidden="true">
        <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"/>
      </svg>
      <span>You're signed in as a professional. Clients will see retail prices.</span>
    </div>
  </div>`
    : '';

  // Embedded scoped styles
  const styles = `
<style>
  .protocol-container {
    max-width: 820px;
    margin: 2rem auto;
    padding: 0 1.25rem;
    font-family: inherit;
    color: #1f2937;
    line-height: 1.5;
  }
  .protocol-practitioner-banner {
    background-color: #ecfdf5;
    border: 1px solid #a7f3d0;
    color: #065f46;
    padding: 0.875rem 1.25rem;
    border-radius: 8px;
    margin-bottom: 2rem;
    font-size: 0.9375rem;
  }
  .protocol-banner-content {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .protocol-banner-icon {
    flex-shrink: 0;
  }
  .protocol-header {
    border-bottom: 1px solid #e5e7eb;
    padding-bottom: 1.75rem;
    margin-bottom: 2rem;
  }
  .protocol-practice-name {
    font-size: 0.875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #4b5563;
    margin-bottom: 0.5rem;
  }
  .protocol-title {
    font-size: 2rem;
    font-weight: 700;
    color: #111827;
    margin: 0 0 0.75rem 0;
    line-height: 1.25;
  }
  .protocol-intro-note {
    font-size: 1.0625rem;
    color: #4b5563;
    margin: 0;
    white-space: pre-line;
  }
  .protocol-top-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .protocol-item-count {
    font-size: 0.9375rem;
    color: #6b7280;
    font-weight: 500;
  }
  .protocol-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.625rem 1.25rem;
    font-size: 0.9375rem;
    font-weight: 600;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s ease-in-out;
    border: 1px solid transparent;
    text-decoration: none;
    box-sizing: border-box;
  }
  .protocol-btn-primary {
    background-color: #111827;
    color: #ffffff;
  }
  .protocol-btn-primary:hover:not(:disabled) {
    background-color: #374151;
  }
  .protocol-btn-secondary {
    background-color: #ffffff;
    color: #1f2937;
    border-color: #d1d5db;
  }
  .protocol-btn-secondary:hover:not(:disabled) {
    background-color: #f9fafb;
    border-color: #9ca3af;
  }
  .protocol-btn:disabled, .protocol-btn-disabled {
    opacity: 0.5;
    cursor: not-allowed;
    background-color: #e5e7eb;
    color: #9ca3af;
    border-color: #e5e7eb;
  }
  .protocol-lines-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .protocol-line-card {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1.25rem;
    background: #ffffff;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    gap: 1.25rem;
  }
  .protocol-line-card.protocol-line-unavailable {
    background-color: #fafafa;
    border-color: #e5e7eb;
  }
  .protocol-line-details {
    flex: 1;
  }
  .protocol-line-title {
    font-size: 1.125rem;
    font-weight: 600;
    color: #111827;
    margin: 0 0 0.375rem 0;
  }
  .protocol-line-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    font-size: 0.875rem;
    color: #4b5563;
    margin-bottom: 0.375rem;
  }
  .protocol-line-qty {
    font-weight: 600;
  }
  .protocol-line-price {
    font-weight: 500;
  }
  .protocol-line-usage {
    margin: 0.5rem 0 0 0;
    font-size: 0.875rem;
    color: #374151;
    background-color: #f3f4f6;
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    display: inline-block;
  }
  .protocol-line-actions {
    flex-shrink: 0;
  }
  .protocol-badge {
    display: inline-block;
    padding: 0.2rem 0.5rem;
    font-size: 0.75rem;
    font-weight: 600;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .protocol-badge-unavailable {
    background-color: #fee2e2;
    color: #991b1b;
  }
  .protocol-status-card {
    text-align: center;
    padding: 4rem 1.5rem;
    background: #ffffff;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    margin: 3rem auto;
    max-width: 540px;
  }
  .protocol-status-icon {
    margin-bottom: 1.25rem;
    color: #6b7280;
  }
  .protocol-status-title {
    font-size: 1.5rem;
    font-weight: 700;
    color: #111827;
    margin: 0 0 0.75rem 0;
  }
  .protocol-status-message {
    font-size: 1rem;
    color: #6b7280;
    margin: 0;
    line-height: 1.6;
  }
  @media (max-width: 640px) {
    .protocol-line-card {
      flex-direction: column;
      align-items: flex-start;
    }
    .protocol-line-actions {
      width: 100%;
      margin-top: 0.75rem;
    }
    .protocol-line-actions .protocol-btn {
      width: 100%;
    }
    .protocol-top-bar {
      flex-direction: column;
      align-items: stretch;
    }
    .protocol-top-bar .protocol-btn {
      width: 100%;
    }
  }
</style>`;

  // Handle Archived State
  if (state === 'archived') {
    return `${robotsMeta}${styles}
<div class="protocol-container">
  ${practitionerBanner}
  <div class="protocol-status-card protocol-archived">
    <div class="protocol-status-icon">
      <svg width="48" height="48" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"/>
      </svg>
    </div>
    <h1 class="protocol-status-title">Protocol No Longer Active</h1>
    <p class="protocol-status-message">This recommendation is no longer active. If you have questions about your routine, please reach out directly to your practitioner.</p>
  </div>
</div>`;
  }

  // Handle Disabled State
  if (state === 'disabled') {
    return `${robotsMeta}${styles}
<div class="protocol-container">
  ${practitionerBanner}
  <div class="protocol-status-card protocol-disabled">
    <div class="protocol-status-icon">
      <svg width="48" height="48" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"/>
      </svg>
    </div>
    <h1 class="protocol-status-title">Protocol No Longer Active</h1>
    <p class="protocol-status-message">This protocol is no longer active or is temporarily unavailable. If you have questions, please reach out directly to your practitioner.</p>
  </div>
</div>`;
  }

  // Handle Not Found State
  if (state === 'not_found') {
    return `${robotsMeta}${styles}
<div class="protocol-container">
  ${practitionerBanner}
  <div class="protocol-status-card protocol-not-found">
    <div class="protocol-status-icon">
      <svg width="48" height="48" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
      </svg>
    </div>
    <h1 class="protocol-status-title">Protocol Not Found</h1>
    <p class="protocol-status-message">The requested protocol could not be found. Please verify your link or contact your practitioner.</p>
  </div>
</div>`;
  }

  // Active State: Render full protocol client page
  const displayPractice = escapeHtml(practiceName || protocol.displayName || '');
  const displayTitle = escapeHtml(protocol.name || 'Product Protocol');
  const displayIntro = escapeHtml(protocol.introNote || '');
  const rawToken = protocol.token || protocol.shareToken || '';
  const rawId = String(protocol.id || '');
  const protocolToken = escapeHtml(rawToken);
  const protocolId = escapeHtml(rawId);

  const lines = Array.isArray(protocol.lines) ? protocol.lines : [];

  // Build client items JSON for Cart AJAX operations
  const clientItems = [];
  const linesMarkup = lines.map((line) => {
    const rawVariant = line.variantGid || line.variantId || line.id || '';
    const normVariantId = normalizeVariantId(rawVariant);
    const quantity = (typeof line.quantity === 'number' && Number.isInteger(line.quantity) && line.quantity >= 1)
      ? line.quantity
      : 1;
    const usageNote = line.usageNote ? String(line.usageNote).trim() : '';
    const title = line.title || line.productTitle || line.name || 'Recommended Product';
    const variantTitle = line.variantTitle || '';
    const price = line.price || line.priceFormatted || '';
    const isAvailable = line.available !== false && line.inStock !== false;

    clientItems.push({
      id: normVariantId,
      quantity,
      available: isAvailable,
      usageNote
    });

    const safeTitle = escapeHtml(title);
    const safeVariant = escapeHtml(variantTitle);
    const safePrice = escapeHtml(price);
    const safeUsage = escapeHtml(usageNote);

    return `
    <div class="protocol-line-card ${isAvailable ? '' : 'protocol-line-unavailable'}" data-variant-id="${escapeHtml(normVariantId)}">
      <div class="protocol-line-details">
        <h3 class="protocol-line-title">${safeTitle}</h3>
        <div class="protocol-line-meta">
          ${safeVariant ? `<span class="protocol-line-variant">${safeVariant}</span>` : ''}
          ${safePrice ? `<span class="protocol-line-price">${safePrice}</span>` : ''}
          <span class="protocol-line-qty">Qty: ${quantity}</span>
          ${!isAvailable ? `<span class="protocol-badge protocol-badge-unavailable">Out of stock</span>` : ''}
        </div>
        ${safeUsage ? `<div class="protocol-line-usage"><strong>Instructions:</strong> ${safeUsage}</div>` : ''}
      </div>
      <div class="protocol-line-actions">
        ${isAvailable ? `
        <button type="button" class="protocol-btn protocol-btn-secondary protocol-line-add-btn"
          data-variant-id="${escapeHtml(normVariantId)}"
          data-quantity="${quantity}"
          data-usage="${safeUsage}"
          aria-label="Add ${safeTitle} to cart">
          Add
        </button>` : `
        <button type="button" class="protocol-btn protocol-btn-disabled" disabled aria-disabled="true">
          Unavailable
        </button>`}
      </div>
    </div>`;
  }).join('\n');

  const totalLines = lines.length;
  const inStockCount = clientItems.filter((i) => i.available).length;

  const protocolDataJson = JSON.stringify({
    protocolId: rawId,
    protocolToken: rawToken,
    items: clientItems
  })
    .replace(/</g, '\\u003c')
    .replace(/\{\{/g, '\\u007b\\u007b')
    .replace(/\}\}/g, '\\u007d\\u007d')
    .replace(/\{%/g, '\\u007b\\u0025')
    .replace(/%\}/g, '\\u0025\\u007d')
    .replace(/%/g, '\\u0025');

  return `${robotsMeta}${styles}
<div class="protocol-container">
  ${practitionerBanner}
  <header class="protocol-header">
    ${displayPractice ? `<div class="protocol-practice-name">${displayPractice}</div>` : ''}
    <h1 class="protocol-title">${displayTitle}</h1>
    ${displayIntro ? `<p class="protocol-intro-note">${displayIntro}</p>` : ''}
  </header>

  <div class="protocol-top-bar">
    <div class="protocol-item-count">
      ${totalLines} ${totalLines === 1 ? 'item' : 'items'} recommended
    </div>
    <button type="button" class="protocol-btn protocol-btn-primary protocol-add-all-btn" id="protocol-add-all-btn"
      ${inStockCount === 0 ? 'disabled aria-disabled="true"' : ''}>
      Add all to cart
    </button>
  </div>

  <div class="protocol-lines-list" role="list">
    ${linesMarkup}
  </div>
</div>

<script type="application/json" id="protocol-data-payload">
${protocolDataJson}
</script>

<script>
(function() {
  var payloadEl = document.getElementById('protocol-data-payload');
  if (!payloadEl) return;
  var payload = JSON.parse(payloadEl.textContent);
  var token = payload.protocolToken || '';
  var protoId = payload.protocolId || '';

  function addToCart(items, btn, successText) {
    if (!items || !items.length) return;
    var originalText = btn ? btn.textContent : '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Adding...';
    }

    var requestBody = {
      items: items.map(function(item) {
        var props = {
          _protocol_token: token,
          _protocol_id: protoId
        };
        if (item.usageNote) {
          props._protocol_usage = item.usageNote;
        }
        return {
          id: item.id,
          quantity: item.quantity,
          properties: props
        };
      })
    };

    fetch('/cart/add.js', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(requestBody)
    })
    .then(function(res) {
      if (!res.ok) {
        throw new Error('Failed to add to cart: ' + res.statusText);
      }
      return res.json();
    })
    .then(function(cartData) {
      if (btn) {
        btn.textContent = successText || 'Added!';
        setTimeout(function() {
          btn.disabled = false;
          btn.textContent = originalText;
        }, 1500);
      }
      document.dispatchEvent(new CustomEvent('cart:updated', { detail: cartData }));
      window.location.href = '/cart';
    })
    .catch(function(err) {
      console.error('[Protocol] Error adding to cart:', err);
      if (btn) {
        btn.disabled = false;
        btn.textContent = originalText;
      }
      alert('Unable to add products to cart. Please try again.');
    });
  }

  var addAllBtn = document.getElementById('protocol-add-all-btn');
  if (addAllBtn) {
    addAllBtn.addEventListener('click', function() {
      var available = payload.items.filter(function(i) { return i.available !== false && i.id; });
      if (available.length === 0) {
        alert('All products in this protocol are currently out of stock.');
        return;
      }
      addToCart(available, addAllBtn, 'All items added!');
    });
  }

  var lineButtons = document.querySelectorAll('.protocol-line-add-btn');
  lineButtons.forEach(function(btn) {
    btn.addEventListener('click', function() {
      var variantId = btn.getAttribute('data-variant-id');
      var quantity = parseInt(btn.getAttribute('data-quantity') || '1', 10);
      var usageNote = btn.getAttribute('data-usage') || '';
      addToCart([{ id: variantId, quantity: quantity, usageNote: usageNote }], btn, 'Added!');
    });
  });
})();
</script>`;
}

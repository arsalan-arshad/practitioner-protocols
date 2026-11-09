import { generateQrSvg } from './qr.js';
import { escapeHtml, normalizeVariantId } from './proxy.js';

export { generateQrSvg, escapeHtml, normalizeVariantId };

/**
 * Builds self-contained, print-ready HTML/CSS for US Letter and A4 handouts.
 *
 * @param {{
 *   protocol: {
 *     name: string,
 *     introNote?: string,
 *     displayName?: string,
 *     lines?: Array<{
 *       title?: string,
 *       productTitle?: string,
 *       variantTitle?: string,
 *       quantity: number,
 *       usageNote?: string,
 *       variantGid?: string
 *     }>
 *   },
 *   practiceName?: string,
 *   shareUrl: string,
 *   qrSvg?: string,
 *   handoutText?: string,
 *   footerDisclaimer?: string
 * }} params
 * @returns {string} Complete HTML document string
 */
export function renderHandoutHtml({ protocol, practiceName = '', shareUrl = '', qrSvg = '', handoutText = '', footerDisclaimer = '' }) {
  if (!protocol || typeof protocol !== 'object') {
    throw new TypeError('Protocol object is required');
  }

  const safePractice = escapeHtml(practiceName || protocol.displayName || 'Practitioner Recommendation');
  const safeTitle = escapeHtml(protocol.name || 'Product Protocol');
  const safeIntro = escapeHtml(protocol.introNote || '');
  const safeUrl = escapeHtml(shareUrl);
  const safeHandoutText = escapeHtml(handoutText ? String(handoutText).trim() : '');
  const safeDisclaimer = escapeHtml(footerDisclaimer ? String(footerDisclaimer).trim() : '');
  const activeQrSvg = qrSvg || (shareUrl ? generateQrSvg(shareUrl, { size: 160 }) : '');

  const lines = Array.isArray(protocol.lines) ? protocol.lines : [];

  const linesMarkup = lines.map((line, idx) => {
    const rawVariant = line.variantGid || line.variantId || line.id || '';
    const normVariantId = normalizeVariantId(rawVariant);
    const productHandle = line.productHandle ? String(line.productHandle).trim() : '';

    const isEnriched = Boolean(line.title || line.productTitle || line.name);
    const hasHandle = Boolean(productHandle);
    const isMissingProduct = !isEnriched && !hasHandle;
    const isAvailable = !isMissingProduct && line.available !== false && line.inStock !== false && line.isDeleted !== true;

    let itemTitle = 'Unavailable product';
    if (line.title) {
      itemTitle = line.title;
    } else if (line.productTitle) {
      const vTitle = line.variantTitle && line.variantTitle !== 'Default Title' ? ` - ${line.variantTitle}` : '';
      itemTitle = `${line.productTitle}${vTitle}`;
    } else if (line.name) {
      itemTitle = line.name;
    } else if (line.variantTitle && line.variantTitle !== 'Default Title') {
      itemTitle = `Product (${line.variantTitle})`;
    } else if (hasHandle) {
      itemTitle = 'Loading product...';
    } else {
      itemTitle = 'Unavailable product';
    }

    const qty = Number.isInteger(line.quantity) && line.quantity >= 1 ? line.quantity : 1;
    const usage = line.usageNote ? escapeHtml(line.usageNote) : '';

    const statusBadge = isMissingProduct
      ? `<div class="item-status"><span class="handout-badge-unavailable">Unavailable product</span></div>`
      : (!isAvailable ? `<div class="item-status"><span class="handout-badge-unavailable">Out of stock</span></div>` : '');

    return `
      <tr class="line-row ${isAvailable ? '' : 'line-row-unavailable'}"
        data-variant-id="${escapeHtml(normVariantId)}"
        data-variant-gid="${escapeHtml(line.variantGid || '')}"
        data-product-handle="${escapeHtml(productHandle)}">
        <td class="col-num">${idx + 1}</td>
        <td class="col-item">
          <div class="item-title">${escapeHtml(itemTitle)}</div>
          ${statusBadge}
          ${usage ? `<div class="item-usage">${usage}</div>` : ''}
        </td>
        <td class="col-qty">${qty}</td>
      </tr>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${safeTitle} — ${safePractice}</title>
  <style>
    @page {
      size: auto;
      margin: 15mm;
    }
    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #111827;
      background-color: #ffffff;
      line-height: 1.5;
      padding: 24px;
      max-width: 800px;
      margin: 0 auto;
    }
    .handout-header {
      border-bottom: 2px solid #e5e7eb;
      padding-bottom: 20px;
      margin-bottom: 24px;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 20px;
    }
    .header-main {
      flex: 1;
    }
    .practice-label {
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #4b5563;
      font-weight: 700;
      margin-bottom: 4px;
    }
    .protocol-title {
      font-size: 26px;
      font-weight: 800;
      line-height: 1.2;
      color: #111827;
    }
    .protocol-intro {
      margin-top: 10px;
      font-size: 14px;
      color: #374151;
      white-space: pre-line;
      background: #f9fafb;
      padding: 12px 16px;
      border-radius: 6px;
      border-left: 3px solid #008060;
    }
    .qr-card {
      text-align: center;
      padding: 12px;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      background: #ffffff;
      width: 170px;
      flex-shrink: 0;
    }
    .qr-card svg {
      display: block;
      margin: 0 auto;
      max-width: 140px;
      height: auto;
    }
    .qr-card p {
      font-size: 11px;
      color: #6b7280;
      margin-top: 6px;
      font-weight: 500;
    }
    .section-title {
      font-size: 16px;
      font-weight: 700;
      color: #111827;
      margin-bottom: 12px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    table.protocol-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 24px;
    }
    table.protocol-table th {
      text-align: left;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #6b7280;
      border-bottom: 1px solid #d1d5db;
      padding: 8px 12px;
      font-weight: 600;
    }
    table.protocol-table td {
      padding: 12px;
      border-bottom: 1px solid #f3f4f6;
      vertical-align: top;
    }
    .col-num {
      width: 32px;
      color: #9ca3af;
      font-size: 13px;
      font-weight: 600;
    }
    .col-item {
      padding-right: 20px;
    }
    .col-qty {
      width: 60px;
      text-align: center;
      font-size: 15px;
      font-weight: 700;
      color: #111827;
    }
    .item-title {
      font-size: 15px;
      font-weight: 600;
      color: #111827;
    }
    .item-usage {
      font-size: 13px;
      color: #4b5563;
      margin-top: 3px;
      font-style: italic;
    }
    .line-row-unavailable {
      opacity: 0.65;
    }
    .line-row-unavailable .item-title {
      text-decoration: line-through;
      color: #6b7280;
    }
    .handout-badge-unavailable {
      display: inline-block;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 2px 6px;
      border-radius: 4px;
      background: #fee2e2;
      color: #991b1b;
      margin-top: 3px;
    }
    .item-status {
      margin-top: 2px;
    }
    .instructions-box {
      border: 1px dashed #d1d5db;
      background-color: #fafafa;
      border-radius: 8px;
      padding: 16px 20px;
      margin-bottom: 24px;
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .instructions-box .step-number {
      background: #008060;
      color: #ffffff;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 14px;
      flex-shrink: 0;
    }
    .instructions-box p {
      font-size: 13px;
      color: #374151;
      line-height: 1.4;
    }
    .handout-footer {
      border-top: 1px solid #e5e7eb;
      padding-top: 16px;
      font-size: 12px;
      color: #9ca3af;
      text-align: center;
    }
    .url-display {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      color: #2563eb;
      word-break: break-all;
      margin-top: 4px;
    }
    .no-print-bar {
      margin-bottom: 20px;
      display: flex;
      justify-content: flex-end;
    }
    .print-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 16px;
      background: #008060;
      color: #ffffff;
      border: none;
      border-radius: 4px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }
    .print-btn:hover {
      background: #006e52;
    }
    .handout-instructions-box {
      margin-bottom: 20px;
      font-size: 13px;
      color: #374151;
      background: #f9fafb;
      padding: 12px 16px;
      border-radius: 6px;
      border-left: 3px solid #008060;
      line-height: 1.5;
    }
    .handout-disclaimer {
      margin-top: 10px;
      font-size: 11px;
      color: #9ca3af;
      line-height: 1.4;
    }
    @media print {
      body {
        padding: 0;
        max-width: 100%;
      }
      .no-print-bar, .no-print {
        display: none !important;
      }
      .instructions-box, .protocol-intro, .handout-instructions-box {
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
    }
  </style>
</head>
<body>
  <div class="no-print-bar">
    <button type="button" class="print-btn no-print" onclick="window.print()">Print Handout</button>
  </div>

  <div class="handout-header">
    <div class="header-main">
      <div class="practice-label">${safePractice}</div>
      <h1 class="protocol-title">${safeTitle}</h1>
      ${safeIntro ? `<div class="protocol-intro">${safeIntro}</div>` : ''}
    </div>
    ${activeQrSvg ? `
    <div class="qr-card">
      ${activeQrSvg}
      <p>Scan with phone camera</p>
    </div>` : ''}
  </div>

  ${safeHandoutText ? `<div class="handout-instructions-box">${safeHandoutText}</div>` : ''}

  <div class="instructions-box">
    <div class="step-number">1</div>
    <p>Scan the QR code or visit the link below to review your practitioner's recommended routine. You can add all items to your cart in one tap.</p>
  </div>

  <div class="section-title">Recommended Routine</div>
  <table class="protocol-table">
    <thead>
      <tr>
        <th class="col-num">#</th>
        <th class="col-item">Product &amp; Usage</th>
        <th class="col-qty">Qty</th>
      </tr>
    </thead>
    <tbody>
      ${linesMarkup}
    </tbody>
  </table>

  <div class="handout-footer">
    <div>Direct Storefront Access:</div>
    ${safeUrl ? `<div class="url-display">${safeUrl}</div>` : ''}
    <div style="margin-top: 8px;">Order directly from the official store at standard retail pricing.</div>
    ${safeDisclaimer ? `<div class="handout-disclaimer">${safeDisclaimer}</div>` : ''}
  </div>

  <script>
  (function() {
    function findRowsByHandle(targetHandle) {
      var rowsList = document.querySelectorAll('.line-row');
      var matches = [];
      for (var i = 0; i < rowsList.length; i++) {
        if (rowsList[i].getAttribute('data-product-handle') === targetHandle) {
          matches.push(rowsList[i]);
        }
      }
      return matches;
    }

    var rows = document.querySelectorAll('.line-row[data-product-handle]');
    var handlesToFetch = {};
    rows.forEach(function(row) {
      var h = row.getAttribute('data-product-handle');
      if (h && h.trim()) {
        handlesToFetch[h.trim()] = true;
      }
    });

    var uniqueHandles = Object.keys(handlesToFetch);
    var hydrationPromise = Promise.resolve();

    if (uniqueHandles.length > 0) {
      hydrationPromise = Promise.all(uniqueHandles.map(function(handle) {
        return fetch('/products/' + encodeURIComponent(handle) + '.js', {
          headers: { 'Accept': 'application/json' }
        })
        .then(function(res) {
          if (!res.ok) throw new Error('Product not found: ' + handle);
          return res.json();
        })
        .then(function(product) {
          var matchingRows = findRowsByHandle(handle);
          matchingRows.forEach(function(row) {
            var varId = row.getAttribute('data-variant-id');
            var varGid = row.getAttribute('data-variant-gid');
            var variant = null;
            if (product && Array.isArray(product.variants)) {
              variant = product.variants.find(function(v) {
                return String(v.id) === String(varId) || ('gid://shopify/ProductVariant/' + v.id) === varGid;
              });
            }

            var titleEl = row.querySelector('.item-title');
            var itemCol = row.querySelector('.col-item');

            function setBadge(text) {
              var badgeEl = row.querySelector('.handout-badge-unavailable');
              if (!badgeEl && itemCol) {
                var statusDiv = document.createElement('div');
                statusDiv.className = 'item-status';
                badgeEl = document.createElement('span');
                badgeEl.className = 'handout-badge-unavailable';
                statusDiv.appendChild(badgeEl);
                var usageEl = row.querySelector('.item-usage');
                if (usageEl) {
                  itemCol.insertBefore(statusDiv, usageEl);
                } else {
                  itemCol.appendChild(statusDiv);
                }
              }
              if (badgeEl) badgeEl.textContent = text;
            }

            function removeBadge() {
              var statusEl = row.querySelector('.item-status');
              if (statusEl && statusEl.parentNode) {
                statusEl.parentNode.removeChild(statusEl);
              }
            }

            if (!variant) {
              row.classList.add('line-row-unavailable');
              if (titleEl) titleEl.textContent = 'Unavailable product';
              setBadge('Unavailable product');
              return;
            }

            var vTitle = variant.title && variant.title !== 'Default Title' ? variant.title : '';
            var fullTitle = (product.title || 'Product') + (vTitle ? ' - ' + vTitle : '');
            if (titleEl) titleEl.textContent = fullTitle;

            var isAvail = variant.available === true;
            if (isAvail) {
              row.classList.remove('line-row-unavailable');
              removeBadge();
            } else {
              row.classList.add('line-row-unavailable');
              setBadge('Out of stock');
            }
          });
        })
        .catch(function() {
          var matchingRows = findRowsByHandle(handle);
          matchingRows.forEach(function(row) {
            row.classList.add('line-row-unavailable');
            var titleEl = row.querySelector('.item-title');
            if (titleEl) titleEl.textContent = 'Unavailable product';
            var itemCol = row.querySelector('.col-item');
            var badgeEl = row.querySelector('.handout-badge-unavailable');
            if (!badgeEl && itemCol) {
              var statusDiv = document.createElement('div');
              statusDiv.className = 'item-status';
              badgeEl = document.createElement('span');
              badgeEl.className = 'handout-badge-unavailable';
              statusDiv.appendChild(badgeEl);
              var usageEl = row.querySelector('.item-usage');
              if (usageEl) {
                itemCol.insertBefore(statusDiv, usageEl);
              } else {
                itemCol.appendChild(statusDiv);
              }
            }
            if (badgeEl) badgeEl.textContent = 'Unavailable product';
          });
        });
      }));
    }

    var printBtn = document.querySelector('.print-btn');
    if (printBtn) {
      printBtn.addEventListener('click', function(e) {
        e.preventDefault();
        hydrationPromise.then(function() {
          window.print();
        });
      });
    }
  })();
  </script>
</body>
</html>`;
}

import { generateQrSvg } from './qr.js';

export { generateQrSvg };

/**
 * Escapes characters for safe HTML insertion.
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
    .replace(/'/g, '&#039;');
}

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
 *   qrSvg?: string
 * }} params
 * @returns {string} Complete HTML document string
 */
export function renderHandoutHtml({ protocol, practiceName = '', shareUrl = '', qrSvg = '' }) {
  if (!protocol || typeof protocol !== 'object') {
    throw new TypeError('Protocol object is required');
  }

  const safePractice = escapeHtml(practiceName || protocol.displayName || 'Practitioner Recommendation');
  const safeTitle = escapeHtml(protocol.name || 'Product Protocol');
  const safeIntro = escapeHtml(protocol.introNote || '');
  const safeUrl = escapeHtml(shareUrl);
  const activeQrSvg = qrSvg || (shareUrl ? generateQrSvg(shareUrl, { size: 160 }) : '');

  const lines = Array.isArray(protocol.lines) ? protocol.lines : [];

  const linesMarkup = lines.map((line, idx) => {
    const itemTitle = escapeHtml(
      line.title ||
      line.productTitle ||
      (line.variantTitle ? `Product (${line.variantTitle})` : `Item ${idx + 1}`)
    );
    const qty = Number.isInteger(line.quantity) && line.quantity >= 1 ? line.quantity : 1;
    const usage = line.usageNote ? escapeHtml(line.usageNote) : '';

    return `
      <tr class="line-row">
        <td class="col-num">${idx + 1}</td>
        <td class="col-item">
          <div class="item-title">${itemTitle}</div>
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
    @media print {
      body {
        padding: 0;
        max-width: 100%;
      }
      .instructions-box, .protocol-intro {
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
    }
  </style>
</head>
<body>
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
  </div>
</body>
</html>`;
}

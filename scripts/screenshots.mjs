#!/usr/bin/env node
/**
 * scripts/screenshots.mjs
 *
 * Renders static fixtures (portal, editor, client page, handout, admin list)
 * to assets/screenshots/*.png using Playwright (1600x900 viewport, deviceScaleFactor 1).
 *
 * Strictly zero client PII, zero real shop data, fixtures only.
 * No new dependencies added to package.json (run via npx or external playwright environment).
 */

import { mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAdminHtml } from '../app/lib/protocols/admin.js';
import { renderPortalLiquid } from '../app/lib/protocols/portal.js';
import { renderProtocolLiquid } from '../app/lib/protocols/proxy.js';
import { renderHandoutHtml } from '../app/lib/protocols/handout.js';
import { generateQrSvg } from '../app/lib/protocols/qr.js';
import {
  DEMO_SHOP,
  DEMO_PROFILES,
  DEMO_STARTERS,
  DEMO_REPORT,
  DEMO_SETTINGS,
  DEMO_PROTOCOL,
} from '../server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const screenshotsDir = join(__dirname, '..', 'assets', 'screenshots');

/**
 * Fixture HTML definitions
 */
export function getFixtures() {
  const shareUrl = `https://${DEMO_SHOP}/apps/protocols/${DEMO_PROTOCOL.token}`;
  const qrSvg = generateQrSvg(shareUrl, { size: 180 });

  // 1. Admin List (Merchant Admin Dashboard)
  const adminHtml = renderAdminHtml({
    shop: DEMO_SHOP,
    apiKey: 'demo-api-key',
    profiles: DEMO_PROFILES,
    starters: DEMO_STARTERS,
    report: DEMO_REPORT,
    settings: DEMO_SETTINGS,
    activeTab: 'practitioners',
  });

  // 2. Practitioner Portal (Overview)
  const portalHtml = renderPortalLiquid({
    shop: DEMO_SHOP,
    isLoggedIn: true,
    isApproved: true,
    practiceName: 'Apex Integrative Wellness',
    activeProtocols: [
      {
        id: DEMO_PROTOCOL.id,
        token: DEMO_PROTOCOL.token,
        name: DEMO_PROTOCOL.name,
        introNote: DEMO_PROTOCOL.introNote,
        lines: DEMO_PROTOCOL.lines,
        linesCount: DEMO_PROTOCOL.lines.length,
        retailTotal: '$110.50',
      },
    ],
    starterProtocols: DEMO_STARTERS,
  });

  // 3. Practitioner Editor (Create/Edit View)
  // Modify portal HTML to activate editor view on load
  const editorHtml = portalHtml
    .replace('id="portal-create-view" style="display:none;"', 'id="portal-create-view" style="display:block;"')
    .replace('id="portal-list-view"', 'id="portal-list-view" style="display:none;"');

  // 4. Client Protocol Landing Page
  const clientPageHtml = renderProtocolLiquid({
    protocol: DEMO_PROTOCOL,
    practiceName: 'Apex Integrative Wellness',
    isLoggedInPractitioner: false,
  });

  // 5. Printable Handout View (US Letter / A4 with Vector QR)
  const handoutHtml = renderHandoutHtml({
    protocol: DEMO_PROTOCOL,
    practiceName: 'Apex Integrative Wellness',
    shareUrl,
    qrSvg,
  });

  return [
    { name: 'admin-dashboard.png', html: adminHtml },
    { name: 'portal-overview.png', html: portalHtml },
    { name: 'protocol-editor.png', html: editorHtml },
    { name: 'client-protocol-page.png', html: clientPageHtml },
    { name: 'printable-handout.png', html: handoutHtml },
  ];
}

/**
 * Main execution function
 */
export async function renderAllScreenshots() {
  await mkdir(screenshotsDir, { recursive: true });

  let playwright;
  try {
    playwright = await import('playwright');
  } catch (err) {
    try {
      playwright = await import('playwright-core');
    } catch {
      console.warn('[screenshots] Playwright is not installed in the workspace dependencies (per zero new repo dependencies rule).');
      console.warn('[screenshots] Run with temporary external tooling: npx playwright or external runner.');
      return;
    }
  }

  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 900 },
      deviceScaleFactor: 1,
    });

    const fixtures = getFixtures();
    for (const fixture of fixtures) {
      const page = await context.newPage();
      await page.setContent(fixture.html, { waitUntil: 'load' });
      const destPath = join(screenshotsDir, fixture.name);
      await page.screenshot({ path: destPath, fullPage: false });
      console.log(`[screenshots] Generated: ${fixture.name}`);
      await page.close();
    }
    await context.close();
  } finally {
    await browser.close();
  }
}

// Auto-run if executed directly via node CLI
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  renderAllScreenshots()
    .then(() => console.log('[screenshots] Screenshot generation complete.'))
    .catch((err) => {
      console.error('[screenshots] Error generating screenshots:', err);
      process.exit(1);
    });
}

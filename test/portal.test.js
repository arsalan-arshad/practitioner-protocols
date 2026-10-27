import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatMoney,
  calculateProtocolRetailTotal,
  formatProtocolCard,
  formatProtocolLibrary,
  reorderProtocolLines,
  addProtocolLine,
  updateProtocolLine,
  removeProtocolLine,
  prepareProtocolEditorPayload,
  detectConcurrentEdit,
  generateProtocolShareKit,
  renderPortalLiquid,
  ProtocolValidationError
} from '../app/lib/protocols/portal.js';

describe('Practitioner Portal (app/lib/protocols/portal.js)', () => {
  describe('formatMoney & Retail Calculations', () => {
    it('formats minor integer cents into standard USD currency', () => {
      assert.equal(formatMoney(2999), '$29.99');
      assert.equal(formatMoney(0), '$0.00');
      assert.equal(formatMoney(150), '$1.50');
      assert.equal(formatMoney(10000), '$100.00');
    });

    it('formats other ISO currencies properly', () => {
      const cad = formatMoney(4500, 'CAD');
      assert.ok(cad.includes('45.00'));
      const eur = formatMoney(2500, 'EUR');
      assert.ok(eur.includes('25.00'));
    });

    it('calculates retail total from line prices directly', () => {
      const lines = [
        { variantGid: 'gid://shopify/ProductVariant/1', quantity: 2, priceMinor: 2500 }, // $50.00
        { variantGid: 'gid://shopify/ProductVariant/2', quantity: 1, price: '19.99' }    // $19.99
      ];
      const result = calculateProtocolRetailTotal(lines);

      assert.equal(result.totalMinor, 6999);
      assert.equal(result.formattedTotal, '$69.99');
      assert.equal(result.itemsPriced, 2);
      assert.equal(result.totalItems, 2);
      assert.equal(result.isComplete, true);
    });

    it('calculates retail total using variantCatalogMap', () => {
      const lines = [
        { variantGid: 'gid://shopify/ProductVariant/101', quantity: 3 },
        { variantGid: 'gid://shopify/ProductVariant/102', quantity: 1 }
      ];
      const catalog = {
        'gid://shopify/ProductVariant/101': { priceMinor: 1500 }, // 3 * $15.00 = $45.00
        'gid://shopify/ProductVariant/102': { price: '34.50' }    // 1 * $34.50 = $34.50
      };
      const result = calculateProtocolRetailTotal(lines, catalog);

      assert.equal(result.totalMinor, 7950);
      assert.equal(result.formattedTotal, '$79.50');
      assert.equal(result.isComplete, true);
    });

    it('handles missing or unpriced items cleanly', () => {
      const lines = [
        { variantGid: 'gid://shopify/ProductVariant/101', quantity: 1 },
        { variantGid: 'gid://shopify/ProductVariant/999', quantity: 1 } // Not in catalog
      ];
      const catalog = {
        'gid://shopify/ProductVariant/101': { priceMinor: 2000 }
      };
      const result = calculateProtocolRetailTotal(lines, catalog);

      assert.equal(result.totalMinor, 2000);
      assert.equal(result.itemsPriced, 1);
      assert.equal(result.totalItems, 2);
      assert.equal(result.isComplete, false);
    });

    it('handles empty line arrays safely', () => {
      const result = calculateProtocolRetailTotal([]);
      assert.equal(result.totalMinor, 0);
      assert.equal(result.formattedTotal, '$0.00');
      assert.equal(result.isComplete, true);
    });

    it('handles null, undefined, and non-finite values in formatMoney', () => {
      assert.equal(formatMoney(null), '$0.00');
      assert.equal(formatMoney(undefined), '$0.00');
      assert.equal(formatMoney(NaN), '$0.00');
    });

    it('normalizes string prices with symbols and object price representations', () => {
      const lines = [
        { variantGid: 'gid://shopify/ProductVariant/1', quantity: 1, price: '$49.95' },
        { variantGid: 'gid://shopify/ProductVariant/2', quantity: 2, price: { amount: '12.50' } }
      ];
      const result = calculateProtocolRetailTotal(lines);
      assert.equal(result.totalMinor, 4995 + 2500);
      assert.equal(result.formattedTotal, '$74.95');
    });
  });

  describe('Protocol Card & Library Formatting (SPEC §1, §3, §5)', () => {
    const mockProtocol = {
      id: 'proto-123',
      token: 'tok_GutHealth12345',
      name: 'Gut Health Regimen',
      displayName: 'Integrative Wellness',
      introNote: 'Take with food for 30 days',
      status: 'active',
      isStarter: false,
      ownerType: 'customer',
      ownerId: 'gid://shopify/Customer/456',
      createdBy: 'cust-456',
      updatedBy: 'cust-456',
      createdAt: '2026-10-01T10:00:00Z',
      updatedAt: '2026-10-15T12:00:00Z',
      lines: [
        {
          id: 'l-1',
          position: 0,
          variantGid: 'gid://shopify/ProductVariant/1',
          quantity: 2,
          usageNote: 'Morning with food'
        },
        {
          id: 'l-2',
          position: 1,
          variantGid: 'gid://shopify/ProductVariant/2',
          quantity: 1,
          usageNote: 'Evening'
        }
      ]
    };

    it('formats a single protocol card with unit count and retail calculation', () => {
      const catalog = {
        'gid://shopify/ProductVariant/1': { title: 'Probiotic Complex', availableForSale: true, priceMinor: 3000 },
        'gid://shopify/ProductVariant/2': { title: 'L-Glutamine', availableForSale: true, priceMinor: 2500 }
      };

      const card = formatProtocolCard(mockProtocol, { variantCatalogMap: catalog });

      assert.equal(card.id, 'proto-123');
      assert.equal(card.token, 'tok_GutHealth12345');
      assert.equal(card.name, 'Gut Health Regimen');
      assert.equal(card.lineCount, 2);
      assert.equal(card.totalUnits, 3); // 2 + 1
      assert.equal(card.retailTotal.totalMinor, 8500); // 2*30 + 1*25 = $85.00
      assert.equal(card.hasUnavailableItems, false);
      assert.equal(card.unavailableNotice, null);
      assert.equal(card.lines[0].title, 'Probiotic Complex');
      assert.equal(card.canEdit, true);
      assert.equal(card.canDuplicate, true);
      assert.equal(card.canArchive, true);
    });

    it('flags unavailable and deleted items with SPEC §5 notice', () => {
      const catalog = {
        'gid://shopify/ProductVariant/1': { title: 'Probiotic Complex', availableForSale: true, priceMinor: 3000 },
        'gid://shopify/ProductVariant/2': { title: 'L-Glutamine', availableForSale: false, priceMinor: 2500 } // Out of stock
      };

      const card = formatProtocolCard(mockProtocol, { variantCatalogMap: catalog });

      assert.equal(card.unavailableCount, 1);
      assert.equal(card.hasUnavailableItems, true);
      assert.equal(card.unavailableNotice, '1 product no longer available');
      assert.equal(card.lines[1].isUnavailable, true);
      assert.equal(card.lines[1].isOutOfStock, true);
    });

    it('formats multiple unavailable items with plural count', () => {
      const catalog = {
        'gid://shopify/ProductVariant/1': { title: 'Probiotic Complex', isDeleted: true },
        'gid://shopify/ProductVariant/2': { title: 'L-Glutamine', availableForSale: false }
      };

      const card = formatProtocolCard(mockProtocol, { variantCatalogMap: catalog });

      assert.equal(card.unavailableCount, 2);
      assert.equal(card.hasUnavailableItems, true);
      assert.equal(card.unavailableNotice, '2 products no longer available');
    });

    it('handles starter protocols as read-only templates', () => {
      const starterProto = {
        ...mockProtocol,
        id: 'starter-999',
        name: 'Brand Foundation Protocol',
        isStarter: true
      };

      const card = formatProtocolCard(starterProto);
      assert.equal(card.isStarter, true);
      assert.equal(card.isReadOnly, true);
      assert.equal(card.canEdit, false);
      assert.equal(card.canArchive, false);
      assert.equal(card.canDuplicate, true);
    });

    it('formats protocol library with search filtering and sorting', () => {
      const protocols = [
        mockProtocol,
        {
          id: 'proto-sleep',
          token: 'tok_SleepWell77777',
          name: 'Sleep & Relaxation Routine',
          displayName: 'Integrative Wellness',
          introNote: 'Take magnesium 30 mins before bed',
          status: 'active',
          isStarter: false,
          updatedAt: '2026-10-20T10:00:00Z',
          lines: [
            { variantGid: 'gid://shopify/ProductVariant/3', quantity: 1, usageNote: 'Nightly' }
          ]
        },
        {
          id: 'starter-1',
          token: 'tok_BrandStarter001',
          name: 'Daily Essentials Starter',
          status: 'active',
          isStarter: true,
          updatedAt: '2026-09-01T08:00:00Z',
          lines: []
        },
        {
          id: 'proto-archived',
          token: 'tok_OldArchived000',
          name: 'Archived Detox Routine',
          status: 'archived',
          isStarter: false,
          updatedAt: '2026-08-01T08:00:00Z',
          lines: []
        }
      ];

      // 1. Default active library
      const activeLib = formatProtocolLibrary({ protocols, filter: { status: 'active', type: 'all' } });
      assert.equal(activeLib.protocols.length, 3);
      assert.equal(activeLib.starters.length, 1);
      assert.equal(activeLib.userProtocols.length, 2);
      assert.equal(activeLib.summary.totalProtocols, 3);
      assert.equal(activeLib.summary.activeCount, 3);

      // Sorted by updatedAt desc: proto-sleep (Oct 20) should be first
      assert.equal(activeLib.protocols[0].id, 'proto-sleep');

      // 2. Search query for "Magnesium" or "sleep"
      const searched = formatProtocolLibrary({
        protocols,
        filter: { status: 'all', type: 'all' },
        search: 'magnesium'
      });
      assert.equal(searched.protocols.length, 1);
      assert.equal(searched.protocols[0].id, 'proto-sleep');

      // 3. Filter by starters
      const startersOnly = formatProtocolLibrary({
        protocols,
        filter: { status: 'all', type: 'starters' }
      });
      assert.equal(startersOnly.protocols.length, 1);
      assert.equal(startersOnly.protocols[0].id, 'starter-1');

      // 4. Sort by name asc
      const sortedByName = formatProtocolLibrary({
        protocols,
        filter: { status: 'all', type: 'all' },
        sortBy: 'name_asc'
      });
      assert.equal(sortedByName.protocols[0].name, 'Archived Detox Routine');

      // 5. Filter by mine (non-starters)
      const mineOnly = formatProtocolLibrary({
        protocols,
        filter: { status: 'all', type: 'mine' }
      });
      assert.equal(mineOnly.protocols.length, 3);
      assert.ok(mineOnly.protocols.every(p => !p.isStarter));

      // 6. Sort by name desc & updatedAt asc
      const sortedNameDesc = formatProtocolLibrary({
        protocols,
        filter: { status: 'all', type: 'all' },
        sortBy: 'name_desc'
      });
      assert.equal(sortedNameDesc.protocols[0].name, 'Sleep & Relaxation Routine');

      const sortedUpdatedAsc = formatProtocolLibrary({
        protocols,
        filter: { status: 'all', type: 'all' },
        sortBy: 'updatedAt_asc'
      });
      assert.equal(sortedUpdatedAsc.protocols[0].id, 'proto-archived');
    });

    it('handles empty protocol library gracefully', () => {
      const result = formatProtocolLibrary({ protocols: [] });
      assert.equal(result.protocols.length, 0);
      assert.equal(result.starters.length, 0);
      assert.equal(result.userProtocols.length, 0);
      assert.equal(result.summary.totalProtocols, 0);
      assert.equal(result.summary.activeCount, 0);
    });
  });

  describe('Protocol Editor Line Management & Reordering (M3)', () => {
    const initialLines = [
      { variantGid: 'gid://shopify/ProductVariant/1', quantity: 1, usageNote: 'First', position: 0 },
      { variantGid: 'gid://shopify/ProductVariant/2', quantity: 2, usageNote: 'Second', position: 1 },
      { variantGid: 'gid://shopify/ProductVariant/3', quantity: 1, usageNote: 'Third', position: 2 }
    ];

    it('reorders lines via { fromIndex, toIndex }', () => {
      // Move item from index 2 to index 0
      const reordered = reorderProtocolLines(initialLines, { fromIndex: 2, toIndex: 0 });

      assert.equal(reordered.length, 3);
      assert.equal(reordered[0].variantGid, 'gid://shopify/ProductVariant/3');
      assert.equal(reordered[0].position, 0);

      assert.equal(reordered[1].variantGid, 'gid://shopify/ProductVariant/1');
      assert.equal(reordered[1].position, 1);

      assert.equal(reordered[2].variantGid, 'gid://shopify/ProductVariant/2');
      assert.equal(reordered[2].position, 2);
    });

    it('reorders lines via explicit variantGid order array', () => {
      const explicitOrder = [
        'gid://shopify/ProductVariant/2',
        'gid://shopify/ProductVariant/3',
        'gid://shopify/ProductVariant/1'
      ];
      const reordered = reorderProtocolLines(initialLines, explicitOrder);

      assert.equal(reordered[0].variantGid, 'gid://shopify/ProductVariant/2');
      assert.equal(reordered[0].position, 0);
      assert.equal(reordered[1].variantGid, 'gid://shopify/ProductVariant/3');
      assert.equal(reordered[1].position, 1);
      assert.equal(reordered[2].variantGid, 'gid://shopify/ProductVariant/1');
      assert.equal(reordered[2].position, 2);
    });

    it('rejects invalid reorder indices', () => {
      assert.throws(
        () => reorderProtocolLines(initialLines, { fromIndex: -1, toIndex: 1 }),
        RangeError
      );
      assert.throws(
        () => reorderProtocolLines(initialLines, { fromIndex: 0, toIndex: 5 }),
        RangeError
      );
    });

    it('adds a new protocol line with validation and sequential position', () => {
      const newLine = {
        variantGid: 'gid://shopify/ProductVariant/4',
        quantity: 3,
        usageNote: 'Take with dinner'
      };
      const updated = addProtocolLine(initialLines, newLine);

      assert.equal(updated.length, 4);
      assert.equal(updated[3].variantGid, 'gid://shopify/ProductVariant/4');
      assert.equal(updated[3].quantity, 3);
      assert.equal(updated[3].usageNote, 'Take with dinner');
      assert.equal(updated[3].position, 3);
    });

    it('prevents adding duplicate variants', () => {
      const duplicateLine = {
        variantGid: 'gid://shopify/ProductVariant/1',
        quantity: 1
      };
      assert.throws(
        () => addProtocolLine(initialLines, duplicateLine),
        (err) => err instanceof ProtocolValidationError && err.code === 'DUPLICATE_VARIANT'
      );
    });

    it('prevents exceeding 20 product lines', () => {
      const twentyLines = Array.from({ length: 20 }, (_, i) => ({
        variantGid: `gid://shopify/ProductVariant/${i + 1}`,
        quantity: 1,
        position: i
      }));

      assert.throws(
        () => addProtocolLine(twentyLines, { variantGid: 'gid://shopify/ProductVariant/21' }),
        (err) => err instanceof ProtocolValidationError && err.code === 'MAX_ITEMS'
      );
    });

    it('updates quantity and usage notes of an existing line', () => {
      const updated = updateProtocolLine(initialLines, 'gid://shopify/ProductVariant/2', {
        quantity: 5,
        usageNote: 'Adjusted dosage: 5 capsules'
      });

      assert.equal(updated[1].quantity, 5);
      assert.equal(updated[1].usageNote, 'Adjusted dosage: 5 capsules');
      assert.equal(updated[0].quantity, 1); // Other lines unchanged
    });

    it('rejects invalid quantities or excessive note length when updating', () => {
      assert.throws(
        () => updateProtocolLine(initialLines, 'gid://shopify/ProductVariant/1', { quantity: 15 }),
        (err) => err.code === 'INVALID_QUANTITY'
      );

      const longNote = 'A'.repeat(201);
      assert.throws(
        () => updateProtocolLine(initialLines, 'gid://shopify/ProductVariant/1', { usageNote: longNote }),
        (err) => err.code === 'INVALID_LENGTH'
      );
    });

    it('removes a line and re-indexes remaining lines sequentially', () => {
      const removed = removeProtocolLine(initialLines, 'gid://shopify/ProductVariant/2');

      assert.equal(removed.length, 2);
      assert.equal(removed[0].variantGid, 'gid://shopify/ProductVariant/1');
      assert.equal(removed[0].position, 0);
      assert.equal(removed[1].variantGid, 'gid://shopify/ProductVariant/3');
      assert.equal(removed[1].position, 1);
    });

    it('supports line operations by numeric index', () => {
      const updated = updateProtocolLine(initialLines, 0, { quantity: 4 });
      assert.equal(updated[0].quantity, 4);

      const removed = removeProtocolLine(initialLines, 0);
      assert.equal(removed.length, 2);
      assert.equal(removed[0].variantGid, 'gid://shopify/ProductVariant/2');
      assert.equal(removed[0].position, 0);
    });

    it('handles boundary cases in reorderProtocolLines and removeProtocolLine', () => {
      // 0 or 1 line
      assert.equal(reorderProtocolLines([], { fromIndex: 0, toIndex: 0 }).length, 0);
      const single = [{ variantGid: 'gid://1', quantity: 1 }];
      assert.equal(reorderProtocolLines(single, { fromIndex: 0, toIndex: 0 })[0].position, 0);

      // Non-existent line removal returns copy
      const unchanged = removeProtocolLine(initialLines, 'gid://non-existent');
      assert.equal(unchanged.length, 3);
    });

    it('defaults quantity to 1 in addProtocolLine', () => {
      const added = addProtocolLine(initialLines, { variantGid: 'gid://shopify/ProductVariant/99' });
      assert.equal(added[3].quantity, 1);
      assert.equal(added[3].usageNote, '');
    });
  });

  describe('Protocol Editor Payload Preparation & Zero PII Barrier', () => {
    it('prepares and normalizes valid editor payload', () => {
      const input = {
        name: 'Immune Defense Protocol',
        introNote: 'Take daily during seasonal changes.',
        displayName: 'Aura Wellness',
        lines: [
          { variantGid: 'gid://shopify/ProductVariant/10', quantity: 2, usageNote: 'Twice daily' },
          { variantGid: 'gid://shopify/ProductVariant/20', quantity: 1, usageNote: 'Once daily' }
        ]
      };

      const result = prepareProtocolEditorPayload(input, { currentUserId: 'practitioner-99' });

      assert.equal(result.isValid, true);
      assert.equal(result.errors.length, 0);
      assert.equal(result.payload.name, 'Immune Defense Protocol');
      assert.equal(result.payload.introNote, 'Take daily during seasonal changes.');
      assert.equal(result.payload.lines.length, 2);
      assert.equal(result.payload.lines[0].position, 0);
      assert.equal(result.payload.lines[1].position, 1);
      assert.equal(result.payload.updatedBy, 'practitioner-99');
    });

    it('strictly enforces zero client PII in the editor payload', () => {
      const maliciousInput = {
        name: 'Recovery Routine',
        patientName: 'Jane Doe',
        clientEmail: 'jane@example.com',
        medicalDiagnosis: 'Adrenal Fatigue',
        lines: [
          { variantGid: 'gid://shopify/ProductVariant/1', quantity: 1 }
        ]
      };

      const result = prepareProtocolEditorPayload(maliciousInput);

      assert.equal(result.isValid, false);
      assert.ok(result.errors.length >= 3);
      assert.ok(result.errors.some(e => e.field === 'patientName' && e.code === 'PII_NOT_ALLOWED'));
      assert.ok(result.errors.some(e => e.field === 'clientEmail' && e.code === 'PII_NOT_ALLOWED'));
      assert.ok(result.errors.some(e => e.field === 'medicalDiagnosis' && e.code === 'PII_NOT_ALLOWED'));
      assert.equal(result.payload, null);
    });

    it('validates protocol name length boundaries', () => {
      const emptyName = { name: '   ', lines: [{ variantGid: 'gid://1', quantity: 1 }] };
      const longName = { name: 'A'.repeat(61), lines: [{ variantGid: 'gid://1', quantity: 1 }] };

      assert.equal(prepareProtocolEditorPayload(emptyName).isValid, false);
      assert.equal(prepareProtocolEditorPayload(longName).isValid, false);
    });
  });

  describe('Concurrent Edit Detection (SPEC §5)', () => {
    const openedAt = '2026-10-21T12:00:00.000Z';

    it('detects no conflict when protocol has not been updated since opening', () => {
      const result = detectConcurrentEdit({
        openedAt,
        protocolUpdatedAt: '2026-10-21T11:59:00.000Z',
        lastUpdatedBy: 'practitioner-1',
        currentUserId: 'practitioner-1'
      });

      assert.equal(result.hasConflict, false);
      assert.equal(result.conflictType, null);
      assert.equal(result.warningMessage, null);
    });

    it('detects concurrent edit by another practitioner in the same company (PEER_PRACTITIONER_EDIT)', () => {
      const result = detectConcurrentEdit({
        openedAt,
        protocolUpdatedAt: '2026-10-21T12:05:00.000Z', // 5 minutes after opening
        lastUpdatedBy: 'practitioner-bob',
        currentUserId: 'practitioner-alice'
      });

      assert.equal(result.hasConflict, true);
      assert.equal(result.conflictType, 'PEER_PRACTITIONER_EDIT');
      assert.ok(result.warningMessage.includes('Another practitioner in your practice updated this protocol'));
      assert.ok(result.warningMessage.includes('last save wins'));
    });

    it('detects concurrent edit by the same practitioner across multiple tabs/windows (SELF_CONCURRENT_EDIT)', () => {
      const result = detectConcurrentEdit({
        openedAt,
        protocolUpdatedAt: '2026-10-21T12:02:00.000Z',
        lastUpdatedBy: 'practitioner-alice',
        currentUserId: 'practitioner-alice'
      });

      assert.equal(result.hasConflict, true);
      assert.equal(result.conflictType, 'SELF_CONCURRENT_EDIT');
      assert.ok(result.warningMessage.includes('another window or session'));
    });

    it('handles missing or invalid timestamps gracefully', () => {
      const result1 = detectConcurrentEdit({});
      assert.equal(result1.hasConflict, false);

      const result2 = detectConcurrentEdit({ openedAt: 'invalid-date', protocolUpdatedAt: 'invalid-date' });
      assert.equal(result2.hasConflict, false);
    });

    it('detects no conflict when timestamps are identical', () => {
      const sameTime = '2026-10-21T12:00:00.000Z';
      const result = detectConcurrentEdit({ openedAt: sameTime, protocolUpdatedAt: sameTime });
      assert.equal(result.hasConflict, false);
    });

    it('handles Date instances and numeric millisecond timestamps', () => {
      const openedDate = new Date('2026-10-21T10:00:00Z');
      const updatedTimestamp = openedDate.getTime() + 60000; // 1 min later

      const result = detectConcurrentEdit({
        openedAt: openedDate,
        protocolUpdatedAt: updatedTimestamp
      });
      assert.equal(result.hasConflict, true);
      assert.equal(result.conflictType, 'CONCURRENT_EDIT');
    });
  });

  describe('Share Kit Generation (SPEC §8)', () => {
    const mockProtocol = {
      token: 'tok_ResetProtocol99',
      name: 'Spring Detox & Reset',
      displayName: 'Alpine Naturopathic',
      introNote: 'Follow for 14 days with plenty of water.',
      lines: [
        {
          title: 'Milk Thistle Standardized Extract',
          quantity: 1,
          usageNote: '1 capsule twice daily'
        },
        {
          title: 'Electrolyte Mineral Complex',
          quantity: 2,
          usageNote: '1 packet in 500ml water'
        }
      ]
    };

    it('generates a complete share kit with URL, vector QR, and printable handout', () => {
      const kit = generateProtocolShareKit({
        protocol: mockProtocol,
        shopDomain: 'brand.myshopify.com',
        practiceName: 'Alpine Naturopathic'
      });

      assert.equal(kit.token, 'tok_ResetProtocol99');
      assert.equal(kit.shareUrl, 'https://brand.myshopify.com/apps/protocols/tok_ResetProtocol99');

      // QR SVG verification
      assert.ok(kit.qrSvg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
      assert.ok(kit.qrSvg.includes('viewBox='));
      assert.ok(kit.qrSvg.includes('width="200"'));

      // QR Data URI verification
      assert.ok(kit.qrDataUri.startsWith('data:image/svg+xml;charset=utf-8,'));

      // Handout HTML verification
      assert.ok(kit.handoutHtml.startsWith('<!DOCTYPE html>'));
      assert.ok(kit.handoutHtml.includes('@media print'));
      assert.ok(kit.handoutHtml.includes('Spring Detox &amp; Reset'));
      assert.ok(kit.handoutHtml.includes('Alpine Naturopathic'));
      assert.ok(kit.handoutHtml.includes('Milk Thistle Standardized Extract'));
      assert.ok(kit.handoutHtml.includes('https://brand.myshopify.com/apps/protocols/tok_ResetProtocol99'));
    });

    it('normalizes shopDomain with https protocol and trailing slashes', () => {
      const kit = generateProtocolShareKit({
        protocol: mockProtocol,
        shopDomain: 'https://store.example.com///',
        pathPrefix: '/custom-protocols/'
      });

      assert.equal(kit.shareUrl, 'https://store.example.com/custom-protocols/tok_ResetProtocol99');
    });

    it('honors custom qrSize and falls back to displayName when practiceName omitted', () => {
      const kit = generateProtocolShareKit({
        protocol: mockProtocol,
        shopDomain: 'store.example.com',
        qrSize: 320
      });

      assert.ok(kit.qrSvg.includes('width="320"'));
      assert.ok(kit.qrSvg.includes('height="320"'));
      assert.equal(kit.practiceName, 'Alpine Naturopathic');
    });

    it('throws when protocol is missing or lacks token', () => {
      assert.throws(
        () => generateProtocolShareKit({ protocol: null, shopDomain: 'example.com' }),
        TypeError
      );
      assert.throws(
        () => generateProtocolShareKit({ protocol: { name: 'No Token' }, shopDomain: 'example.com' }),
        TypeError
      );
    });

    it('throws when shopDomain is missing', () => {
      assert.throws(
        () => generateProtocolShareKit({ protocol: mockProtocol, shopDomain: '' }),
        TypeError
      );
    });
  });

  describe('renderPortalLiquid (M3 Practitioner Portal UI)', () => {
    it('renders unauthenticated sign-in state with /account/login link when isLoggedIn is false', () => {
      const liquid = renderPortalLiquid({ isLoggedIn: false });
      assert.ok(liquid.includes('Practitioner Sign In Required'));
      assert.ok(liquid.includes('/account/login'));
      assert.ok(liquid.includes('<meta name="robots" content="noindex, nofollow">'));
    });

    it('renders pending approval message when signed in but not yet approved', () => {
      const liquid = renderPortalLiquid({
        isLoggedIn: true,
        isApproved: false,
        practiceName: 'Pending Health Center'
      });
      assert.ok(liquid.includes('Account Pending Approval'));
      assert.ok(liquid.includes('Pending Health Center'));
      assert.ok(liquid.includes('reviewed by the store administrator'));
    });

    it('renders full protocol library when signed in and approved', () => {
      const activeProtocols = [
        {
          id: 'p_1',
          token: 'tok_active_12345678',
          name: 'Gut Healing Routine',
          introNote: 'Take with lunch',
          linesCount: 3,
          retailTotal: '$75.00',
          updatedAt: '2026-10-27T00:00:00Z'
        }
      ];

      const liquid = renderPortalLiquid({
        isLoggedIn: true,
        isApproved: true,
        practiceName: 'Elite Naturopathic Clinic',
        activeProtocols
      });

      assert.ok(liquid.includes('Elite Naturopathic Clinic'));
      assert.ok(liquid.includes('Gut Healing Routine'));
      assert.ok(liquid.includes('tok_active_12345678'));
      assert.ok(liquid.includes('$75.00'));
      assert.ok(liquid.includes('Copy Link'));
      assert.ok(liquid.includes('Print Handout'));
      assert.ok(liquid.includes('protocol-editor-modal'));
      assert.ok(liquid.includes('product-search-input'));
      assert.ok(liquid.includes('protocol-selected-lines'));
      assert.ok(liquid.includes('protocol-save-btn'));
      assert.ok(liquid.includes('portal-edit-btn'));
    });

    it('neutralizes Liquid delimiters in protocol names and practice names', () => {
      const liquid = renderPortalLiquid({
        isLoggedIn: true,
        isApproved: true,
        practiceName: 'Clinic {{ shop.name }}',
        activeProtocols: [
          {
            id: 'p_2',
            token: 'tok_escape_12345678',
            name: 'Hack {% assign x = 1 %}',
            linesCount: 1,
            retailTotal: '$10.00'
          }
        ]
      });

      assert.ok(!liquid.includes('{{ shop.name }}'));
      assert.ok(!liquid.includes('{% assign x = 1 %}'));
      assert.ok(liquid.includes('&#123;&#123; shop.name &#125;&#125;'));
      assert.ok(liquid.includes('&#123;% assign x = 1 %&#125;'));
    });
  });
});

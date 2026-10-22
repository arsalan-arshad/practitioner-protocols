import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateProtocolInput } from '../app/lib/protocols/validation.js';

describe('Protocol Validation (app/lib/protocols/validation.js)', () => {
  const validLine = {
    variantGid: 'gid://shopify/ProductVariant/1001',
    quantity: 2,
    usageNote: 'Apply twice daily after cleansing'
  };

  const validProtocol = {
    name: 'Barrier Restoration Daily Protocol',
    introNote: 'Core regimen formulated to repair skin barrier lipids.',
    displayName: 'Dr. Jane Smith, ND',
    status: 'active',
    lines: [validLine]
  };

  it('accepts a fully valid protocol payload', () => {
    const res = validateProtocolInput(validProtocol);
    assert.equal(res.isValid, true);
    assert.equal(res.errors.length, 0);
    assert.equal(res.sanitized.name, 'Barrier Restoration Daily Protocol');
    assert.equal(res.sanitized.status, 'active');
    assert.equal(res.sanitized.lines.length, 1);
    assert.equal(res.sanitized.lines[0].quantity, 2);
  });

  describe('Privacy & PII Barrier', () => {
    const forbiddenFields = [
      'patientName',
      'patientId',
      'clientEmail',
      'clientPhone',
      'ssn',
      'medicalDiagnosis',
      'healthCondition'
    ];

    for (const field of forbiddenFields) {
      it(`strictly rejects payloads containing forbidden PII field '${field}'`, () => {
        const payload = {
          ...validProtocol,
          [field]: 'Sensitive value'
        };
        const res = validateProtocolInput(payload);
        assert.equal(res.isValid, false);
        const piiError = res.errors.find(e => e.code === 'PII_NOT_ALLOWED' && e.field === field);
        assert.ok(piiError, `Expected PII_NOT_ALLOWED error for field ${field}`);
      });
    }

    it('strictly rejects payloads with nested PII fields inside lines[]', () => {
      const payload = {
        ...validProtocol,
        lines: [
          {
            variantGid: 'gid://shopify/ProductVariant/1001',
            quantity: 1,
            patientName: 'Jane Doe',
            clientEmail: 'jane@example.com'
          }
        ]
      };
      const res = validateProtocolInput(payload);
      assert.equal(res.isValid, false);
      const piiError1 = res.errors.find(e => e.code === 'PII_NOT_ALLOWED' && e.field === 'lines[0].patientName');
      assert.ok(piiError1, 'Expected PII_NOT_ALLOWED error for lines[0].patientName');
      const piiError2 = res.errors.find(e => e.code === 'PII_NOT_ALLOWED' && e.field === 'lines[0].clientEmail');
      assert.ok(piiError2, 'Expected PII_NOT_ALLOWED error for lines[0].clientEmail');
    });
  });

  describe('Name Validation', () => {
    it('rejects empty or whitespace-only name', () => {
      const res1 = validateProtocolInput({ ...validProtocol, name: '' });
      assert.equal(res1.isValid, false);
      assert.ok(res1.errors.some(e => e.field === 'name'));

      const res2 = validateProtocolInput({ ...validProtocol, name: '   ' });
      assert.equal(res2.isValid, false);
    });

    it('rejects names exceeding 60 characters', () => {
      const longName = 'A'.repeat(61);
      const res = validateProtocolInput({ ...validProtocol, name: longName });
      assert.equal(res.isValid, false);
      assert.ok(res.errors.some(e => e.field === 'name' && e.code === 'INVALID_LENGTH'));
    });

    it('trims leading and trailing whitespace from valid name', () => {
      const res = validateProtocolInput({ ...validProtocol, name: '  Post-Workout Recovery  ' });
      assert.equal(res.isValid, true);
      assert.equal(res.sanitized.name, 'Post-Workout Recovery');
    });
  });

  describe('Intro Note Validation', () => {
    it('accepts optional intro note under 500 characters', () => {
      const res = validateProtocolInput({ ...validProtocol, introNote: 'Take with morning meal.' });
      assert.equal(res.isValid, true);
      assert.equal(res.sanitized.introNote, 'Take with morning meal.');
    });

    it('rejects intro note exceeding 500 characters', () => {
      const longNote = 'X'.repeat(501);
      const res = validateProtocolInput({ ...validProtocol, introNote: longNote });
      assert.equal(res.isValid, false);
      assert.ok(res.errors.some(e => e.field === 'introNote' && e.code === 'INVALID_LENGTH'));
    });
  });

  describe('Lines and Variant Rules', () => {
    it('rejects protocols with 0 lines', () => {
      const res = validateProtocolInput({ ...validProtocol, lines: [] });
      assert.equal(res.isValid, false);
      assert.ok(res.errors.some(e => e.field === 'lines' && e.code === 'MIN_ITEMS'));
    });

    it('rejects protocols with more than 20 lines', () => {
      const lines = Array.from({ length: 21 }, (_, i) => ({
        variantGid: `gid://shopify/ProductVariant/${1000 + i}`,
        quantity: 1
      }));
      const res = validateProtocolInput({ ...validProtocol, lines });
      assert.equal(res.isValid, false);
      assert.ok(res.errors.some(e => e.field === 'lines' && e.code === 'MAX_ITEMS'));
    });

    it('rejects duplicate variants in the same protocol', () => {
      const lines = [
        { variantGid: 'gid://shopify/ProductVariant/999', quantity: 1 },
        { variantGid: 'gid://shopify/ProductVariant/999', quantity: 2 }
      ];
      const res = validateProtocolInput({ ...validProtocol, lines });
      assert.equal(res.isValid, false);
      assert.ok(res.errors.some(e => e.code === 'DUPLICATE_VARIANT'));
    });

    it('rejects invalid quantities (<1, >10, floats, non-numbers)', () => {
      for (const badQty of [0, -1, 11, 2.5, '2', null]) {
        const lines = [{ variantGid: 'gid://shopify/ProductVariant/1001', quantity: badQty }];
        const res = validateProtocolInput({ ...validProtocol, lines });
        assert.equal(res.isValid, false, `Expected quantity ${badQty} to be rejected`);
        assert.ok(res.errors.some(e => e.code === 'INVALID_QUANTITY'));
      }
    });

    it('rejects usage note exceeding 200 characters', () => {
      const lines = [{
        variantGid: 'gid://shopify/ProductVariant/1001',
        quantity: 1,
        usageNote: 'N'.repeat(201)
      }];
      const res = validateProtocolInput({ ...validProtocol, lines });
      assert.equal(res.isValid, false);
      assert.ok(res.errors.some(e => e.code === 'INVALID_LENGTH'));
    });

    it('rejects variantGid exceeding maximum length of 100 characters', () => {
      const longVariantGid = 'gid://shopify/ProductVariant/' + '9'.repeat(101);
      const payload = {
        ...validProtocol,
        lines: [{ variantGid: longVariantGid, quantity: 1 }]
      };
      const res = validateProtocolInput(payload);
      assert.equal(res.isValid, false);
      assert.ok(res.errors.some(e => e.field === 'lines[0].variantGid' && e.code === 'INVALID_LENGTH'));
    });

    it('rejects invalid variantGid format', () => {
      const invalidGids = [
        'invalid-gid',
        'gid://shopify/Product/12345',
        'gid://shopify/Customer/12345',
        '12345',
        'gid://shopify/ProductVariant/',
        'gid://shopify/ProductVariant/abc!@#'
      ];
      for (const badGid of invalidGids) {
        const payload = {
          ...validProtocol,
          lines: [{ variantGid: badGid, quantity: 1 }]
        };
        const res = validateProtocolInput(payload);
        assert.equal(res.isValid, false, `Expected ${badGid} to be rejected as invalid GID format`);
        assert.ok(res.errors.some(e => e.field === 'lines[0].variantGid' && e.code === 'INVALID_GID_FORMAT'));
      }
    });
  });

  describe('Status and Admin Safeguards', () => {
    it('rejects setting status to disabled by non-admin', () => {
      const res = validateProtocolInput({ ...validProtocol, status: 'disabled' }, { isAdmin: false });
      assert.equal(res.isValid, false);
      assert.ok(res.errors.some(e => e.field === 'status' && e.code === 'ADMIN_ONLY_STATUS'));
    });

    it('allows setting status to disabled by admin', () => {
      const res = validateProtocolInput({ ...validProtocol, status: 'disabled' }, { isAdmin: true });
      assert.equal(res.isValid, true);
      assert.equal(res.sanitized.status, 'disabled');
    });

    it('ignores isStarter flag when set by non-admin', () => {
      const res = validateProtocolInput({ ...validProtocol, isStarter: true }, { isAdmin: false });
      assert.equal(res.isValid, true);
      assert.equal(res.sanitized.isStarter, false);
    });

    it('preserves isStarter flag when set by admin', () => {
      const res = validateProtocolInput({ ...validProtocol, isStarter: true }, { isAdmin: true });
      assert.equal(res.isValid, true);
      assert.equal(res.sanitized.isStarter, true);
    });
  });
});

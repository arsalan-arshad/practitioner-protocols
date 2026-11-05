import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMAIL_MAX_LENGTH,
  FIRST_NAME_MAX_LENGTH,
  CUSTOM_REQUEST_MESSAGE_MAX_LENGTH,
  ContactValidationError,
  validateContactEmail,
  validateContactFirstName,
  validateCustomRequestMessage,
  saveShopperContact,
  listPractitionerContacts,
  deletePractitionerContact,
  exportPractitionerContactsCsv,
  listMerchantContacts,
  deleteMerchantContact,
  deleteMerchantPracticeContacts,
  exportMerchantContactsCsv,
  saveMerchantCustomRequest,
  listMerchantFeedback
} from '../app/lib/protocols/contacts.js';

describe('Contacts & Merchant Feedback Service (app/lib/protocols/contacts.js)', () => {
  describe('Input Validators & Zero-PII Error Handling', () => {
    it('validates and lowercases valid email addresses', () => {
      assert.equal(validateContactEmail('Test.User@example.com'), 'test.user@example.com');
      assert.equal(validateContactEmail('  PRACTITIONER@CLINIC.ORG  '), 'practitioner@clinic.org');
      assert.equal(validateContactEmail('user+tag@sub.domain.co.uk'), 'user+tag@sub.domain.co.uk');
    });

    it('rejects invalid or empty email addresses without echoing input in error', () => {
      const invalidEmails = [
        '',
        '   ',
        null,
        undefined,
        12345,
        'plainaddress',
        '@missinguser.com',
        'missingdomain@.com',
        'spaces in@email.com',
        'a'.repeat(250) + '@example.com' // > 254 chars
      ];

      for (const input of invalidEmails) {
        assert.throws(
          () => validateContactEmail(input),
          (err) => {
            assert.ok(err instanceof ContactValidationError);
            assert.equal(err.code, 'INVALID_EMAIL');
            // Strict security/privacy assertion: error message must never echo the invalid input
            if (typeof input === 'string' && input.trim()) {
              assert.ok(!err.message.includes(input), 'Error message must not leak input email');
            }
            return true;
          }
        );
      }
    });

    it('validates optional first name up to 60 characters without echoing input in error', () => {
      assert.equal(validateContactFirstName(null), null);
      assert.equal(validateContactFirstName(undefined), null);
      assert.equal(validateContactFirstName(''), null);
      assert.equal(validateContactFirstName('   '), null);
      assert.equal(validateContactFirstName('  Jane  '), 'Jane');
      assert.equal(validateContactFirstName('Dr. Sarah Connor'), 'Dr. Sarah Connor');

      // Rejects non-string
      assert.throws(
        () => validateContactFirstName(123),
        (err) => err instanceof ContactValidationError && err.code === 'INVALID_FIRST_NAME'
      );

      // Rejects name > 60 chars
      const longName = 'A'.repeat(61);
      assert.throws(
        () => validateContactFirstName(longName),
        (err) => {
          assert.ok(err instanceof ContactValidationError);
          assert.equal(err.code, 'FIRST_NAME_TOO_LONG');
          assert.ok(!err.message.includes(longName), 'Error message must not leak input name');
          return true;
        }
      );
    });

    it('validates custom request message up to 1000 characters', () => {
      assert.equal(validateCustomRequestMessage('  We need bulk CSV import.  '), 'We need bulk CSV import.');

      assert.throws(
        () => validateCustomRequestMessage(''),
        (err) => err instanceof ContactValidationError && err.code === 'EMPTY_MESSAGE'
      );
      assert.throws(
        () => validateCustomRequestMessage('   '),
        (err) => err instanceof ContactValidationError && err.code === 'EMPTY_MESSAGE'
      );
      assert.throws(
        () => validateCustomRequestMessage(null),
        (err) => err instanceof ContactValidationError && err.code === 'INVALID_MESSAGE'
      );

      const longMessage = 'M'.repeat(1001);
      assert.throws(
        () => validateCustomRequestMessage(longMessage),
        (err) => err instanceof ContactValidationError && err.code === 'MESSAGE_TOO_LONG'
      );
    });
  });

  describe('saveShopperContact', () => {
    function createMockDb(initialProtocols = []) {
      const state = {
        queries: [],
        protocols: [...initialProtocols],
        contacts: []
      };

      return {
        state,
        async query(sql, params = []) {
          state.queries.push({ sql, params });

          // 1. SELECT "id", "ownerId", "status" FROM "Protocol" WHERE "shop" = $1 AND "token" = $2
          if (sql.includes('FROM "Protocol"') && sql.includes('"token" = $2')) {
            const [shop, token] = params;
            const proto = state.protocols.find(p => p.shop === shop && p.token === token);
            return { rows: proto ? [proto] : [] };
          }

          // 2. INSERT INTO "ShopperContact" ... ON CONFLICT DO UPDATE
          if (sql.includes('INSERT INTO "ShopperContact"')) {
            const [shop, ownerId, email, firstName, consentText, consentVersion, consentedAt] = params;
            const existingIdx = state.contacts.findIndex(c =>
              c.shop === shop && c.ownerId === ownerId && c.email.toLowerCase() === email.toLowerCase()
            );

            if (existingIdx >= 0) {
              state.contacts[existingIdx] = {
                ...state.contacts[existingIdx],
                firstName: firstName || state.contacts[existingIdx].firstName,
                consentText,
                consentVersion,
                consentedAt
              };
              return { rowCount: 1, rows: [{ id: state.contacts[existingIdx].id }] };
            }

            const newContact = {
              id: `contact_${Date.now()}_${Math.random()}`,
              shop,
              ownerId,
              email,
              firstName,
              consentText,
              consentVersion,
              consentedAt,
              source: 'protocol_page',
              createdAt: new Date()
            };
            state.contacts.push(newContact);
            return { rowCount: 1, rows: [{ id: newContact.id }] };
          }

          return { rows: [] };
        }
      };
    }

    const activeProto = {
      id: 'proto_123',
      shop: 'test.myshopify.com',
      token: 'tok_abc456',
      ownerId: 'gid://shopify/Customer/101',
      status: 'active'
    };

    it('silently ignores submissions with non-empty honeypot without database queries', async () => {
      const db = createMockDb([activeProto]);
      const res = await saveShopperContact(db, {
        shop: 'test.myshopify.com',
        token: 'tok_abc456',
        email: 'spammer@bot.com',
        consent: true,
        consentText: 'I agree',
        honeypot: 'bot filled this'
      });

      assert.equal(res.success, true);
      assert.equal(db.state.queries.length, 0, 'No database queries should be made when honeypot is filled');
      assert.equal(db.state.contacts.length, 0);
    });

    it('rejects submissions without explicit unticked consent', async () => {
      const db = createMockDb([activeProto]);
      await assert.rejects(
        () => saveShopperContact(db, {
          shop: 'test.myshopify.com',
          token: 'tok_abc456',
          email: 'user@example.com',
          consent: false,
          consentText: 'I agree'
        }),
        (err) => err instanceof ContactValidationError && err.code === 'CONSENT_REQUIRED'
      );
    });

    it('rejects submissions for missing, invalid, or inactive protocol token', async () => {
      const inactiveProto = {
        id: 'proto_disabled',
        shop: 'test.myshopify.com',
        token: 'tok_disabled',
        ownerId: 'gid://shopify/Customer/101',
        status: 'disabled'
      };
      const db = createMockDb([activeProto, inactiveProto]);

      await assert.rejects(
        () => saveShopperContact(db, {
          shop: 'test.myshopify.com',
          token: 'tok_nonexistent',
          email: 'user@example.com',
          consent: true,
          consentText: 'I agree'
        }),
        (err) => err instanceof ContactValidationError && err.code === 'PROTOCOL_INACTIVE'
      );

      await assert.rejects(
        () => saveShopperContact(db, {
          shop: 'test.myshopify.com',
          token: 'tok_disabled',
          email: 'user@example.com',
          consent: true,
          consentText: 'I agree'
        }),
        (err) => err instanceof ContactValidationError && err.code === 'PROTOCOL_INACTIVE'
      );
    });

    it('saves opted-in contact and guarantees zero shopper tracking across protocols/orders', async () => {
      const db = createMockDb([activeProto]);
      const consentText = 'I agree to receive communications from Dr. Smith.';
      const res = await saveShopperContact(db, {
        shop: 'test.myshopify.com',
        token: 'tok_abc456',
        email: 'Shopper@Example.COM',
        firstName: 'Alice',
        consent: true,
        consentText,
        consentVersion: 1
      });

      assert.equal(res.success, true);
      assert.equal(db.state.contacts.length, 1);
      const contact = db.state.contacts[0];
      assert.equal(contact.email, 'shopper@example.com');
      assert.equal(contact.firstName, 'Alice');
      assert.equal(contact.ownerId, 'gid://shopify/Customer/101');
      assert.equal(contact.consentText, consentText);
      assert.equal(contact.source, 'protocol_page');

      // Verify that no protocolId, order id, or PII tracking was stored in contact
      assert.equal(contact.protocolId, undefined);
      assert.equal(contact.orderId, undefined);
      assert.equal(contact.ip, undefined);
      assert.equal(contact.userAgent, undefined);
    });

    it('handles idempotent submissions for the same (shop, ownerId, email)', async () => {
      const db = createMockDb([activeProto]);
      const firstText = 'Consent v1';
      const secondText = 'Consent v2';

      await saveShopperContact(db, {
        shop: 'test.myshopify.com',
        token: 'tok_abc456',
        email: 'shopper@example.com',
        firstName: null,
        consent: true,
        consentText: firstText,
        consentVersion: 1
      });

      assert.equal(db.state.contacts.length, 1);

      await saveShopperContact(db, {
        shop: 'test.myshopify.com',
        token: 'tok_abc456',
        email: 'shopper@example.com',
        firstName: 'Updated Alice',
        consent: true,
        consentText: secondText,
        consentVersion: 2
      });

      assert.equal(db.state.contacts.length, 1, 'Duplicate contact must not create second row');
      assert.equal(db.state.contacts[0].firstName, 'Updated Alice');
      assert.equal(db.state.contacts[0].consentText, secondText);
      assert.equal(db.state.contacts[0].consentVersion, 2);
    });
  });

  describe('Practitioner Scoped Contacts & RFC 4180 CSV Export', () => {
    it('lists and deletes contacts strictly scoped to the practitioner ownerId', async () => {
      const contacts = [
        { id: 'c1', shop: 'test.myshopify.com', ownerId: 'gid://shopify/Customer/101', email: 'c1@test.com' },
        { id: 'c2', shop: 'test.myshopify.com', ownerId: 'gid://shopify/Customer/101', email: 'c2@test.com' },
        { id: 'c3', shop: 'test.myshopify.com', ownerId: 'gid://shopify/Customer/202', email: 'c3@test.com' }
      ];

      const mockDb = {
        async query(sql, params) {
          if (sql.includes('SELECT') && sql.includes('FROM "ShopperContact"')) {
            const [shop, ownerId] = params;
            return { rows: contacts.filter(c => c.shop === shop && c.ownerId === ownerId) };
          }
          if (sql.includes('DELETE FROM "ShopperContact"')) {
            const [shop, ownerId, id] = params;
            const idx = contacts.findIndex(c => c.shop === shop && c.ownerId === ownerId && c.id === id);
            if (idx >= 0) {
              contacts.splice(idx, 1);
              return { rowCount: 1 };
            }
            return { rowCount: 0 };
          }
          return { rows: [] };
        }
      };

      const owner1Contacts = await listPractitionerContacts(mockDb, {
        shop: 'test.myshopify.com',
        ownerId: 'gid://shopify/Customer/101'
      });
      assert.equal(owner1Contacts.length, 2);

      // Attempting to delete c3 (owned by 202) while scoped to 101 must fail
      const crossDelete = await deletePractitionerContact(mockDb, {
        shop: 'test.myshopify.com',
        ownerId: 'gid://shopify/Customer/101',
        contactId: 'c3'
      });
      assert.equal(crossDelete, false);
      assert.equal(contacts.length, 3);

      // Deleting own contact succeeds
      const ownDelete = await deletePractitionerContact(mockDb, {
        shop: 'test.myshopify.com',
        ownerId: 'gid://shopify/Customer/101',
        contactId: 'c1'
      });
      assert.equal(ownDelete, true);
      assert.equal(contacts.length, 2);
    });

    it('exports practitioner contacts to RFC 4180 CSV with Email, First Name, Consented At', () => {
      const contacts = [
        {
          email: 'jane@example.com',
          firstName: 'Jane, M.D.',
          consentedAt: new Date('2026-11-05T12:00:00Z')
        },
        {
          email: 'bob@example.com',
          firstName: null,
          consentedAt: '2026-11-05T13:00:00Z'
        }
      ];

      const csv = exportPractitionerContactsCsv(contacts);
      const lines = csv.split('\r\n');
      assert.equal(lines[0], 'Email,First Name,Consented At');
      assert.equal(lines[1], 'jane@example.com,"Jane, M.D.",2026-11-05T12:00:00.000Z');
      assert.equal(lines[2], 'bob@example.com,,2026-11-05T13:00:00Z');
    });
  });

  describe('Merchant Admin Contacts & Custom Requests', () => {
    it('lists merchant contacts and computes practice rollups', async () => {
      const mockRows = [
        { id: '1', shop: 'shop.myshopify.com', ownerId: 'p1', email: 'a@test.com', firstName: 'A', practiceName: 'Practice Alpha' },
        { id: '2', shop: 'shop.myshopify.com', ownerId: 'p1', email: 'b@test.com', firstName: 'B', practiceName: 'Practice Alpha' },
        { id: '3', shop: 'shop.myshopify.com', ownerId: 'p2', email: 'c@test.com', firstName: 'C', practiceName: 'Practice Beta' }
      ];

      const mockDb = {
        async query() {
          return { rows: mockRows };
        }
      };

      const result = await listMerchantContacts(mockDb, { shop: 'shop.myshopify.com' });
      assert.equal(result.totalContacts, 3);
      assert.equal(result.practices.length, 2);
      assert.equal(result.practices[0].ownerId, 'p1');
      assert.equal(result.practices[0].count, 2);
      assert.equal(result.practices[1].ownerId, 'p2');
      assert.equal(result.practices[1].count, 1);
    });

    it('exports all merchant contacts to RFC 4180 CSV with 9 columns', () => {
      const contacts = [
        {
          shop: 'demo.myshopify.com',
          practiceName: 'Elite Health',
          ownerId: 'gid://shopify/Customer/99',
          email: 'patient@example.com',
          firstName: 'John',
          consentText: 'I consent to "stay in touch".',
          consentVersion: 1,
          consentedAt: new Date('2026-11-05T10:00:00Z'),
          createdAt: new Date('2026-11-05T10:00:00Z')
        }
      ];

      const csv = exportMerchantContactsCsv(contacts, 'demo.myshopify.com');
      const lines = csv.split('\r\n');
      assert.equal(lines[0], 'Shop,Practice Name,Owner GID,Email,First Name,Consent Text,Consent Version,Consented At,Created At');
      assert.ok(lines[1].includes('demo.myshopify.com,Elite Health,gid://shopify/Customer/99,patient@example.com,John,"I consent to ""stay in touch"".",1,2026-11-05T10:00:00.000Z,2026-11-05T10:00:00.000Z'));
    });

    it('saves and lists merchant custom requests', async () => {
      const feedbackRows = [];
      const mockDb = {
        async query(sql, params) {
          if (sql.includes('INSERT INTO "MerchantFeedback"')) {
            const [shop, shopName, ownerName, replyEmail, planName, country, message, kind] = params;
            const newRow = { id: 'fb_1', shop, shopName, ownerName, replyEmail, planName, country, message, kind, createdAt: new Date() };
            feedbackRows.push(newRow);
            return { rowCount: 1, rows: [{ id: newRow.id }] };
          }
          if (sql.includes('SELECT') && sql.includes('FROM "MerchantFeedback"')) {
            const [shop, kind] = params;
            return { rows: feedbackRows.filter(r => r.shop === shop && r.kind === kind) };
          }
          return { rows: [] };
        }
      };

      const res = await saveMerchantCustomRequest(mockDb, {
        shop: 'store.myshopify.com',
        shopName: 'Health Store',
        ownerName: 'Alice Merchant',
        replyEmail: 'merchant@store.com',
        message: 'Could you add support for barcode scanner input?'
      });

      assert.equal(res.success, true);
      assert.equal(feedbackRows.length, 1);
      assert.equal(feedbackRows[0].replyEmail, 'merchant@store.com');
      assert.equal(feedbackRows[0].kind, 'custom_request');

      const listed = await listMerchantFeedback(mockDb, { shop: 'store.myshopify.com' });
      assert.equal(listed.length, 1);
      assert.equal(listed[0].message, 'Could you add support for barcode scanner input?');
    });
  });
});

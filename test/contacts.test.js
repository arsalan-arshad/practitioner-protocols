import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMAIL_MAX_LENGTH,
  FIRST_NAME_MAX_LENGTH,
  CUSTOM_REQUEST_MESSAGE_MAX_LENGTH,
  CANONICAL_CONSENT_TEMPLATES,
  getCanonicalConsentText,
  ContactValidationError,
  validateContactEmail,
  validateContactFirstName,
  validateCustomRequestMessage,
  validateFeedbackRating,
  saveShopperContact,
  listPractitionerContacts,
  deletePractitionerContact,
  exportPractitionerContactsCsv,
  listMerchantContacts,
  deleteMerchantContact,
  deleteMerchantPracticeContacts,
  exportMerchantContactsCsv,
  getShopProfile,
  upsertShopProfile,
  updateShopMarketingOptIn,
  syncShopProfile,
  saveMerchantCustomRequest,
  saveMerchantFeedback,
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

    it('validates feedback rating 1-5', () => {
      assert.equal(validateFeedbackRating(null), null);
      assert.equal(validateFeedbackRating(undefined), null);
      assert.equal(validateFeedbackRating(''), null);
      assert.equal(validateFeedbackRating(1), 1);
      assert.equal(validateFeedbackRating(5), 5);
      assert.equal(validateFeedbackRating('3'), 3);

      assert.throws(() => validateFeedbackRating(0), { message: /Rating must be an integer between 1 and 5/ });
      assert.throws(() => validateFeedbackRating(6), { message: /Rating must be an integer between 1 and 5/ });
      assert.throws(() => validateFeedbackRating(-1), { message: /Rating must be an integer between 1 and 5/ });
      assert.throws(() => validateFeedbackRating(3.5), { message: /Rating must be an integer between 1 and 5/ });
      assert.throws(() => validateFeedbackRating('invalid'), { message: /Rating must be an integer between 1 and 5/ });
    });

    it('generates canonical consent texts and rejects unknown consent versions', () => {
      const text = getCanonicalConsentText(1, { practiceName: 'Dr. Jane Clinic', shopName: 'my-store.myshopify.com' });
      assert.equal(
        text,
        'I agree to receive emails from Dr. Jane Clinic and my-store.myshopify.com with product recommendations and offers. I can unsubscribe at any time.'
      );

      // Default fallbacks
      const fallbackText = getCanonicalConsentText(1, { practiceName: null, shopName: null });
      assert.equal(
        fallbackText,
        'I agree to receive emails from this practice and this store with product recommendations and offers. I can unsubscribe at any time.'
      );

      // Unknown version throws
      assert.throws(
        () => getCanonicalConsentText(99),
        (err) => err instanceof ContactValidationError && err.code === 'INVALID_CONSENT_VERSION'
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

          // 1. SELECT pr."id", pr."ownerId", pr."status", pp."practiceName" FROM "Protocol" ...
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
      practiceName: 'Wellness Partners',
      status: 'active'
    };

    it('silently ignores submissions with non-empty honeypot without database queries', async () => {
      const db = createMockDb([activeProto]);
      const res = await saveShopperContact(db, {
        shop: 'test.myshopify.com',
        token: 'tok_abc456',
        email: 'spammer@bot.com',
        consent: true,
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
          consent: false
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
          consent: true
        }),
        (err) => err instanceof ContactValidationError && err.code === 'PROTOCOL_INACTIVE'
      );

      await assert.rejects(
        () => saveShopperContact(db, {
          shop: 'test.myshopify.com',
          token: 'tok_disabled',
          email: 'user@example.com',
          consent: true
        }),
        (err) => err instanceof ContactValidationError && err.code === 'PROTOCOL_INACTIVE'
      );
    });

    it('ignores client-supplied consentText and stores canonical text server-side', async () => {
      const db = createMockDb([activeProto]);
      const res = await saveShopperContact(db, {
        shop: 'test.myshopify.com',
        token: 'tok_abc456',
        email: 'Shopper@Example.COM',
        firstName: 'Alice',
        consent: true,
        consentText: 'ANYTHING I WANT', // Forged text from client
        consentVersion: 1
      });

      assert.equal(res.success, true);
      assert.equal(db.state.contacts.length, 1);
      const contact = db.state.contacts[0];
      assert.equal(contact.email, 'shopper@example.com');
      assert.equal(contact.firstName, 'Alice');
      assert.equal(contact.ownerId, 'gid://shopify/Customer/101');

      // Canonical server text MUST be stored, forged text ignored
      assert.equal(
        contact.consentText,
        'I agree to receive emails from Wellness Partners and test.myshopify.com with product recommendations and offers. I can unsubscribe at any time.'
      );
      assert.equal(contact.consentVersion, 1);
      assert.equal(contact.source, 'protocol_page');
    });

    it('rejects unknown consent version values', async () => {
      const db = createMockDb([activeProto]);
      await assert.rejects(
        () => saveShopperContact(db, {
          shop: 'test.myshopify.com',
          token: 'tok_abc456',
          email: 'shopper@example.com',
          consent: true,
          consentVersion: 999
        }),
        (err) => err instanceof ContactValidationError && err.code === 'INVALID_CONSENT_VERSION'
      );
    });

    it('treats Jane@X.com and jane@x.com as the exact same contact on (shop, ownerId, email)', async () => {
      const db = createMockDb([activeProto]);

      await saveShopperContact(db, {
        shop: 'test.myshopify.com',
        token: 'tok_abc456',
        email: 'Jane@X.com',
        firstName: 'Jane',
        consent: true,
        consentVersion: 1
      });

      assert.equal(db.state.contacts.length, 1);
      assert.equal(db.state.contacts[0].email, 'jane@x.com');

      await saveShopperContact(db, {
        shop: 'test.myshopify.com',
        token: 'tok_abc456',
        email: 'jane@x.com',
        firstName: 'Updated Jane',
        consent: true,
        consentVersion: 1
      });

      assert.equal(db.state.contacts.length, 1, 'Same contact under case-insensitive comparison');
      assert.equal(db.state.contacts[0].firstName, 'Updated Jane');
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

    it('exports practitioner contacts to RFC 4180 CSV with Verified = no and disclaimer comment', () => {
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
      assert.match(lines[0], /^# Note: Email addresses are collected with opt-in consent but are not verified/);
      assert.equal(lines[1], 'Email,First Name,Consented At,Verified');
      assert.equal(lines[2], 'jane@example.com,"Jane, M.D.",2026-11-05T12:00:00.000Z,no');
      assert.equal(lines[3], 'bob@example.com,,2026-11-05T13:00:00Z,no');
    });
  });

  describe('Merchant Admin Contacts & CSV Export', () => {
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

    it('exports all merchant contacts to RFC 4180 CSV with Verified = no and disclaimer comment', () => {
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
      assert.match(lines[0], /^# Note: Email addresses are collected with opt-in consent but are not verified/);
      assert.equal(lines[1], 'Shop,Practice Name,Owner GID,Email,First Name,Consent Text,Consent Version,Consented At,Created At,Verified');
      assert.ok(lines[2].includes('demo.myshopify.com,Elite Health,gid://shopify/Customer/99,patient@example.com,John,"I consent to ""stay in touch"".",1,2026-11-05T10:00:00.000Z,2026-11-05T10:00:00.000Z,no'));
    });
  });

  describe('ShopProfile & Merchant Feedback Management', () => {
    it('upserts ShopProfile and preserves marketingOptIn on reinstall', async () => {
      let storedProfile = null;

      const mockDb = {
        async query(sql, params) {
          if (sql.includes('INSERT INTO "ShopProfile"')) {
            const [shop, shopName, ownerName, email, planName, country] = params;
            if (!storedProfile) {
              storedProfile = {
                id: 'sp_1',
                shop,
                shopName,
                ownerName,
                email,
                planName,
                country,
                installedAt: new Date(),
                uninstalledAt: null,
                marketingOptIn: false,
                marketingOptInAt: null,
                updatedAt: new Date()
              };
            } else {
              // Reinstall simulation: clears uninstalledAt, keeps marketingOptIn
              storedProfile = {
                ...storedProfile,
                shopName: shopName || storedProfile.shopName,
                ownerName: ownerName || storedProfile.ownerName,
                email: email || storedProfile.email,
                planName: planName || storedProfile.planName,
                country: country || storedProfile.country,
                uninstalledAt: null,
                updatedAt: new Date()
              };
            }
            return { rows: [storedProfile] };
          }
          if (sql.includes('SELECT * FROM "ShopProfile"')) {
            return { rows: storedProfile ? [storedProfile] : [] };
          }
          return { rows: [] };
        }
      };

      // 1. Initial install
      const p1 = await upsertShopProfile(mockDb, {
        shop: 'store.myshopify.com',
        shopName: 'Organic Apothecary',
        ownerName: 'Dr. Jane',
        email: 'jane@apothecary.com',
        planName: 'Shopify Plus',
        country: 'CA'
      });
      assert.equal(p1.shop, 'store.myshopify.com');
      assert.equal(p1.marketingOptIn, false);
      assert.equal(p1.uninstalledAt, null);

      // 2. Merchant opts in
      storedProfile.marketingOptIn = true;
      storedProfile.marketingOptInAt = new Date();

      // 3. Merchant uninstalls
      storedProfile.uninstalledAt = new Date();

      // 4. Reinstall: must clear uninstalledAt and KEEP marketingOptIn = true
      const p2 = await upsertShopProfile(mockDb, {
        shop: 'store.myshopify.com',
        shopName: 'Organic Apothecary 2.0'
      });
      assert.equal(p2.uninstalledAt, null, 'Reinstall clears uninstalledAt');
      assert.equal(p2.marketingOptIn, true, 'Reinstall preserves prior marketing opt-in');
      assert.ok(p2.marketingOptInAt instanceof Date);
    });

    it('updates marketingOptIn and sets/clears timestamp', async () => {
      let stored = {
        shop: 'store.myshopify.com',
        marketingOptIn: false,
        marketingOptInAt: null
      };

      const mockDb = {
        async query(sql, params) {
          if (sql.includes('UPDATE "ShopProfile"')) {
            const [shop, isOptedIn] = params;
            stored.marketingOptIn = isOptedIn;
            stored.marketingOptInAt = isOptedIn ? new Date() : null;
            return { rows: [stored] };
          }
          return { rows: [] };
        }
      };

      const optIn = await updateShopMarketingOptIn(mockDb, { shop: 'store.myshopify.com', marketingOptIn: true });
      assert.equal(optIn.marketingOptIn, true);
      assert.ok(optIn.marketingOptInAt instanceof Date);

      const optOut = await updateShopMarketingOptIn(mockDb, { shop: 'store.myshopify.com', marketingOptIn: false });
      assert.equal(optOut.marketingOptIn, false);
      assert.equal(optOut.marketingOptInAt, null);
    });

    it('saves merchant feedback with rating and message', async () => {
      const feedbackRows = [];
      const mockDb = {
        async query(sql, params) {
          if (sql.includes('INSERT INTO "MerchantFeedback"')) {
            const [shop, shopName, ownerName, replyEmail, planName, country, message, rating] = params;
            const newRow = { id: 'fb_1', shop, shopName, ownerName, replyEmail, planName, country, message, rating, kind: 'feedback', createdAt: new Date() };
            feedbackRows.push(newRow);
            return { rowCount: 1, rows: [{ id: newRow.id }] };
          }
          if (sql.includes('SELECT * FROM "ShopProfile"')) {
            return { rows: [{ shop: 'test.myshopify.com', shopName: 'Herbal Shop', email: 'owner@herbal.com' }] };
          }
          if (sql.includes('UPDATE "ShopProfile"')) {
            return { rows: [] };
          }
          return { rows: [] };
        }
      };

      const res = await saveMerchantFeedback(mockDb, {
        shop: 'test.myshopify.com',
        rating: 5,
        message: 'The protocol editor has been amazing for our staff.',
        marketingOptIn: true
      });

      assert.equal(res.success, true);
      assert.equal(feedbackRows.length, 1);
      assert.equal(feedbackRows[0].rating, 5);
      assert.equal(feedbackRows[0].message, 'The protocol editor has been amazing for our staff.');
      assert.equal(feedbackRows[0].replyEmail, 'owner@herbal.com');
    });

    it('prefills metadata from ShopProfile on custom request and never turns on marketingOptIn', async () => {
      const feedbackRows = [];
      let shopProfile = {
        shop: 'test.myshopify.com',
        shopName: 'Clinic One',
        ownerName: 'Dr. Roberts',
        email: 'roberts@clinic.com',
        planName: 'Grow',
        country: 'US',
        marketingOptIn: false
      };

      const mockDb = {
        async query(sql, params) {
          if (sql.includes('SELECT * FROM "ShopProfile"')) {
            return { rows: [shopProfile] };
          }
          if (sql.includes('INSERT INTO "MerchantFeedback"')) {
            const [shop, shopName, ownerName, replyEmail, planName, country, message, kind] = params;
            const newRow = { id: 'cr_1', shop, shopName, ownerName, replyEmail, planName, country, message, kind };
            feedbackRows.push(newRow);
            return { rowCount: 1, rows: [{ id: newRow.id }] };
          }
          return { rows: [] };
        }
      };

      await saveMerchantCustomRequest(mockDb, {
        shop: 'test.myshopify.com',
        message: 'Can we have customizable color themes?'
      });

      assert.equal(feedbackRows.length, 1);
      assert.equal(feedbackRows[0].shopName, 'Clinic One');
      assert.equal(feedbackRows[0].ownerName, 'Dr. Roberts');
      assert.equal(feedbackRows[0].replyEmail, 'roberts@clinic.com');
      assert.equal(feedbackRows[0].planName, 'Grow');
      assert.equal(feedbackRows[0].country, 'US');
      assert.equal(shopProfile.marketingOptIn, false, 'Custom request must never turn on marketingOptIn');
    });

    it('syncShopProfile queries GraphQL and handles failures gracefully without blocking', async () => {
      let storedProfile = null;
      const mockDb = {
        async query(sql, params) {
          if (sql.includes('SELECT "accessToken" FROM "Session"')) {
            return { rows: [{ accessToken: 'mock_shpat_valid_token' }] };
          }
          if (sql.includes('INSERT INTO "ShopProfile"')) {
            const [shop, shopName, ownerName, email, planName, country] = params;
            storedProfile = { shop, shopName, ownerName, email, planName, country };
            return { rows: [storedProfile] };
          }
          return { rows: [] };
        }
      };

      // 1. Success path
      let capturedSignal = null;
      let capturedBody = null;
      const fakeFetchSuccess = async (url, options) => {
        capturedSignal = options?.signal;
        capturedBody = JSON.parse(options?.body || '{}');
        return {
          ok: true,
          json: async () => ({
            data: {
              shop: {
                name: 'Holistic Care',
                email: 'info@holistic.com',
                shopOwnerName: 'Alice Green',
                plan: { publicDisplayName: 'Advanced' },
                shopAddress: { countryCodeV2: 'GB' }
              }
            }
          })
        };
      };

      const res = await syncShopProfile(mockDb, { shop: 'holistic.myshopify.com', fetchFn: fakeFetchSuccess });
      assert.ok(res);
      assert.ok(capturedSignal, 'Must pass AbortSignal to GraphQL fetch');
      assert.equal(typeof capturedSignal.aborted, 'boolean');
      assert.ok(capturedBody.query, 'Must send GraphQL query in body');
      assert.match(capturedBody.query, /shopAddress\s*\{\s*countryCodeV2\s*\}/, 'Query must select shopAddress { countryCodeV2 }');
      assert.doesNotMatch(capturedBody.query, /billingAddress/, 'Query must not select billingAddress');
      assert.equal(res.shopName, 'Holistic Care');
      assert.equal(res.email, 'info@holistic.com');
      assert.equal(res.ownerName, 'Alice Green');
      assert.equal(res.planName, 'Advanced');
      assert.equal(res.country, 'GB');

      // 2. Failed fetch must never throw or block
      const origWarn = console.warn;
      const warnings = [];
      console.warn = (...args) => warnings.push(args.join(' '));

      try {
        const fakeFetchFail = async () => ({
          ok: false,
          status: 500
        });

        const failRes = await syncShopProfile(mockDb, { shop: 'holistic.myshopify.com', fetchFn: fakeFetchFail });
        assert.equal(failRes, null);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /Failed to fetch shop profile for holistic\.myshopify\.com: HTTP 500/);

        // 3. Aborted/timed out fetch must be handled gracefully without throwing
        const fakeFetchTimeout = async () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          throw err;
        };

        const timeoutRes = await syncShopProfile(mockDb, { shop: 'holistic.myshopify.com', fetchFn: fakeFetchTimeout });
        assert.equal(timeoutRes, null);
        assert.equal(warnings.length, 2);
        assert.match(warnings[1], /The operation was aborted/);

        // 4. GraphQL errors response logs single line with truncated message and returns null
        const longMessage = 'A'.repeat(300);
        const fakeFetchGraphQLError = async () => ({
          ok: true,
          json: async () => ({
            errors: [{ message: longMessage }]
          })
        });

        const gqlErrRes = await syncShopProfile(mockDb, { shop: 'holistic.myshopify.com', fetchFn: fakeFetchGraphQLError });
        assert.equal(gqlErrRes, null);
        assert.equal(warnings.length, 3);
        assert.match(warnings[2], /^\[ShopProfile\] GraphQL error for holistic\.myshopify\.com: A{200}$/);
      } finally {
        console.warn = origWarn;
      }
    });
  });
});

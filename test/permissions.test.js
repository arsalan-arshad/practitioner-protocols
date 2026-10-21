import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canAccessProtocol, DENIAL_REASONS } from '../app/lib/protocols/permissions.js';

describe('Permissions & Authorization Guard (app/lib/protocols/permissions.js)', () => {
  const adminUser = { id: 'admin_1', role: 'admin' };

  const practitionerCustomerA = {
    id: 'user_1',
    role: 'practitioner',
    ownerType: 'customer',
    ownerId: 'gid://shopify/Customer/101'
  };

  const practitionerCustomerB = {
    id: 'user_2',
    role: 'practitioner',
    ownerType: 'customer',
    ownerId: 'gid://shopify/Customer/202'
  };

  const practitionerCompanyA = {
    id: 'user_3',
    role: 'practitioner',
    ownerType: 'company',
    ownerId: 'gid://shopify/Company/999'
  };

  const standardProtocol = {
    id: 'prot_1',
    ownerType: 'customer',
    ownerId: 'gid://shopify/Customer/101',
    isStarter: false,
    status: 'active'
  };

  const starterProtocol = {
    id: 'prot_starter',
    ownerType: 'company',
    ownerId: 'gid://shopify/Company/brand',
    isStarter: true,
    status: 'active'
  };

  const disabledProtocol = {
    id: 'prot_disabled',
    ownerType: 'customer',
    ownerId: 'gid://shopify/Customer/101',
    isStarter: false,
    status: 'disabled'
  };

  const archivedProtocol = {
    id: 'prot_archived',
    ownerType: 'customer',
    ownerId: 'gid://shopify/Customer/101',
    isStarter: false,
    status: 'archived'
  };

  describe('Admin Access', () => {
    it('grants admin full access to any protocol and action', () => {
      const actions = ['read', 'create', 'edit', 'archive', 'restore', 'duplicate', 'delete'];
      for (const act of actions) {
        assert.deepEqual(canAccessProtocol(adminUser, standardProtocol, act), {
          allowed: true,
          reason: null
        });
        assert.deepEqual(canAccessProtocol(adminUser, starterProtocol, act), {
          allowed: true,
          reason: null
        });
        assert.deepEqual(canAccessProtocol(adminUser, disabledProtocol, act), {
          allowed: true,
          reason: null
        });
      }
    });
  });

  describe('Authentication & Action Validation', () => {
    it('denies unauthenticated or invalid user objects', () => {
      assert.deepEqual(canAccessProtocol(null, standardProtocol, 'read'), {
        allowed: false,
        reason: DENIAL_REASONS.UNAUTHENTICATED
      });
      assert.deepEqual(canAccessProtocol(undefined, standardProtocol, 'read'), {
        allowed: false,
        reason: DENIAL_REASONS.UNAUTHENTICATED
      });
    });

    it('denies unknown actions', () => {
      assert.deepEqual(canAccessProtocol(practitionerCustomerA, standardProtocol, 'publish'), {
        allowed: false,
        reason: DENIAL_REASONS.INVALID_ACTION
      });
      assert.deepEqual(canAccessProtocol(practitionerCustomerA, standardProtocol, ''), {
        allowed: false,
        reason: DENIAL_REASONS.INVALID_ACTION
      });
    });

    it('denies non-practitioner/non-admin roles', () => {
      const shopper = { id: 'shop_1', role: 'customer' };
      assert.deepEqual(canAccessProtocol(shopper, standardProtocol, 'read'), {
        allowed: false,
        reason: DENIAL_REASONS.UNAUTHORIZED_ROLE
      });
    });
  });

  describe('Ownership Matching (Tag vs Company Mode)', () => {
    it('allows owner practitioner in Tag mode (customer ownerType)', () => {
      assert.deepEqual(canAccessProtocol(practitionerCustomerA, standardProtocol, 'read'), {
        allowed: true,
        reason: null
      });
      assert.deepEqual(canAccessProtocol(practitionerCustomerA, standardProtocol, 'edit'), {
        allowed: true,
        reason: null
      });
      assert.deepEqual(canAccessProtocol(practitionerCustomerA, standardProtocol, 'archive'), {
        allowed: true,
        reason: null
      });
    });

    it('blocks cross-practitioner access (different customer ID)', () => {
      const res = canAccessProtocol(practitionerCustomerB, standardProtocol, 'read');
      assert.deepEqual(res, {
        allowed: false,
        reason: DENIAL_REASONS.FORBIDDEN_OWNERSHIP_MISMATCH
      });
    });

    it('blocks cross-owner-type access (Company user accessing customer protocol)', () => {
      const res = canAccessProtocol(practitionerCompanyA, standardProtocol, 'edit');
      assert.deepEqual(res, {
        allowed: false,
        reason: DENIAL_REASONS.FORBIDDEN_OWNERSHIP_MISMATCH
      });
    });

    it('allows Company mode practitioner matching Company ownerId', () => {
      const companyProtocol = {
        id: 'prot_co',
        ownerType: 'company',
        ownerId: 'gid://shopify/Company/999',
        isStarter: false,
        status: 'active'
      };
      assert.deepEqual(canAccessProtocol(practitionerCompanyA, companyProtocol, 'read'), {
        allowed: true,
        reason: null
      });
      assert.deepEqual(canAccessProtocol(practitionerCompanyA, companyProtocol, 'edit'), {
        allowed: true,
        reason: null
      });
    });
  });

  describe('Disabled Protocols', () => {
    it('blocks non-admin from accessing disabled protocol even if owned', () => {
      assert.deepEqual(canAccessProtocol(practitionerCustomerA, disabledProtocol, 'read'), {
        allowed: false,
        reason: DENIAL_REASONS.ADMIN_ONLY_DISABLED_PROTOCOL
      });
      assert.deepEqual(canAccessProtocol(practitionerCustomerA, disabledProtocol, 'edit'), {
        allowed: false,
        reason: DENIAL_REASONS.ADMIN_ONLY_DISABLED_PROTOCOL
      });
    });
  });

  describe('Starter Templates (Brand Templates)', () => {
    it('allows practitioners to read and duplicate starter protocols', () => {
      assert.deepEqual(canAccessProtocol(practitionerCustomerA, starterProtocol, 'read'), {
        allowed: true,
        reason: null
      });
      assert.deepEqual(canAccessProtocol(practitionerCustomerA, starterProtocol, 'duplicate'), {
        allowed: true,
        reason: null
      });
    });

    it('strictly forbids practitioners from editing, archiving, restoring, or deleting starters', () => {
      for (const act of ['edit', 'archive', 'restore', 'delete']) {
        assert.deepEqual(canAccessProtocol(practitionerCustomerA, starterProtocol, act), {
          allowed: false,
          reason: DENIAL_REASONS.STARTER_MODIFICATION_FORBIDDEN
        });
      }
    });

    it('forbids practitioners from creating starter protocols', () => {
      assert.deepEqual(canAccessProtocol(practitionerCustomerA, { isStarter: true }, 'create'), {
        allowed: false,
        reason: DENIAL_REASONS.STARTER_CREATION_ADMIN_ONLY
      });
    });
  });

  describe('Archived Protocols', () => {
    it('blocks editing archived protocols directly until restored', () => {
      assert.deepEqual(canAccessProtocol(practitionerCustomerA, archivedProtocol, 'edit'), {
        allowed: false,
        reason: DENIAL_REASONS.ARCHIVED_PROTOCOL_READ_ONLY
      });
    });

    it('allows reading, restoring, duplicating, and deleting archived protocols', () => {
      for (const act of ['read', 'restore', 'duplicate', 'delete']) {
        assert.deepEqual(canAccessProtocol(practitionerCustomerA, archivedProtocol, act), {
          allowed: true,
          reason: null
        });
      }
    });
  });
});

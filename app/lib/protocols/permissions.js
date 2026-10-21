/**
 * Supported actions on protocol records.
 */
export const PROTOCOL_ACTIONS = new Set([
  'read',
  'create',
  'edit',
  'archive',
  'restore',
  'duplicate',
  'delete'
]);

/**
 * Reason codes for permission denials.
 */
export const DENIAL_REASONS = {
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  UNAUTHORIZED_ROLE: 'UNAUTHORIZED_ROLE',
  INVALID_ACTION: 'INVALID_ACTION',
  PROTOCOL_NOT_FOUND: 'PROTOCOL_NOT_FOUND',
  ADMIN_ONLY_DISABLED_PROTOCOL: 'ADMIN_ONLY_DISABLED_PROTOCOL',
  STARTER_CREATION_ADMIN_ONLY: 'STARTER_CREATION_ADMIN_ONLY',
  STARTER_MODIFICATION_FORBIDDEN: 'STARTER_MODIFICATION_FORBIDDEN',
  ARCHIVED_PROTOCOL_READ_ONLY: 'ARCHIVED_PROTOCOL_READ_ONLY',
  FORBIDDEN_OWNERSHIP_MISMATCH: 'FORBIDDEN_OWNERSHIP_MISMATCH'
};

/**
 * Evaluates whether a user context is authorized to perform an action on a protocol.
 *
 * @param {{
 *   id?: string,
 *   role: 'admin' | 'practitioner' | string,
 *   ownerType?: 'customer' | 'company' | string,
 *   ownerId?: string
 * }} user
 * @param {{
 *   id?: string,
 *   ownerType?: 'customer' | 'company' | string,
 *   ownerId?: string,
 *   isStarter?: boolean,
 *   status?: string
 * } | null | undefined} protocol
 * @param {'read' | 'create' | 'edit' | 'archive' | 'restore' | 'duplicate' | 'delete' | string} action
 * @returns {{ allowed: boolean, reason: string | null }}
 */
export function canAccessProtocol(user, protocol, action) {
  // 1. Authentication & user validation
  if (!user || typeof user !== 'object') {
    return { allowed: false, reason: DENIAL_REASONS.UNAUTHENTICATED };
  }

  // 2. Action validation
  if (typeof action !== 'string' || !PROTOCOL_ACTIONS.has(action)) {
    return { allowed: false, reason: DENIAL_REASONS.INVALID_ACTION };
  }

  // 3. Admin bypass: Full access across all protocols and actions
  if (user.role === 'admin') {
    return { allowed: true, reason: null };
  }

  // 4. Role validation for non-admin
  if (user.role !== 'practitioner') {
    return { allowed: false, reason: DENIAL_REASONS.UNAUTHORIZED_ROLE };
  }

  // 5. Handling create action
  if (action === 'create') {
    if (protocol && typeof protocol === 'object') {
      if (protocol.isStarter === true) {
        return { allowed: false, reason: DENIAL_REASONS.STARTER_CREATION_ADMIN_ONLY };
      }
      if (
        (protocol.ownerType && protocol.ownerType !== user.ownerType) ||
        (protocol.ownerId && protocol.ownerId !== user.ownerId)
      ) {
        return { allowed: false, reason: DENIAL_REASONS.FORBIDDEN_OWNERSHIP_MISMATCH };
      }
    }
    return { allowed: true, reason: null };
  }

  // 6. Protocol existence required for non-create actions
  if (!protocol || typeof protocol !== 'object') {
    return { allowed: false, reason: DENIAL_REASONS.PROTOCOL_NOT_FOUND };
  }

  // 7. Disabled protocols cannot be read or modified by non-admins
  if (protocol.status === 'disabled') {
    return { allowed: false, reason: DENIAL_REASONS.ADMIN_ONLY_DISABLED_PROTOCOL };
  }

  // 8. Starter templates (brand-owned templates)
  if (protocol.isStarter === true) {
    if (action === 'read' || action === 'duplicate') {
      return { allowed: true, reason: null };
    }
    return { allowed: false, reason: DENIAL_REASONS.STARTER_MODIFICATION_FORBIDDEN };
  }

  // 9. Ownership enforcement (Tag Mode: customer, B2B Mode: company)
  if (!user.ownerId || !user.ownerType) {
    return { allowed: false, reason: DENIAL_REASONS.FORBIDDEN_OWNERSHIP_MISMATCH };
  }

  if (protocol.ownerType !== user.ownerType || protocol.ownerId !== user.ownerId) {
    return { allowed: false, reason: DENIAL_REASONS.FORBIDDEN_OWNERSHIP_MISMATCH };
  }

  // 10. Archived protocols cannot be edited directly (must restore first)
  if (protocol.status === 'archived' && action === 'edit') {
    return { allowed: false, reason: DENIAL_REASONS.ARCHIVED_PROTOCOL_READ_ONLY };
  }

  return { allowed: true, reason: null };
}

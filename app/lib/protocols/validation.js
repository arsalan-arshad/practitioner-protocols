/**
 * Custom error class for protocol validation errors.
 */
export class ProtocolValidationError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {string} [field]
   */
  constructor(message, code, field) {
    super(message);
    this.name = 'ProtocolValidationError';
    this.code = code;
    this.field = field;
  }
}

const PII_FORBIDDEN_KEY_PATTERN = /(?:patient|client|ssn|health|medical|diagnosis|condition)/i;
const ALLOWED_STATUSES = new Set(['active', 'archived', 'disabled']);

/**
 * Validates protocol input for creation or updates.
 *
 * @param {any} input
 * @param {{ isUpdate?: boolean, isAdmin?: boolean }} [options]
 * @returns {{
 *   isValid: boolean,
 *   errors: Array<{ field: string, code: string, message: string }>,
 *   sanitized: {
 *     name?: string,
 *     introNote?: string,
 *     displayName?: string,
 *     status?: string,
 *     isStarter?: boolean,
 *     sourceProtocolId?: string | null,
 *     lines?: Array<{ variantGid: string, quantity: number, usageNote?: string }>
 *   } | null
 * }}
 */
export function validateProtocolInput(input, { isUpdate = false, isAdmin = false } = {}) {
  const errors = [];

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      isValid: false,
      errors: [{ field: 'input', code: 'INVALID_INPUT', message: 'Input must be a valid non-null object' }],
      sanitized: null
    };
  }

  // 1. Strict Privacy & PII Inspection: Reject any client/patient specific fields
  for (const key of Object.keys(input)) {
    if (PII_FORBIDDEN_KEY_PATTERN.test(key)) {
      errors.push({
        field: key,
        code: 'PII_NOT_ALLOWED',
        message: `Field '${key}' is not allowed. Protocols are generic and must never contain client or patient information.`
      });
    }
  }

  // 2. Name validation
  let sanitizedName;
  if (!isUpdate || input.name !== undefined) {
    if (typeof input.name !== 'string') {
      errors.push({ field: 'name', code: 'REQUIRED', message: 'Protocol name is required and must be a string' });
    } else {
      const trimmed = input.name.trim();
      if (trimmed.length < 1 || trimmed.length > 60) {
        errors.push({ field: 'name', code: 'INVALID_LENGTH', message: 'Protocol name must be between 1 and 60 characters' });
      } else {
        sanitizedName = trimmed;
      }
    }
  }

  // 3. Intro Note validation
  let sanitizedIntroNote = '';
  if (input.introNote !== undefined && input.introNote !== null) {
    if (typeof input.introNote !== 'string') {
      errors.push({ field: 'introNote', code: 'INVALID_TYPE', message: 'Intro note must be a string' });
    } else {
      const trimmed = input.introNote.trim();
      if (trimmed.length > 500) {
        errors.push({ field: 'introNote', code: 'INVALID_LENGTH', message: 'Intro note cannot exceed 500 characters' });
      } else {
        sanitizedIntroNote = trimmed;
      }
    }
  }

  // 4. Display Name validation
  let sanitizedDisplayName;
  if (input.displayName !== undefined && input.displayName !== null) {
    if (typeof input.displayName !== 'string') {
      errors.push({ field: 'displayName', code: 'INVALID_TYPE', message: 'Display name must be a string' });
    } else {
      const trimmed = input.displayName.trim();
      if (trimmed.length > 60) {
        errors.push({ field: 'displayName', code: 'INVALID_LENGTH', message: 'Display name cannot exceed 60 characters' });
      } else {
        sanitizedDisplayName = trimmed;
      }
    }
  }

  // 5. Status validation
  let sanitizedStatus = 'active';
  if (input.status !== undefined && input.status !== null) {
    if (typeof input.status !== 'string' || !ALLOWED_STATUSES.has(input.status.toLowerCase())) {
      errors.push({
        field: 'status',
        code: 'INVALID_STATUS',
        message: "Status must be one of: 'active', 'archived', 'disabled'"
      });
    } else {
      const normalizedStatus = input.status.toLowerCase();
      if (normalizedStatus === 'disabled' && !isAdmin) {
        errors.push({
          field: 'status',
          code: 'ADMIN_ONLY_STATUS',
          message: "The 'disabled' status can only be set or modified by a store administrator"
        });
      } else {
        sanitizedStatus = normalizedStatus;
      }
    }
  }

  // 6. Lines validation
  let sanitizedLines;
  if (!isUpdate || input.lines !== undefined) {
    if (!Array.isArray(input.lines)) {
      errors.push({ field: 'lines', code: 'INVALID_TYPE', message: 'Lines must be an array of product items' });
    } else if (input.lines.length < 1) {
      errors.push({ field: 'lines', code: 'MIN_ITEMS', message: 'Protocol must contain at least 1 product line' });
    } else if (input.lines.length > 20) {
      errors.push({ field: 'lines', code: 'MAX_ITEMS', message: 'Protocol cannot exceed 20 product lines' });
    } else {
      const seenVariants = new Set();
      const parsedLines = [];

      for (let i = 0; i < input.lines.length; i++) {
        const line = input.lines[i];
        const lineFieldPrefix = `lines[${i}]`;

        if (!line || typeof line !== 'object' || Array.isArray(line)) {
          errors.push({ field: lineFieldPrefix, code: 'INVALID_LINE', message: 'Line must be a non-null object' });
          continue;
        }

        // Variant GID
        if (typeof line.variantGid !== 'string' || !line.variantGid.trim()) {
          errors.push({
            field: `${lineFieldPrefix}.variantGid`,
            code: 'REQUIRED',
            message: 'Variant GID is required'
          });
        } else {
          const trimmedGid = line.variantGid.trim();
          if (seenVariants.has(trimmedGid)) {
            errors.push({
              field: `${lineFieldPrefix}.variantGid`,
              code: 'DUPLICATE_VARIANT',
              message: `Variant '${trimmedGid}' is duplicated. A protocol cannot include duplicate variants.`
            });
          } else {
            seenVariants.add(trimmedGid);
          }
        }

        // Quantity (1 to 10 integer)
        const qty = line.quantity;
        if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1 || qty > 10) {
          errors.push({
            field: `${lineFieldPrefix}.quantity`,
            code: 'INVALID_QUANTITY',
            message: 'Quantity must be an integer between 1 and 10'
          });
        }

        // Usage Note (optional, max 200 chars)
        let usageNote = '';
        if (line.usageNote !== undefined && line.usageNote !== null) {
          if (typeof line.usageNote !== 'string') {
            errors.push({
              field: `${lineFieldPrefix}.usageNote`,
              code: 'INVALID_TYPE',
              message: 'Usage note must be a string'
            });
          } else {
            const trimmedNote = line.usageNote.trim();
            if (trimmedNote.length > 200) {
              errors.push({
                field: `${lineFieldPrefix}.usageNote`,
                code: 'INVALID_LENGTH',
                message: 'Usage note cannot exceed 200 characters'
              });
            } else {
              usageNote = trimmedNote;
            }
          }
        }

        if (errors.length === 0 || errors.every(e => !e.field.startsWith(lineFieldPrefix))) {
          parsedLines.push({
            variantGid: line.variantGid ? line.variantGid.trim() : '',
            quantity: typeof qty === 'number' ? qty : 1,
            usageNote
          });
        }
      }

      if (parsedLines.length === input.lines.length) {
        sanitizedLines = parsedLines;
      }
    }
  }

  if (errors.length > 0) {
    return {
      isValid: false,
      errors,
      sanitized: null
    };
  }

  const sanitized = {
    ...(sanitizedName !== undefined && { name: sanitizedName }),
    introNote: sanitizedIntroNote,
    ...(sanitizedDisplayName !== undefined && { displayName: sanitizedDisplayName }),
    status: sanitizedStatus,
    ...(input.isStarter !== undefined && { isStarter: Boolean(input.isStarter && isAdmin) }),
    ...(input.sourceProtocolId !== undefined && { sourceProtocolId: input.sourceProtocolId || null }),
    ...(sanitizedLines !== undefined && { lines: sanitizedLines })
  };

  return {
    isValid: true,
    errors: [],
    sanitized
  };
}

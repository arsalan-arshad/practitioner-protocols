# M1 Contract — Pure Engine & Protocol Core

_Written 2026-10-21. Implements BUILD_PLAN M1 / SPEC §2, §5, §6, §9. If this file and SPEC disagree, SPEC wins for intent and this file wins for exact runtime shapes._

**M1 Done =** `npm test` passes all unit tests for token generation, input validation, permission enforcement, cart payload construction, QR generation, and order attribution parsing. Zero network calls, zero external test dependencies, zero mutations of input data, and zero client PII accepted or stored.

---

## 1. Conventions & Limits

- **Tokens:** URL-safe string, minimum 16 characters, alphanumeric characters only (`[A-Za-z0-9]`). Generated using `crypto.randomBytes`.
- **Protocol Limits:**
  - Name: string, required, trimmed length 1 to 60 characters.
  - Intro note: string, optional, trimmed length max 500 characters.
  - Lines: array of items, 1 to 20 items.
  - Variant ID: string, required, must be non-empty and unique within a single protocol.
  - Quantity per line: integer, 1 to 10. Non-integers rejected.
  - Usage note: string, optional, trimmed length max 200 characters.
  - Display name: string, optional, max 60 characters.
  - Statuses: `'active'`, `'archived'`, `'disabled'` (only admin can set or edit `'disabled'`).
- **Privacy & PII Barrier:**
  - Any attempt to pass client-identifying fields (`patientName`, `clientEmail`, `clientPhone`, `diagnosis`, `ssn`) is strictly rejected with a `PII_NOT_ALLOWED` validation error.

---

## 2. Share Tokens (`app/lib/protocols/token.js`)

```javascript
// Generates a cryptographically strong, URL-safe random token (default 16 chars)
export function generateShareToken(length = 16) -> string

// Checks if a token conforms to the URL-safe regex ^[A-Za-z0-9_-]{16,64}$
export function isValidShareToken(token) -> boolean
```

---

## 3. Protocol Validation (`app/lib/protocols/validation.js`)

```javascript
export class ProtocolValidationError extends Error {
  constructor(message, code, field) { ... }
}

// Validates full protocol payload (for create or update)
export function validateProtocolInput(input, { isUpdate = false, isAdmin = false } = {}) -> {
  isValid: boolean,
  errors: Array<{ field: string, code: string, message: string }>,
  sanitized: object | null
}
```

Validation Rules:
1. `name`: trimmed, length between 1 and 60.
2. `introNote`: trimmed, length <= 500.
3. `lines`: array between 1 and 20 items. No duplicate variant IDs.
4. Each line: `variantGid` non-empty string, `quantity` integer 1..10, `usageNote` trimmed <= 200.
5. If `status === 'disabled'` and `!isAdmin`, throw/return `ADMIN_ONLY_STATUS`.
6. Disallowed fields: any object key matching `/patient|client|ssn|health|medical|diagnosis/i` returns `PII_NOT_ALLOWED`.

---

## 4. Permissions & Authorization Guard (`app/lib/protocols/permissions.js`)

```javascript
// user context:
// { id: string, role: 'admin' | 'practitioner', ownerType: 'customer' | 'company', ownerId: string }
// protocol record:
// { id: string, ownerType: 'customer' | 'company', ownerId: string, isStarter: boolean, status: string }
// action: 'read' | 'create' | 'edit' | 'archive' | 'restore' | 'duplicate' | 'delete'

export function canAccessProtocol(user, protocol, action) -> {
  allowed: boolean,
  reason: string | null
}
```

Rules:
1. Admins (`user.role === 'admin'`) have full access across all protocols.
2. If `protocol.status === 'disabled'`, non-admins cannot access or modify it.
3. If `protocol.isStarter === true`:
   - Practitioners can `read` and `duplicate`.
   - Practitioners **cannot** `edit`, `archive`, `restore`, or `delete` starters (starters are brand-owned templates).
4. Ownership match:
   - For Tag Mode: `protocol.ownerType === 'customer' && protocol.ownerId === user.ownerId`.
   - For Company Mode: `protocol.ownerType === 'company' && protocol.ownerId === user.ownerId`.
   - Any cross-owner access is denied (`FORBIDDEN_OWNERSHIP_MISMATCH`).

---

## 5. Cart Payload & Order Attribution (`app/lib/protocols/attribution.js`)

```javascript
// Constructs the POST /cart/add.js payload for 1-tap "Add all to cart"
export function buildCartAddPayload({ protocol, availableVariantIds = [] }) -> {
  items: Array<{
    id: string | number, // numeric variant id or gid
    quantity: number,
    properties: {
      _protocol_token: string,
      _protocol_id: string,
      _protocol_usage?: string
    }
  }>,
  skippedLines: Array<{ variantGid: string, reason: string }>
}

// Parses an orders/paid webhook line items to extract protocol attribution
export function extractAttributionFromOrder(order) -> Array<{
  protocolToken: string,
  protocolId: string,
  lineItemGid: string,
  variantGid: string,
  quantity: number,
  priceMinor: number // price in cents/minor units
}>

// Increments aggregate monthly stats (pure calculation)
export function aggregateMonthlyStats(currentStat, newAttributions) -> {
  ordersIncrement: number,
  unitsIncrement: number,
  revenueMinorIncrement: number
}
```

---

## 6. Print Handout & QR Generator (`app/lib/protocols/handout.js`)

```javascript
// Pure vector QR SVG generator (no network, zero native binaries)
export function generateQrSvg(text, { size = 200 } = {}) -> string

// Builds self-contained, print-ready CSS/HTML for US Letter / A4
export function renderHandoutHtml({ protocol, practiceName, shareUrl, qrSvg }) -> string
```

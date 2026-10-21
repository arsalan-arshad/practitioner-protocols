# Practitioner Protocols

Open-source (MIT) Shopify app: professionals share reusable product "protocols" by link or QR, clients add everything to cart in one tap at retail price, and the brand sees aggregate attribution by practice and protocol.
Start with `README.md`; details in `docs/SPEC.md`, `docs/BUILD_PLAN.md` and `docs/M1_CONTRACT.md`.
Read `PROJECT_CONTEXT.md` for current state, open decisions, and append-only session logs.

## Hard rules
- Clean-room design: this is a general-purpose portfolio app for any brand selling through professionals (dermatology, physical therapy, vet, fitness, salon). Never reference or name any client.
- Privacy by design: no client-identifying data (name, email, phone, medical records) is ever accepted, stored, or transmitted. Attribution is strictly aggregate monthly counters.
- Deterministic core: pure functions for token generation, protocol validation, permission checks, cart payload construction, and attribution parsing.
- Backend-enforced authorization: permission checks live in the backend service, never only in the UI. Cross-owner access must be rejected.
- Minimal scopes: request only read-only scopes needed. Any write scope or new scope requires explicit justification and owner sign-off.
- README/docs claim only what exists. CI gates only on checks that really run.
- Never print or commit secrets; reference variable names only.
- ASK the owner before: commit, push, tag, deploy, release, open/merge a PR, submit for review.
- Never touch `../salesforce`.
- One public contact email: arsalanarshad.dev@gmail.com.

## Code conventions
- ESM, plain `.js` with Node native test runner (`node --test`).
- Zero external dependencies for pure engine modules.
- Tests live in `test/` and run via `npm test`.
- Clean error classes and immutable function outputs.

## Session end
After material progress, update `docs/BUILD_PLAN.md` and append a numbered section to `PROJECT_CONTEXT.md`.

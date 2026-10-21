# Contributing to practitioner-protocols

Thanks for your interest! This project is **open source (MIT)** and currently at the
**blueprint stage** — the spec in `README.md` and `docs/` is the thing to review.

## Right now (before code exists)
- Open an issue for spec feedback, missing edge cases, or better approaches.
- Challenge the open decisions listed in `PROJECT_CONTEXT.md` — that is the most useful input.

## Once code lands
- Open an issue first for anything beyond a small fix.
- Keep PRs focused: one feature or fix per PR; branch names `feat/<short>` or `fix/<short>`.
- Only claim checks that are really wired up. CI, lint and tests will be added with the first
  implementation commit; the README's Verification section will list the real commands.
- Never commit secrets. `.env` is git-ignored; document every variable in `.env.example`.
- Protocols must never contain client or patient-identifying data. No field anywhere may accept it.
- Permission checks live in the backend, never only in the UI.
- Security-sensitive changes (auth, webhooks, token storage, permissions) get extra scrutiny.

See also the portfolio-level guide: `../CONTRIBUTING.md`.

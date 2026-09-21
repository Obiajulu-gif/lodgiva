## What and why

<!-- What changes, and the reason for it. Link the issue or register entry (L-xx). -->

## How it was checked

<!-- Tests run, and what you did by hand. Name the commands:
     pnpm test:unit · pnpm --filter lodgiva lint · pnpm check:migrations -->

## Documentation (same PR, not later)

See [docs/README.md → Keeping these documents true](../docs/README.md#keeping-these-documents-true).
Tick what applies, and delete the rest:

- [ ] **CHANGELOG.md** has a line under *Unreleased* (anything user-visible)
- [ ] **docs/CONFIGURATION.md**: a new or changed environment variable
- [ ] **docs/ARCHITECTURE.md**: a new module, route, model, job or request path (and `pnpm openapi` re-run)
- [ ] **docs/deploy-vercel.md**: a build, Vercel setting or runtime change
- [ ] **deploy/README.md** / PMS READMEs: installer, router or PMS change
- [ ] **docs/LODGIVA_ISSUE_REGISTER.md**: a defect found or fixed
- [ ] Nothing here needs documenting, because: <!-- say why -->

## Risk

- [ ] Touches money, permissions or tenant isolation. A second reviewer is needed
- [ ] Changes the database schema. The migration is **additive** and has been run against production **before** merging
- [ ] No secrets, connection strings or real guest data in the diff or the description

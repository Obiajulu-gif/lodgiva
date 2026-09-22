# Lodgiva documentation

The home page for everything written about Lodgiva. It's organised by
**what you're trying to do**, following the [Diátaxis](https://diataxis.fr)
framework:

- **Tutorials** to learn by doing
- **How-to guides** for a specific task
- **Reference** to look something up
- **Explanation** to understand why

New here? Read the [project README](../README.md), then
[ARCHITECTURE.md](ARCHITECTURE.md).

---

## Tutorials: get it running

| Document | Takes you from → to |
|---|---|
| [deploy-vercel.md](deploy-vercel.md) | Nothing → the landing page, sign-up, dashboard and API live on Vercel |
| [deploy/README.md](../deploy/README.md) | A blank Ubuntu server → the Lodgiva PMS with HTTPS, in one command |
| [LODGIVA_PMS_DEPLOYMENT.md](LODGIVA_PMS_DEPLOYMENT.md) | A Windows laptop → a shareable PMS demo over Cloudflare Tunnel |
| [LOCAL_DATABASE_SETUP.md](LOCAL_DATABASE_SETUP.md) | A developer machine → a local PostgreSQL for tests |

## How-to guides: do one thing

| Task | Document |
|---|---|
| Set up the Neon database and its two roles | [NEON_DEPLOYMENT.md](NEON_DEPLOYMENT.md) |
| Run the API as a standalone server instead of serverless | [deploy-render.md](deploy-render.md) |
| Host the PMS on Oracle, Hetzner, DigitalOcean… | [deploy/README.md](../deploy/README.md), [deploy/oracle/README.md](../deploy/oracle/README.md) |
| Operate it: backups, restores, incidents, rate limits | [LODGIVA_OPERATIONS.md](LODGIVA_OPERATIONS.md), [operations.md](operations.md) |
| Walk a hotel through acceptance testing | [uat-script.md](uat-script.md) |
| Check a deployment's environment | [DEPLOYMENT_ENVIRONMENT_GUIDE.md](DEPLOYMENT_ENVIRONMENT_GUIDE.md) |

## Reference: look it up

| Document | Contents |
|---|---|
| [CONFIGURATION.md](CONFIGURATION.md) | **Every environment variable**: default, required or not, where it's read |
| [api-reference.md](api-reference.md), [openapi.json](openapi.json) | The HTTP API: 155 paths, 184 operations |
| [ARCHITECTURE.md §14](ARCHITECTURE.md#14-data-model) | The 55 data models, grouped |
| [technical-specification.md](technical-specification.md) | The original product specification |
| [LODGIVA_ISSUE_REGISTER.md](LODGIVA_ISSUE_REGISTER.md) | Every known defect, with its state and evidence |
| [CHANGELOG.md](../CHANGELOG.md) | What changed, release by release |

## Explanation: understand why

| Document | Question it answers |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | **How does Lodgiva work, end to end?** |
| [adr/ADR-001-kamra-fork-evaluation.md](adr/ADR-001-kamra-fork-evaluation.md) | Why build the PMS on Kamra, and on what conditions |
| [LODGIVA_GAP_MATRIX.md](LODGIVA_GAP_MATRIX.md) | What Kamra does and doesn't do, verified on a live site |
| [LODGIVA_IMPLEMENTATION_PLAN.md](LODGIVA_IMPLEMENTATION_PLAN.md) | The plan, milestones and what's left |
| [LODGIVA_VERIFICATION.md](LODGIVA_VERIFICATION.md) | How each claim was checked |
| [implementation-status.md](implementation-status.md), [DASHBOARD_READINESS.md](DASHBOARD_READINESS.md), [audit/](audit/) | Earlier status snapshots and audits, kept for history. **Newer documents win where they disagree** |

---

## Keeping these documents true

Documentation that's out of date is worse than none, because people act on
it. These rules apply to every change, from anyone, and to Claude when it
works on this repository.

**1. Documentation ships in the same pull request as the change.** If a PR
changes behaviour, configuration, deployment or the data model, it updates:

| If the change… | Update |
|---|---|
| Adds, fixes or removes anything user-visible | [CHANGELOG.md](../CHANGELOG.md), under **Unreleased** |
| Reads a new environment variable, or changes a default | [CONFIGURATION.md](CONFIGURATION.md) |
| Adds a module, route, model or background job, or changes the request path | [ARCHITECTURE.md](ARCHITECTURE.md), and regenerate `openapi.json` with `pnpm openapi` |
| Changes the build, the Vercel settings or what runs on Vercel | [deploy-vercel.md](deploy-vercel.md) |
| Changes the PMS, the installer or the router | [deploy/README.md](../deploy/README.md), and the PMS repo READMEs |
| Finds or fixes a defect | [LODGIVA_ISSUE_REGISTER.md](LODGIVA_ISSUE_REGISTER.md) |

The pull request template has a checklist for this.

**2. Numbers are counted, not remembered.** Test counts, module counts, route
counts and model counts are measured from the code when a document is
edited, and the document records the date it was **last verified against
code**.

**3. Say what doesn't work.** Every guide has a limitations section.
Features that are planned but not built are labelled that way, never
described as if they exist.

**4. One source of truth per fact.** Link rather than copy. When two documents
disagree, fix the older one, or mark it as history as the table above does.

**5. Never put a secret in a document.** Use placeholders such as
`<password>`. Real connection strings, keys and passwords belong in the host's
secret store only.

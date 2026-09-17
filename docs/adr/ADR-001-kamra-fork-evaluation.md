# ADR-001 · Whether to replace Lodgiva's operational core with a Kamra PMS fork

- **Status:** Proposed — **awaiting a decision from Domain-Plus**
- **Date:** 2026-09-17
- **Context:** `Lodgiva_Kamra_Revamp_Master_Prompt_and_Plan.md` (17 Sep 2026)
- **Decision owner:** Domain-Plus International Ltd (this is a business decision, not an engineering one)

The revamp plan proposes forking Kamra PMS, rebranding it as Lodgiva PMS, and
retiring the existing NestJS/Prisma stack. The plan's own working rules require
discovery before coding, and require stopping to report any licence blocker.
This ADR is that report. **No code has been changed.**

---

## 1. Audit — verified, not assumed

### Kamra PMS

Read from the GitHub API on 2026-09-17, not from the plan document:

| Fact | Value |
| --- | --- |
| Licence | **AGPL-3.0** |
| Repository created | **2026-07-04** |
| Last push | 2026-09-17 (actively worked on) |
| Default branch | `develop` |
| Latest release | v2.6.0 |
| Stars / forks / watchers | 37 / 19 / **2** |
| Open issues | 2 |
| Description | "…front desk, booking engine, folios & **GST/tax billing**, housekeeping, POS, WhatsApp. Agent-ready via MCP." |

Two things the plan does not state:

- **The project is ten weeks old.** The plan describes pinning "a stable Kamra
  release"; v2.6.0 is ten weeks of work, not a matured baseline.
- **Two subscribers.** Forks and stars can come from anywhere; two watchers is
  the sharper signal of how many people are tracking its development.

"GST/tax billing" in the project's own one-line description confirms the plan's
concern about India-specific assumptions — it is not incidental, it is in the
product's summary of itself.

### Existing Lodgiva

| Fact | Value |
| --- | --- |
| Licence file | **None** |
| `package.json` license field | **Absent**; `private: true` |
| API source | ~17,400 lines of TypeScript across 29 modules |
| Data model | 55 Prisma models, 2 PostgreSQL migrations |
| Tests | 14 unit suites, 13 integration suites |

No licence file means no grant to anyone else by default. That is unproblematic
for the owner's own use, but it has to be settled before combining with
AGPL-covered code, and the plan is right to flag it.

---

## 2. The licence question, stated plainly

AGPL-3.0 §13 requires that users interacting with a modified covered work
**over a network** be offered the complete corresponding source of that
modified version.

Lodgiva PMS would be exactly that: a modified Kamra, reached over a network by
hotel staff. So the obligation is not theoretical or deferrable:

- The corresponding source of the Lodgiva fork — including
  `lodgiva_nigeria`, if it is a derivative rather than a genuinely separate
  work — must be offered to every hotel using it.
- A competitor could obtain it and run their own service.
- Rebranding changes nothing about this.

The plan says "obtain legal review before commercial launch." That is correct
but understates the sequencing: **this determines whether the business model
works at all**, so it belongs before the engineering, not before launch. If
Domain-Plus intends a proprietary hosted SaaS, this is the decision that
settles the architecture.

There is a legitimate answer in which the AGPL is fine — an open-core or
source-available Lodgiva, or one whose value is hosting, support and the
Nigeria pack rather than secrecy. That is a strategy choice, and it is theirs.

---

## 3. What the plan is right about

Not everything here is a caution. The plan's central technical claim is sound:

**Kamra's React dashboard cannot be pointed at Lodgiva's NestJS API.** It is
built against Frappe DocTypes, permissions, whitelisted methods and realtime
events. Copying the interface alone would mean rebuilding Kamra's backend
contracts — two sources of truth, and the worst of both. If the goal is
Kamra's interface, taking Kamra whole is the right way to get it.

The repository strategy, the upstream-tracking discipline, the
`lodgiva_nigeria` app for upgrade-safe overrides, the API-based migration
rather than direct SQL, and the reconciliation gates are all good practice.

---

## 4. What is being given up

| Capability in the current system | Notes |
| --- | --- |
| Row-level security per tenant | PostgreSQL RLS with a restricted application role |
| MFA (TOTP, RFC 6238) | Verified against the RFC test vectors |
| Append-only folio ledger | Corrections are reversals; immutability is enforced, not documented |
| Versioned tax rules with effective dates | Historical documents are not recomputed from current settings |
| Night audit with blockers/warnings | Business date advances only through it |
| Concurrency-safe inventory | Unique-index slot allocation, not check-then-act |
| Audit trail | Every state change, including support lookups |

Kamra may provide equivalents — that is what the gap matrix in
`docs/LODGIVA_GAP_MATRIX.md` is for — but "may" is the operative word until
each one is verified against a running instance. Several of these were only
made correct in the last two weeks (see `LODGIVA_ISSUE_REGISTER.md`), so the
knowledge of *why* they are shaped that way is recent and worth carrying over
regardless of which stack wins.

---

## 5. Concentration risk

Betting the operational product on a ten-week-old project with two watchers is
the part of this plan that deserves the most scrutiny. Mitigations exist and
the plan already names some:

- The fork is owned by Domain-Plus; upstream disappearing does not delete it.
- AGPL guarantees the source stays available.

But the realistic failure mode is not deletion. It is that upstream stalls or
diverges, and Domain-Plus ends up maintaining an unfamiliar Frappe application
without the author. That requires Frappe/Python/MariaDB capability on the team
— a different stack from the current Next.js/NestJS/PostgreSQL one.

---

## 6. Options

| Option | What it means | Best when |
| --- | --- | --- |
| **A — Adopt the plan** | Fork Kamra, build `lodgiva_nigeria`, migrate, retire NestJS | AGPL is acceptable, Frappe skills exist or will be hired, speed to a broad feature set beats control |
| **B — Evaluate first** | Run the plan's §8 vertical slice on a throwaway bench; decide with evidence | The decision is genuinely open — **recommended** |
| **C — Keep the current stack** | Continue the phased plan in `LODGIVA_IMPLEMENTATION_PLAN.md` | A proprietary model matters, or the team is Node-shaped |
| **D — Hybrid** | Keep Lodgiva for finance/tenancy, take specific Kamra ideas | Usually the worst of both; two sources of truth |

**Recommendation: B.** The plan's own first sprint is a vertical slice for
exactly this reason — it exposes localisation, licence and skills risk before
anything is retired. Do that slice, then decide A or C with evidence rather
than on either document's say-so. Nothing about the current system needs to be
dismantled to run it.

---

## 7. Blockers to starting today

| Blocker | Detail |
| --- | --- |
| **WSL2 will not start** | `Wsl/Service/CreateInstance/CreateVm/0x800705b4`, and once `ConfigureNetworking/E_UNEXPECTED` falling back to `networkingMode None`. Ubuntu-24.04 is installed but unusable. |
| **Docker unavailable** | Docker Desktop runs on WSL2, so it fails for the same reason — also why the previous cycle's integration tests remain unverified. |
| **No bench toolchain** | No MariaDB, Redis or `bench`. Host Python is 3.14.2, likely ahead of the pinned Frappe v16 range. |

A Frappe bench needs Linux. On this machine that means repairing WSL2 —
probably a reboot, and checking Hyper-V / Virtual Machine Platform features.
Virtualization itself is present (`HypervisorPresent: True`), so the hardware
is not the problem.

Until then, Phase 1 of the revamp cannot begin, and neither can the isolated
PostgreSQL the previous cycle needed. **Repairing WSL2 unblocks both.**

---

## 8. Consequences

**If A is chosen:** the AGPL source-offer obligation must be designed in from
the first commit, not retrofitted. Financial correctness in Kamra must be
verified to the same standard the current register applies to Lodgiva — an
unverified ledger is not safer because someone else wrote it.

**If C is chosen:** `LODGIVA_IMPLEMENTATION_PLAN.md` Phase 2 onward stands, and
Kamra remains a useful reference for the interface.

**Either way:** the landing page is retained and independently deployed, the
existing PostgreSQL data is preserved read-only until reconciliation, and
nothing is deleted before UAT sign-off.

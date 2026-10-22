# Subscription lifecycle — design

**Status:** approved for planning
**Scope:** sub-project #1 of 4 (customer & plan model, subscription state machine,
enforcement). Paystack billing is #3 and has its own spec; this document never
calls a payment processor.

---

## Intent

Lodgiva sells hotel management software to Nigerian hotels on a subscription.
This subsystem decides, for every hotel, whether its site is fully usable,
restricted, or free — and makes that decision survive a bill going unpaid
without ever taking a hotel's operations offline mid-stay.

A hotel is not a web app. When a bill lapses there are guests physically in the
building, and a front desk that cannot check them out is a worse outcome than an
unpaid invoice. Every decision below follows from that.

**Success:** an operator can put a hotel on a plan, a trial expires without
anyone intervening, an unpaid hotel is restricted on a schedule the customer was
warned about, and no billing state ever destroys data.

---

## Decisions already taken

| Decision | Value |
|---|---|
| Billing unit | One hotel = one subscription. No Customer entity. |
| Trial | 15 days |
| Free tier | 1 user, 10 rooms, core PMS only |
| `unpaid` behaviour | Read-only PMS, booking engine off |
| Trial expiry | Drops to free; over-limit data goes read-only, never deleted |
| Grace period | Configurable 7–14 days, default 14 |
| Suspension notice | At least 72 hours before restriction |
| Retry schedule | Days 1/3/5/7 — **belongs to #3**, not here |

---

## 1 · Data model

Two new DocTypes in `lodgiva_control`.

### `Subscription Plan`

| Field | Type | Notes |
|---|---|---|
| `plan_code` | Data, unique | `FREE`, `STARTER`, `GROWTH` |
| `plan_name` | Data | Shown to operators |
| `monthly_price` | Currency | NGN. `0` for free |
| `max_users` | Int | `0` means unlimited |
| `max_rooms` | Int | `0` means unlimited |
| `allowed_modules` | Small Text | Comma-separated module ids from the PMS launcher |
| `booking_engine` | Check | Whether `/book` sells |
| `is_free` | Check | Exactly one plan carries this |

`0 = unlimited` rather than a null, so every limit check is the same integer
comparison and there is no "missing means infinite" ambiguity.

### `Hotel Subscription`

| Field | Type | Notes |
|---|---|---|
| `hotel_environment` | Link → Hotel Environment, unique | One per hotel |
| `plan` | Link → Subscription Plan | |
| `state` | Select | `trialing`, `active`, `past_due`, `unpaid`, `free`, `cancelled`, `paused` |
| `trial_ends_on` | Date | Set at creation, `today + 15` |
| `grace_ends_on` | Date | Set when entering `past_due` |
| `suspend_notice_sent_on` | Datetime | Read by the 72-hour guard |
| `access_mode` | Select, read-only | `full`, `read_only` — the computed result |
| `state_log` | Code, read-only | Append-only record of every transition and why |

**`state` is not `status`.** `Hotel Environment.status` already means *is the
site built* (`Draft` → `Provisioning` → `Active` → `Failed`). A hotel can be
`Active` and `unpaid` at the same time. Conflating them would make "provisioned
but restricted" inexpressible, which is the single most common real state.

---

## 2 · State machine

```
                  ┌──────────── payment succeeds ───────────┐
                  │                                          │
  trialing ──15d──┴─→ free                                   │
     │                  ↑                                    │
     │ pays             │ (over-limit ⇒ read_only)           │
     ↓                  │                                    │
  active ──payment fails──→ past_due ──grace expires──→ unpaid
     │                         │                         │
     │                         └──── pays ───────────────┘
     ↓
  cancelled / paused
```

| State | Access | Meaning |
|---|---|---|
| `trialing` | full | First 15 days. Paid-tier features. |
| `active` | full | Paying. |
| `past_due` | **full** | Payment failed; customer is fixing it. Grace running. |
| `unpaid` | read_only | Grace expired, notice served. |
| `free` | full, or read_only if over limits | Permanent free tier. |
| `cancelled` | read_only | Customer left. Data retained. |
| `paused` | read_only | Operator-initiated hold. |

**`past_due` deliberately keeps full access.** The customer's card failed; the
hotel has not done anything wrong. Restriction waits for grace to expire *and*
for notice to have been served.

Transitions are computed by one scheduled job, `evaluate_subscriptions`, running
daily. Nothing sets `state` by hand except an operator pausing or cancelling.
Every transition appends to `state_log` with a timestamp and a reason — when a
hotel asks why it was restricted, the answer is in the record.

Two whitelisted entry points exist for #3 to call, and nothing else:
`mark_payment_succeeded(subscription)` and `mark_payment_failed(subscription)`.

---

## 3 · Enforcement

One value, written by the control site into each hotel's `site_config.json`:

```
lodgiva_access_mode = "full" | "read_only"
```

`evaluate_subscriptions` computes it and writes it with
`bench --site <site> set-config`. The hotel's own site never computes billing
state and never contacts the control site to ask. If the control plane is down,
every hotel keeps running on its last known mode.

In `kamra`, a single guard on the document write path rejects inserts and
updates when `access_mode == "read_only"`, with a message naming the reason and
what to do. Exempt, always:

- reading anything,
- checking out an in-house guest and settling their folio,
- the payment and subscription screens themselves.

A hotel in read-only can still finish serving the guests already in its rooms.
It cannot take new business. That is the whole point: the pain is commercial,
never operational.

`booking_engine` is enforced separately — `/book` stops selling whenever the
plan says so or access is read-only, independent of the write guard.

**Free-tier limits use the same path.** A free hotel over `max_rooms` or
`max_users` gets `read_only`, identical to `unpaid`. One mechanism, one set of
tests, one behaviour for a customer to learn.

---

## 4 · Notice and grace

- Entering `past_due` sets `grace_ends_on = today + grace_days` (site config
  `lodgiva_grace_days`, default 14, clamped to 7–14).
- Before any transition into `unpaid`, the job requires
  `suspend_notice_sent_on` to be at least 72 hours old.
- If notice has not been sent, the job sends it and **leaves the subscription in
  `past_due`**, regardless of grace. Restriction waits for the next run.

The 72-hour rule is enforced by the job refusing to act, not by an operator
remembering. A policy that depends on discipline is not a policy.

---

## 5 · Seams for Paystack (#3)

This spec builds no integration. It exposes:

- `mark_payment_succeeded(subscription)` → `active`, clears grace and notice
- `mark_payment_failed(subscription)` → `past_due` if currently `active`, sets grace
- `Subscription Plan.monthly_price` and `plan_code`, for #3 to map onto
  processor-side plans

Retry timing (days 1/3/5/7), webhooks, invoices and receipts live entirely in
#3. Nothing here knows a processor exists.

---

## 6 · Testing

Table-driven, against a frozen clock.

- Every transition in the state machine, including the ones that must *not*
  happen: `past_due → unpaid` without notice, `trialing → unpaid`.
- The 72-hour guard: notice 71 hours old does not restrict; 73 hours does.
- Grace clamping: configured 3 → 7, configured 30 → 14.
- Over-limit free produces exactly the same `access_mode` as `unpaid`.
- The write guard blocks a new reservation and permits a checkout of an
  in-house guest.
- **No billing state deletes a record.** Asserted directly: row counts for
  Room, Reservation, Guest and Folio are unchanged across every transition.

---

## Out of scope

Payment processing, invoices, receipts, dunning emails, proration, annual
billing, multi-property customers, usage metering, self-serve signup. Each is a
later sub-project; none changes the model above.

## Known gaps to resolve during planning

- Exact plan tiers and NGN prices beyond `FREE` — needed before `Subscription
  Plan` records can be seeded.
- Which PMS launcher module ids belong in `allowed_modules` for the free tier.
  The nine ids exist in `kamra/frontend/src/lib/apps.ts`; the free set is
  front-desk, housekeeping and guests, and should be confirmed against that file
  when the task is written.

# Lodgiva operations guide

For the people running a hotel on Lodgiva, and for whoever supports them.
Written in the language of the front desk, not the database.

For infrastructure runbooks (backups, WAF, SLOs) see `docs/operations.md`.

---

## 1. Setting up a new hotel

1. **Create the account** at `/signup`. You give your name, work email, a
   password, your hotel's name and its timezone. That makes you the owner and
   creates your first property.
2. **Add room types** in Settings → Room types: a code, a name, how many
   people it sleeps, and its standard nightly rate.
3. **Add rooms** in Settings → Rooms: room number, floor, and which type it is.
4. **Set your billing rules** in Settings → Taxes before you take a booking.
   This matters — see §2.
5. **Invite your staff** in Settings → Team, choosing a role for each.

### What each role can do

| Role | Can | Cannot |
| --- | --- | --- |
| Owner | Everything operational: bookings, check-in, charges, payments, checkout, housekeeping, settings, staff | Open, take and close a cash drawer alone |
| General manager | The same, plus approvals and cash variance | — |
| Front desk | Bookings, check-in/out, charges, payments, cash shifts | Settings, staff, refunds |
| Housekeeping | See and update room cleaning work | Anything to do with money or bookings |
| Finance | Reports, refunds, tax settings, exports | Check-in, room operations |
| Auditor | Read everything | Change anything |

An owner running reception alone is a supported way to work: the owner role
carries the front-desk permissions. Cash-drawer shifts are the exception —
one person opening, taking and closing their own drawer removes the only
check on it, so give that to a second person.

---

## 2. Billing rules — set these before your first booking

Lodgiva bills in kobo and shows naira. Two different things are often
confused:

- **Government tax** (VAT) — what you collect on behalf of the state.
- **Service charge** — your own charge, which is not a tax.

Each rule is **inclusive** or **exclusive**:

| Basis | Means | Room quoted ₦107,500 at 7.5% |
| --- | --- | --- |
| Inclusive | The tax is already inside the price you quote | Guest pays **₦107,500** — ₦100,000 room, ₦7,500 VAT |
| Exclusive | The tax is added to the price you quote | Guest pays **₦115,562.50** |

Until you configure rules, Lodgiva applies documented Nigerian defaults (5%
service charge, 7.5% VAT) so billing works on day one. **This is a starting
assumption, not advice** — confirm your own obligations and set your rules
explicitly. A known gap: a property that has deliberately configured *no*
service charge is not yet distinguishable from one that has configured
nothing (issue L-23).

---

## 3. A normal day

**Morning** — Overview shows today's arrivals, departures and rooms needing
cleaning. Housekeeping picks tasks off the board.

**Check-in** — Reservations → the booking → *Check in*. Pick a room; the list
shows each room's cleaning state. Assigning a dirty room needs an override,
and that override is recorded against your name.

**During the stay** — Open the booking's folio to add charges. Every charge
shows its service charge and VAT as separate lines that add up to the total.

**Taking payment** — In the folio, *Record payment*:

| Method | What to enter | When |
| --- | --- | --- |
| Cash | Amount | You have counted it into the drawer |
| Bank transfer | Amount + the narration or sender | You have seen it land in the account |
| POS terminal | Amount + the slip number | You have the printed slip |

**A screenshot is not a payment.** Record a transfer only once you can see it
in the account. The narration is what lets you match it on the statement
later.

Card and payment-link collection is **not available** in this build. It was
previously offered but did not verify anything — typing any reference marked
the folio paid. It has been removed rather than left looking functional, and
returns when gateway credentials are configured (§6).

**Check-out** — Reservations → *Check out*. Lodgiva posts the nights stayed
and refuses if anything is owed, telling you the amount. That amount now
appears on the folio, so you can take the payment and check out. A manager can
authorise checkout with a balance outstanding when a company is being invoiced.

**Closing the day** — Night audit posts the night's room charges, snapshots
the day's figures and moves the business date forward. It refuses while
anything is unfinished and names each item: open cash drawers, open restaurant
orders, undecided voids. Warnings — a guest due to leave who is still in house
— must be acknowledged, not ignored.

The business date is the hotel's own day. It moves only when night audit runs,
which is why last night's arrivals still count as last night's even at 2am.

---

## 4. When a payment does not arrive

| Situation | What to do |
| --- | --- |
| Guest says they transferred, nothing in the account | Do not record it. Leave the folio open. Record it when it lands. |
| Money arrived, no booking matches | Do not invent a booking. Note the reference and raise it with your manager. |
| Charged the wrong folio | Reverse the entry — never delete it — and post it correctly. Both lines stay visible, which is what makes the correction auditable. |
| Guest disputes a charge | Open the folio; a reversed charge shows its reversal alongside it. |

---

## 5. Recovery

- **Wrong charge:** reverse it, with a reason. Corrections are additions, never
  edits.
- **Lost second factor:** use a recovery code. If none remain, an owner turns
  MFA off for that account — which needs the owner's own password and is
  recorded.
- **Suspected account compromise:** Settings → the user → revoke sessions;
  change the password; require MFA for that role.
- **Data restore:** `docs/operations.md` §3.3. Restoring over a live database
  is refused unless explicitly forced.

---

## 6. What is not working yet

Stated plainly so nobody plans around a feature that is not there.

| Area | Status |
| --- | --- |
| Card / payment-link collection | **Unavailable.** Needs Paystack credentials and a registered webhook. |
| Guest ID scans, receipts, exports | **Unavailable.** Needs a Cloudflare R2 bucket; without it uploads would be lost on each redeploy. |
| Staff invitation emails | **Not delivered.** Invitations are created but no email is sent; there is no acceptance link yet. |
| Password reset | **Not implemented.** An owner must reset a colleague's access. |
| Push notifications | **Disabled** unless VAPID keys are configured. |
| Offline use | **Not supported** in this dashboard. Do not rely on it at the desk. |
| Restaurant POS, cashiering screens | Removed from this dashboard by design. |

---

## 7. Support

`/support/lookup` finds a booking from a confirmation code, phone number,
surname or invoice number. Contact details are masked — enough to confirm you
have the right person, not enough to become a second copy of the guest list.
Every lookup is recorded against the person who ran it.

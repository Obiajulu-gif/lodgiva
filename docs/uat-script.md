# User acceptance test script

Run against the **training tenant**, never against a live property.

```bash
node packages/database/src/seed-demo.js --reset
```

That creates *Harmattan Suites Abuja* (`HRM-ABJ`) — a separate tenant from the
Grand Palm seed the automated suites use, so a trainee cancelling everything
cannot break a test run.

**Logins** (password `TrainMe123!`):

| Email | Role |
| --- | --- |
| `trainer@harmattan.demo` | Tenant owner |
| `trainee.gm@harmattan.demo` | General manager |
| `trainee.desk@harmattan.demo` | Front desk |
| `trainee.hk@harmattan.demo` | Housekeeping |

The dataset ships **deliberately broken**, because a property where every folio
balances and every room is clean teaches nobody what to do on a real Tuesday:

- one in-house guest owes a balance
- one departure is past checkout and still in house
- one room is `VACANT_DIRTY` with an arrival waiting on it
- one room is `OUT_OF_ORDER` with an open maintenance ticket
- one reservation is an unresolved `NO_SHOW`

---

## How to record a result

For each scenario write **PASS**, **FAIL**, or **BLOCKED**, and for anything
other than PASS record what you saw, not what you expected. "Didn't work" is
not a result; "the Void button did nothing and the console showed a 403" is.

---

## A. Front desk (as `trainee.desk`)

| # | Scenario | Expected |
| --- | --- | --- |
| A1 | Sign in | Room board loads showing today's arrivals and departures |
| A2 | Search availability for 2 nights from today | Rooms offered with prices; sold-out types are absent, not shown at ₦0 |
| A3 | Create a booking for a walk-in guest | Confirmation code in the form `LDG-XXXX-XXXX`, never sequential |
| A4 | Check in the arriving guest | Refused if the only free room is dirty, with the reason named |
| A5 | Post a ₦5,000 sundry charge to their folio | Appears immediately with tax applied |
| A6 | Try to check out with a balance owing | Refused, and the balance is stated |
| A7 | Take a cash payment for the balance, then check out | Succeeds; folio closes |
| A8 | Reopen the folio | Requires approval — front desk alone cannot |
| A9 | Drag a stay to a different room on the calendar | Moves; the room board updates without a refresh |
| A10 | Attempt a 10% discount | Above the 5% self-service limit, so it raises an approval request |

## B. Housekeeping (as `trainee.hk`)

| # | Scenario | Expected |
| --- | --- | --- |
| B1 | Open the room board on a phone-sized window | Three columns, tap targets usable one-handed |
| B2 | Start and complete a clean | Status moves `PENDING → IN_PROGRESS → COMPLETED` |
| B3 | Turn off wifi, complete another clean, turn wifi back on | Queued offline, flushed on reconnect, no duplicate |
| B4 | While offline, open the board fresh | Loads from cache with a visible "offline" indicator |
| B5 | Have the trainer advance the same task from another screen, then sync yours | Conflict shown with the server's version and what to do — never a silent overwrite |
| B6 | Try to open the Payments page | Not in the navigation; direct URL is refused |

## C. Restaurant and cash (as `trainee.desk`)

| # | Scenario | Expected |
| --- | --- | --- |
| C1 | Open a cashier shift with a ₦50,000 float | Shift opens |
| C2 | Ring a ₦3,000 order and void it immediately | Voids outright — small and inside the 15-minute window |
| C3 | Ring a ₦12,000 order and void it | Held as `VOID — AWAITING APPROVAL`; a reason is required |
| C4 | Try to settle the held order | Refused: it cannot be settled while a void is pending |
| C5 | Try to approve your own void | Refused; front desk cannot approve |
| C6 | As `trainee.gm`, reject that void | Order returns to `OPEN` with no void reason left behind |
| C7 | Settle it to a room folio | Charge appears on the guest's folio with service charge and VAT |
| C8 | Close the shift, counting ₦1,000 short | Variance recorded, flagged for approval, reason required |

## D. Manager and owner (as `trainee.gm` / `trainer`)

| # | Scenario | Expected |
| --- | --- | --- |
| D1 | Approve the outstanding discount request | Discount posts; the requester cannot have approved it |
| D2 | Run night audit pre-flight | Blockers list the open shift and any undecided void, each with a reason |
| D3 | Clear the blockers and run the audit | Business date advances; room charges post for every in-house stay |
| D4 | Try to run it twice for the same date | Refused with `ALREADY_RUN` |
| D5 | Open the owner dashboard | Occupancy, ADR and RevPAR; ADR ≥ RevPAR whenever rooms are empty |
| D6 | Export the guest ledger as PDF | Downloads a real PDF; money reads `NGN`, pages are numbered |
| D7 | Enable MFA on your own account | QR scans in Google Authenticator or Authy; ten recovery codes shown once |
| D8 | Sign out and back in | Password alone is not enough; the code completes it |
| D9 | Sign in using a recovery code, then reuse the same one | First works, second is refused |
| D10 | As owner, require MFA for `FRONT_DESK` | Response states how many users will be prompted |
| D11 | Sign in as `trainee.desk` | Sent to enrolment, not blocked; finishing it signs them straight in |
| D12 | Look up a booking in support tooling by phone number | Found; the email is masked |

## E. Guest-facing

| # | Scenario | Expected |
| --- | --- | --- |
| E1 | Open the public booking page | Loads on a slow connection; prices in naira |
| E2 | Book a room end to end | Confirmation code shown and emailed content generated |
| E3 | Book the last room of a type from two browsers at once | Exactly one succeeds; the other is told it sold out |

---

## Sign-off

UAT is complete when every scenario is PASS, or each FAIL has a ticket and an
explicit accept-or-fix decision from the property owner. **Scenarios A6, C4,
C5, D4, D9 and E3 are not negotiable** — each one is a control protecting money
or guest data, and a workaround for any of them is a defect, not a preference.

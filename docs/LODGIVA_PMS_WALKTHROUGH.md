# Lodgiva PMS — demo walkthrough

A script for walking a colleague through `/lodgiva`, the staff-facing property
management system. Each section gives what the screen is, what to say, and what
to click to make the point land.

The structure below is taken from the app launcher: nine modules, each a group
of screens. Sign in at `/lodgiva`, and the launcher is at `/lodgiva/apps`.

---

## Opening line

> "Lodgiva runs a hotel end to end on one screen — reservations, front desk,
> housekeeping, restaurant and payments. Today a Nigerian hotel typically runs
> four systems that don't reconcile. This is all of them in one, and it keeps
> working when the network drops."

Then open `/lodgiva` and sign in.

---

## 1. Today

**Path:** `/lodgiva` (the landing screen after sign-in)

The shift view. Whoever is on duty opens this and sees the day's work: who is
arriving, who is leaving, which rooms are ready.

> "This is the screen the front desk lives on. Not a dashboard to admire —
> a worklist. Arrivals, departures, and what's blocking them."

## 2. Front Desk

**Module:** *Arrivals, departures, bookings and guests — the day's work.*

| Screen | Path | What to say |
|---|---|---|
| Dashboard | `/lodgiva/dashboard` | Occupancy and the day's numbers at a glance. |
| Lodgiva Agent | `/lodgiva/assistant` | The AI assistant over the property's own data. |
| Reservations | `/lodgiva/reservations` | Every booking, filterable. The core record. |
| Central Reservations | `/lodgiva/crs` | Search across properties, for a group with more than one hotel. |
| Tape Chart | `/lodgiva/tape` | The grid every hotelier recognises: rooms down, dates across. |
| Calendar | `/lodgiva/calendar` | Same inventory, month view. |
| Guests | `/lodgiva/guests` | Guest profiles and history. |
| Room Blocks | `/lodgiva/room-blocks` | Rooms held off-sale for a group or maintenance. |

**Demo this one:** open **Tape Chart**. It is the most immediately legible
screen in the product — anyone who has worked a front desk understands it
without explanation.

## 3. Housekeeping

**Module:** *Room status board, lost & found, and the phone app.*

| Screen | Path | What to say |
|---|---|---|
| Room Board | `/lodgiva/housekeeping` | Clean, dirty, inspected — the status of every room. |
| Laundry | `/lodgiva/laundry` | Linen and guest laundry tracking. |
| Lost & Found | `/lodgiva/lost-found` | Logged against the room and the stay. |
| Phone App | `/lodgiva/hk` | Separate mobile view for room attendants. |

**Demo this one:** open **Phone App** (`/lodgiva/hk`) on a phone-sized window.
Room attendants do not carry laptops — this is the screen they actually use,
and it is a strong answer to "will my staff really use it?"

## 4. Operations

**Module:** *Guest requests and ops workflows.*

| Screen | Path | What to say |
|---|---|---|
| Guest Requests | `/lodgiva/tickets` | Every request becomes a tracked ticket. |
| WhatsApp | `/lodgiva/whatsapp` | Guests message the channel they already use. |
| Channels | `/lodgiva/channels` | Other inbound contact channels. |
| SLA Report | `/lodgiva/ops-sla` | How fast requests were actually answered. |

**Worth stressing:** WhatsApp is not a gimmick in this market — it is where
Nigerian guests already are.

## 5. F&B

**Module:** *Restaurant POS, kitchen display, the menu and kitchen stock.*

| Screen | Path | What to say |
|---|---|---|
| Restaurant POS | `/lodgiva/pos` | Table service and bar, with charges posting to the room folio. |
| F&B Dashboard | `/lodgiva/pos-dashboard` | Covers and revenue. |
| Kitchen Display | `/lodgiva/kitchen` | Orders on a kitchen screen instead of paper tickets. |
| Menu | `/lodgiva/menu-items` | Items and prices. |
| Kitchen Inventory | `/lodgiva/inventory` | Stock behind the menu. |
| Outlets | `/lodgiva/outlets` | Restaurant, bar, room service as separate outlets. |

**The point to make:** a restaurant charge lands on the guest's folio
automatically. That single link is what removes the midnight reconciliation
between the POS till and the front-desk ledger.

## 6. Banquets & Groups

**Module:** *Function prospecting, quotations and event orders — plus room
blocks and pickup.*

| Screen | Path | What to say |
|---|---|---|
| Banquets | `/lodgiva/banquet` | The event pipeline. |
| Month Availability | `/lodgiva/banquet-month` | Which halls are free. |
| Function Diary | `/lodgiva/banquet-diary` | The day's events. |
| Registers | `/lodgiva/banquet-registers` | Statutory registers. |
| Menus & Services | `/lodgiva/banquet-catalogue` | What can be sold into a function. |
| All Functions | `/lodgiva/events` | Full list. |
| Groups & Blocks | `/lodgiva/groups` | Group bookings and their room allocation. |
| Halls & Venues | `/lodgiva/venues` | The spaces themselves. |

**Why it matters here:** weddings and conferences are a large share of revenue
for Nigerian hotels, and most PMS products treat banquets as an afterthought.

## 7. Revenue

**Module:** *Rates, seasons, offers and the partners who sell you.*

| Screen | Path | What to say |
|---|---|---|
| Revenue Reports | `/lodgiva/revenue-reports` | Where money came from. |
| Channel Manager | `/lodgiva/channel-manager` | Pushes rates and availability to OTAs. |
| OTA Room Mappings | `/lodgiva/ota-mappings` | Matches your room types to each OTA's. |
| Rate Plans | `/lodgiva/rate-plans` | Pricing structures. |
| Seasons | `/lodgiva/seasons` | Rate changes by period. |
| Guardrails | `/lodgiva/guardrails` | Floors and ceilings, so nobody sells a room at a loss. |
| Vouchers | `/lodgiva/vouchers` | Discount codes. |
| Meal Plans | `/lodgiva/meal-plans` | Room-only, B&B, half board. |
| Travel Agents | `/lodgiva/travel-agents` | Agent accounts and commission. |
| Companies | `/lodgiva/companies` | Corporate accounts and negotiated rates. |

**Demo this one:** **Guardrails**. It is the screen that shows the product was
designed by someone who has watched a night-shift clerk discount a room too far.

## 8. Finance

**Module:** *Cashier till, folios, ledgers, night audit and books export.*

Grouped into three:

**Cashier** — `/lodgiva/cashier` (My Till), `/sessions`, `/petty-cash`,
`/shift-report`, `/lodgiva/shifts` (Shift Handover), `/cashier/fx` (Currency Desk)

> "Each cashier has their own till and their own shift. Handover is a record,
> not a conversation."

**Billing** — `/lodgiva/billing`, `/folio-history`, `/laundry`

> "The folio is the guest's running bill. Every charge from every outlet lands
> here."

**Books** — `/lodgiva/ledgers`, `/reports`, `/accounting-export`

> "And it exports to whatever the accountant already uses."

**The line that lands:** the ledger is tamper-proof — entries are corrected by
counter-entry, never edited away. That is the difference between software a
hotel owner tolerates and software they trust.

## 9. Booking Engine

**Module:** *Manage direct booking setup, property profile, photo gallery, FAQs
and SEO rules.*

| Screen | Path |
|---|---|
| Hotel Profile | `/lodgiva/booking-settings/profile` |
| Amenities | `/lodgiva/booking-settings/amenities` |
| Photos | `/lodgiva/booking-settings/photos` |
| Policies | `/lodgiva/booking-settings/policies` |
| Payments | `/lodgiva/booking-settings/payments` |
| FAQ | `/lodgiva/booking-settings/faq` |
| SEO | `/lodgiva/booking-settings/seo` |

This is the back office for the **public booking page**. Configure it here,
guests see it at `/book`.

**Demo this one properly:** set something in Photos or Policies, then open
`/book` in a second tab and show the guest-facing result. Direct bookings carry
no OTA commission, so this screen is the one with the clearest money attached.

## 10. Admin

**Module:** *Property setup, inventory, users, audit and the Marketplace.*

| Screen | Path | What to say |
|---|---|---|
| Settings | `/lodgiva/settings` | Property configuration. |
| System Health | `/lodgiva/health` | Is everything running. |
| Rooms / Room Types | `/lodgiva/rooms`, `/room-types` | The inventory itself. |
| Activity Log | `/lodgiva/activity` | Who did what. |
| Marketplace | `/lodgiva/marketplace` | Add-ons. |
| New Property | `/lodgiva/setup` | Add another hotel to this environment. |
| Manage Users | — | Staff accounts and roles. |
| Frappe Desk | — | The underlying framework's admin UI. |

---

## Guest-facing pages — show these too

These need no login, and they are the easiest part of the demo to make real.

| Page | Path | What it is |
|---|---|---|
| Booking page | `/book` | Direct online booking, commission-free |
| Property listing | `/stay/<slug>` | A single property's public page |
| Online check-in | `/checkin/<token>` | Guest checks in before arriving |
| QR menu | `/lodgiva/menu/<outlet>` | Scan at the table, see the menu |

---

## Closing line

> "Four systems became one. The restaurant posts to the folio, the folio posts
> to the ledger, the ledger exports to the accountant, and the booking page
> feeds all of it without paying commission."

---

## If you only have five minutes

1. **Tape Chart** — instantly recognisable
2. **Restaurant POS → folio** — the integration that removes reconciliation
3. **`/book`** — the guest side, no commission
4. **Housekeeping phone app** — proof staff will actually use it

## Questions you should expect

**"What happens when the internet goes down?"**
The app is built to keep working through a drop and sync afterwards. Say this
plainly — it is a deliberate design choice for this market, not a feature list
item.

**"Can it handle more than one hotel?"**
Yes. Central Reservations searches across properties, and Admin → New Property
adds one. Provisioning a whole new customer environment is a separate admin
console at `/admin`.

**"Is it locked to Nigeria?"**
No. Nigerian defaults — Naira, local tax rules, WhatsApp — ship in a separate
`lodgiva_nigeria` pack, so the core is not tied to one market.

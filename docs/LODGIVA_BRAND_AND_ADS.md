# Lodgiva — branding and ad promotion kit

Everything needed to run brand and performance advertising for Lodgiva: the
positioning spine, the feature set written as benefits, the copy bank, and the
claims that are safe to make.

Feature names and capabilities here are taken from the shipped product — the
PMS app launcher and the landing page — not from a wish list. Anything not yet
built is listed under **Do not claim** at the end.

---

## 1. Positioning

**Category:** hotel management software (PMS) for Nigerian hotels.

**One-liner**
> One screen for the whole property.

**The enemy.** Not a competing PMS — the four disconnected systems a hotel
already runs. A booking book, a restaurant till, a housekeeping sheet and a
cashbook that disagree with each other every night.

**The promise**
> Reservations, front desk, housekeeping, POS and payments in one system — so
> your team stops reconciling four registers at midnight.

**The three pillars** (already live on the landing page — keep advertising
consistent with them):

| Pillar | What it means | Why it sells here |
|---|---|---|
| **Revenue leakage, eliminated** | One ledger that cannot be quietly edited | Owners' first fear is theft, not inefficiency |
| **Works offline, syncs later** | Keeps working when the network drops | Every Nigerian operator has lost a night to downtime |
| **Built for Nigerian payments** | Naira, local rails, local tax | "Built for us" beats "world-class" in this market |

**Tone.** Calm, specific, operator-to-operator. Lodgiva sounds like someone who
has worked a night shift, not like a SaaS brochure. Concrete nouns over
adjectives: *room moves, split folios, variance reports* — not *powerful,
seamless, revolutionary*.

---

## 2. Brand assets

Pulled from `apps/marketing-web/app/globals.css` — use these exact values so ads
match the site.

| Token | Hex | Use |
|---|---|---|
| `brand-800` | `#124434` | Primary deep emerald — backgrounds, logo |
| `brand-700` | `#175540` | Links, accents on light |
| `brand-900` | `#0c3527` | Deepest shade, large fields |
| `gold-400` | `#cda95c` | Primary gold — rules, highlights, one accent per frame |
| `gold-300` | `#ddc588` | Soft gold on dark |
| `gold-500` | `#bd923f` | Gold on light where contrast is needed |
| `cream` | `#faf9f6` | Page background — never pure white |

**Type.** Playfair Display (`--font-display`) for headlines; Inter
(`--font-sans`) for everything else. Headlines are the only place the serif
appears — mixing it into body copy cheapens it.

**Visual grammar.** Generous whitespace, a thin gold rule above section
headings, soft blurred colour fields rather than hard blocks, one accent per
frame. The landing page's restraint *is* the brand — ads that shout will look
like a different company.

**Logo lockup.** Emerald rounded tile, house mark, wordmark in the display face.

---

## 3. Feature set, written to sell

Ten groups. Lead with the operator's problem; the feature is the answer.

### Front desk — the day's work
Reservations, Tape Chart, Calendar, Central Reservations, Guests, Room Blocks.

> "Check-in in under a minute. Room moves, stay extensions and split folios —
> each one leaving an audit trail behind it."

**Ad angle:** the Tape Chart. It is the single most recognisable screen in the
product — any hotelier understands it in two seconds, which makes it the best
image in a feed.

### Direct booking engine — the commission story
Public booking page, property listing, online check-in, QR menus. Configured
from Hotel Profile, Amenities, Photos, Policies, Payments, FAQ, SEO.

> "A booking page for your own hotel with instant confirmation, so you stop
> paying commission on guests who already know your name."

**Ad angle:** the strongest performance-marketing hook Lodgiva has. OTA
commission is a number every owner can quote from memory, and this is the only
feature that visibly hands it back.

### Payments and reconciliation — the trust story
Cashier tills, per-cashier shifts, folios, ledgers, accounting export, currency
desk, petty cash.

> "Every naira accounted for. Collection, posting and reconciliation in one
> ledger that cannot be quietly edited."

**Ad angle:** the tamper-proof ledger. Entries are corrected by counter-entry,
never edited away. Say that plainly — it is the difference between software an
owner tolerates and software they trust.

### Housekeeping — the half guests never see
Room status board, laundry, lost and found, and a separate phone app for room
attendants.

> "The half of the operation that decides whether tonight's rooms are
> sellable."

**Ad angle:** the phone app. It answers the objection every owner raises —
*will my staff actually use it?* Room attendants do not carry laptops.

### Restaurant and bar
POS, kitchen display, menu, kitchen inventory, outlets, F&B dashboard.

**Ad angle:** a restaurant charge lands on the guest's folio automatically.
That one link removes the midnight argument between the till and the front desk.

### Banquets and groups
Function prospecting, quotations, event orders, function diary, halls and
venues, groups and room blocks.

**Ad angle:** underserved. Weddings and conferences are a large share of
Nigerian hotel revenue, and most PMS products treat banquets as an afterthought.
Worth its own campaign aimed at event-heavy properties.

### Revenue management
Rate plans, seasons, guardrails, vouchers, meal plans, channel manager, OTA room
mappings, travel agents, corporate accounts.

**Ad angle:** guardrails — floors and ceilings so nobody sells a room at a loss
at 2am.

### Owner visibility
> "A daily flash report on your phone: occupancy, ADR, RevPAR, outstanding
> balances and anything unusual — before your first cup of tea."

**Ad angle:** the best creative for owners who are not on site. Sell the
morning, not the dashboard.

### Reports and accounting
Occupancy, ADR, RevPAR, discounts, voids, tax summary, guest ledger, CSV export.

> "Exports to whatever your accountant already uses."

### Inventory and procurement
Stock ledgers, reorder alerts, variance reports for stores, kitchen and
housekeeping.

---

## 4. Audience angles

| Audience | What they fear | Lead with |
|---|---|---|
| **Owner / MD** | Staff theft, invisible leakage | Tamper-proof ledger, morning flash report |
| **General manager** | Four systems, nightly reconciliation | One screen, POS→folio→ledger chain |
| **Front office manager** | Slow check-in, queues, mistakes | Tape Chart, under-a-minute check-in |
| **Finance / accounts** | Month-end chaos | Audit trail, CSV export, tax summary |
| **Event-heavy properties** | Banquets run on WhatsApp and paper | Function diary, event orders |
| **Small hotels / guesthouses** | Cost, complexity, "not for us" | Direct booking page, commission saved |

---

## 5. Copy bank

### Headlines — brand
- One screen for the whole property.
- Your hotel, in one system.
- Stop reconciling four registers at midnight.
- Built for Nigerian hospitality.

### Headlines — performance
- Stop paying commission on guests who already know your name.
- Every naira accounted for.
- A ledger nobody can quietly edit.
- Check-in in under a minute.
- Still works when the network drops.
- Your hotel's numbers, before your first cup of tea.

### Subheads
- Reservations, front desk, housekeeping, POS and payments in one system.
- From enquiry to key handover, without a paper register in sight.
- The restaurant posts to the folio. The folio posts to the ledger. The ledger
  exports to your accountant.

### Calls to action
Primary: **Start free trial** · Secondary: **Explore the platform** ·
Soft: **See a 10-minute demo** · Local: **Talk to someone in Lagos**

### Short-form ad copy

**Facebook / Instagram — owners**
> Your front desk says one number. Your restaurant says another. Your cashbook
> says a third.
> Lodgiva puts reservations, POS, housekeeping and payments in one ledger — one
> that cannot be quietly edited.
> Built for Nigerian hotels. Works offline.
> → Start free trial

**Instagram — commission angle**
> You pay commission on guests who already knew your name.
> Lodgiva gives your hotel its own booking page, with instant confirmation and
> payment. The booking is yours. So is the money.
> → See how it works

**LinkedIn — GM / group operators**
> Most hotels run four systems that disagree every night.
> Lodgiva runs reservations, front desk, housekeeping, restaurant POS, banquets
> and payments on one record — with an audit trail on every movement and a tax
> summary your accountant can actually use.
> Nigerian payments, offline-tolerant, 24/7 local support.

**WhatsApp / status — short**
> One screen for the whole property. Reservations, front desk, housekeeping,
> POS and payments. Built for Nigerian hotels. lodgiva.com

**Google Search — responsive**
Headlines: *Hotel Management Software Nigeria* · *One Screen For Your Hotel* ·
*Stop OTA Commission* · *Works Offline* · *Free Trial, No Card*
Descriptions: *Reservations, front desk, housekeeping, POS and payments in one
system. Built for Nigerian hotels.* · *Your own booking page with instant
confirmation. Keep the commission.*

---

## 6. Creative direction for ads

**Show the product.** Lodgiva's screens are its best asset — the Tape Chart, the
folio, the booking page on a phone. Stock photos of smiling receptionists say
nothing and look like every competitor.

**Best frames, in order:**
1. Tape Chart — instantly legible, looks like a real hotel's week
2. Booking page on a phone — the guest side, the commission story
3. Housekeeping phone app in a hand — answers the adoption objection
4. Morning flash report on a phone — the owner's moment
5. A folio with a restaurant charge on it — the integration, in one image

**Rules.** Cream or emerald background, one gold accent, real screenshots with
real-looking Nigerian hotel names and Naira amounts. Never lorem ipsum, never
dollar signs, never a fake metric on screen.

---

## 7. Claims — what is safe

**Safe, because it is built and verifiable:** every module and screen in
section 3; offline tolerance; audit trail on movements; CSV and accounting
export; direct booking with instant confirmation; multi-property; Naira and
Nigerian tax defaults; 24/7 local support (if staffed — confirm before running).

**Fill in before running ads.** The landing page has three stat slots that need
real numbers:
- *Properties on Lodgiva*
- *Payments reconciled monthly*
- *Average drop in revenue leakage*

Do not invent these. An unverifiable number in an ad is the fastest way to lose
an owner who is already suspicious of software salespeople — and the third one
is a performance claim that needs evidence behind it.

**Do not claim** without checking the product first:
- Any integration not actually wired — confirm which OTAs the channel manager
  really connects to before naming Booking.com or Expedia in creative
- Specific uptime or availability percentages
- Certifications or compliance marks not held
- Named customers or testimonials not in writing — the landing page has a
  testimonials section; it must hold real, permitted quotes before it runs in
  paid media
- Anything the documentation site marks with a status label rather than as
  available

---

## 8. Assets to produce next

1. Screenshot set at ad ratios (1:1, 4:5, 9:16, 16:9) from a seeded demo
   property with realistic Nigerian names and Naira rates
2. A 30-second product film: four systems → one screen
3. A 15-second commission cut for Reels and Shorts
4. One-page PDF leaflet for in-person sales visits
5. Case study with one real property, once numbers exist

# Subscription Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every hotel carries a subscription whose state is computed daily and enforced as read-only access, without any billing state ever deleting data.

**Architecture:** Two DocTypes in `lodgiva_control` (`Subscription Plan`, `Hotel Subscription`). A pure state-machine module computes the next state from the current record and today's date — no I/O, no clock of its own — and a scheduled job applies it, writing one `lodgiva_access_mode` value into each hotel's `site_config.json`. The `kamra` app reads that flag and blocks writes. The control app moves onto its own site so the control plane is never subject to the billing state it enforces.

**Tech Stack:** Frappe 16 (Python 3.14), `unittest` via `bench run-tests`, MariaDB.

**Spec:** `docs/superpowers/specs/2026-10-22-subscription-lifecycle-design.md`

## Global Constraints

- Trial is **15 days**; `trial_ends_on = today + 15` at creation.
- Grace is site config `lodgiva_grace_days`, **default 14, clamped to 7–14**.
- Suspension requires `suspend_notice_sent_on` **at least 72 hours** old.
- `0` in `max_users` / `max_rooms` means **unlimited**.
- Free tier: **1 user, 10 rooms**, core PMS only, no booking engine.
- States are exactly: `trialing`, `active`, `past_due`, `unpaid`, `free`, `cancelled`, `paused`.
- `past_due` keeps **full** access. Only `unpaid`, `cancelled`, `paused`, and over-limit `free` are `read_only`.
- `Hotel Subscription.state` is separate from `Hotel Environment.status`; neither is derived from the other.
- No billing state ever deletes a record.
- Existing names to consume, not redefine: `provisioning.apex()`, `provisioning.site_exists(site)`, `provisioning.bench_bin()`, `Hotel Environment.site_name`.

## Review Focus

Five failure modes the spec implies but does not name a test for. Each has a test assigned to the task that owns the code.

1. **A hotel with no subscription record at all.** Half the fleet predates this feature. `evaluate_subscriptions` must skip it, not crash and not restrict it. → Task 4.
2. **`bench set-config` fails for one site** (site dropped, disk full) mid-sweep. The sweep must continue for the remaining hotels and record the failure. → Task 4.
3. **Clock moving backwards or a record dated in the future** (`trial_ends_on` after today following a manual edit). Must not transition. → Task 2.
4. **`lodgiva_grace_days` set to a non-integer or absent.** Must fall back to 14, not raise inside a scheduled job. → Task 2.
5. **Over-limit free hotel that later shrinks** below the caps. Must return to `full` on the next sweep, not stay restricted forever. → Task 3.

---

### Task 1: Subscription Plan and Hotel Subscription DocTypes

**Files:**
- Create: `frappe-apps/lodgiva_control/lodgiva_control/lodgiva_control/doctype/subscription_plan/subscription_plan.json`
- Create: `frappe-apps/lodgiva_control/lodgiva_control/lodgiva_control/doctype/subscription_plan/subscription_plan.py`
- Create: `frappe-apps/lodgiva_control/lodgiva_control/lodgiva_control/doctype/subscription_plan/__init__.py`
- Create: `.../doctype/hotel_subscription/hotel_subscription.json`
- Create: `.../doctype/hotel_subscription/hotel_subscription.py`
- Create: `.../doctype/hotel_subscription/__init__.py`
- Test: `frappe-apps/lodgiva_control/lodgiva_control/tests/test_subscription_model.py`

**Interfaces:**
- Consumes: `Hotel Environment` (Link target), `Lodgiva Operator` and `System Manager` roles.
- Produces: DocType `Subscription Plan` with fields `plan_code` (Data, unique), `plan_name` (Data), `monthly_price` (Currency), `max_users` (Int), `max_rooms` (Int), `allowed_modules` (Small Text), `booking_engine` (Check), `is_free` (Check). DocType `Hotel Subscription` with `hotel_environment` (Link → Hotel Environment, unique), `plan` (Link → Subscription Plan), `state` (Select, default `trialing`), `trial_ends_on` (Date), `grace_ends_on` (Date), `suspend_notice_sent_on` (Datetime), `access_mode` (Select `full`/`read_only`, read-only, default `full`), `state_log` (Code, read-only).

- [ ] **Step 1: Write the failing test**

```python
class TestSubscriptionModel(unittest.TestCase):
    def test_trial_ends_fifteen_days_after_creation(self):
        sub = make_subscription(plan="STARTER")
        self.assertEqual(sub.trial_ends_on, add_days(nowdate(), 15))
        self.assertEqual(sub.state, "trialing")
        self.assertEqual(sub.access_mode, "full")

    def test_one_subscription_per_hotel(self):
        env = make_environment("dupe")
        make_subscription(hotel_environment=env)
        with self.assertRaises(frappe.UniqueValidationError):
            make_subscription(hotel_environment=env)

    def test_exactly_one_plan_is_free(self):
        with self.assertRaises(frappe.ValidationError):
            make_plan(plan_code="FREE2", is_free=1)
```

`make_plan`, `make_environment` and `make_subscription` are fixtures in the same test file; write them there.

- [ ] **Step 2: Run test to verify it fails**

Run: `bench --site <control site> run-tests --app lodgiva_control --module lodgiva_control.tests.test_subscription_model`
Expected: FAIL — `DoesNotExistError: DocType Subscription Plan not found`

- [ ] **Step 3: Create both DocType JSONs and their controllers**

`Hotel Subscription.autoname` is `field:hotel_environment`. `Subscription Plan.autoname` is `field:plan_code`. Permissions on both match `Hotel Environment`: `Lodgiva Operator` and `System Manager` read/write/create, `System Manager` also delete and cancel. In `subscription_plan.py`, `validate` rejects a second `is_free` plan. In `hotel_subscription.py`, `before_insert` sets `trial_ends_on` to `add_days(nowdate(), 15)`.

- [ ] **Step 4: Run test to verify it passes**

Run: as Step 2
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add frappe-apps/lodgiva_control/lodgiva_control/lodgiva_control/doctype/subscription_plan frappe-apps/lodgiva_control/lodgiva_control/lodgiva_control/doctype/hotel_subscription frappe-apps/lodgiva_control/lodgiva_control/tests/test_subscription_model.py
git commit -m "feat(control): subscription plan and hotel subscription doctypes"
```

---

### Task 2: The state machine, pure

**Files:**
- Create: `frappe-apps/lodgiva_control/lodgiva_control/subscription.py`
- Test: `frappe-apps/lodgiva_control/lodgiva_control/tests/test_subscription_state.py`

**Interfaces:**
- Consumes: the field names from Task 1.
- Produces:
  - `next_state(current: dict, today: date, notice_age_hours: float | None) -> tuple[str, str]` — returns `(state, reason)`. Pure: no DB, no `nowdate()`, no I/O. `current` carries `state`, `plan_is_free`, `trial_ends_on`, `grace_ends_on`.
  - `grace_days(raw) -> int` — clamps to 7–14, returns 14 for `None` or anything non-integer.
  - `TRANSITIONS: dict[str, set[str]]` — legal target states per source state.

This module is the only place a state decision is made. Keeping it free of
clock and database is what lets the whole table be tested in milliseconds and
is why Review Focus items 3 and 4 are cheap to pin.

- [ ] **Step 1: Write the failing test**

```python
class TestNextState(unittest.TestCase):
    def test_trial_expiry_drops_to_free(self):
        state, _ = next_state(
            {"state": "trialing", "trial_ends_on": date(2026, 1, 1), "plan_is_free": False},
            today=date(2026, 1, 2), notice_age_hours=None)
        self.assertEqual(state, "free")

    def test_trial_not_yet_over_stays_trialing(self):
        state, _ = next_state(
            {"state": "trialing", "trial_ends_on": date(2026, 1, 5), "plan_is_free": False},
            today=date(2026, 1, 2), notice_age_hours=None)
        self.assertEqual(state, "trialing")

    def test_future_dated_trial_does_not_transition(self):
        # Review Focus 3: a manual edit must not drive a transition backwards.
        state, _ = next_state(
            {"state": "trialing", "trial_ends_on": date(2027, 1, 1), "plan_is_free": False},
            today=date(2026, 1, 2), notice_age_hours=None)
        self.assertEqual(state, "trialing")

    def test_past_due_without_notice_stays_past_due(self):
        state, reason = next_state(
            {"state": "past_due", "grace_ends_on": date(2026, 1, 1), "plan_is_free": False},
            today=date(2026, 1, 20), notice_age_hours=None)
        self.assertEqual(state, "past_due")
        self.assertIn("notice", reason)

    def test_past_due_with_stale_notice_stays_past_due(self):
        state, _ = next_state(
            {"state": "past_due", "grace_ends_on": date(2026, 1, 1), "plan_is_free": False},
            today=date(2026, 1, 20), notice_age_hours=71.0)
        self.assertEqual(state, "past_due")

    def test_past_due_with_served_notice_becomes_unpaid(self):
        state, _ = next_state(
            {"state": "past_due", "grace_ends_on": date(2026, 1, 1), "plan_is_free": False},
            today=date(2026, 1, 20), notice_age_hours=73.0)
        self.assertEqual(state, "unpaid")

    def test_past_due_inside_grace_never_restricts(self):
        state, _ = next_state(
            {"state": "past_due", "grace_ends_on": date(2026, 2, 1), "plan_is_free": False},
            today=date(2026, 1, 20), notice_age_hours=500.0)
        self.assertEqual(state, "past_due")

    def test_terminal_states_do_not_move(self):
        for terminal in ("cancelled", "paused", "free", "active"):
            with self.subTest(state=terminal):
                state, _ = next_state(
                    {"state": terminal, "plan_is_free": terminal == "free"},
                    today=date(2026, 6, 1), notice_age_hours=None)
                self.assertEqual(state, terminal)


class TestGraceDays(unittest.TestCase):
    def test_clamps_and_defaults(self):
        # Review Focus 4: a scheduled job must not raise on bad config.
        self.assertEqual(grace_days(3), 7)
        self.assertEqual(grace_days(30), 14)
        self.assertEqual(grace_days(10), 10)
        self.assertEqual(grace_days(None), 14)
        self.assertEqual(grace_days("banana"), 14)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bench --site <control site> run-tests --app lodgiva_control --module lodgiva_control.tests.test_subscription_state`
Expected: FAIL — `ImportError: cannot import name 'next_state'`

- [ ] **Step 3: Implement `next_state`, `grace_days` and `TRANSITIONS` in `subscription.py`**

`next_state` returns the input state unchanged when no rule fires; `reason` is a short human sentence used for `state_log`. Only two rules move a record: trial expiry, and grace expiry with notice served.

- [ ] **Step 4: Run test to verify it passes**

Run: as Step 2
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add frappe-apps/lodgiva_control/lodgiva_control/subscription.py frappe-apps/lodgiva_control/lodgiva_control/tests/test_subscription_state.py
git commit -m "feat(control): pure subscription state machine"
```

---

### Task 3: Access mode from state and plan limits

**Files:**
- Modify: `frappe-apps/lodgiva_control/lodgiva_control/subscription.py`
- Test: `frappe-apps/lodgiva_control/lodgiva_control/tests/test_access_mode.py`

**Interfaces:**
- Consumes: `next_state` from Task 2.
- Produces: `access_mode_for(state: str, usage: dict, limits: dict) -> str` returning `"full"` or `"read_only"`. `usage` carries `users` and `rooms` as ints; `limits` carries `max_users` and `max_rooms`, where `0` means unlimited.

- [ ] **Step 1: Write the failing test**

```python
class TestAccessMode(unittest.TestCase):
    UNLIMITED = {"max_users": 0, "max_rooms": 0}
    FREE = {"max_users": 1, "max_rooms": 10}

    def test_full_access_states(self):
        for state in ("trialing", "active", "past_due"):
            with self.subTest(state=state):
                self.assertEqual(
                    access_mode_for(state, {"users": 50, "rooms": 500}, self.UNLIMITED), "full")

    def test_past_due_keeps_full_access(self):
        self.assertEqual(access_mode_for("past_due", {"users": 1, "rooms": 1}, self.UNLIMITED), "full")

    def test_restricted_states(self):
        for state in ("unpaid", "cancelled", "paused"):
            with self.subTest(state=state):
                self.assertEqual(
                    access_mode_for(state, {"users": 1, "rooms": 1}, self.UNLIMITED), "read_only")

    def test_free_within_limits_is_full(self):
        self.assertEqual(access_mode_for("free", {"users": 1, "rooms": 10}, self.FREE), "full")

    def test_free_over_limits_matches_unpaid(self):
        over = access_mode_for("free", {"users": 1, "rooms": 11}, self.FREE)
        self.assertEqual(over, "read_only")
        self.assertEqual(over, access_mode_for("unpaid", {"users": 1, "rooms": 1}, self.FREE))

    def test_free_hotel_that_shrinks_returns_to_full(self):
        # Review Focus 5: restriction must be recomputed, never latched.
        self.assertEqual(access_mode_for("free", {"users": 1, "rooms": 11}, self.FREE), "read_only")
        self.assertEqual(access_mode_for("free", {"users": 1, "rooms": 9}, self.FREE), "full")

    def test_zero_means_unlimited(self):
        self.assertEqual(access_mode_for("free", {"users": 99, "rooms": 99}, self.UNLIMITED), "full")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bench --site <control site> run-tests --app lodgiva_control --module lodgiva_control.tests.test_access_mode`
Expected: FAIL — `ImportError: cannot import name 'access_mode_for'`

- [ ] **Step 3: Implement `access_mode_for` in `subscription.py`**

Limits are checked only for `free`. A paid state is never restricted by usage.

- [ ] **Step 4: Run test to verify it passes**

Run: as Step 2
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add frappe-apps/lodgiva_control/lodgiva_control/subscription.py frappe-apps/lodgiva_control/lodgiva_control/tests/test_access_mode.py
git commit -m "feat(control): access mode from state and plan limits"
```

---

### Task 4: The daily sweep

**Files:**
- Create: `frappe-apps/lodgiva_control/lodgiva_control/scheduler.py`
- Modify: `frappe-apps/lodgiva_control/lodgiva_control/hooks.py`
- Test: `frappe-apps/lodgiva_control/lodgiva_control/tests/test_sweep.py`

**Interfaces:**
- Consumes: `next_state`, `access_mode_for`, `grace_days` (Tasks 2–3); `provisioning.bench_bin()`, `provisioning.site_exists(site)`.
- Produces:
  - `evaluate_subscriptions() -> dict` returning `{"evaluated": int, "changed": int, "noticed": int, "failed": list[str]}`.
  - `write_access_mode(site: str, mode: str) -> None` — runs `bench --site <site> set-config lodgiva_access_mode <mode>`.
  - `usage_for(site: str) -> dict` — counts `User` (enabled, System User) and `Room` on that site.
  - `send_suspension_notice(subscription) -> None` — emails `Hotel Environment.owner_email`, stamps `suspend_notice_sent_on`, appends to `state_log`.

- [ ] **Step 1: Write the failing test**

```python
class TestSweep(unittest.TestCase):
    def test_hotel_without_subscription_is_skipped_not_restricted(self):
        # Review Focus 1: pre-existing hotels must survive the sweep untouched.
        env = make_environment("nosub")
        result = evaluate_subscriptions()
        self.assertNotIn(env.site_name, result["failed"])
        self.assertIsNone(frappe.db.get_value("Hotel Subscription", {"hotel_environment": env.name}))

    def test_one_failing_site_does_not_stop_the_sweep(self):
        # Review Focus 2: a dropped site must not strand every hotel after it.
        make_subscription(hotel_environment=make_environment("gone").name)
        good = make_subscription(hotel_environment=make_environment("fine").name)
        with patch_write_access_mode_to_fail_for("gone.localhost"):
            result = evaluate_subscriptions()
        self.assertIn("gone.localhost", result["failed"])
        self.assertEqual(frappe.db.get_value("Hotel Subscription", good.name, "access_mode"), "full")

    def test_transition_is_recorded_in_state_log(self):
        sub = make_subscription(trial_ends_on=add_days(nowdate(), -1))
        evaluate_subscriptions()
        sub.reload()
        self.assertEqual(sub.state, "free")
        self.assertIn("free", sub.state_log)

    def test_grace_expiry_without_notice_sends_one_and_waits(self):
        sub = make_subscription(state="past_due", grace_ends_on=add_days(nowdate(), -1))
        result = evaluate_subscriptions()
        sub.reload()
        self.assertEqual(sub.state, "past_due", "notice must precede restriction")
        self.assertIsNotNone(sub.suspend_notice_sent_on)
        self.assertEqual(result["noticed"], 1)

    def test_notice_is_sent_once_not_every_sweep(self):
        sub = make_subscription(state="past_due", grace_ends_on=add_days(nowdate(), -1))
        evaluate_subscriptions()
        sub.reload()
        first = sub.suspend_notice_sent_on
        evaluate_subscriptions()
        sub.reload()
        self.assertEqual(sub.suspend_notice_sent_on, first)

    def test_sweep_never_deletes_rows(self):
        before = {dt: frappe.db.count(dt) for dt in ("Hotel Environment", "Hotel Subscription")}
        evaluate_subscriptions()
        for dt, count in before.items():
            self.assertEqual(frappe.db.count(dt), count, f"{dt} lost rows")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bench --site <control site> run-tests --app lodgiva_control --module lodgiva_control.tests.test_sweep`
Expected: FAIL — `ImportError: cannot import name 'evaluate_subscriptions'`

- [ ] **Step 3: Implement the sweep in `scheduler.py` and register it in `hooks.py`**

Iterate `Hotel Subscription`, not `Hotel Environment` — a hotel with no subscription is simply absent from the loop, which is what makes Review Focus 1 true by construction rather than by a guard. Each hotel's work is wrapped so one failure appends to `failed` and the loop continues. Append to `state_log` only when the state or access mode actually changes. Register under `scheduler_events["daily"]` as `lodgiva_control.scheduler.evaluate_subscriptions`.

- [ ] **Step 4: Run test to verify it passes**

Run: as Step 2
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add frappe-apps/lodgiva_control/lodgiva_control/scheduler.py frappe-apps/lodgiva_control/lodgiva_control/hooks.py frappe-apps/lodgiva_control/lodgiva_control/tests/test_sweep.py
git commit -m "feat(control): daily subscription sweep"
```

---

### Task 5: Payment seams for Paystack

**Files:**
- Modify: `frappe-apps/lodgiva_control/lodgiva_control/subscription.py`
- Test: `frappe-apps/lodgiva_control/lodgiva_control/tests/test_payment_seams.py`

**Interfaces:**
- Consumes: Task 1 fields, `grace_days` from Task 2.
- Produces, both `@frappe.whitelist()`:
  - `mark_payment_succeeded(subscription: str) -> str` — sets `active`, clears `grace_ends_on` and `suspend_notice_sent_on`, returns the new state.
  - `mark_payment_failed(subscription: str) -> str` — if state is `active` or `trialing`, sets `past_due` and `grace_ends_on = today + grace_days(...)`; otherwise leaves the state unchanged.

- [ ] **Step 1: Write the failing test**

```python
class TestPaymentSeams(unittest.TestCase):
    def test_success_from_any_restricted_state_restores_active(self):
        for start in ("past_due", "unpaid", "free"):
            with self.subTest(start=start):
                sub = make_subscription(state=start, grace_ends_on=nowdate())
                self.assertEqual(mark_payment_succeeded(sub.name), "active")
                sub.reload()
                self.assertIsNone(sub.grace_ends_on)
                self.assertIsNone(sub.suspend_notice_sent_on)

    def test_failure_from_active_starts_grace(self):
        sub = make_subscription(state="active")
        self.assertEqual(mark_payment_failed(sub.name), "past_due")
        sub.reload()
        self.assertEqual(sub.grace_ends_on, add_days(nowdate(), 14))

    def test_failure_does_not_deepen_an_already_unpaid_subscription(self):
        sub = make_subscription(state="unpaid")
        self.assertEqual(mark_payment_failed(sub.name), "unpaid")

    def test_failure_never_restricts_immediately(self):
        sub = make_subscription(state="active")
        mark_payment_failed(sub.name)
        sub.reload()
        self.assertEqual(sub.access_mode, "full")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bench --site <control site> run-tests --app lodgiva_control --module lodgiva_control.tests.test_payment_seams`
Expected: FAIL — `ImportError: cannot import name 'mark_payment_succeeded'`

- [ ] **Step 3: Implement both functions in `subscription.py`**

Neither function contacts a processor, imports a payment library, or knows a retry schedule exists.

- [ ] **Step 4: Run test to verify it passes**

Run: as Step 2
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add frappe-apps/lodgiva_control/lodgiva_control/subscription.py frappe-apps/lodgiva_control/lodgiva_control/tests/test_payment_seams.py
git commit -m "feat(control): payment seams for billing integration"
```

---

### Task 6: The write guard in the PMS

**Files:**
- Create: `<lodgiva-pms repo>/kamra/kamra/access_guard.py`
- Modify: `<lodgiva-pms repo>/kamra/kamra/hooks.py`
- Test: `<lodgiva-pms repo>/kamra/kamra/tests/test_access_guard.py`

**Interfaces:**
- Consumes: `frappe.conf.lodgiva_access_mode`, written by Task 4.
- Produces: `enforce_access_mode(doc, method=None) -> None`, registered on `doc_events["*"]` for `before_insert` and `before_save`.

This task lands in the `lodgiva-pms` repository, not this one.

**Exempt from the guard, always:** every read; `Folio`, `Folio Payment` and `Reservation` writes whose effect is checking out an in-house guest; and `Hotel Subscription` itself. A hotel in read-only must still be able to finish serving the guests already in its rooms.

- [ ] **Step 1: Write the failing test**

```python
class TestAccessGuard(unittest.TestCase):
    def test_full_mode_permits_everything(self):
        with access_mode("full"):
            make_reservation()  # must not raise

    def test_read_only_blocks_a_new_reservation(self):
        with access_mode("read_only"):
            with self.assertRaises(frappe.ValidationError) as caught:
                make_reservation()
            self.assertIn("subscription", str(caught.exception).lower())

    def test_read_only_permits_checking_out_an_in_house_guest(self):
        res = make_reservation()
        with access_mode("read_only"):
            check_out(res)  # must not raise

    def test_read_only_permits_settling_a_folio(self):
        folio = make_folio()
        with access_mode("read_only"):
            add_folio_payment(folio, amount=1000)  # must not raise

    def test_absent_config_defaults_to_full(self):
        with access_mode(None):
            make_reservation()  # a hotel with no flag is not restricted
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bench --site <hotel site> run-tests --app kamra --module kamra.tests.test_access_guard`
Expected: FAIL — `ModuleNotFoundError: No module named 'kamra.access_guard'`

- [ ] **Step 3: Implement `enforce_access_mode` and register it in `hooks.py`**

Absent config means `full`: a site that has never been swept is not a site that has stopped paying. The raised message names the subscription state and what to do about it.

- [ ] **Step 4: Run test to verify it passes**

Run: as Step 2
Expected: PASS, 5 tests

- [ ] **Step 5: Commit** (in the `lodgiva-pms` repo)

```bash
git add kamra/access_guard.py kamra/hooks.py kamra/tests/test_access_guard.py
git commit -m "feat(kamra): block writes when the subscription is restricted"
```

---

### Task 7: Move the control app to its own site

**Files:**
- Create: `scripts/lodgiva-control-site.sh`
- Modify: `scripts/lodgiva-up.sh`
- Modify: `deploy/oracle/Caddyfile.routes`
- Modify: `frappe-apps/lodgiva_control/README.md`

**Interfaces:**
- Consumes: `provisioning.apex()`.
- Produces: a `control.<apex>` site carrying `lodgiva_control` alone, reachable at `/admin`.

The control plane must not be subject to the billing state it enforces. While
`lodgiva_control` rides on a hotel site, that hotel going `unpaid` takes the
console that manages billing read-only with it.

- [ ] **Step 1: Write the failing test**

```python
class TestControlSiteIsolation(unittest.TestCase):
    def test_control_app_is_not_installed_on_a_hotel_site(self):
        installed = frappe.get_installed_apps()
        if frappe.local.site.startswith("control."):
            self.assertIn("lodgiva_control", installed)
        else:
            self.assertNotIn("lodgiva_control", installed,
                             "the control app must not run on a hotel site")

    def test_control_site_has_no_access_mode_flag(self):
        if frappe.local.site.startswith("control."):
            self.assertIsNone(frappe.conf.get("lodgiva_access_mode"))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bench --site kamra.localhost run-tests --app lodgiva_control --module lodgiva_control.tests.test_control_site`
Expected: FAIL — `lodgiva_control` is installed on `kamra.localhost`

- [ ] **Step 3: Write `scripts/lodgiva-control-site.sh` and move the app**

The script creates `control.<apex>` if absent, installs `lodgiva_control` on it, sets `lodgiva_apex`, `lodgiva_db_*`, `lodgiva_bench_bin` and `lodgiva_cloudflared_bin` from the bench's own credentials, and uninstalls `lodgiva_control` from any hotel site that carries it. `lodgiva-up.sh` calls it before starting Caddy. `Caddyfile.routes` routes `/admin` to the control site by rewriting the Host header, the same mechanism `tunnel.py` already uses for per-hotel links.

- [ ] **Step 4: Run test to verify it passes**

Run: as Step 2, then `bench --site control.<apex> run-tests --app lodgiva_control --module lodgiva_control.tests.test_control_site`
Expected: PASS on both — absent on the hotel site, present on the control site

- [ ] **Step 5: Commit**

```bash
git add scripts/lodgiva-control-site.sh scripts/lodgiva-up.sh deploy/oracle/Caddyfile.routes frappe-apps/lodgiva_control/README.md frappe-apps/lodgiva_control/lodgiva_control/tests/test_control_site.py
git commit -m "feat(control): move the console onto its own central site"
```

---

### Task 8: Seed the plans and backfill existing hotels

**Files:**
- Create: `frappe-apps/lodgiva_control/lodgiva_control/patches/seed_plans.py`
- Create: `frappe-apps/lodgiva_control/lodgiva_control/patches.txt`
- Modify: `frappe-apps/lodgiva_control/lodgiva_control/hooks.py`
- Test: `frappe-apps/lodgiva_control/lodgiva_control/tests/test_seed_plans.py`

**Interfaces:**
- Consumes: Task 1 DocTypes.
- Produces: `execute() -> None`, idempotent; plan records `FREE`, `STARTER`, `GROWTH`; a `Hotel Subscription` on the `FREE` plan in state `free` for every `Hotel Environment` that has none.

**Values this task needs that the spec does not fix.** `FREE` is fully
specified: `monthly_price` 0, `max_users` 1, `max_rooms` 10,
`booking_engine` 0, `allowed_modules` `front-desk,housekeeping,operations`
(the ids in `kamra/frontend/src/lib/apps.ts`; confirm against that file).
`STARTER` and `GROWTH` prices are **not decided** — seed them with
`monthly_price` 0 and `disabled` set, and open a follow-up for the real
figures. Do not invent prices: a seeded number becomes a quoted price the
first time an operator opens the console.

- [ ] **Step 1: Write the failing test**

```python
class TestSeedPlans(unittest.TestCase):
    def test_seeds_three_plans_with_free_limits(self):
        execute()
        free = frappe.get_doc("Subscription Plan", "FREE")
        self.assertEqual((free.max_users, free.max_rooms, free.booking_engine), (1, 10, 0))
        self.assertEqual(frappe.db.count("Subscription Plan"), 3)

    def test_is_idempotent(self):
        execute()
        execute()
        self.assertEqual(frappe.db.count("Subscription Plan"), 3)

    def test_backfills_only_hotels_without_a_subscription(self):
        existing = make_subscription(state="active")
        bare = make_environment("bare")
        execute()
        self.assertEqual(frappe.db.get_value("Hotel Subscription", existing.name, "state"), "active")
        self.assertEqual(
            frappe.db.get_value("Hotel Subscription", {"hotel_environment": bare.name}, "state"), "free")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bench --site <control site> run-tests --app lodgiva_control --module lodgiva_control.tests.test_seed_plans`
Expected: FAIL — `ModuleNotFoundError: No module named 'lodgiva_control.patches.seed_plans'`

- [ ] **Step 3: Implement `execute()` and register it in `patches.txt`**

Backfilled hotels land on `free`, never `trialing`: an existing hotel has not just started a trial, and dating one from the backfill would hand every current customer 15 free days of paid features by accident.

- [ ] **Step 4: Run test to verify it passes**

Run: as Step 2
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add frappe-apps/lodgiva_control/lodgiva_control/patches frappe-apps/lodgiva_control/lodgiva_control/patches.txt frappe-apps/lodgiva_control/lodgiva_control/hooks.py frappe-apps/lodgiva_control/lodgiva_control/tests/test_seed_plans.py
git commit -m "feat(control): seed subscription plans and backfill hotels"
```

---

### Task 9: Operator console surface

**Files:**
- Modify: `frappe-apps/lodgiva_control/lodgiva_control/lodgiva_control/doctype/hotel_subscription/hotel_subscription.js` (create)
- Create: `.../doctype/hotel_subscription/hotel_subscription_list.js`
- Modify: `.../workspace/lodgiva_control/lodgiva_control.json`

**Interfaces:**
- Consumes: Task 5's whitelisted methods; Task 1's fields.
- Produces: no Python interface.

- [ ] **Step 1: Add list indicators and the workspace link**

List colours by `state`: `trialing` blue, `active` green, `past_due` orange, `unpaid` red, `free` grey, `cancelled`/`paused` dark grey. `access_mode` is `in_list_view`. Add a `Hotel Subscription` shortcut and link to the existing `Lodgiva Control` workspace alongside `Hotel Environment`.

- [ ] **Step 2: Add the form banner**

When `access_mode` is `read_only`, a headline naming the state and what clears it. When `state` is `past_due`, show `grace_ends_on` and whether notice has been served — an operator fielding an angry phone call needs both facts on screen.

- [ ] **Step 3: Verify in the browser**

Run: open `/app/hotel-subscription` on the control site
Expected: list shows coloured states; a `past_due` record shows its grace date

- [ ] **Step 4: Commit**

```bash
git add frappe-apps/lodgiva_control/lodgiva_control/lodgiva_control/doctype/hotel_subscription frappe-apps/lodgiva_control/lodgiva_control/lodgiva_control/workspace
git commit -m "feat(control): subscription list indicators and form banner"
```

---

## Notes for the executor

- `<control site>` is `control.<apex>` after Task 7 and `kamra.localhost` before it. Tasks 1–6 run against whichever exists.
- The bench needs a running worker for nothing in this plan — the sweep is scheduler-driven and every test calls `evaluate_subscriptions()` directly.
- Task 6 is the only task outside this repository.

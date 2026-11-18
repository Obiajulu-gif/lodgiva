// Hotels Console: every hotel on the platform and what needs a hand.
// Data comes from lodgiva_control.console.overview; issues are worded as
// actions, so the page reads as an operator's to-do list.

frappe.pages["hotels-console"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("Hotels Console"),
		single_column: true,
	});
	const state = { data: null, attentionOnly: false, query: "" };
	const esc = frappe.utils.escape_html;

	page.set_primary_action(__("New hotel"), () => frappe.new_doc("Hotel Environment"), "add");
	page.set_secondary_action(__("Re-check all sites"), () => load(1), "refresh");
	const search = page.add_field({
		fieldtype: "Data", fieldname: "q", placeholder: __("Search hotel, site, owner"),
		change: () => { state.query = (search.get_value() || "").toLowerCase(); render(); },
	});
	const attention = page.add_field({
		fieldtype: "Check", fieldname: "attention", label: __("Needs attention only"),
		change: () => { state.attentionOnly = !!attention.get_value(); render(); },
	});

	const $body = $(`<div class="hotels-console"></div>`).appendTo(page.main);
	$(`<style>
		.hotels-console { padding: 8px 0 32px; }
		.hc-cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:20px; }
		.hc-card { border:1px solid var(--border-color); border-radius:10px; padding:14px 16px; background:var(--card-bg); }
		.hc-card .n { font-size:26px; font-weight:600; line-height:1.1; }
		.hc-card .l { color:var(--text-muted); font-size:12px; margin-top:4px; }
		.hc-card.bad .n { color:var(--red-600); }
		.hc-row { border:1px solid var(--border-color); border-radius:10px; padding:14px 16px; margin-bottom:12px; background:var(--card-bg); }
		.hc-row.critical { border-left:4px solid var(--red-500); }
		.hc-row.warning { border-left:4px solid var(--orange-400); }
		.hc-head { display:flex; flex-wrap:wrap; gap:8px 16px; align-items:baseline; justify-content:space-between; }
		.hc-title { font-size:15px; font-weight:600; }
		.hc-meta { color:var(--text-muted); font-size:12px; }
		.hc-stats { display:flex; flex-wrap:wrap; gap:6px 18px; margin:10px 0 6px; font-size:12px; color:var(--text-muted); }
		.hc-stats b { color:var(--text-color); font-weight:600; }
		.hc-issues { list-style:none; padding:0; margin:8px 0 0; }
		.hc-issues li { font-size:13px; padding:3px 0 3px 18px; position:relative; }
		.hc-issues li:before { content:""; position:absolute; left:2px; top:9px; width:8px; height:8px; border-radius:50%; }
		.hc-issues li.critical:before { background:var(--red-500); }
		.hc-issues li.warning:before { background:var(--orange-400); }
		.hc-issues li.info:before { background:var(--blue-400); }
		.hc-ok { color:var(--green-600); font-size:13px; margin-top:8px; }
		.hc-actions { display:flex; flex-wrap:wrap; gap:6px; margin-top:12px; }
		.hc-log { font-family:var(--font-stack-monospace, monospace); font-size:11px; color:var(--text-muted); margin-top:6px; overflow-wrap:anywhere; }
	</style>`).appendTo(page.main);

	function load(refresh) {
		$body.html(`<div class="text-muted" style="padding:24px 0">${__("Checking every hotel site...")}</div>`);
		frappe.call({
			method: "lodgiva_control.console.overview",
			args: { refresh: refresh ? 1 : 0 },
			callback: (r) => { state.data = r.message; render(); },
			error: () => $body.html(`<div class="text-danger">${__("Could not load the console.")}</div>`),
		});
	}

	function card(n, label, bad) {
		return `<div class="hc-card ${bad && n ? "bad" : ""}"><div class="n">${n}</div><div class="l">${esc(label)}</div></div>`;
	}

	function badge(text, color) {
		return `<span class="indicator-pill ${color}">${esc(text)}</span>`;
	}

	const STATUS = { Active: "green", Provisioning: "blue", Failed: "red", Draft: "gray", Unregistered: "orange" };
	const SUB = { trialing: "blue", active: "green", past_due: "orange", unpaid: "red", free: "gray", cancelled: "gray" };

	function worst(row) {
		if (row.issues.some((i) => i.level === "critical")) return "critical";
		if (row.issues.some((i) => i.level === "warning")) return "warning";
		return "";
	}

	function rowHtml(r) {
		const h = r.health || {};
		const sub = r.subscription;
		const stats = h.error || !r.health ? "" : `<div class="hc-stats">
			<span>${__("Staff")} <b>${h.users ?? 0}</b></span>
			<span>${__("Rooms")} <b>${h.rooms ?? "-"}</b></span>
			<span>${__("In house")} <b>${h.in_house ?? "-"}</b></span>
			<span>${__("Bookings, 30 days")} <b>${h.bookings_30d ?? "-"}</b></span>
			<span>${__("Last booking")} <b>${h.last_booking ? frappe.datetime.prettyDate(h.last_booking) : "-"}</b></span>
			<span>${__("Last sign-in")} <b>${h.last_login ? frappe.datetime.prettyDate(h.last_login) : __("never")}</b></span>
			<span>${__("Business date")} <b>${esc(h.business_date || "-")}</b></span>
			<span>${__("Access applied")} <b>${esc(h.access_mode || "-")}</b></span>
			<span>${__("Version")} <b>${esc(Object.entries(h.version || {}).map(([a, v]) => `${a} ${v}`).join(" · ") || "-")}</b></span>
			<span>${__("Health checked")} <b>${h.checked_at ? frappe.datetime.prettyDate(h.checked_at) : "-"}</b></span>
		</div>`;
		const b = r.backups || {};
		const when = (ev) => (ev ? frappe.datetime.prettyDate(ev.at) : __("never"));
		const backups = r.status === "Active" ? `<div class="hc-stats">
			<span>${__("Local backup")} <b>${h.last_local_backup ? frappe.datetime.prettyDate(h.last_local_backup) : __("never")}</b></span>
			<span>${__("Off-server copy")} <b>${when(b["Off-site copy"])}</b></span>
			<span>${__("Restore verified")} <b>${when(b["Restore verified"])}</b>${b["Restore verified"] && b["Restore verified"].duration_s ? ` (${b["Restore verified"].duration_s}s)` : ""}</span>
			${sub && sub.grace_ends_on ? `<span>${__("Grace ends")} <b>${esc(sub.grace_ends_on)}</b></span>` : ""}
		</div>` : "";
		const grants = (r.support || []).map((g) =>
			`<div class="hc-meta">${__("Support access")} ${esc(g.name)} · ${esc(g.granted_to)} · ${__("until")} ${esc(g.expires_at)} · ${esc(g.reason)}
			<button class="btn btn-xs btn-link" data-act="revoke" data-name="${esc(g.name)}">${__("Revoke")}</button></div>`).join("");
		const issues = r.issues.length
			? `<ul class="hc-issues">${r.issues.map((i) => `<li class="${i.level}">${esc(i.text)}</li>`).join("")}</ul>`
			: `<div class="hc-ok">${__("Healthy - nothing to do.")}</div>`;
		const log = r.status === "Failed" && r.last_log ? `<div class="hc-log">${esc(r.last_log)}</div>` : "";
		const actions = [];
		if (r.on_disk) actions.push(`<a class="btn btn-xs btn-default" href="${esc(r.url)}" target="_blank" rel="noopener">${__("Open hotel site")}</a>`);
		if (r.name) actions.push(`<a class="btn btn-xs btn-default" href="/app/hotel-environment/${encodeURIComponent(r.name)}">${__("Record & log")}</a>`);
		if (sub) actions.push(`<a class="btn btn-xs btn-default" href="/app/hotel-subscription/${encodeURIComponent(sub.name)}">${__("Subscription")}</a>`);
		if (r.status === "Failed") actions.push(`<button class="btn btn-xs btn-primary" data-act="retry" data-name="${esc(r.name)}">${__("Retry provisioning")}</button>`);
		if (sub && ["past_due", "unpaid"].includes(sub.state)) actions.push(`<button class="btn btn-xs btn-primary" data-act="paid" data-name="${esc(sub.name)}">${__("Mark paid")}</button>`);
		if (r.owner_email) actions.push(`<a class="btn btn-xs btn-default" href="mailto:${esc(r.owner_email)}">${__("Email owner")}</a>`);
		if (r.status === "Active" && r.name) {
			actions.push(`<button class="btn btn-xs btn-default" data-act="activation" data-name="${esc(r.name)}">${__("Resend activation")}</button>`);
			actions.push(`<button class="btn btn-xs btn-default" data-act="support" data-name="${esc(r.name)}">${__("Support access")}</button>`);
		}
		return `<div class="hc-row ${worst(r)}">
			<div class="hc-head">
				<div>
					<div class="hc-title">${esc(r.customer_name || r.site_name)}</div>
					<div class="hc-meta">${esc(r.site_name)}${r.owner_email ? " · " + esc(r.owner_email) : ""}${r.city ? " · " + esc(r.city) : ""}${r.creation ? " · " + __("joined {0}", [frappe.datetime.prettyDate(r.creation)]) : ""}</div>
				</div>
				<div>
					${badge(r.status, STATUS[r.status] || "gray")}
					${sub ? badge(`${sub.plan || ""} · ${sub.state}${sub.state === "trialing" && sub.trial_ends_on ? " → " + sub.trial_ends_on : ""}`, SUB[sub.state] || "gray") : ""}
				</div>
			</div>
			${stats}${backups}${issues}${log}${grants}
			<div class="hc-actions">${actions.join("")}</div>
		</div>`;
	}

	// The platform exception queue: what broke, where, when, and the next step.
	function exceptionsHtml(list) {
		if (!list.length) return `<div class="hc-ok" style="margin-bottom:12px">${__("No exceptions: provisioning, jobs, backups and billing are all in order.")}</div>`;
		const act = (a) => !a ? "" : a.act
			? `<button class="btn btn-xs btn-primary" data-act="${esc(a.act)}" data-name="${esc(a.name || "")}">${esc(__(a.label))}</button>`
			: `<a class="btn btn-xs btn-default" href="${esc(a.href)}">${esc(__(a.label))}</a>`;
		return `<h5 style="margin:4px 0 10px">${__("Exceptions")} (${list.length})</h5>
		<table class="table table-bordered" style="background:var(--card-bg);font-size:13px">
			<thead><tr><th>${__("Site")}</th><th>${__("What happened")}</th><th>${__("When")}</th><th>${__("Next action")}</th></tr></thead>
			<tbody>${list.map((e) => `<tr>
				<td>${badge(e.level, e.level === "critical" ? "red" : "orange")} ${esc(e.site)}</td>
				<td>${esc(e.what)}</td>
				<td style="white-space:nowrap">${e.when && e.when !== "never" ? esc(frappe.datetime.prettyDate(e.when)) : esc(e.when || "-")}</td>
				<td>${act(e.action)}</td></tr>`).join("")}</tbody>
		</table>`;
	}

	function render() {
		const d = state.data;
		if (!d) return;
		const s = d.summary;
		let rows = d.rows;
		if (state.attentionOnly) rows = rows.filter((r) => worst(r));
		if (state.query) rows = rows.filter((r) =>
			[r.customer_name, r.site_name, r.owner_email, r.city].some((v) => (v || "").toLowerCase().includes(state.query)));
		$body.html(`
			<div class="hc-cards">
				${card(s.hotels, __("Hotels"))}
				${card(s.active, __("Active"))}
				${card(s.trialing, __("On trial"))}
				${card(s.paying, __("Paying"))}
				${card(s.at_risk, __("Payment at risk"), true)}
				${card(s.attention, __("Need attention now"), true)}
				${card(s.bookings_30d, __("Bookings, 30 days"))}
			</div>
			${exceptionsHtml(d.exceptions || [])}
			<h5 style="margin:18px 0 10px">${__("Customer sites")}</h5>
			${rows.map(rowHtml).join("") || `<div class="text-muted">${__("No hotels match.")}</div>`}
			<div class="hc-meta" style="margin-top:8px">${__("Checked {0}. Site health is cached for 5 minutes; Re-check all sites forces a fresh read.", [frappe.datetime.prettyDate(d.generated_at)])}</div>
		`);
	}

	$body.on("click", "button[data-act]", function () {
		const { act, name } = this.dataset;
		const run = (method, args, msg) => frappe.confirm(msg, () =>
			frappe.call({ method, args, freeze: true, callback: () => load(1) }));
		if (act === "retry") run(
			"lodgiva_control.lodgiva_control.doctype.hotel_environment.hotel_environment.retry",
			{ docname: name }, __("Re-run provisioning for {0}?", [name]));
		if (act === "activation") run(
			"lodgiva_control.provisioning.resend_activation",
			{ docname: name }, __("Send {0}'s owner a new activation link? The old link stops working.", [name]));
		if (act === "revoke") run(
			"lodgiva_control.support.revoke",
			{ grant_name: name }, __("Revoke support access {0} now?", [name]));
		if (act === "support") {
			const d = new frappe.ui.Dialog({
				title: __("Support access to {0}", [name]),
				fields: [
					{ fieldtype: "Small Text", fieldname: "reason", label: __("Reason (goes on the record)"), reqd: 1 },
					{ fieldtype: "Float", fieldname: "hours", label: __("Hours (max 24)"), default: 2, reqd: 1 },
				],
				primary_action_label: __("Grant"),
				primary_action: (v) => frappe.call({
					method: "lodgiva_control.support.grant", args: { hotel_environment: name, ...v }, freeze: true,
					callback: (r) => {
						d.hide();
						const g = r.message;
						frappe.msgprint({
							title: __("Access {0} until {1}", [g.grant, g.expires_at]),
							message: `<p>${__("Sign in at")} <a href="${esc(g.login)}" target="_blank" rel="noopener">${esc(g.login)}</a></p>
								<p>${__("User")}: <code>${esc(g.user)}</code><br>${__("Password (shown once)")}: <code>${esc(g.password)}</code></p>`,
						});
						load(1);
					},
				}),
			});
			d.show();
		}
		if (act === "paid") run(
			"lodgiva_control.subscription.mark_payment_succeeded",
			{ subscription: name }, __("Record payment received for {0}? This restores full access.", [name]));
	});

	load(0);
};

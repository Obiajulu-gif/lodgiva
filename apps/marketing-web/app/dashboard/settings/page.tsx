"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAuth } from "@/components/providers";
import { api } from "@/lib/api/client";

interface Property {
  id: string;
  name: string;
  code: string;
  timezone: string;
  businessDate: string;
  checkinTime: string;
  checkoutTime: string;
  status: string;
}
interface TaxRule {
  id: string;
  code: string;
  name: string;
  rateBp: number;
  version: number;
  appliesTo: string;
  effectiveFrom: string;
}
interface Settings {
  property: Property;
  counts: {
    roomTypes: number;
    rooms: number;
    amenities: number;
    activeBlocks: number;
  };
  effectiveTaxRules: TaxRule[];
}

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const { me, selectedPropertyId, retrySession } = useAuth();
  const propertyId = selectedPropertyId || me?.properties[0]?.id || "";
  const canManage =
    me?.permissions.includes("settings.property.manage") ?? false;
  const [changes, setChanges] = useState<
    Partial<
      Pick<
        Property,
        "name" | "timezone" | "checkinTime" | "checkoutTime" | "status"
      >
    >
  >({});
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const settings = useQuery({
    queryKey: ["settings", propertyId],
    queryFn: () => api<Settings>(`/properties/${propertyId}/settings`),
    enabled: Boolean(propertyId),
  });
  const save = useMutation({
    mutationFn: () =>
      api(`/properties/${propertyId}/settings`, {
        method: "PATCH",
        body: changes,
      }),
    onSuccess: async () => {
      setChanges({});
      setError("");
      setNotice("Property settings saved.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["settings", propertyId] }),
        retrySession(),
      ]);
    },
    onError: (cause) =>
      setError(
        cause instanceof Error ? cause.message : "Settings could not be saved.",
      ),
  });
  const property = settings.data?.property;
  const value = (key: keyof typeof changes) =>
    changes[key] ?? property?.[key] ?? "";
  const input =
    "mt-2 w-full rounded-xl border border-ink/10 px-3 py-2.5 text-sm outline-none focus:border-brand-500 disabled:bg-cream disabled:text-ink/50";
  return (
    <div className="space-y-7">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold">
            Property Settings
          </h1>
          <p className="mt-1 text-sm text-ink/55">
            {property?.name ?? "Property configuration"}
            {canManage ? "" : " · read-only for your role"}
          </p>
        </div>
        <span className="rounded-full bg-white px-3 py-1.5 text-xs font-semibold shadow-sm">
          {me?.role.replaceAll("_", " ")}
        </span>
      </header>
      {error ? (
        <button
          type="button"
          onClick={() => setError("")}
          className="w-full rounded-xl bg-red-50 p-3 text-left text-sm text-red-700"
        >
          {error} — dismiss
        </button>
      ) : null}
      {notice ? (
        <p className="rounded-xl bg-brand-50 p-3 text-sm text-brand-700">
          {notice}
        </p>
      ) : null}
      {property ? (
        <div className="grid gap-6 xl:grid-cols-2">
          <section className="rounded-2xl bg-white p-6 shadow-sm">
            <h2 className="font-semibold">Property profile</h2>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <label className="text-xs font-semibold text-ink/60 sm:col-span-2">
                Name
                <input
                  disabled={!canManage}
                  value={value("name")}
                  onChange={(event) =>
                    setChanges((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                  className={input}
                />
              </label>
              <label className="text-xs font-semibold text-ink/60">
                Property code
                <input
                  disabled
                  value={property.code}
                  className={input}
                  title="Property codes are immutable"
                />
              </label>
              <label className="text-xs font-semibold text-ink/60">
                Timezone
                <input
                  disabled={!canManage}
                  value={value("timezone")}
                  onChange={(event) =>
                    setChanges((current) => ({
                      ...current,
                      timezone: event.target.value,
                    }))
                  }
                  className={input}
                />
              </label>
              <label className="text-xs font-semibold text-ink/60">
                Check-in time
                <input
                  disabled={!canManage}
                  type="time"
                  value={value("checkinTime")}
                  onChange={(event) =>
                    setChanges((current) => ({
                      ...current,
                      checkinTime: event.target.value,
                    }))
                  }
                  className={input}
                />
              </label>
              <label className="text-xs font-semibold text-ink/60">
                Check-out time
                <input
                  disabled={!canManage}
                  type="time"
                  value={value("checkoutTime")}
                  onChange={(event) =>
                    setChanges((current) => ({
                      ...current,
                      checkoutTime: event.target.value,
                    }))
                  }
                  className={input}
                />
              </label>
              <label className="text-xs font-semibold text-ink/60">
                Status
                <select
                  disabled={!canManage}
                  value={value("status")}
                  onChange={(event) =>
                    setChanges((current) => ({
                      ...current,
                      status: event.target.value as Property["status"],
                    }))
                  }
                  className={input}
                >
                  <option value="ACTIVE">Active</option>
                  <option value="INACTIVE">Inactive</option>
                </select>
              </label>
              <label className="text-xs font-semibold text-ink/60">
                Business date
                <input
                  disabled
                  value={property.businessDate}
                  className={input}
                  title="Business date advances only through night audit"
                />
              </label>
            </div>
            {canManage ? (
              <button
                type="button"
                disabled={!Object.keys(changes).length || save.isPending}
                onClick={() => save.mutate()}
                className="mt-6 rounded-full bg-brand-800 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
              >
                {save.isPending ? "Saving…" : "Save changes"}
              </button>
            ) : null}
          </section>
          <section className="space-y-6">
            <div className="grid grid-cols-2 gap-3">
              {Object.entries(settings.data?.counts ?? {}).map(
                ([label, count]) => (
                  <div
                    key={label}
                    className="rounded-2xl bg-white p-5 shadow-sm"
                  >
                    <p className="text-xs capitalize text-ink/45">
                      {label.replace(/([A-Z])/g, " $1")}
                    </p>
                    <p className="mt-2 font-display text-2xl font-semibold">
                      {count}
                    </p>
                  </div>
                ),
              )}
            </div>
            <div className="rounded-2xl bg-white p-6 shadow-sm">
              <h2 className="font-semibold">Effective tax rules</h2>
              <div className="mt-4 divide-y divide-ink/5">
                {(settings.data?.effectiveTaxRules ?? []).map((rule) => (
                  <div
                    key={rule.id}
                    className="flex justify-between gap-4 py-3 text-sm"
                  >
                    <span>
                      <strong>{rule.name}</strong>
                      <span className="ml-2 text-xs text-ink/40">
                        v{rule.version} · {rule.appliesTo}
                      </span>
                    </span>
                    <span className="font-semibold">
                      {(rule.rateBp / 100).toFixed(2)}%
                    </span>
                  </div>
                ))}
              </div>
              {!settings.data?.effectiveTaxRules.length ? (
                <p className="mt-5 text-sm text-ink/45">
                  No effective tax rules for this business date.
                </p>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
      {settings.isError ? (
        <p className="rounded-xl bg-red-50 p-4 text-sm text-red-700">
          {settings.error.message}
        </p>
      ) : null}
    </div>
  );
}

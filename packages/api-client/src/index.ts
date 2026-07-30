/* AUTO-GENERATED from docs/openapi.json — do not edit by hand.
 * Regenerate with: pnpm --filter @lodgiva/database generate:client
 *
 * Request bodies are typed as `unknown`: the API validates them with Zod at
 * runtime, so the OpenAPI document does not describe body schemas. See
 * docs/api-reference.md for the body contracts.
 */

export interface LodgivaClientOptions {
  baseUrl?: string;
  /** Called before each request; return the current access token. */
  getToken?: () => string | null | undefined;
  fetch?: typeof globalThis.fetch;
}

export class LodgivaApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "LodgivaApiError";
  }
}

type Query = Record<string, string | number | boolean | undefined>;

export class LodgivaClient {
  private readonly baseUrl: string;
  private readonly getToken: () => string | null | undefined;
  private readonly doFetch: typeof globalThis.fetch;

  constructor(options: LodgivaClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
    this.getToken = options.getToken ?? (() => null);
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async request<T>(
    method: string,
    path: string,
    options: { query?: Query; body?: unknown } = {}
  ): Promise<T> {
    const url = new URL(this.baseUrl + path, this.baseUrl || "http://localhost");
    for (const [k, v] of Object.entries(options.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const token = this.getToken();
    const res = await this.doFetch(this.baseUrl ? url.toString() : url.pathname + url.search, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const err = (data as { error?: { code?: string; message?: string; details?: unknown } })?.error;
      throw new LodgivaApiError(
        err?.code ?? "UNKNOWN",
        err?.message ?? `Request failed with ${res.status}`,
        res.status,
        err?.details
      );
    }
    return data as T;
  }

  /** GET /api/v1/health/live (Health) */
  healthcontrollerLive<T = unknown>(): Promise<T> {
    return this.request<T>("GET", `/api/v1/health/live`);
  }

  /** GET /api/v1/health/ready (Health) */
  healthcontrollerReady<T = unknown>(): Promise<T> {
    return this.request<T>("GET", `/api/v1/health/ready`);
  }

  /** POST /api/v1/auth/login (Auth) */
  authcontrollerLogin<T = unknown>(body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/auth/login`, { body });
  }

  /** POST /api/v1/auth/refresh (Auth) */
  authcontrollerRefresh<T = unknown>(body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/auth/refresh`, { body });
  }

  /** POST /api/v1/auth/logout (Auth) */
  authcontrollerLogout<T = unknown>(body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/auth/logout`, { body });
  }

  /** GET /api/v1/auth/me (Auth) */
  authcontrollerMe<T = unknown>(): Promise<T> {
    return this.request<T>("GET", `/api/v1/auth/me`);
  }

  /** GET /api/v1/auth/sessions (Auth) */
  authcontrollerSessions<T = unknown>(): Promise<T> {
    return this.request<T>("GET", `/api/v1/auth/sessions`);
  }

  /** DELETE /api/v1/auth/sessions (Auth) */
  authcontrollerRevokeall<T = unknown>(): Promise<T> {
    return this.request<T>("DELETE", `/api/v1/auth/sessions`);
  }

  /** DELETE /api/v1/auth/sessions/{id} (Auth) */
  authcontrollerRevokesession<T = unknown>(id: string): Promise<T> {
    return this.request<T>("DELETE", `/api/v1/auth/sessions/${id}`);
  }

  /** POST /api/v1/onboarding/tenants (Admin) */
  admincontrollerOnboard<T = unknown>(body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/onboarding/tenants`, { body });
  }

  /** POST /api/v1/onboarding/invitations/accept (Admin) */
  admincontrollerAccept<T = unknown>(body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/onboarding/invitations/accept`, { body });
  }

  /** POST /api/v1/properties (Admin) */
  admincontrollerCreateproperty<T = unknown>(body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/properties`, { body });
  }

  /** GET /api/v1/properties (Properties) */
  propertiescontrollerList<T = unknown>(): Promise<T> {
    return this.request<T>("GET", `/api/v1/properties`);
  }

  /** GET /api/v1/memberships (Admin) */
  admincontrollerMemberships<T = unknown>(): Promise<T> {
    return this.request<T>("GET", `/api/v1/memberships`);
  }

  /** PATCH /api/v1/memberships/{id} (Admin) */
  admincontrollerUpdatemembership<T = unknown>(id: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", `/api/v1/memberships/${id}`, { body });
  }

  /** POST /api/v1/invitations (Admin) */
  admincontrollerInvite<T = unknown>(body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/invitations`, { body });
  }

  /** GET /api/v1/invitations (Admin) */
  admincontrollerListinvitations<T = unknown>(query?: { status?: string | number | boolean }): Promise<T> {
    return this.request<T>("GET", `/api/v1/invitations`, { query });
  }

  /** POST /api/v1/invitations/{id}/revoke (Admin) */
  admincontrollerRevokeinvitation<T = unknown>(id: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/invitations/${id}/revoke`, { body });
  }

  /** GET /api/v1/properties/{id}/room-rack (Properties) */
  propertiescontrollerRoomrack<T = unknown>(id: string): Promise<T> {
    return this.request<T>("GET", `/api/v1/properties/${id}/room-rack`);
  }

  /** GET /api/v1/properties/{id}/room-types (Properties) */
  propertiescontrollerRoomtypes<T = unknown>(id: string): Promise<T> {
    return this.request<T>("GET", `/api/v1/properties/${id}/room-types`);
  }

  /** PATCH /api/v1/rooms/{id}/status (Properties) */
  propertiescontrollerSetroomstatus<T = unknown>(id: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", `/api/v1/rooms/${id}/status`, { body });
  }

  /** GET /api/v1/properties/{id}/settings (Config) */
  configcontrollerGetsettings<T = unknown>(id: string): Promise<T> {
    return this.request<T>("GET", `/api/v1/properties/${id}/settings`);
  }

  /** PATCH /api/v1/properties/{id}/settings (Config) */
  configcontrollerUpdatesettings<T = unknown>(id: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", `/api/v1/properties/${id}/settings`, { body });
  }

  /** GET /api/v1/properties/{id}/business-date (Config) */
  configcontrollerBusinessdate<T = unknown>(id: string): Promise<T> {
    return this.request<T>("GET", `/api/v1/properties/${id}/business-date`);
  }

  /** GET /api/v1/config/room-types (Config) */
  configcontrollerListroomtypes<T = unknown>(query?: { propertyId?: string | number | boolean }): Promise<T> {
    return this.request<T>("GET", `/api/v1/config/room-types`, { query });
  }

  /** POST /api/v1/config/room-types (Config) */
  configcontrollerCreateroomtype<T = unknown>(body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/config/room-types`, { body });
  }

  /** PATCH /api/v1/config/room-types/{id} (Config) */
  configcontrollerUpdateroomtype<T = unknown>(id: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", `/api/v1/config/room-types/${id}`, { body });
  }

  /** DELETE /api/v1/config/room-types/{id} (Config) */
  configcontrollerDeleteroomtype<T = unknown>(id: string): Promise<T> {
    return this.request<T>("DELETE", `/api/v1/config/room-types/${id}`);
  }

  /** GET /api/v1/config/rooms (Config) */
  configcontrollerListrooms<T = unknown>(query?: { propertyId?: string | number | boolean }): Promise<T> {
    return this.request<T>("GET", `/api/v1/config/rooms`, { query });
  }

  /** POST /api/v1/config/rooms (Config) */
  configcontrollerCreateroom<T = unknown>(body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/config/rooms`, { body });
  }

  /** DELETE /api/v1/config/rooms/{id} (Config) */
  configcontrollerDeleteroom<T = unknown>(id: string): Promise<T> {
    return this.request<T>("DELETE", `/api/v1/config/rooms/${id}`);
  }

  /** GET /api/v1/config/amenities (Config) */
  configcontrollerListamenities<T = unknown>(query?: { propertyId?: string | number | boolean }): Promise<T> {
    return this.request<T>("GET", `/api/v1/config/amenities`, { query });
  }

  /** POST /api/v1/config/amenities (Config) */
  configcontrollerCreateamenity<T = unknown>(body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/config/amenities`, { body });
  }

  /** DELETE /api/v1/config/amenities/{id} (Config) */
  configcontrollerDeleteamenity<T = unknown>(id: string): Promise<T> {
    return this.request<T>("DELETE", `/api/v1/config/amenities/${id}`);
  }

  /** GET /api/v1/config/room-blocks (Config) */
  configcontrollerListblocks<T = unknown>(query?: { propertyId?: string | number | boolean; status?: string | number | boolean }): Promise<T> {
    return this.request<T>("GET", `/api/v1/config/room-blocks`, { query });
  }

  /** POST /api/v1/config/room-blocks (Config) */
  configcontrollerCreateblock<T = unknown>(body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/config/room-blocks`, { body });
  }

  /** POST /api/v1/config/room-blocks/{id}/release (Config) */
  configcontrollerReleaseblock<T = unknown>(id: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/config/room-blocks/${id}/release`, { body });
  }

  /** POST /api/v1/config/imports/rooms (Config) */
  configcontrollerImportrooms<T = unknown>(body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/config/imports/rooms`, { body });
  }

  /** GET /api/v1/guests (Guests) */
  guestscontrollerSearch<T = unknown>(query?: { q?: string | number | boolean }): Promise<T> {
    return this.request<T>("GET", `/api/v1/guests`, { query });
  }

  /** POST /api/v1/guests (Guests) */
  guestscontrollerCreate<T = unknown>(body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/guests`, { body });
  }

  /** GET /api/v1/guests/{id} (Guests) */
  guestscontrollerGet<T = unknown>(id: string): Promise<T> {
    return this.request<T>("GET", `/api/v1/guests/${id}`);
  }

  /** GET /api/v1/reservations/availability (Reservations) */
  reservationscontrollerAvailability<T = unknown>(query?: { propertyId?: string | number | boolean; arrival?: string | number | boolean; departure?: string | number | boolean }): Promise<T> {
    return this.request<T>("GET", `/api/v1/reservations/availability`, { query });
  }

  /** GET /api/v1/reservations (Reservations) */
  reservationscontrollerList<T = unknown>(query?: { propertyId?: string | number | boolean; status?: string | number | boolean }): Promise<T> {
    return this.request<T>("GET", `/api/v1/reservations`, { query });
  }

  /** POST /api/v1/reservations (Reservations) */
  reservationscontrollerCreate<T = unknown>(body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/reservations`, { body });
  }

  /** GET /api/v1/reservations/{id} (Reservations) */
  reservationscontrollerGet<T = unknown>(id: string): Promise<T> {
    return this.request<T>("GET", `/api/v1/reservations/${id}`);
  }

  /** POST /api/v1/reservations/{id}/check-in (Reservations) */
  reservationscontrollerCheckin<T = unknown>(id: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/reservations/${id}/check-in`, { body });
  }

  /** POST /api/v1/reservations/{id}/check-out (Reservations) */
  reservationscontrollerCheckout<T = unknown>(id: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/reservations/${id}/check-out`, { body });
  }

  /** POST /api/v1/reservations/{id}/room-move (Reservations) */
  reservationscontrollerRoommove<T = unknown>(id: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/reservations/${id}/room-move`, { body });
  }

  /** POST /api/v1/reservations/{id}/extend (Reservations) */
  reservationscontrollerExtend<T = unknown>(id: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/reservations/${id}/extend`, { body });
  }

  /** POST /api/v1/reservations/{id}/cancel (Reservations) */
  reservationscontrollerCancel<T = unknown>(id: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/reservations/${id}/cancel`, { body });
  }

  /** POST /api/v1/reservations/{id}/no-show (Reservations) */
  reservationscontrollerNoshow<T = unknown>(id: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/reservations/${id}/no-show`, { body });
  }

  /** GET /api/v1/folios/{id} (Folios) */
  folioscontrollerGet<T = unknown>(id: string): Promise<T> {
    return this.request<T>("GET", `/api/v1/folios/${id}`);
  }

  /** POST /api/v1/folios/{id}/charges (Folios) */
  folioscontrollerPostcharge<T = unknown>(id: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/folios/${id}/charges`, { body });
  }

  /** POST /api/v1/folios/{id}/entries/{entryId}/reverse (Folios) */
  folioscontrollerReverse<T = unknown>(id: string, entryId: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/folios/${id}/entries/${entryId}/reverse`, { body });
  }

  /** POST /api/v1/payments (Payments) */
  paymentscontrollerRecord<T = unknown>(body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/payments`, { body });
  }

  /** GET /api/v1/payments (Payments) */
  paymentscontrollerList<T = unknown>(query?: { propertyId?: string | number | boolean }): Promise<T> {
    return this.request<T>("GET", `/api/v1/payments`, { query });
  }

  /** GET /api/v1/housekeeping/tasks (Housekeeping) */
  housekeepingcontrollerList<T = unknown>(query?: { propertyId?: string | number | boolean }): Promise<T> {
    return this.request<T>("GET", `/api/v1/housekeeping/tasks`, { query });
  }

  /** POST /api/v1/housekeeping/tasks (Housekeeping) */
  housekeepingcontrollerCreate<T = unknown>(body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/housekeeping/tasks`, { body });
  }

  /** POST /api/v1/housekeeping/tasks/{id}/advance (Housekeeping) */
  housekeepingcontrollerAdvance<T = unknown>(id: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/housekeeping/tasks/${id}/advance`, { body });
  }

  /** GET /api/v1/pos/outlets (Pos) */
  poscontrollerOutlets<T = unknown>(query?: { propertyId?: string | number | boolean }): Promise<T> {
    return this.request<T>("GET", `/api/v1/pos/outlets`, { query });
  }

  /** GET /api/v1/pos/orders (Pos) */
  poscontrollerOrders<T = unknown>(query?: { propertyId?: string | number | boolean }): Promise<T> {
    return this.request<T>("GET", `/api/v1/pos/orders`, { query });
  }

  /** POST /api/v1/pos/orders (Pos) */
  poscontrollerCreate<T = unknown>(body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/pos/orders`, { body });
  }

  /** POST /api/v1/pos/orders/{id}/settle (Pos) */
  poscontrollerSettle<T = unknown>(id: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/pos/orders/${id}/settle`, { body });
  }

  /** POST /api/v1/pos/orders/{id}/void (Pos) */
  poscontrollerVoidorder<T = unknown>(id: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/pos/orders/${id}/void`, { body });
  }

  /** GET /api/v1/cashiering/shifts (Cashiering) */
  cashieringcontrollerList<T = unknown>(query?: { propertyId?: string | number | boolean }): Promise<T> {
    return this.request<T>("GET", `/api/v1/cashiering/shifts`, { query });
  }

  /** POST /api/v1/cashiering/shifts (Cashiering) */
  cashieringcontrollerOpen<T = unknown>(body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/cashiering/shifts`, { body });
  }

  /** GET /api/v1/cashiering/shifts/{id} (Cashiering) */
  cashieringcontrollerGet<T = unknown>(id: string): Promise<T> {
    return this.request<T>("GET", `/api/v1/cashiering/shifts/${id}`);
  }

  /** POST /api/v1/cashiering/shifts/{id}/movements (Cashiering) */
  cashieringcontrollerMovement<T = unknown>(id: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/cashiering/shifts/${id}/movements`, { body });
  }

  /** POST /api/v1/cashiering/shifts/{id}/close (Cashiering) */
  cashieringcontrollerClose<T = unknown>(id: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/cashiering/shifts/${id}/close`, { body });
  }

  /** POST /api/v1/cashiering/shifts/{id}/approve (Cashiering) */
  cashieringcontrollerApprove<T = unknown>(id: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/cashiering/shifts/${id}/approve`, { body });
  }

  /** GET /api/v1/maintenance/tickets (Maintenance) */
  maintenancecontrollerList<T = unknown>(query?: { propertyId?: string | number | boolean }): Promise<T> {
    return this.request<T>("GET", `/api/v1/maintenance/tickets`, { query });
  }

  /** POST /api/v1/maintenance/tickets (Maintenance) */
  maintenancecontrollerCreate<T = unknown>(body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/maintenance/tickets`, { body });
  }

  /** POST /api/v1/maintenance/tickets/{id}/status (Maintenance) */
  maintenancecontrollerSetstatus<T = unknown>(id: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/maintenance/tickets/${id}/status`, { body });
  }

  /** GET /api/v1/rates/plans (Rates) */
  ratescontrollerListplans<T = unknown>(query?: { propertyId?: string | number | boolean }): Promise<T> {
    return this.request<T>("GET", `/api/v1/rates/plans`, { query });
  }

  /** POST /api/v1/rates/plans (Rates) */
  ratescontrollerCreateplan<T = unknown>(body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/rates/plans`, { body });
  }

  /** POST /api/v1/rates/calendar (Rates) */
  ratescontrollerSetdailyrates<T = unknown>(body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/rates/calendar`, { body });
  }

  /** GET /api/v1/rates/calendar (Rates) */
  ratescontrollerCalendar<T = unknown>(query?: { ratePlanId?: string | number | boolean; from?: string | number | boolean; to?: string | number | boolean }): Promise<T> {
    return this.request<T>("GET", `/api/v1/rates/calendar`, { query });
  }

  /** GET /api/v1/rates/quote (Rates) */
  ratescontrollerQuote<T = unknown>(query?: { propertyId?: string | number | boolean; ratePlanId?: string | number | boolean; arrival?: string | number | boolean; departure?: string | number | boolean }): Promise<T> {
    return this.request<T>("GET", `/api/v1/rates/quote`, { query });
  }

  /** GET /api/v1/properties/tax-rules (Rates) */
  ratescontrollerListtaxrules<T = unknown>(query?: { propertyId?: string | number | boolean }): Promise<T> {
    return this.request<T>("GET", `/api/v1/properties/tax-rules`, { query });
  }

  /** POST /api/v1/properties/tax-rules (Rates) */
  ratescontrollerUpserttaxrule<T = unknown>(body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/properties/tax-rules`, { body });
  }

  /** POST /api/v1/sync/mutations (Sync) */
  synccontrollerPush<T = unknown>(body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/sync/mutations`, { body });
  }

  /** GET /api/v1/approvals (Approvals) */
  approvalscontrollerList<T = unknown>(query?: { propertyId?: string | number | boolean; status?: string | number | boolean }): Promise<T> {
    return this.request<T>("GET", `/api/v1/approvals`, { query });
  }

  /** POST /api/v1/approvals/discounts (Approvals) */
  approvalscontrollerRequestdiscount<T = unknown>(body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/approvals/discounts`, { body });
  }

  /** POST /api/v1/approvals/{id}/approve (Approvals) */
  approvalscontrollerApprove<T = unknown>(id: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/approvals/${id}/approve`, { body });
  }

  /** POST /api/v1/approvals/{id}/reject (Approvals) */
  approvalscontrollerReject<T = unknown>(id: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/approvals/${id}/reject`, { body });
  }

  /** POST /api/v1/night-audit/run (NightAudit) */
  nightauditcontrollerRun<T = unknown>(body?: unknown): Promise<T> {
    return this.request<T>("POST", `/api/v1/night-audit/run`, { body });
  }

  /** GET /api/v1/night-audit/history (NightAudit) */
  nightauditcontrollerHistory<T = unknown>(query?: { propertyId?: string | number | boolean }): Promise<T> {
    return this.request<T>("GET", `/api/v1/night-audit/history`, { query });
  }

  /** GET /api/v1/reports/daily-flash (Reports) */
  reportscontrollerDailyflash<T = unknown>(query?: { propertyId?: string | number | boolean }): Promise<T> {
    return this.request<T>("GET", `/api/v1/reports/daily-flash`, { query });
  }

  /** GET /api/v1/reports/audit-trail (Reports) */
  reportscontrollerAudittrail<T = unknown>(query?: { propertyId?: string | number | boolean }): Promise<T> {
    return this.request<T>("GET", `/api/v1/reports/audit-trail`, { query });
  }

  /** GET /api/v1/reports/tax-summary (Reports) */
  reportscontrollerTaxsummary<T = unknown>(query?: { propertyId?: string | number | boolean; from?: string | number | boolean; to?: string | number | boolean }): Promise<T> {
    return this.request<T>("GET", `/api/v1/reports/tax-summary`, { query });
  }

  /** GET /api/v1/reports/guest-ledger (Reports) */
  reportscontrollerGuestledger<T = unknown>(query?: { propertyId?: string | number | boolean; from?: string | number | boolean; to?: string | number | boolean }): Promise<T> {
    return this.request<T>("GET", `/api/v1/reports/guest-ledger`, { query });
  }

  /** GET /api/v1/reports/export (Reports) */
  reportscontrollerExportcsv<T = unknown>(query?: { propertyId?: string | number | boolean; type?: string | number | boolean; from?: string | number | boolean; to?: string | number | boolean }): Promise<T> {
    return this.request<T>("GET", `/api/v1/reports/export`, { query });
  }
}

export default LodgivaClient;

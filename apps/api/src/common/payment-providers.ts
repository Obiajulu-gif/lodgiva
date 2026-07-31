import { createHmac, createHash, timingSafeEqual } from "crypto";

/**
 * §13.1 payment provider abstraction.
 *
 * Everything a gateway must do sits behind this interface so the folio layer
 * never learns which provider took the money. Two rules are non-negotiable and
 * are enforced here rather than left to each adapter:
 *
 *  1. A payment is only ever confirmed from a server-side signal — a verified
 *     webhook or an explicit verify call. A browser redirect back from a
 *     gateway proves nothing; anyone can navigate to a success URL.
 *  2. Signatures are computed over the EXACT bytes received. Parsing JSON and
 *     re-serialising changes whitespace and key order, which silently breaks
 *     verification and, worse, can make an invalid signature look valid if the
 *     comparison is done loosely.
 */

export interface InitResult {
  reference: string;
  checkoutUrl: string;
  providerRef?: string;
}

export interface VerifyResult {
  verified: boolean;
  amountMinor?: bigint;
  currency?: string;
  providerRef?: string;
  feeMinor?: bigint;
  note: string;
}

export interface WebhookParse {
  /** Stable id used to deduplicate deliveries. */
  externalId: string;
  eventType: string;
  reference?: string;
  providerRef?: string;
  amountMinor?: bigint;
  currency?: string;
  feeMinor?: bigint;
  /** Whether this event means "money received". */
  isSuccessfulPayment: boolean;
}

export interface RefundResult {
  accepted: boolean;
  providerRef?: string;
  note: string;
}

export interface PaymentProvider {
  readonly name: string;
  /** True when the adapter has credentials and can reach the real gateway. */
  readonly live: boolean;

  initialize(input: {
    reference: string;
    amountMinor: bigint;
    currency: string;
    email: string;
    callbackUrl?: string;
  }): Promise<InitResult>;

  verify(reference: string): Promise<VerifyResult>;

  /** Verifies a webhook against the raw request bytes. */
  verifySignature(rawBody: Buffer, headers: Record<string, string | undefined>): boolean;

  parseWebhook(rawBody: Buffer): WebhookParse;

  refund(input: {
    providerRef: string;
    amountMinor: bigint;
    reason: string;
  }): Promise<RefundResult>;
}

/** Constant-time compare that will not throw on length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a ?? "", "utf8");
  const bb = Buffer.from(b ?? "", "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Outbound money operations fail CLOSED.
 *
 * `live` is not inferred from the shape of a key: a placeholder like
 * "sk_test_placeholder" looks exactly like a real test key, and treating it as
 * live means a misconfigured environment starts making real calls to a third
 * party. The operator must opt in explicitly with PAYMENTS_MODE=live.
 *
 * Signature verification is deliberately NOT gated on this — it only needs the
 * shared secret, and a sandbox environment should still reject forged
 * webhooks.
 */
export function paymentsModeIsLive(): boolean {
  return (process.env.PAYMENTS_MODE ?? "sandbox").toLowerCase() === "live";
}

/**
 * Paystack.
 *
 * Webhooks are signed with HMAC-SHA512 of the raw body keyed by the SECRET
 * key, sent in `x-paystack-signature`. Amounts are in kobo, which matches our
 * minor units exactly — no conversion, and therefore no rounding.
 */
export class PaystackProvider implements PaymentProvider {
  readonly name = "PAYSTACK";
  readonly live: boolean;

  constructor(
    private readonly secretKey = process.env.PAYSTACK_SECRET_KEY ?? "",
    live?: boolean
  ) {
    this.live = live ?? (paymentsModeIsLive() && this.secretKey.startsWith("sk_"));
  }

  async initialize(input: {
    reference: string;
    amountMinor: bigint;
    currency: string;
    email: string;
    callbackUrl?: string;
  }): Promise<InitResult> {
    if (!this.live) {
      // Sandbox: no network call, but the shape matches the real response so
      // the caller cannot come to depend on sandbox-only fields.
      return {
        reference: input.reference,
        checkoutUrl: `https://sandbox.local/paystack/checkout/${input.reference}`,
      };
    }
    const res = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        reference: input.reference,
        amount: Number(input.amountMinor), // kobo
        currency: input.currency,
        email: input.email,
        callback_url: input.callbackUrl,
      }),
    });
    const json = (await res.json()) as {
      status: boolean;
      message: string;
      data?: { authorization_url: string; reference: string };
    };
    if (!res.ok || !json.status || !json.data) {
      throw new Error(`Paystack initialise failed: ${json.message ?? res.status}`);
    }
    return { reference: json.data.reference, checkoutUrl: json.data.authorization_url };
  }

  async verify(reference: string): Promise<VerifyResult> {
    if (!this.live) {
      return {
        verified: false,
        note: "Paystack sandbox: no credentials configured, so no transaction can be verified server-side.",
      };
    }
    const res = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${this.secretKey}` } }
    );
    const json = (await res.json()) as {
      status: boolean;
      data?: { status: string; amount: number; currency: string; id: number; fees?: number };
    };
    const ok = json.status && json.data?.status === "success";
    return {
      verified: !!ok,
      amountMinor: json.data ? BigInt(json.data.amount) : undefined,
      currency: json.data?.currency,
      providerRef: json.data ? String(json.data.id) : undefined,
      feeMinor: json.data?.fees !== undefined ? BigInt(json.data.fees) : undefined,
      note: ok ? "Verified with Paystack." : `Paystack reports ${json.data?.status ?? "unknown"}.`,
    };
  }

  verifySignature(rawBody: Buffer, headers: Record<string, string | undefined>): boolean {
    const sent = headers["x-paystack-signature"];
    if (!sent || !this.secretKey) return false;
    const expected = createHmac("sha512", this.secretKey).update(rawBody).digest("hex");
    return safeEqual(expected, sent);
  }

  parseWebhook(rawBody: Buffer): WebhookParse {
    const body = JSON.parse(rawBody.toString("utf8")) as {
      event: string;
      data?: {
        id?: number;
        reference?: string;
        amount?: number;
        currency?: string;
        status?: string;
        fees?: number;
      };
    };
    const d = body.data ?? {};
    return {
      // Paystack does not send a delivery id, so the transaction id plus the
      // event name identifies the delivery; a hash of the body is the
      // fallback for events that carry neither.
      externalId:
        d.id !== undefined
          ? `${body.event}:${d.id}`
          : createHash("sha256").update(rawBody).digest("hex"),
      eventType: body.event,
      reference: d.reference,
      providerRef: d.id !== undefined ? String(d.id) : undefined,
      amountMinor: d.amount !== undefined ? BigInt(d.amount) : undefined,
      currency: d.currency,
      feeMinor: d.fees !== undefined ? BigInt(d.fees) : undefined,
      isSuccessfulPayment: body.event === "charge.success" && d.status === "success",
    };
  }

  async refund(input: { providerRef: string; amountMinor: bigint; reason: string }): Promise<RefundResult> {
    if (!this.live) {
      return {
        accepted: false,
        note: "Paystack sandbox: refunds cannot be executed without credentials; recorded locally for approval only.",
      };
    }
    const res = await fetch("https://api.paystack.co/refund", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        transaction: input.providerRef,
        amount: Number(input.amountMinor),
        merchant_note: input.reason,
      }),
    });
    const json = (await res.json()) as { status: boolean; message: string; data?: { id: number } };
    return {
      accepted: res.ok && json.status,
      providerRef: json.data ? String(json.data.id) : undefined,
      note: json.message ?? "Paystack refund requested.",
    };
  }
}

/**
 * Flutterwave.
 *
 * Webhooks are authenticated with a shared secret echoed verbatim in the
 * `verif-hash` header — not an HMAC over the body. That is weaker than
 * Paystack's scheme (it proves the sender knows the secret but says nothing
 * about the payload), so the amount is always re-verified against the
 * provider before any money is posted.
 *
 * Amounts arrive in MAJOR units (naira), so they are converted to kobo here.
 */
export class FlutterwaveProvider implements PaymentProvider {
  readonly name = "FLUTTERWAVE";
  readonly live: boolean;

  constructor(
    private readonly secretKey = process.env.FLUTTERWAVE_SECRET_KEY ?? "",
    private readonly webhookHash = process.env.FLUTTERWAVE_WEBHOOK_HASH ?? "",
    live?: boolean
  ) {
    this.live = live ?? (paymentsModeIsLive() && this.secretKey.startsWith("FLWSECK"));
  }

  async initialize(input: {
    reference: string;
    amountMinor: bigint;
    currency: string;
    email: string;
    callbackUrl?: string;
  }): Promise<InitResult> {
    if (!this.live) {
      return {
        reference: input.reference,
        checkoutUrl: `https://sandbox.local/flutterwave/checkout/${input.reference}`,
      };
    }
    const res = await fetch("https://api.flutterwave.com/v3/payments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tx_ref: input.reference,
        amount: (Number(input.amountMinor) / 100).toFixed(2), // major units
        currency: input.currency,
        redirect_url: input.callbackUrl,
        customer: { email: input.email },
      }),
    });
    const json = (await res.json()) as { status: string; message: string; data?: { link: string } };
    if (!res.ok || json.status !== "success" || !json.data) {
      throw new Error(`Flutterwave initialise failed: ${json.message ?? res.status}`);
    }
    return { reference: input.reference, checkoutUrl: json.data.link };
  }

  async verify(reference: string): Promise<VerifyResult> {
    if (!this.live) {
      return {
        verified: false,
        note: "Flutterwave sandbox: no credentials configured, so no transaction can be verified server-side.",
      };
    }
    const res = await fetch(
      `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${this.secretKey}` } }
    );
    const json = (await res.json()) as {
      status: string;
      data?: { status: string; amount: number; currency: string; id: number; app_fee?: number };
    };
    const ok = json.status === "success" && json.data?.status === "successful";
    return {
      verified: !!ok,
      amountMinor: json.data ? BigInt(Math.round(json.data.amount * 100)) : undefined,
      currency: json.data?.currency,
      providerRef: json.data ? String(json.data.id) : undefined,
      feeMinor:
        json.data?.app_fee !== undefined
          ? BigInt(Math.round(json.data.app_fee * 100))
          : undefined,
      note: ok ? "Verified with Flutterwave." : `Flutterwave reports ${json.data?.status ?? "unknown"}.`,
    };
  }

  verifySignature(_rawBody: Buffer, headers: Record<string, string | undefined>): boolean {
    const sent = headers["verif-hash"];
    if (!sent || !this.webhookHash) return false;
    return safeEqual(this.webhookHash, sent);
  }

  parseWebhook(rawBody: Buffer): WebhookParse {
    const body = JSON.parse(rawBody.toString("utf8")) as {
      event?: string;
      "event.type"?: string;
      data?: {
        id?: number;
        tx_ref?: string;
        amount?: number;
        currency?: string;
        status?: string;
        app_fee?: number;
      };
    };
    const d = body.data ?? {};
    const eventType = body.event ?? body["event.type"] ?? "unknown";
    return {
      externalId:
        d.id !== undefined
          ? `${eventType}:${d.id}`
          : createHash("sha256").update(rawBody).digest("hex"),
      eventType,
      reference: d.tx_ref,
      providerRef: d.id !== undefined ? String(d.id) : undefined,
      // Major → minor. Rounded because a float like 4650.005 cannot be
      // represented exactly and must not silently truncate a kobo.
      amountMinor: d.amount !== undefined ? BigInt(Math.round(d.amount * 100)) : undefined,
      currency: d.currency,
      feeMinor: d.app_fee !== undefined ? BigInt(Math.round(d.app_fee * 100)) : undefined,
      isSuccessfulPayment:
        (eventType === "charge.completed" || eventType === "CHARGE_COMPLETED") &&
        d.status === "successful",
    };
  }

  async refund(input: { providerRef: string; amountMinor: bigint; reason: string }): Promise<RefundResult> {
    if (!this.live) {
      return {
        accepted: false,
        note: "Flutterwave sandbox: refunds cannot be executed without credentials; recorded locally for approval only.",
      };
    }
    const res = await fetch(
      `https://api.flutterwave.com/v3/transactions/${encodeURIComponent(input.providerRef)}/refund`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ amount: Number(input.amountMinor) / 100, comments: input.reason }),
      }
    );
    const json = (await res.json()) as { status: string; message: string; data?: { id: number } };
    return {
      accepted: res.ok && json.status === "success",
      providerRef: json.data ? String(json.data.id) : undefined,
      note: json.message ?? "Flutterwave refund requested.",
    };
  }
}

export const PROVIDERS: Record<string, PaymentProvider> = {
  PAYSTACK: new PaystackProvider(),
  FLUTTERWAVE: new FlutterwaveProvider(),
};

export function getProvider(name: string): PaymentProvider {
  const p = PROVIDERS[name?.toUpperCase()];
  if (!p) throw new Error(`Unknown payment provider "${name}".`);
  return p;
}

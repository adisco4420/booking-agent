/**
 * Minimal Paystack client: initialize a transaction (hosted payment link) and
 * verify it. Test mode only: the server refuses to boot with a live key.
 */

export interface InitResult {
  authorizationUrl: string;
  reference: string;
}

export type PaystackStatus =
  | "success" | "failed" | "abandoned" | "ongoing" | "pending"
  | "processing" | "queued" | "reversed" | "not_found";

export interface VerifyResult {
  status: PaystackStatus;
  amountKobo: number;
  currency: string;
  paidAt?: string;
}

export interface Payments {
  initialize(args: { reference: string; amountKobo: number; email: string; metadata: Record<string, unknown> }): Promise<InitResult>;
  verify(reference: string): Promise<VerifyResult>;
}

export class PaystackPayments implements Payments {
  constructor(private secretKey: string, private callbackUrl?: string) {
    if (!secretKey.startsWith("sk_test_")) {
      throw new Error("Refusing to start: PAYSTACK_SECRET_KEY must be a test key (sk_test_...)");
    }
  }

  private async call(method: string, path: string, body?: unknown) {
    // Paystack rate-limits bursts with 429. A 429 means the request wasn't processed, so
    // retrying is safe even for initialize; 5xx is only retried for reads (it may have gone through).
    const delays = [1000, 2000, 4000];
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`https://api.paystack.co${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.secretKey}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
      const retryable = res.status === 429 || (method === "GET" && res.status >= 500);
      if (!retryable || attempt >= delays.length) {
        const json = (await res.json().catch(() => ({}))) as any;
        return { httpStatus: res.status, json };
      }
      console.warn(`Paystack ${method} ${path.split("/").slice(0, 3).join("/")} ${res.status}, retrying in ${delays[attempt]} ms`);
      await new Promise((r) => setTimeout(r, delays[attempt] + Math.random() * 500));
    }
  }

  async initialize({ reference, amountKobo, email, metadata }: Parameters<Payments["initialize"]>[0]) {
    const { httpStatus, json } = await this.call("POST", "/transaction/initialize", {
      email,
      amount: amountKobo,
      currency: "NGN",
      reference,
      callback_url: this.callbackUrl,
      metadata,
    });
    if (httpStatus >= 300 || !json.status) {
      throw new Error(`Paystack initialize failed (${httpStatus}): ${json.message ?? "unknown error"}`);
    }
    return { authorizationUrl: json.data.authorization_url, reference: json.data.reference };
  }

  async verify(reference: string): Promise<VerifyResult> {
    const { httpStatus, json } = await this.call("GET", `/transaction/verify/${encodeURIComponent(reference)}`);
    if (httpStatus === 404 || (json.status === false && /not found/i.test(json.message ?? ""))) {
      return { status: "not_found", amountKobo: 0, currency: "NGN" };
    }
    if (httpStatus >= 300 || !json.status) {
      throw new Error(`Paystack verify failed (${httpStatus}): ${json.message ?? "unknown error"}`);
    }
    return {
      status: json.data.status,
      amountKobo: json.data.amount,
      currency: json.data.currency,
      paidAt: json.data.paid_at ?? undefined,
    };
  }
}

/** Local-only fake. GET /mock-pay/:ref marks a reference paid with the expected amount. */
export class MockPayments implements Payments {
  paid = new Map<string, number>();
  expected = new Map<string, number>();
  constructor(private publicBaseUrl: string) {}
  async initialize({ reference, amountKobo }: Parameters<Payments["initialize"]>[0]) {
    this.expected.set(reference, amountKobo);
    return { authorizationUrl: `${this.publicBaseUrl}/mock-pay/${reference}`, reference };
  }
  async verify(reference: string): Promise<VerifyResult> {
    const amt = this.paid.get(reference);
    return amt === undefined
      ? { status: "abandoned", amountKobo: 0, currency: "NGN" }
      : { status: "success", amountKobo: amt, currency: "NGN", paidAt: new Date().toISOString() };
  }
}

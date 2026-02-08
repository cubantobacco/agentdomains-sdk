import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wrapFetchWithPaymentMock = vi.hoisted(() => vi.fn());
const toClientEvmSignerMock = vi.hoisted(() => vi.fn((account: unknown) => account));
const exactEvmSchemeCtorMock = vi.hoisted(() => vi.fn());
const registerMock = vi.hoisted(() => vi.fn());
const shared = vi.hoisted(() => ({
  payableFetch: vi.fn(),
}));

vi.mock("@x402/fetch", () => {
  class MockX402Client {
    register(network: unknown, scheme: unknown) {
      registerMock(network, scheme);
      return this;
    }
  }

  return {
    wrapFetchWithPayment: wrapFetchWithPaymentMock,
    x402Client: MockX402Client,
  };
});

vi.mock("@x402/evm", () => {
  class MockExactEvmScheme {
    constructor(signer: unknown) {
      exactEvmSchemeCtorMock(signer);
    }
  }

  return {
    ExactEvmScheme: MockExactEvmScheme,
    toClientEvmSigner: toClientEvmSignerMock,
  };
});

import { AgentDomains, AgentDomainsError, type EvmSigner, type Registrant } from "../index";

const DEFAULT_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678" as const;

function makeAccount(overrides: Partial<EvmSigner> = {}): EvmSigner {
  return {
    address: DEFAULT_ADDRESS,
    signTypedData: vi.fn().mockResolvedValue(`0x${"1".repeat(130)}` as `0x${string}`),
    ...overrides,
  };
}

function makeRegistrant(): Registrant {
  return {
    type: "individual",
    first_name: "Jane",
    last_name: "Agent",
    email: "jane@example.com",
    phone: "+12025550123",
    address: {
      street: "1 Market St",
      city: "San Francisco",
      state: "CA",
      postal_code: "94105",
      country: "US",
    },
  };
}

function ok(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function err(error: unknown, status = 400): Response {
  return new Response(JSON.stringify({ success: false, error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function paidOrder(overrides: Record<string, unknown> = {}) {
  return {
    order_id: "ord_123",
    domain: "cool.dev",
    status: "paid",
    amount_usdc: "11.99",
    expires_at: "2026-02-08T00:00:00.000Z",
    created_at: "2026-02-08T00:00:00.000Z",
    ...overrides,
  };
}

function validOrderValidation() {
  return {
    valid: true,
    errors: [],
    warnings: [],
    price: { per_year: "11.99", total: "11.99", years: 1, currency: "USDC" },
    tld_rules: { tld: "dev", min_years: 1, max_years: 10 },
  };
}

describe("AgentDomains SDK", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    shared.payableFetch = vi.fn();
    wrapFetchWithPaymentMock.mockReset();
    wrapFetchWithPaymentMock.mockImplementation(() => shared.payableFetch);
    toClientEvmSignerMock.mockClear();
    exactEvmSchemeCtorMock.mockClear();
    registerMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns a useful static tool description", () => {
    const schema = AgentDomains.describe();
    expect(schema.name).toBe("AgentDomains");
    expect(schema.methods.map((m) => m.name)).toEqual([
      "checkDomain",
      "checkBulk",
      "suggestDomains",
      "buyDomain",
      "getOrder",
    ]);
    const buyDomain = schema.methods.find((m) => m.name === "buyDomain");
    expect(buyDomain?.parameters["options.prevalidate"]).toBeTruthy();
    expect(buyDomain?.parameters["options.source_chain"]).toBeTruthy();
  });

  it("throws on missing account address", () => {
    expect(() => new AgentDomains({ account: {} as EvmSigner })).toThrow("account must have an address");
  });

  it("throws on unknown network", () => {
    expect(() =>
      new AgentDomains({
        account: makeAccount(),
        network: "invalid-network" as never,
      }),
    ).toThrow('Unknown network: invalid-network. Use "base-mainnet" or "base-sepolia"');
  });

  it("wires signer, scheme, and x402 client registration", () => {
    const account = makeAccount();
    new AgentDomains({ account, network: "base-sepolia" });

    expect(toClientEvmSignerMock).toHaveBeenCalledWith(account);
    expect(exactEvmSchemeCtorMock).toHaveBeenCalledTimes(1);
    expect(registerMock).toHaveBeenCalledWith("eip155:84532", expect.anything());
    expect(wrapFetchWithPaymentMock).toHaveBeenCalledWith(fetchMock, expect.anything());
  });

  it("builds registrant from defaults with overrides", () => {
    const client = new AgentDomains({
      account: makeAccount(),
      registrantDefaults: {
        type: "organization",
        organization: "Agent Co",
        email: "default@example.com",
        phone: "+12025559999",
        fax: "+12025558888",
        address: {
          street: "Default St",
          street2: "Suite 5",
          city: "Default City",
          state: "CA",
          postal_code: "94105",
          country: "US",
        },
      },
    });

    const registrant = client.buildRegistrant({
      first_name: "Jane",
      last_name: "Agent",
      address: { city: "Override City" } as any,
    });

    expect(registrant.type).toBe("organization");
    expect(registrant.organization).toBe("Agent Co");
    expect(registrant.email).toBe("default@example.com");
    expect(registrant.fax).toBe("+12025558888");
    expect(registrant.address.street2).toBe("Suite 5");
    expect(registrant.address.city).toBe("Override City");
  });

  it("buildRegistrant falls back to type=individual and omits optional fields when absent", () => {
    const client = new AgentDomains({ account: makeAccount() });
    const registrant = client.buildRegistrant({
      first_name: "Jane",
      last_name: "Agent",
      email: "jane@example.com",
      phone: "+12025550123",
      address: {
        street: "1 Main",
        city: "SF",
        state: "CA",
        postal_code: "94105",
        country: "US",
      },
    });

    expect(registrant.type).toBe("individual");
    expect("organization" in registrant).toBe(false);
    expect("fax" in registrant).toBe(false);
    expect("street2" in registrant.address).toBe(false);
  });

  it("buildRegistrant prioritizes override optional fields over template values", () => {
    const client = new AgentDomains({
      account: makeAccount(),
      registrantDefaults: {
        type: "organization",
        organization: "Template Org",
        email: "template@example.com",
        phone: "+12025550000",
        fax: "+12025551111",
        address: {
          street: "Template Street",
          street2: "Template Suite",
          city: "Template City",
          state: "CA",
          postal_code: "94105",
          country: "US",
        },
      },
    });

    const registrant = client.buildRegistrant({
      type: "individual",
      first_name: "Jane",
      last_name: "Agent",
      organization: "Override Org",
      fax: "+12025552222",
      address: { street2: "Override Suite" } as any,
    });

    expect(registrant.type).toBe("individual");
    expect(registrant.organization).toBe("Override Org");
    expect(registrant.fax).toBe("+12025552222");
    expect(registrant.address.street2).toBe("Override Suite");
  });

  it("throws clear errors for each missing registrant field", () => {
    const client = new AgentDomains({ account: makeAccount() });
    const base = {
      first_name: "Jane",
      last_name: "Agent",
      email: "jane@example.com",
      phone: "+12025550123",
      address: {
        street: "1 Main",
        city: "SF",
        state: "CA",
        postal_code: "94105",
        country: "US",
      },
    };

    const cases: Array<{ value: Partial<Registrant>; missing: string }> = [
      { value: { first_name: base.first_name, last_name: base.last_name }, missing: "email" },
      {
        value: { first_name: base.first_name, last_name: base.last_name, email: base.email },
        missing: "phone",
      },
      {
        value: { first_name: base.first_name, last_name: base.last_name, email: base.email, phone: base.phone },
        missing: "address.street",
      },
      {
        value: {
          first_name: base.first_name,
          last_name: base.last_name,
          email: base.email,
          phone: base.phone,
          address: { street: base.address.street } as any,
        },
        missing: "address.city",
      },
      {
        value: {
          first_name: base.first_name,
          last_name: base.last_name,
          email: base.email,
          phone: base.phone,
          address: { street: base.address.street, city: base.address.city } as any,
        },
        missing: "address.state",
      },
      {
        value: {
          first_name: base.first_name,
          last_name: base.last_name,
          email: base.email,
          phone: base.phone,
          address: { street: base.address.street, city: base.address.city, state: base.address.state } as any,
        },
        missing: "address.postal_code",
      },
      {
        value: {
          first_name: base.first_name,
          last_name: base.last_name,
          email: base.email,
          phone: base.phone,
          address: {
            street: base.address.street,
            city: base.address.city,
            state: base.address.state,
            postal_code: base.address.postal_code,
          } as any,
        },
        missing: "address.country",
      },
    ];

    for (const testCase of cases) {
      expect(() => client.buildRegistrant(testCase.value as Partial<Registrant> & { first_name: string; last_name: string }))
        .toThrow(testCase.missing);
    }
  });

  it("checkDomain includes registrant_country when provided", async () => {
    const client = new AgentDomains({ account: makeAccount() });
    fetchMock.mockResolvedValue(ok({ domain: "cool.dev", available: true }));

    await client.checkDomain("cool.dev", "US");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/v1/domains/check?");
    expect(url).toContain("domain=cool.dev");
    expect(url).toContain("registrant_country=US");
    expect(init.method).toBe("GET");
  });

  it("checkDomain omits registrant_country when not provided", async () => {
    const client = new AgentDomains({ account: makeAccount() });
    fetchMock.mockResolvedValue(ok({ domain: "cool.dev", available: true }));

    await client.checkDomain("cool.dev");

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("domain=cool.dev");
    expect(url).not.toContain("registrant_country");
  });

  it("checkBulk, suggestDomains, and getOrder parse happy paths", async () => {
    const client = new AgentDomains({ account: makeAccount() });
    fetchMock
      .mockResolvedValueOnce(ok({ results: [{ domain: "a.dev", available: true, price: "11.99" }] }))
      .mockResolvedValueOnce(
        ok({
          results: [{ domain: "a.dev", available: true, price_usd: "11.99", status: "available" }],
          checked_count: 1,
          available_count: 1,
          currency: "USD",
          tlds: ["dev"],
          patterns: ["exact"],
          include_unavailable: false,
        }),
      )
      .mockResolvedValueOnce(ok(paidOrder()));

    const bulk = await client.checkBulk(["a.dev"]);
    expect(bulk[0].domain).toBe("a.dev");

    const ideas = await client.suggestDomains({ keywords: ["agent"] });
    expect(ideas.results[0].status).toBe("available");
    expect(ideas.tlds).toEqual(["dev"]);

    await client.getOrder("ord_abc/def");
    expect(fetchMock.mock.calls[2][0]).toContain("/v1/orders/ord_abc%2Fdef");
  });

  it("surfaces network errors from request()", async () => {
    const client = new AgentDomains({ account: makeAccount() });
    fetchMock.mockRejectedValue(new Error("offline"));
    await expect(client.checkDomain("cool.dev")).rejects.toMatchObject({
      code: "network_error",
      status: 0,
      message: "Network request failed: offline",
    });
  });

  it("surfaces unknown network errors from request() for non-Error throws", async () => {
    const client = new AgentDomains({ account: makeAccount() });
    fetchMock.mockRejectedValue("offline");
    await expect(client.checkDomain("cool.dev")).rejects.toMatchObject({
      code: "network_error",
      status: 0,
      message: "Network request failed: Unknown error",
    });
  });

  it("handles non-JSON responses", async () => {
    const client = new AgentDomains({ account: makeAccount() });
    fetchMock.mockResolvedValue(
      new Response("plain text error", {
        status: 502,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    await expect(client.checkDomain("cool.dev")).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("normalizes string and missing error payloads", async () => {
    const client = new AgentDomains({ account: makeAccount() });
    fetchMock
      .mockResolvedValueOnce(err("plain error", 400))
      .mockResolvedValueOnce(err(undefined, 500));

    await expect(client.checkDomain("cool.dev")).rejects.toMatchObject({
      code: "unknown",
      status: 400,
      message: "plain error",
    });

    await expect(client.checkDomain("cool.dev")).rejects.toMatchObject({
      code: "unknown",
      status: 500,
      message: "Request failed",
    });
  });

  it("normalizes object error payloads missing code/message fields", async () => {
    const client = new AgentDomains({ account: makeAccount() });
    fetchMock
      .mockResolvedValueOnce(err({ message: "only-message" }, 400))
      .mockResolvedValueOnce(err({ code: "only-code" }, 400))
      .mockResolvedValueOnce(err({}, 400));

    await expect(client.checkDomain("cool.dev")).rejects.toMatchObject({
      code: "unknown",
      status: 400,
      message: "only-message",
    });

    await expect(client.checkDomain("cool.dev")).rejects.toMatchObject({
      code: "only-code",
      status: 400,
      message: "Request failed",
    });

    await expect(client.checkDomain("cool.dev")).rejects.toMatchObject({
      code: "unknown",
      status: 400,
      message: "Request failed",
    });
  });

  it("treats non-ok response as failure even if success=true", async () => {
    const client = new AgentDomains({ account: makeAccount() });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: {} }), {
        status: 418,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(client.checkDomain("cool.dev")).rejects.toMatchObject({
      code: "unknown",
      status: 418,
      message: "Request failed",
    });
  });

  it("buyDomain prevalidates by default and uses deterministic idempotency key", async () => {
    const client = new AgentDomains({ account: makeAccount() });
    fetchMock.mockResolvedValue(ok(validOrderValidation()));
    shared.payableFetch.mockResolvedValue(ok(paidOrder()));

    const result = await client.buyDomain("cool.dev", { registrant: makeRegistrant() });
    expect(result.order_id).toBe("ord_123");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/v1/orders/validate");

    const payableBody = JSON.parse(String(shared.payableFetch.mock.calls[0][1].body));
    expect(payableBody.idempotency_key).toMatch(/^sdk_[a-f0-9]{48}$/);
    expect(payableBody.source_chain).toBe("base");
  });

  it("passes through explicit source_chain, nameservers, and idempotency_key", async () => {
    const client = new AgentDomains({ account: makeAccount() });
    shared.payableFetch.mockResolvedValue(ok(paidOrder()));

    await client.buyDomain("cool.dev", {
      registrant: makeRegistrant(),
      prevalidate: false,
      source_chain: "arbitrum",
      idempotency_key: "manual-key",
      nameservers: ["ns1.cloudflare.com", "ns2.cloudflare.com"],
    });

    const body = JSON.parse(String(shared.payableFetch.mock.calls[0][1].body));
    expect(body.source_chain).toBe("arbitrum");
    expect(body.idempotency_key).toBe("manual-key");
    expect(body.nameservers).toEqual(["ns1.cloudflare.com", "ns2.cloudflare.com"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("adds SIWE headers when signMessage is available", async () => {
    const signMessage = vi.fn().mockResolvedValue("0xsigned");
    const mixedCaseAddress = "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD" as const;
    const client = new AgentDomains({
      account: makeAccount({ address: mixedCaseAddress, signMessage }),
    });
    shared.payableFetch.mockResolvedValue(ok(paidOrder()));

    await client.buyDomain("cool.dev", { registrant: makeRegistrant(), prevalidate: false });

    const headers = shared.payableFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["X-Wallet-Signature"]).toBe("0xsigned");
    expect(headers["X-Wallet-Message"]).toContain(mixedCaseAddress.toLowerCase());
    expect(signMessage).toHaveBeenCalledTimes(1);
  });

  it("continues without SIWE headers when signMessage throws", async () => {
    const client = new AgentDomains({
      account: makeAccount({
        signMessage: vi.fn().mockRejectedValue(new Error("rejected")),
      }),
    });
    shared.payableFetch.mockResolvedValue(ok(paidOrder()));

    await client.buyDomain("cool.dev", { registrant: makeRegistrant(), prevalidate: false });
    const headers = shared.payableFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["X-Wallet-Signature"]).toBeUndefined();
    expect(headers["X-Wallet-Message"]).toBeUndefined();
  });

  it("returns existing idempotent order when prevalidation sees active domain", async () => {
    const client = new AgentDomains({ account: makeAccount() });
    fetchMock
      .mockResolvedValueOnce(
        ok({
          valid: false,
          errors: [{ code: "domain_already_registered", message: "Domain already active" }],
          warnings: [],
        }),
      )
      .mockResolvedValueOnce(ok(paidOrder({ order_id: "ord_existing" })));

    const result = await client.buyDomain("cool.dev", { registrant: makeRegistrant() });
    expect(result.order_id).toBe("ord_existing");
    expect(shared.payableFetch).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[1][0]).toContain("/v1/orders");
  });

  it("throws validation error if active-domain probe returns 402", async () => {
    const client = new AgentDomains({ account: makeAccount() });
    fetchMock
      .mockResolvedValueOnce(
        ok({
          valid: false,
          errors: [{ code: "domain_already_registered", message: "already active" }],
          warnings: [],
        }),
      )
      .mockResolvedValueOnce(err({ code: "payment_required", message: "pay first" }, 402));

    await expect(client.buyDomain("cool.dev", { registrant: makeRegistrant() })).rejects.toMatchObject({
      code: "domain_already_registered",
      status: 400,
    });
    expect(shared.payableFetch).not.toHaveBeenCalled();
  });

  it("rethrows non-402 errors from active-domain probe", async () => {
    const client = new AgentDomains({ account: makeAccount() });
    fetchMock
      .mockResolvedValueOnce(
        ok({
          valid: false,
          errors: [{ code: "domain_already_registered", message: "already active" }],
          warnings: [],
        }),
      )
      .mockResolvedValueOnce(err({ code: "internal_error", message: "db down" }, 500));

    await expect(client.buyDomain("cool.dev", { registrant: makeRegistrant() })).rejects.toMatchObject({
      code: "internal_error",
      status: 500,
      message: "db down",
    });
  });

  it("throws first validation error when prevalidation fails", async () => {
    const client = new AgentDomains({ account: makeAccount() });
    fetchMock.mockResolvedValue(
      ok({
        valid: false,
        errors: [{ code: "tld_year_constraint", message: ".ai requires minimum 2 year registration" }],
        warnings: [],
      }),
    );

    await expect(client.buyDomain("cool.ai", { registrant: makeRegistrant() })).rejects.toMatchObject({
      code: "tld_year_constraint",
      status: 400,
      message: ".ai requires minimum 2 year registration",
    });
  });

  it("falls back to generic validation message when error list is empty", async () => {
    const client = new AgentDomains({ account: makeAccount() });
    fetchMock.mockResolvedValue(ok({ valid: false, errors: [], warnings: [] }));

    await expect(client.buyDomain("cool.dev", { registrant: makeRegistrant() })).rejects.toMatchObject({
      code: "validation_error",
      status: 400,
      message: "Order validation failed",
    });
  });

  it("propagates AgentDomainsError from payable fetch", async () => {
    const client = new AgentDomains({ account: makeAccount() });
    const customError = new AgentDomainsError("already normalized", "custom", 499);
    shared.payableFetch.mockRejectedValue(customError);

    await expect(client.buyDomain("cool.dev", { registrant: makeRegistrant(), prevalidate: false })).rejects.toBe(customError);
  });

  it("maps payment-like payable fetch errors to payment_error", async () => {
    const client = new AgentDomains({ account: makeAccount() });
    shared.payableFetch.mockRejectedValue(new Error("insufficient balance for payment"));

    await expect(client.buyDomain("cool.dev", { registrant: makeRegistrant(), prevalidate: false })).rejects.toMatchObject({
      code: "payment_error",
      status: 402,
      message: "Payment failed: insufficient balance for payment",
    });
  });

  it("maps generic payable fetch errors to network_error", async () => {
    const client = new AgentDomains({ account: makeAccount() });
    shared.payableFetch.mockRejectedValue(new Error("socket hang up"));

    await expect(client.buyDomain("cool.dev", { registrant: makeRegistrant(), prevalidate: false })).rejects.toMatchObject({
      code: "network_error",
      status: 0,
      message: "Network request failed: socket hang up",
    });
  });

  it("maps non-Error payable fetch throws to unknown network_error", async () => {
    const client = new AgentDomains({ account: makeAccount() });
    shared.payableFetch.mockRejectedValue({ boom: true });

    await expect(client.buyDomain("cool.dev", { registrant: makeRegistrant(), prevalidate: false })).rejects.toMatchObject({
      code: "network_error",
      status: 0,
      message: "Network request failed: Unknown error",
    });
  });

  it("handles payableRequest calls without a body", async () => {
    const client = new AgentDomains({ account: makeAccount() });
    shared.payableFetch.mockResolvedValue(ok(paidOrder()));

    await (client as any).payableRequest("GET", "/v1/orders");

    const init = shared.payableFetch.mock.calls[0][1] as RequestInit;
    expect(init.body).toBeUndefined();
  });
});

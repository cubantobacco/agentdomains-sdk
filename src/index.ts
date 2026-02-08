/**
 * agentdomains-sdk
 *
 * TypeScript SDK for Agent Native Domains.
 * Register domains programmatically with USDC payments via the x402 protocol.
 *
 * Usage:
 *   import { AgentDomains } from "agentdomains-sdk";
 *   import { privateKeyToAccount } from "viem/accounts";
 *
 *   const account = privateKeyToAccount("0x...");
 *   const ad = new AgentDomains({ account });
 *   const result = await ad.buyDomain("cool.dev", { registrant });
 */

import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import type { Network } from "@x402/fetch";
import { createHash } from "node:crypto";

// ============================================================================
// Types
// ============================================================================

/** A signer with address and signTypedData (viem LocalAccount works) */
export interface EvmSigner {
  readonly address: `0x${string}`;
  signTypedData(message: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`>;
  /** Optional: enables credit-first payment flow (SIWE wallet proof) */
  signMessage?(message: { message: string }): Promise<`0x${string}`>;
}

export interface AgentDomainsConfig {
  /** EVM account with signing capabilities (e.g., from privateKeyToAccount) */
  account: EvmSigner;
  /** API base URL (default: https://api.agentdomains.ai) */
  baseUrl?: string;
  /** Network: "base-mainnet" or "base-sepolia" (default: "base-mainnet") */
  network?: "base-mainnet" | "base-sepolia";
  /** Pre-fill registrant fields to reduce per-call boilerplate */
  registrantDefaults?: RegistrantTemplate;
}

export interface Registrant {
  type: "individual" | "organization";
  first_name: string;
  last_name: string;
  organization?: string;
  email: string;
  /** E.164 format, e.g. "+12025551234" */
  phone: string;
  fax?: string;
  address: {
    street: string;
    street2?: string;
    city: string;
    state: string;
    postal_code: string;
    /** ISO 3166-1 alpha-2, e.g. "US" */
    country: string;
  };
}

export interface DomainCheck {
  domain: string;
  available: boolean;
  tld: string;
  pricing: {
    per_year: string;
    registration: Record<string, string>;
    min_required_total: string;
    renewal: string;
    currency: string;
    whois_privacy: string;
  };
  registration_period: {
    min_years: number;
    max_years: number;
  };
  registrant_requirements?: Array<{
    type: string;
    description: string;
  }>;
  warnings?: string[];
}

export interface BulkCheckResult {
  domain: string;
  available: boolean;
  price: string | null;
}

export interface DomainIdeasInput {
  keywords: string[];
  tlds?: string[];
  patterns?: Array<"exact" | "hyphenated" | "prefix" | "suffix">;
  max_to_check?: number;
  include_unavailable?: boolean;
}

export interface DomainSuggestion {
  domain: string;
  available: boolean;
  price_usd: string | null;
  status: "available" | "unavailable";
}

export interface SuggestDomainsResult {
  results: DomainSuggestion[];
  checked_count: number;
  available_count: number;
  currency: string;
  tlds: string[];
  patterns: Array<"exact" | "hyphenated" | "prefix" | "suffix">;
  include_unavailable: boolean;
}

export interface OrderResult {
  order_id: string;
  domain: string;
  status: string;
  amount_usdc: string;
  expires_at: string;
  created_at: string;
  paid_at?: string;
  payment?: {
    chain: string;
    method: string;
    contract_address?: string;
    function?: string;
    parameters?: { order_id: string; amount: string };
  };
  registration?: {
    registrar: string;
    registered_at: string;
    expires_at: string;
    nameservers: string[];
    auto_renew: boolean;
  };
  failure?: {
    reason: string;
    message: string;
    failed_at: string;
  };
  credit?: {
    status: string;
    amount_usdc: string;
    credited_at?: string;
  };
  next_steps?: {
    dns_management: string;
    nameservers: string;
  };
}

export interface OrderStatus {
  order_id: string;
  domain: string;
  status: "awaiting_payment" | "paid" | "processing" | "completed" | "failed" | "expired" | "credited";
  amount_usdc: string;
  expires_at: string;
  created_at: string;
  paid_at?: string;
  registration?: OrderResult["registration"];
  failure?: OrderResult["failure"];
  credit?: OrderResult["credit"];
  next_steps?: OrderResult["next_steps"];
}

export type SourceChain = "base" | "arbitrum" | "ethereum" | "solana";

export interface BuyDomainOptions {
  registrant: Registrant;
  years?: number;
  nameservers?: string[];
  /** Source chain metadata stored with the order (x402 payments settle on Base) */
  source_chain?: SourceChain;
  idempotency_key?: string;
  /** Run /v1/orders/validate before paying (default: true) */
  prevalidate?: boolean;
}

/** Pre-filled registrant template to reduce boilerplate */
export interface RegistrantTemplate {
  type?: "individual" | "organization";
  organization?: string;
  email?: string;
  phone?: string;
  fax?: string;
  address?: Partial<Registrant["address"]>;
}

/** Structured tool description for LLM consumption */
export interface ToolDescription {
  name: string;
  description: string;
  base_url: string;
  auth: { type: string; protocol: string; currency: string; network: string };
  methods: Array<{
    name: string;
    description: string;
    parameters: Record<string, { type: string; required: boolean; description: string }>;
    returns: string;
    requires_payment: boolean;
  }>;
}

export interface ApiError {
  code: string;
  message: string;
  retry_after_seconds?: number;
  details?: Array<{ field: string; message: string }>;
}

interface OrderValidationIssue {
  code: string;
  message: string;
  field?: string;
}

interface OrderValidationResult {
  valid: boolean;
  errors: OrderValidationIssue[];
  warnings: Array<{ code: string; message: string }>;
  price?: {
    per_year: string;
    total: string;
    years: number;
    currency: string;
  } | null;
  tld_rules?: {
    tld: string;
    min_years: number;
    max_years: number;
  };
}

export class AgentDomainsError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AgentDomainsError";
  }
}

// Network mapping
const NETWORK_MAP: Record<string, Network> = {
  "base-mainnet": "eip155:8453" as Network,
  "base-sepolia": "eip155:84532" as Network,
};

// ============================================================================
// SDK Client
// ============================================================================

export class AgentDomains {
  private baseUrl: string;
  private payableFetch: typeof fetch;
  private walletAddress: string;
  private account: EvmSigner;
  private registrantTemplate?: RegistrantTemplate;

  /**
   * Returns a structured description of the SDK for LLM tool-use.
   * Call this to understand what the SDK can do without reading docs.
   *
   * @example
   * const schema = AgentDomains.describe();
   * // Pass schema to an LLM as a tool definition
   */
  static describe(): ToolDescription {
    return {
      name: "AgentDomains",
      description:
        "Register internet domains and pay with USDC on Base via the x402 protocol. " +
        "No API keys needed — payment is the authentication.",
      base_url: "https://api.agentdomains.ai",
      auth: {
        type: "x402",
        protocol: "EIP-712 signed USDC authorization",
        currency: "USDC",
        network: "Base (eip155:8453)",
      },
      methods: [
        {
          name: "checkDomain",
          description: "Check if a domain is available and get pricing in USDC. Free, no payment.",
          parameters: {
            domain: { type: "string", required: true, description: 'Full domain name, e.g. "cool.dev"' },
            registrantCountry: { type: "string", required: false, description: "ISO 3166-1 alpha-2 country code for restriction warnings" },
          },
          returns: "{ domain, available, tld, pricing: { per_year, registration, renewal, currency }, registration_period }",
          requires_payment: false,
        },
        {
          name: "checkBulk",
          description: "Check up to 50 domains at once. Free, no payment.",
          parameters: {
            domains: { type: "string[]", required: true, description: "Array of domain names to check" },
          },
          returns: "Array<{ domain, available, price }>",
          requires_payment: false,
        },
        {
          name: "suggestDomains",
          description: "Generate domain name ideas from keywords and check availability.",
          parameters: {
            keywords: { type: "string[]", required: true, description: "Keywords to generate ideas from" },
            tlds: { type: "string[]", required: false, description: 'TLDs to check, e.g. ["dev","ai","com"]' },
            patterns: { type: "string[]", required: false, description: 'Generation patterns: "exact","hyphenated","prefix","suffix"' },
            max_to_check: { type: "number", required: false, description: "Max domains to check (default 100)" },
          },
          returns: "{ results: Array<{ domain, available, price_usd, status }>, checked_count, available_count, currency, tlds, patterns, include_unavailable }",
          requires_payment: false,
        },
        {
          name: "buyDomain",
          description:
            "Register a domain. Costs USDC (price from checkDomain). " +
            "Requires registrant contact info (name, email, phone, address). " +
            "WHOIS privacy included free.",
          parameters: {
            domain: { type: "string", required: true, description: "Domain to register" },
            "options.registrant": { type: "Registrant", required: true, description: "Contact info: type, first_name, last_name, email, phone, address {street, city, state, postal_code, country}" },
            "options.years": { type: "number", required: false, description: "Registration years 1-10 (default 1, some TLDs require more)" },
            "options.nameservers": { type: "string[]", required: false, description: "Custom nameservers (2-6), e.g. Cloudflare" },
            "options.source_chain": { type: "string", required: false, description: 'Source chain metadata: "base" | "arbitrum" | "ethereum" | "solana" (x402 settles on Base)' },
            "options.idempotency_key": { type: "string", required: false, description: "Unique key to prevent duplicate orders (recommended for retry safety)" },
            "options.prevalidate": { type: "boolean", required: false, description: "Validate order before paying (default true)" },
          },
          returns: "{ order_id, domain, status, amount_usdc, expires_at, created_at, registration?, failure?, next_steps? }",
          requires_payment: true,
        },
        {
          name: "getOrder",
          description: "Check the status of a domain registration order.",
          parameters: {
            orderId: { type: "string", required: true, description: 'Order ID (format: "ord_*")' },
          },
          returns: "{ order_id, domain, status, amount_usdc, expires_at, created_at, paid_at?, registration?, failure?, credit? }",
          requires_payment: false,
        },
      ],
    };
  }

  constructor(config: AgentDomainsConfig) {
    this.baseUrl = (config.baseUrl || "https://api.agentdomains.ai").replace(/\/$/, "");
    this.registrantTemplate = config.registrantDefaults;

    if (!config.account?.address) {
      throw new Error("account must have an address");
    }
    this.walletAddress = config.account.address.toLowerCase() as `0x${string}`;
    this.account = config.account;

    // Build x402 client with EVM scheme for Base
    const networkKey = config.network || "base-mainnet";
    const network = NETWORK_MAP[networkKey];
    if (!network) {
      throw new Error(`Unknown network: ${networkKey}. Use "base-mainnet" or "base-sepolia"`);
    }

    const signer = toClientEvmSigner(config.account);
    const scheme = new ExactEvmScheme(signer);
    const client = new x402Client().register(network, scheme);

    this.payableFetch = wrapFetchWithPayment(fetch, client);
  }

  // --------------------------------------------------------------------------
  // Domain Discovery (free, no payment required)
  // --------------------------------------------------------------------------

  /**
   * Check if a domain is available and get pricing.
   *
   * @example
   * const result = await ad.checkDomain("cool.dev");
   * if (result.available) {
   *   console.log(`Price: $${result.pricing.per_year}/year`);
   * }
   */
  async checkDomain(domain: string, registrantCountry?: string): Promise<DomainCheck> {
    const params = new URLSearchParams({ domain });
    if (registrantCountry) params.set("registrant_country", registrantCountry);

    const res = await this.request("GET", `/v1/domains/check?${params}`);
    return res.data;
  }

  /**
   * Check multiple domains at once (up to 50).
   *
   * @example
   * const results = await ad.checkBulk(["cool.dev", "agent.ai", "tld.com"]);
   * const available = results.filter(r => r.available);
   */
  async checkBulk(domains: string[]): Promise<BulkCheckResult[]> {
    const res = await this.request("POST", "/v1/domains/check/bulk", { domains });
    return res.data.results;
  }

  /**
   * Generate domain ideas from keywords and check availability.
   *
   * @example
   * const ideas = await ad.suggestDomains({
   *   keywords: ["agent", "ai"],
   *   tlds: ["dev", "ai", "com"],
   * });
   */
  async suggestDomains(input: DomainIdeasInput): Promise<SuggestDomainsResult> {
    const res = await this.request("POST", "/v1/domains/ideas", input);
    return res.data;
  }

  // --------------------------------------------------------------------------
  // Domain Registration (requires USDC payment)
  // --------------------------------------------------------------------------

  /**
   * Register a domain. Payment is handled automatically via x402.
   *
   * WHOIS privacy is included free with all registrations.
   *
   * @example
   * const order = await ad.buyDomain("cool.dev", {
   *   registrant: {
   *     type: "individual",
   *     first_name: "Jane",
   *     last_name: "Agent",
   *     email: "jane@example.com",
   *     phone: "+12025551234",
   *     address: {
   *       street: "123 AI Street",
   *       city: "San Francisco",
   *       state: "CA",
   *       postal_code: "94105",
   *       country: "US",
   *     },
   *   },
   * });
   * console.log(`Registered! Order: ${order.order_id}`);
   */
  /**
   * Build a complete Registrant by merging per-call fields with constructor defaults.
   * Only first_name, last_name, and address fields without defaults are required.
   *
   * @example
   * // With defaults set in constructor:
   * const registrant = ad.buildRegistrant({
   *   first_name: "Jane",
   *   last_name: "Agent",
   * });
   */
  buildRegistrant(overrides: Partial<Registrant> & { first_name: string; last_name: string }): Registrant {
    const tpl = this.registrantTemplate || {};

    const email = overrides.email || tpl.email;
    const phone = overrides.phone || tpl.phone;
    const street = overrides.address?.street || tpl.address?.street;
    const city = overrides.address?.city || tpl.address?.city;
    const state = overrides.address?.state || tpl.address?.state;
    const postal_code = overrides.address?.postal_code || tpl.address?.postal_code;
    const country = overrides.address?.country || tpl.address?.country;

    if (!email) throw new AgentDomainsError("email is required (provide in overrides or registrantDefaults)", "missing_field", 400);
    if (!phone) throw new AgentDomainsError("phone is required (provide in overrides or registrantDefaults)", "missing_field", 400);
    if (!street) throw new AgentDomainsError("address.street is required (provide in overrides or registrantDefaults)", "missing_field", 400);
    if (!city) throw new AgentDomainsError("address.city is required (provide in overrides or registrantDefaults)", "missing_field", 400);
    if (!state) throw new AgentDomainsError("address.state is required (provide in overrides or registrantDefaults)", "missing_field", 400);
    if (!postal_code) throw new AgentDomainsError("address.postal_code is required (provide in overrides or registrantDefaults)", "missing_field", 400);
    if (!country) throw new AgentDomainsError("address.country is required (provide in overrides or registrantDefaults)", "missing_field", 400);

    return {
      type: overrides.type || tpl.type || "individual",
      first_name: overrides.first_name,
      last_name: overrides.last_name,
      ...(overrides.organization || tpl.organization ? { organization: overrides.organization || tpl.organization } : {}),
      email,
      phone,
      ...(overrides.fax || tpl.fax ? { fax: overrides.fax || tpl.fax } : {}),
      address: {
        street,
        ...(overrides.address?.street2 || tpl.address?.street2 ? { street2: overrides.address?.street2 || tpl.address?.street2 } : {}),
        city,
        state,
        postal_code,
        country,
      },
    };
  }

  async buyDomain(domain: string, options: BuyDomainOptions): Promise<OrderResult> {
    const sourceChain = options.source_chain ?? "base";
    const baseBody = {
      domain,
      years: options.years ?? 1,
      wallet_address: this.walletAddress,
      source_chain: sourceChain,
      registrant: options.registrant,
      ...(options.nameservers && { nameservers: options.nameservers }),
    };
    const idempotencyKey = options.idempotency_key || this.buildDeterministicIdempotencyKey(baseBody);
    const body = {
      ...baseBody,
      idempotency_key: idempotencyKey,
    };

    if (options.prevalidate !== false) {
      const validateRes = await this.request("POST", "/v1/orders/validate", body);
      const validation = validateRes.data as OrderValidationResult;
      if (!validation.valid) {
        const hasDomainActiveError = validation.errors.some((e) => e.code === "domain_already_registered");
        if (hasDomainActiveError) {
          const existingOrder = await this.tryFetchExistingIdempotentOrder(body);
          if (existingOrder) return existingOrder;
        }

        const first = validation.errors[0];
        throw new AgentDomainsError(
          first?.message || "Order validation failed",
          first?.code || "validation_error",
          400,
          validation.errors,
        );
      }
    }

    // Build SIWE headers for credit-first payment flow (if account supports signMessage)
    const siweHeaders = await this.buildSiweHeaders();

    const res = await this.payableRequest("POST", "/v1/orders", body, siweHeaders);
    return res.data;
  }

  /**
   * Sign a SIWE message to prove wallet ownership (enables credit-first payment).
   * Returns empty object if account doesn't support signMessage.
   */
  private async buildSiweHeaders(): Promise<Record<string, string>> {
      if (!this.account.signMessage) return {};
    try {
      const timestamp = Date.now().toString();
      const message = `Sign this message to verify ownership of ${this.walletAddress} for agent-native-domains. Timestamp: ${timestamp}`;
      const signature = await this.account.signMessage({ message });
      return {
        "X-Wallet-Signature": signature,
        "X-Wallet-Message": message,
      };
    } catch {
      // If signing fails (e.g., user rejected), proceed without credits
      return {};
    }
  }

  /**
   * Safe probe for idempotent order reuse.
   * Calls POST /v1/orders without payment headers:
   * - If idempotency key already exists, API returns the existing order (2xx).
   * - Otherwise API returns 402 (no funds moved), and we return null.
   */
  private async tryFetchExistingIdempotentOrder(body: unknown): Promise<OrderResult | null> {
    try {
      const res = await this.request("POST", "/v1/orders", body);
      return res.data as OrderResult;
    } catch (err) {
      if (err instanceof AgentDomainsError && err.status === 402) {
        return null;
      }
      throw err;
    }
  }

  private buildDeterministicIdempotencyKey(payload: unknown): string {
    const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    return `sdk_${hash.slice(0, 48)}`;
  }

  /**
   * Get the status of an order.
   *
   * @example
   * const status = await ad.getOrder("ord_abc123");
   * if (status.status === "completed") {
   *   console.log(`Domain registered!`);
   * }
   */
  async getOrder(orderId: string): Promise<OrderStatus> {
    const res = await this.request("GET", `/v1/orders/${encodeURIComponent(orderId)}`);
    return res.data;
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ success: boolean; data: any }> {
    const url = `${this.baseUrl}${path}`;
    const options: RequestInit = {
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (body) options.body = JSON.stringify(body);

    let res: Response;
    try {
      res = await fetch(url, options);
    } catch (err) {
      throw new AgentDomainsError(
        `Network request failed: ${err instanceof Error ? err.message : "Unknown error"}`,
        "network_error",
        0,
      );
    }
    return this.handleResponse(res);
  }

  private async payableRequest(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<{ success: boolean; data: any }> {
    const url = `${this.baseUrl}${path}`;
    const options: RequestInit = {
      method,
      headers: { "Content-Type": "application/json", ...extraHeaders },
    };
    if (body) options.body = JSON.stringify(body);

    let res: Response;
    try {
      res = await this.payableFetch(url, options);
    } catch (err) {
      if (err instanceof AgentDomainsError) throw err;
      const message = err instanceof Error ? err.message : "Unknown error";
      const lowerMsg = message.toLowerCase();
      const isPaymentError =
        lowerMsg.includes("insufficient") ||
        lowerMsg.includes("balance") ||
        lowerMsg.includes("allowance") ||
        lowerMsg.includes("signature") ||
        lowerMsg.includes("payment") ||
        lowerMsg.includes("402");
      throw new AgentDomainsError(
        isPaymentError ? `Payment failed: ${message}` : `Network request failed: ${message}`,
        isPaymentError ? "payment_error" : "network_error",
        isPaymentError ? 402 : 0,
      );
    }
    return this.handleResponse(res);
  }

  private async handleResponse(res: Response): Promise<{ success: boolean; data: any }> {
    let json: { success: boolean; data?: any; error?: ApiError };
    try {
      json = await res.json();
    } catch {
      throw new AgentDomainsError(
        `Server returned non-JSON response (HTTP ${res.status})`,
        "invalid_response",
        res.status,
      );
    }

    if (!json.success || !res.ok) {
      const rawErr = json.error;
      const err = rawErr && typeof rawErr === "object"
        ? { code: rawErr.code || "unknown", message: rawErr.message || "Request failed" }
        : { code: "unknown", message: typeof rawErr === "string" ? rawErr : "Request failed" };
      throw new AgentDomainsError(err.message, err.code, res.status, rawErr);
    }

    return json as { success: boolean; data: any };
  }
}

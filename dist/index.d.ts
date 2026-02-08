/**
 * @agentdomains/sdk
 *
 * TypeScript SDK for Agent Native Domains.
 * Register domains programmatically with USDC payments via the x402 protocol.
 *
 * Usage:
 *   import { AgentDomains } from "@agentdomains/sdk";
 *   import { privateKeyToAccount } from "viem/accounts";
 *
 *   const account = privateKeyToAccount("0x...");
 *   const ad = new AgentDomains({ account });
 *   const result = await ad.buyDomain("cool.dev", { registrant });
 */
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
    signMessage?(message: {
        message: string;
    }): Promise<`0x${string}`>;
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
        parameters?: {
            order_id: string;
            amount: string;
        };
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
    auth: {
        type: string;
        protocol: string;
        currency: string;
        network: string;
    };
    methods: Array<{
        name: string;
        description: string;
        parameters: Record<string, {
            type: string;
            required: boolean;
            description: string;
        }>;
        returns: string;
        requires_payment: boolean;
    }>;
}
export interface ApiError {
    code: string;
    message: string;
    retry_after_seconds?: number;
    details?: Array<{
        field: string;
        message: string;
    }>;
}
export declare class AgentDomainsError extends Error {
    readonly code: string;
    readonly status: number;
    readonly details?: unknown | undefined;
    constructor(message: string, code: string, status: number, details?: unknown | undefined);
}
export declare class AgentDomains {
    private baseUrl;
    private payableFetch;
    private walletAddress;
    private account;
    private registrantTemplate?;
    /**
     * Returns a structured description of the SDK for LLM tool-use.
     * Call this to understand what the SDK can do without reading docs.
     *
     * @example
     * const schema = AgentDomains.describe();
     * // Pass schema to an LLM as a tool definition
     */
    static describe(): ToolDescription;
    constructor(config: AgentDomainsConfig);
    /**
     * Check if a domain is available and get pricing.
     *
     * @example
     * const result = await ad.checkDomain("cool.dev");
     * if (result.available) {
     *   console.log(`Price: $${result.pricing.per_year}/year`);
     * }
     */
    checkDomain(domain: string, registrantCountry?: string): Promise<DomainCheck>;
    /**
     * Check multiple domains at once (up to 50).
     *
     * @example
     * const results = await ad.checkBulk(["cool.dev", "agent.ai", "tld.com"]);
     * const available = results.filter(r => r.available);
     */
    checkBulk(domains: string[]): Promise<BulkCheckResult[]>;
    /**
     * Generate domain ideas from keywords and check availability.
     *
     * @example
     * const ideas = await ad.suggestDomains({
     *   keywords: ["agent", "ai"],
     *   tlds: ["dev", "ai", "com"],
     * });
     */
    suggestDomains(input: DomainIdeasInput): Promise<SuggestDomainsResult>;
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
    buildRegistrant(overrides: Partial<Registrant> & {
        first_name: string;
        last_name: string;
    }): Registrant;
    buyDomain(domain: string, options: BuyDomainOptions): Promise<OrderResult>;
    /**
     * Sign a SIWE message to prove wallet ownership (enables credit-first payment).
     * Returns empty object if account doesn't support signMessage.
     */
    private buildSiweHeaders;
    /**
     * Safe probe for idempotent order reuse.
     * Calls POST /v1/orders without payment headers:
     * - If idempotency key already exists, API returns the existing order (2xx).
     * - Otherwise API returns 402 (no funds moved), and we return null.
     */
    private tryFetchExistingIdempotentOrder;
    private buildDeterministicIdempotencyKey;
    /**
     * Get the status of an order.
     *
     * @example
     * const status = await ad.getOrder("ord_abc123");
     * if (status.status === "completed") {
     *   console.log(`Domain registered!`);
     * }
     */
    getOrder(orderId: string): Promise<OrderStatus>;
    private request;
    private payableRequest;
    private handleResponse;
}

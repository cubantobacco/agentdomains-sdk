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
import { createHash } from "node:crypto";
export class AgentDomainsError extends Error {
    code;
    status;
    details;
    constructor(message, code, status, details) {
        super(message);
        this.code = code;
        this.status = status;
        this.details = details;
        this.name = "AgentDomainsError";
    }
}
// Network mapping
const NETWORK_MAP = {
    "base-mainnet": "eip155:8453",
    "base-sepolia": "eip155:84532",
};
// ============================================================================
// SDK Client
// ============================================================================
export class AgentDomains {
    baseUrl;
    payableFetch;
    walletAddress;
    account;
    registrantTemplate;
    /**
     * Returns a structured description of the SDK for LLM tool-use.
     * Call this to understand what the SDK can do without reading docs.
     *
     * @example
     * const schema = AgentDomains.describe();
     * // Pass schema to an LLM as a tool definition
     */
    static describe() {
        return {
            name: "AgentDomains",
            description: "Register internet domains and pay with USDC on Base via the x402 protocol. " +
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
                    description: "Register a domain. Costs USDC (price from checkDomain). " +
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
    constructor(config) {
        this.baseUrl = (config.baseUrl || "https://api.agentdomains.ai").replace(/\/$/, "");
        this.registrantTemplate = config.registrantDefaults;
        if (!config.account?.address) {
            throw new Error("account must have an address");
        }
        this.walletAddress = config.account.address.toLowerCase();
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
    async checkDomain(domain, registrantCountry) {
        const params = new URLSearchParams({ domain });
        if (registrantCountry)
            params.set("registrant_country", registrantCountry);
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
    async checkBulk(domains) {
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
    async suggestDomains(input) {
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
    buildRegistrant(overrides) {
        const tpl = this.registrantTemplate || {};
        const email = overrides.email || tpl.email;
        const phone = overrides.phone || tpl.phone;
        const street = overrides.address?.street || tpl.address?.street;
        const city = overrides.address?.city || tpl.address?.city;
        const state = overrides.address?.state || tpl.address?.state;
        const postal_code = overrides.address?.postal_code || tpl.address?.postal_code;
        const country = overrides.address?.country || tpl.address?.country;
        if (!email)
            throw new AgentDomainsError("email is required (provide in overrides or registrantDefaults)", "missing_field", 400);
        if (!phone)
            throw new AgentDomainsError("phone is required (provide in overrides or registrantDefaults)", "missing_field", 400);
        if (!street)
            throw new AgentDomainsError("address.street is required (provide in overrides or registrantDefaults)", "missing_field", 400);
        if (!city)
            throw new AgentDomainsError("address.city is required (provide in overrides or registrantDefaults)", "missing_field", 400);
        if (!state)
            throw new AgentDomainsError("address.state is required (provide in overrides or registrantDefaults)", "missing_field", 400);
        if (!postal_code)
            throw new AgentDomainsError("address.postal_code is required (provide in overrides or registrantDefaults)", "missing_field", 400);
        if (!country)
            throw new AgentDomainsError("address.country is required (provide in overrides or registrantDefaults)", "missing_field", 400);
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
    async buyDomain(domain, options) {
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
            const validation = validateRes.data;
            if (!validation.valid) {
                const hasDomainActiveError = validation.errors.some((e) => e.code === "domain_already_registered");
                if (hasDomainActiveError) {
                    const existingOrder = await this.tryFetchExistingIdempotentOrder(body);
                    if (existingOrder)
                        return existingOrder;
                }
                const first = validation.errors[0];
                throw new AgentDomainsError(first?.message || "Order validation failed", first?.code || "validation_error", 400, validation.errors);
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
    async buildSiweHeaders() {
        if (!this.account.signMessage)
            return {};
        try {
            const timestamp = Date.now().toString();
            const message = `Sign this message to verify ownership of ${this.walletAddress} for agent-native-domains. Timestamp: ${timestamp}`;
            const signature = await this.account.signMessage({ message });
            return {
                "X-Wallet-Signature": signature,
                "X-Wallet-Message": message,
            };
        }
        catch {
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
    async tryFetchExistingIdempotentOrder(body) {
        try {
            const res = await this.request("POST", "/v1/orders", body);
            return res.data;
        }
        catch (err) {
            if (err instanceof AgentDomainsError && err.status === 402) {
                return null;
            }
            throw err;
        }
    }
    buildDeterministicIdempotencyKey(payload) {
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
    async getOrder(orderId) {
        const res = await this.request("GET", `/v1/orders/${encodeURIComponent(orderId)}`);
        return res.data;
    }
    // --------------------------------------------------------------------------
    // Internal helpers
    // --------------------------------------------------------------------------
    async request(method, path, body) {
        const url = `${this.baseUrl}${path}`;
        const options = {
            method,
            headers: { "Content-Type": "application/json" },
        };
        if (body)
            options.body = JSON.stringify(body);
        let res;
        try {
            res = await fetch(url, options);
        }
        catch (err) {
            throw new AgentDomainsError(`Network request failed: ${err instanceof Error ? err.message : "Unknown error"}`, "network_error", 0);
        }
        return this.handleResponse(res);
    }
    async payableRequest(method, path, body, extraHeaders) {
        const url = `${this.baseUrl}${path}`;
        const options = {
            method,
            headers: { "Content-Type": "application/json", ...extraHeaders },
        };
        if (body)
            options.body = JSON.stringify(body);
        let res;
        try {
            res = await this.payableFetch(url, options);
        }
        catch (err) {
            if (err instanceof AgentDomainsError)
                throw err;
            const message = err instanceof Error ? err.message : "Unknown error";
            const lowerMsg = message.toLowerCase();
            const isPaymentError = lowerMsg.includes("insufficient") ||
                lowerMsg.includes("balance") ||
                lowerMsg.includes("allowance") ||
                lowerMsg.includes("signature") ||
                lowerMsg.includes("payment") ||
                lowerMsg.includes("402");
            throw new AgentDomainsError(isPaymentError ? `Payment failed: ${message}` : `Network request failed: ${message}`, isPaymentError ? "payment_error" : "network_error", isPaymentError ? 402 : 0);
        }
        return this.handleResponse(res);
    }
    async handleResponse(res) {
        let json;
        try {
            json = await res.json();
        }
        catch {
            throw new AgentDomainsError(`Server returned non-JSON response (HTTP ${res.status})`, "invalid_response", res.status);
        }
        if (!json.success || !res.ok) {
            const rawErr = json.error;
            const err = rawErr && typeof rawErr === "object"
                ? { code: rawErr.code || "unknown", message: rawErr.message || "Request failed" }
                : { code: "unknown", message: typeof rawErr === "string" ? rawErr : "Request failed" };
            throw new AgentDomainsError(err.message, err.code, res.status, rawErr);
        }
        return json;
    }
}

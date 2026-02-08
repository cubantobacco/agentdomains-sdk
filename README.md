# agentdomains-sdk

TypeScript SDK for [Agent Native Domains](https://api.agentdomains.ai) — register domains programmatically with USDC payments via the x402 protocol.

## Install

```bash
npm install agentdomains-sdk viem
```

## Quick Start

```typescript
import { AgentDomains } from "agentdomains-sdk";
import { privateKeyToAccount } from "viem/accounts";

// 1. Set up account
const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);

// 2. Create client
const ad = new AgentDomains({ account });

// 3. Check availability
const check = await ad.checkDomain("cool.dev");
console.log(check.available, check.pricing.per_year);

// 4. Register (payment handled automatically)
const order = await ad.buyDomain("cool.dev", {
  registrant: {
    type: "individual",
    first_name: "Jane",
    last_name: "Agent",
    email: "jane@example.com",
    phone: "+12025551234",
    address: {
      street: "123 AI Street",
      city: "San Francisco",
      state: "CA",
      postal_code: "94105",
      country: "US",
    },
  },
});

console.log(`Registered! Order: ${order.order_id}`);
```

## Wallet Setup

Your wallet needs two things on **Base** (Coinbase L2):

| Token | Purpose | Amount |
|-------|---------|--------|
| **USDC** | Domain payments | Varies by TLD ($5-90/year) |
| **ETH** | Gas fees for signing | ~$0.10 (lasts many transactions) |

### Getting USDC on Base

- **Bridge from Ethereum**: Use the [Base Bridge](https://bridge.base.org) or [Coinbase](https://www.coinbase.com)
- **Buy directly**: Purchase USDC on Base through Coinbase or any DEX

### Getting ETH on Base

- **Bridge from Ethereum**: Use the [Base Bridge](https://bridge.base.org)
- **For testnet**: Use the [Base Sepolia faucet](https://www.alchemy.com/faucets/base-sepolia)

### Signing (No Raw Private Key Required)

The SDK needs an `EvmSigner` — anything that can sign EIP-712 typed data. Raw private keys are **one option**, not the only one.

#### Option 1: Private Key (simplest for scripts)

```typescript
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
const ad = new AgentDomains({ account });
```

#### Option 2: Coinbase CDP Wallet (no raw key exposure)

Use [Coinbase CDP AgentKit](https://docs.cdp.coinbase.com/agentkit) for MPC-based signing. The private key is split across multiple parties and never fully assembled.

```typescript
import { CdpWalletProvider } from "@coinbase/agentkit";

const walletProvider = await CdpWalletProvider.configureWithWallet({
  apiKeyName: process.env.CDP_API_KEY_NAME,
  apiKeyPrivateKey: process.env.CDP_API_KEY_PRIVATE_KEY,
  networkId: "base-mainnet",
});

const ad = new AgentDomains({
  account: {
    address: walletProvider.getAddress() as `0x${string}`,
    signTypedData: (msg) => walletProvider.signTypedData(msg),
    signMessage: (msg) => walletProvider.signMessage(msg.message),
  },
});
```

#### Option 3: Custom Signer (wrap any provider)

Any object matching the `EvmSigner` interface works — hardware wallets, KMS, MPC services, or smart contract wallets:

```typescript
import type { EvmSigner } from "agentdomains-sdk";

const customSigner: EvmSigner = {
  address: "0xYourAddress",
  async signTypedData({ domain, types, primaryType, message }) {
    // Route to your signing infrastructure
    return await yourKmsService.signEIP712(domain, types, primaryType, message);
  },
  async signMessage({ message }) {
    // Optional: enables credit-first payment flow
    return await yourKmsService.signPersonal(message);
  },
};

const ad = new AgentDomains({ account: customSigner });
```

> **Note:** `signMessage` is optional. If provided, the SDK will attempt credit-based payment (SIWE wallet proof) before falling back to x402.

## For AI Agents

### Tool Discovery

LLM agents can inspect available methods without reading docs:

```typescript
const schema = AgentDomains.describe();
// Returns structured JSON with all methods, parameters, and return types
// Pass this to your agent's tool registry
```

### Registrant Defaults

Set common registrant fields once to minimize per-call boilerplate:

```typescript
const ad = new AgentDomains({
  account,
  registrantDefaults: {
    type: "individual",
    email: "agent@example.com",
    phone: "+12025551234",
    address: {
      street: "123 AI Street",
      city: "San Francisco",
      state: "CA",
      postal_code: "94105",
      country: "US",
    },
  },
});

// Now buyDomain only needs the unique fields
const registrant = ad.buildRegistrant({
  first_name: "Jane",
  last_name: "Agent",
});
const order = await ad.buyDomain("cool.dev", { registrant });
```

## API Reference

### `AgentDomains.describe()`

Static method. Returns a structured JSON description of the SDK for LLM tool-use integration. No instantiation needed.

### `new AgentDomains(config)`

Create a new client.

```typescript
const ad = new AgentDomains({
  account,                                     // Required: viem LocalAccount
  baseUrl: "https://api.agentdomains.ai",      // Optional: API URL
  network: "base-mainnet",                     // Optional: "base-mainnet" | "base-sepolia"
  registrantDefaults: { ... },                 // Optional: pre-fill registrant fields
});
```

### `ad.buildRegistrant(overrides)`

Merge per-call fields with constructor defaults. Only `first_name` and `last_name` are required if defaults cover the rest.

```typescript
const registrant = ad.buildRegistrant({
  first_name: "Jane",
  last_name: "Agent",
  // All other fields pulled from registrantDefaults
});
```

### `ad.checkDomain(domain, registrantCountry?)`

Check domain availability and pricing. Free, no payment required.

```typescript
const check = await ad.checkDomain("cool.dev");
// { domain, available, tld, pricing, registration_period }

// With country check for ccTLD restrictions:
const check = await ad.checkDomain("example.eu", "US");
// check.warnings: [".eu domains require EU/EEA registrant"]
```

### `ad.checkBulk(domains)`

Check up to 50 domains at once.

```typescript
const results = await ad.checkBulk(["cool.dev", "agent.ai", "tld.com"]);
const available = results.filter(r => r.available);
```

### `ad.suggestDomains(input)`

Generate domain ideas from keywords.

```typescript
const ideas = await ad.suggestDomains({
  keywords: ["agent", "ai"],
  tlds: ["dev", "ai", "com"],
  patterns: ["exact", "hyphenated"],
  max_to_check: 100,
});
```

### `ad.buyDomain(domain, options)`

Register a domain. USDC payment is handled automatically via x402.

WHOIS privacy is included free with all registrations.

```typescript
const order = await ad.buyDomain("cool.dev", {
  registrant: { ... },           // Required: contact info
  years: 2,                      // Optional: 1-10 (default: 1)
  source_chain: "base",          // Optional metadata: base|arbitrum|ethereum|solana
  prevalidate: true,             // Optional: validates before payment (default true)
  nameservers: [                  // Optional: custom nameservers
    "ns1.cloudflare.com",
    "ns2.cloudflare.com",
  ],
  idempotency_key: "unique-id",  // Optional: explicit idempotency key
});
```

If `idempotency_key` is omitted, the SDK derives a deterministic key from the order payload to make retries safer.

### `ad.getOrder(orderId)`

Check order status.

```typescript
const status = await ad.getOrder("ord_abc123");
// status.status: "completed" | "processing" | "failed" | ...
```

## Error Handling

```typescript
import { AgentDomainsError } from "agentdomains-sdk";

try {
  await ad.buyDomain("taken.com", { registrant });
} catch (err) {
  if (err instanceof AgentDomainsError) {
    console.log(err.code);    // "domain_unavailable"
    console.log(err.status);  // 400
    console.log(err.message); // "Domain is not available"

    if (err.code === "rate_limited") {
      const retryAfter = (err.details as any)?.retry_after_seconds;
      await new Promise(r => setTimeout(r, retryAfter * 1000));
    }
  }
}
```

## TLD-Specific Rules

Some TLDs have minimum registration periods or registrant restrictions:

| TLD | Min Years | Restriction |
|-----|-----------|-------------|
| `.ai` | 2 | None |
| `.tm` | 10 | None |
| `.us` | 1 | US nexus required |
| `.eu` | 1 | EU/EEA registrant required |
| `.ca` | 1 | Canadian presence required |
| `.uk` | 1 | UK address required |
| `.au` | 1 | Australian ABN/ACN required |

Use `registrant_country` in `checkDomain()` to get warnings before purchase.

## Testing

For development, point to a testnet instance:

```typescript
const ad = new AgentDomains({
  account,                            // Your viem account
  baseUrl: "http://localhost:3000",   // Local dev server
  network: "base-sepolia",           // Use testnet
});
```

Check `GET /health` on any instance to see if it's testnet (`"testnet": true`).

## License

MIT

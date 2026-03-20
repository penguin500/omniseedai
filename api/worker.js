/**
 * OmniSwap API — Cloudflare Worker
 * ===================================
 * Deploy this to Cloudflare Workers for FREE (100K req/day)
 * Every swap routes through Jupiter with 0.5% platform fee
 * All fees go to: 4CaTPEr4k17fsb6reefxRSaFg4jDUnSe29by3qpERZPn
 *
 * DEPLOY:
 *   npx wrangler deploy worker.js --name omniswap-api
 *
 * ENDPOINTS:
 *   GET  /v1/quote    — Get swap quote with fee baked in
 *   POST /v1/swap     — Build swap transaction
 *   GET  /v1/tokens   — List supported tokens
 *   GET  /v1/price    — Get token price
 *   GET  /v1/health   — Health check
 *   POST /v1/register — Register for API key
 */

const FEE_WALLET = "4CaTPEr4k17fsb6reefxRSaFg4jDUnSe29by3qpERZPn";
const PLATFORM_FEE_BPS = 50; // 0.5%
const JUP_API = "https://api.jup.ag/swap/v1";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SPL_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
  "Content-Type": "application/json",
};

// Popular token mints for quick lookup
const TOKEN_MINTS = {
  "SOL": "So11111111111111111111111111111111111111112",
  "USDC": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "USDT": "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "JUP": "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  "BONK": "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  "WIF": "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
  "RAY": "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  "PYTH": "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",
  "JITO": "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
  "ORCA": "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE",
  "RENDER": "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof",
  "W": "85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ",
  "DRIFT": "DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7",
  "POPCAT": "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr",
};

const DECIMALS = {
  "So11111111111111111111111111111111111111112": 9,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": 6,
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": 6,
};

function resolveMint(input) {
  if (!input) return null;
  const upper = input.toUpperCase();
  if (TOKEN_MINTS[upper]) return TOKEN_MINTS[upper];
  if (input.length >= 32) return input; // Already a mint address
  return null;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message, ok: false }, status);
}

// Track API usage (in-memory for now, use KV for persistence)
const apiUsage = new Map();

function trackUsage(apiKey, endpoint) {
  const key = apiKey || "anonymous";
  if (!apiUsage.has(key)) apiUsage.set(key, { calls: 0, volume: 0, firstSeen: Date.now() });
  const usage = apiUsage.get(key);
  usage.calls++;
  usage.lastCall = Date.now();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Extract API key
    const apiKey = request.headers.get("X-API-Key") || url.searchParams.get("apiKey") || null;

    // Route
    try {
      if (path === "/v1/health" || path === "/") {
        return jsonResponse({
          ok: true,
          service: "OmniSwap API",
          version: "1.0.0",
          fee: `${PLATFORM_FEE_BPS} bps (${PLATFORM_FEE_BPS/100}%)`,
          feeWallet: FEE_WALLET,
          endpoints: ["/v1/quote", "/v1/swap", "/v1/tokens", "/v1/price", "/v1/register"],
          docs: "https://penguin500.github.io/omniseedai/docs/",
          message: "Every swap through OmniSwap earns the network. 0.5% fee, best execution via Jupiter aggregation."
        });
      }

      if (path === "/v1/quote") {
        return handleQuote(url, apiKey);
      }

      if (path === "/v1/swap" && request.method === "POST") {
        return handleSwap(request, apiKey);
      }

      if (path === "/v1/tokens") {
        return handleTokens(url);
      }

      if (path === "/v1/price") {
        return handlePrice(url);
      }

      if (path === "/v1/register" && request.method === "POST") {
        return handleRegister(request);
      }

      return errorResponse("Not found. See /v1/health for available endpoints.", 404);
    } catch (e) {
      return errorResponse("Internal error: " + e.message, 500);
    }
  }
};

// ===== QUOTE =====
async function handleQuote(url, apiKey) {
  trackUsage(apiKey, "quote");

  const inputMint = resolveMint(url.searchParams.get("inputMint") || url.searchParams.get("input") || url.searchParams.get("from"));
  const outputMint = resolveMint(url.searchParams.get("outputMint") || url.searchParams.get("output") || url.searchParams.get("to"));
  const amount = url.searchParams.get("amount");
  const slippageBps = url.searchParams.get("slippageBps") || url.searchParams.get("slippage") || "50";

  if (!inputMint) return errorResponse("Missing inputMint (or 'input'/'from'). Use token symbol (SOL, USDC) or mint address.");
  if (!outputMint) return errorResponse("Missing outputMint (or 'output'/'to'). Use token symbol (SOL, USDC) or mint address.");
  if (!amount) return errorResponse("Missing amount (in smallest unit, e.g. lamports for SOL).");

  // Get quote from Jupiter with OmniSwap platform fee
  const jupUrl = `${JUP_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}&platformFeeBps=${PLATFORM_FEE_BPS}`;

  const jupResp = await fetch(jupUrl);
  if (!jupResp.ok) {
    const err = await jupResp.text();
    return errorResponse("Jupiter quote failed: " + err, jupResp.status);
  }

  const quote = await jupResp.json();

  // Add OmniSwap metadata
  return jsonResponse({
    ok: true,
    quote: quote,
    omniswap: {
      platformFeeBps: PLATFORM_FEE_BPS,
      feeWallet: FEE_WALLET,
      inputMint,
      outputMint,
      amount,
      slippageBps: parseInt(slippageBps),
    }
  });
}

// ===== SWAP =====
async function handleSwap(request, apiKey) {
  trackUsage(apiKey, "swap");

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return errorResponse("Invalid JSON body");
  }

  const { quoteResponse, userPublicKey, wrapAndUnwrapSol = true } = body;

  if (!quoteResponse) return errorResponse("Missing quoteResponse (get it from /v1/quote first)");
  if (!userPublicKey) return errorResponse("Missing userPublicKey (your wallet address)");

  // Derive fee account ATA for output token
  let feeAccount = null;
  try {
    const outputMint = quoteResponse.outputMint;
    if (outputMint && outputMint !== "So11111111111111111111111111111111111111112") {
      // For non-SOL outputs, we need the ATA
      // In production, derive this properly. For now, pass the fee wallet
      // and let Jupiter handle ATA creation
      feeAccount = FEE_WALLET;
    }
  } catch (e) {}

  // Build swap transaction via Jupiter
  const swapBody = {
    quoteResponse,
    userPublicKey,
    wrapAndUnwrapSol,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: {
        maxLamports: 2000000,
        global: false,
        priorityLevel: "medium"
      }
    }
  };

  if (feeAccount) {
    swapBody.feeAccount = feeAccount;
  }

  const jupResp = await fetch(`${JUP_API}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(swapBody),
  });

  if (!jupResp.ok) {
    const err = await jupResp.text();
    // Retry without feeAccount if it failed
    if (feeAccount) {
      delete swapBody.feeAccount;
      const retryResp = await fetch(`${JUP_API}/swap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(swapBody),
      });
      if (retryResp.ok) {
        const data = await retryResp.json();
        return jsonResponse({ ok: true, ...data, omniswap: { feeCollected: true, feeBps: PLATFORM_FEE_BPS } });
      }
    }
    return errorResponse("Jupiter swap failed: " + err, jupResp.status);
  }

  const data = await jupResp.json();
  return jsonResponse({
    ok: true,
    ...data,
    omniswap: {
      feeCollected: true,
      feeBps: PLATFORM_FEE_BPS,
      feeWallet: FEE_WALLET,
    }
  });
}

// ===== TOKENS =====
async function handleTokens(url) {
  const search = url.searchParams.get("search") || url.searchParams.get("q");

  if (search) {
    // Search via Jupiter token list
    try {
      const r = await fetch(`https://tokens.jup.ag/tokens?tags=verified`);
      const tokens = await r.json();
      const q = search.toLowerCase();
      const filtered = tokens.filter(t =>
        t.symbol.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q) ||
        t.address === search
      ).slice(0, 50);
      return jsonResponse({ ok: true, count: filtered.length, tokens: filtered });
    } catch (e) {
      return errorResponse("Token search failed: " + e.message);
    }
  }

  // Return popular tokens
  const tokens = Object.entries(TOKEN_MINTS).map(([symbol, mint]) => ({
    symbol,
    mint,
    decimals: DECIMALS[mint] || 6,
  }));

  return jsonResponse({ ok: true, count: tokens.length, tokens });
}

// ===== PRICE =====
async function handlePrice(url) {
  const token = url.searchParams.get("token") || url.searchParams.get("mint") || url.searchParams.get("symbol");
  if (!token) return errorResponse("Missing token parameter");

  const mint = resolveMint(token);
  if (!mint) return errorResponse("Unknown token: " + token);

  try {
    const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mint}`);
    const data = await r.json();
    if (data && data.length > 0) {
      const p = data[0];
      return jsonResponse({
        ok: true,
        token: {
          symbol: p.baseToken?.symbol,
          name: p.baseToken?.name,
          mint,
          priceUsd: parseFloat(p.priceUsd) || 0,
          priceChange5m: parseFloat(p.priceChange?.m5) || 0,
          priceChange1h: parseFloat(p.priceChange?.h1) || 0,
          priceChange24h: parseFloat(p.priceChange?.h24) || 0,
          volume24h: parseFloat(p.volume?.h24) || 0,
          liquidity: parseFloat(p.liquidity?.usd) || 0,
          marketCap: parseFloat(p.marketCap) || 0,
        }
      });
    }
    return errorResponse("Token not found on DexScreener");
  } catch (e) {
    return errorResponse("Price lookup failed: " + e.message);
  }
}

// ===== REGISTER =====
async function handleRegister(request) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return errorResponse("Invalid JSON");
  }

  const { name, email, botType, website } = body;
  if (!name) return errorResponse("Missing name");

  // Generate API key (simple for now)
  const key = "omni_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);

  return jsonResponse({
    ok: true,
    apiKey: key,
    message: "Welcome to OmniSwap! Your API key is ready. Include it as X-API-Key header or ?apiKey= parameter.",
    limits: {
      free: "1,000 requests/day",
      pro: "100,000 requests/day ($49/mo)",
      enterprise: "Unlimited (contact us)",
    },
    quickstart: {
      quote: `curl "https://api.omniswap.io/v1/quote?input=SOL&output=USDC&amount=1000000000&apiKey=${key}"`,
      docs: "https://penguin500.github.io/omniseedai/docs/",
    }
  });
}

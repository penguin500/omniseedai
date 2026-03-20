/**
 * OmniSwap JavaScript SDK v1.0
 * =============================
 * Swap any Solana token in 3 lines. Built for bots, agents & dApps.
 * 0.5% platform fee on every swap -> OmniSwap network.
 *
 * INSTALL:
 *   npm install omniswap  (coming soon)
 *   OR: <script src="https://penguin500.github.io/omniseedai/sdk/js/omniswap.js"></script>
 *
 * USAGE (Node.js):
 *   const { OmniSwap } = require('./omniswap');
 *   const swap = new OmniSwap();
 *   const quote = await swap.quote('SOL', 'USDC', { amountSol: 1.5 });
 *   console.log(`Output: ${quote.outputHuman} USDC`);
 *
 * USAGE (Browser):
 *   const swap = new OmniSwap();
 *   const quote = await swap.quote('SOL', 'USDC', { amountSol: 1.5 });
 *
 * AGENT USAGE:
 *   const tools = swap.agentTools(); // For Claude/GPT function calling
 */

(function(root) {
  'use strict';

  const VERSION = '1.0.0';
  const FEE_WALLET = '4CaTPEr4k17fsb6reefxRSaFg4jDUnSe29by3qpERZPn';
  const PLATFORM_FEE_BPS = 50;
  const JUP_API = 'https://api.jup.ag/swap/v1';

  const TOKEN_MINTS = {
    SOL: 'So11111111111111111111111111111111111111112',
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    RAY: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
    PYTH: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
    JITO: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
    ORCA: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
    RENDER: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof',
  };

  const DECIMALS = {
    'So11111111111111111111111111111111111111112': 9,
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 6,
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 6,
  };

  function resolveMint(token) {
    if (!token) throw new Error('Token required');
    const upper = token.toUpperCase();
    if (TOKEN_MINTS[upper]) return TOKEN_MINTS[upper];
    if (token.length >= 32) return token;
    throw new Error(`Unknown token: ${token}. Use symbol (SOL, USDC) or mint address.`);
  }

  function getDecimals(mint) {
    return DECIMALS[mint] || 6;
  }

  class OmniSwap {
    constructor(options = {}) {
      this.apiKey = options.apiKey || null;
      this.rpcUrl = options.rpcUrl || 'https://api.mainnet-beta.solana.com';
      this.feeBps = PLATFORM_FEE_BPS;
      this.feeWallet = FEE_WALLET;
    }

    /**
     * Get swap quote with OmniSwap fee included
     * @param {string} inputToken - Token to sell (symbol or mint)
     * @param {string} outputToken - Token to buy (symbol or mint)
     * @param {object} opts - { amount, amountSol, slippageBps }
     */
    async quote(inputToken, outputToken, opts = {}) {
      const inputMint = resolveMint(inputToken);
      const outputMint = resolveMint(outputToken);
      const inDecimals = getDecimals(inputMint);
      const outDecimals = getDecimals(outputMint);

      let amount = opts.amount;
      if (!amount && opts.amountSol) {
        amount = Math.floor(opts.amountSol * Math.pow(10, inDecimals));
      }
      if (!amount) throw new Error('Provide amount or amountSol');

      const slippageBps = opts.slippageBps || 50;

      const url = `${JUP_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}&platformFeeBps=${PLATFORM_FEE_BPS}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Quote failed: ${await resp.text()}`);
      const quoteData = await resp.json();

      const outAmount = parseInt(quoteData.outAmount || '0');

      return {
        ok: true,
        quote: quoteData,
        inputToken,
        outputToken,
        inputMint,
        outputMint,
        inputAmount: amount,
        inputHuman: amount / Math.pow(10, inDecimals),
        outputAmount: outAmount,
        outputHuman: outAmount / Math.pow(10, outDecimals),
        priceImpact: quoteData.priceImpactPct || '0',
        platformFeeBps: PLATFORM_FEE_BPS,
        feeWallet: FEE_WALLET,
        slippageBps,
      };
    }

    /**
     * Build swap transaction (unsigned, for external signing)
     * @param {object} quoteResult - Result from quote()
     * @param {string} walletAddress - Signer's public key
     */
    async buildTransaction(quoteResult, walletAddress) {
      if (!quoteResult?.quote) throw new Error('Invalid quote - call quote() first');
      if (!walletAddress) throw new Error('walletAddress required');

      const body = {
        quoteResponse: quoteResult.quote,
        userPublicKey: walletAddress,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: {
            maxLamports: 2000000,
            global: false,
            priorityLevel: 'medium',
          }
        },
      };

      const resp = await fetch(`${JUP_API}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!resp.ok) throw new Error(`Swap build failed: ${await resp.text()}`);
      const data = await resp.json();

      return {
        ok: true,
        swapTransaction: data.swapTransaction,
        lastValidBlockHeight: data.lastValidBlockHeight,
        quote: quoteResult,
      };
    }

    /**
     * Execute swap with Phantom or any wallet provider
     * @param {string} inputToken - Token to sell
     * @param {string} outputToken - Token to buy
     * @param {object} opts - { amountSol, wallet (Phantom provider) }
     */
    async executeWithWallet(inputToken, outputToken, opts = {}) {
      const wallet = opts.wallet || (typeof window !== 'undefined' && window.phantom?.solana);
      if (!wallet) throw new Error('Wallet not found. Pass opts.wallet or connect Phantom.');

      // Ensure connected
      if (!wallet.publicKey) {
        await wallet.connect();
      }
      const pubkey = wallet.publicKey.toBase58();

      // Get quote
      const quoteResult = await this.quote(inputToken, outputToken, opts);

      // Build transaction
      const txResult = await this.buildTransaction(quoteResult, pubkey);

      // Deserialize and sign
      const txBytes = Uint8Array.from(atob(txResult.swapTransaction), c => c.charCodeAt(0));

      let signature;
      if (typeof solanaWeb3 !== 'undefined') {
        const tx = solanaWeb3.VersionedTransaction.deserialize(txBytes);
        const result = await wallet.signAndSendTransaction(tx);
        signature = result.signature;
      } else {
        // Fallback: let wallet handle everything
        const result = await wallet.signAndSendTransaction(txBytes);
        signature = result.signature;
      }

      return {
        ok: true,
        signature,
        explorer: `https://solscan.io/tx/${signature}`,
        input: quoteResult.inputHuman,
        output: quoteResult.outputHuman,
        inputToken,
        outputToken,
        feeBps: PLATFORM_FEE_BPS,
      };
    }

    /**
     * Get token price from DexScreener
     */
    async price(token) {
      const mint = resolveMint(token);
      const resp = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mint}`);
      const data = await resp.json();
      if (data && data.length > 0) {
        const p = data[0];
        return {
          symbol: p.baseToken?.symbol || '?',
          name: p.baseToken?.name || '?',
          mint,
          priceUsd: parseFloat(p.priceUsd) || 0,
          priceChange5m: parseFloat(p.priceChange?.m5) || 0,
          priceChange1h: parseFloat(p.priceChange?.h1) || 0,
          priceChange24h: parseFloat(p.priceChange?.h24) || 0,
          volume24h: parseFloat(p.volume?.h24) || 0,
          liquidity: parseFloat(p.liquidity?.usd) || 0,
        };
      }
      throw new Error(`Token ${token} not found`);
    }

    /**
     * Returns AI agent tool definitions (Claude/GPT function calling format)
     */
    agentTools() {
      return [
        {
          name: 'omniswap_quote',
          description: 'Get a swap quote for any Solana token pair with best price via Jupiter aggregation. Returns expected output amount.',
          input_schema: {
            type: 'object',
            properties: {
              input_token: { type: 'string', description: 'Token to sell (SOL, USDC, or mint address)' },
              output_token: { type: 'string', description: 'Token to buy' },
              amount_sol: { type: 'number', description: 'Amount to swap (in SOL or token units)' },
            },
            required: ['input_token', 'output_token', 'amount_sol'],
          },
        },
        {
          name: 'omniswap_execute',
          description: 'Execute a token swap on Solana blockchain. Requires connected wallet.',
          input_schema: {
            type: 'object',
            properties: {
              input_token: { type: 'string', description: 'Token to sell' },
              output_token: { type: 'string', description: 'Token to buy' },
              amount_sol: { type: 'number', description: 'Amount to swap' },
            },
            required: ['input_token', 'output_token', 'amount_sol'],
          },
        },
        {
          name: 'omniswap_price',
          description: 'Get current price and market data for any Solana token.',
          input_schema: {
            type: 'object',
            properties: {
              token: { type: 'string', description: 'Token symbol (SOL, BONK) or mint address' },
            },
            required: ['token'],
          },
        },
      ];
    }

    /** SDK info */
    info() {
      return {
        name: 'OmniSwap SDK',
        version: VERSION,
        feeBps: PLATFORM_FEE_BPS,
        feeWallet: FEE_WALLET,
        tokens: Object.keys(TOKEN_MINTS),
        docs: 'https://penguin500.github.io/omniseedai/docs/',
      };
    }
  }

  // Export for Node.js and browser
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { OmniSwap, TOKEN_MINTS, resolveMint, VERSION };
  }
  if (typeof root !== 'undefined') {
    root.OmniSwap = OmniSwap;
  }

})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);

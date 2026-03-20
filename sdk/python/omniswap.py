"""
OmniSwap Python SDK v1.0
=========================
The simplest way to swap tokens on Solana. Built for bots & agents.
Every swap includes 0.5% platform fee -> OmniSwap network.

INSTALL:
    pip install omniswap  (coming soon)
    OR just copy this file into your project

USAGE:
    from omniswap import OmniSwap

    # Initialize
    swap = OmniSwap(api_key="your_key")  # Optional API key

    # Get a quote
    quote = swap.quote("SOL", "USDC", amount_sol=1.5)
    print(f"You'll get: {quote['output_amount']} USDC")

    # Execute swap (requires wallet private key)
    result = swap.execute("SOL", "USDC", amount_sol=1.5, private_key="your_base58_key")
    print(f"TX: {result['signature']}")

    # Get token price
    price = swap.price("SOL")
    print(f"SOL: ${price['priceUsd']}")

    # Search tokens
    tokens = swap.search_tokens("bonk")

AGENT INTEGRATION:
    # For AI agents (Claude, GPT, custom)
    swap = OmniSwap()
    tools = swap.as_agent_tools()  # Returns tool definitions for agent frameworks
"""

import json
import time
import base64
import struct
import hashlib
import requests
from typing import Optional, Dict, List, Tuple, Any

__version__ = "1.0.0"
__author__ = "OmniSwap"

# ===== CONSTANTS =====
OMNISWAP_API = "https://omniswap-api.workers.dev"  # Cloudflare Worker
JUP_API = "https://api.jup.ag/swap/v1"
FEE_WALLET = "4CaTPEr4k17fsb6reefxRSaFg4jDUnSe29by3qpERZPn"
PLATFORM_FEE_BPS = 50  # 0.5%

SOLANA_RPCS = [
    "https://api.mainnet-beta.solana.com",
    "https://solana-rpc.publicnode.com",
]

TOKEN_MINTS = {
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
}

DECIMALS = {
    "So11111111111111111111111111111111111111112": 9,
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": 6,
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": 6,
}


def resolve_mint(token: str) -> str:
    """Resolve token symbol or mint address."""
    upper = token.upper()
    if upper in TOKEN_MINTS:
        return TOKEN_MINTS[upper]
    if len(token) >= 32:
        return token
    raise ValueError(f"Unknown token: {token}. Use symbol (SOL, USDC) or full mint address.")


def get_decimals(mint: str) -> int:
    """Get token decimals."""
    return DECIMALS.get(mint, 6)


class OmniSwap:
    """
    OmniSwap SDK - Swap any Solana token with one line of code.
    All swaps include 0.5% platform fee to support the OmniSwap network.
    """

    def __init__(self, api_key: Optional[str] = None, rpc_url: Optional[str] = None):
        self.api_key = api_key
        self.rpc_url = rpc_url or SOLANA_RPCS[0]
        self.session = requests.Session()
        self.session.headers.update({
            "Accept": "application/json",
            "Content-Type": "application/json",
        })
        if api_key:
            self.session.headers["X-API-Key"] = api_key

    # ===== QUOTE =====
    def quote(
        self,
        input_token: str,
        output_token: str,
        amount: Optional[int] = None,
        amount_sol: Optional[float] = None,
        amount_usd: Optional[float] = None,
        slippage_bps: int = 50,
    ) -> Dict:
        """
        Get a swap quote with OmniSwap fee included.

        Args:
            input_token: Token symbol (SOL, USDC) or mint address
            output_token: Token symbol or mint address
            amount: Raw amount in smallest unit (lamports for SOL)
            amount_sol: Amount in SOL (convenience, converts to lamports)
            amount_usd: Amount in USD (convenience, converts via price lookup)
            slippage_bps: Slippage tolerance in basis points (default 50 = 0.5%)

        Returns:
            Quote dict with input/output amounts, route info, and fee details
        """
        input_mint = resolve_mint(input_token)
        output_mint = resolve_mint(output_token)

        # Resolve amount
        if amount is None:
            if amount_sol is not None:
                amount = int(amount_sol * 10 ** get_decimals(input_mint))
            elif amount_usd is not None:
                # Look up price first
                p = self.price(input_token)
                price = p.get("priceUsd", 0)
                if price <= 0:
                    raise ValueError(f"Could not get price for {input_token}")
                token_amount = amount_usd / price
                amount = int(token_amount * 10 ** get_decimals(input_mint))
            else:
                raise ValueError("Provide amount, amount_sol, or amount_usd")

        # Get quote from Jupiter with platform fee
        url = (
            f"{JUP_API}/quote"
            f"?inputMint={input_mint}"
            f"&outputMint={output_mint}"
            f"&amount={amount}"
            f"&slippageBps={slippage_bps}"
            f"&platformFeeBps={PLATFORM_FEE_BPS}"
        )

        resp = self.session.get(url, timeout=10)
        resp.raise_for_status()
        quote_data = resp.json()

        # Enrich with readable info
        out_amount = int(quote_data.get("outAmount", 0))
        out_decimals = get_decimals(output_mint)
        in_decimals = get_decimals(input_mint)

        return {
            "ok": True,
            "quote": quote_data,
            "input_token": input_token,
            "output_token": output_token,
            "input_amount": amount,
            "input_human": amount / 10 ** in_decimals,
            "output_amount": out_amount,
            "output_human": out_amount / 10 ** out_decimals,
            "price_impact": quote_data.get("priceImpactPct", "0"),
            "platform_fee_bps": PLATFORM_FEE_BPS,
            "fee_wallet": FEE_WALLET,
            "slippage_bps": slippage_bps,
        }

    # ===== EXECUTE SWAP =====
    def execute(
        self,
        input_token: str,
        output_token: str,
        amount: Optional[int] = None,
        amount_sol: Optional[float] = None,
        private_key: Optional[str] = None,
        wallet_address: Optional[str] = None,
        slippage_bps: int = 50,
        sign_only: bool = False,
    ) -> Dict:
        """
        Execute a swap on Solana.

        Args:
            input_token: Token to sell
            output_token: Token to buy
            amount: Raw amount in smallest unit
            amount_sol: Amount in SOL (convenience)
            private_key: Base58 private key (required for auto-sign)
            wallet_address: Wallet public key (required if sign_only=True)
            slippage_bps: Slippage tolerance
            sign_only: If True, returns unsigned transaction for external signing

        Returns:
            Transaction signature or unsigned transaction bytes
        """
        # Get quote first
        q = self.quote(input_token, output_token, amount=amount, amount_sol=amount_sol, slippage_bps=slippage_bps)
        quote_data = q["quote"]

        # Determine wallet address
        if private_key and not wallet_address:
            wallet_address = self._get_pubkey(private_key)
        if not wallet_address:
            raise ValueError("Provide private_key or wallet_address")

        # Build swap transaction
        swap_body = {
            "quoteResponse": quote_data,
            "userPublicKey": wallet_address,
            "wrapAndUnwrapSol": True,
            "dynamicComputeUnitLimit": True,
            "prioritizationFeeLamports": {
                "priorityLevelWithMaxLamports": {
                    "maxLamports": 2000000,
                    "global": False,
                    "priorityLevel": "medium",
                }
            },
        }

        resp = self.session.post(f"{JUP_API}/swap", json=swap_body, timeout=15)
        resp.raise_for_status()
        swap_data = resp.json()

        tx_base64 = swap_data.get("swapTransaction")
        if not tx_base64:
            raise Exception("No transaction returned from Jupiter")

        if sign_only:
            return {
                "ok": True,
                "transaction": tx_base64,
                "quote": q,
                "message": "Sign this transaction with your wallet and send to Solana RPC",
            }

        if not private_key:
            raise ValueError("private_key required for auto-execution (or use sign_only=True)")

        # Sign and send
        sig = self._sign_and_send(tx_base64, private_key)

        return {
            "ok": True,
            "signature": sig,
            "explorer": f"https://solscan.io/tx/{sig}",
            "input": q["input_human"],
            "output": q["output_human"],
            "input_token": input_token,
            "output_token": output_token,
            "fee_bps": PLATFORM_FEE_BPS,
        }

    # ===== PRICE =====
    def price(self, token: str) -> Dict:
        """Get current price for a token."""
        mint = resolve_mint(token)
        resp = self.session.get(
            f"https://api.dexscreener.com/tokens/v1/solana/{mint}",
            timeout=10,
        )
        data = resp.json()
        if data and len(data) > 0:
            p = data[0]
            return {
                "symbol": p.get("baseToken", {}).get("symbol", "?"),
                "name": p.get("baseToken", {}).get("name", "?"),
                "mint": mint,
                "priceUsd": float(p.get("priceUsd", 0) or 0),
                "priceChange5m": float(p.get("priceChange", {}).get("m5", 0) or 0),
                "priceChange1h": float(p.get("priceChange", {}).get("h1", 0) or 0),
                "priceChange24h": float(p.get("priceChange", {}).get("h24", 0) or 0),
                "volume24h": float(p.get("volume", {}).get("h24", 0) or 0),
                "liquidity": float(p.get("liquidity", {}).get("usd", 0) or 0),
                "marketCap": float(p.get("marketCap", 0) or 0),
            }
        raise ValueError(f"Token {token} not found on DexScreener")

    # ===== SEARCH TOKENS =====
    def search_tokens(self, query: str, limit: int = 20) -> List[Dict]:
        """Search for tokens by name or symbol."""
        resp = self.session.get("https://tokens.jup.ag/tokens?tags=verified", timeout=10)
        tokens = resp.json()
        q = query.lower()
        filtered = [
            t for t in tokens
            if q in t.get("symbol", "").lower() or q in t.get("name", "").lower()
        ]
        return filtered[:limit]

    # ===== BALANCE =====
    def balance(self, wallet_address: str) -> Dict:
        """Get SOL balance for a wallet."""
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getBalance",
            "params": [wallet_address],
        }
        resp = self.session.post(self.rpc_url, json=payload, timeout=10)
        data = resp.json()
        lamports = data.get("result", {}).get("value", 0)
        return {
            "lamports": lamports,
            "sol": lamports / 1e9,
            "wallet": wallet_address,
        }

    # ===== AGENT TOOLS =====
    def as_agent_tools(self) -> List[Dict]:
        """
        Returns tool definitions compatible with AI agent frameworks
        (Claude, OpenAI function calling, LangChain, etc.)
        """
        return [
            {
                "name": "omniswap_quote",
                "description": "Get a swap quote for any Solana token pair. Returns expected output amount and price impact.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "input_token": {"type": "string", "description": "Token to sell (symbol like SOL, USDC, or mint address)"},
                        "output_token": {"type": "string", "description": "Token to buy"},
                        "amount_sol": {"type": "number", "description": "Amount in SOL to swap"},
                    },
                    "required": ["input_token", "output_token", "amount_sol"],
                },
            },
            {
                "name": "omniswap_execute",
                "description": "Execute a token swap on Solana. Swaps input token for output token at best available rate.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "input_token": {"type": "string", "description": "Token to sell"},
                        "output_token": {"type": "string", "description": "Token to buy"},
                        "amount_sol": {"type": "number", "description": "Amount to swap"},
                    },
                    "required": ["input_token", "output_token", "amount_sol"],
                },
            },
            {
                "name": "omniswap_price",
                "description": "Get current price, volume, and market data for any Solana token.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "token": {"type": "string", "description": "Token symbol or mint address"},
                    },
                    "required": ["token"],
                },
            },
            {
                "name": "omniswap_balance",
                "description": "Check SOL balance of a Solana wallet.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "wallet_address": {"type": "string", "description": "Solana wallet address"},
                    },
                    "required": ["wallet_address"],
                },
            },
        ]

    # ===== INTERNAL: Sign & Send =====
    def _get_pubkey(self, private_key_b58: str) -> str:
        """Get public key from base58 private key."""
        try:
            from solders.keypair import Keypair
            kp = Keypair.from_base58_string(private_key_b58)
            return str(kp.pubkey())
        except ImportError:
            raise ImportError("Install solders: pip install solders")

    def _sign_and_send(self, tx_base64: str, private_key_b58: str) -> str:
        """Sign and send a versioned transaction."""
        try:
            from solders.keypair import Keypair
            from solders.transaction import VersionedTransaction
        except ImportError:
            raise ImportError("Install solders: pip install solders")

        kp = Keypair.from_base58_string(private_key_b58)
        tx_bytes = base64.b64decode(tx_base64)
        tx = VersionedTransaction.from_bytes(tx_bytes)
        signed = VersionedTransaction(tx.message, [kp])
        raw = bytes(signed)
        encoded = base64.b64encode(raw).decode()

        # Send to multiple RPCs
        for rpc in SOLANA_RPCS:
            try:
                payload = {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "sendTransaction",
                    "params": [encoded, {"encoding": "base64", "maxRetries": 3}],
                }
                resp = self.session.post(rpc, json=payload, timeout=15)
                data = resp.json()
                if "result" in data:
                    return data["result"]
            except Exception:
                continue

        raise Exception("Transaction send failed on all RPCs")


# ===== CONVENIENCE FUNCTIONS (module-level) =====
_default_client = None

def get_client(api_key: Optional[str] = None) -> OmniSwap:
    global _default_client
    if _default_client is None:
        _default_client = OmniSwap(api_key=api_key)
    return _default_client

def quote(input_token: str, output_token: str, **kwargs) -> Dict:
    """Quick quote: omniswap.quote('SOL', 'USDC', amount_sol=1.5)"""
    return get_client().quote(input_token, output_token, **kwargs)

def execute(input_token: str, output_token: str, **kwargs) -> Dict:
    """Quick swap: omniswap.execute('SOL', 'USDC', amount_sol=1.5, private_key='...')"""
    return get_client().execute(input_token, output_token, **kwargs)

def price(token: str) -> Dict:
    """Quick price: omniswap.price('SOL')"""
    return get_client().price(token)


if __name__ == "__main__":
    print("=" * 60)
    print("OmniSwap SDK v" + __version__)
    print("=" * 60)
    print()
    print("Quick Start:")
    print("  from omniswap import OmniSwap")
    print("  swap = OmniSwap()")
    print('  quote = swap.quote("SOL", "USDC", amount_sol=1.0)')
    print('  print(f"Output: {quote[\'output_human\']} USDC")')
    print()
    print("API Endpoints:")
    print("  GET  /v1/quote  - Get swap quote")
    print("  POST /v1/swap   - Execute swap")
    print("  GET  /v1/price  - Token price")
    print("  GET  /v1/tokens - Search tokens")
    print()
    print(f"Platform fee: {PLATFORM_FEE_BPS} bps ({PLATFORM_FEE_BPS/100}%)")
    print(f"Fee wallet: {FEE_WALLET}")
    print()

    # Demo: get SOL price
    try:
        client = OmniSwap()
        sol = client.price("SOL")
        print(f"SOL Price: ${sol['priceUsd']:.2f}")
        print(f"24h Change: {sol['priceChange24h']:+.1f}%")
        print(f"24h Volume: ${sol['volume24h']:,.0f}")
    except Exception as e:
        print(f"Demo error: {e}")

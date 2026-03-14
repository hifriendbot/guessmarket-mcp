# GuessMarket MCP Server

MCP server for [GuessMarket](https://guessmarket.com) prediction markets. Gives AI agents full access to discover markets, analyze prices, check on-chain balances and positions, build trading transactions, and get smart contract ABIs.

Live on 5 EVM chains: Ethereum, Base, Polygon, BSC, and PulseChain.

## Tools

### Read-Only (API)

| Tool | Description |
|------|-------------|
| `list_markets` | List prediction markets with filters for status and chain |
| `get_market` | Get detailed market info: question, YES/NO odds, volume, liquidity, end time |
| `get_market_history` | Get timestamped price history for trend analysis |
| `get_networks` | Get all supported chains with contract addresses |
| `get_portfolio` | Get a wallet's trading activity across all markets |
| `get_abi` | Get smart contract ABI for custom integrations |

### Read-Only (On-Chain)

| Tool | Description |
|------|-------------|
| `get_balance` | Get a wallet's stablecoin (USDC/USDT) balance on any chain |
| `get_allowance` | Check how much stablecoin a market is approved to spend from a wallet |
| `get_position` | Get a wallet's YES shares, NO shares, and LP tokens on a specific market |

These tools read directly from the blockchain via public RPC endpoints. No API keys required.

### Transaction Builders

All transaction builders return unsigned EVM transaction objects. Sign with your wallet and broadcast to the chain. Amounts are human-readable (e.g. `"10.5"`) and automatically converted to the correct decimals per chain (6 for USDC, 18 for BSC USDT).

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `build_approve_tx` | Approve stablecoin spending for a market | `market_address`, `amount` (or `"max"` for unlimited), `chain_id` |
| `build_buy_shares_tx` | Buy YES or NO outcome shares | `market_address`, `outcome`, `amount`, `chain_id`, `min_shares` (slippage) |
| `build_sell_shares_tx` | Sell YES or NO outcome shares | `market_address`, `outcome`, `shares`, `chain_id`, `min_usdc` (slippage) |
| `build_add_liquidity_tx` | Add stablecoin liquidity, receive LP tokens | `market_address`, `amount`, `chain_id` |
| `build_remove_liquidity_tx` | Burn LP tokens, receive stablecoin back | `market_address`, `lp_tokens`, `chain_id` |
| `build_claim_winnings_tx` | Claim winnings from a resolved market | `market_address`, `chain_id` |
| `build_create_market_tx` | Create a new prediction market | `question`, `end_time` (unix timestamp), `chain_id` |
| `build_buy_with_approval_tx` | Approve + buy in one call (returns 2 ordered transactions) | `market_address`, `outcome`, `amount`, `chain_id`, `min_shares` (slippage) |

#### Slippage Protection

`build_buy_shares_tx` and `build_sell_shares_tx` accept optional slippage parameters (`min_shares` and `min_usdc`). When set to `0` (default), the server returns a warning. Set a minimum to protect against front-running.

## Trading Flow

### Buy Shares

```
1. list_markets               → Find a market to trade
2. get_market                  → Check current odds and liquidity
3. get_balance                 → Check your stablecoin balance
4. get_allowance               → Check if approval is needed
5. build_approve_tx            → Approve stablecoin spending (if needed)
6. build_buy_shares_tx         → Buy YES or NO shares
7. Sign and broadcast transactions with your wallet
8. get_position                → Verify your shares
```

Or combine steps 5-6 with `build_buy_with_approval_tx` which returns both transactions in order.

### Sell Shares

```
1. get_position                → Check your share holdings
2. build_sell_shares_tx        → Sell shares back to the market
3. Sign and broadcast the transaction
4. get_balance                 → Verify stablecoin received
```

### Provide Liquidity

```
1. build_approve_tx            → Approve stablecoin spending
2. build_add_liquidity_tx      → Deposit stablecoin, receive LP tokens
3. get_position                → Verify LP tokens received
4. build_remove_liquidity_tx   → Later: burn LP tokens to withdraw
```

### Create a Market

```
1. build_create_market_tx      → Deploy a new prediction market
2. Sign and broadcast — the new market address is in the tx receipt
```

### Transaction Response Format

```json
{
  "transaction": {
    "to": "0x...",
    "data": "0x...",
    "chainId": 8453,
    "value": "0x0"
  },
  "description": "Buy YES shares for 10 USDC on market 0x... (Base Mainnet)",
  "meta": {
    "chain": "Base Mainnet",
    "stablecoin": "USDC",
    "outcome": "YES",
    "function": "buyShares(uint8,uint256,uint256)"
  },
  "warnings": []
}
```

## Quickstart

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "guessmarket": {
      "command": "npx",
      "args": ["-y", "guessmarket-mcp"]
    }
  }
}
```

### Claude Code

Add to your project with the CLI:

```bash
claude mcp add guessmarket -- npx -y guessmarket-mcp
```

Or add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "guessmarket": {
      "command": "npx",
      "args": ["-y", "guessmarket-mcp"]
    }
  }
}
```

### VS Code

Add to your VS Code settings or `.vscode/mcp.json`:

```json
{
  "mcp": {
    "servers": {
      "guessmarket": {
        "command": "npx",
        "args": ["-y", "guessmarket-mcp"]
      }
    }
  }
}
```

## Supported Chains

| Chain | Chain ID | Stablecoin |
|-------|----------|------------|
| Ethereum | 1 | USDC (6 decimals) |
| Base | 8453 | USDC (6 decimals) |
| Polygon | 137 | USDC (6 decimals) |
| BSC | 56 | USDT (18 decimals) |
| PulseChain | 369 | USDC (6 decimals) |

## Configuration

No API keys required — the server uses the public GuessMarket REST API.

### Custom API URL

By default the server connects to `https://guessmarket.com/api/guessmarket/v1`. Override with an environment variable:

```json
{
  "mcpServers": {
    "guessmarket": {
      "command": "npx",
      "args": ["-y", "guessmarket-mcp"],
      "env": {
        "GUESSMARKET_API_URL": "https://your-instance.com/api/guessmarket/v1"
      }
    }
  }
}
```

## Architecture

```
AI Agent  <-->  MCP Server  <-->  GuessMarket REST API (market data)
   |                  |
   |                  └───────>  Public RPCs (on-chain reads)
   |                                    |
   |                              5 EVM Chains
   |                          (Ethereum, Base, Polygon,
   |                             BSC, PulseChain)
   |
   └── Signs & broadcasts unsigned transactions on-chain
```

The MCP server provides market data (via REST API), reads on-chain state (via public RPC endpoints), and builds unsigned transactions (via local ABI encoding). The agent signs transactions with its own wallet and broadcasts directly to the blockchain.

## Requirements

- Node.js 18 or later (uses native `fetch`)

## Development

```bash
npm install
npm run build
node build/index.js
```

## License

MIT

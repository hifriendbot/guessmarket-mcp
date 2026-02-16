#!/usr/bin/env node
/**
 * GuessMarket MCP Server
 *
 * Gives AI agents access to GuessMarket prediction markets:
 * discover markets, analyze prices, view portfolios, get contract
 * ABIs, and build unsigned trading transactions.
 *
 * All data comes from the GuessMarket WordPress REST API.
 * Trading transactions are built locally and signed by the agent.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { JsonRpcProvider, Contract, formatUnits } from 'ethers';
import { api, getNetwork } from './networks.js';
import { PREDICTION_MARKET_ABI, ERC20_ABI } from './abi-fragments.js';
import { registerTxTools } from './tx-builder.js';

// ─── Server ──────────────────────────────────────────────────────

const server = new McpServer({
  name: 'guessmarket',
  version: '1.2.0',
});

// ─── Tool: list_markets ──────────────────────────────────────────

server.tool(
  'list_markets',
  'List prediction markets on GuessMarket. Filter by status (active/resolved/all) ' +
    'and chain_id. Returns market address, question, odds, volume, and end time.',
  {
    status: z.enum(['active', 'resolved', 'all']).default('active').describe('Market status filter'),
    chain_id: z.number().int().optional().describe('EVM chain ID to filter by (e.g. 8453 for Base)'),
    page: z.number().int().default(1).describe('Page number for pagination'),
    per_page: z.number().int().default(20).describe('Results per page (max 100)'),
  },
  async ({ status, chain_id, page, per_page }) => {
    const params = new URLSearchParams();
    params.set('status', status);
    params.set('page', String(page));
    params.set('per_page', String(Math.min(per_page, 100)));
    if (chain_id) params.set('chain_id', String(chain_id));

    const data = await api(`/markets?${params}`);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

// ─── Tool: get_market ────────────────────────────────────────────

server.tool(
  'get_market',
  'Get detailed info for a single prediction market by its contract address. ' +
    'Returns question, current YES/NO odds, volume, liquidity, end time, resolution status, and chain.',
  {
    address: z.string().regex(/^0x[a-fA-F0-9]{40}$/).describe('Market contract address'),
  },
  async ({ address }) => {
    const data = await api(`/market/${address.toLowerCase()}`);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

// ─── Tool: get_market_history ────────────────────────────────────

server.tool(
  'get_market_history',
  'Get price history for a market. Returns timestamped YES/NO price data points ' +
    'for charting and trend analysis. Optionally specify chain_id and limit.',
  {
    address: z.string().regex(/^0x[a-fA-F0-9]{40}$/).describe('Market contract address'),
    chain_id: z.number().int().optional().describe('EVM chain ID (auto-detected if omitted)'),
    limit: z.number().int().default(500).describe('Max data points to return (max 5000)'),
  },
  async ({ address, chain_id, limit }) => {
    const params = new URLSearchParams();
    if (chain_id) params.set('chain_id', String(chain_id));
    params.set('limit', String(Math.min(limit, 5000)));

    const data = await api(`/markets/${address.toLowerCase()}/history?${params}`);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

// ─── Tool: get_networks ──────────────────────────────────────────

server.tool(
  'get_networks',
  'Get all blockchain networks GuessMarket is deployed on, with contract addresses ' +
    '(MarketFactory, FeeManager, Oracle, Stablecoin) for each chain. Essential for on-chain trading.',
  async () => {
    const data = await api('/networks');
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

// ─── Tool: get_portfolio ─────────────────────────────────────────

server.tool(
  'get_portfolio',
  "Get a wallet's trading activity across all GuessMarket markets. " +
    'Returns trades with market address, outcome, shares, cost, and timestamp.',
  {
    wallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/).describe('Wallet address'),
    limit: z.number().int().default(50).describe('Max trades to return (max 100)'),
    offset: z.number().int().default(0).describe('Offset for pagination'),
  },
  async ({ wallet, limit, offset }) => {
    const params = new URLSearchParams();
    params.set('limit', String(Math.min(limit, 100)));
    params.set('offset', String(offset));

    const data = await api(`/portfolio/${wallet.toLowerCase()}?${params}`);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

// ─── Tool: get_abi ───────────────────────────────────────────────

server.tool(
  'get_abi',
  'Get the ABI (Application Binary Interface) for a GuessMarket smart contract. ' +
    'Use this to build transactions for on-chain trading. ' +
    'Valid contracts: PredictionMarket, MarketFactory, ERC20, FeeManager, Oracle, SimpleOracle.',
  {
    contract: z
      .enum(['PredictionMarket', 'MarketFactory', 'ERC20', 'FeeManager', 'Oracle', 'SimpleOracle'])
      .describe('Contract name'),
  },
  async ({ contract }) => {
    const data = await api(`/abis/${contract}`);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

// ─── Blockchain Read Tools ───────────────────────────────────────

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const chainIdSchema = z.number().int().describe('EVM chain ID (e.g. 8453 for Base, 369 for PulseChain)');

// Max uint256 — used to detect "unlimited" allowances
const MAX_UINT256 = BigInt('0x' + 'f'.repeat(64));

server.tool(
  'get_balance',
  "Get a wallet's stablecoin (USDC/USDT) balance on a specific chain. " +
    'Returns balance in both raw and human-readable format.',
  {
    wallet: addressSchema.describe('Wallet address to check'),
    chain_id: chainIdSchema,
  },
  async ({ wallet, chain_id }) => {
    const net = await getNetwork(chain_id);
    const provider = new JsonRpcProvider(net.rpc_url);
    const token = new Contract(net.contracts.stablecoin, ERC20_ABI, provider);

    const balance: bigint = await token.balanceOf(wallet);
    const formatted = formatUnits(balance, net.stablecoin_decimals);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          wallet: wallet.toLowerCase(),
          chain: net.name,
          chain_id: net.chain_id,
          token: net.stablecoin_symbol,
          balance: formatted,
          balance_raw: balance.toString(),
        }, null, 2),
      }],
    };
  },
);

server.tool(
  'get_allowance',
  'Check how much stablecoin a prediction market contract is approved to spend from a wallet. ' +
    'Use this before buying shares to see if an approve transaction is needed.',
  {
    wallet: addressSchema.describe('Wallet address (token owner)'),
    market_address: addressSchema.describe('PredictionMarket contract address (spender)'),
    chain_id: chainIdSchema,
  },
  async ({ wallet, market_address, chain_id }) => {
    const net = await getNetwork(chain_id);
    const provider = new JsonRpcProvider(net.rpc_url);
    const token = new Contract(net.contracts.stablecoin, ERC20_ABI, provider);

    const allowance: bigint = await token.allowance(wallet, market_address);
    const isUnlimited = allowance >= MAX_UINT256 / 2n;
    const formatted = isUnlimited ? 'unlimited' : formatUnits(allowance, net.stablecoin_decimals);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          wallet: wallet.toLowerCase(),
          spender: market_address.toLowerCase(),
          chain: net.name,
          chain_id: net.chain_id,
          token: net.stablecoin_symbol,
          allowance: formatted,
          allowance_raw: allowance.toString(),
          needs_approval: !isUnlimited && allowance === 0n,
        }, null, 2),
      }],
    };
  },
);

server.tool(
  'get_position',
  "Get a wallet's share holdings on a specific prediction market. " +
    'Returns YES shares, NO shares, and LP tokens.',
  {
    wallet: addressSchema.describe('Wallet address to check'),
    market_address: addressSchema.describe('PredictionMarket contract address'),
    chain_id: chainIdSchema,
  },
  async ({ wallet, market_address, chain_id }) => {
    const net = await getNetwork(chain_id);
    const provider = new JsonRpcProvider(net.rpc_url);
    const market = new Contract(market_address, PREDICTION_MARKET_ABI, provider);

    const [yesShares, noShares, lpTokens]: [bigint, bigint, bigint] = await market.positions(wallet);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          wallet: wallet.toLowerCase(),
          market: market_address.toLowerCase(),
          chain: net.name,
          chain_id: net.chain_id,
          yes_shares: formatUnits(yesShares, 18),
          yes_shares_raw: yesShares.toString(),
          no_shares: formatUnits(noShares, 18),
          no_shares_raw: noShares.toString(),
          lp_tokens: formatUnits(lpTokens, 18),
          lp_tokens_raw: lpTokens.toString(),
          has_position: yesShares > 0n || noShares > 0n || lpTokens > 0n,
        }, null, 2),
      }],
    };
  },
);

// ─── Transaction Builder Tools ───────────────────────────────────

registerTxTools(server);

// ─── Start ───────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('GuessMarket MCP server running on stdio');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

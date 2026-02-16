/**
 * Transaction-builder MCP tools.
 * Returns unsigned EVM transactions that agents sign with their own wallet.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Interface, parseUnits } from 'ethers';
import { getNetwork } from './networks.js';
import { PREDICTION_MARKET_ABI, MARKET_FACTORY_ABI, ERC20_ABI } from './abi-fragments.js';

// Pre-create Interface instances (reusable, stateless)
const marketIface = new Interface(PREDICTION_MARKET_ABI);
const factoryIface = new Interface(MARKET_FACTORY_ABI);
const erc20Iface = new Interface(ERC20_ABI);

// Shared zod schemas
const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const chainIdSchema = z.number().int().describe('EVM chain ID (e.g. 8453 for Base, 369 for PulseChain)');
const amountSchema = z.string().describe('Human-readable amount (e.g. "10.5" USDC)');
const outcomeSchema = z.enum(['YES', 'NO']).describe('Market outcome: YES or NO');

function outcomeToUint8(outcome: 'YES' | 'NO'): number {
  // Solidity enum: None=0, Yes=1, No=2
  return outcome === 'YES' ? 1 : 2;
}

// Max uint256 for unlimited approval
const MAX_UINT256 = '0x' + 'f'.repeat(64);

interface TxMeta { [key: string]: string }

function txResponse(
  tx: { to: string; data: string; chainId: number; value: string },
  description: string,
  meta: TxMeta,
  warnings: string[] = [],
) {
  const result: Record<string, unknown> = { transaction: tx, description, meta };
  if (warnings.length > 0) result.warnings = warnings;
  return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
}

// ─── Register all tx-builder tools on the server ─────────────────

export function registerTxTools(server: McpServer): void {

  // ─── build_approve_tx ────────────────────────────────────────
  server.tool(
    'build_approve_tx',
    'Build an unsigned ERC-20 approve transaction to let a prediction market spend your stablecoin. ' +
      'Must be signed and broadcast before buying shares or adding liquidity.',
    {
      market_address: addressSchema.describe('PredictionMarket contract to approve as spender'),
      amount: amountSchema.describe('Amount to approve (e.g. "100"). Use "max" for unlimited approval.'),
      chain_id: chainIdSchema,
    },
    async ({ market_address, amount, chain_id }) => {
      const net = await getNetwork(chain_id);
      const rawAmount = amount.toLowerCase() === 'max'
        ? MAX_UINT256
        : parseUnits(amount, net.stablecoin_decimals).toString();

      const data = erc20Iface.encodeFunctionData('approve', [
        market_address.toLowerCase(),
        rawAmount,
      ]);

      const displayAmount = amount.toLowerCase() === 'max'
        ? 'unlimited'
        : `${amount} ${net.stablecoin_symbol}`;

      return txResponse(
        { to: net.contracts.stablecoin, data, chainId: chain_id, value: '0x0' },
        `Approve ${displayAmount} for market ${market_address} on ${net.name}`,
        {
          chain: net.name,
          stablecoin: net.stablecoin_symbol,
          spender: market_address.toLowerCase(),
          function: 'approve(address,uint256)',
        },
      );
    },
  );

  // ─── build_buy_shares_tx ─────────────────────────────────────
  server.tool(
    'build_buy_shares_tx',
    'Build an unsigned transaction to buy YES or NO shares on a prediction market. ' +
      'Requires prior stablecoin approval. Returns shares based on CPMM pricing.',
    {
      market_address: addressSchema.describe('PredictionMarket contract address'),
      outcome: outcomeSchema,
      amount: amountSchema.describe('Stablecoin amount to spend (e.g. "10.5")'),
      min_shares: z.string().default('0').describe('Minimum shares to accept (slippage protection). Default "0" for no minimum.'),
      chain_id: chainIdSchema,
    },
    async ({ market_address, outcome, amount, min_shares, chain_id }) => {
      const net = await getNetwork(chain_id);
      const rawAmount = parseUnits(amount, net.stablecoin_decimals);
      const rawMinShares = min_shares === '0' ? 0n : parseUnits(min_shares, net.stablecoin_decimals);

      const data = marketIface.encodeFunctionData('buyShares', [
        outcomeToUint8(outcome),
        rawAmount,
        rawMinShares,
      ]);

      const warnings: string[] = [];
      if (min_shares === '0') {
        warnings.push('No slippage protection (min_shares=0). Consider setting a minimum to avoid front-running.');
      }

      return txResponse(
        { to: market_address.toLowerCase(), data, chainId: chain_id, value: '0x0' },
        `Buy ${outcome} shares for ${amount} ${net.stablecoin_symbol} on market ${market_address} (${net.name})`,
        {
          market: market_address.toLowerCase(),
          chain: net.name,
          stablecoin: net.stablecoin_symbol,
          outcome,
          function: 'buyShares(uint8,uint256,uint256)',
        },
        warnings,
      );
    },
  );

  // ─── build_sell_shares_tx ────────────────────────────────────
  server.tool(
    'build_sell_shares_tx',
    'Build an unsigned transaction to sell YES or NO shares on a prediction market. ' +
      'Returns stablecoin based on CPMM pricing.',
    {
      market_address: addressSchema.describe('PredictionMarket contract address'),
      outcome: outcomeSchema,
      shares: amountSchema.describe('Number of shares to sell (e.g. "50.0")'),
      min_usdc: z.string().default('0').describe('Minimum stablecoin to accept (slippage protection). Default "0" for no minimum.'),
      chain_id: chainIdSchema,
    },
    async ({ market_address, outcome, shares, min_usdc, chain_id }) => {
      const net = await getNetwork(chain_id);
      const rawShares = parseUnits(shares, net.stablecoin_decimals);
      const rawMinUsdc = min_usdc === '0' ? 0n : parseUnits(min_usdc, net.stablecoin_decimals);

      const data = marketIface.encodeFunctionData('sellShares', [
        outcomeToUint8(outcome),
        rawShares,
        rawMinUsdc,
      ]);

      const warnings: string[] = [];
      if (min_usdc === '0') {
        warnings.push('No slippage protection (min_usdc=0). Consider setting a minimum.');
      }

      return txResponse(
        { to: market_address.toLowerCase(), data, chainId: chain_id, value: '0x0' },
        `Sell ${shares} ${outcome} shares on market ${market_address} (${net.name})`,
        {
          market: market_address.toLowerCase(),
          chain: net.name,
          stablecoin: net.stablecoin_symbol,
          outcome,
          function: 'sellShares(uint8,uint256,uint256)',
        },
        warnings,
      );
    },
  );

  // ─── build_add_liquidity_tx ──────────────────────────────────
  server.tool(
    'build_add_liquidity_tx',
    'Build an unsigned transaction to add liquidity to a prediction market. ' +
      'Requires prior stablecoin approval. Returns LP tokens.',
    {
      market_address: addressSchema.describe('PredictionMarket contract address'),
      amount: amountSchema.describe('Stablecoin amount to add (e.g. "100")'),
      chain_id: chainIdSchema,
    },
    async ({ market_address, amount, chain_id }) => {
      const net = await getNetwork(chain_id);
      const rawAmount = parseUnits(amount, net.stablecoin_decimals);

      const data = marketIface.encodeFunctionData('addLiquidity', [rawAmount]);

      return txResponse(
        { to: market_address.toLowerCase(), data, chainId: chain_id, value: '0x0' },
        `Add ${amount} ${net.stablecoin_symbol} liquidity to market ${market_address} (${net.name})`,
        {
          market: market_address.toLowerCase(),
          chain: net.name,
          stablecoin: net.stablecoin_symbol,
          function: 'addLiquidity(uint256)',
        },
      );
    },
  );

  // ─── build_remove_liquidity_tx ───────────────────────────────
  server.tool(
    'build_remove_liquidity_tx',
    'Build an unsigned transaction to remove liquidity from a prediction market. ' +
      'Burns LP tokens and returns stablecoin.',
    {
      market_address: addressSchema.describe('PredictionMarket contract address'),
      lp_tokens: amountSchema.describe('Number of LP tokens to burn (e.g. "50.0")'),
      chain_id: chainIdSchema,
    },
    async ({ market_address, lp_tokens, chain_id }) => {
      const net = await getNetwork(chain_id);
      const rawLpTokens = parseUnits(lp_tokens, net.stablecoin_decimals);

      const data = marketIface.encodeFunctionData('removeLiquidity', [rawLpTokens]);

      return txResponse(
        { to: market_address.toLowerCase(), data, chainId: chain_id, value: '0x0' },
        `Remove ${lp_tokens} LP tokens from market ${market_address} (${net.name})`,
        {
          market: market_address.toLowerCase(),
          chain: net.name,
          stablecoin: net.stablecoin_symbol,
          function: 'removeLiquidity(uint256)',
        },
      );
    },
  );

  // ─── build_claim_winnings_tx ─────────────────────────────────
  server.tool(
    'build_claim_winnings_tx',
    'Build an unsigned transaction to claim winnings from a resolved prediction market. ' +
      'Only works after the market has been resolved. Returns stablecoin.',
    {
      market_address: addressSchema.describe('PredictionMarket contract address'),
      chain_id: chainIdSchema,
    },
    async ({ market_address, chain_id }) => {
      const net = await getNetwork(chain_id);

      const data = marketIface.encodeFunctionData('claimWinnings', []);

      return txResponse(
        { to: market_address.toLowerCase(), data, chainId: chain_id, value: '0x0' },
        `Claim winnings from resolved market ${market_address} (${net.name})`,
        {
          market: market_address.toLowerCase(),
          chain: net.name,
          stablecoin: net.stablecoin_symbol,
          function: 'claimWinnings()',
        },
      );
    },
  );

  // ─── build_create_market_tx ──────────────────────────────────
  server.tool(
    'build_create_market_tx',
    'Build an unsigned transaction to create a new prediction market via the MarketFactory. ' +
      'Returns the address of the new market contract in the transaction receipt.',
    {
      question: z.string().min(10).max(500).describe('The market question (e.g. "Will BTC reach $100k by Dec 2026?")'),
      end_time: z.number().int().describe('Market end time as Unix timestamp (seconds). Must be in the future.'),
      chain_id: chainIdSchema,
    },
    async ({ question, end_time, chain_id }) => {
      const net = await getNetwork(chain_id);

      if (end_time <= Math.floor(Date.now() / 1000)) {
        throw new Error('end_time must be in the future (Unix timestamp in seconds).');
      }

      const data = factoryIface.encodeFunctionData('createMarket', [question, end_time]);

      const endDate = new Date(end_time * 1000).toISOString();

      return txResponse(
        { to: net.contracts.market_factory, data, chainId: chain_id, value: '0x0' },
        `Create market "${question}" ending ${endDate} on ${net.name}`,
        {
          chain: net.name,
          factory: net.contracts.market_factory,
          end_time: endDate,
          function: 'createMarket(string,uint256)',
        },
      );
    },
  );

  // ─── build_buy_with_approval_tx ──────────────────────────────
  server.tool(
    'build_buy_with_approval_tx',
    'Build TWO unsigned transactions: (1) approve stablecoin spending and (2) buy shares. ' +
      'Convenience tool that combines approve + buyShares. Both must be signed and sent in order.',
    {
      market_address: addressSchema.describe('PredictionMarket contract address'),
      outcome: outcomeSchema,
      amount: amountSchema.describe('Stablecoin amount to spend (e.g. "10.5")'),
      min_shares: z.string().default('0').describe('Minimum shares to accept (slippage protection)'),
      chain_id: chainIdSchema,
    },
    async ({ market_address, outcome, amount, min_shares, chain_id }) => {
      const net = await getNetwork(chain_id);
      const rawAmount = parseUnits(amount, net.stablecoin_decimals);
      const rawMinShares = min_shares === '0' ? 0n : parseUnits(min_shares, net.stablecoin_decimals);

      const approveData = erc20Iface.encodeFunctionData('approve', [
        market_address.toLowerCase(),
        rawAmount,
      ]);

      const buyData = marketIface.encodeFunctionData('buyShares', [
        outcomeToUint8(outcome),
        rawAmount,
        rawMinShares,
      ]);

      const result = {
        transactions: [
          {
            step: 1,
            label: 'Approve stablecoin',
            transaction: {
              to: net.contracts.stablecoin,
              data: approveData,
              chainId: chain_id,
              value: '0x0',
            },
          },
          {
            step: 2,
            label: 'Buy shares',
            transaction: {
              to: market_address.toLowerCase(),
              data: buyData,
              chainId: chain_id,
              value: '0x0',
            },
          },
        ],
        description: `Approve and buy ${outcome} shares for ${amount} ${net.stablecoin_symbol} on market ${market_address} (${net.name})`,
        meta: {
          market: market_address.toLowerCase(),
          chain: net.name,
          stablecoin: net.stablecoin_symbol,
          outcome,
        },
        warnings: min_shares === '0'
          ? ['No slippage protection (min_shares=0). Consider setting a minimum.']
          : [],
      };

      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}

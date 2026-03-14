/**
 * Shared API helper, network data cache, and RPC URLs.
 * Extracted from index.ts so tx-builder.ts can reuse it.
 */

const API_BASE =
  process.env.GUESSMARKET_API_URL?.replace(/\/+$/, '') ||
  'https://guessmarket.com/api/guessmarket/v1';

export async function api(path: string): Promise<unknown> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'GuessMarket-MCP/1.2' },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json();
}

// Public RPC endpoints for read-only calls
const RPC_URLS: Record<number, string> = {
  369: 'https://rpc.pulsechain.com',
  8453: 'https://mainnet.base.org',
  137: 'https://polygon-rpc.com',
  1: 'https://eth.llamarpc.com',
  56: 'https://bsc-dataseed.bnbchain.org',
};

export interface NetworkInfo {
  key: string;
  name: string;
  chain_id: number;
  explorer: string;
  native_token: string;
  stablecoin_symbol: string;
  stablecoin_decimals: number;
  rpc_url: string;
  contracts: {
    market_factory: string;
    fee_manager: string;
    oracle: string;
    stablecoin: string;
  };
}

let cache: NetworkInfo[] | null = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function getNetworks(): Promise<NetworkInfo[]> {
  if (cache && Date.now() - cacheTime < CACHE_TTL) {
    return cache;
  }
  const data = (await api('/networks')) as { networks: Omit<NetworkInfo, 'rpc_url'>[] };
  // Merge hardcoded RPC URLs into network info
  cache = data.networks.map((n) => ({
    ...n,
    rpc_url: RPC_URLS[n.chain_id] || '',
  }));
  cacheTime = Date.now();
  return cache;
}

export async function getNetwork(chainId: number): Promise<NetworkInfo> {
  const networks = await getNetworks();
  const net = networks.find((n) => n.chain_id === chainId);
  if (!net) {
    const valid = networks.map((n) => `${n.name} (${n.chain_id})`).join(', ');
    throw new Error(`Unsupported chain_id ${chainId}. Valid chains: ${valid}`);
  }
  if (!net.rpc_url) {
    throw new Error(`No RPC URL configured for ${net.name} (${chainId}).`);
  }
  return net;
}

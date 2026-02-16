/**
 * Minimal human-readable ABI fragments for transaction encoding and reads.
 */

export const PREDICTION_MARKET_ABI = [
  // Write
  'function buyShares(uint8 _outcome, uint256 usdcAmount, uint256 minShares) returns (uint256 shares)',
  'function sellShares(uint8 _outcome, uint256 sharesToSell, uint256 minUsdc) returns (uint256 usdcAmount)',
  'function addLiquidity(uint256 usdcAmount) returns (uint256 lpTokens)',
  'function removeLiquidity(uint256 lpTokens) returns (uint256 usdcAmount)',
  'function claimWinnings() returns (uint256 amount)',
  // Read
  'function positions(address) view returns (uint256 yesShares, uint256 noShares, uint256 lpTokens)',
];

export const MARKET_FACTORY_ABI = [
  'function createMarket(string question_, uint256 endTime_) returns (address marketAddress)',
];

export const ERC20_ABI = [
  // Write
  'function approve(address spender, uint256 amount) returns (bool)',
  // Read
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

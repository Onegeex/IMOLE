import { createPublicClient, defineChain, fallback, http, type Address } from "viem";

export const qie = defineChain({
  id: 1990,
  name: "QIE Mainnet",
  nativeCurrency: { name: "QIE", symbol: "QIE", decimals: 18 },
  rpcUrls: {
    default: {
      http: import.meta.env.VITE_RPC
        ? [import.meta.env.VITE_RPC as string]
        : ["https://rpc1mainnet.qie.digital", "https://rpc2mainnet.qie.digital", "https://rpc5mainnet.qie.digital"],
    },
  },
  blockExplorers: { default: { name: "QIE Explorer", url: "https://mainnet.qie.digital" } },
});

const env = import.meta.env;

export const ADDR = {
  payg: (env.VITE_PAYG || "") as Address | "",
  kyc: (env.VITE_KYC || "") as Address | "",
  qusdc: (env.VITE_QUSDC || "0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5") as Address,
  router: (env.VITE_QIEDEX_ROUTER || "0x08cd2e72e156D8563B4351eb4065C262A9f553Ef") as Address,
};

/** Kit shown live on the home page (the one wired to the Wokwi controller). */
export const DEMO_KIT = env.VITE_DEMO_KIT ? BigInt(env.VITE_DEMO_KIT) : 0n;

export const deployed = ADDR.payg !== "";

export const publicClient = createPublicClient({
  chain: qie,
  transport: fallback(qie.rpcUrls.default.http.map((u) => http(u, { timeout: 6_000, batch: { wait: 20 } })), { rank: { interval: 30_000 }, retryCount: 2 }),
});

export const explorerTx = (h: string) => `${qie.blockExplorers.default.url}/tx/${h}`;
export const explorerAddr = (a: string) => `${qie.blockExplorers.default.url}/address/${a}`;

export const erc20Abi = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

export const routerAbi = [
  { type: "function", name: "WETH", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "getAmountsOut", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address[]" }], outputs: [{ type: "uint256[]" }] },
  { type: "function", name: "swapExactETHForTokens", stateMutability: "payable", inputs: [{ type: "uint256" }, { type: "address[]" }, { type: "address" }, { type: "uint256" }], outputs: [{ type: "uint256[]" }] },
] as const;

export const FEED = (env.VITE_QIE_USD_FEED || "0x3Bc617cF3A4Bb77003e4c556B87b13D556903D17") as Address;
export const feedAbi = [
  { type: "function", name: "latestRoundData", stateMutability: "view", inputs: [], outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }] },
] as const;
/** Must match ImolePAYG.maxOracleAge on mainnet (3 days). */
export const MAX_ORACLE_AGE = 3 * 86400;

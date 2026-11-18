import { BaseError, ContractFunctionRevertedError, formatUnits, parseUnits, type Address, type Hash, type WalletClient } from "viem";
import { ADDR, publicClient, qie } from "./config";
import { ImolePAYGAbi } from "./abi/ImolePAYG";
import { ImoleKYCAbi } from "./abi/ImoleKYC";

export const STATUS = ["None", "Pending", "Active", "PaidOff", "Repossessed", "Cancelled"] as const;
export type StatusName = (typeof STATUS)[number];

export type Terms = {
  price: bigint;
  deposit: bigint;
  installment: bigint;
  period: number;
  grace: number;
  repossessAfter: number;
  requireKyc: boolean;
};

export type Plan = {
  id: bigint;
  kitId: bigint;
  installer: Address;
  customer: Address;
  terms: Terms;
  startedAt: number;
  paidUntil: number;
  totalPaid: bigint;
  status: StatusName;
};

export type Kit = {
  id: bigint;
  installer: Address;
  panelWatts: number;
  batteryWh: number;
  inverterVA: number;
  location: string;
  currentPlan: bigint;
};

const payg = () => ({ address: ADDR.payg as Address, abi: ImolePAYGAbi });

let decimalsCache: number | null = null;
export async function qusdcDecimals(): Promise<number> {
  if (decimalsCache === null) {
    decimalsCache = Number(await publicClient.readContract({ ...payg(), functionName: "qusdcDecimals" }));
  }
  return decimalsCache;
}

export const fmtUsd = (v: bigint, d: number) => {
  const n = Number(formatUnits(v, d));
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 });
};
export const toUnits = (s: string, d: number) => parseUnits(s || "0", d);

export async function readKit(id: bigint): Promise<Kit> {
  const r = (await publicClient.readContract({ ...payg(), functionName: "kits", args: [id] })) as readonly [
    Address, number, number, number, string, bigint,
  ];
  return { id, installer: r[0], panelWatts: r[1], batteryWh: r[2], inverterVA: r[3], location: r[4], currentPlan: r[5] };
}

export async function readPlan(id: bigint): Promise<Plan> {
  const p = await publicClient.readContract({ ...payg(), functionName: "getPlan", args: [id] });
  return {
    id,
    kitId: p.kitId,
    installer: p.installer,
    customer: p.customer,
    terms: { ...p.terms, period: Number(p.terms.period), grace: Number(p.terms.grace), repossessAfter: Number(p.terms.repossessAfter) },
    startedAt: Number(p.startedAt),
    paidUntil: Number(p.paidUntil),
    totalPaid: p.totalPaid,
    status: STATUS[p.status] ?? "None",
  };
}

export async function readKitStatus(id: bigint) {
  const [active, secondsLeft, percentPaid] = await publicClient.readContract({ ...payg(), functionName: "kitStatus", args: [id] });
  return { active, secondsLeft, percentPaid: Number(percentPaid) };
}

export async function readTokenImage(id: bigint): Promise<string | null> {
  try {
    const uri = await publicClient.readContract({ ...payg(), functionName: "tokenURI", args: [id] });
    const json = JSON.parse(atob(uri.split(",")[1]));
    return json.image as string;
  } catch {
    return null;
  }
}

export async function readStats() {
  const fns = ["totalVolume", "paymentCount", "uniquePayers", "kitsPaidOff", "nextKitId"] as const;
  const [vol, pays, payers, paidOff, nextKit] = await Promise.all(
    fns.map((f) => publicClient.readContract({ ...payg(), functionName: f }) as Promise<bigint>),
  );
  return { volume: vol, payments: pays, payers, paidOff, kits: nextKit - 1n };
}

export async function readInstaller(a: Address) {
  const r = (await publicClient.readContract({ ...payg(), functionName: "installers", args: [a] })) as readonly [
    boolean, boolean, string, number, bigint,
  ];
  return { registered: r[0], verified: r[1], name: r[2], plans: r[3], collected: r[4] };
}

export async function plansOf(kind: "customer" | "installer", a: Address): Promise<bigint[]> {
  return (await publicClient.readContract({
    ...payg(),
    functionName: kind === "customer" ? "plansOfCustomer" : "plansOfInstaller",
    args: [a],
  })) as bigint[];
}

export async function isVerified(a: Address) {
  if (!ADDR.kyc) return false;
  return publicClient.readContract({ address: ADDR.kyc as Address, abi: ImoleKYCAbi, functionName: "isVerified", args: [a] });
}

export async function isAttester(a: Address) {
  if (!ADDR.kyc) return false;
  return publicClient.readContract({ address: ADDR.kyc as Address, abi: ImoleKYCAbi, functionName: "isAttester", args: [a] });
}

/** Plain-language messages for the contracts' custom errors. */
const ERRORS: Record<string, string> = {
  NotInstaller: "Only the installer who listed this kit can do that.",
  AlreadyRegistered: "This wallet is already registered as an installer.",
  BadTerms: "These terms aren't valid. Check that the deposit and weekly amount are below the price, and the customer isn't your own wallet.",
  NotYourKit: "You don't hold this kit, so you can't relist it.",
  KitBusy: "This kit already has an open plan.",
  WrongStatus: "This plan isn't in a state that allows that.",
  NotCustomer: "Only the customer named on this plan can accept it.",
  NotVerified: "This customer's identity hasn't been verified yet. Ask the installer to complete the ID check first.",
  ZeroAmount: "Enter an amount above zero.",
  NotOverdue: "The customer isn't overdue long enough for the kit to be taken back.",
  StaleOracle: "The QIE price feed hasn't updated recently, so paying in QIE is paused. Pay in QUSDC instead.",
  BadOraclePrice: "The QIE price feed returned an invalid price. Pay in QUSDC instead.",
  SwapBelowOracle: "QIEDEX offered less than the fair QIE price, so the payment was stopped. Try a smaller amount or pay in QUSDC.",
  NotAttester: "This wallet isn't allowed to verify customers.",
};

export function explain(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName ?? "";
      if (ERRORS[name]) return ERRORS[name];
      if (revert.reason?.includes("INSUFFICIENT_OUTPUT")) return ERRORS.SwapBelowOracle;
      if (revert.reason) return revert.reason;
    }
    if (e.shortMessage?.includes("User rejected") || e.shortMessage?.includes("denied")) return "The transaction was declined in the wallet.";
    if (e.shortMessage?.includes("insufficient funds")) return "This wallet doesn't have enough QIE to cover the amount and gas.";
    return e.shortMessage;
  }
  if (e instanceof Error && e.message) return e.message;
  return "Something went wrong sending the transaction. Try again.";
}

export type TxRequest = {
  address: Address;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
};

/** Simulate first (so reverts are explained before the wallet opens), then send and wait. */
export async function send(client: WalletClient, req: TxRequest): Promise<Hash> {
  const account = client.account!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { request } = await publicClient.simulateContract({ ...req, account } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hash = await client.writeContract({ ...(request as any), chain: qie, account });
  const rcpt = await publicClient.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success") throw new Error("The transaction failed on-chain.");
  return hash;
}

export function payg_() {
  return payg();
}

export function humanDuration(sec: number | bigint): string {
  const s = Number(sec);
  if (!isFinite(s) || s > 1e12) return "forever";
  if (s <= 0) return "0 minutes";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} day${d === 1 ? "" : "s"}${h ? `, ${h} h` : ""}`;
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}

export function periodName(sec: number): string {
  if (sec === 86400) return "day";
  if (sec === 604800) return "week";
  if (sec === 2592000) return "30 days";
  return humanDuration(sec);
}

/** "2 weeks", "3 days", or a plain duration for unusual periods. */
export function periodCount(n: number, sec: number): string {
  if (sec === 86400) return `${n} day${n === 1 ? "" : "s"}`;
  if (sec === 604800) return `${n} week${n === 1 ? "" : "s"}`;
  if (sec === 2592000) return `${n * 30} days`;
  return humanDuration(n * sec);
}

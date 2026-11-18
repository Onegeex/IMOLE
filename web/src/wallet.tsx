import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createWalletClient, custom, type Address, type EIP1193Provider, type WalletClient } from "viem";
import { qie } from "./config";

/**
 * Wallet connection following QIE's integration guide:
 * discover QIE Wallet via EIP-6963 (rdns "me.qiewallet"), then window.qie,
 * and only then fall back to window.ethereum. QIE Wallet reports isMetaMask = true,
 * so it is never identified by that flag.
 */

type Discovered = { info: { rdns: string; name: string; icon: string }; provider: EIP1193Provider };

declare global {
  interface Window {
    qie?: EIP1193Provider;
    ethereum?: EIP1193Provider;
  }
}

const found: Discovered[] = [];
if (typeof window !== "undefined") {
  window.addEventListener("eip6963:announceProvider", (e: Event) => {
    const d = (e as CustomEvent<Discovered>).detail;
    if (d && !found.some((f) => f.info.rdns === d.info.rdns)) found.push(d);
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

function pickProvider(): { provider: EIP1193Provider; name: string } | null {
  const q = found.find((f) => f.info.rdns === "me.qiewallet");
  if (q) return { provider: q.provider, name: "QIE Wallet" };
  if (window.qie) return { provider: window.qie, name: "QIE Wallet" };
  if (found[0]) return { provider: found[0].provider, name: found[0].info.name };
  if (window.ethereum) return { provider: window.ethereum, name: "Browser wallet" };
  return null;
}

type WalletState = {
  account: Address | null;
  walletName: string | null;
  client: WalletClient | null;
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
};

const Ctx = createContext<WalletState | null>(null);

async function ensureQieChain(p: EIP1193Provider) {
  const id = (await p.request({ method: "eth_chainId" })) as string;
  if (parseInt(id, 16) === qie.id) return;
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x7c6" }] });
  } catch (e: unknown) {
    if ((e as { code?: number }).code !== 4902) throw e;
    await p.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: "0x7c6",
          chainName: "QIE Blockchain Mainnet",
          nativeCurrency: qie.nativeCurrency,
          rpcUrls: [...qie.rpcUrls.default.http],
          blockExplorerUrls: [qie.blockExplorers.default.url],
        },
      ],
    });
  }
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<Address | null>(null);
  const [walletName, setWalletName] = useState<string | null>(null);
  const [provider, setProvider] = useState<EIP1193Provider | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // reconnect silently if the site is already approved
  useEffect(() => {
    const t = setTimeout(async () => {
      const picked = pickProvider();
      if (!picked) return;
      const accts = (await picked.provider.request({ method: "eth_accounts" })) as Address[];
      if (accts[0]) {
        setProvider(picked.provider);
        setWalletName(picked.name);
        setAccount(accts[0]);
      }
    }, 300);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!provider) return;
    const onAccounts = (a: unknown) => setAccount(((a as Address[])[0] as Address) ?? null);
    const onChain = () => window.location.reload();
    provider.on?.("accountsChanged", onAccounts);
    provider.on?.("chainChanged", onChain);
    return () => {
      provider.removeListener?.("accountsChanged", onAccounts);
      provider.removeListener?.("chainChanged", onChain);
    };
  }, [provider]);

  const connect = useCallback(async () => {
    setError(null);
    const picked = pickProvider();
    if (!picked) {
      setError("No wallet found. Install QIE Wallet from qiewallet.me, then reload this page.");
      return;
    }
    setConnecting(true);
    try {
      const accts = (await picked.provider.request({ method: "eth_requestAccounts" })) as Address[];
      await ensureQieChain(picked.provider);
      setProvider(picked.provider);
      setWalletName(picked.name);
      setAccount(accts[0] ?? null);
    } catch (e: unknown) {
      const code = (e as { code?: number }).code;
      setError(code === 4001 ? "Connection was declined in the wallet." : "Could not connect to the wallet. Try again.");
    } finally {
      setConnecting(false);
    }
  }, []);

  const client = useMemo(
    () => (provider && account ? createWalletClient({ chain: qie, transport: custom(provider), account }) : null),
    [provider, account],
  );

  return (
    <Ctx.Provider value={{ account, walletName, client, connecting, error, connect }}>{children}</Ctx.Provider>
  );
}

export function useWallet() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet outside WalletProvider");
  return v;
}

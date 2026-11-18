import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Connect } from "../components/Shell";
import { deployed } from "../config";
import { fmtUsd, humanDuration, plansOf, qusdcDecimals, readKitStatus, readPlan, type Plan } from "../chain";
import { useWallet } from "../wallet";

type Row = Plan & { active: boolean; secondsLeft: bigint };

export function Mine() {
  const { account } = useWallet();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [d, setD] = useState(6);

  useEffect(() => {
    if (!account || !deployed) return;
    (async () => {
      setD(await qusdcDecimals());
      const ids = await plansOf("customer", account);
      const plans = await Promise.all(ids.map(readPlan));
      const out = await Promise.all(
        plans.map(async (p) => {
          const s = await readKitStatus(p.kitId);
          return { ...p, active: s.active, secondsLeft: s.secondsLeft };
        }),
      );
      setRows(out.filter((r) => r.status !== "Cancelled").reverse());
    })().catch(() => setRows([]));
  }, [account]);

  if (!deployed) return <p className="empty">Contracts aren't configured for this build.</p>;
  if (!account) return <Connect why="Connect the wallet your installer registered to see your kits." />;
  if (!rows) return <p className="empty">Looking up your kits…</p>;
  if (rows.length === 0)
    return (
      <p className="empty">
        No kits are registered to this wallet. If an installer has fitted one for you, ask them for the kit number.
      </p>
    );

  return (
    <section className="narrow">
      <h1>My kits</h1>
      <ul className="mine">
        {rows.map((r) => (
          <li key={r.id.toString()}>
            <Link to={`/kit/${r.kitId}`}>
              <span className={`dot ${r.active ? "dot-on" : ""}`} />
              <strong>Kit {r.kitId.toString()}</strong>
              <span>
                {r.status === "PaidOff"
                  ? "Paid off, yours for good"
                  : r.status === "Pending"
                    ? "Waiting for you to accept"
                    : r.active
                      ? `${humanDuration(r.secondsLeft)} of power left`
                      : "Off, payment due"}
              </span>
              <span className="muted">{fmtUsd(r.totalPaid, d)} of {fmtUsd(r.terms.price, d)} QUSDC</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

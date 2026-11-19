import { useEffect, useState } from "react";
import { useRiseFlash } from "../motion";

type Props = {
  kitId: bigint;
  active: boolean;
  owned: boolean;
  secondsLeft: bigint;
  percentPaid: number;
  caption?: string;
};

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Styled after a Nigerian prepaid electricity meter: an LCD readout of how much
 * light is left, counting down live, on a solar-cell blue body.
 */
export function Meter({ kitId, active, owned, secondsLeft, percentPaid, caption }: Props) {
  const [left, setLeft] = useState(Number(secondsLeft > 10n ** 12n ? 0n : secondsLeft));
  useEffect(() => {
    setLeft(Number(secondsLeft > 10n ** 12n ? 0n : secondsLeft));
  }, [secondsLeft]);
  useEffect(() => {
    if (owned || left <= 0) return;
    const t = setInterval(() => setLeft((l) => Math.max(0, l - 1)), 1000);
    return () => clearInterval(t);
  }, [owned, left > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const on = owned || (active && left > 0);
  const flash = useRiseFlash(percentPaid);
  const d = Math.floor(left / 86400);
  const h = Math.floor((left % 86400) / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;

  return (
    <figure className={`meter ${on ? "is-on" : "is-off"}`} aria-label={`Kit ${kitId} is ${on ? "powered" : "locked"}`}>
      {flash > 0 && <span key={flash} className="charge-burst" aria-hidden="true" />}
      <div className="meter-top">
        <span className="meter-brand">Imole</span>
        <span className="meter-kit">Kit {kitId.toString()}</span>
        <span className={`lamp ${on ? "lamp-on" : ""}`} aria-hidden="true" />
      </div>
      <div className="lcd" role="timer" aria-live="off">
        {owned ? (
          <div className="lcd-owned">
            <span className="lcd-digits">PAId</span>
            <span className="lcd-sub">Paid off. Power is on for good.</span>
          </div>
        ) : (
          <>
            <div className="lcd-row">
              {[
                [pad(Math.min(d, 99)), "days"],
                [pad(h), "hours"],
                [pad(m), "min"],
                [pad(s), "sec"],
              ].map(([v, unit], i) => (
                <span key={unit} className="lcd-group">
                  {i > 0 && (
                    <span className="lcd-cell" aria-hidden="true">
                      <span className="lcd-colon">:</span>
                      <span className="lcd-unit">&nbsp;</span>
                    </span>
                  )}
                  <span className="lcd-cell">
                    <span className={`lcd-digits ${unit === "sec" ? "lcd-sec" : ""}`}>{v}</span>
                    <span className="lcd-unit">{unit}</span>
                  </span>
                </span>
              ))}
            </div>
          </>
        )}
      </div>
      <div className="meter-foot">
        <span className="meter-state">{owned ? "Owned by the customer" : on ? "Power on" : "Power off, payment due"}</span>
        <span className="meter-paid">
          <span className="paid-track">
            <span className="paid-fill" style={{ width: `${Math.min(100, percentPaid)}%` }} />
          </span>
          {percentPaid}% of the kit paid
        </span>
      </div>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

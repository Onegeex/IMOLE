import { useEffect, useRef, useState } from "react";

/** Page-wide power mood: the sky background brightens when a kit is on and dims when it's locked. */
export function usePowerMood(mood: "on" | "off" | "owned" | null) {
  useEffect(() => {
    if (!mood) return;
    document.body.dataset.power = mood;
    return () => {
      delete document.body.dataset.power;
    };
  }, [mood]);
}

const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Counts up from the previous value to `target` with an ease-out curve. */
export function useCountUp(target: number, ms = 900) {
  const [v, setV] = useState(target);
  const from = useRef(0);
  useEffect(() => {
    if (reduced()) {
      setV(target);
      from.current = target;
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      const e = 1 - Math.pow(1 - p, 4);
      setV(a + (target - a) * e);
      if (p < 1) raf = requestAnimationFrame(tick);
      else from.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

/** True for ~1.4 s whenever `value` goes up (used for the meter's charge burst). */
export function useRiseFlash(value: number) {
  const prev = useRef(value);
  const [flash, setFlash] = useState(0);
  useEffect(() => {
    if (value > prev.current + 0.5) setFlash((f) => f + 1);
    prev.current = value;
  }, [value]);
  return flash;
}

"use client";

// The motion vocabulary, kept small and quick so the one big moment (the blast radius) has room:
// one easing curve, a masked word reveal for the Brain's headline (once per visit), a short rise for things that
// arrive, and a risk score that counts up the first time a universe is shown.

import { animate, motion, useReducedMotion, type HTMLMotionProps } from "motion/react";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";

export const EASE = [0.16, 1, 0.3, 1] as const;
export const SPRING = { type: "spring", stiffness: 520, damping: 38, mass: 0.7 } as const;

const REVEALED = "orion.revealed";

/** A statement whose words rise out of a mask, one after another: the first time this visit only. */
export function WordReveal({
  text,
  className = "",
  delay = 0,
  stagger = 0.04,
  id = text,
}: {
  text: string;
  className?: string;
  delay?: number;
  stagger?: number;
  /** reveals sharing an id play once per browser session */
  id?: string;
}) {
  const reduce = useReducedMotion();
  // decided before the first paint (the server can't know), so a returning visitor never sees the words jump
  const [play, setPlay] = useState(true);
  useLayoutEffect(() => {
    try {
      const seen = new Set((sessionStorage.getItem(REVEALED) ?? "").split("|"));
      if (seen.has(id)) setPlay(false);
      else sessionStorage.setItem(REVEALED, [...seen, id].join("|"));
    } catch {
      setPlay(false);
    }
  }, [id]);
  if (!play || reduce) return <span className={className}>{text}</span>;
  const words = text.split(" ");
  // the space sits between the masks, not inside them: trailing white space inside an inline-block collapses,
  // which once ran the headline together ("Askanythingabout")
  return (
    <span className={className} aria-label={text}>
      {words.map((w, i) => (
        <Fragment key={i}>
          <span aria-hidden className="inline-block overflow-hidden pb-[0.08em] align-bottom">
            <motion.span
              className="inline-block"
              initial={{ y: "105%" }}
              animate={{ y: "0%" }}
              transition={{ duration: 0.5, ease: EASE, delay: delay + i * stagger }}
            >
              {w}
            </motion.span>
          </span>
          {i < words.length - 1 && " "}
        </Fragment>
      ))}
    </span>
  );
}

/** Arrives: rises a few pixels as it fades in. */
export function Rise({
  delay = 0,
  y = 8,
  children,
  ...rest
}: { delay?: number; y?: number } & HTMLMotionProps<"div">) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? { opacity: 0 } : { opacity: 0, y }}
      animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: EASE, delay }}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

const counted = new Set<string>();

/** A number that counts up to its value the first time `once` is shown in this page load; static after that. */
export function CountUp({
  value,
  once,
  decimals = 0,
  duration = 0.5,
  className = "",
}: {
  value: number;
  /** a key (a universe uid): the count plays once per key */
  once: string;
  decimals?: number;
  duration?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const [first] = useState(() => !counted.has(once));
  const from = useRef(first && !reduce ? 0 : value);
  const [shown, setShown] = useState(from.current);
  useEffect(() => {
    counted.add(once);
    if (reduce || from.current === value) {
      setShown(value);
      from.current = value;
      return;
    }
    const controls = animate(from.current, value, { duration, ease: "easeOut", onUpdate: (v) => setShown(v) });
    from.current = value;
    return () => controls.stop();
  }, [value, reduce, duration, once]);
  return <span className={`tnum ${className}`}>{shown.toFixed(decimals)}</span>;
}

/** true the first time `key` is seen in this page load: for animations that should play once per universe. */
export function useFirstTime(key: string): boolean {
  const [first] = useState(() => !counted.has(`first:${key}`));
  useEffect(() => {
    counted.add(`first:${key}`);
  }, [key]);
  return first;
}

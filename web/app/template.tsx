"use client";

// Re-mounted on every navigation: the new screen fades in, quickly. No movement and no blur: a page change should
// feel instant, and a full-page filter over a WebGL canvas is the most expensive thing a phone can be asked to draw.
import { motion } from "motion/react";

export default function Template({ children }: { children: React.ReactNode }) {
  return (
    <motion.div className="h-full" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.12, ease: "easeOut" }}>
      {children}
    </motion.div>
  );
}

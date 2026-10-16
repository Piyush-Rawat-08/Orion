import type { Metadata } from "next";
import Stage from "@/components/rehearse/Stage";

export const metadata: Metadata = {
  title: "Rehearse a shutdown",
  description: "Break a company in a parallel universe: rehearse retiring a system on a copy of the company graph, see what breaks, and find a safer sequence.",
};

export default function RehearsePage() {
  return <Stage />;
}

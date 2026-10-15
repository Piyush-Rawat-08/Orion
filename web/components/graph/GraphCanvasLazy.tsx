"use client";

// Both canvases touch WebGL and window at construction, so they only ever render in the browser. Which one
// shows is a per-browser choice (components/graph/mode.ts); 3D is the default.
import dynamic from "next/dynamic";
import type { GraphCanvasProps } from "./GraphCanvas";
import { useGraphMode } from "./mode";

const loading = () => <div className="graph-surface h-full w-full" aria-busy="true" />;
const GraphCanvas2D = dynamic(() => import("./GraphCanvas"), { ssr: false, loading });
const GraphCanvas3D = dynamic(() => import("./GraphCanvas3D"), { ssr: false, loading });

export default function LazyGraphCanvas(props: GraphCanvasProps) {
  const mode = useGraphMode();
  if (mode === "3d") return <GraphCanvas3D {...props} />;
  // the flat view has no hop-by-hop walk: the agent's trail shows as a plain highlight
  const trail = props.trail && !props.highlight?.length ? { highlight: props.trail.nodes, highlightColor: undefined } : {};
  return <GraphCanvas2D {...props} {...trail} />;
}

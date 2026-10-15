// d3-force-3d ships without types; this covers the parts lib/layout3d.ts uses.
declare module "d3-force-3d" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Any = any;
  export function forceSimulation(nodes?: Any[], numDimensions?: 1 | 2 | 3): Any;
  export function forceLink(links?: Any[]): Any;
  export function forceManyBody(): Any;
  export function forceCenter(x?: number, y?: number, z?: number): Any;
  export function forceX(x?: number): Any;
  export function forceY(y?: number): Any;
  export function forceZ(z?: number): Any;
}

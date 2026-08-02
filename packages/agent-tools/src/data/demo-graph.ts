/**
 * Bounded demo road lattice over the Avenues neighborhood of Chico, CA
 * (Butte County) — the geography the seeded wildfire scenario plays out on.
 *
 * This is a hand-authored demonstration graph, not a routing-grade network:
 * four north-south roads crossed with five east-west avenues, 20 nodes and
 * 31 undirected edges, with idealized (straight, axis-aligned) geometry. Every
 * route response is labelled `routing: "demonstration"` for exactly this
 * reason.
 *
 * Shared demo geography (all Harborline packages agree on these coordinates):
 *   bbox lon -121.848..-121.832, lat 39.738..39.755
 */
import type { LonLat } from "@harborline/event-schema";

export interface GraphNode {
  id: string;
  coord: LonLat;
  name: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  name: string;
  geometry: LonLat[];
}

export interface RoadGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** North-south roads, west to east. */
const AVENUES: { key: string; name: string; lon: number }[] = [
  { key: "esplanade", name: "The Esplanade", lon: -121.846 },
  { key: "oleander", name: "Oleander Ave", lon: -121.8425 },
  { key: "arcadian", name: "Arcadian Ave", lon: -121.839 },
  { key: "mangrove", name: "Mangrove Ave", lon: -121.835 },
];

/** East-west avenues, north to south. */
const STREETS: { key: string; name: string; lat: number }[] = [
  { key: "e_9th_ave", name: "E 9th Ave", lat: 39.7525 },
  { key: "e_7th_ave", name: "E 7th Ave", lat: 39.7495 },
  { key: "e_5th_ave", name: "E 5th Ave", lat: 39.7465 },
  { key: "e_3rd_ave", name: "E 3rd Ave", lat: 39.7435 },
  { key: "e_1st_ave", name: "E 1st Ave", lat: 39.7405 },
];

export function nodeId(avenueKey: string, streetKey: string): string {
  return `${avenueKey}__${streetKey}`;
}

function buildGraph(): RoadGraph {
  const nodes: GraphNode[] = [];
  const byKey = new Map<string, GraphNode>();

  for (const ave of AVENUES) {
    for (const st of STREETS) {
      const node: GraphNode = {
        id: nodeId(ave.key, st.key),
        coord: [ave.lon, st.lat],
        name: `${ave.name} & ${st.name}`,
      };
      nodes.push(node);
      byKey.set(node.id, node);
    }
  }

  const edges: GraphEdge[] = [];
  const connect = (fromId: string, toId: string, name: string) => {
    const from = byKey.get(fromId);
    const to = byKey.get(toId);
    if (!from || !to) throw new Error(`demo-graph: unknown node ${fromId} -> ${toId}`);
    edges.push({ from: fromId, to: toId, name, geometry: [from.coord, to.coord] });
  };

  // Along each east-west avenue, between adjacent north-south roads.
  for (const st of STREETS) {
    for (let i = 0; i < AVENUES.length - 1; i++) {
      connect(
        nodeId(AVENUES[i]!.key, st.key),
        nodeId(AVENUES[i + 1]!.key, st.key),
        st.name,
      );
    }
  }

  // Along each north-south road, between adjacent avenues.
  for (const ave of AVENUES) {
    for (let i = 0; i < STREETS.length - 1; i++) {
      connect(
        nodeId(ave.key, STREETS[i]!.key),
        nodeId(ave.key, STREETS[i + 1]!.key),
        ave.name,
      );
    }
  }

  return { nodes, edges };
}

export const demoGraph: RoadGraph = buildGraph();

/** Demo bounding box the whole system agrees on: [west, south, east, north]. */
export const DEMO_BBOX: [number, number, number, number] = [
  -121.848, 39.738, -121.832, 39.755,
];

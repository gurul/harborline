/**
 * Bounded Capitol Hill / Central District road lattice.
 *
 * This is a hand-authored demonstration graph, not a routing-grade network:
 * five north-south avenues crossed with four east-west streets, 20 nodes and
 * 31 undirected edges. Every route response is labelled
 * `routing: "demonstration"` for exactly this reason.
 *
 * Shared demo geography (all Harborline packages agree on these coordinates):
 *   bbox lon -122.330..-122.298, lat 47.598..47.626
 *
 * E Madison St runs diagonally through this area at roughly lat 47.6115. It is
 * intentionally NOT part of the lattice — a diagonal would need intersection
 * nodes that don't fall on the grid, and the demo scenario doesn't route over
 * it. Adding it later means adding nodes, not bending an existing edge.
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

/** North-south avenues, west to east. */
const AVENUES: { key: string; name: string; lon: number }[] = [
  { key: "broadway", name: "Broadway", lon: -122.3208 },
  { key: "12th_ave", name: "12th Ave", lon: -122.317 },
  { key: "15th_ave", name: "15th Ave", lon: -122.3128 },
  { key: "19th_ave", name: "19th Ave", lon: -122.3079 },
  { key: "23rd_ave", name: "23rd Ave", lon: -122.3035 },
];

/** East-west streets, north to south. */
const STREETS: { key: string; name: string; lat: number }[] = [
  { key: "e_john_st", name: "E John St", lat: 47.6205 },
  { key: "e_pine_st", name: "E Pine St", lat: 47.6154 },
  { key: "e_union_st", name: "E Union St", lat: 47.6098 },
  { key: "e_cherry_st", name: "E Cherry St", lat: 47.6033 },
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
    if (!from || !to) throw new Error(`seattle-graph: unknown node ${fromId} -> ${toId}`);
    edges.push({ from: fromId, to: toId, name, geometry: [from.coord, to.coord] });
  };

  // Along each east-west street, between adjacent avenues.
  for (const st of STREETS) {
    for (let i = 0; i < AVENUES.length - 1; i++) {
      connect(
        nodeId(AVENUES[i]!.key, st.key),
        nodeId(AVENUES[i + 1]!.key, st.key),
        st.name,
      );
    }
  }

  // Along each north-south avenue, between adjacent streets.
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

export const seattleGraph: RoadGraph = buildGraph();

/** Demo bounding box the whole system agrees on: [west, south, east, north]. */
export const DEMO_BBOX: [number, number, number, number] = [
  -122.33, 47.598, -122.298, 47.626,
];

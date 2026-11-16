import type { Connector } from "@harborline/event-schema";
import { nwsConnector } from "./nws.js";
import { usgsConnector } from "./usgs.js";
import { femaSheltersConnector } from "./fema.js";
import { demoConnector } from "./demo.js";
import { firmsConnector } from "./firms.js";
import { wfigsConnector } from "./wfigs.js";
import { airnowConnector } from "./airnow.js";
import { nwpsConnector } from "./nwps.js";
import { hmsSmokeConnector } from "./hms.js";

export { nwsConnector, NWS_ALERTS_URL, mapSeverity, mapUrgency, mapCertainty, mapEventType } from "./nws.js";
export { usgsConnector, USGS_FEED_URL, magnitudeToSeverity } from "./usgs.js";
export { femaSheltersConnector, FEMA_SHELTERS_URL, mapShelterStatus, pickAttribute } from "./fema.js";
export { demoConnector } from "./demo.js";
export {
  firmsConnector,
  FIRMS_FILES,
  FIRMS_INFO_URL,
  FIRMS_PROVIDER,
  FOOTPRINT_MARGIN_M,
  clusterDetections,
  clusterSeverity,
  detectionsToEvents,
  parseFirmsCsv,
  regionRows,
  type FirmsDetection,
} from "./firms.js";
export {
  buildDemoFixtures,
  demoFixtures,
  DEMO_USER_LOCATION,
  DEMO_EVENT_IDS,
  DEMO_RESOURCE_IDS,
  CLOSURE_CONTRADICTION_NOTE,
  DEMO_PROVIDER_PREFIX,
  type DemoFixtures,
} from "./demo/fixtures.js";
export { dedupKey, mergeEvents } from "./normalize.js";
export {
  wfigsConnector,
  wfigsToEvents,
  wfigsQueryUrl,
  containmentSeverity,
  normalizeIrwinId,
  WFIGS_PERIMETERS_LAYER,
  WFIGS_INCIDENTS_LAYER,
  WFIGS_PROVIDER,
} from "./wfigs.js";
export {
  airnowConnector,
  parseReportingArea,
  reportingAreaToObservations,
  AIRNOW_REPORTING_AREA_URL,
} from "./airnow.js";
export { nwpsConnector, gaugesToObservations, mapFloodCategory, nwpsGaugesUrl } from "./nwps.js";
export { hmsSmokeConnector, smokeToObservations, hmsTime, hmsSmokeQueryUrl } from "./hms.js";

/** The connectors added for fire, smoke, air and river data (all keyless). */
export const ENVIRONMENT_CONNECTOR_IDS = [
  "firms-viirs",
  "nifc-wfigs",
  "airnow-files",
  "nwps-gauges",
  "hms-smoke",
] as const;

/** Connectors whose healthy fetch backs a fire status. */
export const FIRE_CONNECTOR_IDS = ["firms-viirs", "nifc-wfigs"] as const;

/** Connectors that report power outages. None is configured today. */
export const POWER_CONNECTOR_IDS: readonly string[] = [];

export {
  FEED_USER_AGENT,
  fetchText,
  hashContent,
  makeEvent,
  makeSourceRecord,
  toIso,
  type EventDraft,
} from "./util.js";

export interface ConnectorEnv {
  demoMode: boolean;
}

/**
 * Live connectors always run; the demo connector is additive so the seeded
 * scenario can be demonstrated alongside real feeds without replacing them.
 */
export function allConnectors(env: ConnectorEnv): Connector[] {
  const connectors: Connector[] = [
    nwsConnector,
    usgsConnector,
    femaSheltersConnector,
    // Keyless fire feeds. No key or environment variable is needed.
    firmsConnector,
    wfigsConnector,
    // Keyless observation feeds (air quality, river gauges, smoke).
    airnowConnector,
    nwpsConnector,
    hmsSmokeConnector,
  ];
  if (env.demoMode) connectors.push(demoConnector);
  return connectors;
}

import type { Connector } from "@harborline/event-schema";
import { nwsConnector } from "./nws.js";
import { usgsConnector } from "./usgs.js";
import { femaSheltersConnector } from "./fema.js";
import { demoConnector } from "./demo.js";

export { nwsConnector, NWS_ALERTS_URL, mapSeverity, mapUrgency, mapCertainty, mapEventType } from "./nws.js";
export { usgsConnector, USGS_FEED_URL, magnitudeToSeverity } from "./usgs.js";
export { femaSheltersConnector, FEMA_SHELTERS_URL, mapShelterStatus, pickAttribute } from "./fema.js";
export { demoConnector } from "./demo.js";
export {
  buildDemoFixtures,
  demoFixtures,
  DEMO_USER_LOCATION,
  DEMO_EVENT_IDS,
  DEMO_RESOURCE_IDS,
  CLOSURE_CONTRADICTION_NOTE,
  type DemoFixtures,
} from "./demo/fixtures.js";
export { dedupKey, mergeEvents } from "./normalize.js";
export { hashContent, makeEvent, makeSourceRecord, toIso, type EventDraft } from "./util.js";

export interface ConnectorEnv {
  demoMode: boolean;
}

/**
 * Live connectors always run; the demo connector is additive so the seeded
 * scenario can be demonstrated alongside real feeds without replacing them.
 */
export function allConnectors(env: ConnectorEnv): Connector[] {
  const connectors: Connector[] = [nwsConnector, usgsConnector, femaSheltersConnector];
  if (env.demoMode) connectors.push(demoConnector);
  return connectors;
}

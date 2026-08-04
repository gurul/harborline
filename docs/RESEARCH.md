# Research grounding — disaster response protocols

This document records the research corpus behind Harborline's design and its
2026-08 hardening pass: what the literature says the best-evidenced disaster
response protocols are, where Harborline already embodies them, which findings
were implemented as code changes, and which remain roadmap items. Every source
below was **live-fetched and citation-verified** at collection time — a
reported source either resolved to the named document at its URL and supported
the claim attributed to it, or it was excluded.

## Method

Two independent retrieval passes, then adversarial verification:

1. **A multi-agent research sweep** across five dimensions — public alerting
   and warning, wildfire evacuation and routing, crisis informatics and
   information trust, shelter/resource logistics, and AI/LLM systems in
   disaster response. Each researcher's citations were checked by a separate
   verifier agent that fetched every URL and confirmed (a) the document exists
   under that title and (b) its content supports the claims attributed to it.
   Fabricated or unconfirmable citations were dropped (three candidates were
   excluded this way; see caveats).
2. **An alphaXiv MCP discovery pass** (`discover_papers`) over the same five
   dimensions, returning 58 ranked papers from the alphaXiv/arXiv corpus, used
   to cross-check coverage and surface recent work. Top-ranked supplemental
   papers are listed at the end.

## The twelve best-evidenced protocols

1. **Every public alert carries an explicit geographic footprint and an
   explicit expiration.** `<expires>` is REQUIRED and at least one `<area>`
   block is mandatory in the normative US profile.
   [CAP v1.2 IPAWS Profile, 2009](https://docs.oasis-open.org/emergency/cap/v1.2/ipaws-profile/v1.0/cs01/cap-v1.2-ipaws-profile-cs01.html)
2. **Precise geometry takes precedence over administrative geocodes** —
   polygon/circle over county-level FIPS codes.
   [CAP v1.2 IPAWS Profile, 2009](https://docs.oasis-open.org/emergency/cap/v1.2/ipaws-profile/v1.0/cs01/cap-v1.2-ipaws-profile-cs01.html)
3. **Alerts form supersession chains, not independent records.** Update/Cancel
   messages reference and retire prior messages; consuming alerts correctly
   means tracking the chain.
   [CAP v1.2 OASIS Standard, 2010](http://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2-os.html)
4. **Warning messages need five elements — source, hazard, location, time,
   protective action — and completeness beats length.** 360-character messages
   did not outperform 90-character ones when both carried all five elements.
   [Mileti & Sorensen, ORNL-6609, 1990](https://www.osti.gov/biblio/6137387);
   [Carlson et al., 2024](https://doi.org/10.1111/1468-5973.12587)
5. **Neutral factual framing outperforms persuasive, emotional, or coercive
   framing** (N=898; punishment-framed alerts had the lowest compliance).
   [Tale of Seven Alerts, arXiv:2102.00589](https://arxiv.org/abs/2102.00589)
6. **Repeated alerts have diminishing effect; over-broad targeting causes
   spillover evacuation** that congests routes (~580,000 devices, 2024
   Valparaíso wildfires).
   [arXiv:2503.21497](https://arxiv.org/abs/2503.21497)
7. **Route-closure decisions should be conservative geometric trigger buffers
   intersected with live hazard position**, recomputed as forecasts change.
   Historical validation showed buffers erred safely conservative.
   [WUIVAC, 2007](https://link.springer.com/article/10.1007/s11069-006-9032-y);
   [Cedar Fire validation, 2011](https://www.sciencedirect.com/science/article/abs/pii/S014362281000055X)
8. **Route validity decays on minute timescales under wildfire; temporary
   refuge areas are a formal fallback category when all routes fail.** In the
   Camp Fire, burnovers occurred on active evacuation routes and 31 improvised
   refuge areas sheltered 1,200+ civilians.
   [NIST TN 2252, 2023](https://nvlpubs.nist.gov/nistpubs/TechnicalNotes/NIST.TN.2252.pdf)
9. **Capacity, not distance, binds evacuation networks** — intersections and
   shared exits are the bottlenecks; one inbound emergency corridor stays
   reserved.
   [Paradise pipeline, arXiv:2002.06198](https://arxiv.org/abs/2002.06198);
   [Mill Valley study, arXiv:2307.07108](https://arxiv.org/abs/2307.07108);
   [Lahaina junction optimization, arXiv:2603.29055](https://arxiv.org/abs/2603.29055)
10. **Crowd volume and early crowd stance are unreliable veracity signals;
    corroboration must never outweigh authority.** Boston-bombing
    misinformation outran its correction 44:1.
    [Starbird et al., 2014](https://faculty.washington.edu/kstarbi/Starbird_iConference2014-final.pdf);
    [Zubiaga et al., 2016](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0150989)
11. **Time-without-confirmation is itself a veracity signal.** True rumours
    resolved in ~2 h median vs ~14 h for false ones.
    [Zubiaga et al., 2016](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0150989)
12. **LLM-verbalized confidence is systematically overconfident; confidence
    must be computed system-side, and grounded generation over structured
    authoritative records is the standard hallucination control.** The
    field survey's top-listed risk is hallucinated evacuation routes.
    [Xiong et al., arXiv:2306.13063](https://arxiv.org/abs/2306.13063);
    [LLMs for Disaster Management survey, arXiv:2501.06932](https://arxiv.org/abs/2501.06932);
    [Geospatial Awareness Layer, arXiv:2510.12061](https://arxiv.org/abs/2510.12061)

## Where Harborline's design already matches the literature

- **Restate-only LLM assistant** — grounding over parametric memory is the
  field's universal recommendation [2501.06932; 2510.12061;
  FloodBrain 2311.02597], and plain factual content beats persuasive framing
  [2102.00589].
- **System-computed confidence with four fixed labels, never percentages** —
  supported by demonstrated LLM overconfidence [2306.13063] and by TweetCred's
  60% user-disagreement rate with raw numeric credibility scores [1405.5490].
- **`authority × freshness × corroboration × precision × consistency`** — each
  factor has a standards or empirical anchor: CAP severity/urgency/certainty
  enums, the mandatory IPAWS expiration, polygon-over-FIPS precedence, and the
  44:1 misinformation ratio justifying authority-dominant weighting.
- **Enforced freshness with stale records displayed but never recommended** —
  shelter data quality degrades exactly when usage peaks [CrisisReady 2020],
  and route validity decays on minute timescales [NIST TN 2252].
- **Route elimination, never averaging** — the trigger-buffer paradigm with
  conservative bias [WUIVAC 2007; Cedar Fire 2011].
- **Contradictions shown side by side, never averaged** — the crisis-informatics
  literature warns explicitly against consensus aggregation [Starbird 2014;
  Zubiaga 2016].
- **Provenance on every record** — diffusion strips provenance from 56% of
  crisis content; anchoring to source + timestamp is the countermeasure
  [Starbird 2014].

## What the 2026-08 hardening pass implemented

| Change | Research basis | Where |
|---|---|---|
| Unparseable timestamps fail **stale**, never fresh; honest age labels | Freshness is load-bearing [IPAWS Profile; NIST TN 2252] | `packages/event-schema/src/freshness.ts` |
| Confidence formula guards: unknown tier → least trust, non-finite age → stale floor, no NaN | Confidence must be computed system-side and fail toward less trust [2306.13063] | `packages/event-schema/src/confidence.ts` |
| Confidence **decays at read time** instead of freezing at ingest | Same; a 3-hour-old fire must not keep an "official" label | `packages/agent-tools/src/store.ts` |
| All geometry coordinates range-checked; polygon rings must be closed | Geometry precedence makes geometry the load-bearing field [IPAWS Profile] | `packages/event-schema/src/geo.ts` |
| Point hazards get a severity-scaled standoff (30–500 m), conservative bias | Trigger-buffer conservatism [WUIVAC 2007; Cedar Fire 2011] | `packages/agent-tools/src/router.ts` |
| Validator: reassurance/guarantee lexicon broadened beyond 8 exact phrases | Neutral framing beats reassurance; officials never reassure [2102.00589] | `packages/agent-tools/src/validator.ts` |
| Validator: LLM answers over severe active hazards must carry a protective action | Five-element completeness model [ORNL-6609; Carlson 2024] | `packages/agent-tools/src/validator.ts` |
| `raw_payload` excluded from LLM prompts and from entity grounding | Grounding must be over normalized authoritative records [2501.06932; 2510.12061] | `packages/agent-tools/src/llm.ts`, `validator.ts` |
| Rate limiting no longer trusts spoofable `X-Forwarded-For` by default; per-client SSE cap | System availability during load is a warning-system requirement [2503.21497] | `services/api/src/rate-limit.ts`, `routes/stream.ts` |
| Freshness validated against a post-LLM-call clock | Minute-scale validity decay [NIST TN 2252] | `services/api/src/routes/assistant.ts` |
| Resource retention sweep + cap; bounded web feed cache; request timeouts | Operational hygiene for sustained incidents | `store.ts`, `apps/web/lib/*` |

## Roadmap items grounded in this corpus (not yet implemented)

- **CAP Update/Cancel supersession chains** in ingest — retire superseded
  geometry [CAP v1.2]. Effort: M.
- **Precision tiering as a defined enum** (polygon > circle > FIPS) feeding the
  confidence precision factor [IPAWS Profile]. Effort: S.
- **Per-route trigger buffers** computed from spread rate, recomputed on
  forecast change [WUIVAC; Cedar Fire; NIST TN 2252]. Effort: L.
- **Evacuation warning-vs-order as a routing input**; phased-zone awareness
  [Mill Valley; NIST TN 2252]. Effort: M.
- **Intersection/shared-exit funneling penalties; reserved emergency
  corridors** [Paradise; Lahaina]. Effort: M.
- **Temporary Refuge Area fallback** when every route is eliminated
  [NIST TN 2252]. Effort: M.
- **FEMA NSS-aligned shelter schema** (status enum incl. Alert, capacity
  triplet, accessibility flags, shelter-in-hazard-zone exposure)
  [FEMA NSS; CrisisReady 2020]. Effort: M.
- **"Developing" label time-decay** — long-unconfirmed claims decay toward
  "unverified" [Zubiaga 2016]. Effort: S.
- **Notify only on material change** — diminishing returns of repeated alerts
  [2503.21497]. Effort: S.

## Verified source table

| # | Source | Dimension | Year | Type |
|---|--------|-----------|------|------|
| 1 | [Common Alerting Protocol v1.2 (OASIS)](http://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2-os.html) | alerting-warning | 2010 | standard |
| 2 | [CAP v1.2 IPAWS Profile v1.0 (OASIS)](https://docs.oasis-open.org/emergency/cap/v1.2/ipaws-profile/v1.0/cs01/cap-v1.2-ipaws-profile-cs01.html) | alerting-warning | 2009 | standard |
| 3 | [Mileti & Sorensen, Communication of Emergency Public Warnings (ORNL-6609)](https://www.osti.gov/biblio/6137387) | alerting-warning | 1990 | government report |
| 4 | [Tale of Seven Alerts (arXiv:2102.00589)](https://arxiv.org/abs/2102.00589) | alerting-warning | 2021 | arXiv |
| 5 | [Behavioral response to mobile evacuation alerts (arXiv:2503.21497)](https://arxiv.org/abs/2503.21497) | alerting-warning | 2025 | arXiv |
| 6 | [Carlson et al., 360- vs 90-Character WEA Messages (JCCM)](https://doi.org/10.1111/1468-5973.12587) | alerting-warning | 2024 | journal |
| 7 | [NIST TN 2252 — Camp Fire NETTRA Case Study](https://nvlpubs.nist.gov/nistpubs/TechnicalNotes/NIST.TN.2252.pdf) | wildfire-evacuation | 2023 | government report |
| 8 | [WUIVAC WUI evacuation trigger model (Natural Hazards)](https://link.springer.com/article/10.1007/s11069-006-9032-y) | wildfire-evacuation | 2007 | journal |
| 9 | [Dynamic Trigger Buffers / 2003 Cedar Fire (Applied Geography)](https://www.sciencedirect.com/science/article/abs/pii/S014362281000055X) | wildfire-evacuation | 2011 | journal |
| 10 | [Simulation Pipeline for Traffic Evacuation (arXiv:2002.06198)](https://arxiv.org/abs/2002.06198) | wildfire-evacuation | 2020 | arXiv |
| 11 | [Mill Valley Evacuation Study (arXiv:2307.07108)](https://arxiv.org/abs/2307.07108) | wildfire-evacuation | 2023 | arXiv |
| 12 | [Lahaina Game-Theoretic Junction Optimization (arXiv:2603.29055)](https://arxiv.org/abs/2603.29055) | wildfire-evacuation | 2026 | arXiv |
| 13 | [Starbird et al., Rumors, False Flags, and Digital Vigilantes](https://faculty.washington.edu/kstarbi/Starbird_iConference2014-final.pdf) | crisis-informatics | 2014 | conference |
| 14 | [Zubiaga et al., Rumours in Conversational Threads (PLOS ONE)](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0150989) | crisis-informatics | 2016 | journal |
| 15 | [TweetCred (arXiv:1405.5490)](https://arxiv.org/abs/1405.5490) | crisis-informatics | 2014 | arXiv |
| 16 | [Detection and Resolution of Rumours: A Survey (arXiv:1704.00656)](https://arxiv.org/abs/1704.00656) | crisis-informatics | 2018 | arXiv |
| 17 | [Processing Social Media Messages in Mass Emergency (arXiv:1407.7071)](https://arxiv.org/abs/1407.7071) | crisis-informatics | 2015 | arXiv |
| 18 | [CrisisBench (arXiv:2004.06774)](https://arxiv.org/abs/2004.06774) | crisis-informatics | 2021 | arXiv |
| 19 | [Optimal Shelter Location-Allocation under Uncertainty (arXiv:1802.05775)](https://arxiv.org/abs/1802.05775) | resource-shelter | 2018 | arXiv |
| 20 | [Branch-and-Price for Equitable Last-Mile Relief (arXiv:2512.19882)](https://arxiv.org/abs/2512.19882) | resource-shelter | 2025 | arXiv |
| 21 | [Recent Advances in Disaster Emergency Response Planning (arXiv:2505.03979)](https://arxiv.org/abs/2505.03979) | resource-shelter | 2025 | arXiv |
| 22 | [Incident Prediction, Resource Allocation, and Dispatch review (arXiv:2006.04200)](https://arxiv.org/abs/2006.04200) | resource-shelter | 2020 | arXiv |
| 23 | [FEMA ESF#6 / National Shelter System open data](https://gis.fema.gov/arcgis/rest/services/NSS/OpenShelters/MapServer) | resource-shelter | live | government data |
| 24 | [CrisisReady — NSS Data: Opportunities and Challenges](https://www.crisisready.io/) | resource-shelter | 2020 | NGO report |
| 25 | [Harnessing LLMs for Disaster Management: A Survey (arXiv:2501.06932)](https://arxiv.org/abs/2501.06932) | ai-agents | 2025 | arXiv |
| 26 | [Geospatial Awareness Layer for Wildfire Response (arXiv:2510.12061)](https://arxiv.org/abs/2510.12061) | ai-agents | 2025 | arXiv |
| 27 | [FloodBrain: RAG Flood Disaster Reporting (arXiv:2311.02597)](https://arxiv.org/abs/2311.02597) | ai-agents | 2023 | arXiv |
| 28 | [Zero-Shot Classification of Crisis Tweets (arXiv:2410.00182)](https://arxiv.org/abs/2410.00182) | ai-agents | 2024 | arXiv |
| 29 | [Can LLMs Express Their Uncertainty? (arXiv:2306.13063)](https://arxiv.org/abs/2306.13063) | ai-agents | 2023 | arXiv |
| 30 | [CrisiText: Warning-Message Dataset (arXiv:2510.09243)](https://arxiv.org/abs/2510.09243) | ai-agents | 2025 | arXiv |

## Supplemental alphaXiv discovery corpus

The alphaXiv `discover_papers` pass returned 58 ranked papers; the top-ranked
per dimension, for follow-up reading (retrieved and ranked by alphaXiv; not
independently claim-verified like the table above):

- **AI agents:** Can LLM Agents Respond to Disasters? (2605.11633) · RAPTOR-AI
  for Disaster OODA Loop (2602.00030) · Guide Me Out: VLM Operators in Crisis
  Scenarios (2606.09428)
- **Alerting:** Android Alerts in the 2025 Marmara Ereglisi Earthquake
  (2607.08975) · LLMs and Social Media for Earthquake Early Warning Perception
  (2603.23322)
- **Crisis informatics:** LLM-based uncertainty assessment of social signals
  (2605.00829) · ReMMD multimodal misinformation detection (2606.24112)
- **Resource/shelter:** Multi-Objective Routing + Facility Location for
  Earthquake Response (2503.22487) · Set Covering Routing for Relief
  (2605.00131)
- **Wildfire evacuation:** Time-Expanded Networks with Integrated Wildfire
  Information (2410.14500) · Dual-Stage ML Evacuation Behavior Prediction
  (2603.02223)

## Corpus caveats

FEMA's fema.gov IPAWS pages block automated fetches, so the OASIS IPAWS
Profile is cited as the normative substitute. No strong arXiv paper exists on
CAP protocol design itself — the standards are the primary sources. No located
paper benchmarks side-by-side contradiction display as a UI protocol;
Harborline's never-average design is consistent with the literature's warnings
but not itself benchmarked. Three unverified follow-up candidates
(CrisiSense-RAG 2602.13239, DisasterLex 2605.30538, attribution survey
2601.19927) were excluded because they could not be verified at collection
time.

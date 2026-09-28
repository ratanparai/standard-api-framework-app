// The Kafka in-topic (eh.saf.in.v1) accepts several distinct envelope shapes —
// see Kafka-Events-Specification/kafka-topics/eh.saf.in.v1-value.json in
// EcoHub-AG/Api-Specs (async-rest-1.2.1), which is an anyOf of these. Only one
// JSON document is ever produced to Kafka: the envelope itself. Which of these
// shapes applies determines the envelope's `type` field and whether a
// `ProcessName` even applies.
export type EventKind = "data" | "generic" | "ids" | "inquiry" | "error" | "offerNlpiError";

export type EventTypeDef = {
  kind: EventKind;
  label: string;
  ceType: string; // CloudEvents `type` field
  envelopeSchemaPath: string; // relative to Kafka-Events-Specification/ at async-rest-1.2.1
  hasProcess: boolean; // false = no ProcessName selector (ids/inquiry/error kinds)
};

export const EVENT_TYPES: Record<EventKind, EventTypeDef> = {
  data: { kind: "data", label: "Data event", ceType: "ch.ecohub.saf.data", envelopeSchemaPath: "eventType-data/SAFEventType.json", hasProcess: true },
  generic: { kind: "generic", label: "Generic exchange", ceType: "ch.ecohub.saf.generic", envelopeSchemaPath: "eventType-generic-data/SAFGenericEventType.json", hasProcess: true },
  ids: { kind: "ids", label: "Document intelligence (IDS)", ceType: "ch.ecohub.saf.ids", envelopeSchemaPath: "eventType-ids/SAFIDSEventType.json", hasProcess: false },
  inquiry: { kind: "inquiry", label: "Inquiry", ceType: "ch.ecohub.saf.inquiry", envelopeSchemaPath: "eventType-inquiry/SAFInquiryEventType.json", hasProcess: false },
  error: { kind: "error", label: "SAF error", ceType: "ch.ecohub.saf.error", envelopeSchemaPath: "eventType-saf-error/SAFErrorEventType.json", hasProcess: false },
  offerNlpiError: { kind: "offerNlpiError", label: "Offer NLPI error", ceType: "ch.ecohub.saf.error.offer-nlpi", envelopeSchemaPath: "eventType-standard-error/OfferNLPIErrorEventType.json", hasProcess: false },
};

export const ALL_EVENT_KINDS = Object.keys(EVENT_TYPES) as EventKind[];

// Process names for the Generic Exchange kind's processName dropdown — the
// full GenericProcessNameType.json enum at async-rest-1.2.1.
// Note it's "offer", not "offer.nlpi", for this kind.
export const GENERIC_PROCESS_SUGGESTIONS = [
  "offer", "invoice", "commission", "contract", "mandate", "claimsExperience",
  "claims", "information", "customer", "broker",
];

export const GENERIC_PROCESS_VERSION = "1.0.0";

export const BUSINESS_DOMAINS = {
  insurance: "Insurance",
  occupationalPension: "Occupational pension",
} as const;
export type BusinessDomain = keyof typeof BUSINESS_DOMAINS;

// GenericSubProcessNameType.json — workflow-stage values (verbatim lowercase
// enum), used for the subProcessName of the generic and ids kinds. Note the
// generic event additionally pins this with `allOf … enum: ["provide"]`, so
// "provide" is the only value that passes schema validation there.
export const GENERIC_SUBPROCESS_STAGES = ["initiate", "provide", "review", "decide", "execute", "close"];

// SubProcessNameType.json — subProcessName options for the data/inquiry/error/
// offerNlpiError kinds (the generic and ids kinds use GENERIC_SUBPROCESS_STAGES).
export const SUBPROCESS_NAMES = ["request", "offer", "feedback", "conclusionDecision", "billing", "reminder", "contract", "commission", "submission", "cancellation", "claimsExperience"];

// The process-name string used to look up an activated encryption key
// (PublicKeyInfo.supportedProcesses) — the CloudEvents type suffix, not a
// business process. Real keys carry entries like { processName: "generic" } /
// { processName: "ids" } alongside the standard processes, so the generic kind
// must match "generic" (NOT the free-text genericProcessName like "offer").
// Confirmed values only — kinds not listed here still fall back to the event
// type's label, which is very unlikely to match a real key's supportedProcesses
// and should be replaced once the real value is known.
export const KEY_PROCESS_NAME_OVERRIDES: Partial<Record<EventKind, string>> = {
  generic: "generic",
  ids: "ids",
};

// Envelope processName for the kinds with no ProcessName selector
// (ids/inquiry/error/offerNlpiError) — validates against ProcessNameType (or the
// ProcessNameAllType superset for saf-error). Fixed placeholder.
export const DEFAULT_PROCESS_NAME_NO_SELECTOR = "contract";

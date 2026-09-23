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

// GenericProcessNameType.json — the envelope processName enum for the Generic
// Exchange kind (also GenericExchange.json's payload processName, which must
// match it). Note it's "offer", not "offer.nlpi", and there is no "other".
export const GENERIC_PROCESS_NAMES = [
  "offer", "invoice", "commission", "contract", "mandate", "claimsExperience",
  "claims", "information", "customer", "broker",
] as const;
export type GenericProcessName = (typeof GENERIC_PROCESS_NAMES)[number];

// SAFGenericEventType.json pins subProcessName to this single (lowercase)
// GenericSubProcessNameType value.
export const GENERIC_SUBPROCESS_NAME = "provide";

// BusinessDomainType.json — required on the Generic Exchange envelope only.
export const BUSINESS_DOMAINS = ["insurance", "occupationalPension"] as const;
export type BusinessDomain = (typeof BUSINESS_DOMAINS)[number];

// GenericExchange.json's processVersion const; also sent as the envelope processVersion.
export const GENERIC_PROCESS_VERSION = "1.0.0";

// The process-name string used to look up an activated encryption key
// (PublicKeyInfo.supportedProcesses) for event kinds that have no ProcessName
// selector in the UI. Confirmed values only — kinds not listed here still fall
// back to the event type's label, which is very unlikely to match a real key's
// supportedProcesses and should be replaced once the real value is known.
export const KEY_PROCESS_NAME_OVERRIDES: Partial<Record<EventKind, string>> = {
  ids: "ids",
  generic: "generic", // tried first; SendEvent then falls back to the chosen GenericProcessName
};

// Envelope processName/subProcessName for the kinds with no ProcessName selector
// (ids/inquiry/error/offerNlpiError) — these still validate against ProcessNameType
// and GenericSubProcessNameType respectively, so "" / "n/a" are invalid. "contract"
// and "Initiate" are fixed placeholders (chosen values, not derived from real data).
export const DEFAULT_PROCESS_NAME_NO_SELECTOR = "contract";
export const DEFAULT_SUBPROCESS_NAME_NO_SELECTOR = "Initiate";

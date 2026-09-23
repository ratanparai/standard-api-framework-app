// Builds the outgoing SAF envelope object. All 6 branches of the
// eh.saf.in.v1-value anyOf (SAFEventType, SAFGenericEventType, SAFIDSEventType,
// SAFInquiryEventType, SAFErrorEventType, OfferNLPIErrorEventType) share the
// same top-level property set (id/source/specversion/type/datacontenttype/
// dataschema/subject/time/licenceKey/userAgent/eventReceiver/eventSender/data/
// processGroupId/processId/processName/processVersion/processStatus/
// subProcessName/subProcessStatus) — confirmed directly against each schema
// file at async-rest-1.2.1 — so one skeleton builder covers all of them; only
// `type` and the process-name source differ per kind. The one exception is
// SAFGenericEventType, which additionally requires `businessDomain` — every
// other schema is additionalProperties:false, so it's only emitted when set.
import type { EventKind, EventTypeDef } from "../../data/eventTypes";
import { API_SPECS_BASE } from "./loader";

export type EnvelopeContext = {
  eventType: EventTypeDef;
  data: any;
  dataschema?: string;
  subject: string;
  licenceKey: string;
  userAgent: { name: string; version: string };
  eventReceiver: { category: string; id: string };
  eventSender: { category: string; id: string };
  processId?: string; // pass when the payload must reference it (GenericExchange processIdentificationNo)
  processName: string;
  processVersion: string;
  processStatus: string;
  subProcessName: string;
  subProcessStatus: string;
  businessDomain?: string; // generic only
};

export function envelopeSchemaUrl(kind: EventKind, def: EventTypeDef): string {
  return `${API_SPECS_BASE}/Kafka-Events-Specification/${def.envelopeSchemaPath}`;
}

export function buildEnvelopeSkeleton(ctx: EnvelopeContext) {
  return {
    id: globalThis.crypto.randomUUID(),
    source: "http://www.myecohub.ch/saf-testing-tool",
    specversion: "1.0",
    type: ctx.eventType.ceType,
    datacontenttype: "application/json",
    dataschema: ctx.dataschema,
    subject: ctx.subject,
    time: new Date().toISOString(),
    licenceKey: ctx.licenceKey,
    userAgent: ctx.userAgent,
    eventReceiver: ctx.eventReceiver,
    eventSender: ctx.eventSender,
    data: ctx.data,
    processId: ctx.processId ?? globalThis.crypto.randomUUID(),
    processGroupId: globalThis.crypto.randomUUID(),
    processName: ctx.processName,
    processVersion: ctx.processVersion,
    processStatus: ctx.processStatus,
    subProcessName: ctx.subProcessName,
    subProcessStatus: ctx.subProcessStatus,
    ...(ctx.businessDomain !== undefined ? { businessDomain: ctx.businessDomain } : {}),
  };
}

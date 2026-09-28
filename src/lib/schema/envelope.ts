// Builds the outgoing SAF envelope object. The data, IDS, inquiry, and error
// branches share their documented base properties; Generic additionally
// carries its root-level businessDomain. A draft's processId is supplied by
// the composer so it remains stable across encryptions and can match the
// Generic payload's processIdentificationNo.
import type { BusinessDomain, EventKind, EventTypeDef } from "../../data/eventTypes";
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
  processName: string;
  processId: string;
  processVersion: string;
  businessDomain?: BusinessDomain;
  processStatus: string;
  subProcessName: string;
  subProcessStatus: string;
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
    processId: ctx.processId,
    processGroupId: globalThis.crypto.randomUUID(),
    processName: ctx.processName,
    processVersion: ctx.processVersion,
    ...(ctx.eventType.kind === "generic" && ctx.businessDomain ? { businessDomain: ctx.businessDomain } : {}),
    processStatus: ctx.processStatus,
    subProcessName: ctx.subProcessName,
    subProcessStatus: ctx.subProcessStatus,
  };
}

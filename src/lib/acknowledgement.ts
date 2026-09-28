import type { MembershipType } from "../types";

const ACKNOWLEDGEABLE_TYPES = new Set([
  "ch.ecohub.saf.data",
  "ch.ecohub.saf.generic",
  "ch.ecohub.saf.ids",
  "ch.ecohub.saf.inquiry",
]);
const CATEGORIES = new Set(["broker", "insurer", "serviceprovider"]);
const SUBPROCESS_STATUSES = new Set([
  "Created", "InProgress", "Responded", "Updated", "Error", "Inquiry", "Inquiry_Answer", "Received", "Closed",
]);
const UUID_PATTERN = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const IDP_PATTERN = /^IDP\d{7}$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export type AcknowledgementProfile = {
  idp: string;
  membershipType: MembershipType;
  licenceKey: string;
};

export type AcknowledgementEvent = {
  id: string;
  source: string;
  specversion: "1.0";
  type: string;
  time: string;
  licenceKey: string;
  userAgent: { name: string; version: string };
  eventReceiver: { category: string; id: string };
  eventSender: { category: string; id: string };
  processId: string;
  processGroupId?: string;
  processName: string;
  processVersion: string;
  processStatus: "active";
  subProcessName: string;
  subProcessStatus: "Received";
  businessDomain?: "insurance" | "occupationalPension";
  data?: never;
};

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function acknowledgementIneligibility(
  event: unknown,
  profile: AcknowledgementProfile,
): string | null {
  if (!isObject(event)) return "The selected inbox item has no valid SAF event.";
  if (!ACKNOWLEDGEABLE_TYPES.has(event.type)) return "Only data, generic, IDS, and inquiry events can be acknowledged.";
  if (!isObject(event.data) || Object.keys(event.data).length === 0) return "This event has no payload to acknowledge.";
  if (event.subProcessStatus === "Received" || event.subProcessStatus === "Closed") return "This event is already received or closed.";
  if (event.processStatus === "closed") return "This process is closed and cannot be acknowledged.";
  if (event.processStatus !== "active") return "The event has no valid processStatus.";
  if (typeof event.processId !== "string" || !UUID_PATTERN.test(event.processId)) return "The event has no valid processId UUID.";
  if (typeof event.processName !== "string" || !event.processName.trim()) return "The event has no processName.";
  if (typeof event.processVersion !== "string" || !SEMVER_PATTERN.test(event.processVersion)) return "The event has no valid processVersion.";
  if (typeof event.subProcessName !== "string" || !event.subProcessName.trim()) return "The event has no subProcessName.";
  if (typeof event.subProcessStatus !== "string" || !SUBPROCESS_STATUSES.has(event.subProcessStatus)) return "The event has no valid subProcessStatus.";
  if (event.processGroupId !== undefined && (typeof event.processGroupId !== "string" || !UUID_PATTERN.test(event.processGroupId))) {
    return "The event has an invalid processGroupId UUID.";
  }
  if (typeof profile.idp !== "string" || !IDP_PATTERN.test(profile.idp)) return "Connect a profile with a valid IDP before acknowledging.";
  if (!isObject(event.eventReceiver) || event.eventReceiver.id !== profile.idp) return "This event was not addressed to the active profile.";
  if (!CATEGORIES.has(event.eventReceiver.category)) return "The event has an invalid receiver category.";
  if (!isObject(event.eventSender) || typeof event.eventSender.id !== "string" || !IDP_PATTERN.test(event.eventSender.id)) {
    return "The event has no valid sender IDP to acknowledge.";
  }
  if (!CATEGORIES.has(event.eventSender.category)) return "The event has an invalid sender category.";
  if (!CATEGORIES.has(profile.membershipType)) return "The active profile has an invalid membership type.";
  if (typeof profile.licenceKey !== "string" || profile.licenceKey.trim().length < 3) return "The active profile has no valid licence key.";
  if (event.type === "ch.ecohub.saf.generic" && event.businessDomain !== "insurance" && event.businessDomain !== "occupationalPension") {
    return "The Generic event has no valid businessDomain.";
  }
  return null;
}

export function buildAcknowledgement(
  event: unknown,
  profile: AcknowledgementProfile,
  options: { eventId?: string; time?: string } = {},
): AcknowledgementEvent {
  const issue = acknowledgementIneligibility(event, profile);
  if (issue) throw new Error(issue);
  const original = event as Record<string, any>;
  const acknowledgement: AcknowledgementEvent = {
    id: options.eventId ?? globalThis.crypto.randomUUID(),
    source: "http://www.myecohub.ch/saf-testing-tool",
    specversion: "1.0",
    type: original.type,
    time: options.time ?? new Date().toISOString(),
    licenceKey: profile.licenceKey,
    userAgent: { name: "SAF Testing Tool", version: "2.1" },
    eventReceiver: { category: original.eventSender.category, id: original.eventSender.id },
    eventSender: { category: profile.membershipType, id: profile.idp },
    processId: original.processId,
    processName: original.processName,
    processVersion: original.processVersion,
    processStatus: original.processStatus,
    subProcessName: original.subProcessName,
    subProcessStatus: "Received",
  };
  if (original.processGroupId !== undefined) acknowledgement.processGroupId = original.processGroupId;
  if (original.type === "ch.ecohub.saf.generic") acknowledgement.businessDomain = original.businessDomain;
  return acknowledgement;
}

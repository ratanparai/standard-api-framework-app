import { describe, expect, it } from "vitest";
import { acknowledgementIneligibility, buildAcknowledgement } from "./acknowledgement";

const profile = {
  idp: "IDP3003668",
  membershipType: "insurer" as const,
  licenceKey: "license-123",
};

const incoming = {
  id: "11111111-1111-4111-8111-111111111111",
  type: "ch.ecohub.saf.data",
  time: "2026-09-26T00:00:00.000Z",
  eventReceiver: { category: "insurer", id: profile.idp },
  eventSender: { category: "broker", id: "IDP3003669" },
  processId: "22222222-2222-4222-8222-222222222222",
  processGroupId: "33333333-3333-4333-8333-333333333333",
  processName: "invoice",
  processVersion: "5.3.0",
  processStatus: "active",
  subProcessName: "offer",
  subProcessStatus: "InProgress",
  data: { payload: "ciphertext", encryptionKey: "wrapped-key", payloadSignature: "signature" },
  // Intentionally include unrelated projection/extension fields to verify the
  // acknowledgement is whitelisted rather than copied wholesale.
  subject: "original subject",
  recipient: { ignored: true },
};

describe("buildAcknowledgement", () => {
  it("reverses routing, creates a fresh event ID, preserves process identity and omits the payload", () => {
    const ack = buildAcknowledgement(incoming, profile, {
      eventId: "44444444-4444-4444-8444-444444444444",
      time: "2026-09-26T12:00:00.000Z",
    });

    expect(ack.id).not.toBe(incoming.id);
    expect(ack.eventSender).toEqual({ category: "insurer", id: profile.idp });
    expect(ack.eventReceiver).toEqual({ category: "broker", id: "IDP3003669" });
    expect(ack.processId).toBe(incoming.processId);
    expect(ack.processGroupId).toBe(incoming.processGroupId);
    expect(ack.processName).toBe(incoming.processName);
    expect(ack.processVersion).toBe(incoming.processVersion);
    expect(ack.processStatus).toBe("active");
    expect(ack.subProcessStatus).toBe("Received");
    expect(ack).not.toHaveProperty("data");
    expect(ack).not.toHaveProperty("recipient");
    expect(ack).not.toHaveProperty("subject");
  });

  it("keeps Generic businessDomain at the acknowledgement root", () => {
    const ack = buildAcknowledgement({ ...incoming, type: "ch.ecohub.saf.generic", businessDomain: "occupationalPension" }, profile);
    expect(ack.businessDomain).toBe("occupationalPension");
    expect(ack).not.toHaveProperty("data");
  });

  it.each([
    [{ ...incoming, processId: "not-a-uuid" }, "processId UUID"],
    [{ ...incoming, eventReceiver: { category: "insurer", id: "IDP0000000" } }, "not addressed"],
    [{ ...incoming, type: "ch.ecohub.saf.error" }, "Only data"],
    [{ ...incoming, subProcessStatus: "Received" }, "already received"],
    [{ ...incoming, data: {} }, "no payload"],
    [{ ...incoming, type: "ch.ecohub.saf.generic" }, "businessDomain"],
  ])("rejects events that cannot be safely acknowledged", (event, message) => {
    expect(acknowledgementIneligibility(event, profile)).toContain(message);
    expect(() => buildAcknowledgement(event, profile)).toThrow(message);
  });
});

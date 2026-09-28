import { afterEach, describe, expect, it, vi } from "vitest";
import { EVENT_TYPES } from "../../data/eventTypes";
import { buildEnvelopeSkeleton } from "./envelope";

afterEach(() => vi.unstubAllGlobals());

const encryptedData = {
  payload: "eyJvayI6dHJ1ZX0=",
  encryptionKey: "wrapped-aes-key",
  payloadSignature: "signature-over-payload",
  publicKeyVersion: "1",
  signatureKeyVersion: "1",
};

function build(kind: "generic" | "data", businessDomain?: "insurance" | "occupationalPension") {
  vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValueOnce("id-1").mockReturnValueOnce("id-2").mockReturnValueOnce("id-3") });
  return buildEnvelopeSkeleton({
    eventType: EVENT_TYPES[kind],
    data: encryptedData,
    subject: "Generic exchange provide",
    licenceKey: "license",
    userAgent: { name: "test", version: "1" },
    eventReceiver: { category: "insurer", id: "receiver" },
    eventSender: { category: "insurer", id: "sender" },
    processName: "offer",
    processId: "33333333-3333-4333-8333-333333333333",
    processVersion: "1.0.0",
    businessDomain,
    processStatus: "active",
    subProcessName: "provide",
    subProcessStatus: "Created",
  });
}

describe("buildEnvelopeSkeleton", () => {
  it.each(["insurance", "occupationalPension"] as const)("places Generic businessDomain=%s at the root", (businessDomain) => {
    const envelope = build("generic", businessDomain);

    expect(envelope.businessDomain).toBe(businessDomain);
    expect(envelope.data).toBe(encryptedData);
    expect(envelope.data).not.toHaveProperty("businessDomain");
    expect(Object.keys(envelope)).toContain("businessDomain");
    expect(envelope.processId).toBe("33333333-3333-4333-8333-333333333333");
  });

  it("omits businessDomain for non-Generic event kinds", () => {
    const envelope = build("data", "insurance");

    expect(envelope).not.toHaveProperty("businessDomain");
    expect(envelope.data).toBe(encryptedData);
  });
});

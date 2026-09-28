import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Inbox from "./Inbox";

const mocks = vi.hoisted(() => ({
  useApp: vi.fn(),
  messages: [] as any[],
  inboxFor: vi.fn(),
  addMessage: vi.fn(),
  markAcknowledged: vi.fn(),
  kafkaStartConsumer: vi.fn(),
  kafkaStopConsumer: vi.fn(),
  fetchMemberKeys: vi.fn(),
  produceViaKafka: vi.fn(),
  schemaRegistryGetIds: vi.fn(),
  publish: vi.fn(),
}));

vi.mock("../store", () => ({ useApp: mocks.useApp }));
vi.mock("../lib/inboxStore", () => ({
  inboxFor: mocks.inboxFor,
  addMessage: mocks.addMessage,
  markAcknowledged: mocks.markAcknowledged,
}));
vi.mock("../lib/ecohub", () => ({
  kafkaStartConsumer: mocks.kafkaStartConsumer,
  kafkaStopConsumer: mocks.kafkaStopConsumer,
  fetchMemberKeys: mocks.fetchMemberKeys,
  produceViaKafka: mocks.produceViaKafka,
  schemaRegistryGetIds: mocks.schemaRegistryGetIds,
  isTauri: true,
}));
vi.mock("../lib/bus", () => ({ publish: mocks.publish }));
vi.mock("../lib/crypto", () => ({ decrypt: vi.fn(), verify: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));
vi.mock("../components/FormTree", () => ({ default: () => null }));
vi.mock("../components/JsonView", () => ({ default: ({ data }: { data: unknown }) => <pre>{JSON.stringify(data)}</pre> }));

const currentIdp = "IDP3003668";
const senderIdp = "IDP3003669";
const processId = "22222222-2222-4222-8222-222222222222";

function makeMessage(id: string, fromIdp = senderIdp) {
  const rawEvent = {
    id,
    type: "ch.ecohub.saf.data",
    source: "https://sender.example",
    time: "2026-09-26T00:00:00.000Z",
    eventReceiver: { category: "insurer", id: currentIdp },
    eventSender: { category: "broker", id: fromIdp },
    processId,
    processGroupId: "33333333-3333-4333-8333-333333333333",
    processName: "invoice",
    processVersion: "5.3.0",
    processStatus: "active",
    subProcessName: "offer",
    subProcessStatus: "InProgress",
    data: { payload: "ciphertext", encryptionKey: "wrapped-key", payloadSignature: "signature" },
  };
  return {
    id,
    topic: "eh.saf.out.v1",
    partition: 0,
    offset: 1,
    kafkaTimestampMs: Date.parse(rawEvent.time),
    receivedAt: rawEvent.time,
    toIdp: currentIdp,
    fromIdp,
    processName: rawEvent.processName,
    subject: `Event ${id}`,
    envelope: {
      payload: rawEvent.data.payload,
      encryptionKey: rawEvent.data.encryptionKey,
      payloadSignature: rawEvent.data.payloadSignature,
      publicKeyVersion: "1",
      signatureKeyVersion: "1",
    },
    rawEvent,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function renderInbox() {
  return render(<Inbox />);
}

describe("Inbox acknowledgement", () => {
  beforeEach(() => {
    mocks.messages = [makeMessage("11111111-1111-4111-8111-111111111111")];
    mocks.inboxFor.mockImplementation(() => mocks.messages.map((message) => ({ ...message })));
    mocks.markAcknowledged.mockImplementation((id: string, at: string, ackId: string) => {
      const message = mocks.messages.find((item) => item.id === id);
      if (!message || message.acknowledgedAt) return false;
      message.acknowledgedAt = at;
      message.acknowledgementEventId = ackId;
      return true;
    });
    mocks.useApp.mockReturnValue({
      active: {
        id: "profile-1",
        name: "Current profile",
        membershipType: "insurer",
        credentials: { environment: "IAT", idp: currentIdp, license: "license-123", password: "secret" },
        techUser: { techUserCert: "certificate" },
        encKeys: [],
      },
      toast: vi.fn(),
      configured: true,
      sessionInboxIds: new Set<string>(),
      markReceivedThisSession: vi.fn(),
      bumpBus: vi.fn(),
    });
    mocks.kafkaStartConsumer.mockResolvedValue(undefined);
    mocks.kafkaStopConsumer.mockResolvedValue(undefined);
    mocks.fetchMemberKeys.mockResolvedValue({ data: [] });
    mocks.schemaRegistryGetIds.mockResolvedValue({ valueSchemaId: 100060, keySchemaId: 100021 });
    mocks.produceViaKafka.mockResolvedValue({ ok: true, detail: "produced" });
  });

  it("sends a payload-less acknowledgement to the original sender and logs only successful sends", async () => {
    const app = mocks.useApp();
    const view = renderInbox();
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));

    await waitFor(() => expect(mocks.produceViaKafka).toHaveBeenCalledTimes(1));
    const request = mocks.produceViaKafka.mock.calls[0][0];
    const ack = JSON.parse(request.eventJson);
    expect(request.processId).toBe(processId);
    expect(ack.type).toBe("ch.ecohub.saf.data");
    expect(ack.eventSender).toEqual({ category: "insurer", id: currentIdp });
    expect(ack.eventReceiver).toEqual({ category: "broker", id: senderIdp });
    expect(ack.processId).toBe(processId);
    expect(ack.subProcessStatus).toBe("Received");
    expect(ack).not.toHaveProperty("data");
    expect(mocks.markAcknowledged).toHaveBeenCalledWith(mocks.messages[0].id, expect.any(String), ack.id);
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({
      id: `ack-${ack.id}`,
      fromProfileId: "profile-1",
      toIdp: senderIdp,
      rawEvent: ack,
      status: "sent",
    }));
    expect(app.bumpBus).toHaveBeenCalledOnce();
    await screen.findByRole("button", { name: "Acknowledged" });

    view.unmount();
    renderInbox();
    const persistedAckButton = screen.getByRole("button", { name: "Acknowledged" }) as HTMLButtonElement;
    expect(persistedAckButton.disabled).toBe(true);
    expect(mocks.produceViaKafka).toHaveBeenCalledOnce();
  });

  it("prevents double-click duplicates while the Kafka request is pending", async () => {
    const pending = deferred<{ ok: boolean; detail: string }>();
    mocks.produceViaKafka.mockReturnValueOnce(pending.promise);
    renderInbox();
    const button = screen.getByRole("button", { name: "Acknowledge" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(mocks.produceViaKafka).toHaveBeenCalledTimes(1));
    await act(async () => { pending.resolve({ ok: true, detail: "produced" }); await pending.promise; });
    expect(mocks.markAcknowledged).toHaveBeenCalledTimes(1);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
  });

  it("keeps the item unacknowledged after failure and permits an explicit retry", async () => {
    mocks.produceViaKafka
      .mockResolvedValueOnce({ ok: false, detail: "broker rejected" })
      .mockResolvedValueOnce({ ok: true, detail: "produced" });
    renderInbox();
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    await screen.findByText(/Acknowledgement failed: broker rejected/);
    expect(mocks.markAcknowledged).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    await screen.findByRole("button", { name: "Acknowledged" });
    expect(mocks.produceViaKafka).toHaveBeenCalledTimes(2);
    expect(mocks.markAcknowledged).toHaveBeenCalledOnce();
    expect(mocks.publish).toHaveBeenCalledOnce();
  });

  it("keeps an in-flight send tied to its selected-message snapshot", async () => {
    const first = makeMessage("11111111-1111-4111-8111-111111111111");
    const second = makeMessage("55555555-5555-4555-8555-555555555555", "IDP3003670");
    mocks.messages = [first, second];
    const pending = deferred<{ ok: boolean; detail: string }>();
    mocks.produceViaKafka.mockReturnValueOnce(pending.promise);
    const { container } = renderInbox();
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    const rows = container.querySelectorAll(".list .row");
    fireEvent.click(rows[1]);
    await act(async () => { pending.resolve({ ok: true, detail: "produced" }); await pending.promise; });

    expect(JSON.parse(mocks.produceViaKafka.mock.calls[0][0].eventJson).eventReceiver.id).toBe(senderIdp);
    expect(mocks.markAcknowledged).toHaveBeenCalledWith(first.id, expect.any(String), expect.any(String));
    expect(mocks.markAcknowledged).not.toHaveBeenCalledWith(second.id, expect.any(String), expect.any(String));
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ toIdp: senderIdp }));
    expect(screen.getByRole("button", { name: "Acknowledge" })).toBeTruthy();
    expect(screen.queryByText("Acknowledged")).toBeNull();
  });

  it("does not offer acknowledgement for payload-less or status/error events", () => {
    mocks.messages = [makeMessage("11111111-1111-4111-8111-111111111111")];
    mocks.messages[0] = { ...mocks.messages[0], rawEvent: { ...mocks.messages[0].rawEvent, type: "ch.ecohub.saf.error", data: {} } };
    renderInbox();
    expect((screen.getByRole("button", { name: "Acknowledge" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.produceViaKafka).not.toHaveBeenCalled();
  });
});

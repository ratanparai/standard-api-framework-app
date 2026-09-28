import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SendEvent from "./SendEvent";

const mocks = vi.hoisted(() => ({
  useApp: vi.fn(),
  fetchReceivers: vi.fn(),
  fetchMemberKeys: vi.fn(),
  pickEncryptionKey: vi.fn(),
  encryptAndSign: vi.fn(),
  validateAgainstSchema: vi.fn(),
  loadLegacyForm: vi.fn(),
}));

vi.mock("../store", () => ({ useApp: mocks.useApp }));
vi.mock("../lib/ecohub", () => ({
  fetchReceivers: mocks.fetchReceivers,
  fetchMemberKeys: mocks.fetchMemberKeys,
  pickEncryptionKey: mocks.pickEncryptionKey,
  produceEvent: vi.fn(),
  produceViaKafka: vi.fn(),
  schemaRegistryGetIds: vi.fn(),
  toCategoryEnum: (value: string) => value.toLowerCase(),
}));
vi.mock("../lib/crypto", () => ({ encryptAndSign: mocks.encryptAndSign }));
vi.mock("../lib/schema/ajv", () => ({ validateAgainstSchema: mocks.validateAgainstSchema }));
vi.mock("../lib/schema/xsdParser", () => ({ loadLegacyForm: mocks.loadLegacyForm }));
vi.mock("../lib/bus", () => ({ publish: vi.fn() }));
vi.mock("../components/FormTree", () => ({ default: () => null }));
vi.mock("../components/DetailModal", () => ({ default: () => null }));

const encryptedData = {
  payload: "opaque-ciphertext",
  encryptionKey: "wrapped-aes-key",
  payloadSignature: "signature-over-payload",
  publicKeyVersion: "1",
  signatureKeyVersion: "1",
};

const supportedProcesses = [
  { processName: "offer.nlpi", processVersion: "1.0.0" },
  { processName: "invoice", processVersion: "5.2.0" },
  { processName: "invoice", processVersion: "5.3.0" },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function renderAndLoadReceiver() {
  render(<SendEvent />);
  await waitFor(() => expect((screen.getByRole("combobox", { name: "Target receiver" }) as HTMLSelectElement).disabled).toBe(false));
}

function chooseGeneric() {
  fireEvent.change(screen.getByRole("combobox", { name: "Event type" }), { target: { value: "generic" } });
}

function enterGenericData() {
  fireEvent.change(screen.getByRole("textbox", { name: "Event data" }), { target: { value: "{\"message\":\"hello\"}" } });
}

function upload(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

async function encrypt() {
  fireEvent.click(screen.getByRole("button", { name: /Encrypt/ }));
  return await screen.findByRole("textbox", { name: "SAF event envelope" });
}

describe("SendEvent Generic business domain and process version", () => {
  beforeEach(() => {
    mocks.useApp.mockReturnValue({
      active: {
        id: "profile-1",
        name: "Test sender",
        membershipType: "insurer",
        credentials: { environment: "IAT", idp: "sender-idp", license: "license", password: "password" },
        techUser: { techUserCert: "certificate" },
        sigKeys: [{ active: true, privatePem: "signer-private", publicPem: "signer-public", version: "1" }],
      },
      configured: true,
      setView: vi.fn(),
      toast: vi.fn(),
      bumpBus: vi.fn(),
    });
    mocks.fetchReceivers.mockResolvedValue({
      result: { status: 200, ok: true, body: "[]" },
      data: [{ idp: ["receiver-idp"], companyName: "Receiver", memberType: "Insurer", supportedProcesses }],
      url: "https://example.test/receivers",
      method: "POST",
      requestBody: "{}",
    });
    mocks.fetchMemberKeys.mockResolvedValue({
      result: { status: 200, ok: true, body: "[]" },
      data: [{ keyType: "encryption", keyId: "key-1", version: "1", key: "receiver-public", ecoHubStatus: "Activated" }],
      url: "https://example.test/keys",
      method: "GET",
    });
    mocks.pickEncryptionKey.mockReturnValue({ key: "receiver-public", version: "1" });
    mocks.encryptAndSign.mockResolvedValue(encryptedData);
    mocks.validateAgainstSchema.mockResolvedValue({ valid: false, errors: ["mock schema issue"] });
    mocks.loadLegacyForm.mockResolvedValue({ schema: {}, sample: { invoice: "sample" } });
  });

  it("defaults to Insurance, writes either domain at the root, and clears preview and validation on a domain change", async () => {
    await renderAndLoadReceiver();
    chooseGeneric();

    const domain = screen.getByRole("combobox", { name: "Business domain" });
    expect((domain as HTMLSelectElement).value).toBe("insurance");
    enterGenericData();
    let envelopeInput = await encrypt();
    await screen.findByText("mock schema issue");
    let envelope = JSON.parse((envelopeInput as HTMLTextAreaElement).value);
    expect(envelope.businessDomain).toBe("insurance");
    expect(envelope.processVersion).toBe("1.0.0");
    const processId = envelope.processId;
    expect(envelope.data).toEqual(encryptedData);
    expect(envelope.data).not.toHaveProperty("businessDomain");

    fireEvent.change(domain, { target: { value: "occupationalPension" } });
    expect(screen.getByText("Not built yet")).toBeTruthy();
    expect(screen.queryByText("mock schema issue")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "SAF event envelope" })).toBeNull();

    envelopeInput = await encrypt();
    envelope = JSON.parse((envelopeInput as HTMLTextAreaElement).value);
    expect(envelope.businessDomain).toBe("occupationalPension");
    expect(envelope.processId).toBe(processId);
    expect(envelope.data).toEqual(encryptedData);
  });

  it("keeps the process ID stable across re-encryption, and starts a new process only on request", async () => {
    await renderAndLoadReceiver();
    chooseGeneric();
    enterGenericData();
    let envelopeInput = await encrypt();
    const originalId = JSON.parse((envelopeInput as HTMLTextAreaElement).value).processId;

    fireEvent.change(screen.getByRole("combobox", { name: "Business domain" }), { target: { value: "occupationalPension" } });
    envelopeInput = await encrypt();
    expect(JSON.parse((envelopeInput as HTMLTextAreaElement).value).processId).toBe(originalId);

    fireEvent.click(screen.getByRole("button", { name: "New process" }));
    envelopeInput = await encrypt();
    const nextId = JSON.parse((envelopeInput as HTMLTextAreaElement).value).processId;
    expect(nextId).not.toBe(originalId);
    const cleartext = mocks.encryptAndSign.mock.calls[mocks.encryptAndSign.mock.calls.length - 1]?.[0].cleartext;
    expect(JSON.parse(String(cleartext)).processIdentificationNo).toBe(nextId);
  });

  it("synchronizes Generic typed JSON before encryption, including JSON entered while Data was selected", async () => {
    await renderAndLoadReceiver();
    const dataInput = screen.getByRole("textbox", { name: "Event data" });
    fireEvent.change(dataInput, { target: { value: "{\"businessValue\":\"entered under Data\"}" } });
    chooseGeneric();

    const envelopeInput = await encrypt();
    const envelope = JSON.parse((envelopeInput as HTMLTextAreaElement).value);
    const encryptedPlaintext = JSON.parse(String(mocks.encryptAndSign.mock.calls[mocks.encryptAndSign.mock.calls.length - 1]?.[0].cleartext));
    expect(encryptedPlaintext.businessValue).toBe("entered under Data");
    expect(encryptedPlaintext.processIdentificationNo).toBe(envelope.processId);
    expect((screen.getByRole("textbox", { name: "Event data" }) as HTMLTextAreaElement).value).toContain(envelope.processId);
  });

  it("synchronizes uploaded JSON bytes but leaves non-object binary bytes unchanged", async () => {
    await renderAndLoadReceiver();
    chooseGeneric();
    const app = mocks.useApp();
    const jsonFile = new File(["{\"uploaded\":true}"], "payload.json", { type: "application/json" });
    upload(jsonFile);
    await waitFor(() => expect(app.toast).toHaveBeenCalledWith(expect.stringContaining("loaded as JSON")));
    const jsonEnvelope = await encrypt();
    const jsonEvent = JSON.parse((jsonEnvelope as HTMLTextAreaElement).value);
    const encryptedJson = JSON.parse(String(mocks.encryptAndSign.mock.calls[mocks.encryptAndSign.mock.calls.length - 1]?.[0].cleartext));
    expect(encryptedJson.uploaded).toBe(true);
    expect(encryptedJson.processIdentificationNo).toBe(jsonEvent.processId);

    fireEvent.click(screen.getByRole("button", { name: "New process" }));
    const binary = new Uint8Array([0, 1, 255, 13, 10]);
    const binaryFile = new File([binary], "payload.bin", { type: "application/octet-stream" });
    upload(binaryFile);
    await waitFor(() => expect(app.toast).toHaveBeenCalledWith(expect.stringContaining("binary/non-object bytes preserved")));
    await waitFor(() => expect((screen.getByRole("button", { name: /Encrypt/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: /Encrypt/ }));
    await waitFor(() => expect(mocks.encryptAndSign).toHaveBeenCalledTimes(2));
    expect(mocks.encryptAndSign.mock.calls[mocks.encryptAndSign.mock.calls.length - 1]?.[0].cleartext).toEqual(binary);
  });

  it("drops an older successful encryption after a selection changes while it is pending", async () => {
    const pending = deferred<typeof encryptedData>();
    mocks.encryptAndSign.mockReturnValueOnce(pending.promise);
    await renderAndLoadReceiver();
    chooseGeneric();
    enterGenericData();

    fireEvent.click(screen.getByRole("button", { name: /Encrypt/ }));
    await waitFor(() => expect(mocks.encryptAndSign).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole("combobox", { name: "Business domain" }), { target: { value: "occupationalPension" } });
    expect(screen.getByText("Not built yet")).toBeTruthy();

    await act(async () => { pending.resolve(encryptedData); await pending.promise; });
    expect(screen.queryByRole("textbox", { name: "SAF event envelope" })).toBeNull();
    expect(screen.queryByText("mock schema issue")).toBeNull();
    expect(screen.getByText("Selection changed — encrypt to rebuild the event.")).toBeTruthy();
  });

  it("drops an older encryption error after a selection changes while receiver keys are pending", async () => {
    const pending = deferred<Awaited<ReturnType<typeof mocks.fetchMemberKeys>>>();
    mocks.fetchMemberKeys.mockReturnValueOnce(pending.promise);
    await renderAndLoadReceiver();
    chooseGeneric();
    enterGenericData();

    fireEvent.click(screen.getByRole("button", { name: /Encrypt/ }));
    await waitFor(() => expect(mocks.fetchMemberKeys).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole("combobox", { name: "Sub-process" }), { target: { value: "review" } });
    await act(async () => { pending.reject(new Error("obsolete key lookup failed")); await pending.promise.catch(() => undefined); });

    expect(screen.getByText("Selection changed — encrypt to rebuild the event.")).toBeTruthy();
    expect(screen.queryByText("✗ obsolete key lookup failed")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "SAF event envelope" })).toBeNull();
  });

  it("keeps Data receiver version choices but resolves a same-name Generic process to 1.0.0", async () => {
    await renderAndLoadReceiver();

    chooseGeneric();
    fireEvent.change(screen.getByRole("combobox", { name: "Generic process" }), { target: { value: "invoice" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Event type" }), { target: { value: "data" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Standard process" }), { target: { value: "invoice" } });

    const versionPicker = await screen.findByRole("combobox", { name: "Process version" });
    expect(Array.from((versionPicker as HTMLSelectElement).options).map((option) => option.value)).toEqual(["5.2.0", "5.3.0"]);
    fireEvent.change(versionPicker, { target: { value: "5.3.0" } });
    expect((versionPicker as HTMLSelectElement).value).toBe("5.3.0");

    chooseGeneric();
    expect((screen.getByRole("combobox", { name: "Generic process" }) as HTMLSelectElement).value).toBe("invoice");
    expect(screen.queryByRole("combobox", { name: "Process version" })).toBeNull();
    expect(screen.getByText("processVersion 1.0.0")).toBeTruthy();
  });
});

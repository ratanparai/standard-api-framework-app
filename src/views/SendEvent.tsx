import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Lock, ArrowRight, Send, Copy, Check, FileText, AlertTriangle, RefreshCw, Loader2, Upload } from "lucide-react";
import { PROCESSES, ALL_PROCESS_NAMES, isProcessName, LEGACY_XSD_NAMESPACE, legacyXsdBase, resolveLegacyXsd, type ProcessName } from "../data/standards";
import { EVENT_TYPES, ALL_EVENT_KINDS, GENERIC_PROCESS_SUGGESTIONS, GENERIC_SUBPROCESS_STAGES, SUBPROCESS_NAMES, KEY_PROCESS_NAME_OVERRIDES, DEFAULT_PROCESS_NAME_NO_SELECTOR, BUSINESS_DOMAINS, type BusinessDomain, type EventKind } from "../data/eventTypes";
import { useApp } from "../store";
import FormTree from "../components/FormTree";
import DetailModal, { type Detail } from "../components/DetailModal";
import { deepClone, setPath, toJSON, toXML, copyText, fileToBase64, fileToBytes } from "../lib/format";
import * as crypto from "../lib/crypto";
import { fetchReceivers, fetchMemberKeys, pickEncryptionKey, produceEvent, produceViaKafka, schemaRegistryGetIds, toCategoryEnum, type Receiver } from "../lib/ecohub";
import { publish } from "../lib/bus";
import type { FieldSchema } from "../lib/formSchema";
import { loadLegacyForm } from "../lib/schema/xsdParser";
import { buildEnvelopeSkeleton, envelopeSchemaUrl } from "../lib/schema/envelope";
import { validateAgainstSchema } from "../lib/schema/ajv";
import { resolveProcessVersion } from "../lib/processVersion";
import { isGenericPayloadObject, synchronizeGenericProcessIdentificationNo } from "../lib/processIdentification";

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export default function SendEvent() {
  const { active, configured, setView, toast, bumpBus } = useApp();
  const pfx = active.techUser?.techUserCert;
  const senderSig = active.sigKeys.find((k) => k.active);

  const [receivers, setReceivers] = useState<Receiver[]>([]);
  const [recvLoading, setRecvLoading] = useState(false);
  const [recvIdx, setRecvIdx] = useState(0);
  const [eventKind, setEventKind] = useState<EventKind>("data");
  const [processId, setProcessId] = useState(() => globalThis.crypto.randomUUID());
  const [proc, setProc] = useState<ProcessName>("offer.nlpi");
  const [genericProcessName, setGenericProcessName] = useState(GENERIC_PROCESS_SUGGESTIONS[0]);
  const [businessDomain, setBusinessDomain] = useState<BusinessDomain>("insurance");
  const [nonDataProc, setNonDataProc] = useState<string>(DEFAULT_PROCESS_NAME_NO_SELECTOR);
  const [subProcess, setSubProcess] = useState(PROCESSES["offer.nlpi"].subProcessName);

  // --- Legacy XSD form state (invoice/commission/contract/mandate/claimsExperience) ---
  const [mode, setMode] = useState<"form" | "raw">("form");
  const [values, setValues] = useState<any>(deepClone(PROCESSES["offer.nlpi"].sample));
  const [legacySchema, setLegacySchema] = useState<FieldSchema | null>(null);
  const [legacyLoading, setLegacyLoading] = useState(false);
  const [legacyError, setLegacyError] = useState<string | null>(null);
  const [rawXml, setRawXml] = useState("");

  // --- Free-text "data" (offer.nlpi / generic / ids / inquiry / error — no XML schema) ---
  const [dataText, setDataText] = useState("");
  // Raw bytes of the last uploaded file — encrypted as-is instead of re-encoding the
  // base64 shown in the textarea. Cleared whenever the user hand-edits that text.
  const [uploadedFileBytes, setUploadedFileBytes] = useState<Uint8Array | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const operationGeneration = useRef(0);
  const processIdRef = useRef(processId);
  processIdRef.current = processId;

  const [event, setEvent] = useState<any | null>(null);
  const [envelopeText, setEnvelopeText] = useState("");
  const [encrypting, setEncrypting] = useState(false);
  const [sending, setSending] = useState<null | "kafka" | "rest">(null);
  const [status, setStatus] = useState("Encrypt, then send.");
  const [detail, setDetail] = useState<Detail>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  const receiver = receivers[recvIdx];
  const procOptions: ProcessName[] = useMemo(() => {
    const sp = receiver?.supportedProcesses?.map((p) => p.processName).filter(isProcessName) as ProcessName[] | undefined;
    return sp && sp.length ? Array.from(new Set(sp)) : ALL_PROCESS_NAMES;
  }, [receiver]);

  // The process/type identifier currently selected, whichever event kind we're in —
  // used to look up how many versions the receiver has on file for it.
  const currentProcessId: string = eventKind === "data" ? proc : eventKind === "generic" ? genericProcessName : nonDataProc;

  const [versionOverride, setVersionOverride] = useState<string | null>(null);
  useEffect(() => { setVersionOverride(null); }, [eventKind, currentProcessId, receiver]);
  const versionSelection = useMemo(() => resolveProcessVersion(
    eventKind,
    currentProcessId,
    receiver?.supportedProcesses ?? [],
    isProcessName(currentProcessId) ? PROCESSES[currentProcessId].defaultVersion : "1.0.0",
    versionOverride,
  ), [eventKind, currentProcessId, receiver, versionOverride]);
  const availableVersions = versionSelection.availableVersions;
  const processVersion = versionSelection.processVersion;

  function invalidateGeneratedEvent() {
    operationGeneration.current += 1;
    setEncrypting(false);
    setEvent(null);
    setEnvelopeText("");
    setValidationErrors([]);
    setStatus("Selection changed — encrypt to rebuild the event.");
  }

  function startNewProcess() {
    const nextProcessId = globalThis.crypto.randomUUID();
    processIdRef.current = nextProcessId;
    invalidateGeneratedEvent();
    setProcessId(nextProcessId);
    if (eventKind === "generic") {
      setDataText((text) => synchronizeGenericProcessIdentificationNo(text, nextProcessId).text);
    }
  }

  // Depends on processVersion, not just proc — this is what makes the version
  // dropdown actually change which XSD tag/file gets loaded.
  const legacyDef = eventKind === "data" ? resolveLegacyXsd(proc, processVersion) : undefined;

  // Version dropdown when the receiver lists more than one version for the current
  // selection, otherwise the same read-only tag as before — defined once, used beside
  // every process/type selector below.
  const versionPicker = availableVersions.length > 1 ? (
    <div className="selectw" style={{ width: 110 }}>
      <select aria-label="Process version" value={processVersion} onChange={(e) => { invalidateGeneratedEvent(); setVersionOverride(e.target.value); }}>
        {availableVersions.map((v) => <option key={v} value={v}>{v}</option>)}
      </select>
    </div>
  ) : (
    <span className="std-tag">processVersion {processVersion}</span>
  );

  useEffect(() => { if (eventKind === "data" && !procOptions.includes(proc)) changeProc(procOptions[0]); }, [procOptions, eventKind]);

  // Load the XSD-derived form for legacy processes; everything else uses the free-text data pane.
  useEffect(() => {
    setEvent(null);
    setEnvelopeText("");
    setValidationErrors([]);
    if (!legacyDef) { setLegacySchema(null); setLegacyError(null); return; }
    let cancelled = false;
    setLegacyLoading(true);
    setLegacyError(null);
    loadLegacyForm(legacyDef, processVersion)
      .then(({ schema, sample }) => {
        if (cancelled) return;
        setLegacySchema(schema);
        setValues(sample);
        setMode("form");
      })
      .catch((e) => {
        if (cancelled) return;
        setLegacySchema(null);
        setLegacyError(`Couldn't load the live XSD schema (${String((e as Error).message)}) — falling back to the built-in sample.`);
        setValues(deepClone(PROCESSES[proc].sample));
      })
      .finally(() => { if (!cancelled) setLegacyLoading(false); });
    return () => { cancelled = true; };
  }, [legacyDef?.tag, eventKind]);

  // Keep the raw-XML view in sync with form edits (but not vice versa while the user is typing in raw mode).
  useEffect(() => {
    if (legacyDef) setRawXml(toXML(legacyDef.rootElementName, LEGACY_XSD_NAMESPACE, values));
  }, [values, legacyDef?.tag]);

  // Seed the free-text data pane from whatever sample exists for the selected process/kind.
  useEffect(() => {
    if (legacyDef) return;
    if (eventKind === "data") {
      setDataText(toJSON(PROCESSES[proc].sample));
      setUploadedFileBytes(null);
    }
    setEvent(null);
    setEnvelopeText("");
    setValidationErrors([]);
  }, [eventKind, proc, legacyDef]);

  async function loadReceivers() {
    if (!configured || !pfx) { toast("Connect this profile first"); return; }
    invalidateGeneratedEvent();
    setRecvLoading(true);
    try {
      const { result, data, url, method, requestBody } = await fetchReceivers({ environment: active.credentials.environment, pfxBase64: pfx, password: active.credentials.password, license: active.credentials.license });
      if (result.ok && data) {
        invalidateGeneratedEvent();
        setReceivers(data); setRecvIdx(0);
        toast(`${data.length} receiver${data.length === 1 ? "" : "s"} loaded`);
      } else {
        setDetail({ title: "Load receivers", status: result.status, ok: false, body: result.body, url, method, requestBody });
      }
    } catch (e) {
      setDetail({ title: "Load receivers", status: 0, ok: false, body: String((e as Error).message) });
    }
    setRecvLoading(false);
  }
  useEffect(() => { if (configured && pfx && receivers.length === 0) loadReceivers(); }, []);

  function changeProc(p: ProcessName) {
    invalidateGeneratedEvent();
    setProc(p);
    setSubProcess(PROCESSES[p].subProcessName);
    setValues(deepClone(PROCESSES[p].sample));
  }

  function onField(path: string, val: any) {
    setValues((prev: any) => { const n = deepClone(prev); setPath(n, path, val); return n; });
    invalidateGeneratedEvent();
  }

  async function onUploadFile(f: File | undefined) {
    if (!f) return;
    const uploadProcessId = processIdRef.current;
    const uploadGeneration = operationGeneration.current;
    if (f.size > MAX_UPLOAD_BYTES) {
      toast(`${f.name} is ${(f.size / (1024 * 1024)).toFixed(1)}MB — max upload size is 8MB`);
      return;
    }
    try {
      const [bytes, b64] = await Promise.all([fileToBytes(f), fileToBase64(f)]);
      if (uploadProcessId !== processIdRef.current || uploadGeneration !== operationGeneration.current) return;
      let uploadMessage = `${f.name} → base64 preview; uploaded bytes preserved for encryption.`;
      if (eventKind === "generic") {
        const genericText = synchronizeGenericProcessIdentificationNo(new TextDecoder().decode(bytes), uploadProcessId);
        if (genericText.isObject) {
          setUploadedFileBytes(null);
          setDataText(genericText.text);
          uploadMessage = `${f.name} loaded as JSON; Generic processIdentificationNo synchronized.`;
        } else {
          setUploadedFileBytes(bytes);
          setDataText(b64);
          uploadMessage = `${f.name} → base64 preview; binary/non-object bytes preserved unchanged for encryption.`;
        }
      } else {
        setUploadedFileBytes(bytes);
        setDataText(b64);
      }
      invalidateGeneratedEvent();
      toast(uploadMessage);
    } catch (e) {
      toast(`Could not read ${f.name}: ${String((e as Error).message)}`);
    }
  }

  const cleartext = legacyDef ? rawXml : dataText;
  const genericPlaintext = uploadedFileBytes ? new TextDecoder().decode(uploadedFileBytes) : dataText;
  const genericPayloadIsObject = eventKind === "generic" && isGenericPayloadObject(genericPlaintext);
  const eventTypeDef = EVENT_TYPES[eventKind];

  const blocker = !configured ? "Connect this profile first (Configuration)."
    : !senderSig ? "No active signature key — generate & activate one in Configuration → Keys."
    : !receiver ? "Load receivers and pick one."
    : null;

  async function doEncrypt() {
    if (blocker) { setStatus(blocker); return; }
    const generation = ++operationGeneration.current;
    setEncrypting(true); setStatus("Fetching receiver key & encrypting…");
    try {
      let cleartextForEncryption: string | Uint8Array = uploadedFileBytes ?? cleartext;
      if (eventKind === "generic") {
        const genericText = typeof cleartextForEncryption === "string"
          ? cleartextForEncryption
          : new TextDecoder().decode(cleartextForEncryption);
        const synchronized = synchronizeGenericProcessIdentificationNo(genericText, processIdRef.current);
        if (synchronized.isObject) {
          cleartextForEncryption = synchronized.text;
          setDataText(synchronized.text);
          setUploadedFileBytes(null);
        }
      }
      const idp = receiver.idp[0];
      const km = await fetchMemberKeys({ environment: active.credentials.environment, pfxBase64: pfx!, password: active.credentials.password, idp });
      if (generation !== operationGeneration.current) return;
      if (!km.result.ok || !km.data) {
        setDetail({ title: "Fetch receiver public key", status: km.result.status, ok: false, body: km.result.body, url: km.url, method: km.method });
        setStatus("✗ Could not fetch receiver key.");
        return;
      }
      const processNameForKey =
        eventKind === "data" ? proc
        : KEY_PROCESS_NAME_OVERRIDES[eventKind] ?? eventTypeDef.label; // generic → "generic", ids → "ids"; unconfirmed kinds fall back to the label
      const encKey = pickEncryptionKey(km.data, processNameForKey);
      if (!encKey) {
        setDetail({ title: "Fetch receiver public key", status: km.result.status, ok: true, body: km.result.body, url: km.url, method: km.method });
        setStatus(`✗ ${receiver.companyName} has no activated encryption key for ${processNameForKey}.`);
        return;
      }

      const data = await crypto.encryptAndSign({
        cleartext: cleartextForEncryption,
        recipientEncPublicPem: encKey.key,
        publicKeyVersion: encKey.version,
        signerSigPrivatePem: senderSig!.privatePem,
        signatureKeyVersion: senderSig!.version,
      });
      if (generation !== operationGeneration.current) return;

      const dataschema =
        eventKind === "data"
          ? legacyDef
            ? `${legacyXsdBase(legacyDef, processVersion)}/${legacyDef.xsdFile}`
            : PROCESSES[proc].dataschema?.(processVersion)
          : undefined;

      const processName = eventKind === "data" ? proc : eventKind === "generic" ? genericProcessName : nonDataProc;
      const subProcessName = subProcess;
      const processStatus = eventKind === "data" ? PROCESSES[proc].processStatus : "active";
      const label = eventKind === "data" ? PROCESSES[proc].label : eventTypeDef.label;

      const evt = buildEnvelopeSkeleton({
        eventType: eventTypeDef,
        data,
        dataschema,
        subject: `${label} ${subProcessName}`,
        licenceKey: active.credentials.license,
        userAgent: { name: "SAF Testing Tool", version: "2.1" },
        eventReceiver: { category: toCategoryEnum(receiver.memberType), id: idp },
        eventSender: { category: active.membershipType, id: active.credentials.idp },
        processName,
        processId,
        processVersion,
        ...(eventKind === "generic" ? { businessDomain } : {}),
        processStatus,
        subProcessName,
        subProcessStatus: "Created",
      });
      setEvent(evt);
      setEnvelopeText(toJSON(evt));
      // Envelope validation runs reactively in the debounced effect keyed on
      // envelopeText below, so it re-checks on every manual edit — not only here.
      // Setting the text above triggers that effect, which finalises the status.
      setStatus("Encrypted & signed — validating envelope…");
    } catch (e) {
      if (generation === operationGeneration.current) setStatus("✗ " + String((e as Error).message));
    } finally {
      if (generation === operationGeneration.current) setEncrypting(false);
    }
  }

  function onEnvelopeTextChange(text: string) {
    setEnvelopeText(text);
    try { setEvent(JSON.parse(text)); } catch { /* keep last-valid `event` until it parses again */ }
  }

  // Re-validate the envelope against its schema whenever the (editable) envelope
  // text changes — not just once at encrypt time. Debounced so we don't validate
  // on every keystroke; cancellation guards against stale async results.
  useEffect(() => {
    if (!envelopeText.trim()) { setValidationErrors([]); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      let parsed: any;
      try {
        parsed = JSON.parse(envelopeText);
      } catch (e) {
        if (cancelled) return;
        setValidationErrors([`Invalid JSON: ${String((e as Error).message)}`]);
        setStatus("⚠ Envelope is not valid JSON — fix it before sending.");
        return;
      }
      try {
        const { valid, errors } = await validateAgainstSchema(envelopeSchemaUrl(eventKind, eventTypeDef), parsed);
        if (cancelled) return;
        setValidationErrors(valid ? [] : errors);
        setStatus(valid ? "Envelope valid — ready to send." : `⚠ Envelope has ${errors.length} schema issue(s) — see below.`);
      } catch (e) {
        if (cancelled) return;
        setValidationErrors([]);
        setStatus(`Ready to send (envelope validation unavailable: ${String((e as Error).message)}).`);
      }
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [envelopeText, eventKind, eventTypeDef]);

  function recordOutbox() {
    publish({
      id: "m-" + Date.now(), fromProfileId: active.id, fromName: active.name,
      toName: receiver.companyName, toIdp: receiver.idp[0], topic: "eh.saf.in.v1", standardNs: event.dataschema ?? "",
      subject: event.subject, processId: event.processId, time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      envelope: event.data, rawEvent: event, recipientEncPublicPem: "", signerSigPublicPem: senderSig!.publicPem, signerName: active.name, status: "sent",
    });
    bumpBus();
  }

  async function send(via: "kafka" | "rest") {
    if (!event) return;
    setSending(via);
    setStatus(via === "kafka" ? "Producing via Kafka (eh.saf.in.v1)…" : "Producing via REST proxy (/saf/v1/in)…");
    try {
      setStatus("Resolving schema IDs from registry…");
      let valueSchemaId: number | undefined;
      let keySchemaId: number | undefined;
      try {
        const ids = await schemaRegistryGetIds({
          environment: active.credentials.environment,
          pfxBase64: pfx!,
          password: active.credentials.password,
          topic: "eh.saf.in.v1",
        });
        valueSchemaId = ids.valueSchemaId;
        keySchemaId = ids.keySchemaId;
      } catch {
        // registry unreachable — both transports fall back to hardcoded ids
      }

      if (via === "kafka") {
        const r = await produceViaKafka({
          environment: active.credentials.environment,
          pfxBase64: pfx!,
          password: active.credentials.password,
          eventJson: JSON.stringify(event),
          processId: event.processId,
          valueSchemaId,
        });
        setDetail({ title: "Produce via Kafka — eh.saf.in.v1", status: r.ok ? 200 : 0, ok: r.ok, body: r.detail });
        if (r.ok) { recordOutbox(); setStatus(`✓ ${r.detail}`); toast(`Event produced to ${receiver.companyName}`); }
        else setStatus(`✗ Kafka produce failed. See details.`);
      }
      if (via === "rest") {
        const r = await produceEvent({ environment: active.credentials.environment, pfxBase64: pfx!, password: active.credentials.password, eventJson: JSON.stringify(event), valueSchemaId, keySchemaId });
        setDetail({ title: "Produce via REST proxy — POST /saf/v1/in", status: r.status, ok: r.ok, body: r.body || "(empty body)" });
        if (r.ok) { recordOutbox(); setStatus(`✓ HTTP ${r.status} — produced via REST proxy.`); toast(`Event produced to ${receiver.companyName}`); }
        else setStatus(`✗ HTTP ${r.status} — REST produce failed. See details.`);
      }
    } catch (e) {
      setDetail({ title: "Produce event", status: 0, ok: false, body: String((e as Error).message) });
    }
    setSending(null);
  }

  return (
    <div className="view">
      <div className="chead">
        <div><h1>Send event</h1><div className="sub">Compose, encrypt, and produce a standardised SAF event</div></div>
      </div>

      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        <div className="exch-head">
          <div className="sel">
            <span className="fl">Target (receiver)</span>
            <div style={{ display: "flex", gap: 8 }}>
              <div className="selectw" style={{ flex: 1 }}>
                <select aria-label="Target receiver" value={recvIdx} disabled={!receivers.length} onChange={(e) => { invalidateGeneratedEvent(); setRecvIdx(+e.target.value); }}>
                  {receivers.length === 0 ? <option>{configured ? "No receivers loaded" : "Connect first"}</option>
                    : receivers.map((r, i) => <option key={i} value={i}>{r.companyName} ({r.memberType})</option>)}
                </select>
              </div>
              <button className="btn-ghost" disabled={recvLoading || !configured} onClick={loadReceivers} title="Fetch from /saf-receivers">
                {recvLoading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
              </button>
            </div>
            {receiver && <span className="std-tag">{receiver.idp.join(", ")}</span>}
          </div>
          <div className="sel">
            <span className="fl">Event type</span>
            <div className="selectw">
              <select aria-label="Event type" value={eventKind} onChange={(e) => {
                const k = e.target.value as EventKind;
                invalidateGeneratedEvent(); setEventKind(k);
                setSubProcess(k === "data" ? PROCESSES[proc].subProcessName : k === "generic" ? "provide" : k === "ids" ? "initiate" : "request");
              }}>
                {ALL_EVENT_KINDS.map((k) => <option key={k} value={k}>{EVENT_TYPES[k].label}</option>)}
              </select>
            </div>
            <span className="std-tag">{eventTypeDef.ceType}</span>
          </div>
          <div className="sel">
            <span className="fl">Process ID</span>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="std-tag" aria-label="Process ID" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{processId}</span>
              <button className="btn-ghost" disabled={sending !== null} onClick={startNewProcess}>New process</button>
            </div>
          </div>
          {eventKind === "data" && (
            <div className="sel">
              <span className="fl">Process (standard)</span>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <div className="selectw" style={{ flex: 1 }}>
                  <select aria-label="Standard process" value={proc} onChange={(e) => changeProc(e.target.value as ProcessName)}>
                    {procOptions.map((p) => <option key={p} value={p}>{PROCESSES[p].label} ({p})</option>)}
                  </select>
                </div>
                {versionPicker}
              </div>
            </div>
          )}
          {eventKind === "generic" && (
            <div className="sel">
              <span className="fl">Process</span>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <div className="selectw" style={{ flex: 1 }}>
                  <select aria-label="Generic process" value={genericProcessName} onChange={(e) => { invalidateGeneratedEvent(); setGenericProcessName(e.target.value); }}>
                    {GENERIC_PROCESS_SUGGESTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <span className="std-tag">processVersion {processVersion}</span>
              </div>
            </div>
          )}
          {eventKind === "generic" && (
            <div className="sel">
              <span className="fl">Business domain</span>
              <div className="selectw">
                <select aria-label="Business domain" value={businessDomain} onChange={(e) => { invalidateGeneratedEvent(); setBusinessDomain(e.target.value as BusinessDomain); }}>
                  {Object.entries(BUSINESS_DOMAINS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </div>
            </div>
          )}
          {eventKind !== "data" && eventKind !== "generic" && (
            <div className="sel">
              <span className="fl">Process</span>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <div className="selectw" style={{ flex: 1 }}>
                  <select aria-label="Process" value={nonDataProc} onChange={(e) => { invalidateGeneratedEvent(); setNonDataProc(e.target.value); }}>
                    {(eventKind === "error" ? Array.from(new Set([...ALL_PROCESS_NAMES, ...GENERIC_PROCESS_SUGGESTIONS])) : ALL_PROCESS_NAMES)
                      .map((p) => <option key={p} value={p}>{PROCESSES[p as ProcessName]?.label ? `${PROCESSES[p as ProcessName].label} (${p})` : p}</option>)}
                  </select>
                </div>
                {versionPicker}
              </div>
            </div>
          )}
          <div className="sel">
            <span className="fl">Sub-process</span>
            <div className="selectw">
              <select aria-label="Sub-process" value={subProcess} onChange={(e) => { invalidateGeneratedEvent(); setSubProcess(e.target.value); }}>
                {(eventKind === "generic" || eventKind === "ids" ? GENERIC_SUBPROCESS_STAGES : SUBPROCESS_NAMES).map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
        </div>

        {blocker && (
          <div style={{ margin: "0 16px 4px", display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--warn)" }}>
            <AlertTriangle size={14} /> {blocker}
          </div>
        )}
        {legacyError && (
          <div style={{ margin: "0 16px 4px", display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--warn)" }}>
            <AlertTriangle size={14} /> {legacyError}
          </div>
        )}

        <div className="pipeline">
          <div className="pane">
            <div className="pane-head">
              <span className="pane-step">1</span>
              <div className="pane-titles">
                <div className="pane-title">Data</div>
                <div className="pane-sub">Cleartext · {eventKind === "data" ? PROCESSES[proc].label : eventTypeDef.label}{legacyLoading ? " · loading XSD…" : ""}</div>
              </div>
              {legacyDef ? (
                <>
                  <button className="btn-copy" style={{ marginRight: 8 }} onClick={() => { loadLegacyForm(legacyDef, processVersion).then(({ sample }) => setValues(sample)); toast("Sample reloaded"); }}>
                    <FileText size={12} /> Sample
                  </button>
                  <div className="seg">
                    <button className={mode === "form" ? "on" : ""} onClick={() => setMode("form")}>Form</button>
                    <button className={mode === "raw" ? "on" : ""} onClick={() => setMode("raw")}>Raw</button>
                  </div>
                </>
              ) : (
                <>
                  <button className="btn-copy" style={{ marginRight: 8 }} onClick={() => fileInputRef.current?.click()}>
                    <Upload size={12} /> Upload file
                  </button>
                  <input ref={fileInputRef} type="file" style={{ display: "none" }} onChange={(e) => onUploadFile(e.target.files?.[0])} />
                </>
              )}
            </div>
            <div className="pane-body">
              {legacyDef ? (
                mode === "form" ? (
                  <FormTree values={values} schema={legacySchema ?? undefined} onChange={onField} />
                ) : (
                  <div>
                    <div className="raw-bar">
                      <button className="btn-copy" onClick={() => { copyText(rawXml); toast("Copied"); }}><Copy size={12} /> Copy</button>
                    </div>
                    <textarea className="code-edit" spellCheck={false} value={rawXml} onChange={(e) => { setRawXml(e.target.value); invalidateGeneratedEvent(); }} />
                  </div>
                )
              ) : (
                <div>
                  <div className="raw-bar">
                    <button className="btn-copy" onClick={() => { copyText(dataText); toast("Copied"); }}><Copy size={12} /> Copy</button>
                  </div>
                  <textarea
                    aria-label="Event data" className="code-edit" spellCheck={false} value={dataText}
                    placeholder="Free-form data — type it in, or upload a file (binary uploads appear as base64 here)."
                    onChange={(e) => {
                      const text = e.target.value;
                      setDataText(text);
                      setUploadedFileBytes(null);
                      invalidateGeneratedEvent();
                    }}
                    onBlur={(e) => {
                      if (eventKind === "generic") setDataText(synchronizeGenericProcessIdentificationNo(e.target.value, processIdRef.current).text);
                    }}
                  />
                  {eventKind === "generic" && !genericPayloadIsObject && (
                    <div className="unsupported-note">This Generic payload is not a JSON object. It will be encrypted unchanged; only the envelope process ID is generated.</div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="connector">
            <motion.div className={"op-node" + (event ? " done" : "")} animate={encrypting ? { scale: [1, 1.08, 1] } : { scale: 1 }} transition={encrypting ? { repeat: Infinity, duration: 1 } : {}}>
              {event ? <Check size={21} /> : <Lock size={21} strokeWidth={1.8} />}
            </motion.div>
            <button className="op-btn" disabled={encrypting || !!blocker || !cleartext} onClick={doEncrypt}>{encrypting ? "Encrypting…" : "Encrypt"} <ArrowRight size={13} /></button>
            <div className="op-label">RSA-OAEP-256<br />+ A256GCM</div>
          </div>

          <div className="pane">
            <div className="pane-head">
              <span className={"pane-step" + (event ? " done" : "")}>2</span>
              <div className="pane-titles"><div className="pane-title">SAF event</div><div className="pane-sub">CloudEvents envelope to produce — editable</div></div>
              <button className="btn-copy" disabled={!event} onClick={() => { if (event) { copyText(envelopeText); toast("Copied"); } }}><Copy size={12} /> Copy</button>
            </div>
            <div className="pane-body">
              {!event ? (
                <div className="pane-empty">
                  <Lock strokeWidth={1.5} /><div className="t">Not built yet</div>
                  <div className="s">Encrypt to assemble the signed {eventTypeDef.label} envelope that will be produced to the in-topic.</div>
                </div>
              ) : (
                <textarea aria-label="SAF event envelope" className="code-edit" spellCheck={false} value={envelopeText} onChange={(e) => onEnvelopeTextChange(e.target.value)} />
              )}
              {validationErrors.length > 0 && (
                <div className="unsupported-note" style={{ marginTop: 8 }}>
                  Envelope schema issues:
                  <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                    {validationErrors.map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                </div>
              )}
            </div>
            <div className="pane-foot">
              <span className={"st" + (status.startsWith("✓") ? " ok" : status.startsWith("✗") ? " err" : "")}>{status}</span>
              <button className="btn-ghost" disabled={!event || sending !== null} onClick={() => send("kafka")} title="Native Kafka protocol (mTLS to CSM broker)">
                {sending === "kafka" ? <Loader2 size={13} className="spin" style={{ verticalAlign: "-2px" }} /> : null} Send via Kafka
              </button>
              <button className="btn-primary" disabled={!event || sending !== null} onClick={() => send("rest")} title="REST proxy POST /saf/v1/in">
                <Send size={14} /> {sending === "rest" ? "Producing…" : "Send via REST proxy"}
              </button>
            </div>
          </div>
        </div>
      </div>

      <DetailModal detail={detail} onClose={() => setDetail(null)} />
    </div>
  );
}

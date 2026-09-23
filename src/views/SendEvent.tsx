import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Lock, ArrowRight, Send, Copy, Check, FileText, AlertTriangle, RefreshCw, Loader2, Upload } from "lucide-react";
import { PROCESSES, ALL_PROCESS_NAMES, isProcessName, LEGACY_XSD_NAMESPACE, legacyStandardsBase, type ProcessName } from "../data/standards";
import {
  EVENT_TYPES, ALL_EVENT_KINDS, GENERIC_PROCESS_NAMES, GENERIC_SUBPROCESS_NAME, GENERIC_PROCESS_VERSION, BUSINESS_DOMAINS,
  KEY_PROCESS_NAME_OVERRIDES, DEFAULT_PROCESS_NAME_NO_SELECTOR, DEFAULT_SUBPROCESS_NAME_NO_SELECTOR,
  type EventKind, type GenericProcessName, type BusinessDomain,
} from "../data/eventTypes";
import {
  GENERIC_EXCHANGE_SCHEMA_URL, GENERIC_EXCHANGE_SAMPLE_URL, GENERIC_EXCHANGE_AUTO_KEYS, GENERIC_EXCHANGE_FALLBACK_SAMPLE,
  GENERIC_ATTACHMENT_MAX_BYTES, headerBranchFor,
} from "../data/genericExchange";
import { useApp } from "../store";
import FormTree from "../components/FormTree";
import DetailModal, { type Detail } from "../components/DetailModal";
import { deepClone, setPath, toJSON, toXML, copyText, fileToBase64, fileToBytes, isObj } from "../lib/format";
import * as crypto from "../lib/crypto";
import { md5Base64 } from "../lib/md5";
import { fetchReceivers, fetchMemberKeys, pickEncryptionKey, produceEvent, produceViaKafka, schemaRegistryGetIds, toCategoryEnum, type Receiver } from "../lib/ecohub";
import { publish } from "../lib/bus";
import type { FieldSchema } from "../lib/formSchema";
import { loadLegacyForm } from "../lib/schema/xsdParser";
import { buildEnvelopeSkeleton, envelopeSchemaUrl } from "../lib/schema/envelope";
import { validateAgainstSchema } from "../lib/schema/ajv";
import { loadJsonSchemaForm, fromFormValues, toFormValues } from "../lib/schema/jsonSchemaForm";

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export default function SendEvent() {
  const { active, configured, setView, toast, bumpBus } = useApp();
  const pfx = active.techUser?.techUserCert;
  const senderSig = active.sigKeys.find((k) => k.active);

  const [receivers, setReceivers] = useState<Receiver[]>([]);
  const [recvLoading, setRecvLoading] = useState(false);
  const [recvIdx, setRecvIdx] = useState(0);
  const [eventKind, setEventKind] = useState<EventKind>("data");
  const [proc, setProc] = useState<ProcessName>("offer.nlpi");
  const [genericProcessName, setGenericProcessName] = useState<GenericProcessName>("contract");
  const [businessDomain, setBusinessDomain] = useState<BusinessDomain>("insurance");

  // --- Legacy XSD form state (invoice/commission/contract/mandate/claimsExperience) ---
  const legacyDef = eventKind === "data" ? PROCESSES[proc].legacyXsd : undefined;
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

  // --- Generic Exchange payload form (GenericExchange.json v1.0.0, live JSON Schema) ---
  const isGeneric = eventKind === "generic";
  const [genericSchema, setGenericSchema] = useState<FieldSchema | null>(null);
  const [genericValues, setGenericValues] = useState<any>(() => deepClone(GENERIC_EXCHANGE_FALLBACK_SAMPLE));
  const [genericLoading, setGenericLoading] = useState(false);
  const [genericError, setGenericError] = useState<string | null>(null);
  const [genericRaw, setGenericRaw] = useState("");
  const [payloadErrors, setPayloadErrors] = useState<string[]>([]);
  const attachInputRef = useRef<HTMLInputElement>(null);

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
  const processVersion = useMemo(() => {
    const m = receiver?.supportedProcesses?.find((p) => p.processName === proc);
    return m?.processVersion || PROCESSES[proc].defaultVersion;
  }, [receiver, proc]);

  useEffect(() => { if (eventKind === "data" && !procOptions.includes(proc)) changeProc(procOptions[0]); }, [procOptions, eventKind]);

  // Load the XSD-derived form for legacy processes; everything else uses the free-text data pane.
  useEffect(() => {
    setEvent(null);
    setValidationErrors([]);
    if (!legacyDef) { setLegacySchema(null); setLegacyError(null); return; }
    let cancelled = false;
    setLegacyLoading(true);
    setLegacyError(null);
    loadLegacyForm(legacyDef)
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
    if (eventKind === "data") setDataText(toJSON(PROCESSES[proc].sample));
    else setDataText("");
    setUploadedFileBytes(null);
    setEvent(null);
    setValidationErrors([]);
  }, [eventKind, proc, legacyDef]);

  // Load the live GenericExchange schema + sample for the generic kind (built-in sample if unreachable).
  useEffect(() => {
    setPayloadErrors([]);
    if (!isGeneric) return;
    let cancelled = false;
    setGenericLoading(true);
    setGenericError(null);
    loadJsonSchemaForm(GENERIC_EXCHANGE_SCHEMA_URL, GENERIC_EXCHANGE_SAMPLE_URL, { hide: GENERIC_EXCHANGE_AUTO_KEYS })
      .then(({ schema, sample }) => {
        if (cancelled) return;
        setGenericSchema(schema);
        setGenericValues(withSampleFingerprints(sample));
        setMode("form");
      })
      .catch((e) => {
        if (cancelled) return;
        setGenericSchema(null);
        setGenericError(`Couldn't load the live GenericExchange schema (${String((e as Error).message)}) — falling back to the built-in sample.`);
        setGenericValues(deepClone(GENERIC_EXCHANGE_FALLBACK_SAMPLE));
      })
      .finally(() => { if (!cancelled) setGenericLoading(false); });
    return () => { cancelled = true; };
  }, [isGeneric]);

  // Point the payload header's sender/recipient branch at this profile and the chosen receiver.
  useEffect(() => {
    if (isGeneric && genericSchema) setGenericValues((prev: any) => withHeaderParties(prev));
  }, [isGeneric, genericSchema, receiver, active.membershipType]);

  // Keep the raw-JSON view in sync with form edits (not vice versa while typing in raw mode).
  useEffect(() => {
    if (isGeneric && mode === "form") setGenericRaw(toJSON(genericBody()));
  }, [isGeneric, genericValues, genericSchema, mode]);

  function genericBody(): any {
    return fromFormValues(genericValues, genericSchema ?? undefined) ?? {};
  }

  /** Form values with header.sender/recipient's "_choice" selected from the envelope parties (schema-driven values only). */
  function withHeaderParties(values: any): any {
    const v = deepClone(values);
    const setBranch = (side: "sender" | "recipient", branch: string, companyName?: string) => {
      const choice = v?.header?.[side]?._choice;
      if (!isObj(choice)) return;
      choice["@selected"] = branch;
      if (companyName) choice[branch] = { ...(isObj(choice[branch]) ? choice[branch] : {}), companyName };
    };
    setBranch("sender", headerBranchFor(active.membershipType));
    if (receiver) setBranch("recipient", headerBranchFor(toCategoryEnum(receiver.memberType)), receiver.companyName);
    return v;
  }

  /** The upstream test file's fingerprint doesn't match its data — recompute so the sample is self-consistent. */
  function withSampleFingerprints(values: any): any {
    const v = deepClone(values);
    for (const a of Array.isArray(v?.attachments) ? v.attachments : []) {
      if (typeof a?.file?.data === "string" && a.file.data) {
        try { a.file.fingerprint = md5Base64(crypto.b64decode(a.file.data)); } catch { /* leave as-is */ }
      }
    }
    return v;
  }

  function onGenericField(path: string, val: any) {
    setGenericValues((prev: any) => { const n = deepClone(prev); setPath(n, path, val); return n; });
    setEvent(null);
  }

  function reloadGenericSample() {
    loadJsonSchemaForm(GENERIC_EXCHANGE_SCHEMA_URL, GENERIC_EXCHANGE_SAMPLE_URL, { hide: GENERIC_EXCHANGE_AUTO_KEYS })
      .then(({ schema, sample }) => { setGenericSchema(schema); setGenericValues(withHeaderParties(withSampleFingerprints(sample))); })
      .catch(() => setGenericValues(deepClone(GENERIC_EXCHANGE_FALLBACK_SAMPLE)));
    setMode("form");
    setEvent(null);
    toast("Sample reloaded");
  }

  function setGenericMode(next: "form" | "raw") {
    if (next === mode) return;
    if (next === "form") {
      try {
        setGenericValues(toFormValues(JSON.parse(genericRaw), genericSchema ?? undefined));
      } catch (e) {
        toast(`Raw payload isn't valid JSON: ${String((e as Error).message)}`);
        return;
      }
    }
    setMode(next);
  }

  async function onAddAttachment(f: File | undefined) {
    if (!f) return;
    const max = Math.min(MAX_UPLOAD_BYTES, GENERIC_ATTACHMENT_MAX_BYTES);
    if (f.size > max) {
      toast(`${f.name} is ${(f.size / (1024 * 1024)).toFixed(1)}MB — max attachment size is ${(max / (1024 * 1024)).toFixed(1)}MB`);
      return;
    }
    try {
      const [bytes, b64] = await Promise.all([fileToBytes(f), fileToBase64(f)]);
      const att = { documentType: "other", file: { filename: f.name, data: b64, fingerprint: md5Base64(bytes) } };
      if (mode === "raw") {
        const body = JSON.parse(genericRaw || "{}");
        body.attachments = [...(Array.isArray(body.attachments) ? body.attachments : []), att];
        setGenericRaw(toJSON(body));
      } else {
        setGenericValues((prev: any) => {
          const n = deepClone(prev);
          n.attachments = [...(Array.isArray(n.attachments) ? n.attachments : []), att];
          return n;
        });
      }
      setEvent(null);
      toast(`${f.name} added as an attachment — set its document type`);
    } catch (e) {
      toast(`Could not add ${f.name}: ${String((e as Error).message)}`);
    }
  }

  async function loadReceivers() {
    if (!configured || !pfx) { toast("Connect this profile first"); return; }
    setRecvLoading(true);
    try {
      const { result, data, url, method, requestBody } = await fetchReceivers({ environment: active.credentials.environment, pfxBase64: pfx, password: active.credentials.password, license: active.credentials.license });
      if (result.ok && data) {
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
    setProc(p);
    setValues(deepClone(PROCESSES[p].sample));
  }

  function onField(path: string, val: any) {
    setValues((prev: any) => { const n = deepClone(prev); setPath(n, path, val); return n; });
    setEvent(null);
  }

  async function onUploadFile(f: File | undefined) {
    if (!f) return;
    if (f.size > MAX_UPLOAD_BYTES) {
      toast(`${f.name} is ${(f.size / (1024 * 1024)).toFixed(1)}MB — max upload size is 8MB`);
      return;
    }
    try {
      const [bytes, b64] = await Promise.all([fileToBytes(f), fileToBase64(f)]);
      setUploadedFileBytes(bytes);
      setDataText(b64);
      setEvent(null);
      toast(`${f.name} → base64, filled into "data"`);
    } catch (e) {
      toast(`Could not read ${f.name}: ${String((e as Error).message)}`);
    }
  }

  const cleartext = legacyDef ? rawXml : dataText;
  const eventTypeDef = EVENT_TYPES[eventKind];

  const blocker = !configured ? "Connect this profile first (Configuration)."
    : !senderSig ? "No active signature key — generate & activate one in Configuration → Keys."
    : !receiver ? "Load receivers and pick one."
    : null;

  async function doEncrypt() {
    if (blocker) { setStatus(blocker); return; }
    setEncrypting(true); setStatus("Fetching receiver key & encrypting…");
    setPayloadErrors([]);
    try {
      // Generic Exchange: build the GenericExchange payload up front — its
      // processIdentificationNo/processName must equal the envelope's processId/processName.
      let genericPayload: any = null;
      let processId: string | undefined;
      let payloadIssues = 0;
      if (isGeneric) {
        let body: any;
        if (mode === "raw") {
          try { body = JSON.parse(genericRaw); } catch (e) {
            setStatus(`✗ Raw payload isn't valid JSON: ${String((e as Error).message)}`);
            setEncrypting(false);
            return;
          }
        } else body = genericBody();
        processId = globalThis.crypto.randomUUID();
        const rest = Object.fromEntries(Object.entries(isObj(body) ? body : {}).filter(([k]) => !GENERIC_EXCHANGE_AUTO_KEYS.includes(k)));
        genericPayload = {
          processIdentificationNo: processId,
          timestamp: new Date().toISOString(),
          processName: genericProcessName,
          processVersion: GENERIC_PROCESS_VERSION,
          ...rest,
        };
        for (const a of Array.isArray(genericPayload.attachments) ? genericPayload.attachments : []) {
          if (a?.file && !a.file.fingerprint && typeof a.file.data === "string") {
            try { a.file.fingerprint = md5Base64(crypto.b64decode(a.file.data)); } catch { /* schema validation will flag it */ }
          }
        }
        try {
          const { valid, errors } = await validateAgainstSchema(GENERIC_EXCHANGE_SCHEMA_URL, genericPayload);
          setPayloadErrors(valid ? [] : errors);
          payloadIssues = valid ? 0 : errors.length;
        } catch { /* payload validation unavailable offline — encrypt anyway */ }
      }

      const idp = receiver.idp[0];
      const km = await fetchMemberKeys({ environment: active.credentials.environment, pfxBase64: pfx!, password: active.credentials.password, idp });
      if (!km.result.ok || !km.data) {
        setDetail({ title: "Fetch receiver public key", status: km.result.status, ok: false, body: km.result.body, url: km.url, method: km.method });
        setStatus("✗ Could not fetch receiver key.");
        setEncrypting(false);
        return;
      }
      const processNamesForKey =
        eventKind === "data" ? [proc]
        : isGeneric ? [KEY_PROCESS_NAME_OVERRIDES.generic!, genericProcessName]
        : [KEY_PROCESS_NAME_OVERRIDES[eventKind] ?? eventTypeDef.label]; // unconfirmed kinds fall back to the label — likely won't match a real key
      const encKey = pickEncryptionKey(km.data, processNamesForKey);
      if (!encKey) {
        setDetail({ title: "Fetch receiver public key", status: km.result.status, ok: true, body: km.result.body, url: km.url, method: km.method });
        setStatus(`✗ ${receiver.companyName} has no activated encryption key for ${processNamesForKey.join(" / ")}.`);
        setEncrypting(false);
        return;
      }

      const data = await crypto.encryptAndSign({
        cleartext: genericPayload ? JSON.stringify(genericPayload) : uploadedFileBytes ?? cleartext,
        recipientEncPublicPem: encKey.key,
        publicKeyVersion: encKey.version,
        signerSigPrivatePem: senderSig!.privatePem,
        signatureKeyVersion: senderSig!.version,
      });

      const dataschema =
        eventKind === "data"
          ? legacyDef
            ? `${legacyStandardsBase(legacyDef)}/${legacyDef.xsdFile}`
            : PROCESSES[proc].dataschema?.(processVersion)
          : isGeneric ? GENERIC_EXCHANGE_SCHEMA_URL
          : undefined;

      const processName = eventKind === "data" ? proc : isGeneric ? genericProcessName : DEFAULT_PROCESS_NAME_NO_SELECTOR;
      const subProcessName = eventKind === "data" ? PROCESSES[proc].subProcessName : isGeneric ? GENERIC_SUBPROCESS_NAME : DEFAULT_SUBPROCESS_NAME_NO_SELECTOR;
      const processStatus = eventKind === "data" ? PROCESSES[proc].processStatus : "active";
      const label = eventKind === "data" ? PROCESSES[proc].label : eventTypeDef.label;

      const evt = buildEnvelopeSkeleton({
        eventType: eventTypeDef,
        data,
        dataschema,
        subject: isGeneric ? `${label} ${genericProcessName}` : `${label} ${subProcessName}`,
        licenceKey: active.credentials.license,
        userAgent: { name: "SAF Testing Tool", version: "2.1" },
        eventReceiver: { category: toCategoryEnum(receiver.memberType), id: idp },
        eventSender: { category: active.membershipType, id: active.credentials.idp },
        processId,
        processName,
        processVersion: eventKind === "data" ? processVersion : isGeneric ? GENERIC_PROCESS_VERSION : PROCESSES["offer.nlpi"].defaultVersion,
        processStatus,
        subProcessName,
        subProcessStatus: "Created",
        businessDomain: isGeneric ? businessDomain : undefined,
      });
      setEvent(evt);
      setEnvelopeText(toJSON(evt));
      setStatus("Encrypted & signed — validating envelope…");

      try {
        const { valid, errors } = await validateAgainstSchema(envelopeSchemaUrl(eventKind, eventTypeDef), evt);
        setValidationErrors(valid ? [] : errors);
        const issues = [
          !valid ? `envelope has ${errors.length} schema issue(s)` : null,
          payloadIssues ? `payload has ${payloadIssues} schema issue(s)` : null,
        ].filter(Boolean);
        setStatus(issues.length ? `⚠ Encrypted, but ${issues.join(" and ")} — see below.` : "Encrypted & signed — ready to send.");
      } catch (e) {
        setValidationErrors([]);
        setStatus(`Encrypted & signed — ready to send (envelope validation unavailable: ${String((e as Error).message)}).`);
      }
    } catch (e) {
      setStatus("✗ " + String((e as Error).message));
    }
    setEncrypting(false);
  }

  function onEnvelopeTextChange(text: string) {
    setEnvelopeText(text);
    try { setEvent(JSON.parse(text)); } catch { /* keep last-valid `event` until it parses again */ }
  }

  function recordOutbox() {
    publish({
      id: "m-" + Date.now(), fromProfileId: active.id, fromName: active.name,
      toName: receiver.companyName, toIdp: receiver.idp[0], topic: "eh.saf.in.v1", standardNs: event.dataschema ?? "",
      subject: event.subject, time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      envelope: event.data, recipientEncPublicPem: "", signerSigPublicPem: senderSig!.publicPem, signerName: active.name, status: "sent",
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
                <select value={recvIdx} disabled={!receivers.length} onChange={(e) => { setRecvIdx(+e.target.value); setEvent(null); }}>
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
              <select value={eventKind} onChange={(e) => setEventKind(e.target.value as EventKind)}>
                {ALL_EVENT_KINDS.map((k) => <option key={k} value={k}>{EVENT_TYPES[k].label}</option>)}
              </select>
            </div>
            <span className="std-tag">{eventTypeDef.ceType}</span>
          </div>
          {eventKind === "data" && (
            <div className="sel">
              <span className="fl">Process (standard)</span>
              <div className="selectw">
                <select value={proc} onChange={(e) => changeProc(e.target.value as ProcessName)}>
                  {procOptions.map((p) => <option key={p} value={p}>{PROCESSES[p].label} ({p})</option>)}
                </select>
              </div>
              <span className="std-tag">processVersion {processVersion}</span>
            </div>
          )}
          {isGeneric && (
            <>
              <div className="sel">
                <span className="fl">Process (generic)</span>
                <div className="selectw">
                  <select value={genericProcessName} onChange={(e) => { setGenericProcessName(e.target.value as GenericProcessName); setEvent(null); }}>
                    {GENERIC_PROCESS_NAMES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <span className="std-tag">subProcessName {GENERIC_SUBPROCESS_NAME} · processVersion {GENERIC_PROCESS_VERSION}</span>
              </div>
              <div className="sel">
                <span className="fl">Business domain</span>
                <div className="selectw">
                  <select value={businessDomain} onChange={(e) => { setBusinessDomain(e.target.value as BusinessDomain); setEvent(null); }}>
                    {BUSINESS_DOMAINS.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </div>
            </>
          )}
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
        {isGeneric && genericError && (
          <div style={{ margin: "0 16px 4px", display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--warn)" }}>
            <AlertTriangle size={14} /> {genericError}
          </div>
        )}

        <div className="pipeline">
          <div className="pane">
            <div className="pane-head">
              <span className="pane-step">1</span>
              <div className="pane-titles">
                <div className="pane-title">Data</div>
                <div className="pane-sub">Cleartext · {eventKind === "data" ? PROCESSES[proc].label : isGeneric ? "GenericExchange v1.0.0" : eventTypeDef.label}{legacyLoading ? " · loading XSD…" : ""}{isGeneric && genericLoading ? " · loading schema…" : ""}</div>
              </div>
              {isGeneric ? (
                <>
                  <button className="btn-copy" style={{ marginRight: 8 }} onClick={() => attachInputRef.current?.click()}>
                    <Upload size={12} /> Add attachment
                  </button>
                  <input ref={attachInputRef} type="file" style={{ display: "none" }} onChange={(e) => { onAddAttachment(e.target.files?.[0]); e.target.value = ""; }} />
                  <button className="btn-copy" style={{ marginRight: 8 }} onClick={reloadGenericSample}>
                    <FileText size={12} /> Sample
                  </button>
                  <div className="seg">
                    <button className={mode === "form" ? "on" : ""} onClick={() => setGenericMode("form")}>Form</button>
                    <button className={mode === "raw" ? "on" : ""} onClick={() => setGenericMode("raw")}>Raw</button>
                  </div>
                </>
              ) : legacyDef ? (
                <>
                  <button className="btn-copy" style={{ marginRight: 8 }} onClick={() => { loadLegacyForm(legacyDef).then(({ sample }) => setValues(sample)); toast("Sample reloaded"); }}>
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
              {isGeneric ? (
                <div>
                  <div className="unsupported-note">
                    processIdentificationNo, timestamp, processName and processVersion are filled in on Encrypt to match the envelope.
                  </div>
                  {mode === "form" ? (
                    <FormTree values={genericValues} schema={genericSchema ?? undefined} onChange={onGenericField} />
                  ) : (
                    <div>
                      <div className="raw-bar">
                        <button className="btn-copy" onClick={() => { copyText(genericRaw); toast("Copied"); }}><Copy size={12} /> Copy</button>
                      </div>
                      <textarea className="code-edit" spellCheck={false} value={genericRaw} onChange={(e) => { setGenericRaw(e.target.value); setEvent(null); }} />
                    </div>
                  )}
                  {payloadErrors.length > 0 && (
                    <div className="unsupported-note" style={{ marginTop: 8 }}>
                      Payload schema issues (GenericExchange.json):
                      <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                        {payloadErrors.map((e, i) => <li key={i}>{e}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              ) : legacyDef ? (
                mode === "form" ? (
                  <FormTree values={values} schema={legacySchema ?? undefined} onChange={onField} />
                ) : (
                  <div>
                    <div className="raw-bar">
                      <button className="btn-copy" onClick={() => { copyText(rawXml); toast("Copied"); }}><Copy size={12} /> Copy</button>
                    </div>
                    <textarea className="code-edit" spellCheck={false} value={rawXml} onChange={(e) => { setRawXml(e.target.value); setEvent(null); }} />
                  </div>
                )
              ) : (
                <div>
                  <div className="raw-bar">
                    <button className="btn-copy" onClick={() => { copyText(dataText); toast("Copied"); }}><Copy size={12} /> Copy</button>
                  </div>
                  <textarea
                    className="code-edit" spellCheck={false} value={dataText}
                    placeholder="Free-form data — type it in, or upload a file (it will be base64-encoded into this box)."
                    onChange={(e) => { setDataText(e.target.value); setUploadedFileBytes(null); setEvent(null); }}
                  />
                </div>
              )}
            </div>
          </div>

          <div className="connector">
            <motion.div className={"op-node" + (event ? " done" : "")} animate={encrypting ? { scale: [1, 1.08, 1] } : { scale: 1 }} transition={encrypting ? { repeat: Infinity, duration: 1 } : {}}>
              {event ? <Check size={21} /> : <Lock size={21} strokeWidth={1.8} />}
            </motion.div>
            <button className="op-btn" disabled={encrypting || !!blocker || (isGeneric ? genericLoading : !cleartext)} onClick={doEncrypt}>{encrypting ? "Encrypting…" : "Encrypt"} <ArrowRight size={13} /></button>
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
                <textarea className="code-edit" spellCheck={false} value={envelopeText} onChange={(e) => onEnvelopeTextChange(e.target.value)} />
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

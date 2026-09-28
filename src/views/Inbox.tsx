import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  Search, Inbox as InboxIcon, KeyRound, ArrowRight, Check, Copy,
  ShieldCheck, ShieldAlert, CheckCheck, Wifi, WifiOff,
} from "lucide-react";
import { useApp } from "../store";
import FormTree from "../components/FormTree";
import JsonView from "../components/JsonView";
import { toJSON, copyText } from "../lib/format";
import { decrypt, verify } from "../lib/crypto";
import type { Envelope } from "../lib/crypto";
import { inboxFor, addMessage, markAcknowledged, type InboxMessage } from "../lib/inboxStore";
import { kafkaStartConsumer, kafkaStopConsumer, fetchMemberKeys, isTauri, produceViaKafka, schemaRegistryGetIds } from "../lib/ecohub";
import { acknowledgementIneligibility, buildAcknowledgement } from "../lib/acknowledgement";
import { publish } from "../lib/bus";

// Single source of truth: real Kafka-consumed events, persisted in the vault
// (src/lib/inboxStore.ts). No local/mock feed — this is the live inbox.
export default function Inbox() {
  const { active, toast, configured, sessionInboxIds, markReceivedThisSession, bumpBus } = useApp();
  const pfx = active.techUser?.techUserCert;
  const idp = active.credentials.idp || active.id;

  const [items, setItems] = useState<InboxMessage[]>(() => inboxFor(idp));
  const [consumerState, setConsumerState] = useState<"off" | "starting" | "ready" | "error">("off");
  const [q, setQ] = useState("");

  const [selId, setSelId] = useState<string | null>(null);
  const [decrypting, setDecrypting] = useState(false);
  const [decoded, setDecoded] = useState<any | null>(null);
  const [verified, setVerified] = useState<boolean | null>(null);
  const [viewMode, setViewMode] = useState<"form" | "raw">("form");
  const [err, setErr] = useState<string | null>(null);
  const [ackPendingId, setAckPendingId] = useState<string | null>(null);
  const [ackErr, setAckErr] = useState<string | null>(null);
  const ackInFlight = useRef(false);
  const selectedIdRef = useRef<string | null>(null);
  const profileRef = useRef({ id: active.id, idp: active.credentials.idp });

  // Reload history whenever the active profile's idp changes.
  useEffect(() => { setItems(inboxFor(idp)); }, [idp]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? items.filter((m) => (m.fromIdp + m.subject + m.topic).toLowerCase().includes(s)) : items;
  }, [items, q]);
  const sel = items.find((m) => m.id === selId) ?? items[0] ?? null;
  selectedIdRef.current = sel?.id ?? null;
  profileRef.current = { id: active.id, idp: active.credentials.idp };

  useEffect(() => { setDecoded(null); setVerified(null); setErr(null); setAckErr(null); }, [selId, sel?.id]);

  // Start/stop the Kafka consumer when profile connectivity changes.
  useEffect(() => {
    if (!configured || !pfx || !isTauri) return;

    setConsumerState("starting");
    kafkaStartConsumer({
      environment: active.credentials.environment,
      pfxBase64: pfx,
      password: active.credentials.password,
      idp: active.credentials.idp,
    }).catch((e) => { setConsumerState("error"); toast(`Consumer [idp=${active.credentials.idp} group=CG-00001-${active.credentials.idp}]: ${e}`); });

    return () => { kafkaStopConsumer(); setConsumerState("off"); };
  }, [configured, active.credentials.environment, active.credentials.idp]);

  // Listen for Tauri events from the consumer thread.
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | null = null;
    let unlistenReady: (() => void) | null = null;
    let unlistenErr: (() => void) | null = null;

    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<{ rawJson: string; topic: string; partition: number; offset: number; timestampMs: number | null }>("saf-message", (evt) => {
        try {
          const event = JSON.parse(evt.payload.rawJson);
          const envelope: Envelope = {
            payload: event.data?.payload ?? "",
            encryptionKey: event.data?.encryptionKey ?? "",
            payloadSignature: event.data?.payloadSignature ?? "",
            publicKeyVersion: event.data?.publicKeyVersion ?? "",
            signatureKeyVersion: event.data?.signatureKeyVersion ?? "",
          };
          const msg: InboxMessage = {
            id: event.id ?? `kafka-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            topic: evt.payload.topic,
            partition: evt.payload.partition,
            offset: evt.payload.offset,
            kafkaTimestampMs: evt.payload.timestampMs,
            receivedAt: new Date().toISOString(),
            toIdp: event.eventReceiver?.id ?? idp,
            fromIdp: event.eventSender?.id ?? "unknown",
            processName: event.processName ?? "",
            subject: event.subject ?? event.processName ?? "Event",
            envelope,
            rawEvent: event,
          };
          addMessage(msg);
          markReceivedThisSession(msg.id);
          setItems(inboxFor(idp));
        } catch { /* malformed message — skip */ }
      }).then((fn) => { unlisten = fn; });

      listen<void>("saf-consumer-ready", () => setConsumerState("ready")).then((fn) => { unlistenReady = fn; });

      listen<string>("saf-consumer-error", (evt) => {
        setConsumerState("error");
        toast(`Consumer error [idp=${active.credentials.idp} group=CG-00001-${active.credentials.idp}]: ${evt.payload}`);
      }).then((fn) => { unlistenErr = fn; });
    });

    return () => { unlisten?.(); unlistenReady?.(); unlistenErr?.(); };
  }, [idp]);

  async function doDecrypt() {
    if (!sel) return;
    setDecrypting(true); setErr(null);
    try {
      const privKey =
        active.encKeys.find((k) => k.version === sel.envelope.publicKeyVersion) ??
        active.encKeys.find((k) => k.active);
      if (!privKey) throw new Error(`No private key for version "${sel.envelope.publicKeyVersion}". Generate & activate one in Configuration.`);

      const clear = await decrypt(sel.envelope, privKey.privatePem);
      setDecoded(JSON.parse(clear));

      try {
        const km = await fetchMemberKeys({
          environment: active.credentials.environment,
          pfxBase64: pfx!,
          password: active.credentials.password,
          idp: sel.fromIdp,
        });
        const sigKey = km.data?.find(
          (k) => k.keyType === "signature" && k.version === sel.envelope.signatureKeyVersion
        ) ?? km.data?.find((k) => k.keyType === "signature" && k.ecoHubStatus === "Activated");
        setVerified(sigKey ? await verify(sel.envelope, sigKey.key) : false);
      } catch {
        setVerified(false);
      }
    } catch (e) {
      setErr(String(e));
    }
    setDecrypting(false);
  }

  async function doAcknowledge() {
    if (!sel || sel.acknowledgedAt || ackInFlight.current) return;
    const message = sel;
    const profile = {
      id: active.id,
      name: active.name,
      idp: active.credentials.idp,
      membershipType: active.membershipType,
      licenceKey: active.credentials.license,
      environment: active.credentials.environment,
      password: active.credentials.password,
      pfxBase64: pfx ?? "",
    };
    const profileIdentity = { id: profile.id, idp: profile.idp };
    const issue = acknowledgementIneligibility(message.rawEvent, profile);
    if (issue) { setAckErr(issue); return; }
    if (!isTauri) { setAckErr("Open the desktop app to acknowledge this event."); return; }
    if (!configured || !profile.pfxBase64) { setAckErr("Connect this profile in the desktop app before acknowledging."); return; }

    let acknowledgement;
    try {
      acknowledgement = buildAcknowledgement(message.rawEvent, profile);
    } catch (e) {
      setAckErr(String((e as Error).message));
      return;
    }

    ackInFlight.current = true;
    setAckPendingId(message.id);
    setAckErr(null);
    try {
      let valueSchemaId: number | undefined;
      try {
        const ids = await schemaRegistryGetIds({
          environment: profile.environment,
          pfxBase64: profile.pfxBase64,
          password: profile.password,
          topic: "eh.saf.in.v1",
        });
        valueSchemaId = ids.valueSchemaId;
      } catch {
        // Use the same existing Kafka producer fallback schema ID as normal sends.
      }
      const result = await produceViaKafka({
        environment: profile.environment,
        pfxBase64: profile.pfxBase64,
        password: profile.password,
        eventJson: JSON.stringify(acknowledgement),
        processId: acknowledgement.processId,
        valueSchemaId,
      });
      if (!result.ok) throw new Error(result.detail || "Kafka did not accept the acknowledgement.");

      const acknowledgedAt = new Date().toISOString();
      markAcknowledged(message.id, acknowledgedAt, acknowledgement.id);
      publish({
        id: `ack-${acknowledgement.id}`,
        fromProfileId: profile.id,
        fromName: profile.name,
        toName: message.fromIdp,
        toIdp: acknowledgement.eventReceiver.id,
        topic: "eh.saf.in.v1",
        standardNs: "",
        subject: `${acknowledgement.processName} acknowledgement`,
        processId: acknowledgement.processId,
        time: new Date(acknowledgedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        rawEvent: acknowledgement,
        recipientEncPublicPem: "",
        signerSigPublicPem: "",
        signerName: profile.name,
        status: "sent",
      });
      bumpBus();
      if (profileRef.current.id === profileIdentity.id && profileRef.current.idp === profileIdentity.idp) {
        setItems(inboxFor(profile.idp));
      }
      toast(`Acknowledgement sent to ${message.fromIdp}`);
    } catch (e) {
      const messageText = String((e as Error).message);
      if (profileRef.current.id === profileIdentity.id && profileRef.current.idp === profileIdentity.idp && selectedIdRef.current === message.id) {
        setAckErr(`Acknowledgement failed: ${messageText}. You can retry.`);
      } else {
        toast(`Acknowledgement failed: ${messageText}`);
      }
    } finally {
      ackInFlight.current = false;
      setAckPendingId(null);
    }
  }

  const consumerIcon = consumerState === "ready" ? <Wifi size={12} style={{ color: "var(--ok)" }} />
    : consumerState === "error" ? <WifiOff size={12} style={{ color: "var(--err)" }} />
    : consumerState === "starting" ? <Wifi size={12} style={{ opacity: 0.4 }} />
    : null;

  const liveStatusLabel = consumerState === "ready" ? "Listening" : consumerState === "starting" ? "Connecting…" : consumerState === "error" ? "Consumer error" : "Offline";

  function fmtTime(m: InboxMessage) {
    const ms = m.kafkaTimestampMs ?? Date.parse(m.receivedAt);
    return new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  // Not every SAF event carries an encrypted envelope — error and IDS status
  // events (among others) publish plaintext data with no payload/encryptionKey/
  // payloadSignature at all. Detect that up front so we never show a
  // "Decrypt" affordance for something there's nothing to decrypt.
  const hasEncrypted = Boolean(
    sel?.envelope.payload && sel?.envelope.encryptionKey && sel?.envelope.payloadSignature
  );
  const rawEventText = sel ? toJSON(sel.rawEvent) : "";
  const ackProfile = { idp: active.credentials.idp, membershipType: active.membershipType, licenceKey: active.credentials.license };
  const ackIssue = sel ? acknowledgementIneligibility(sel.rawEvent, ackProfile) : "Select an event to acknowledge.";
  const alreadyAcknowledged = Boolean(sel?.acknowledgedAt);

  return (
    <div className="view">
      <div className="chead">
        <div><h1>Inbox</h1><div className="sub">Live events consumed from Kafka, decrypt and verify</div></div>
        <div className="chead-spacer" />
        {configured && (
          <div className="live-ind">
            {consumerIcon}&nbsp;{liveStatusLabel} · {items.length} event{items.length !== 1 ? "s" : ""}
          </div>
        )}
        <div className="search"><Search size={14} /><input placeholder="Search messages" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      </div>

      {filtered.length === 0 ? (
        <div className="empty-mailbox" style={{ flex: 1 }}>
          <InboxIcon strokeWidth={1.4} />
          <div className="em-title">No incoming events</div>
          <div className="em-sub">
            {consumerState === "ready"
              ? `Listening on ${active.credentials.environment}. Events sent to ${active.credentials.idp} will appear here.`
              : "Connect this profile to start receiving events from EcoHub."}
          </div>
        </div>
      ) : (
        <div className="splitter">
          <div className="list">
            {filtered.map((m) => (
              <div key={m.id} className={"row" + (sel?.id === m.id ? " sel" : "")} onClick={() => setSelId(m.id)}>
                <span className="r-unreaddot" />
                <div className="r-body">
                  <div className="r-top">
                    <span className="r-from">{m.fromIdp}</span>
                    <span className="r-time">{fmtTime(m)}</span>
                  </div>
                  <div className="r-subject">
                    {m.subject}
                    {sessionInboxIds.has(m.id) && <span className="chip chip-ok" style={{ marginLeft: 6 }}>live</span>}
                  </div>
                  <div className="r-meta">
                    <span className="topic-tag">{m.topic}</span>
                    <span className="topic-tag">p{m.partition} · o{m.offset}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {!sel ? (
            <div className="detail-empty">
              <InboxIcon strokeWidth={1.4} />
              <div className="de-title">No message selected</div>
              <div className="de-sub">Pick an event to inspect and decrypt its envelope.</div>
            </div>
          ) : (
            <div className="detail">
              <div className={"pipeline" + (hasEncrypted ? "" : " single")}>
                <div className="pane">
                  <div className="pane-head">
                    <span className="pane-step">1</span>
                    <div className="pane-titles">
                      <div className="pane-title">Received event</div>
                      <div className="pane-sub">Full Kafka message value, as received</div>
                    </div>
                  </div>
                  <div className="pane-body">
                    <div className="enc-meta">
                      <span className="k">From</span><span className="v">{sel.fromIdp}</span>
                      <span className="k">Process</span><span className="v">{sel.processName || "—"}</span>
                      <span className="k">Topic</span><span className="v">{sel.topic}</span>
                      <span className="k">Partition · offset</span><span className="v">{sel.partition} · {sel.offset}</span>
                      <span className="k">Arrived</span><span className="v">{fmtTime(sel)}</span>
                      {hasEncrypted && <><span className="k">Enc key</span><span className="v">v{sel.envelope.publicKeyVersion}</span></>}
                      {hasEncrypted && <><span className="k">Sig key</span><span className="v">v{sel.envelope.signatureKeyVersion}</span></>}
                    </div>
                    <div className="ciph-head">
                      <span className="lbl">event JSON</span>
                      <span className="ciph-head-right">
                        {!hasEncrypted && <span className="chip chip-pending">no encrypted payload</span>}
                        <button className="btn-copy" onClick={() => { copyText(rawEventText); toast("Copied"); }}><Copy size={12} /> Copy</button>
                      </span>
                    </div>
                    <JsonView data={sel.rawEvent} className="code-block-bounded" />
                    <div className="pane-foot">
                      <span className="st">
                        {ackErr ? <span style={{ color: "var(--err)" }}>{ackErr}</span>
                          : alreadyAcknowledged ? <span className="chip chip-ok"><CheckCheck size={10} /> Acknowledged</span>
                          : !configured || !pfx ? <span className="st">Connect this profile in the desktop app to acknowledge.</span>
                          : !active.credentials.idp ? <span className="st">Set an IDP for the active profile before acknowledging.</span>
                          : ackIssue ? <span className="st">{ackIssue}</span>
                          : null}
                      </span>
                      <button className="btn-primary" disabled={alreadyAcknowledged || !!ackIssue || !isTauri || !configured || !pfx || !active.credentials.idp || ackPendingId !== null} onClick={doAcknowledge}>
                        <CheckCheck size={14} /> {ackPendingId === sel.id ? "Sending acknowledgement…" : alreadyAcknowledged ? "Acknowledged" : "Acknowledge"}
                      </button>
                    </div>
                  </div>
                </div>

                {hasEncrypted && (
                  <>
                    <div className="connector">
                      <motion.div className={"op-node" + (decoded ? " done" : "")} animate={decrypting ? { scale: [1, 1.08, 1] } : { scale: 1 }} transition={decrypting ? { repeat: Infinity, duration: 1 } : {}}>
                        {decoded ? <Check size={21} /> : <KeyRound size={21} strokeWidth={1.8} />}
                      </motion.div>
                      <button className="op-btn" disabled={decrypting} onClick={doDecrypt}>
                        {decrypting ? "Decrypting…" : "Decrypt"} <ArrowRight size={13} />
                      </button>
                      <div className="op-label">with your<br />private key</div>
                    </div>

                    <div className="pane">
                      <div className="pane-head">
                        <span className={"pane-step" + (decoded ? " done" : "")}>2</span>
                        <div className="pane-titles"><div className="pane-title">Decoded payload</div><div className="pane-sub">Cleartext after decryption</div></div>
                        {decoded && viewMode === "raw" && (
                          <button className="btn-copy" onClick={() => { copyText(toJSON(decoded)); toast("Copied"); }}><Copy size={12} /> Copy</button>
                        )}
                        <div className="seg" style={{ opacity: decoded ? 1 : 0.4, pointerEvents: decoded ? "auto" : "none" }}>
                          <button className={viewMode === "form" ? "on" : ""} onClick={() => setViewMode("form")}>Form</button>
                          <button className={viewMode === "raw" ? "on" : ""} onClick={() => setViewMode("raw")}>Raw</button>
                        </div>
                      </div>
                      <div className="pane-body">
                        {err ? (
                          <div className="pane-empty"><ShieldAlert style={{ color: "var(--err)" }} strokeWidth={1.5} /><div className="t">Decrypt failed</div><div className="s">{err}</div></div>
                        ) : !decoded ? (
                          <div className="pane-empty"><KeyRound strokeWidth={1.5} /><div className="t">Encrypted</div><div className="s">Decrypt with your private key to reveal the payload and verify the sender's signature.</div></div>
                        ) : viewMode === "form" ? <FormTree values={decoded} readOnly /> : <JsonView data={decoded} className="code-block-bounded" />}
                      </div>
                      {decoded && (
                        <div className="pane-foot">
                          <span className="st">
                            {verified === true
                              ? <span className="chip chip-ok"><ShieldCheck size={10} /> Signature verified</span>
                              : verified === false
                              ? <span className="chip chip-warn"><ShieldAlert size={10} /> Signature NOT verified</span>
                              : null}
                          </span>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Real EcoHub Services API calls.
//
// Native: routed through the Rust `http_post_json` command — HTTP/1.1 (matching
// the C# HttpClient), no browser CORS, and the real status + body come back so
// the UI can show exactly what EcoHub returned.
// Browser dev: window.fetch fallback (cross-origin will usually be CORS-blocked).
// ============================================================

export const ENV_URLS: Record<string, string> = {
  Development: "https://dev-ecohub-services-api.azure-api.net",
  Test: "https://test-ecohub-services-api.azure-api.net",
  Staging: "https://stg-ecohub-services-api.azure-api.net",
  IAT: "https://services.test-myecohub.ch",
  Production: "https://services.myecohub.ch",
};

// CSM Kafka bootstrap hosts (port 9092) per environment — from the C# tool seed.
export const CSM_HOSTS: Record<string, string> = {
  Development: "saf.dev.essential-sandbox.com",
  Test: "saf.test.essential-sandbox.com",
  Staging: "saf.essentials-staging.com",
  IAT: "saf.test-myecohub.ch",
  Production: "saf.myecohub.ch",
};

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export type HttpResult = { status: number; ok: boolean; body: string };

async function postJson(url: string, body: string): Promise<HttpResult> {
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<HttpResult>("http_post_json", { url, body });
  }
  // browser dev fallback
  try {
    const res = await window.fetch(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body,
    });
    return { status: res.status, ok: res.ok, body: await res.text() };
  } catch (e) {
    return { status: 0, ok: false, body: `Browser blocked the cross-origin request to ${url}. Run the native app to call EcoHub for real.\n\n${String(e)}` };
  }
}

export type TechUserResponse = {
  techUserCert: string;
  oAuth2: { clientId: string; clientSecret: string; openIdConfigurationEndpoint: string };
};

export type EnrolInput = { environment: string; iak: string; idp: string; license: string; password: string };

// POST {servicesApiUrl}/general/v3/techUserEnrolment — mirrors C# TechUserService.EnrolTechUser
export async function enrolTechUser(input: EnrolInput): Promise<{ result: HttpResult; data: TechUserResponse | null; url: string }> {
  const base = ENV_URLS[input.environment];
  if (!base) throw new Error(`Unknown environment "${input.environment}".`);
  const url = `${base}/general/v3/techUserEnrolment`;

  const body = JSON.stringify({
    iak: input.iak,
    idpUserId: input.idp,
    licenceKey: input.license,
    password: input.password,
    requestId: globalThis.crypto.randomUUID(),
    requestTime: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    userAgent: { name: "Client software (TEST)", version: "Version 1.0" },
  });

  const result = await postJson(url, body);
  let data: TechUserResponse | null = null;
  if (result.ok) {
    try { data = JSON.parse(result.body) as TechUserResponse; } catch { /* non-JSON success */ }
  }
  return { result, data, url };
}

// ============================================================
// Public Key Store (mutual-TLS with the tech-user cert)
// ============================================================
import * as crypto from "./crypto";

async function mtls(url: string, method: "GET" | "POST", body: string | null, pfxBase64: string, password: string, headers?: Record<string, string>): Promise<HttpResult> {
  if (!isTauri) throw new Error("This call needs mutual-TLS (client certificate). Run the native app.");
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<HttpResult>("mtls_request", { url, method, body, pfxBase64, password, headers: headers ?? null });
}

export type ProduceResult = { ok: boolean; partition: number; offset: number; detail: string };

// ============================================================
// Schema Registry — mirrors CachedSchemaRegistryClient behaviour
// (UseLatestVersion = true, AutoRegisterSchemas = false, SubjectNameStrategy = Topic)
// ============================================================

/** Fetch live key/value schema IDs for a topic from the registry. */
export async function schemaRegistryGetIds(opts: {
  environment: string;
  pfxBase64: string;
  password: string;
  topic: string;
}): Promise<{ valueSchemaId: number; keySchemaId: number }> {
  if (!isTauri) throw new Error("Schema registry lookup needs the desktop app (mTLS).");
  const base = ENV_URLS[opts.environment];
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke("schema_registry_get_ids", {
    servicesApiUrl: base,
    topic: opts.topic,
    pfxBase64: opts.pfxBase64,
    password: opts.password,
  });
}

// Produce over the native Kafka protocol (mTLS to the CSM broker:9092) — the
// path the C# tool used. Key = SAFKeyType {processId}, value = the SAF event;
// both Confluent-wire-framed with the schema ids (same ids as the REST proxy).
export async function produceViaKafka(opts: { environment: string; pfxBase64: string; password: string; eventJson: string; processId: string; valueSchemaId?: number }): Promise<{ ok: boolean; detail: string }> {
  if (!isTauri) throw new Error("Native Kafka produce needs the desktop app.");
  const host = CSM_HOSTS[opts.environment];
  if (!host) throw new Error(`No CSM broker host for ${opts.environment}.`);
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    const r = await invoke<ProduceResult>("kafka_produce", {
      bootstrap: `${host}:9092`,
      topic: "eh.saf.in.v1",
      keyJson: JSON.stringify({ processId: opts.processId }),
      valueJson: opts.eventJson,
      valueSchemaId: opts.valueSchemaId ?? 100060,
      keySchemaId: 100021,
      pfxBase64: opts.pfxBase64,
      password: opts.password,
    });
    return { ok: r.ok, detail: r.detail };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}

// Produce a SAF event via the REST proxy (POST /saf/v1/in) — the HTTPS equivalent
// of producing to the Kafka in-topic. Schema IDs per REST proxy v1.2.0.
export async function produceEvent(opts: { environment: string; pfxBase64: string; password: string; eventJson: string; valueSchemaId?: number; keySchemaId?: number }): Promise<HttpResult> {
  const base = ENV_URLS[opts.environment];
  const url = `${base}/saf/v1/in`;
  return mtls(url, "POST", opts.eventJson, opts.pfxBase64, opts.password, {
    schemaVersionId: String(opts.valueSchemaId ?? 100060),
    keySchemaVersionId: String(opts.keySchemaId ?? 100021),
  });
}

// ============================================================
// Kafka consumer control
// ============================================================

/** Start consuming from ^eh\.saf\..*\.out\.v1$ (mTLS). Emits "saf-message" events. */
export async function kafkaStartConsumer(opts: {
  environment: string;
  pfxBase64: string;
  password: string;
  idp: string; // "IDP3003668" → group id CG-00001-3003668
}): Promise<void> {
  if (!isTauri) return;
  const host = CSM_HOSTS[opts.environment];
  if (!host) throw new Error(`No CSM broker host for ${opts.environment}.`);
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("kafka_start_consumer", {
    bootstrap: `${host}:9092`,
    groupId: `CG-00001-${opts.idp}`,
    pfxBase64: opts.pfxBase64,
    password: opts.password,
  });
}

export async function kafkaStopConsumer(): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("kafka_stop_consumer");
}

// ---- Discovery: receivers the caller has a service agreement with ----
export type Receiver = {
  orgId?: string;
  membershipId?: string;
  idp: string[];
  companyName: string;
  memberType: string; // API returns e.g. "Broker" | "Insurer" | "Service Provider" (spaced)
  supportedProcesses?: { processName: string; processVersion?: string }[];
};

/** Map a receiver's memberType (any casing/spacing) to SenderReceiverType.json's category enum: broker | insurer | serviceprovider. */
export function toCategoryEnum(memberType: string): string {
  return memberType.toLowerCase().replace(/[\s_-]+/g, "");
}

export async function fetchReceivers(opts: { environment: string; pfxBase64: string; password: string; license: string }): Promise<{ result: HttpResult; data: Receiver[] | null; url: string; method: string; requestBody: string }> {
  const base = ENV_URLS[opts.environment];
  const url = `${base}/general/v3/saf-receivers`;
  const body = JSON.stringify({
    licenceKey: opts.license,
    password: opts.password,
    requestId: globalThis.crypto.randomUUID(),
    requestTime: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    userAgent: { name: "SAF Testing Tool", version: "2.1" },
  });
  const result = await mtls(url, "POST", body, opts.pfxBase64, opts.password);
  let data: Receiver[] | null = null;
  if (result.ok) { try { data = JSON.parse(result.body) as Receiver[]; } catch { /* */ } }
  return { result, data, url, method: "POST", requestBody: body };
}

// ---- Public Key Store: fetch a member's keys (to encrypt to a receiver) ----
export type PublicKeyInfo = {
  keyType: string;            // encryption | signature
  supportedProcesses?: { processName: string }[] | null;
  keyId: string;
  version: string;
  key: string;                // PEM
  ecoHubStatus: string;       // Activated | …
};

export async function fetchMemberKeys(opts: { environment: string; pfxBase64: string; password: string; idp: string }): Promise<{ result: HttpResult; data: PublicKeyInfo[] | null; url: string; method: string }> {
  const base = ENV_URLS[opts.environment];
  const url = `${base}/publickeystore/v3/members/${opts.idp}/keys`;
  const result = await mtls(url, "GET", null, opts.pfxBase64, opts.password);
  let data: PublicKeyInfo[] | null = null;
  if (result.ok) { try { data = JSON.parse(result.body) as PublicKeyInfo[]; } catch { /* */ } }
  return { result, data, url, method: "GET" };
}

// Pick the activated encryption key for a process: a key explicitly supporting
// one of the candidate process names (tried in order) wins over a key with no
// process restriction, which is the last resort.
export function pickEncryptionKey(keys: PublicKeyInfo[], processName: string | string[]): PublicKeyInfo | undefined {
  const active = keys.filter((k) => k.keyType === "encryption" && k.ecoHubStatus === "Activated");
  for (const name of Array.isArray(processName) ? processName : [processName]) {
    const k = active.find((k) => k.supportedProcesses?.some((p) => p.processName === name));
    if (k) return k;
  }
  return active.find((k) => !k.supportedProcesses || k.supportedProcesses.length === 0);
}

export type KeyKind = "encryption" | "signature";
export type Step = { name: string; status: number; ok: boolean; method: "GET" | "POST"; url: string; body: string | null };
export type PksResult = { ok: boolean; keyId?: string; version: string; steps: Step[]; detailBody: string; curl: string };

/** Render a step as a runnable curl command (mTLS via the tech-user PFX). */
export function stepToCurl(step: Step, password: string): string {
  const parts = [
    `curl -X ${step.method} "${step.url}"`,
    `--cert-type P12 --cert "client.pfx:${password}"`,
    `-H "Accept: application/json"`,
  ];
  if (step.body) {
    parts.push(`-H "Content-Type: application/json"`);
    parts.push(`-d '${step.body.replace(/'/g, `'\\''`)}'`);
  }
  return parts.join(" \\\n  ") + "\n\n# client.pfx is the enrolled tech-user certificate for this profile (PKCS#12).";
}

// Upload a public key, prove possession of the private key, then activate it.
export async function uploadAndActivateKey(opts: {
  environment: string;
  pfxBase64: string;
  password: string;
  version: string;
  publicPem: string;
  privatePem: string;
  kind: KeyKind;
}): Promise<PksResult> {
  const base = ENV_URLS[opts.environment];
  const keysUrl = `${base}/publickeystore/v3/keys`;
  const steps: Step[] = [];
  const version = opts.version;
  let keyId: string | undefined;
  const curlFor = (s: Step) => stepToCurl(s, opts.password);

  // 1. upload (body is a JSON array) — single attempt with the chosen version
  const body = JSON.stringify([{ version, key: opts.publicPem, expireInDays: 365, keyType: opts.kind }]);
  const r = await mtls(keysUrl, "POST", body, opts.pfxBase64, opts.password);
  const uploadStep: Step = { name: `upload v${version}`, status: r.status, ok: r.ok, method: "POST", url: keysUrl, body };
  steps.push(uploadStep);
  if (!r.ok) {
    let code: string | undefined;
    try { code = JSON.parse(r.body).errorCode; } catch { /* */ }
    const exists = code === "KEY_VERSION_EXISTS" || r.status === 409;
    const msg = exists
      ? `Version ${version} already exists in the ${opts.environment} Public Key Store for this key type. Generate a key with a different version.\n\n${r.body}`
      : r.body;
    return { ok: false, version, steps, detailBody: msg, curl: curlFor(uploadStep) };
  }
  try { keyId = JSON.parse(r.body)[0]?.keyId; } catch { /* */ }
  if (!keyId) return { ok: false, version, steps, detailBody: `Upload returned HTTP ${r.status} but no keyId.\n\n${r.body}`, curl: curlFor(uploadStep) };

  const verifyUrl = `${base}/publickeystore/v3/keys/${keyId}/verify`;

  // 2. GET the verification challenge
  const g = await mtls(verifyUrl, "GET", null, opts.pfxBase64, opts.password);
  const challengeStep: Step = { name: "get challenge", status: g.status, ok: g.ok, method: "GET", url: verifyUrl, body: null };
  steps.push(challengeStep);
  if (!g.ok) return { ok: false, keyId, version, steps, detailBody: g.body, curl: curlFor(challengeStep) };
  let challenge: string;
  try { challenge = JSON.parse(g.body).verificationContent; } catch { return { ok: false, keyId, version, steps, detailBody: g.body, curl: curlFor(challengeStep) }; }

  // 3. prove possession of the private key
  const verifiedContent =
    opts.kind === "encryption"
      ? await crypto.rsaDecryptToString(challenge, opts.privatePem)
      : await crypto.signTextToDerB64(challenge, opts.privatePem);

  // 4. POST the proof
  const verifyBody = JSON.stringify({ keyId, verifiedContent });
  const p = await mtls(verifyUrl, "POST", verifyBody, opts.pfxBase64, opts.password);
  const verifyStep: Step = { name: "verify", status: p.status, ok: p.ok, method: "POST", url: verifyUrl, body: verifyBody };
  steps.push(verifyStep);
  if (!p.ok) return { ok: false, keyId, version, steps, detailBody: p.body, curl: curlFor(verifyStep) };

  // 5. activate
  const activateUrl = `${base}/publickeystore/v3/keys/${keyId}/activate`;
  const a = await mtls(activateUrl, "POST", null, opts.pfxBase64, opts.password);
  const activateStep: Step = { name: "activate", status: a.status, ok: a.ok, method: "POST", url: activateUrl, body: null };
  steps.push(activateStep);
  if (!a.ok) return { ok: false, keyId, version, steps, detailBody: a.body, curl: curlFor(activateStep) };

  return { ok: true, keyId, version, steps, detailBody: a.body || "Key uploaded, verified and activated.", curl: curlFor(activateStep) };
}

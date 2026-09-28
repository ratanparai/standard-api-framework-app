import type { Envelope } from "./lib/crypto";

export type MembershipType = "insurer" | "broker" | "serviceprovider";

export type KeyRecord = {
  version: string;
  createdAt: string;
  active: boolean;          // locally selected as the one to use
  publicPem: string;
  privatePem: string;
  fingerprint: string;
  keyId?: string;           // EcoHub key id once uploaded
  remote?: "uploaded" | "activated"; // status in the live Public Key Store
};

export type Credentials = {
  environment: string;
  idp: string;
  license: string;
  password: string;
  iak: string;
  orgId: string;
};

export type TechUser = {
  clientId: string;
  clientSecret: string;
  openIdConfigurationEndpoint: string;
  techUserCert: string;
  enrolledAt: string;
};

export type Profile = {
  id: string;
  name: string;
  membershipType: MembershipType;
  avatar: string;
  connected: boolean;
  credentials: Credentials;
  techUser: TechUser | null;
  encKeys: KeyRecord[];
  sigKeys: KeyRecord[];
};

// A local log entry for an event THIS profile has produced (Outbox view only —
// incoming events never go through this type, see src/lib/inboxStore.ts).
export type BusMessage = {
  id: string;
  fromProfileId: string;
  fromName: string;
  toName: string;
  toIdp: string;
  topic: string;
  standardNs: string;
  subject: string;
  // processId from the event metadata — lets a sent event be traced back /
  // searched for when coordinating with a counterparty outside EcoHub.
  processId?: string;
  time: string;
  envelope?: Envelope;
  // Full CloudEvents envelope that was produced, so the Outbox can show the
  // event payload (like the Inbox's raw-event pane). Optional for back-compat
  // with records saved before this field existed.
  rawEvent?: any;
  recipientEncPublicPem: string;
  signerSigPublicPem: string;
  signerName: string;
  status: "sent" | "failed" | "pending";
};

// Persisted store for real Kafka-consumed SAF events (the "in" inbox). Backed
// by the same encrypted vault as profiles (src/lib/storage.ts) — distinct from
// src/lib/bus.ts, which stays scoped to the local Outbox (a log of your own
// sent actions, not simulated received traffic).
import type { Envelope } from "./crypto";
import { load, save } from "./storage";

export type InboxMessage = {
  id: string; // envelope id — de-dupe key
  topic: string;
  partition: number;
  offset: number;
  kafkaTimestampMs: number | null;
  receivedAt: string; // ISO, when this app consumed it
  toIdp: string; // envelope.eventReceiver.id — whose inbox this belongs to
  fromIdp: string;
  processName: string;
  subject: string;
  envelope: Envelope;
  rawEvent: any;
  acknowledgedAt?: string;
  acknowledgementEventId?: string;
};

const KEY = "kafkaInbox";

export function allMessages(): InboxMessage[] {
  return load<InboxMessage[]>(KEY, []);
}

export function inboxFor(idp: string): InboxMessage[] {
  return allMessages().filter((m) => m.toIdp === idp);
}

/** Persist a newly consumed message. No-ops if a message with the same id already exists. */
export function addMessage(msg: InboxMessage): void {
  const list = allMessages();
  if (list.some((m) => m.id === msg.id)) return;
  list.unshift(msg);
  save(KEY, list);
}

/** Persist a successful acknowledgement against only the matching incoming event. */
export function markAcknowledged(messageId: string, acknowledgedAt: string, acknowledgementEventId: string): boolean {
  const list = allMessages();
  let updated = false;
  const next = list.map((message) => {
    if (message.id !== messageId || message.acknowledgedAt) return message;
    updated = true;
    return { ...message, acknowledgedAt, acknowledgementEventId };
  });
  if (updated) save(KEY, next);
  return updated;
}

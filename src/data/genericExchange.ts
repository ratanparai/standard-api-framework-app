// GenericExchange v1.0.0 payload (EcoHub-AG/Standards, tag genericExchange-v1.0.0) —
// the cleartext JSON that goes (gzipped + encrypted) into a ch.ecohub.saf.generic
// envelope's data.payload.
import { STANDARDS_BASE } from "../lib/schema/loader";

export const GENERIC_EXCHANGE_BASE = `${STANDARDS_BASE}/refs/tags/genericExchange-v1.0.0/schemas/GenericExchange/v1.0.0`;

/** Root payload schema — also sent as the envelope `dataschema`. (The Api-Specs
 *  examples use `refs/tags/GenericExchange_v1.0.0/schemas/GenericExchange/GenericExchange.json`,
 *  which doesn't resolve: neither that tag nor that path exists.) */
export const GENERIC_EXCHANGE_SCHEMA_URL = `${GENERIC_EXCHANGE_BASE}/genericExchange-root/GenericExchange.json`;
export const GENERIC_EXCHANGE_SAMPLE_URL = `${GENERIC_EXCHANGE_BASE}/Testfiles/GenericExchange-valid-full.json`;

/** Root payload keys the app fills in on Encrypt (kept in sync with the envelope). */
export const GENERIC_EXCHANGE_AUTO_KEYS = ["processIdentificationNo", "timestamp", "processName", "processVersion"];

/** FileType.json `data` max length (base64 chars) → max raw attachment size. */
export const GENERIC_ATTACHMENT_MAX_BYTES = Math.floor((10485760 * 3) / 4);

// Built-in copy of Testfiles/GenericExchange-valid-full.json (minus the auto keys),
// used when the live sample can't be fetched.
export const GENERIC_EXCHANGE_FALLBACK_SAMPLE = {
  header: {
    sender: {
      broker: { brokerRegisterNo: "CHE-FINMA-F12345678", companyId: "CHE-115.517.011", companyName: "Example Broker AG", brokerBranch: "101156" },
    },
    recipient: {
      insurer: { companyId: "CHE-107.516.123", companyName: "Example Insurance AG", insurerCode: "15S" },
    },
  },
  customer: {
    customerNumber: "CUST-100001",
    contracts: [{ contractNumber: "CON-2026-0001", lobIG: ["11000", "12000"], lobINS: ["MOTOR", "LIABILITY"] }],
    company: {
      companyName: "Example Trading AG",
      companyId: "CHE-115.517.011",
      address: { streetName: "Zollstrasse", houseNumber: "1", addressExtension: "Building A", postOfficeBox: "P.O. Box 100", zip: "8005", city: "Zurich", country: "CH" },
    },
  },
  requestedResponseDate: "2026-09-15",
  comment: "Please process the attached contract document and respond by the requested response date.",
  contact: { contactSurname: "Muster", contactFirstName: "Erika", contactMail: "erika.muster@example.com", contactPhone: "+41441234567" },
};

/** Envelope SenderReceiverType category → payload SenderReceiverType branch. */
export function headerBranchFor(category: string): "broker" | "insurer" | "otherExchangePartner" {
  return category === "broker" ? "broker" : category === "insurer" ? "insurer" : "otherExchangePartner";
}

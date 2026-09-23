// Authoritative SAF processes (from saf-integration-docs reference/processes.md and
// json-payload-schema.md). processName enum is the v2/v3 set (async-rest-1.2.x adds
// claimsExperience.nlpi). Each process carries a default subProcessName/processStatus
// and an editable sample business payload.
export type ProcessName = "offer.nlpi" | "invoice" | "commission" | "contract" | "mandate" | "claimsExperience" | "claimsExperience.nlpi";

// Legacy processes have a real XSD in EcoHub-AG/Standards (schemas/legacy/5.4.1) — no
// JSON Schema exists for these, so their form is generated from the XSD instead
// (src/lib/schema/xsdParser.ts). offer.nlpi/ids have no XML schema at all and use a
// free-text "data" textarea + file upload instead; generic uses a form generated from
// the GenericExchange JSON Schema (see SendEvent.tsx).
export type LegacyXsdDef = {
  tag: string;              // Standards repo git tag, e.g. "invoice-v5.4.1"
  xsdFile: string;          // root schema file under schemas/legacy/5.4.1/
  rootElementName: string;  // root <xs:element name="..."> in that file
  sampleFile: string;       // seed sample under schemas/legacy/5.4.1/Testfiles/
};

export type ProcessDef = {
  name: ProcessName;
  label: string;
  subProcessName: string;     // SubProcessNameType
  processStatus: "active" | "closed";
  defaultVersion: string;     // processVersion (semver) when a receiver doesn't pin one
  dataschema?: (version: string) => string;
  sample: Record<string, any>;
  legacyXsd?: LegacyXsdDef;
};

export const PROCESSES: Record<ProcessName, ProcessDef> = {
  "offer.nlpi": {
    name: "offer.nlpi",
    label: "Offer NLPI",
    subProcessName: "request",
    processStatus: "active",
    defaultVersion: "1.0.0",
    dataschema: (v) =>
      `https://raw.githubusercontent.com/EcoHub-AG/Standards/refs/tags/Offer_NLPI_v${v}/schemas/Offer-NLPI/v${v}/offer-nlpi-root/OfferNlpiRequestDataType.json`,
    sample: {
      offerId: "OFR-2026-104872",
      productLine: "household",
      customer: {
        customer: {
          companyName: "Quartierverein Zürich-West",
          companyId: "CHE-123.456.789",
          companyLegalForm: "Association",
          companyLegalStatus: "Active",
          companyFoundingYear: "2022",
          domicilAddress: { zip: "8000", city: "Zürich", country: "CH", streetName: "Zollstrasse", streetNumber: "12" },
        },
        contact: { email: "info@qv-zhwest.ch", phone: "+41 44 000 00 00" },
      },
      coverage: { sumInsured: 2400000, currency: "CHF", coverageStart: "2026-07-01", coverageEnd: "2027-06-30", deductible: 300 },
      premiumGross: 480,
    },
  },
  invoice: {
    name: "invoice", label: "Invoice", subProcessName: "billing", processStatus: "closed", defaultVersion: "5.4.1",
    sample: { invoiceNumber: "INV-2026-5512", policyNumber: "CH-PROP-553019", amountGross: 4180, currency: "CHF", dueDate: "2026-08-01" },
    legacyXsd: { tag: "invoice-v5.4.1", xsdFile: "billing_V5.4.1.xsd", rootElementName: "billing", sampleFile: "testfile billing 5.4.1 max.xml" },
  },
  commission: {
    name: "commission", label: "Commission", subProcessName: "commission", processStatus: "closed", defaultVersion: "5.4.1",
    sample: { statementId: "COM-2026-0091", broker: "Kessler & Co", period: "2026-Q2", amount: 1290.5, currency: "CHF" },
    legacyXsd: { tag: "commission-v5.4.1", xsdFile: "commission_V5.4.1.xsd", rootElementName: "commission", sampleFile: "testfile commission 5.4.1 max.xml" },
  },
  contract: {
    name: "contract", label: "Contract", subProcessName: "contract", processStatus: "closed", defaultVersion: "5.4.1",
    sample: { policyNumber: "CH-MOT-887421", productLine: "motor", effectiveDate: "2026-07-01", status: "active" },
    legacyXsd: { tag: "contract-v5.4.1", xsdFile: "contractRequest_V5.4.1.xsd", rootElementName: "contractRequest", sampleFile: "testfile contractRequest 5.4.1.xml" },
  },
  mandate: {
    name: "mandate", label: "Mandate", subProcessName: "submission", processStatus: "closed", defaultVersion: "5.4.1",
    sample: { mandateId: "MND-2026-3391", broker: "Helvetia Brokers", customerId: "CHE-123.456.789", validFrom: "2026-07-01" },
    legacyXsd: { tag: "mandate-v5.4.1", xsdFile: "mandateSubmission_V5.4.1.xsd", rootElementName: "mandateSubmission", sampleFile: "testfile mandateSubmission 5.4.1 max.xml" },
  },
  claimsExperience: {
    name: "claimsExperience", label: "Claims Experience", subProcessName: "claimsExperience", processStatus: "closed", defaultVersion: "5.4.1",
    sample: { policyNumber: "CH-MOT-887421", period: "2021-2025", claimsCount: 2, totalPaid: 13400, currency: "CHF" },
    legacyXsd: { tag: "claimsExperience-v5.4.1", xsdFile: "claimsExperienceRequest_V5.4.1.xsd", rootElementName: "claimsExperienceRequest", sampleFile: "testfile claimsExperienceRequest 5.4.1.xml" },
  },
  "claimsExperience.nlpi": {
    name: "claimsExperience.nlpi", label: "Claims Experience NLPI", subProcessName: "claimsExperience", processStatus: "active", defaultVersion: "1.0.0",
    sample: { policyNumber: "CH-MOT-887421", period: "2021-2025", claimsCount: 2, totalPaid: 13400, currency: "CHF" },
  },
};

/** raw.githubusercontent.com base for a legacy XSD process's pinned tag. */
export function legacyStandardsBase(def: LegacyXsdDef): string {
  return `https://raw.githubusercontent.com/EcoHub-AG/Standards/refs/tags/${def.tag}/schemas/legacy/5.4.1`;
}

/** targetNamespace shared by all IG B2B 5.4.1 legacy XSDs (invoice/commission/contract/mandate/claimsExperience). */
export const LEGACY_XSD_NAMESPACE = "http://www.IGB2B.ch/XMLSchema";

export const ALL_PROCESS_NAMES = Object.keys(PROCESSES) as ProcessName[];
export const isProcessName = (s: string): s is ProcessName => s in PROCESSES;

// Enum hints + wide fields for the nested form editor (FormTree).
export const ENUMS: Record<string, string[]> = {
  productLine: ["motor", "household", "liability", "legalProtection", "travel"],
  currency: ["CHF", "EUR", "USD"],
  country: ["CH", "DE", "FR", "IT", "AT", "LI"],
  companyLegalForm: ["Association", "AG / SA", "GmbH / Sàrl", "Sole proprietorship", "Cooperative", "Foundation"],
  companyLegalStatus: ["Active", "Inactive", "In liquidation"],
};
export const WIDE_KEYS = ["description", "reason", "note"];

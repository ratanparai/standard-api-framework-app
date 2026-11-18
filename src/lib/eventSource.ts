// CloudEvents `source` for every event this build sends (data, generic, IDS,
// inquiry, error and acknowledgement). The Api-Specs `sourcedef` says it must
// uniquely identify the producer, so this EHP fork uses its own value. EHP's
// inbound intake stores it, which makes events sent with the fork easy to tell
// apart from events sent with the official EcoHub SAF Testing Tool.
export const EVENT_SOURCE = "http://www.myecohub.ch/ehp/ratan/saf-testing-tool";

/** The one visible identity for notices produced by bus extensions and built-in services. */
export const SYSTEM_AGENT_ID = "system";

/** Internal source agents kept for compatibility and reply delivery, but hidden behind @system in participant lists. */
export const SYSTEM_SOURCE_AGENT_IDS = ["status", "task", "resources"] as const;

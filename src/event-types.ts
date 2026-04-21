/** Attribute dimensions extracted per event during compression. */
export type EventAttributes = {
  /** What entity this event is about (project, system, module, concept, person). */
  subject: string;
  /** Event category (software development, investigation, decision, discussion, etc.). */
  type: string;
  /** Application context/domain (production, tech selection, client engagement, etc.). */
  scenario: string;
};

/** A single event extracted from one compressed window. */
export type EventSummary = {
  /** Narrative description of what happened. */
  content: string;
  /** Extracted attribute values across predefined dimensions. */
  attributes: EventAttributes;
  /** Source summary file, e.g. "summaries/2026-04-21-0.md". */
  sourceSummary: string;
  /** Message range [start, end) within the session. */
  messageRange: [number, number];
  /** Unix timestamp. */
  timestamp: number;
};

/** A persistent event document stored as events/evt-<hash>.md. */
export type EventDocument = {
  /** "evt-<hash>", matches the filename stem. */
  id: string;
  /** Human-readable title. */
  title: string;
  /** Attribute values accumulated across all contributing summaries. */
  attributes: EventAttributes;
  /** Ordered list of source summary references. */
  sources: Array<{
    /** e.g. "summaries/2026-04-21-0.md" */
    summaryPath: string;
    messageRange: [number, number];
    timestamp: number;
    snippet: string;
  }>;
  status: "active" | "paused" | "completed" | "abandoned";
  /** Evolving narrative, appended as new summaries match this event. */
  narrative: string;
  createdAt: number;
  lastUpdated: number;
};

/** An entity document (subject / type / scenario) stored as .md. */
export type EntityDocument = {
  dimension: "subject" | "type" | "scenario";
  /** Entity name — also the filename stem. */
  name: string;
  /** LLM-generated description of this entity. */
  description: string;
  /** IDs of events that reference this entity. */
  eventIds: string[];
  /** Links to other entities. */
  relatedEntities: Array<{
    dimension: "subject" | "type" | "scenario";
    name: string;
  }>;
  createdAt: number;
  lastUpdated: number;
};

/** In-memory event index for a session. */
export type EventIndex = {
  documents: Map<string, EventDocument>;
  entities: Map<string, EntityDocument>; // key = "dimension:name"
  processedSummaries: Set<string>;
};

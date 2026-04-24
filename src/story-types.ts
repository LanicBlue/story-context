/** Attribute dimensions extracted per story during compression. */
export type StoryAttributes = {
  /** What entity this story is about (project, system, module, concept, person). */
  subject: string;
  /** Story category (software development, investigation, decision, discussion, etc.). */
  type: string;
  /** Application context/domain (production, tech selection, client engagement, etc.). */
  scenario: string;
};

/** A single story extracted from one compressed window. */
export type StorySummary = {
  /** Narrative description of what happened. */
  content: string;
  /** Extracted attribute values across predefined dimensions. */
  attributes: StoryAttributes;
  /** Source summary file, e.g. "summaries/2026-04-21-0.md". */
  sourceSummary: string;
  /** Message range [start, end) within the session. */
  messageRange: [number, number];
  /** Unix timestamp. */
  timestamp: number;
};

/** A persistent story document stored as stories/story-<hash>.md. */
export type StoryDocument = {
  /** "story-<hash>", matches the filename stem. */
  id: string;
  /** Human-readable title. */
  title: string;
  /** Attribute values accumulated across all contributing summaries. */
  attributes: StoryAttributes;
  /** Ordered list of source summary references. */
  sources: Array<{
    /** e.g. "summaries/2026-04-21-0.md" */
    summaryPath: string;
    messageRange: [number, number];
    timestamp: number;
    snippet: string;
  }>;
  status: "active" | "paused" | "completed" | "abandoned";
  /** Evolving narrative, appended as new summaries match this story. */
  narrative: string;
  /** Active until this turn number (0 = inactive). Reset on create/update. */
  activeUntilTurn: number;
  /** Last turn number when this story was edited. */
  lastEditedTurn: number;
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
  /** IDs of stories that reference this entity. */
  storyIds: string[];
  /** Links to other entities. */
  relatedEntities: Array<{
    dimension: "subject" | "type" | "scenario";
    name: string;
  }>;
  createdAt: number;
  lastUpdated: number;
};

/** In-memory story index for a session. */
export type StoryIndex = {
  documents: Map<string, StoryDocument>;
  entities: Map<string, EntityDocument>; // key = "dimension:name"
  processedSummaries: Set<string>;
};

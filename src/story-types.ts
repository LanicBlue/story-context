/** Attribute dimensions for each story. */
export type StoryAttributes = {
  /** The subject entity (person, project, device, book, etc.). */
  subject: string;
  /** Subject type: person, software-project, book, event, device, workflow, tool, topic, organization, dataset. */
  type: string;
  /** What happened or what was done (free-form description). */
  scenario: string;
};

/** A persistent story document stored as stories/story-<hash>.md. */
export type StoryDocument = {
  /** "story-<hash>", matches the filename stem. */
  id: string;
  /** Human-readable title. */
  title: string;
  /** Attribute values. */
  attributes: StoryAttributes;
  /** Source message ranges that contributed to this story. */
  sources: Array<{
    messageRange: [number, number];
    timestamp: number;
    snippet: string;
  }>;
  status: "active";
  /** Evolving narrative, appended as inner turn updates. */
  narrative: string;
  /** Active until this turn number (0 = inactive). Reset on create/update. */
  activeUntilTurn: number;
  /** Last turn number when this story was edited. */
  lastEditedTurn: number;
  createdAt: number;
  lastUpdated: number;
};

/** An entity document (subject / type / scenario). */
export type EntityDocument = {
  dimension: "subject" | "type" | "scenario";
  /** Entity name — also the filename stem. */
  name: string;
  /** LLM-generated description of this entity. */
  description: string;
  /** IDs of stories that reference this entity. */
  storyIds: string[];
  createdAt: number;
  lastUpdated: number;
};

/** In-memory story index for a session. */
export type StoryIndex = {
  documents: Map<string, StoryDocument>;
  entities: Map<string, EntityDocument>; // key = "dimension:name"
};

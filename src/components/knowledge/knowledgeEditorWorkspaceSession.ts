import type { Text } from "@codemirror/state";
import { markdownEditorTextFromString } from "../ui/markdown-editor/markdownEditorDocumentChange";
import type {
  KnowledgeDirectoryConfig,
  KnowledgeDirectoryConfigRecord,
  KnowledgeDocument,
  KnowledgeDocumentSection,
} from "../../types";
import type { WorkspaceRef } from "../../services/project";
import { documentSessionKey } from "../../document/documentIdentity";
import type { KnowledgeTextConflict } from "./knowledgeCollaborativeEditing";
import { createKnowledgeEditorDraftValues } from "./knowledgeEditorDrafts";
import { KnowledgeEditorSessionCache } from "./knowledgeEditorSessionCache";
import { MarkdownEditorSessionCache } from "../ui/markdown-editor/markdownEditorSessionCache";

export type KnowledgeEditorDraftValues = ReturnType<typeof createKnowledgeEditorDraftValues>;
export type KnowledgeSectionConflicts = Record<
  KnowledgeDocumentSection,
  KnowledgeTextConflict[]
>;
export type DirectoryMarkdownField = "summary" | "maintenanceRules";

export interface KnowledgeDocumentEditorSession {
  drafts: KnowledgeEditorDraftValues;
  baseDrafts: KnowledgeEditorDraftValues;
  conflictResolutionDrafts: KnowledgeEditorDraftValues;
  dirtySections: Set<KnowledgeDocumentSection>;
  sectionConflicts: KnowledgeSectionConflicts;
  saveBlockedSections: Set<KnowledgeDocumentSection>;
  sectionTextBuffers: Map<KnowledgeDocumentSection, Text>;
  baseSectionTexts: Map<KnowledgeDocumentSection, Text>;
  fileNameDraft: string;
  fileNameDirty: boolean;
  saveRevision: number;
}

export interface KnowledgeDirectoryEditorSession {
  draft: KnowledgeDirectoryConfig;
  baseDraft: KnowledgeDirectoryConfig;
  markdownTextBuffers: Map<DirectoryMarkdownField, Text>;
  markdownBaseTexts: Map<DirectoryMarkdownField, Text>;
  markdownDirtyFields: Set<DirectoryMarkdownField>;
  submittedDraft: KnowledgeDirectoryConfig | null;
  dirty: boolean;
}

export type SavedKnowledgeDocumentSession = Omit<KnowledgeDocumentEditorSession,
  "dirtySections" | "saveBlockedSections" | "sectionTextBuffers" | "baseSectionTexts"> & {
    dirtySections: KnowledgeDocumentSection[];
    saveBlockedSections: KnowledgeDocumentSection[];
  };

export function serializeKnowledgeDocumentSession(session: KnowledgeDocumentEditorSession): SavedKnowledgeDocumentSession {
  const { sectionTextBuffers: _text, baseSectionTexts: _base, dirtySections, saveBlockedSections, ...values } = session;
  return JSON.parse(JSON.stringify({ ...values, dirtySections: [...dirtySections], saveBlockedSections: [...saveBlockedSections] }));
}

export function deserializeKnowledgeDocumentSession(saved: SavedKnowledgeDocumentSession): KnowledgeDocumentEditorSession {
  const sections = ["summary", "maintenanceRules", "body"] as const;
  return { ...saved,
    dirtySections: new Set(saved.dirtySections), saveBlockedSections: new Set(saved.saveBlockedSections),
    sectionTextBuffers: new Map(sections.map(section => [section, markdownEditorTextFromString(saved.drafts[section])])),
    baseSectionTexts: new Map(sections.map(section => [section, markdownEditorTextFromString(saved.baseDrafts[section])])),
  };
}

export function knowledgeDocumentEditorSessionKey(
  workspaceRef: WorkspaceRef | null | undefined,
  document: KnowledgeDocument | null | undefined,
): string {
  if (!document) return "";
  return documentSessionKey(workspaceRef, [
    "document",
    document.type,
    document.id || document.path,
  ]);
}

export function knowledgeDirectoryEditorSessionKey(
  workspaceRef: WorkspaceRef | null | undefined,
  directory: KnowledgeDirectoryConfigRecord | null | undefined,
): string {
  if (!directory) return "";
  return documentSessionKey(workspaceRef, [
    "directory",
    directory.type,
    directory.path,
  ]);
}

export class KnowledgeEditorWorkspaceSessionStore {
  readonly documents: KnowledgeEditorSessionCache<KnowledgeDocumentEditorSession>;
  readonly directories: KnowledgeEditorSessionCache<KnowledgeDirectoryEditorSession>;
  readonly markdownEditors: MarkdownEditorSessionCache;

  constructor(
    documentCapacity = 24,
    directoryCapacity = 24,
    markdownEditorCapacity = 96,
  ) {
    this.documents = new KnowledgeEditorSessionCache(
      documentCapacity,
      (session) =>
        session.dirtySections.size === 0
        && session.saveBlockedSections.size === 0
        && !session.fileNameDirty
        && !Object.values(session.sectionConflicts).some((items) => items.length > 0),
    );
    this.directories = new KnowledgeEditorSessionCache(
      directoryCapacity,
      (session) => !session.dirty,
    );
    this.markdownEditors = new MarkdownEditorSessionCache(markdownEditorCapacity);
  }
}

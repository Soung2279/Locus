import type { WorkspaceRef } from "../../services/project";
import type { ViewPackageSummary } from "../../services/view";

export type ViewResourceAction = "rename" | "configure" | "unity" | "export" | "reveal" | "copy" | "delete";
export interface ViewResourceTarget { view: ViewPackageSummary; workspaceRef: WorkspaceRef; }

import { t } from "../i18n";

export function documentSaveStatus(saving: boolean, dirty: boolean): string {
  return t(saving ? "knowledge.editor.saving" : dirty ? "knowledge.editor.unsaved" : "knowledge.editor.saved");
}

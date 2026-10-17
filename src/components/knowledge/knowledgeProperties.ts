// Knowledge configuration has dedicated controls and cannot be overwritten by custom properties.
export const KNOWLEDGE_RESERVED_PROPERTY_KEYS = [
  "scope",
  "id", "type", "path", "title", "bodyFormat", "injectMode", "injectAgents", "inheritInjectMode",
  "summaryEnabled", "summaryCache", "summary", "commandEnabled", "readOnly", "aiEditMode",
  "aiMaintained", "inheritAiConfig", "explicitMaintenanceRules", "maintenanceRulesCache",
  "maintenanceRules", "externalSource", "skillEnabled", "skillSurface", "commandTrigger",
  "argumentHint", "tools", "createdAt", "updatedAt",
] as const;

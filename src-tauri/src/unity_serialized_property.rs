use serde::{Deserialize, Serialize};

use crate::view::{
    UnitySerializedPropertyApplyResult, UnitySerializedPropertyDiscoverResult,
    UnitySerializedPropertyReadResult, UnitySerializedPropertyTarget,
    UnitySerializedPropertyWriteResult,
};

pub mod property_tree;
pub mod objects;
#[cfg(test)]
mod wire_tests;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitySerializedPropertyReadRequest {
    #[serde(default)]
    pub array_offset: Option<i32>,
    #[serde(default)]
    pub binding_id: Option<String>,
    pub target: UnitySerializedPropertyTarget,
    #[serde(default)]
    pub max_depth: Option<i32>,
    #[serde(default)]
    pub max_array_items: Option<i32>,
    #[serde(default)]
    pub auto_expand_char_limit: Option<i32>,
    #[serde(default)]
    pub hierarchy_fields: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitySerializedPropertyDiscoverRequest {
    #[serde(default)]
    pub binding_id: Option<String>,
    pub target: UnitySerializedPropertyTarget,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub field_name: Option<String>,
    #[serde(default)]
    pub field_type: Option<String>,
    #[serde(default)]
    pub match_fields: Option<Vec<String>>,
    #[serde(default)]
    pub max_depth: Option<i32>,
    #[serde(default)]
    pub max_results: Option<i32>,
    #[serde(default)]
    pub include_all: Option<bool>,
    #[serde(default)]
    pub shallow_path_matches: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitySerializedPropertyWriteRequest {
    #[serde(default)]
    pub binding_id: Option<String>,
    pub target: UnitySerializedPropertyTarget,
    pub value: serde_json::Value,
    #[serde(default)]
    pub write_mode: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitySerializedPropertyApplyWrite {
    #[serde(default)]
    pub binding_id: Option<String>,
    pub target: UnitySerializedPropertyTarget,
    pub value: serde_json::Value,
    #[serde(default)]
    pub write_mode: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitySerializedPropertyApplyRequest {
    pub writes: Vec<UnitySerializedPropertyApplyWrite>,
}

pub async fn read(
    working_dir: &str,
    request: UnitySerializedPropertyReadRequest,
) -> Result<UnitySerializedPropertyReadResult, String> {
    validate_object_target(&request.target)?;
    let schema = load_schema_for_target(working_dir, &request.target).await;
    let schema_mode = if schema.is_some() { "dynamic" } else { "full" };
    let hierarchy_fields = request.hierarchy_fields.clone();
    let mut payload = serde_json::json!({
        "bindingId": request.binding_id,
        "target": request.target,
        "maxDepth": request.max_depth.unwrap_or_default(),
        "maxArrayItems": request.max_array_items.unwrap_or_default(),
        "arrayOffset": request.array_offset.unwrap_or_default(),
        "autoExpandCharLimit": request.auto_expand_char_limit.unwrap_or_default(),
        "schemaMode": schema_mode,
    });
    if let Some(hierarchy_fields) = hierarchy_fields {
        payload["hierarchyFields"] = serde_json::json!(hierarchy_fields);
    }
    let raw = crate::unity_bridge::property_tree_read(working_dir, &payload).await?;
    let mut result: UnitySerializedPropertyReadResult = serde_json::from_str(&raw)
        .map_err(|error| format!("Invalid unity_serialized_property_read response: {}", error))?;
    if let Some(schema) = schema {
        schema.enrich_read_result(&mut result);
    }
    Ok(result)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitySerializedPropertyReadManyRequest {
    pub reads: Vec<UnitySerializedPropertyReadRequest>,
}

/// One workspace admission and one Editor turn. Item failures remain local;
/// schema enrichment is identical to the single-read path.
pub async fn read_many(
    working_dir: &str,
    request: UnitySerializedPropertyReadManyRequest,
) -> Result<Vec<UnitySerializedPropertyReadResult>, String> {
    if request.reads.is_empty() || request.reads.len() > 32 {
        return Err("Property read batch requires 1 to 32 requests.".into());
    }
    let index = crate::unity_serialized_schema::try_load_current_schema(working_dir).await;
    let mut payloads = Vec::with_capacity(request.reads.len());
    let mut schemas = Vec::with_capacity(request.reads.len());
    let mut slots: Vec<Option<UnitySerializedPropertyReadResult>> = vec![None; request.reads.len()];
    let mut positions = Vec::new();
    for (position, read) in request.reads.iter().enumerate() {
        if let Err(message) = validate_object_target(&read.target) {
            slots[position] = Some(UnitySerializedPropertyReadResult {
                ok: false, message, binding_id: read.binding_id.clone(), target: read.target.clone(),
                property: crate::view::UnitySerializedPropertySnapshot::default(), properties: vec![],
            });
            continue;
        }
        positions.push(position);
        let schema = index.as_ref().filter(|schema|
            !crate::unity_serialized_schema::target_is_static_schema_excluded(&read.target)
                && schema.can_enrich_target(&read.target));
        payloads.push(serde_json::json!({
            "bindingId":read.binding_id,"target":read.target,
            "maxDepth":read.max_depth.unwrap_or_default(),
            "maxArrayItems":read.max_array_items.unwrap_or_default(),
            "arrayOffset":read.array_offset.unwrap_or_default(),
            "autoExpandCharLimit":read.auto_expand_char_limit.unwrap_or_default(),
            "hierarchyFields":read.hierarchy_fields,
            "schemaMode":if schema.is_some() {"dynamic"} else {"full"},
        }));
        schemas.push(schema);
    }
    if payloads.is_empty() { return Ok(slots.into_iter().flatten().collect()); }
    let raw = match crate::unity_bridge::property_tree_read_many(working_dir, &serde_json::json!({"reads":payloads})).await {
        Ok(raw) => raw,
        Err(error) if error.contains("unknown message type: property_tree_read_many") => {
            // Read-only compatibility for an older installed bridge. Never retry
            // timeouts/connection failures or change the selected data backend.
            let mut results = Vec::with_capacity(payloads.len());
            for payload in &payloads {
                let result = match crate::unity_bridge::property_tree_read(working_dir, payload).await {
                    Ok(raw) => serde_json::from_str::<serde_json::Value>(&raw).map_err(|e| e.to_string())?,
                    Err(message) => serde_json::json!({"ok":false,"message":message,"target":payload["target"],"bindingId":payload["bindingId"]}),
                };
                results.push(result);
            }
            serde_json::json!({"results":results}).to_string()
        }
        Err(error) => return Err(error),
    };
    #[derive(Deserialize)]
    struct Response { results: Vec<UnitySerializedPropertyReadResult> }
    let mut response: Response = serde_json::from_str(&raw).map_err(|e| format!("Invalid property read batch: {e}"))?;
    if response.results.len() != schemas.len() { return Err("Property read batch result count mismatch.".into()); }
    for (result, schema) in response.results.iter_mut().zip(schemas) {
        if result.ok { if let Some(schema) = schema { schema.enrich_read_result(result); } }
    }
    for (position, result) in positions.into_iter().zip(response.results) { slots[position] = Some(result); }
    Ok(slots.into_iter().flatten().collect())
}

pub async fn discover(
    working_dir: &str,
    request: UnitySerializedPropertyDiscoverRequest,
) -> Result<UnitySerializedPropertyDiscoverResult, String> {
    validate_object_target(&request.target)?;
    let schema = load_schema_for_target(working_dir, &request.target).await;
    let filters = crate::unity_serialized_schema::DiscoverFilters {
        query: request.query.clone(),
        field_name: request.field_name.clone(),
        field_type: request.field_type.clone(),
        max_results: request.max_results,
    };
    let include_all = request.include_all.unwrap_or(false)
        || (schema.is_some() && !discover_has_filters(&filters));
    let schema_mode = if include_all { "dynamic" } else { "full" };
    let unity_max_results = if include_all {
        request.max_results.unwrap_or_default().max(5000)
    } else {
        request.max_results.unwrap_or_default()
    };
    let payload = serde_json::json!({
        "bindingId": request.binding_id,
        "target": request.target,
        "query": if include_all { String::new() } else { request.query.unwrap_or_default() },
        "fieldName": if include_all { String::new() } else { request.field_name.unwrap_or_default() },
        "fieldType": if include_all { String::new() } else { request.field_type.unwrap_or_default() },
        "matchFields": request.match_fields.unwrap_or_default(),
        "maxDepth": request.max_depth.unwrap_or_default(),
        "maxResults": unity_max_results,
        "includeAll": include_all,
        "shallowPathMatches": request.shallow_path_matches.unwrap_or(false),
        "schemaMode": schema_mode,
    });
    let raw = crate::unity_bridge::property_tree_discover(working_dir, &payload).await?;
    let mut result: UnitySerializedPropertyDiscoverResult =
        serde_json::from_str(&raw).map_err(|error| {
            format!(
                "Invalid unity_serialized_property_discover response: {}",
                error
            )
        })?;
    if include_all {
        if let Some(schema) = schema {
            schema.enrich_discover_result(&mut result, &filters);
        }
    }
    Ok(result)
}

pub async fn write(
    working_dir: &str,
    request: UnitySerializedPropertyWriteRequest,
) -> Result<UnitySerializedPropertyWriteResult, String> {
    validate_property_target(&request.target)?;
    let schema = load_schema_for_target(working_dir, &request.target).await;
    let schema_mode = if schema.is_some() { "dynamic" } else { "full" };
    let value_json = serde_json::to_string(&request.value)
        .map_err(|error| format!("Failed to serialize serialized property value: {}", error))?;
    let payload = serde_json::json!({
        "bindingId": request.binding_id,
        "target": request.target,
        "valueJson": value_json,
        "mode": normalize_write_mode(request.write_mode.as_deref())?,
        "schemaMode": schema_mode,
    });
    let raw = crate::unity_bridge::property_tree_write(working_dir, &payload).await?;
    let mut result: UnitySerializedPropertyWriteResult =
        serde_json::from_str(&raw).map_err(|error| {
            format!(
                "Invalid unity_serialized_property_write response: {}",
                error
            )
        })?;
    if let Some(schema) = schema {
        if schema.can_enrich_target(&result.read.target) {
            schema.enrich_read_result(&mut result.read);
        }
    }
    Ok(result)
}

pub async fn apply(
    working_dir: &str,
    request: UnitySerializedPropertyApplyRequest,
) -> Result<UnitySerializedPropertyApplyResult, String> {
    for write in &request.writes {
        validate_property_target(&write.target)?;
    }
    let schema = if request.writes.iter().any(|write| {
        !crate::unity_serialized_schema::target_is_static_schema_excluded(&write.target)
    }) {
        crate::unity_serialized_schema::try_load_current_schema(working_dir).await
    } else {
        None
    };
    let mut writes = Vec::with_capacity(request.writes.len());
    for write in request.writes {
        let value_json = serde_json::to_string(&write.value)
            .map_err(|error| format!("Failed to serialize serialized property value: {}", error))?;
        let schema_mode = if schema
            .as_ref()
            .map(|schema| schema.can_enrich_target(&write.target))
            .unwrap_or(false)
        {
            "dynamic"
        } else {
            "full"
        };
        writes.push(serde_json::json!({
            "bindingId": write.binding_id,
            "target": write.target,
            "valueJson": value_json,
            "mode": normalize_write_mode(write.write_mode.as_deref())?,
            "schemaMode": schema_mode,
        }));
    }
    let payload = serde_json::json!({ "writes": writes });
    let raw = crate::unity_bridge::property_tree_apply(working_dir, &payload).await?;
    let mut result: UnitySerializedPropertyApplyResult =
        serde_json::from_str(&raw).map_err(|error| {
            format!(
                "Invalid unity_serialized_property_apply response: {}",
                error
            )
        })?;
    if let Some(schema) = schema {
        for item in &mut result.results {
            if schema.can_enrich_target(&item.read.target) {
                schema.enrich_read_result(&mut item.read);
            }
        }
    }
    Ok(result)
}

async fn load_schema_for_target(
    working_dir: &str,
    target: &UnitySerializedPropertyTarget,
) -> Option<std::sync::Arc<crate::unity_serialized_schema::SerializedSchemaIndex>> {
    if crate::unity_serialized_schema::target_is_static_schema_excluded(target) {
        return None;
    }
    let schema = crate::unity_serialized_schema::try_load_current_schema(working_dir).await;
    schema.filter(|schema| schema.can_enrich_target(target))
}

fn discover_has_filters(filters: &crate::unity_serialized_schema::DiscoverFilters) -> bool {
    filters
        .query
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some()
        || filters
            .field_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some()
        || filters
            .field_type
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some()
}

fn normalize_write_mode(mode: Option<&str>) -> Result<&'static str, String> {
    match mode
        .unwrap_or("commit")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "" | "commit" => Ok("commit"),
        "preview" => Ok("preview"),
        other => Err(format!(
            "Unsupported Unity serialized property write mode: {}",
            other
        )),
    }
}

fn validate_property_target(target: &UnitySerializedPropertyTarget) -> Result<(), String> {
    validate_object_target(target)?;
    if target
        .property_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        return Err("Unity serialized property target propertyPath is required.".to_string());
    }
    Ok(())
}

fn validate_object_target(target: &UnitySerializedPropertyTarget) -> Result<(), String> {
    let kind = target.kind.trim();
    if kind.is_empty() {
        return Err("Unity serialized property target kind cannot be empty.".to_string());
    }
    // Asset targets are meaningless without a locator; reject early instead of
    // round-tripping to the Unity bridge. Other kinds (e.g. selection-relative
    // component targets) may legitimately omit every path field.
    if kind.eq_ignore_ascii_case("asset") {
        let has_locator = [target.guid.as_deref(), target.path.as_deref()]
            .into_iter()
            .flatten()
            .any(|value| !value.trim().is_empty());
        if !has_locator {
            return Err(
                "Unity serialized property asset target requires a path or guid.".to_string(),
            );
        }
    }
    if matches!(target.component_index, Some(index) if index < 0) {
        return Err(
            "Unity serialized property target componentIndex cannot be negative.".to_string(),
        );
    }
    for path in [
        target.guid.as_deref(),
        target.path.as_deref(),
        target.scene_path.as_deref(),
        target.object_path.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if path.contains('\0') {
            return Err(
                "Unity serialized property target path contains an invalid character.".to_string(),
            );
        }
    }
    Ok(())
}

// Frozen pre-fix algorithm, used only by differential tests and benchmarks.
use super::*;
use std::{future::Future, pin::Pin};

pub(super) fn recursive<'a, F, Fut>(
    source: UnitySerializedPropertySnapshot,
    semantic_path: String,
    depth: usize,
    array_limit: usize,
    canonical: &'a mut HashMap<String, String>,
    read_target: &'a mut F,
) -> Pin<Box<dyn Future<Output = Result<UnitySerializedPropertySnapshot, String>> + Send + 'a>>
where
    F: FnMut(UnitySerializedPropertyTarget, usize) -> Fut + Send + 'a,
    Fut: Future<Output = Result<UnitySerializedPropertySnapshot, String>> + Send + 'a,
{
    Box::pin(async move {
        let mut projected = source;
        projected.semantic_path = semantic_path.clone();
        projected.canonical_path.clear();

        let mut content_children = projected.children.clone();
        let mut content_has_children = projected.has_children;
        let mut content_is_array = projected.is_array;
        let mut content_array_size = projected.array_size;
        let mut content_is_object_root = projected.property_path.is_empty();
        if content_is_object_root {
            if let Some(component_target) = projected
                .binding_target
                .as_ref()
                .filter(|target| target.kind.eq_ignore_ascii_case("component"))
            {
                if let Some(identity) = target_identity(component_target) {
                    if let Some(first_path) = canonical.get(&identity) {
                        if first_path != &semantic_path {
                            projected.node_kind = "reference".to_string();
                            projected.canonical_path = first_path.clone();
                            projected.children.clear();
                            projected.visible_child_count = 0;
                            projected.children_truncated = false;
                            projected.has_children = false;
                            return Ok(projected);
                        }
                    }
                    canonical.entry(identity).or_insert(semantic_path.clone());
                }
            }
        }
        if projected.is_managed_reference && projected.managed_reference_id > 0 {
            let owner = projected
                .binding_target
                .as_ref()
                .and_then(target_identity)
                .unwrap_or_else(|| "selection#0".to_string());
            let identity = format!("{}#managed:{}", owner, projected.managed_reference_id);
            if let Some(first_path) = canonical.get(&identity) {
                if first_path != &semantic_path {
                    projected.canonical_path = first_path.clone();
                    projected.children.clear();
                    projected.visible_child_count = 0;
                    projected.children_truncated = false;
                    projected.has_children = false;
                    return Ok(projected);
                }
            }
            canonical.insert(identity, semantic_path.clone());
            projected.node_kind = "reference".to_string();
        }
        if let Some(reference_target) = projected.reference_target.clone() {
            if let Some(identity) = target_identity(&reference_target) {
                if let Some(first_path) = canonical.get(&identity) {
                    if first_path != &semantic_path {
                        projected.canonical_path = first_path.clone();
                        projected.children.clear();
                        projected.visible_child_count = 0;
                        projected.children_truncated = false;
                        projected.has_children = false;
                        return Ok(projected);
                    }
                }
                canonical.insert(identity, semantic_path.clone());
            }

            if depth > 0 {
                let referenced = read_target(reference_target, depth).await?;
                projected.node_kind = "reference".to_string();
                projected.property_type = referenced.property_type.clone();
                projected.value_type = referenced.value_type.clone();
                projected.field_type_full_name = referenced.field_type_full_name.clone();
                projected.field_type_assembly = referenced.field_type_assembly.clone();
                projected.subassets = referenced.subassets;
                projected.display_sections = referenced.display_sections;
                content_children = referenced.children;
                content_has_children = referenced.has_children;
                content_is_array = referenced.is_array;
                content_array_size = referenced.array_size;
                content_is_object_root = referenced.property_path.is_empty();
            }
        }

        // Unity exposes vectors, quaternions, colors, bounds, curves, and
        // gradients as properties with visible implementation children.  The
        // shared Property Tree treats those values as semantic atoms: their
        // snapshot already carries the complete editable value and a compact
        // display string, while expanding x/y/z or keyframe internals only
        // adds latency and makes them look like arrays to the agent.
        if is_compact_unity_value(&projected) {
            content_children.clear();
            content_has_children = false;
            content_is_array = false;
            content_array_size = -1;
            content_is_object_root = false;
            projected.children_truncated = false;
        }

        projected.has_children = content_has_children || !content_children.is_empty();
        projected.is_array = content_is_array;
        projected.array_size = content_array_size;
        projected.children.clear();
        if depth == 0 {
            projected.children_truncated = projected.has_children;
            projected.visible_child_count = 0;
            return Ok(projected);
        }

        content_children
            .retain(|child| !(content_is_object_root && is_root_metadata_name(&child.name)));
        let names = live_child_names_from_children(&projected, &content_children);
        let total = content_children.len();
        let limit = if projected.is_array {
            total.min(array_limit)
        } else {
            total
        };
        for (index, mut child) in content_children.into_iter().take(limit).enumerate() {
            let name = names
                .get(index)
                .cloned()
                .unwrap_or_else(|| child.name.clone());
            child.name = name.clone();
            let child_path = append_path_segment(&semantic_path, &name);
            projected.children.push(
                recursive(
                    child,
                    child_path,
                    depth - 1,
                    array_limit,
                    canonical,
                    read_target,
                )
                .await?,
            );
        }
        projected.visible_child_count = projected.children.len() as i32;
        projected.children_truncated = projected.children_truncated || limit < total;
        Ok(projected)
    })
}

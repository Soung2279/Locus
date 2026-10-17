//! Ownership-preserving DFS. Keep only unfinished parents on the heap instead
//! of allocating and polling a recursive Future for every snapshot node.
use super::{
    append_path_segment, is_compact_unity_value, is_root_metadata_name,
    live_child_names_from_children, target_identity, UnitySerializedPropertySnapshot,
    UnitySerializedPropertyTarget,
};
use std::{collections::HashMap, future::Future};

struct Frame {
    node: UnitySerializedPropertySnapshot,
    children: std::vec::IntoIter<UnitySerializedPropertySnapshot>,
    depth: usize,
}

/// The reader is injected so both immediately-ready snapshots and real async
/// reads exercise exactly the same traversal, canonicalization and limits.
pub(super) async fn project<F, Fut>(
    source: UnitySerializedPropertySnapshot,
    semantic_path: String,
    depth: usize,
    array_limit: usize,
    canonical: &mut HashMap<String, String>,
    mut read_target: F,
) -> Result<UnitySerializedPropertySnapshot, String>
where
    F: FnMut(UnitySerializedPropertyTarget, usize) -> Fut,
    Fut: Future<Output = Result<UnitySerializedPropertySnapshot, String>>,
{
    // Lazy allocation keeps scalar and depth-zero reads allocation-free here.
    let mut parents: Vec<Frame> = Vec::new();
    let mut node = source;
    node.semantic_path = semantic_path;
    let mut remaining = depth;

    'visit: loop {
        node.canonical_path.clear();
        if register_node(&mut node, canonical) {
            let mut children = std::mem::take(&mut node.children);
            let mut object_root = node.property_path.is_empty();
            if remaining > 0 {
                if let Some(target) = node.reference_target.clone() {
                    // One allocation per actual Editor read, never per node.
                    // Do not embed the large bridge Future in the DFS poll frame.
                    let referenced = Box::pin(read_target(target, remaining)).await?;
                    node.node_kind = "reference".to_string();
                    node.property_type = referenced.property_type;
                    node.value_type = referenced.value_type;
                    node.field_type_full_name = referenced.field_type_full_name;
                    node.field_type_assembly = referenced.field_type_assembly;
                    node.subassets = referenced.subassets;
                    node.display_sections = referenced.display_sections;
                    children = referenced.children;
                    node.has_children = referenced.has_children;
                    node.is_array = referenced.is_array;
                    node.array_size = referenced.array_size;
                    object_root = referenced.property_path.is_empty();
                }
            }

            if is_compact_unity_value(&node) {
                children.clear();
                node.has_children = false;
                node.is_array = false;
                node.array_size = -1;
                node.children_truncated = false;
                object_root = false;
            }
            node.has_children |= !children.is_empty();
            if remaining == 0 {
                node.children_truncated = node.has_children;
            } else if !children.is_empty() {
                children.retain(|child| !(object_root && is_root_metadata_name(&child.name)));
                let names = live_child_names_from_children(&node, &children);
                let total = children.len();
                let limit = if node.is_array {
                    total.min(array_limit)
                } else {
                    total
                };
                node.children_truncated |= limit < total;
                children.truncate(limit);
                for (child, name) in children.iter_mut().zip(names) {
                    child.name = name;
                }
                let mut pending = children.into_iter();
                if let Some(mut child) = pending.next() {
                    child.semantic_path = append_path_segment(&node.semantic_path, &child.name);
                    node.children = Vec::with_capacity(limit);
                    // Grow with actual depth; a depth=16 request may still be
                    // a two-node tree and should not reserve sixteen frames.
                    parents.push(Frame {
                        node,
                        children: pending,
                        depth: remaining,
                    });
                    node = child;
                    remaining -= 1;
                    continue 'visit;
                }
            }
        }

        // Finish a node, then resume its parent in the original DFS order.
        // In particular, the first canonical path must not change with depth.
        loop {
            node.visible_child_count = node.children.len() as i32;
            let Some(parent) = parents.last_mut() else {
                return Ok(node);
            };
            parent.node.children.push(node);
            if let Some(mut child) = parent.children.next() {
                child.semantic_path = append_path_segment(&parent.node.semantic_path, &child.name);
                remaining = parent.depth - 1;
                node = child;
                continue 'visit;
            }
            node = parents.pop().expect("parent exists").node;
        }
    }
}

/// Returns false for an already-addressed object. Register before descending
/// or fetching a reference so cycles and shared objects keep their first path.
fn register_node(
    node: &mut UnitySerializedPropertySnapshot,
    canonical: &mut HashMap<String, String>,
) -> bool {
    if node.property_path.is_empty() {
        if let Some(identity) = node
            .binding_target
            .as_ref()
            .filter(|target| target.kind.eq_ignore_ascii_case("component"))
            .and_then(target_identity)
        {
            if let Some(first) = canonical
                .get(&identity)
                .filter(|path| *path != &node.semantic_path)
            {
                node.node_kind = "reference".to_string();
                mark_reference(node, first);
                return false;
            }
            canonical
                .entry(identity)
                .or_insert_with(|| node.semantic_path.clone());
        }
    }
    if node.is_managed_reference && node.managed_reference_id > 0 {
        let owner = node
            .binding_target
            .as_ref()
            .and_then(target_identity)
            .unwrap_or_else(|| "selection#0".to_string());
        let identity = format!("{}#managed:{}", owner, node.managed_reference_id);
        if let Some(first) = canonical
            .get(&identity)
            .filter(|path| *path != &node.semantic_path)
        {
            mark_reference(node, first);
            return false;
        }
        canonical.insert(identity, node.semantic_path.clone());
        node.node_kind = "reference".to_string();
    }
    if let Some(identity) = node.reference_target.as_ref().and_then(target_identity) {
        if let Some(first) = canonical
            .get(&identity)
            .filter(|path| *path != &node.semantic_path)
        {
            mark_reference(node, first);
            return false;
        }
        canonical.insert(identity, node.semantic_path.clone());
    }
    true
}

fn mark_reference(node: &mut UnitySerializedPropertySnapshot, first: &str) {
    node.canonical_path = first.to_string();
    node.children.clear();
    node.visible_child_count = 0;
    node.children_truncated = false;
    node.has_children = false;
}

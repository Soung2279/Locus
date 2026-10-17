//! Ignore delayed control messages across close/reopen and managed reloads.
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Clone, Default)]
pub(crate) struct UnityEmbedControlRevisionState {
    instance_id: String,
    revision: u64,
    pub(crate) closed: bool,
    retired_instances: VecDeque<String>,
    touched: u64,
}

pub(crate) fn should_ignore(
    states: &mut HashMap<String, UnityEmbedControlRevisionState>,
    label: &str,
    kind: &str,
    instance: &str,
    revision: u64,
) -> bool {
    if revision == 0 || !matches!(kind, "open" | "update" | "close" | "park") { return false; }
    let instance = instance.trim();
    let mut retired = VecDeque::new();
    if let Some(state) = states.get(label) {
        let same = instance.is_empty() || state.instance_id == instance;
        if state.retired_instances.iter().any(|old| old == instance)
            || (same && (state.closed || revision < state.revision))
            || (!same && kind != "open") { return true; }
        retired = state.retired_instances.clone();
        if !same {
            retired.push_back(state.instance_id.clone());
            if retired.len() > 4 { retired.pop_front(); }
        }
    }
    if states.len() >= 256 && !states.contains_key(label) {
        let oldest = states.iter().filter(|(_, state)| state.closed)
            .min_by_key(|(_, state)| state.touched).map(|(label, _)| label.clone());
        if let Some(oldest) = oldest { states.remove(&oldest); }
    }
    static NEXT_TOUCH: AtomicU64 = AtomicU64::new(1);
    states.insert(label.into(), UnityEmbedControlRevisionState {
        instance_id: instance.into(), revision, closed: false, retired_instances: retired,
        touched: NEXT_TOUCH.fetch_add(1, Ordering::Relaxed),
    });
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parking_rejects_geometry_queued_before_the_barrier() {
        let mut states = HashMap::new();
        assert!(!should_ignore(&mut states, "a", "open", "old", 1));
        assert!(!should_ignore(&mut states, "a", "park", "old", 10));
        assert!(should_ignore(&mut states, "a", "update", "old", 9));
        assert!(!should_ignore(&mut states, "a", "close", "old", 11));
    }
    #[test]
    fn closed_instance_cannot_resurrect_or_close_its_replacement() {
        let mut states = HashMap::new();
        should_ignore(&mut states, "a", "open", "old", 1);
        should_ignore(&mut states, "a", "close", "old", 10);
        states.get_mut("a").unwrap().closed = true;
        assert!(should_ignore(&mut states, "a", "open", "old", 1));
        assert!(should_ignore(&mut states, "a", "update", "old", 12));
        assert!(!should_ignore(&mut states, "a", "open", "new", 1));
        assert!(should_ignore(&mut states, "a", "open", "old", 20));
        assert!(should_ignore(&mut states, "a", "park", "old", 20));
        assert!(should_ignore(&mut states, "a", "close", "old", 20));
        assert!(!should_ignore(&mut states, "a", "update", "new", 2));
    }
    #[test]
    fn tombstones_are_bounded_without_evicting_live_instances() {
        let mut states = HashMap::new();
        should_ignore(&mut states, "live", "open", "live", 1);
        for i in 0..1_000 {
            let label = format!("closed-{i}");
            should_ignore(&mut states, &label, "open", &label, 1);
            states.get_mut(&label).unwrap().closed = true;
        }
        assert_eq!(states.len(), 256);
        assert!(states.contains_key("live"));
    }
    #[test]
    fn reload_history_is_bounded_and_other_events_do_not_change_revision() {
        let mut states = HashMap::new();
        for i in 0..32 { should_ignore(&mut states, "a", "open", &i.to_string(), 1); }
        assert_eq!(states["a"].retired_instances.len(), 4);
        assert!(!should_ignore(&mut states, "a", "assetDrop", "31", 50));
        assert_eq!(states["a"].revision, 1);
    }
}

//! RTT of the existing SSH stdio heartbeat, never a separate connection/probe.
use std::collections::VecDeque;
use std::time::{Duration, Instant};

const FRESH_FOR: Duration = Duration::from_secs(15);

#[derive(Default)]
pub(super) struct Heartbeat {
    pending: VecDeque<(u64, Instant)>,
    sample: Option<(u64, f64, Instant)>,
}
impl Heartbeat {
    pub fn sent(&mut self, id: u64, now: Instant) {
        self.pending.push_back((id, now));
        while self.pending.len() > 4 { self.pending.pop_front(); }
    }
    pub fn received(&mut self, id: u64, now: Instant) {
        let Some(index) = self.pending.iter().position(|(pending, _)| *pending == id) else { return; };
        let (_, sent) = self.pending.remove(index).unwrap();
        let elapsed = now.saturating_duration_since(sent);
        if elapsed <= FRESH_FOR && self.sample.is_none_or(|(last, _, _)| id > last) {
            self.sample = Some((id, elapsed.as_secs_f64() * 1000.0, now));
        }
    }
    pub fn latency_ms(&self, now: Instant) -> Option<f64> {
        self.sample.filter(|(_, _, at)| now.saturating_duration_since(*at) < FRESH_FOR).map(|(_, ms, _)| ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn samples_roundtrip_and_discards_unknown_late_and_stale_replies() {
        let now = Instant::now();
        let mut heartbeat = Heartbeat::default();
        heartbeat.received(99, now);
        assert_eq!(heartbeat.latency_ms(now), None);
        heartbeat.sent(1, now);
        heartbeat.sent(2, now + Duration::from_secs(5));
        heartbeat.received(2, now + Duration::from_millis(5042));
        assert_eq!(heartbeat.latency_ms(now + Duration::from_secs(6)), Some(42.0));
        heartbeat.received(1, now + Duration::from_secs(7));
        assert_eq!(heartbeat.latency_ms(now + Duration::from_secs(7)), Some(42.0));
        assert_eq!(heartbeat.latency_ms(now + Duration::from_secs(21)), None);
        heartbeat.sent(3, now);
        heartbeat.received(3, now + Duration::from_secs(22));
        assert_eq!(heartbeat.latency_ms(now + Duration::from_secs(22)), None);
    }
}

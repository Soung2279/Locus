//! Bounded recovery policy; no COM or application state in this module.
use std::collections::VecDeque;
use std::time::{Duration, Instant};

#[derive(Default)]
pub struct RecoveryBudget(VecDeque<Instant>);

impl RecoveryBudget {
    pub fn take(&mut self, now: Instant) -> bool {
        while self
            .0
            .front()
            .is_some_and(|at| now.duration_since(*at) >= Duration::from_secs(60))
        {
            self.0.pop_front();
        }
        if self.0.len() >= 3 {
            return false;
        }
        self.0.push_back(now);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn crash_loop_stops_and_only_expired_attempts_are_replenished() {
        let mut b = RecoveryBudget::default();
        let t = Instant::now();
        for seconds in [0, 10, 20] {
            assert!(b.take(t + Duration::from_secs(seconds)));
        }
        assert!(!b.take(t + Duration::from_secs(59)));
        assert!(b.take(t + Duration::from_secs(60)));
        assert!(!b.take(t + Duration::from_secs(61)));
        assert!(b.take(t + Duration::from_secs(70)));
    }
}

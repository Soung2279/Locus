//! Native adaptation is an execution capability carried by the host future,
//! never a magic JSON argument a model can use to bypass normal tool semantics.
use super::native_tools::NativeCall;
use serde_json::Value;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub(crate) struct NativeInvocation {
    pub call: NativeCall,
    pub session_id: String,
    result: Arc<Mutex<Option<Value>>>,
}
tokio::task_local! { static CURRENT: Option<NativeInvocation>; }
pub(crate) fn current() -> Option<NativeInvocation> {
    NativeInvocation::current()
}
impl NativeInvocation {
    pub fn new(call: NativeCall, session_id: String) -> Self {
        Self {
            call,
            session_id,
            result: Arc::new(Mutex::new(None)),
        }
    }
    pub fn current() -> Option<Self> {
        CURRENT.try_with(Clone::clone).ok().flatten()
    }
    pub fn set_result(&self, result: Value) {
        *self.result.lock().unwrap_or_else(|e| e.into_inner()) = Some(result);
    }
    pub fn result(&self) -> Option<Value> {
        self.result
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    pub async fn run<F: std::future::Future>(&self, future: F) -> F::Output {
        CURRENT.scope(Some(self.clone()), future).await
    }
    pub async fn without<F: std::future::Future>(future: F) -> F::Output {
        CURRENT.scope(None, future).await
    }
}

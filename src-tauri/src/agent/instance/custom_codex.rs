//! API-key Codex gateways share the subscription transport and continuation state.
use super::*;

#[cfg(test)]
#[path = "custom_codex_tests.rs"]
mod tests;

pub(super) struct CustomCodexRoute<'a> {
    pub api_key: &'a str,
    pub model: &'a str,
    pub endpoint: &'a str,
    pub transport: crate::commands::CodexTransportMode,
    pub supports_vision: bool,
}

impl AgentInstance {
    pub(super) fn custom_codex_route(&self) -> Option<CustomCodexRoute<'_>> {
        match &self.backend {
            LlmBackend::Custom {
                api_key,
                api_model,
                endpoint,
                api_format: crate::commands::ApiFormat::OpenaiResponses,
                codex_transport: Some(transport),
                supports_vision,
                ..
            } => Some(CustomCodexRoute {
                api_key,
                model: api_model,
                endpoint,
                transport: *transport,
                supports_vision: *supports_vision,
            }),
            _ => None,
        }
    }

    pub(super) fn codex_protocol_model(&self) -> Option<&str> {
        match &self.backend {
            LlmBackend::OpenAiCodex { .. } => Some(&self.effective_model),
            _ => self.custom_codex_route().map(|route| route.model),
        }
    }

    pub(super) fn uses_codex_protocol(&self) -> bool {
        self.codex_protocol_model().is_some()
    }

    pub(super) async fn call_custom_codex(
        &self,
        route: CustomCodexRoute<'_>,
        store: &SessionStore,
        turn: Option<&mut codex::TurnState>,
        steering: Option<&dyn codex::steering::SteeringSource>,
        request_context: Option<(&str, usize)>,
        options: LlmRequestOptions,
        system_parts: &[&str],
        messages: &[ChatMessage],
        tools: &[serde_json::Value],
        tool_search_description: Option<&str>,
        on_text_delta: impl Fn(String) + Send + Sync + 'static,
        on_thinking_delta: impl Fn(String) + Send + Sync + 'static,
        on_tool_call_start: impl Fn(String, String) + Send + Sync + 'static,
    ) -> Result<LlmCallResult, String> {
        if !route.supports_vision && messages_have_images(messages) {
            return Err(no_vision_endpoint_error());
        }
        let metadata = store.get_response_request_metadata(&self.session_id)?;
        let mut owned_turn = codex::TurnState::default();
        let mut stream_options =
            codex::CodexStreamOptions::default().with_fast_mode(self.codex_fast_mode);
        if let Some((run_id, iteration)) = request_context {
            stream_options = stream_options.with_request_context(run_id, iteration);
        }
        // The gateway owns upstream authentication. Never refresh a local
        // subscription token or retry a gateway 401 using another identity.
        let response = codex::stream_chat_steerable(
            route.api_key,
            None,
            route.transport,
            Some(route.endpoint),
            route.model,
            &system_parts.join("\n\n"),
            messages,
            tools,
            tool_search_description,
            options.thinking_level(self.effort.as_deref()),
            self.debug,
            Some(&self.session_id),
            Some(&metadata),
            turn.unwrap_or(&mut owned_turn),
            stream_options,
            steering,
            &on_text_delta,
            &on_thinking_delta,
            &on_tool_call_start,
        )
        .await?;
        Ok(LlmCallResult {
            text: response.text,
            citations: response.citations,
            tool_calls: response.tool_calls,
            finish_reason: response.finish_reason,
            end_turn: response.end_turn,
            response_id: response.response_id,
            input_tokens: response.input_tokens,
            output_tokens: response.output_tokens,
            cache_read_tokens: response.cache_read_tokens,
            cache_write_tokens: response.cache_write_tokens,
            cost_usd: response.cost_usd,
            raw_request: response.raw_request,
            raw_response: response.raw_response,
            thinking_text: response.thinking_text,
            thinking_duration_secs: response.thinking_duration_secs,
            thinking_signature: response.thinking_signature,
            continuation_request: response.continuation_request,
        })
    }
}

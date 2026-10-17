import { computed, inject, onActivated, onDeactivated, onScopeDispose, shallowRef, toValue, watchEffect, type InjectionKey, type MaybeRefOrGetter, type ComputedRef } from "vue";
import { resolveUnityPropertyTarget } from "../../services/unityPropertyPath";
import type { UnityPropertyPathInput, UnityPropertyRuntime, UnityBoundPropertyRuntimeOptions } from "./unityPropertyBinding";
import type { UnityPropertyResource } from "./unityPropertyResources";

export interface UnityPropertyScopeContext {
  runtime: ComputedRef<UnityPropertyRuntime | undefined>;
  target: ComputedRef<UnityPropertyPathInput | undefined>;
  readonly: ComputedRef<boolean>;
  options: ComputedRef<UnityBoundPropertyRuntimeOptions>;
}
export const UNITY_PROPERTY_SCOPE: InjectionKey<UnityPropertyScopeContext> = Symbol("UnityPropertyScope");

/** A custom control declares its binding, not a request or cache policy. */
export function useUnityPropertyBinding(path: MaybeRefOrGetter<string>, explicit?: MaybeRefOrGetter<UnityPropertyResource | undefined>) {
  const scope = inject(UNITY_PROPERTY_SCOPE, null);
  const binding = shallowRef<UnityPropertyResource | null>(null);
  const failure = shallowRef("");
  let release: (() => void) | undefined;
  let visible = true;
  onDeactivated(() => { visible = false; release?.(); release = undefined; });
  onActivated(() => { if (!visible) { visible = true; release = binding.value?.retain(); } });
  watchEffect(() => {
    const provided = explicit ? toValue(explicit) : undefined;
    const runtime = scope?.runtime.value;
    const input = scope?.target.value;
    let next = provided;
    failure.value = !scope && !provided ? "UnityPropertyField requires a scope or an explicit binding." :
      input && !runtime && !provided ? "Property runtime unavailable; supply runtime outside a View." : "";
    if (!next && runtime && input) {
      try {
        const target = resolveUnityPropertyTarget(input);
        const suffix = toValue(path);
        target.propertyPath = [target.propertyPath, suffix].filter(Boolean).join(".");
        next = runtime.bind(target, scope?.options.value);
      } catch (error) { failure.value = error instanceof Error ? error.message : String(error); }
    }
    if (binding.value === (next ?? null)) return;
    release?.(); binding.value = next ?? null; release = visible ? next?.retain() : undefined;
  });
  onScopeDispose(() => release?.());
  return {
    binding,
    value: computed(() => binding.value?.value),
    loading: computed(() => !binding.value || binding.value.loading),
    error: computed(() => failure.value || binding.value?.error || ""),
    readonly: computed(() => scope?.readonly.value ?? false),
    write: (value: unknown) => {
      if (scope?.readonly.value) return Promise.reject(new Error("Property scope is read-only."));
      if (!binding.value) return Promise.reject(new Error("Property scope target is not ready."));
      return binding.value.write(value);
    },
    refresh: () => binding.value?.refresh(),
  };
}

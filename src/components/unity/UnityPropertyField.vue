<script lang="ts">
import { defineComponent, h, type PropType } from "vue";
import { useUnityPropertyBinding } from "./unityPropertyScope";
import type { UnityPropertyResource } from "./unityPropertyResources";
import type { InspectorPropertyDrawerInput } from "../../services/propertyTree";
import BaseButton from "../ui/BaseButton.vue";
export default defineComponent({
  name: "UnityPropertyField",
  props: {
    path: { type: String, default: "" },
    binding: Object as PropType<UnityPropertyResource>,
    readonly: Boolean,
    disabled: Boolean,
    compact: Boolean,
    showLabel: { type: Boolean, default: true },
    propertyDrawers: { type: null as unknown as PropType<InspectorPropertyDrawerInput>, default: undefined },
  },
  setup(props, { slots }) {
    const field = useUnityPropertyBinding(() => props.path, () => props.binding);
    return () => {
      const resource = field.binding.value;
      if (slots.default) return slots.default({ ...field, binding: resource, value: field.value.value,
        loading: field.loading.value, error: field.error.value, readonly: props.readonly || field.readonly.value,
        disabled: props.disabled, write: (value: unknown) => props.readonly || props.disabled
          ? Promise.reject(new Error("Property field is read-only.")) : field.write(value) });
      const property = resource?.property;
      return h("div", { class: "unity-bound-property-field", "data-property-path": props.path, "aria-busy": field.loading.value }, [
        field.error.value ? h("div", { role: "alert", class: "unity-bound-property-error" }, [field.error.value,
          resource ? h(BaseButton, { size: "sm", onClick: () => { void resource.refresh().catch(() => {}); } }, () => "Retry") : null]) : null,
        property ? property.drawDefaultEditor({ compact: props.compact, showLabel: props.showLabel, propertyDrawers: props.propertyDrawers,
          readonly: props.readonly || field.readonly.value, disabled: props.disabled })
          : h("span", { class: "unity-bound-property-placeholder", "aria-label": "Loading property" }, "—"),
      ]);
    };
  },
});
</script>
<style scoped>
.unity-bound-property-field { min-width: 0; }
.unity-bound-property-placeholder { display: block; min-height: 26px; color: var(--text-secondary); }
.unity-bound-property-error { color: var(--status-danger-text, var(--text-color)); font-size: 11px; }
</style>

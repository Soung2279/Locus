import { createApp } from "vue";
import { createPinia } from "pinia";
import { createNativeViewRuntime } from "./services/nativeViewRuntime";
import { installLocusRuntime } from "./services/locusRuntime";
import { installInputPunctuationPairing } from "./services/inputPunctuationPairing";
import "./styles/app-global.css";
import "./styles/typography.css";
import "./styles/asset-icons.css";

const bridge = createNativeViewRuntime(location.origin, location.hash.slice(1));
const bootstrap = await bridge.bootstrap();
const uninstall = installLocusRuntime(bridge.runtime);
const { default: Host } = await import("./components/view/UnityViewHost.vue");
const app = createApp(Host, { bootstrap, diagnostics: bridge.stats });
const uninstallPairing = installInputPunctuationPairing();
app.use(createPinia()); app.mount("#app");
window.addEventListener("pagehide", () => { app.unmount(); bridge.dispose(); uninstall(); uninstallPairing(); }, { once: true });

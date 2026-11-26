import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [cloudflare()],
	// Fecha y hora del build, visible en Ajustes → Diagnóstico Bluetooth.
	define: {
		__APP_VERSION__: JSON.stringify(new Date().toLocaleString("sv-SE").slice(0, 16)),
	},
});

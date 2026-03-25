import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
    plugins: [react()],
    server: {
        port: 5174,
        proxy: {
            "/api": {
                target: "http://127.0.0.1:4123",
                changeOrigin: true,
                rewrite: function (path) { return path.replace(/^\/api/, ""); },
            },
        },
    },
    define: {
        __APP_VERSION__: JSON.stringify("0.1.0"),
    },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolveAutoStartDeveloperMode } from "./src/config/autoStartDeveloperMode";

export default defineConfig(({ mode }) => {
  const autoStartDeveloperMode = resolveAutoStartDeveloperMode({
    mode,
    cloudflarePages: process.env.CF_PAGES,
    cloudflarePagesBranch: process.env.CF_PAGES_BRANCH,
  });

  return {
    plugins: [react()],
    define: {
      __FASTPASS_AUTO_START_DEVELOPER_MODE__: JSON.stringify(autoStartDeveloperMode),
    },
    build: {
      target: "es2022",
      sourcemap: true,
    },
  };
});

import { defineConfig, configDefaults } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    // Refund windows are counted in the server's local calendar days. Pinning
    // the zone keeps tests that depend on "today" the same on every machine.
    env: { TZ: "UTC" },
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
});

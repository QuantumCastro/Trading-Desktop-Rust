import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Capabilities, Options } from "@wdio/types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type TauriCapability = WebdriverIO.Capabilities & {
  "tauri:options": {
    application: string;
  };
};

const appPath =
  process.env.TAURI_APP_PATH ??
  path.resolve(__dirname, "../src-tauri/target/debug/desktop-template.exe");

const tauriCapability: TauriCapability = {
  "tauri:options": {
    application: appPath,
  },
};

export const config: Options.Testrunner & Capabilities.WithRequestedTestrunnerCapabilities = {
  runner: "local",
  hostname: "127.0.0.1",
  port: Number(process.env.TAURI_DRIVER_PORT ?? 4444),
  path: "/",
  specs: ["./specs/**/*.e2e.ts"],
  maxInstances: 1,
  logLevel: "info",
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 120000,
  },
  tsConfigPath: path.resolve(__dirname, "tsconfig.json"),
  capabilities: [tauriCapability],
};

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { test, expect } from "@playwright/test";
import { buildHostAgentDetailRoute } from "../../src/utils/host-routes";
import { seedWorkspace } from "../support/helpers/seed-client";
import { buildSeededHost } from "../support/helpers/daemon-registry";

test("custom Claude gateway usage reaches the browser meter before the result", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const logger = pino({ level: "silent" });
  // Load built ESM directly; Playwright's app transform cannot load the server's TS modules.
  const serverRoot = path.resolve(__dirname, "../../../server/dist/server/server");
  const { ClaudeAgentClient } = await import(
    pathToFileURL(path.join(serverRoot, "agent/providers/claude/agent.js")).href
  );
  const { createPaseoDaemon } = await import(
    pathToFileURL(path.join(serverRoot, "bootstrap.js")).href
  );
  const paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-context-browser-"));
  const configDir = path.join(paseoHome, "claude");
  await mkdir(configDir);
  await writeFile(path.join(configDir, "settings.json"), JSON.stringify({ model: "glm-5.2[1m]" }));
  let finish!: () => void;
  const resultGate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const daemon = await createPaseoDaemon(
    {
      listen: "127.0.0.1:0",
      paseoHome,
      staticDir: paseoHome,
      agentStoragePath: path.join(paseoHome, "agents"),
      corsAllowedOrigins: [`http://localhost:${process.env.E2E_METRO_PORT}`],
      hostnames: true,
      mcpEnabled: false,
      relayEnabled: false,
      appBaseUrl: "https://app.paseo.sh",
      voiceLlmProvider: null,
      agentClients: {
        claude: new ClaudeAgentClient({
          logger,
          configDir,
          resolveBinary: async () => "/test/claude/bin",
          queryFactory: ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
            const stream = (async function* () {
              for await (const _message of prompt as AsyncIterable<unknown>) {
                yield {
                  type: "system",
                  subtype: "init",
                  session_id: "gateway-context",
                  permissionMode: "default",
                  model: "glm-5.2[1m]",
                };
                yield {
                  type: "stream_event",
                  session_id: "gateway-context",
                  event: {
                    type: "message_start",
                    message: { usage: { input_tokens: 0, output_tokens: 0 } },
                  },
                };
                yield {
                  type: "stream_event",
                  session_id: "gateway-context",
                  event: {
                    type: "message_delta",
                    usage: { input_tokens: 249_950, output_tokens: 50 },
                  },
                };
                await resultGate;
                yield {
                  type: "result",
                  subtype: "success",
                  session_id: "gateway-context",
                  result: "OK",
                  is_error: false,
                  total_cost_usd: 0,
                  usage: { input_tokens: 249_950, output_tokens: 50 },
                  modelUsage: { "glm-5.2": { contextWindow: 1_000_000 } },
                };
                break;
              }
            })();
            return Object.assign(stream, {
              close: finish,
              interrupt: async () => {
                finish();
              },
              supportedModels: async () => [],
              supportedCommands: async () => [],
              setPermissionMode: async () => {},
              setModel: async () => {},
            }) as unknown as Query;
          },
        }),
      },
    },
    logger,
  );
  await daemon.start();
  const port = daemon.getListenTarget().port;
  const workspace = await seedWorkspace({ port, repoPrefix: "gateway-context-" });
  try {
    const serverId = (await readFile(path.join(paseoHome, "server-id"), "utf8")).trim();
    const host = buildSeededHost({
      serverId,
      endpoint: `127.0.0.1:${port}`,
      nowIso: new Date().toISOString(),
    });
    await page.route(/:(6767|6768)\b/, (route) => route.abort());
    await page.routeWebSocket(/:(6767|6768)\b/, (ws) => ws.close());
    await page.addInitScript((seededHost) => {
      localStorage.setItem("@paseo:e2e", "1");
      localStorage.setItem("@paseo:daemon-registry", JSON.stringify([seededHost]));
    }, host);
    const agent = await workspace.client.createAgent({
      provider: "claude",
      model: "glm-5.2[1m]",
      cwd: workspace.workspaceDirectory,
      workspaceId: workspace.workspaceId,
      title: "Gateway context usage",
    });
    await workspace.client.sendAgentMessage(agent.id, "Report context usage");
    await page.goto(buildHostAgentDetailRoute(serverId, agent.id, workspace.workspaceId));
    const meter = page.getByTestId("context-window-meter");
    await expect(meter).toHaveAccessibleName(/25%/, { timeout: 30_000 });
    await expect(page.getByText("glm-5.2[1m]", { exact: true })).toBeVisible();
    await meter.hover();
    await expect(page.getByText("25% used", { exact: true })).toBeVisible();
    await expect(page.getByText("250k / 1m tokens", { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("gateway-context-active.png") });
    finish();
    await workspace.client.waitForFinish(agent.id, 10_000);
    await page.reload();
    await expect(meter).toHaveAccessibleName(/25%/, { timeout: 30_000 });
    await meter.hover();
    await expect(page.getByText("250k / 1m tokens", { exact: true })).toBeVisible();
  } finally {
    finish();
    await workspace.cleanup();
    await daemon.stop();
    await daemon.agentManager.flush();
    await rm(paseoHome, { recursive: true, force: true });
  }
});

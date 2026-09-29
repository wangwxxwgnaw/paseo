import { expect, test, type Page } from "../support/fixtures";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { installProviderUsageFixture } from "../support/helpers/provider-usage";

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

async function openMockAgent(page: Page) {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  const session = await seedMockAgentWorkspace({
    repoPrefix: "provider-usage-tooltip-",
    title: "Provider usage tooltip e2e",
    initialPrompt: "emit 1 coalesced agent stream update for provider usage tooltip.",
  });
  await session.client.waitForFinish(session.agentId, 30_000);
  await openAgentRoute(page, session);
  await expectComposerVisible(page);
  await expect(page.getByTestId("context-window-meter")).toBeVisible({ timeout: 30_000 });
  return session;
}

test.describe("provider usage tooltip", () => {
  test("fetches usage when the context tooltip opens and renders the active provider", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const usageFixture = await installProviderUsageFixture(page, [
      {
        fetchedAt: "2026-06-19T00:00:00.000Z",
        providers: [
          {
            providerId: "mock",
            displayName: "Mock provider",
            status: "available",
            planLabel: "Test plan",
            windows: [
              {
                id: "session",
                label: "Session",
                usedPct: 42,
                remainingPct: 58,
                resetsAt: "2026-06-19T05:00:00.000Z",
              },
            ],
          },
        ],
      },
    ]);
    const session = await openMockAgent(page);
    try {
      expect(usageFixture.requestCount()).toBe(0);

      await expect(page.getByTestId("context-window-meter-summary")).toContainText("/ 128k");
      await expect(page.getByTestId("context-window-meter-snapshot-cue")).toHaveText(
        "Usage snapshot",
      );

      await page.getByTestId("context-window-meter").hover();
      await usageFixture.waitForRequestCount(1);

      await expect(page.getByText("Mock provider", { exact: true })).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText("Test plan")).toBeVisible();
      await expect(page.getByText("Session", { exact: true })).toBeVisible();
      await expect(page.getByText("42%")).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });

  test("replaces selected-agent usage with an honest missing-data state", async ({ page }) => {
    test.setTimeout(180_000);
    const session = await openMockAgent(page);
    try {
      await expect(page.getByTestId("context-window-meter-summary")).toContainText("/ 128k tokens");

      await session.client.sendAgentMessage(
        session.agentId,
        "keep the context snapshot visible during this deterministic stream",
      );
      await session.client.waitForAgentUpsert(
        session.agentId,
        (snapshot) => snapshot.status === "running",
        15_000,
      );
      await expect(page.getByTestId("context-window-meter-snapshot-cue")).toHaveText(
        "Usage snapshot",
      );
      await session.client.waitForFinish(session.agentId, 30_000);

      const missingAgent = await session.client.createAgent({
        provider: "mock",
        cwd: session.cwd,
        workspaceId: session.workspaceId,
        title: "Context data unavailable",
        modeId: "load-test",
        model: "e2e-fast-stream",
      });
      await openAgentRoute(page, { ...session, agentId: missingAgent.id });
      await expectComposerVisible(page);

      await expect(page.getByTestId("context-window-meter-unknown")).toHaveText("Context unknown");
      await expect(page.getByTestId("context-window-meter-summary")).toHaveCount(0);
      await expect(page.getByTestId("context-window-meter")).not.toContainText("%");

      await openAgentRoute(page, session);
      await expect(page.getByTestId("context-window-meter-summary")).toContainText("/ 128k tokens");
      await expect(page.getByTestId("context-window-meter-unknown")).toHaveCount(0);
      await expect(page.getByTestId("context-window-meter-snapshot-cue")).toHaveText(
        "Usage snapshot",
      );
    } finally {
      await session.cleanup();
    }
  });

  test("refreshes usage again each time the tooltip is shown", async ({ page }) => {
    test.setTimeout(180_000);
    const usageFixture = await installProviderUsageFixture(page, [
      {
        fetchedAt: "2026-06-19T00:00:00.000Z",
        providers: [
          {
            providerId: "mock",
            displayName: "Mock provider",
            status: "available",
            planLabel: "Test plan",
            windows: [{ id: "session", label: "Session", usedPct: 41 }],
          },
        ],
      },
      {
        fetchedAt: "2026-06-19T00:01:00.000Z",
        providers: [
          {
            providerId: "mock",
            displayName: "Mock provider",
            status: "available",
            planLabel: "Test plan",
            windows: [{ id: "session", label: "Session", usedPct: 64 }],
          },
        ],
      },
    ]);
    const session = await openMockAgent(page);
    try {
      const meter = page.getByTestId("context-window-meter");

      await meter.hover();
      await usageFixture.waitForRequestCount(1);
      await expect(page.getByText("41%")).toBeVisible({ timeout: 10_000 });

      await page.mouse.move(0, 0);
      await expect(page.getByText("Mock provider", { exact: true })).toHaveCount(0);

      await meter.hover();
      await usageFixture.waitForRequestCount(2);
      expect(usageFixture.requestCount()).toBe(2);
      await expect(page.getByText("64%")).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });
});

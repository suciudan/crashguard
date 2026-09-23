import { chromium, expect } from "@playwright/test";
import { createProject, db } from "./test-data";
import { saveEnvelope, listTelemetry } from "../src/lib/telemetry";
import { randomUUID } from "node:crypto";
import http from "node:http";
async function main() {
  const project = createProject("Replay isolation", "javascript"),
    replayId = randomUUID().replaceAll("-", "");
  let requests = 0;
  const receiver = http.createServer((_req, res) => {
    requests++;
    res.end("external content");
  });
  await new Promise<void>((resolve) =>
    receiver.listen(0, "127.0.0.1", resolve),
  );
  const url = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/should-not-load`;
  const now = Date.now();
  const snapshot = {
    type: 0,
    id: 1,
    childNodes: [
      { type: 1, id: 2, name: "html", publicId: "", systemId: "" },
      {
        type: 2,
        id: 3,
        tagName: "html",
        attributes: {},
        childNodes: [
          { type: 2, id: 4, tagName: "head", attributes: {}, childNodes: [] },
          {
            type: 2,
            id: 5,
            tagName: "body",
            attributes: {},
            childNodes: [
              {
                type: 2,
                id: 6,
                tagName: "img",
                attributes: { src: url },
                childNodes: [],
              },
              {
                type: 2,
                id: 7,
                tagName: "script",
                attributes: { src: url },
                childNodes: [],
              },
              {
                type: 2,
                id: 8,
                tagName: "p",
                attributes: {},
                childNodes: [
                  { type: 3, id: 9, textContent: "Replay isolation fixture" },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const events = [
    {
      type: 4,
      timestamp: now,
      data: { href: "https://example.com", width: 800, height: 600 },
    },
    {
      type: 2,
      timestamp: now + 1,
      data: { node: snapshot, initialOffset: { top: 0, left: 0 } },
    },
    { type: 5, timestamp: now + 100, data: { tag: "test", payload: {} } },
  ];
  saveEnvelope(project.id, { event_id: replayId }, [
    {
      type: "replay_event",
      headers: {},
      payload: Buffer.from(
        JSON.stringify({
          replay_id: replayId,
          segment_id: 0,
          timestamp: now / 1000,
        }),
      ),
    },
    {
      type: "replay_recording",
      headers: {},
      payload: Buffer.from(`{"segment_id":0}\n${JSON.stringify(events)}`),
    },
  ]);
  const row = listTelemetry({ project: project.id, kind: "replay_event" })
    .rows[0];
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      storageState: process.env.TEST_STORAGE_STATE,
    });
    const page = await context.newPage();
    await page.goto(
      `${process.env.TEST_BASE_URL}/?view=replays&record=${row.id}`,
    );
    await expect(
      page.getByRole("button", { name: "Play", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(
      page
        .frameLocator('iframe[title="Session replay"]')
        .frameLocator("iframe")
        .getByText("Replay isolation fixture"),
    ).toBeVisible();
    await page.waitForTimeout(500);
    expect(requests).toBe(0);
    const sandbox = await page
      .locator('iframe[title="Session replay"]')
      .getAttribute("sandbox");
    expect(sandbox).not.toContain("allow-scripts");
    console.log(
      "PASS: rrweb playback renders snapshots while blocking recorded scripts and external image/script requests.",
    );
  } finally {
    await browser.close();
    receiver.close();
    db().close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

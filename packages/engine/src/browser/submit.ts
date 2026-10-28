import type { Frame, Page } from "playwright";

const DONE_URL = /thank|confirm|success|submitted|applied/i;
const DONE_TEXT = /thank you for (applying|your application)|application (was |has been )?(submitted|received)|we('ve| have) received your application/i;

// Calls onSubmit when you press a submit button (or hit Enter in the form), in any frame.
const watchSubmits = async (page: Page, onSubmit: () => void) => {
  await page.exposeBinding("__applyAgentSubmit", () => onSubmit());
  const listen = () => {
    const w = window as unknown as { __applyAgentListening?: boolean; __applyAgentSubmit: () => void };
    if (w.__applyAgentListening) return;
    w.__applyAgentListening = true;
    document.addEventListener("click", (e) => {
      const b = (e.target as Element).closest("button, input[type=submit]");
      if (b && (b.matches("[type=submit]") || /submit|send application/i.test(b.textContent ?? ""))) w.__applyAgentSubmit();
    }, true);
    document.addEventListener("submit", () => w.__applyAgentSubmit(), true);
  };
  await page.addInitScript(listen);
  await Promise.all(page.frames().map((f) => f.evaluate(listen).catch(() => {})));
};

// After a submit click: did a confirmation (URL or "thank you" text) show up? Validation errors → no.
const confirmed = (page: Page, frame: Frame) =>
  Promise.any([
    page.waitForURL(DONE_URL, { timeout: 20_000 }),
    page.getByText(DONE_TEXT).first().waitFor({ timeout: 20_000 }),
    frame.getByText(DONE_TEXT).first().waitFor({ timeout: 20_000 }),
  ]).then(() => true, () => false);

// Waits until you submit successfully or close the tab. `snapshot` runs at each submit click,
// before the page navigates away, so we know exactly what you sent.
export const waitForSubmit = <T>(page: Page, frame: Frame, snapshot: () => Promise<T>) =>
  new Promise<{ submitted: boolean; sent?: T }>((resolve) => {
    let sent: T | undefined;
    if (page.isClosed()) return resolve({ submitted: false }); // closed while we were still filling
    page.once("close", () => resolve({ submitted: false }));
    watchSubmits(page, async () => {
      sent = (await snapshot().catch(() => undefined)) ?? sent;
      if (await confirmed(page, frame)) resolve({ submitted: true, sent });
    }).catch(() => {}); // tab already closed
  });

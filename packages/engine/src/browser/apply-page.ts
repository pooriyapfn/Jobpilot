import type { Page } from "playwright-core";
import { config } from "../config.ts";
import { extractForm } from "./form.ts";

const MIN_FIELDS = 3;
const CLOSED_TEXT = /job (not found|no longer|has been closed|is closed)|position (has been filled|is no longer)|no longer accepting/i;
const CHALLENGE_TEXT = /just a moment|security verification|verify you are human|checking your browser/i;
const LOGIN_WALL = { host: /(^|\.)linkedin\.com$/, text: /join now|sign in to apply/i };

// ok: page usable · closed: posting gone · blocked: bot wall (Cloudflare…) · login: needs your session
export type Access = "ok" | "closed" | "blocked" | "login";

// Known ATS: the form lives on a predictable sub-page.
const atsApplyUrl = (url: string): string => {
  const u = new URL(url);
  if (u.hostname === "jobs.lever.co" && !u.pathname.endsWith("/apply")) u.pathname += "/apply";
  if (u.hostname === "jobs.ashbyhq.com" && !u.pathname.endsWith("/application")) u.pathname += "/application";
  return u.toString();
};

const settle = (page: Page) =>
  page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});

// Slow sites (ads, trackers) sometimes miss the first timeout: retry once with a longer one.
const goto = async (page: Page, url: string): Promise<number> => {
  const open = (timeout: number) => page.goto(url, { waitUntil: "domcontentloaded", timeout });
  const res = await open(config.navTimeoutMs).catch((e) => {
    if (e?.name !== "TimeoutError") throw e;
    return open(config.retryTimeoutMs);
  });
  await settle(page);
  return res?.status() ?? 200;
};

const accessOf = async (page: Page, status: number): Promise<Access> => {
  if (status === 404 || status === 410) return "closed";
  const text = `${await page.title()} ${await page.locator("body").innerText().catch(() => "")}`.slice(0, 3_000);
  if (status === 403 || status === 429 || status === 503 || CHALLENGE_TEXT.test(text)) return "blocked";
  if (CLOSED_TEXT.test(text)) return "closed";
  if (LOGIN_WALL.host.test(new URL(page.url()).hostname) && LOGIN_WALL.text.test(text)) return "login";
  return "ok";
};

// Follows an "Apply" link (aggregator → company ATS), or clicks an "Apply" button —
// if that opens a new tab (LinkedIn → company site), take its URL and continue here.
const followApply = async (page: Page): Promise<string | undefined> => {
  const apply = page.getByRole("link", { name: /apply/i }).or(page.getByRole("button", { name: /apply/i })).first();
  const href = await apply.getAttribute("href", { timeout: 3_000 }).catch(() => null);
  if (href && !href.startsWith("#")) return new URL(href, page.url()).toString();
  const popup = page.waitForEvent("popup", { timeout: 5_000 }).catch(() => null);
  await apply.click({ timeout: 3_000 }).catch(() => {});
  const tab = await popup;
  if (!tab) return void (await settle(page));
  await tab.waitForLoadState("domcontentloaded").catch(() => {});
  const url = tab.url();
  await tab.close();
  return url;
};

// Opens the job and lands on its application form: ATS rule → page itself → up to two "Apply" hops.
export const openApplyPage = async (page: Page, url: string) => {
  page.setDefaultTimeout(config.navTimeoutMs);
  let next: string | undefined = url;
  let status = 200;
  for (let hop = 0; ; hop++) {
    if (next) status = await goto(page, atsApplyUrl(next));
    const form = await extractForm(page);
    const access = form.fields.length >= MIN_FIELDS ? "ok" : await accessOf(page, status);
    if (form.fields.length >= MIN_FIELDS || access !== "ok" || hop === 2) return { applyUrl: page.url(), ...form, access };
    next = await followApply(page);
  }
};

export const hasForm = (fieldCount: number) => fieldCount >= MIN_FIELDS;

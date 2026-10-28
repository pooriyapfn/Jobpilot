import type { Frame, Page } from "playwright";
import type { Answers, FormField } from "../types.ts";

// Runs in the page: describes every visible, fillable control.
const scanFields = (): FormField[] => {
  const textOf = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  const optionLabel = (el: HTMLInputElement) =>
    textOf(el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : el.closest("label"));
  // Radio/checkbox group: the question is the first label/legend around the group that isn't an option's own label.
  const groupLabel = (el: HTMLInputElement): string => {
    const group = document.querySelectorAll<HTMLInputElement>(`[name="${CSS.escape(el.name)}"]`);
    if (group.length < 2) return "";
    const options = new Set([...group].map(optionLabel));
    let box = el.parentElement;
    while (box && ![...group].every((g) => box!.contains(g))) box = box.parentElement;
    for (let p = box, i = 0; p && i < 3; p = p.parentElement, i++) {
      const q = [...p.querySelectorAll("legend, label, [class*=label], [class*=title]")]
        .find((n) => !n.querySelector("input") && !options.has(textOf(n)) && textOf(n));
      if (q) return textOf(q);
    }
    return "";
  };
  const labelFor = (el: HTMLInputElement): string => {
    const choice = el.type === "radio" || el.type === "checkbox";
    return (
      el.getAttribute("aria-label") ||
      (choice ? groupLabel(el) : "") ||
      optionLabel(el) ||
      textOf(el.closest("div,li")?.querySelector("label,legend,[class*=label]")) ||
      el.getAttribute("placeholder") ||
      el.getAttribute("name") ||
      ""
    );
  };
  const out = new Map<string, FormField>();
  const els = document.querySelectorAll<HTMLInputElement>("input, textarea, select");
  for (const el of els) {
    const t = el.type;
    if (["hidden", "submit", "button", "reset", "image", "search"].includes(t)) continue;
    if (t !== "file" && !el.offsetParent) continue; // invisible (file inputs are often hidden on purpose)
    const key = el.name || el.id;
    if (!key) continue;
    const type =
      el.tagName === "TEXTAREA" ? "textarea"
      : el.tagName === "SELECT" ? "select"
      : t === "radio" || t === "checkbox" || t === "file" ? t
      : "text";
    const selector = el.name ? `[name="${CSS.escape(el.name)}"]` : `#${CSS.escape(el.id)}`;
    const field = out.get(key) ?? { id: key, selector, label: labelFor(el), type, required: false };
    field.required ||= el.required || el.getAttribute("aria-required") === "true";
    if (type === "select") field.options = [...(el as unknown as HTMLSelectElement).options].map((o) => o.text.trim()).filter(Boolean);
    if (type === "radio" || type === "checkbox") (field.options ??= []).push(optionLabel(el) || el.value);
    out.set(key, field);
  }
  return [...out.values()];
};

// Forms are sometimes in an iframe (embedded Greenhouse); use the frame with the most fields.
export const extractForm = async (page: Page): Promise<{ frame: Frame; fields: FormField[] }> => {
  let best = { frame: page.mainFrame(), fields: [] as FormField[] };
  for (const frame of page.frames()) {
    const fields = await frame.evaluate(scanFields).catch(() => []);
    if (fields.length > best.fields.length) best = { frame, fields };
  }
  return best;
};

// Fills what it can; returns ids of fields left for you (unanswered, unsure or failed).
export const fillForm = async (
  frame: Frame, fields: FormField[], answers: Answers, resumePath?: string,
): Promise<string[]> => {
  const pending: string[] = [];
  for (const f of fields) {
    const a = answers[f.id];
    const loc = frame.locator(f.selector);
    try {
      if (f.type === "file") {
        if (resumePath && /resume|cv/i.test(`${f.label} ${f.id}`)) await loc.first().setInputFiles(resumePath);
        else pending.push(f.id);
        continue;
      }
      if (!a?.value) { if (f.required) pending.push(f.id); continue; }
      if (f.type === "select") await loc.first().selectOption({ label: a.value });
      else if (f.type === "radio") await frame.getByLabel(a.value, { exact: true }).and(loc).first().check();
      else if (f.type === "checkbox") { if (/^(yes|true)$/i.test(a.value)) await loc.first().check(); }
      else {
        await loc.first().fill(a.value);
        // Type-ahead dropdowns (Greenhouse/Ashby country, location…): pick the first match.
        if ((await loc.first().getAttribute("role")) === "combobox") {
          await frame.waitForTimeout(600);
          await loc.first().press("Enter");
        }
      }
      if (!a.confident) pending.push(f.id);
    } catch {
      pending.push(f.id);
    }
  }
  await highlight(frame, fields.filter((f) => pending.includes(f.id)).map((f) => f.selector));
  return pending;
};

const highlight = (frame: Frame, selectors: string[]) =>
  frame.evaluate((sels) => {
    for (const s of sels) document.querySelectorAll<HTMLElement>(s).forEach((el) => {
      el.style.outline = "3px solid #f59e0b";
      el.style.outlineOffset = "2px";
    });
  }, selectors);

// Current values of all fields, keyed by field id (for learning from what you actually submitted).
export const readValues = (frame: Frame, fields: FormField[]) =>
  frame.evaluate((fs) => {
    const vals: Record<string, string> = {};
    for (const f of fs) {
      const els = [...document.querySelectorAll<HTMLInputElement>(f.selector)];
      const picked = els.filter((e) => (e.type === "radio" || e.type === "checkbox" ? e.checked : true));
      vals[f.id] = picked
        .map((e) => (e.type === "radio" || e.type === "checkbox"
          ? e.closest("label")?.textContent?.trim() || e.value
          : e.tagName === "SELECT" ? (e as unknown as HTMLSelectElement).selectedOptions[0]?.text ?? ""
          : e.value))
        .join(", ");
    }
    return vals;
  }, fields);

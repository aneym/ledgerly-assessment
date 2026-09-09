/**
 * DOM helpers for the dev panel. Everything works through the page's own
 * controls: a value goes in through the native setter so React sees it, then
 * the input and change events fire the way a keystroke would. Nothing here
 * touches fetch or the app API.
 */

export type Step = { ok: true; note: string } | { ok: false; note: string };

type Fillable = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

const isFillable = (el: Element | null): el is Fillable =>
  el instanceof HTMLInputElement ||
  el instanceof HTMLTextAreaElement ||
  el instanceof HTMLSelectElement;

/** The element behind a data-tour anchor, or null when the page does not carry it. */
export function anchorEl(anchor: string): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>(`[data-tour="${anchor}"]`);
}

/** The data-screen of the mounted screen, or null. */
export function currentScreen(): string | null {
  if (typeof document === "undefined") return null;
  return document.querySelector("[data-screen]")?.getAttribute("data-screen") ?? null;
}

/** The last correlation id the page exposed through its meta tag or a data attribute. */
export function pageCorrelationId(): string | null {
  if (typeof document === "undefined") return null;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="x-ledgerly-correlation-id"]');
  if (meta?.content) return meta.content;
  return (
    document.querySelector("[data-correlation-id]")?.getAttribute("data-correlation-id") ?? null
  );
}

function nativeSetter(el: Fillable): ((value: string) => void) | null {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
  const set = descriptor?.set;
  return set ? (value: string) => set.call(el, value) : null;
}

/** Sets a text or select value through the native setter, then fires input and change. */
export function setValue(el: Element | null, value: string, label: string): Step {
  if (!isFillable(el)) return { ok: false, note: `${label} is not an input on this page` };
  if (el.disabled) return { ok: false, note: `${label} is disabled` };
  if (el instanceof HTMLSelectElement && ![...el.options].some((o) => o.value === value)) {
    return { ok: false, note: `${label} has no option ${value}` };
  }
  const set = nativeSetter(el);
  if (set) set(value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, note: label };
}

/** Puts files into a file input through a DataTransfer, then fires input and change. */
export function setFiles(el: Element | null, files: File[], label: string): Step {
  const input =
    el instanceof HTMLInputElement && el.type === "file"
      ? el
      : (el?.querySelector<HTMLInputElement>('input[type="file"]') ?? null);
  if (!input) return { ok: false, note: `${label} has no file input` };
  if (input.disabled) return { ok: false, note: `${label} is disabled` };
  if (typeof DataTransfer === "undefined") return { ok: false, note: "DataTransfer unsupported" };
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, note: label };
}

/** Fills the control behind an anchor. */
export function fillAnchor(anchor: string, value: string): Step {
  const el = anchorEl(anchor);
  if (!el) return { ok: false, note: `${anchor} not on this page` };
  return setValue(el, value, anchor);
}

/**
 * Fills a field that has no anchor of its own: `name="<field>"` inside the
 * form that owns the anchored control.
 */
export function fillFormField(anchor: string, field: string, value: string): Step {
  const owner = anchorEl(anchor);
  const form = owner?.closest("form") ?? null;
  if (!form) return { ok: false, note: `${anchor} has no form on this page` };
  const el = form.querySelector(`[name="${field}"]`);
  if (!el) return { ok: false, note: `form of ${anchor} has no field ${field}` };
  return setValue(el, value, `${anchor} form.${field}`);
}

/**
 * Fills a field by its visible label text inside the form that owns the
 * anchored control, for controls that carry neither anchor nor name.
 */
export function fillLabeled(anchor: string, labelText: string, value: string): Step {
  const owner = anchorEl(anchor);
  const form = owner?.closest("form") ?? null;
  if (!form) return { ok: false, note: `${anchor} has no form on this page` };
  const label = [...form.querySelectorAll("label")].find(
    (l) => l.textContent?.trim() === labelText,
  );
  const target = label?.htmlFor ? document.getElementById(label.htmlFor) : null;
  if (!target) return { ok: false, note: `no field labeled ${labelText}` };
  return setValue(target, value, `${anchor} form.${labelText}`);
}

/** Clicks the control behind an anchor. A disabled control is reported, not forced. */
export function clickAnchor(anchor: string): Step {
  const el = anchorEl(anchor);
  return clickEl(el, anchor);
}

export function clickEl(el: Element | null, label: string): Step {
  if (!(el instanceof HTMLElement)) return { ok: false, note: `${label} not on this page` };
  if (
    (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) &&
    (el.disabled || el.getAttribute("aria-disabled") === "true")
  ) {
    return { ok: false, note: `${label} is disabled` };
  }
  el.click();
  return { ok: true, note: `clicked ${label}` };
}

/** Lets React flush state between a fill and the click that reads it. */
export function settle(ms = 60): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A small PNG made on a canvas so a cover input receives a real image file. */
export async function makePngFile(name: string, fill: string): Promise<File | null> {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 80;
  canvas.height = 100;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#1b1916";
  ctx.fillRect(8, 78, 40, 12);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  return blob ? new File([blob], name, { type: "image/png" }) : null;
}

/** A small zip-typed file so a files input has something real to list. */
export function makeSampleFile(name: string): File {
  const header = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]);
  return new File([header], name, { type: "application/zip" });
}

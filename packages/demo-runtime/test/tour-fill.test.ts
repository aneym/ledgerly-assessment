import { afterEach, expect, it, vi } from "vitest";
import { fillStep, performStepAction } from "../src/react/tour-overlay";
import { STEPS } from "../src/steps";
import { reduceTour } from "../src/tour";

// The agreed story has no sign-up step (the sample persona is already signed in), so the
// fill behaviour is exercised on a synthetic step definition rather than a shipped one.
const FILL_STEP = {
  ...STEPS[0]!,
  id: "X01",
  anchor: "signup.submit",
  action: { kind: "type" as const, label: "Create the test account" },
  fill: [
    { anchor: "signup.name", value: "name" as const },
    { anchor: "signup.email", value: "email" as const },
    { anchor: "signup.password", value: "password" as const },
  ],
};
const FILL_STEPS = [FILL_STEP, ...STEPS.slice(1)];

// The DOM is an external boundary. The own setter emulates React's value tracker;
// the prototype setter must bypass it and then notify the app with a bubbling event.
class Input extends EventTarget {
  raw = "";
  ownSetterCalls = 0;
  get value() { return this.raw; }
  set value(value: string) { this.raw = value; }
  constructor() {
    super();
    Object.defineProperty(this, "value", { get: () => this.raw, set: () => { this.ownSetterCalls++; } });
  }
}
afterEach(() => vi.unstubAllGlobals());
it("only the seller-joins chapter fills a form (name and email); every other step is click or observe", () => {
  expect(STEPS[0]?.action.kind).toBe("type");
  expect(STEPS[0]?.fill?.map((f) => f.anchor)).toEqual(["sell.start.name", "sell.start.email"]);
  expect(STEPS.slice(1).every((step) => step.action.kind !== "type" && !step.fill)).toBe(true);
});
it("fills through the native setter and dispatches bubbling input events before submission", () => {
  const fields = [new Input(), new Input(), new Input()];
  const observed: string[] = [];
  for (const field of fields) field.addEventListener("input", (event) => { expect(event.bubbles).toBe(true); observed.push(field.value); });
  vi.stubGlobal("HTMLInputElement", Input);
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  const anchors = ["signup.name", "signup.email", "signup.password"];
  vi.stubGlobal("document", { querySelector: (selector: string) => fields[anchors.findIndex((anchor) => selector === `[data-tour="${anchor}"]`)] });
  const step = reduceTour([], FILL_STEPS).steps[0]!;
  expect(fillStep(step, { name: "Demo Buyer 42", email: "demo-buyer-42@ledgerly.test", password: "fictional-value!" })).toBe(true);
  expect(observed).toEqual(["Demo Buyer 42", "demo-buyer-42@ledgerly.test", "fictional-value!"]);
  expect(fields.every((field) => field.ownSetterCalls === 0)).toBe(true);
  expect(reduceTour([], FILL_STEPS).steps[0]?.status).toBe("active");
});
it("does not partially fill or submit when an input is missing", () => {
  const field = new Input();
  vi.stubGlobal("HTMLInputElement", Input);
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.stubGlobal("document", { querySelector: (selector: string) => selector.includes("signup.name") ? field : null });
  expect(fillStep(reduceTour([], FILL_STEPS).steps[0]!, { name: "Demo Buyer", email: "demo@ledgerly.test", password: "fictional-value!" })).toBe(false);
  expect(field.value).toBe("");
});
it("Skip advances without converting an unperformed operation into success", () => {
  const state = reduceTour([], STEPS, { skipped: new Set(["C01"]) });
  expect(state.steps[0]?.status).toBe("skipped");
  expect(state.steps[0]?.proof.level).toBe("none");
  expect(state.active_index).toBe(1);
  expect(state.outcome).toBe("in-progress");
});

it("fills, assigns correlation, then clicks submit once without inventing an outcome", () => {
  const fields = [new Input(), new Input(), new Input()];
  vi.stubGlobal("HTMLInputElement", Input);
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.stubGlobal("document", { querySelector: (selector: string) => fields[selector.includes("name") ? 0 : selector.includes("email") ? 1 : 2] });
  const order: string[] = [];
  const step = reduceTour([], FILL_STEPS).steps[0]!;
  const button = { focus: () => { order.push("focus"); }, click: () => { order.push("submit"); expect(fields.map((field) => field.value)).toEqual(["Demo Buyer 42", "demo-buyer-42@ledgerly.test", "test-password-42"]); } };
  vi.useFakeTimers();
  expect(performStepAction(step, button, () => { order.push("correlation"); }, () => ({ name: "Demo Buyer 42", email: "demo-buyer-42@ledgerly.test", password: "test-password-42" }))).toBe(true);
  // The submit click is deferred one task so the form's React state has applied the fill.
  expect(order).toEqual(["correlation"]);
  vi.runAllTimers();
  vi.useRealTimers();
  expect(order).toEqual(["correlation", "focus", "submit"]);
  expect(step.status).toBe("active");
});
it("keeps other steps click-only and never calls their fill resolver", () => {
  const button = { focus: vi.fn(), click: vi.fn() };
  const fill = vi.fn();
  expect(performStepAction(reduceTour([]).steps[1]!, button, undefined, fill)).toBe(true);
  expect(button.click).toHaveBeenCalledOnce();
  expect(fill).not.toHaveBeenCalled();
});

it("reports after the actual click so a validation no-op cannot be mistaken for a sent request", () => {
  let dispatched = false;
  const afterClick = vi.fn(() => { expect(dispatched).toBe(false); });
  const button = { focus: vi.fn(), click: vi.fn() };
  expect(performStepAction(reduceTour([]).steps[1]!, button, () => afterClick)).toBe(true);
  expect(button.click).toHaveBeenCalledOnce();
  expect(afterClick).toHaveBeenCalledOnce();
  dispatched = true;
});

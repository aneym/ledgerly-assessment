/**
 * Dev panel action registry. One entry per quick action, keyed by the
 * data-screen it belongs to. Actions only use data-tour anchors and the
 * page's own controls: they fill real forms, click real submit buttons and
 * navigate. They never intercept a fetch or stub a response, so whatever the
 * page shows afterwards (a redirect, a not-live state, an error) is real.
 *
 * The demo-runtime lane can import `DEV_ACTIONS` and `runAction` to drive the
 * guided tour with the same steps instead of writing its own selectors.
 */

import { type DemoProfile, PROFILE_LABEL, profileUrl } from "../demo-profile-url";
import {
  anchorEl,
  clickAnchor,
  clickEl,
  currentScreen,
  fillAnchor,
  fillFormField,
  fillLabeled,
  makePngFile,
  makeSampleFile,
  type Step,
  setFiles,
  settle,
} from "./dom";
import {
  type Identity,
  newBuyer,
  type SellerCountry,
  TEST_IDENTITIES,
  type TestIdentities,
} from "./identities";

export type DevActionKind = "fill" | "submit" | "navigate" | "click";

export type DevActionResult = { ok: boolean; note: string };

export type DevActionContext = {
  /** Fills the control behind a data-tour anchor. */
  fill(anchor: string, value: string): Step;
  /** Fills `name="<field>"` inside the form that owns the anchored control. */
  fillField(anchor: string, field: string, value: string): Step;
  /** Fills a control by its label text inside the form that owns the anchored control. */
  fillLabeled(anchor: string, label: string, value: string): Step;
  /** Puts files into the file input behind an anchor. */
  fillFiles(anchor: string, files: File[]): Step;
  /** Clicks the control behind a data-tour anchor. */
  click(anchor: string): Step;
  /** Navigates to a same-origin path. */
  go(path: string): void;
  /** Waits for React to flush a fill before a click reads it. */
  settle(ms?: number): Promise<void>;
  identities: TestIdentities;
  newBuyer(): Identity;
  screen: string | null;
};

export type DevAction = {
  screen: string;
  id: string;
  label: string;
  kind: DevActionKind;
  run(ctx: DevActionContext): Promise<DevActionResult> | DevActionResult;
};

/* ------------------------------------------------------------------ */
/* Helpers shared by the actions                                        */
/* ------------------------------------------------------------------ */

/** Sums steps into one result: all ok, or the first failure's note. */
function outcome(steps: Step[], okNote: string): DevActionResult {
  const failed = steps.find((s) => !s.ok);
  if (failed) return { ok: false, note: failed.note };
  return { ok: true, note: okNote };
}

function fillAuth(
  ctx: DevActionContext,
  screen: "signup" | "signin",
  who: Identity & { password?: string },
): Step[] {
  const steps: Step[] = [];
  if (screen === "signup") steps.push(ctx.fill("signup.name", who.name));
  steps.push(ctx.fill(`${screen}.email`, who.email));
  if (who.password) steps.push(ctx.fill(`${screen}.password`, who.password));
  return steps;
}

/** One navigate action per demo profile: the server mints the session, no password form. */
function switchAction(screen: string, profile: DemoProfile): DevAction {
  return {
    screen,
    id: `${screen}.switch-${profile}`,
    label: `Switch to ${PROFILE_LABEL[profile].toLowerCase()}`,
    kind: "navigate",
    run(ctx) {
      const next = screen === "signin" || screen === "signup" ? null : window.location.pathname;
      ctx.go(profileUrl(profile, next));
      return { ok: true, note: `Switching to the ${profile} profile` };
    },
  };
}

/**
 * The form derives the seller's external id from name and email, and the Whop sandbox
 * refuses a second account for the same external id. A fresh plus-address per fill keeps
 * every demo run's "seller joins" step real and repeatable; the mailbox stays the owner's.
 */
function uniqueSellerEmail(email: string, at: Date = new Date()): string {
  const [local, domain] = email.split("@");
  const stamp = at
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  return `${local}-${stamp}@${domain}`;
}

function fillSellerStart(ctx: DevActionContext, country: SellerCountry): Step[] {
  // Only the three sandbox test identities have a form; the catalog-only countries do not.
  const values = ctx.identities.sellerForms[country] ?? ctx.identities.sellerForms.US;
  return [
    ctx.fill("sell.start.country", values.country),
    ctx.fillField("sell.start.country", "name", values.name),
    ctx.fillField("sell.start.country", "email", uniqueSellerEmail(values.email)),
  ];
}

async function fillSampleProduct(ctx: DevActionContext): Promise<Step[]> {
  const sample = ctx.identities.sampleProduct;
  const steps: Step[] = [
    ctx.fill("sell.product.title", sample.title),
    ctx.fillLabeled("sell.product.title", "Subtitle", sample.subtitle),
    ctx.fillLabeled("sell.product.title", "Category", sample.category),
    ctx.fill("sell.product.price", sample.price),
    ctx.fillLabeled("sell.product.title", "Description", sample.description),
    ctx.fillFiles("sell.product.files", [makeSampleFile(sample.fileName)]),
  ];
  const cover = await makePngFile(sample.coverName, "#f0e8d5");
  if (cover) steps.push(ctx.fillFiles("sell.product.cover", [cover]));
  return steps;
}

async function fillThen(
  ctx: DevActionContext,
  steps: Step[],
  submitAnchor: string,
  okNote: string,
): Promise<DevActionResult> {
  const filled = outcome(steps, okNote);
  if (!filled.ok) return filled;
  await ctx.settle();
  const clicked = ctx.click(submitAnchor);
  return clicked.ok ? { ok: true, note: okNote } : clicked;
}

/** Expands the first seller row when no panel is open, then finds `anchor` inside it. */
async function inFirstSellerPanel(ctx: DevActionContext, anchor: string): Promise<Step> {
  if (!anchorEl(anchor)) {
    const row = document.querySelector('[data-tour="admin.sellers.item"]');
    const opened = clickEl(row, "admin.sellers.item");
    if (!opened.ok) return opened;
    await ctx.settle(120);
  }
  return anchorEl(anchor) ? { ok: true, note: anchor } : { ok: false, note: `${anchor} not open` };
}

/* ------------------------------------------------------------------ */
/* Registry                                                             */
/* ------------------------------------------------------------------ */

export const DEV_ACTIONS: DevAction[] = [
  // signup
  {
    screen: "signup",
    id: "signup.fill-new-buyer",
    label: "Fill new test buyer",
    kind: "fill",
    run(ctx) {
      const who = ctx.newBuyer();
      return outcome(fillAuth(ctx, "signup", who), `Filled ${who.email}`);
    },
  },
  {
    screen: "signup",
    id: "signup.fill-submit",
    label: "Fill and submit",
    kind: "submit",
    run(ctx) {
      const who = ctx.newBuyer();
      return fillThen(ctx, fillAuth(ctx, "signup", who), "signup.submit", `Submitted ${who.email}`);
    },
  },
  switchAction("signup", "buyer"),
  switchAction("signup", "seller"),
  switchAction("signup", "operator"),

  // signin: no password form; each switch mints the run's profile session server-side
  switchAction("signin", "buyer"),
  switchAction("signin", "seller"),
  switchAction("signin", "operator"),

  // home, browse
  {
    screen: "home",
    id: "home.open-grain",
    label: "Open Grain & Gradient",
    kind: "navigate",
    run(ctx) {
      ctx.go("/p/grain-and-gradient");
      return { ok: true, note: "Opening /p/grain-and-gradient" };
    },
  },
  {
    screen: "browse",
    id: "browse.open-grain",
    label: "Open Grain & Gradient",
    kind: "navigate",
    run(ctx) {
      ctx.go("/p/grain-and-gradient");
      return { ok: true, note: "Opening /p/grain-and-gradient" };
    },
  },

  // product
  {
    screen: "product",
    id: "product.buy",
    label: "Buy",
    kind: "click",
    run: (ctx) => ctx.click("product.buy"),
  },

  // sell.start
  {
    screen: "sell.start",
    id: "sell.start.fill-us",
    label: "Fill seller form (US)",
    kind: "fill",
    run: (ctx) => outcome(fillSellerStart(ctx, "US"), "Filled Mara Okonkwo, US"),
  },
  {
    screen: "sell.start",
    id: "sell.start.fill-de",
    label: "Fill seller form (DE)",
    kind: "fill",
    run: (ctx) => outcome(fillSellerStart(ctx, "DE"), "Filled Studio Kontur, DE"),
  },
  {
    screen: "sell.start",
    id: "sell.start.fill-br",
    label: "Fill seller form (BR)",
    kind: "fill",
    run: (ctx) => outcome(fillSellerStart(ctx, "BR"), "Filled Onda Sounds, BR"),
  },
  {
    screen: "sell.start",
    id: "sell.start.fill-create",
    label: "Fill and create",
    kind: "submit",
    run: (ctx) =>
      fillThen(ctx, fillSellerStart(ctx, "BR"), "sell.start.submit", "Creating Onda Sounds, BR"),
  },

  // sell.onboarding
  {
    screen: "sell.onboarding",
    id: "sell.onboarding.open",
    label: "Open Whop onboarding",
    kind: "click",
    run: (ctx) => ctx.click("sell.onboarding.link"),
  },
  {
    screen: "sell.onboarding",
    id: "sell.onboarding.refresh",
    label: "Refresh status",
    kind: "click",
    run: (ctx) => ctx.click("sell.onboarding.refresh"),
  },

  // sell.product.new
  {
    screen: "sell.product.new",
    id: "sell.product.fill",
    label: "Fill sample product",
    kind: "fill",
    run: async (ctx) => outcome(await fillSampleProduct(ctx), "Filled Onda Drum Library"),
  },
  {
    screen: "sell.product.new",
    id: "sell.product.fill-publish",
    label: "Fill and publish",
    kind: "submit",
    run: async (ctx) =>
      fillThen(
        ctx,
        await fillSampleProduct(ctx),
        "sell.product.publish",
        "Publishing Onda Drum Library",
      ),
  },

  // sell.earnings
  {
    screen: "sell.earnings",
    id: "sell.earnings.withdraw",
    label: "Withdraw",
    kind: "click",
    run: (ctx) => ctx.click("sell.earnings.withdraw"),
  },

  // checkout
  {
    screen: "checkout",
    id: "checkout.open-whop",
    label: "Open Whop checkout",
    kind: "click",
    run() {
      const mount = anchorEl("checkout.provider");
      if (!mount) return { ok: false, note: "checkout.provider not on this page" };
      const link = mount.querySelector("a[href]");
      if (!link) return { ok: false, note: "This order has no checkout link yet" };
      return clickEl(link, "checkout link");
    },
  },

  // receipt
  {
    screen: "receipt",
    id: "receipt.refund",
    label: "Request refund",
    kind: "click",
    run: (ctx) => ctx.click("receipt.refund"),
  },

  // admin.sellers
  {
    screen: "admin.sellers",
    id: "admin.sellers.expand-first",
    label: "Expand first seller",
    kind: "click",
    run() {
      const row = document.querySelector('[data-tour="admin.sellers.item"]');
      if (row?.getAttribute("aria-expanded") === "true") {
        return { ok: true, note: "First seller already open" };
      }
      return clickEl(row, "admin.sellers.item");
    },
  },
  {
    screen: "admin.sellers",
    id: "admin.sellers.platform-only",
    label: "Set platform only",
    kind: "click",
    async run(ctx) {
      const open = await inFirstSellerPanel(ctx, "admin.sellers.policy");
      if (!open.ok) return open;
      const radio = anchorEl("admin.sellers.policy")?.querySelector('input[value="platform_only"]');
      return clickEl(radio ?? null, "policy platform_only");
    },
  },
  {
    screen: "admin.sellers",
    id: "admin.sellers.suspend",
    label: "Suspend (opens confirm)",
    kind: "click",
    async run(ctx) {
      const open = await inFirstSellerPanel(ctx, "admin.sellers.suspend");
      if (!open.ok) return open;
      return ctx.click("admin.sellers.suspend");
    },
  },

  // admin.ledger
  {
    screen: "admin.ledger",
    id: "admin.ledger.reconcile",
    label: "Reconcile",
    kind: "click",
    run: (ctx) => ctx.click("admin.ledger.reconcile"),
  },
];

export function actionsFor(screen: string | null): DevAction[] {
  if (!screen) return [];
  return DEV_ACTIONS.filter((action) => action.screen === screen);
}

/** Builds the context an action runs with. `go` defaults to a full navigation. */
export function makeContext(go: (path: string) => void): DevActionContext {
  return {
    fill: fillAnchor,
    fillField: fillFormField,
    fillLabeled,
    fillFiles: (anchor, files) => setFiles(anchorEl(anchor), files, anchor),
    click: clickAnchor,
    go,
    settle,
    identities: TEST_IDENTITIES,
    newBuyer,
    screen: currentScreen(),
  };
}

/** Runs one action against the current page and never throws. */
export async function runAction(
  action: DevAction,
  go: (path: string) => void = (path) => window.location.assign(path),
): Promise<DevActionResult> {
  try {
    return await action.run(makeContext(go));
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    return { ok: false, note: `${action.id} threw: ${reason}` };
  }
}

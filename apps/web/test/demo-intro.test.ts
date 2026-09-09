import { readFileSync, writeFileSync } from "node:fs";
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DemoIntro } from "@/app/demo/demo-intro";

const signOutProps = vi.hoisted(() => vi.fn());
vi.mock("@/components/buyer/SignOut", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/components/buyer/SignOut")>();
  return {
    SignOut: (props: ComponentProps<typeof original.SignOut>) => {
      signOutProps(props);
      return createElement(original.SignOut, props);
    },
  };
});

const defaults: ComponentProps<typeof DemoIntro> = {
  personaName: null,
  operator: false,
  user: null,
  why: null,
  startUrl: "/demo/start",
  returnTo: null,
  resumeStep: null,
  run: null,
};
const render = (props: Partial<typeof defaults> = {}) =>
  renderToStaticMarkup(createElement(DemoIntro, { ...defaults, ...props }));
const text = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const disclosure =
  "This runs on the real Ledgerly app and the Whop sandbox. Where the sandbox cannot complete a step today the demo says so on that step and uses a labelled simulation.";

// Details is closed initially. Everything before it and its summary is visible.
const defaultText = (html: string) => text(html.slice(0, html.indexOf("</summary>") + 10));

describe("demo entry", () => {
  it("renders the exact anonymous default copy with no session or database access", () => {
    const html = render();
    const visible = defaultText(html);
    expect(visible).toBe(`Explore Ledgerly in a guided demo. ${disclosure} Details`);
    expect(html.match(/This runs on the real Ledgerly app/g)).toHaveLength(1);
    expect(html).not.toMatch(/<details[^>]*\sopen|Readiness|W\d{2}|drift|refetch/i);
    expect(visible).not.toMatch(/Email|Password|Presenter sign-in|Start demo/);
    console.log(`DEFAULT ANONYMOUS TEXT\n${visible}\nEND DEFAULT ANONYMOUS TEXT`);
    console.log(
      `FULL ANONYMOUS TEXT (including collapsed details)\n${text(html)}\nEND FULL ANONYMOUS TEXT`,
    );
    const artifact = process.env.DEMO_INTRO_RENDER_PATH;
    if (artifact) {
      const css = [
        "src/app/globals.css",
        "src/components/buyer/buyer.css",
        "src/app/demo/demo-intro.css",
      ]
        .map((path) => readFileSync(path, "utf8").replace('@import "tailwindcss";', ""))
        .join("\n");
      writeFileSync(
        artifact,
        `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Demo intro render</title><style>${css}</style><body>${html}</body></html>`,
      );
    }
  });

  it("keeps real, simulated and return information inside Details", () => {
    const html = render({ returnTo: "/present?slide=closing" });
    const details = html.slice(html.indexOf("<details"));
    expect(details).toContain(
      "Real: app sign-in, database records and supported Whop sandbox calls.",
    );
    expect(details).toContain(
      "Simulated: steps the sandbox cannot complete, labelled on the step.",
    );
    expect(details).toContain('href="/present?slide=closing"');
  });

  it("nests the existing presenter form and preserves its destination", () => {
    const html = render({ startUrl: "/demo/start?from=deck" });
    expect(html.indexOf('class="demo-intro-signin"')).toBeGreaterThan(
      html.indexOf('class="demo-intro-details"'),
    );
    expect(html).toContain("Presenter sign-in</summary><form");
    expect(html).toContain('data-tour="signin.submit"');
    expect(html).toContain('href="/signup?next=%2Fdemo%2Fstart%3Ffrom%3Ddeck"');
  });

  it("offers Start demo for an operator at the supplied destination", () => {
    const html = render({ operator: true, startUrl: "/demo/start?from=deck" });
    expect(defaultText(html)).toContain("Start demo");
    expect(html).toContain('href="/demo/start?from=deck"');
  });

  it("offers Start demo for a persona session without a presenter form", () => {
    const html = render({
      personaName: "Sample",
      user: { email: "sample@example.test", isPersona: true },
    });
    expect(defaultText(html)).toContain("Start demo");
    expect(html).not.toContain("<form");
  });

  it("does not offer manual sign-in or Start demo for an anonymous configured persona", () => {
    const html = render({ personaName: "Sample" });
    expect(html).not.toMatch(/Start demo|Presenter sign-in|<form/);
  });

  it("keeps persona failure concise and preserves the Details fold", () => {
    for (const personaName of [null, "Sample"]) {
      const html = render({ personaName, why: "persona" });
      expect(defaultText(html)).toContain("The demo account could not sign in; see Details.");
      expect(html).toContain("Details</summary>");
      expect(html.includes("<form")).toBe(personaName === null);
    }
  });

  it("keeps account switching and the exact resume destination without fixed step ids", () => {
    const step = { id: "chapter-resume", title: "Resume chapter", path: "/account" };
    const html = render({
      user: { email: "buyer@example.test" },
      why: "role",
      startUrl: `/account?return=%2Fpresent&from=deck&tour=${step.id}&run=sample-run`,
      returnTo: "/present",
      resumeStep: step,
      run: "sample-run",
    });
    expect(defaultText(html)).toContain(
      "This account is not an operator; sign out to switch accounts. Sign out",
    );
    expect(html).not.toContain("Start demo");
    expect(signOutProps).toHaveBeenLastCalledWith({
      correlationId: "demo-intro",
      next: `/demo?return=%2Fpresent&from=deck&run=sample-run&step=${step.id}`,
    });
  });
});

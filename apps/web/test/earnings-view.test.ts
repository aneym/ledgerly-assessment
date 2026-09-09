// @vitest-environment jsdom
import { act, type ComponentProps, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EarningsView } from "@/components/seller/EarningsView";
import { ondaFixtureLedger } from "@/lib/seller/ledger";

type Props = ComponentProps<typeof EarningsView>;
const defaults: Props = {
  sellerId: "seller-a",
  sellerName: "Seller A",
  readable: true,
  correlationId: "earnings-test",
  // Deliberately supply the old fixture even for a readable seller. The view must
  // protect its first render independently of the page's choice of initial data.
  initial: ondaFixtureLedger(),
  chargeModel: "Direct charge",
  withdrawHref: "/sell/payouts?seller=seller-a",
};

// A controlled HTTP boundary, not a provider read. Exercise the real API client,
// ledger normalizer, and React DOM with a known $25 gross / $2 fee / $23 net sale.
function responseBody(
  item = "Current seller purchase",
  amounts = { gross: 2500, fee: 200, net: 2300 },
) {
  return {
    available: { amountMinor: amounts.net, currency: "USD" },
    pending: { amountMinor: 0, currency: "USD" },
    held: { amountMinor: 0, currency: "USD" },
    currency: "USD",
    provenance: "live",
    charge_model: "direct",
    rows: [
      {
        id: "current-sale",
        item,
        date: "2026-09-09",
        order_id: "current-order",
        status: "settled",
        gross: { amountMinor: amounts.gross, currency: "USD" },
        fee: { amountMinor: amounts.fee, currency: "USD" },
        net: { amountMinor: amounts.net, currency: "USD" },
      },
    ],
  };
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Response>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

let container: HTMLDivElement;
let root: Root;
let fetchStub: ReturnType<typeof vi.fn<typeof fetch>>;
let commits: string[];

// Layout effects run after DOM commit and before passive effects. This records
// the first commit on an identity change, so an effect-only reset cannot pass.
function CommitProbe({ props }: { props: Props }) {
  useLayoutEffect(() => {
    commits.push(container.innerHTML);
  });
  return createElement(EarningsView, props);
}

async function render(overrides: Partial<Props> = {}) {
  commits = [];
  await act(async () =>
    root.render(createElement(CommitProbe, { props: { ...defaults, ...overrides } })),
  );
  expect(commits.length).toBeGreaterThan(0);
  return commits[0];
}

function expectNoFinancialData(html = container.innerHTML) {
  expect(html).not.toMatch(/\$\d/);
  expect(html).not.toContain("Onda Drum Library");
  expect(html).not.toContain("Streetlight Sessions");
  expect(html).not.toContain("Withdraw");
  expect(html).not.toContain("<table");
  expect(html).not.toContain('aria-label="Balances"');
  expect(html).not.toContain("Read from the app API");
  expect(html).not.toContain("LIVE data");
}

async function answer(request: ReturnType<typeof deferredResponse>, body = responseBody()) {
  await act(async () => request.resolve(Response.json(body)));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fetchStub = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchStub);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  commits = [];
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("earnings rendering across request lifetimes", () => {
  it("withholds money, rows, and Withdraw in server HTML before effects or hydration", () => {
    const html = renderToStaticMarkup(createElement(EarningsView, defaults));
    expect(html).toContain("Reading your earnings");
    expectNoFinancialData(html);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("keeps delayed reads neutral, then shows the actual $23 response and its row", async () => {
    const request = deferredResponse();
    fetchStub.mockReturnValueOnce(request.promise);
    expectNoFinancialData(await render());
    expectNoFinancialData();
    expect(container.textContent).toContain("Reading your earnings");
    expect(fetchStub).toHaveBeenCalledWith(
      "/api/sellers/seller-a/earnings",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
    await answer(request);
    expect(container.querySelector('[data-tour="sell.earnings.available"]')?.textContent).toContain(
      "$23.00",
    );
    expect(container.querySelector('[data-tour="sell.earnings.withdraw"]')?.textContent).toBe(
      "Withdraw $23.00",
    );
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(container.querySelector("tbody")?.textContent).toContain("Current seller purchase");
    expect(container.querySelector("tbody")?.textContent).toContain("$25.00");
    expect(container.querySelector("tbody")?.textContent).toContain("$2.00");
    expect(container.textContent).toContain("Read from the app API");
    expect(container.textContent).toContain("LIVE");
    expect(container.textContent).not.toContain("$66.24");
    expect(container.textContent).not.toContain("Reading your earnings");
  });

  it("renders a confirmed empty ledger as zero only after its response", async () => {
    const request = deferredResponse();
    fetchStub.mockReturnValueOnce(request.promise);
    await render({ initial: null });
    expectNoFinancialData();
    await act(async () =>
      request.resolve(
        Response.json({
          available: { amountMinor: 0, currency: "USD" },
          pending: { amountMinor: 0, currency: "USD" },
          held: { amountMinor: 0, currency: "USD" },
          rows: [],
        }),
      ),
    );
    expect(container.textContent).toContain("$0.00");
    expect(container.textContent).toContain("No transactions yet");
    expect(container.textContent).not.toContain("Onda");
  });

  for (const failure of ["http", "network", "unexpected"] as const) {
    it(`keeps a ${failure} failure unavailable without substituting fixture money or zero`, async () => {
      const request = deferredResponse();
      fetchStub.mockReturnValueOnce(request.promise);
      await render();
      await act(async () => {
        if (failure === "network") request.reject(new Error("offline"));
        else if (failure === "http")
          request.resolve(Response.json({ error: "unavailable" }, { status: 503 }));
        else request.resolve(new Response("not JSON", { status: 200 }));
      });
      expectNoFinancialData();
      expect(container.querySelector('[role="status"]')?.textContent).toContain(
        "Earnings for Seller A are unavailable",
      );
      expect(container.querySelector("[data-fail-kind]")?.getAttribute("data-fail-kind")).toBe(
        failure,
      );
      expect(container.textContent).not.toContain("Onda");
    });
  }

  it("invalidates seller A in B's first commit and keeps B's failure free of A's data", async () => {
    const a = deferredResponse();
    const b = deferredResponse();
    fetchStub.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    await render();
    await answer(a, responseBody("Seller A private sale"));
    expect(container.textContent).toContain("Seller A private sale");
    const firstB = await render({ sellerId: "seller-b", sellerName: "Seller B" });
    expectNoFinancialData(firstB);
    expect(firstB).not.toContain("Seller A private sale");
    expect(firstB).toContain("Reading your earnings");
    expect(fetchStub.mock.calls[1][0]).toBe("/api/sellers/seller-b/earnings");
    await act(async () => b.resolve(Response.json({ error: "not_found" }, { status: 404 })));
    expectNoFinancialData();
    expect(container.textContent).toContain("Earnings for Seller B are unavailable");
    expect(container.textContent).not.toContain("Seller A private sale");
    expect(container.textContent).not.toContain("Onda");
  });

  for (const late of ["success", "failure"] as const) {
    it(`ignores a late A ${late} after B's response`, async () => {
      const a = deferredResponse();
      const b = deferredResponse();
      fetchStub.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
      await render();
      expectNoFinancialData(await render({ sellerId: "seller-b", sellerName: "Seller B" }));
      await answer(b, responseBody("Seller B purchase", { gross: 5000, fee: 400, net: 4600 }));
      await act(async () => {
        a.resolve(
          late === "success"
            ? Response.json(responseBody("Seller A private sale"))
            : Response.json({ error: "old_failure" }, { status: 503 }),
        );
      });
      expect(container.textContent).toContain("Seller B purchase");
      expect(container.textContent).toContain("Withdraw $46.00");
      expect(container.textContent).not.toContain("Seller A private sale");
      expect(container.textContent).not.toContain("old_failure");
    });
  }

  it("ignores late A while B is pending, even if the same A identity is later selected again", async () => {
    const oldA = deferredResponse();
    const b = deferredResponse();
    const newA = deferredResponse();
    fetchStub
      .mockReturnValueOnce(oldA.promise)
      .mockReturnValueOnce(b.promise)
      .mockReturnValueOnce(newA.promise);
    await render();
    await render({ sellerId: "seller-b" });
    await answer(oldA, responseBody("Old A sale"));
    expectNoFinancialData();
    expectNoFinancialData(await render());
    await answer(b, responseBody("Old B sale"));
    expectNoFinancialData();
    await answer(newA, responseBody("Fresh A sale"));
    expect(container.textContent).toContain("Fresh A sale");
    expect(container.textContent).not.toContain("Old A sale");
    expect(container.textContent).not.toContain("Old B sale");
  });

  it("invalidates a completed read when its correlation context changes", async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    fetchStub.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await render();
    await answer(first);
    expectNoFinancialData(await render({ correlationId: "new-run" }));
    const headers = fetchStub.mock.calls[1][1]?.headers as Headers;
    expect(headers.get("x-ledgerly-correlation-id")).toBe("new-run");
    await answer(second, responseBody("New run sale"));
    expect(container.textContent).toContain("New run sale");
  });

  it("labels explicit fixture data and removes it on the first readable commit", async () => {
    await render({ readable: false });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Sample earnings for Onda Sounds");
    expect(container.textContent).toContain("$66.24");
    expect(container.textContent).toContain("Onda Drum Library");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(7);
    const request = deferredResponse();
    fetchStub.mockReturnValueOnce(request.promise);
    expectNoFinancialData(await render());
    await answer(request);
    expect(container.textContent).toContain("Withdraw $23.00");
  });

  it("does not invent zero or retain an API ledger when the reader becomes unconfigured", async () => {
    const request = deferredResponse();
    fetchStub.mockReturnValueOnce(request.promise);
    await render();
    await answer(request);
    expectNoFinancialData(await render({ readable: false, initial: null }));
    expect(container.textContent).toContain("No seller ledger is configured");
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("keeps explicit fixture mode when the previous live request finishes late", async () => {
    const request = deferredResponse();
    fetchStub.mockReturnValueOnce(request.promise);
    await render();
    await render({ readable: false });
    await answer(request);
    expect(container.textContent).toContain("Sample earnings for Onda Sounds");
    expect(container.textContent).toContain("$66.24");
    expect(container.textContent).not.toContain("Current seller purchase");
  });
});

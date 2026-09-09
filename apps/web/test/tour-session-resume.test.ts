import { expect, it } from "vitest";
import { personaSessionHandler } from "../src/app/demo/session/route";

function handler(status = 200) {
  let calls = 0;
  return {
    calls: () => calls,
    run: personaSessionHandler({
      isDemoMode: () => true,
      persona: () => ({
        name: "Fictional operator",
        email: "operator@ledgerly.test",
        password: "test-only",
      }),
      signIn: async () => {
        calls++;
        return new Response(null, {
          status,
          headers: { "set-cookie": "session=fixture; HttpOnly" },
        });
      },
    }),
  };
}
it.each(["C06", "C07"])(
  "resumes %s in the same run after real sign-in dependency returns",
  async (step) => {
    const h = handler();
    const response = await h.run(
      new Request(`http://local/demo/session?step=${step}&run=run_42&return=%2Fpresent&from=demo`),
    );
    const location = new URL(response.headers.get("location") ?? "", "http://local");
    expect(response.status).toBe(303);
    expect(location.pathname).toBe("/admin/issues");
    expect(Object.fromEntries(location.searchParams)).toEqual({
      tour: step,
      run: "run_42",
      return: "/present",
      from: "demo",
    });
    expect(response.headers.get("set-cookie")).toContain("session=fixture");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(h.calls()).toBe(1);
  },
);
it.each(["step=unknown&run=run_42", "step=C06", "step=C06&run=bad%2Frun", "step=&run=run_42"])(
  "rejects invalid resume before signing in: %s",
  async (query) => {
    const h = handler();
    expect((await h.run(new Request(`http://local/demo/session?${query}`))).status).toBe(400);
    expect(h.calls()).toBe(0);
  },
);
it("preserves run and step on sign-in failure without forwarding cookies", async () => {
  const response = await handler(401).run(
    new Request("http://local/demo/session?step=C06&run=run_42&return=%2Fpresent&from=demo"),
  );
  const location = new URL(response.headers.get("location") ?? "", "http://local");
  expect(location.pathname).toBe("/demo");
  expect(Object.fromEntries(location.searchParams)).toEqual({
    step: "C06",
    run: "run_42",
    return: "/present",
    from: "demo",
    why: "persona",
  });
  expect(response.headers.get("set-cookie")).toBeNull();
});

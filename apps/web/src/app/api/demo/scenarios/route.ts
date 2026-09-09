import { ASSESSMENT_SCENARIOS, runAssessmentScenario } from "@/lib/assessment-scenarios";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store", "X-Ledgerly-Source": "mock" };

// Public by design: fixed fictional inputs, new memory per request, no application
// session, database, provider credentials, or live adapter reachable from this route.
export async function GET() {
  return Response.json(
    { mode: "mock", isolated: true, scenarios: ASSESSMENT_SCENARIOS },
    { headers },
  );
}

export async function POST(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
    return Response.json({ error: "Use application/json." }, { status: 415, headers });
  }
  // Bound actual bytes, including requests with absent or dishonest Content-Length.
  const reader = request.body?.getReader();
  if (!reader)
    return Response.json({ error: "A scenario selection is required." }, { status: 400, headers });
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 1024) {
      await reader.cancel();
      return Response.json(
        { error: "Scenario selection exceeds 1024 bytes." },
        { status: 413, headers },
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400, headers });
  }
  const result = await runAssessmentScenario(input);
  if (!result.ok) return Response.json({ error: result.error.message }, { status: 400, headers });
  return Response.json(result.value, { headers });
}

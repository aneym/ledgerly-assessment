import { tool } from "ai";
import { z } from "zod";
import { GET as getIssue } from "../issues/[id]/route";
import { GET as listIssues } from "../issues/route";
import { GET as getLedgerEntry } from "../ledger/[id]/route";
import { GET as listLedger } from "../ledger/route";

// A separate tool set prevents deployment-wide lookup and health tools from running
// under a demo session. Each call reuses the HTTP handler's session and scope checks.
export function createDemoAssistantTools(request: Request) {
  const read = async (handler: (request: Request) => Promise<Response>, path: string) => {
    const response = await handler(
      new Request(new URL(path, request.url), { headers: request.headers }),
    );
    return response.json();
  };
  const idSchema = z.object({ id: z.string().trim().min(1).max(200) });
  const listSchema = z.object({ limit: z.number().int().min(1).max(50).default(20) });
  return {
    getIssue: tool({
      description: "Read an issue in this demo run.",
      inputSchema: idSchema,
      execute: ({ id }) =>
        read(
          (req) => getIssue(req, { params: Promise.resolve({ id }) }),
          `/api/admin/issues/${encodeURIComponent(id)}`,
        ),
    }),
    listIssues: tool({
      description: "List issues in this demo run.",
      inputSchema: listSchema,
      execute: ({ limit }) => read(listIssues, `/api/admin/issues?limit=${limit}`),
    }),
    getLedgerEntry: tool({
      description: "Read a ledger entry in this demo run.",
      inputSchema: idSchema,
      execute: ({ id }) =>
        read(
          (req) => getLedgerEntry(req, { params: Promise.resolve({ id }) }),
          `/api/admin/ledger/${encodeURIComponent(id)}`,
        ),
    }),
    listLedger: tool({
      description: "List ledger entries and totals in this demo run.",
      inputSchema: listSchema,
      execute: ({ limit }) => read(listLedger, `/api/admin/ledger?limit=${limit}`),
    }),
  };
}

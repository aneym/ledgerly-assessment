// Catch-all for any /api path no route handler claims. Without it Next.js answers an
// unmatched POST with the HTML not-found page and status 200 (QA-F26), so a UI control
// posting to a route that does not exist reads as success. Every method answers 404 JSON.
export const runtime = "nodejs";

function notFound(request: Request): Response {
  const path = new URL(request.url).pathname;
  return Response.json(
    { error: "not_found", message: `${request.method} ${path} is not an API route` },
    { status: 404 },
  );
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;

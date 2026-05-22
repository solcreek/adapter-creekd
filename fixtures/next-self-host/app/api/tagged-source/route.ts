export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    {
      origin: Date.now(),
    },
    {
      headers: {
        "cache-control": "private, no-store",
      },
    },
  );
}

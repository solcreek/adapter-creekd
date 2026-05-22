export const dynamic = "force-dynamic";

async function readTaggedData() {
  const baseUrl = process.env.BENCH_BASE_URL ?? "http://127.0.0.1:3000";
  const response = await fetch(`${baseUrl}/api/tagged-source`, {
    next: {
      revalidate: 3600,
      tags: ["bench-products"],
    },
  });

  if (!response.ok) {
    throw new Error(`tagged-source failed: ${response.status}`);
  }

  return response.json() as Promise<{ origin: number }>;
}

export default async function TaggedPage() {
  const data = await readTaggedData();
  return (
    <main>
      <h1>Tagged fetch cache</h1>
      <code data-bench-origin={data.origin}>{data.origin}</code>
    </main>
  );
}

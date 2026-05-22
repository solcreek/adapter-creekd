import { Suspense } from "react";

export const dynamic = "force-dynamic";

async function SlowSegment() {
  await new Promise((resolve) => setTimeout(resolve, 150));
  const now = Date.now();
  return <span data-bench-slow={now}>{now}</span>;
}

export default function StreamingPage() {
  return (
    <main>
      <h1>Streaming</h1>
      <span data-bench-shell="ready">ready</span>
      <Suspense fallback={<span data-bench-fallback="pending">pending</span>}>
        <SlowSegment />
      </Suspense>
    </main>
  );
}

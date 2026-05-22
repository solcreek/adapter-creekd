export const revalidate = 1;

export default function IsrPage() {
  const now = Date.now();
  return (
    <main>
      <h1>ISR</h1>
      <time data-bench-origin={now}>{now}</time>
    </main>
  );
}

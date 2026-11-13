export function FullScreenLoading({ label = 'Memuat…' }: { label?: string }) {
  return (
    <div className="centered-page" aria-busy="true">
      <main className="centered-main loading-main" id="main">
        <span className="spinner" aria-hidden="true" />
        <p role="status">{label}</p>
      </main>
    </div>
  );
}

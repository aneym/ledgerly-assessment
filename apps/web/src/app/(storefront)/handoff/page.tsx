export default function Handoff() {
  return (
    <main style={{ maxWidth: 800, margin: "80px auto", padding: 24 }}>
      <h1>Ledgerly assessment source</h1>
      <p>
        This export runs locally with PGlite and a mock provider. See the repository README for
        setup, both money-flow sequence diagrams, and the assessment answers.
      </p>
      <p>
        Local results demonstrate application behavior. They do not prove hosted identity
        verification, successful provider refunds or transfers, bank settlement, or the missing
        provider webhook payloads.
      </p>
      <p>
        Private provider responses and recordings are excluded. The local product and labeled
        assessment scenarios remain available.
      </p>
      <p>Customer Loom: I will add that soon.</p>
      <a href="/">Open the marketplace</a>
    </main>
  );
}

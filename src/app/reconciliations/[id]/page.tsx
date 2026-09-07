type ReconciliationPageProps = {
  params: Promise<{ id: string }>;
};

export default async function ReconciliationPage({ params }: ReconciliationPageProps) {
  const { id } = await params;

  return (
    <main>
      <h1>Reconciliation</h1>
      <p>/reconciliations/{id}</p>
    </main>
  );
}

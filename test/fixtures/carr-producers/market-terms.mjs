function rebuildMarketTerms(snapshot, query = {}) {
  const groups = /* @__PURE__ */ new Map();
  for (const receipt of snapshot.receipts) {
    const key = JSON.stringify([receipt.entity_ref, receipt.fact_key, receipt.term_kind]);
    const group = groups.get(key) ?? [];
    group.push(receipt);
    groups.set(key, group);
  }
  const rows = [...groups.values()].flatMap((group) => {
    group.sort((a, b) => a.effective_from.localeCompare(b.effective_from) || b.version - a.version);
    const periods = group.filter((receipt, index) => index === 0 || receipt.effective_from !== group[index - 1].effective_from);
    return periods.flatMap((receipt, index) => {
      const next = periods[index + 1]?.effective_from;
      const end = next && (!receipt.effective_to || next < receipt.effective_to) ? next : receipt.effective_to;
      if (!receipt.eligible || query.submarket && receipt.submarket !== query.submarket || query.use_type && receipt.use_type !== query.use_type || query.as_of && (receipt.effective_from > query.as_of || end && query.as_of >= end)) return [];
      const { eligible, ...row } = receipt;
      return [{ ...row, effective_to: end, source_coverage: {
        supporting_observations: row.sources.length,
        supporting_documents: new Set(row.sources.map((source) => source.document_ref)).size,
        unaffected_observations: row.sources.filter((source) => !source.quarantined).length
      } }];
    });
  }).sort((a, b) => a.entity_ref.localeCompare(b.entity_ref) || a.fact_key.localeCompare(b.fact_key) || a.term_kind.localeCompare(b.term_kind) || a.effective_from.localeCompare(b.effective_from));
  return {
    ok: true,
    schema_version: "market-terms.v1",
    empty: rows.length === 0,
    rows,
    coverage: {
      ...snapshot.coverage,
      coverage_scope: "tenant_all_recorded_sources",
      unclassified_receipts: snapshot.coverage.canonical_receipts - snapshot.coverage.classified_receipts,
      eligible_receipts: snapshot.receipts.filter((receipt) => receipt.eligible).length,
      unsupported_receipts: snapshot.receipts.filter((receipt) => !receipt.eligible).length,
      superseded_without_context: snapshot.coverage.classified_receipts - snapshot.receipts.length,
      comparable_rows: rows.length,
      comparable_deals: new Set(rows.map((row) => row.entity_ref)).size
    }
  };
}

export { rebuildMarketTerms };

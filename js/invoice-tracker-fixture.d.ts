export type InvoiceEntry = {
  status: string | null;
  received_on: string | null;
  commission_invoiced_on: string | null;
  commission_id: string | null;
  [key: string]: unknown;
};
export type InvoiceSnapshot = { entries: InvoiceEntry[]; [key: string]: unknown };
export declare function invoiceTrackerFixture(today: string): InvoiceSnapshot;

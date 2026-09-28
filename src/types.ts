export interface PrinterConfig {
  id: string; name: string; host: string; port: number; paperWidthMm: number;
  printableWidthDots: number | null; renderMode: string; codePage: number;
  cutEnabled: boolean; beeperEnabled: boolean; configVersion: number;
}
export interface PrintItem { orderItemId: string; itemName: string; variantName: string | null; quantity: number; modifiers: string[]; note: string | null }
export interface PrintUpdateChange {
  orderItemId: string; itemName: string; variantName: string | null; modifiers: string[]; note: string | null;
  changeType: 'added' | 'increased' | 'reduced' | 'cancelled'; previousQuantity: number; newQuantity: number;
  quantityDelta: number; reason: string | null;
}
export interface PrintPayload {
  schemaVersion: 1; kind: 'new_kot' | 'order_update' | 'reprint' | 'test_print'; sourceKind?: 'order_update';
  tenantId?: string; branchId?: string;
  order?: { id: string; orderNumber: string; source: string; tableNumber: string | null; customerName: string | null; cashierName: string | null; createdAt: string; note: string | null };
  station: { id: string; name: string } | null; kotRevision: number | null;
  items: PrintItem[]; branch: { name: string; timezone?: string };
  changes?: PrintUpdateChange[];
  currentItems?: PrintItem[];
  actorName?: string | null;
  printing: { createdAt: string; originalJobId: string | null; originalOrderNumber: string | null; testPrinterName?: string };
}
export interface ClaimedJob { id: string; status: string; payload: PrintPayload; printer: PrinterConfig }

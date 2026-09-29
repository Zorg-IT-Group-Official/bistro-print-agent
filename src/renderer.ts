import { ClaimedJob, PrintPayload } from './types.js';

const ESC = 0x1b;
const GS = 0x1d;
const MAX_CHARS = 32; // Font A at 58mm; deliberately conservative for common heads.

function assertAscii(value: string): void {
  if ([...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) > 126)) {
    throw new Error('unsupported_character: Text print mode currently supports printable ASCII only; configure validated raster/code-page rendering before using this printer for other scripts');
  }
}

function wrap(value: string, width: number): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (word.length > width) {
      if (line) lines.push(line);
      line = '';
      for (let i = 0; i < word.length; i += width) lines.push(word.slice(i, i + width));
      continue;
    }
    if (!line) line = word;
    else if (`${line} ${word}`.length <= width) line += ` ${word}`;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function separator(width: number): string { return '-'.repeat(width); }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validatePayload(value: unknown): asserts value is PrintPayload {
  if (!isRecord(value)) throw new Error('malformed_payload: Print payload must be an object');
  const supportedKinds = ['new_kot', 'order_update', 'reprint', 'test_print'];
  if (typeof value.kind !== 'string' || !supportedKinds.includes(value.kind)) {
    throw new Error(`unsupported_job_kind: ${String(value.kind ?? 'missing')}`);
  }
  if (value.schemaVersion !== 1) throw new Error('malformed_payload: Unsupported schema version');
  if (value.kind === 'reprint' && value.sourceKind !== undefined && value.sourceKind !== 'new_kot' && value.sourceKind !== 'order_update') {
    throw new Error('malformed_payload: Unsupported reprint source kind');
  }
  if (!isRecord(value.printing) || typeof value.printing.createdAt !== 'string') {
    throw new Error('malformed_payload: Missing print metadata');
  }
  if (value.kind === 'test_print') return;
  if (!Array.isArray(value.items) || !isRecord(value.branch)) {
    throw new Error('malformed_payload: Missing branch or item list');
  }
  const validItem = (item: unknown) => isRecord(item) &&
    typeof item.itemName === 'string' && typeof item.quantity === 'number' && Number.isFinite(item.quantity) &&
    Array.isArray(item.modifiers) && item.modifiers.every((modifier) => typeof modifier === 'string');
  if (!value.items.every(validItem)) throw new Error('malformed_payload: Invalid item row');
  if (value.kind === 'order_update' || (value.kind === 'reprint' && value.sourceKind === 'order_update')) {
    const validChange = (change: unknown) => {
      if (!isRecord(change) || typeof change.itemName !== 'string' ||
        !['added', 'increased', 'reduced', 'cancelled'].includes(String(change.changeType)) ||
        !Array.isArray(change.modifiers) || !change.modifiers.every((modifier) => typeof modifier === 'string')) return false;
      const { previousQuantity, newQuantity, quantityDelta, changeType } = change;
      const validQuantity = (quantity: unknown): quantity is number =>
        typeof quantity === 'number' && Number.isFinite(quantity) && Number.isInteger(quantity) && quantity >= 0;
      if (!validQuantity(previousQuantity) || !validQuantity(newQuantity) || !validQuantity(quantityDelta)) return false;
      if (changeType === 'added') return previousQuantity === 0 && newQuantity > 0 && quantityDelta === newQuantity;
      if (changeType === 'increased') return newQuantity > previousQuantity && quantityDelta === newQuantity - previousQuantity;
      if (changeType === 'reduced') return previousQuantity > newQuantity && newQuantity > 0 && quantityDelta === previousQuantity - newQuantity;
      return previousQuantity > 0 && newQuantity === 0 && quantityDelta === previousQuantity;
    };
    if (!Array.isArray(value.changes) || !value.changes.every(validChange)) {
      throw new Error('malformed_payload: Invalid update changes');
    }
    if (value.currentItems !== undefined && (!Array.isArray(value.currentItems) || !value.currentItems.every(validItem))) {
      throw new Error('malformed_payload: Invalid current station items');
    }
  }
}

export function renderKot(job: Pick<ClaimedJob, 'payload' | 'printer'>): Buffer {
  if (job.printer.renderMode !== 'text') throw new Error('unsupported_render_mode: This agent build supports text mode only');
  if (job.printer.paperWidthMm !== 58) throw new Error('unsupported_paper_width: This agent build is validated for 58mm only');
  if (job.printer.beeperEnabled) throw new Error('unsupported_beeper: Beeper output has not been validated for this printer model');
  if (job.printer.codePage !== 0) throw new Error('unsupported_code_page: This build supports printable ASCII only');
  const width = MAX_CHARS;
  validatePayload(job.payload);
  const p: PrintPayload = job.payload;
  const chunks: number[] = [ESC, 0x40, ESC, 0x45, 1]; // initialize; bold on
  const line = (text: string) => {
    assertAscii(text);
    for (const part of wrap(text, width)) chunks.push(...Buffer.from(part, 'ascii'), 0x0a);
  };
  const centered = (text: string) => { chunks.push(ESC, 0x61, 1); line(text); chunks.push(ESC, 0x61, 0); };
  if (p.kind === 'test_print') {
    centered('BISTRO OS PRINTER TEST');
    line(separator(width));
    line(`Printer: ${p.printing.testPrinterName ?? 'Configured printer'}`);
    line(`Printed: ${new Date(p.printing.createdAt).toLocaleString('en-GB')}`);
    line('ESC/POS TCP test complete');
  } else {
    const isUpdate = p.kind === 'order_update' || p.sourceKind === 'order_update';
    if (isUpdate) {
      centered('ORDER UPDATE');
      chunks.push(ESC, 0x45, 1, GS, 0x21, 0x01);
      centered('NOT A NEW ORDER');
      chunks.push(GS, 0x21, 0x00);
      line(`Order: ${p.order?.orderNumber ?? 'UNKNOWN'}`);
      line(`Table: ${p.order?.tableNumber || (p.order?.source === 'takeaway' ? 'Takeaway' : p.order?.source === 'delivery' ? 'Delivery' : 'N/A')}`);
      line(`Revision: ${p.kotRevision ?? 'N/A'}`);
      line(`Station: ${p.station?.name ?? 'Kitchen'}`);
      line(`Time: ${p.printing.createdAt ? new Date(p.printing.createdAt).toLocaleString('en-GB', { timeZone: p.branch.timezone ?? 'UTC' }) : ''}`);
      if (p.kind === 'reprint') line('*** REPRINT ***');
      line(separator(width));
      const labels = [
        ['added', 'ADDED'], ['increased', 'QTY INCREASED'], ['reduced', 'QTY REDUCED'], ['cancelled', 'CANCELLED'],
      ] as const;
      const changes = p.changes ?? [];
      const itemLabel = (change: NonNullable<PrintPayload['changes']>[number]) =>
        change.variantName ? `${change.itemName} (${change.variantName})` : change.itemName;
      for (const [type, heading] of labels) {
        const rows = changes.filter((change) => change.changeType === type);
        if (!rows.length) continue;
        line(heading);
        for (const change of rows) {
          const label = itemLabel(change);
          if (type === 'added' || type === 'cancelled') {
            line(`${change.quantityDelta}x ${label}`);
          } else {
            line(label);
            line(`Previous: ${change.previousQuantity}`);
            line(`New: ${change.newQuantity}`);
            line(`${type === 'increased' ? 'Add' : 'Remove'}: ${change.quantityDelta}`);
          }
          for (const modifier of change.modifiers) line(`  - ${modifier}`);
          if (change.note) line(`Note: ${change.note}`);
          if (type === 'cancelled' && change.reason) line(`Reason: ${change.reason}`);
        }
        line(separator(width));
      }
      line('CURRENT STATION ORDER');
      for (const item of p.currentItems ?? []) {
        const label = item.variantName ? `${item.itemName} (${item.variantName})` : item.itemName;
        line(`${item.quantity}x ${label}`);
      }
      if (p.actorName) line(`Cashier: ${p.actorName}`);
    } else {
    centered(p.station?.name ? `${p.station.name.toUpperCase()} TOKEN` : 'KITCHEN TOKEN');
    chunks.push(ESC, 0x45, 1, GS, 0x21, 0x01);
    const orderNumber = p.order?.orderNumber ?? 'UNKNOWN';
    const orderLabel = `Order No: ${orderNumber}`;
    if (orderLabel.length <= width) line(orderLabel);
    else { line('Order No:'); line(orderNumber); }
    chunks.push(GS, 0x21, 0x00);
    line(`Date: ${p.order?.createdAt ? new Date(p.order.createdAt).toLocaleString('en-GB', { timeZone: p.branch.timezone ?? 'UTC' }) : ''}`);
    line(`Customer: ${p.order?.customerName || 'Walk-in Customer'}`);
    const table = p.order?.tableNumber || (p.order?.source === 'takeaway' ? 'Takeaway' : p.order?.source === 'delivery' ? 'Delivery' : 'N/A');
    line(`Table: ${table}`);
    line(`Cashier: ${p.order?.cashierName || 'N/A'}`);
    if (p.kind === 'reprint') line(`*** REPRINT ${p.printing.originalOrderNumber ?? ''} ***`);
    line(separator(width));
    line('Item Name'.padEnd(width - 5) + 'QTY'.padStart(5));
    line(separator(width));
    for (const item of p.items) {
      const label = item.variantName ? `${item.itemName} (${item.variantName})` : item.itemName;
      assertAscii(label);
      const firstWidth = width - 5;
      const wrapped = wrap(label, firstWidth);
      chunks.push(GS, 0x21, 0x01); // double-height only; retain the 32-column width
      line(wrapped[0].padEnd(firstWidth) + String(item.quantity).slice(-5).padStart(5));
      chunks.push(GS, 0x21, 0x00);
      for (const more of wrapped.slice(1)) line(more);
      for (const modifier of item.modifiers) for (const modifierLine of wrap(`  - ${modifier}`, width)) line(modifierLine);
    }
    line(separator(width));
    line(`Total Item: ${p.items.reduce((n, item) => n + item.quantity, 0)}`);
    const notes = [
      ...p.items.filter((item) => item.note).map((item) => `${item.itemName}: ${item.note}`),
      p.order?.note,
    ].filter((n): n is string => Boolean(n));
    if (notes.length) {
      line(separator(width)); line('Notes:');
      for (const note of notes) for (const noteLine of wrap(note!, width)) line(noteLine);
    }
    }
  }
  chunks.push(ESC, 0x45, 0, ESC, 0x64, 4);
  if (job.printer.cutEnabled) chunks.push(GS, 0x56, 0); // full cut; only when enabled by profile
  return Buffer.from(chunks);
}

export const rendererInternals = { wrap, MAX_CHARS };

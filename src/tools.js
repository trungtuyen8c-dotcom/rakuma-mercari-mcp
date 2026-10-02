import { z } from 'zod';

const qs = params => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? '?' + s : '';
};

const text = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const failure = msg => ({ content: [{ type: 'text', text: msg }], isError: true });

// Maps an API result to an MCP tool result. Soft warnings (duplicate link/tracking, overselling) are not errors:
// the model must show them to the user and only retry with confirm_warnings=true after the user agrees.
function toResult(res, onOk = d => d) {
  if (res.ok) return text(onOk(res.data));
  if (res.warnings?.length) {
    return text({
      saved: false,
      needs_confirmation: true,
      warnings: res.warnings,
      next_step: 'Show these warnings to the user. Retry with confirm_warnings=true only if the user confirms.',
    });
  }
  if (res.errors) return failure('Invalid input: ' + JSON.stringify(res.errors));
  if (res.status === 401) return failure('API key is missing, wrong or revoked.');
  if (res.status === 403) return failure('This API key is read-only; create a "Đọc và ghi" key in Cài đặt to add data.');
  return failure(res.error || `Request failed (HTTP ${res.status})`);
}

// Accepts a product id or its exact name (spaces trimmed, case-insensitive).
async function resolveProduct(client, ref) {
  const res = await client.get('/products');
  if (!res.ok) return { error: toResult(res) };
  const want = String(ref).trim();
  const hit = res.data.find(p => p.id === want) || res.data.find(p => p.name.trim().toLowerCase() === want.toLowerCase());
  if (!hit) return { error: failure(`Product "${ref}" not found. Use list_products to see names, or add_product to create it.`) };
  return { product: hit };
}

const period = z.string().optional().describe('Period id from list_periods; omit for the open period');
const readOnly = { readOnlyHint: true, openWorldHint: false };
const additive = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export function registerTools(server, client) {
  server.registerTool('get_dashboard', {
    title: 'Dashboard',
    description: 'Cumulative cost, revenue and cash-flow profit (revenue - cost), this period\'s purchases/sales, total stock and negative-stock products. Money is integer yen.',
    inputSchema: { period_id: period },
    annotations: readOnly,
  }, async ({ period_id }) => toResult(await client.get('/dashboard' + qs({ period_id }))));

  server.registerTool('list_periods', {
    title: 'List periods',
    description: 'Monthly accounting periods with status OPEN/CLOSED and opening/closing cost and revenue.',
    inputSchema: {},
    annotations: readOnly,
  }, async () => toResult(await client.get('/periods')));

  server.registerTool('list_products', {
    title: 'List products',
    description: 'Product catalog: id, name, active flag and number of transactions.',
    inputSchema: {},
    annotations: readOnly,
  }, async () => toResult(await client.get('/products')));

  server.registerTool('get_stock', {
    title: 'Stock',
    description: 'Stock per product for a period: opening + purchased - sold = current.',
    inputSchema: { period_id: period, only_negative: z.boolean().optional().describe('Only products with negative stock') },
    annotations: readOnly,
  }, async ({ period_id, only_negative }) => toResult(await client.get('/stock' + qs({ period_id })),
    d => (only_negative ? { ...d, rows: d.rows.filter(r => r.current < 0) } : d)));

  server.registerTool('list_purchases', {
    title: 'List purchases',
    description: 'Purchase rows (both REGULAR and BULK sources). Includes duplicate flags for link and tracking number.',
    inputSchema: { period_id: z.string().optional().describe('Period id; omit for all periods'), product: z.string().optional().describe('Filter by product id or name') },
    annotations: readOnly,
  }, async ({ period_id, product }) => {
    let pid;
    if (product) {
      const r = await resolveProduct(client, product);
      if (r.error) return r.error;
      pid = r.product.id;
    }
    return toResult(await client.get('/purchases' + qs({ period_id })), rows => (pid ? rows.filter(r => r.productId === pid) : rows));
  });

  server.registerTool('list_sales', {
    title: 'List sales',
    description: 'Sale rows with quantity, unit price, shipping paid by the shop, total and customer.',
    inputSchema: { period_id: z.string().optional().describe('Period id; omit for all periods'), product: z.string().optional().describe('Filter by product id or name') },
    annotations: readOnly,
  }, async ({ period_id, product }) => {
    let pid;
    if (product) {
      const r = await resolveProduct(client, product);
      if (r.error) return r.error;
      pid = r.product.id;
    }
    return toResult(await client.get('/sales' + qs({ period_id })), rows => (pid ? rows.filter(r => r.productId === pid) : rows));
  });

  server.registerTool('analyze_product', {
    title: 'Product profit analysis',
    description: 'All-time sold/purchased quantities and amounts, cost of goods sold taken LIFO from the latest purchases, and profit.',
    inputSchema: { product: z.string().describe('Product id or exact name') },
    annotations: readOnly,
  }, async ({ product }) => {
    const r = await resolveProduct(client, product);
    if (r.error) return r.error;
    return toResult(await client.get('/analysis/products/' + r.product.id));
  });

  server.registerTool('add_product', {
    title: 'Add product',
    description: 'Add a product to the catalog (needs a read-write key). Names must be unique.',
    inputSchema: { name: z.string().min(1) },
    annotations: additive,
  }, async ({ name }) => toResult(await client.post('/products', { name })));

  server.registerTool('add_purchase', {
    title: 'Add purchase',
    description: 'Record a purchase in the open period (needs a read-write key). Total = (price - discount per unit) x qty.',
    inputSchema: {
      product: z.string().describe('Product id or exact name'),
      price: z.number().int().positive().describe('Unit price in yen'),
      qty: z.number().int().min(1),
      discount: z.number().int().min(0).optional().describe('Discount per unit in yen'),
      source: z.enum(['REGULAR', 'BULK']).optional().describe('REGULAR = Nhập hàng, BULK = Nhập lô lớn'),
      date: z.string().optional().describe('Order date YYYY-MM-DD inside the open period'),
      link: z.string().optional().describe('Rakuma/Mercari item URL'),
      tracking: z.string().optional().describe('Tracking number, as text'),
      merged: z.boolean().optional().describe('Several items shipped in one parcel under the same tracking number'),
      note: z.string().optional(),
      confirm_warnings: z.boolean().optional().describe('Save despite duplicate link/tracking warnings; only after the user confirms'),
    },
    annotations: additive,
  }, async ({ product, confirm_warnings, ...rest }) => {
    const r = await resolveProduct(client, product);
    if (r.error) return r.error;
    return toResult(await client.post('/purchases' + qs({ force: confirm_warnings ? 'true' : undefined }), { ...rest, productId: r.product.id }));
  });

  server.registerTool('add_sale', {
    title: 'Add sale',
    description: 'Record a sale in the open period (needs a read-write key). Total = qty x price - shipping paid by the shop. A 0¥ price takes opened items out of stock and asks for confirmation.',
    inputSchema: {
      product: z.string().describe('Product id or exact name'),
      qty: z.number().int().min(1),
      price: z.number().int().min(0).describe('Unit price in yen; 0 records opened stock ("bóc hàng"): stock goes down, no revenue'),
      ship: z.number().int().min(0).optional().describe('Shipping paid by the shop, in yen'),
      date: z.string().optional().describe('Sale date YYYY-MM-DD inside the open period'),
      customer: z.string().optional(),
      note: z.string().optional(),
      confirm_warnings: z.boolean().optional().describe('Save even if stock goes negative; only after the user confirms'),
    },
    annotations: additive,
  }, async ({ product, confirm_warnings, ...rest }) => {
    const r = await resolveProduct(client, product);
    if (r.error) return r.error;
    return toResult(await client.post('/sales' + qs({ force: confirm_warnings ? 'true' : undefined }), { ...rest, productId: r.product.id }));
  });
}

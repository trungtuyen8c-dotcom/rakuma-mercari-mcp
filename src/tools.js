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

const period = z.string().optional().describe('Period id from list_periods; omit for the newest open period');
const writePeriod = z.string().optional().describe('Period id from list_periods. Omit to pick by date (the open period containing it), else the newest open period. Any period works, closed ones too.');
const readOnly = { readOnlyHint: true, openWorldHint: false };
const additive = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const editing = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const destructive = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
const force = confirm => qs({ force: confirm ? 'true' : undefined });
const confirmWarnings = z.boolean().optional().describe('Save despite warnings (duplicate link/tracking, negative stock); only after the user confirms');

// Finds one row by id in a list endpoint, so partial edits can be merged into the full row the API expects.
async function findRow(client, path, id) {
  const res = await client.get(path);
  if (!res.ok) return { error: toResult(res) };
  const row = res.data.find(r => r.id === String(id));
  if (!row) return { error: failure(`No row with id ${id}. Use ${path === '/sales' ? 'list_sales' : 'list_purchases'} to find it.`) };
  return { row };
}

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
    description: 'Record a purchase (needs a read-write key). Total = (price - discount per unit) x qty.',
    inputSchema: {
      product: z.string().describe('Product id or exact name'),
      price: z.number().int().positive().describe('Unit price in yen'),
      qty: z.number().int().min(1),
      discount: z.number().int().min(0).optional().describe('Discount per unit in yen'),
      source: z.enum(['REGULAR', 'BULK']).optional().describe('REGULAR = Nhập hàng, BULK = Nhập lô lớn'),
      date: z.string().optional().describe('Order date YYYY-MM-DD'),
      period_id: writePeriod,
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
    const { period_id, ...body } = rest;
    return toResult(await client.post('/purchases' + force(confirm_warnings), { ...body, periodId: period_id, productId: r.product.id }));
  });

  server.registerTool('add_sale', {
    title: 'Add sale',
    description: 'Record a sale (needs a read-write key). Total = qty x price - shipping paid by the shop. A 0¥ price takes opened items out of stock and asks for confirmation.',
    inputSchema: {
      product: z.string().describe('Product id or exact name'),
      qty: z.number().int().min(1),
      price: z.number().int().min(0).describe('Unit price in yen; 0 records opened stock ("bóc hàng"): stock goes down, no revenue'),
      ship: z.number().int().min(0).optional().describe('Shipping paid by the shop, in yen'),
      date: z.string().optional().describe('Sale date YYYY-MM-DD'),
      period_id: writePeriod,
      customer: z.string().optional(),
      note: z.string().optional(),
      confirm_warnings: z.boolean().optional().describe('Save even if stock goes negative; only after the user confirms'),
    },
    annotations: additive,
  }, async ({ product, confirm_warnings, ...rest }) => {
    const r = await resolveProduct(client, product);
    if (r.error) return r.error;
    const { period_id, ...body } = rest;
    return toResult(await client.post('/sales' + force(confirm_warnings), { ...body, periodId: period_id, productId: r.product.id }));
  });

  // Edits. The owner works alone and every period stays editable, closed ones included; later periods follow.

  server.registerTool('update_purchase', {
    title: 'Edit purchase',
    description: 'Change fields of a purchase row in any period (closed ones too; later periods recompute). Only the given fields change. Confirm the change with the user first.',
    inputSchema: {
      id: z.string().describe('Purchase id from list_purchases'),
      product: z.string().optional().describe('Product id or exact name'),
      price: z.number().int().positive().optional(),
      qty: z.number().int().min(1).optional(),
      discount: z.number().int().min(0).optional().describe('Discount per unit'),
      source: z.enum(['REGULAR', 'BULK']).optional(),
      date: z.string().optional().describe('YYYY-MM-DD, inside the row\'s period; "" clears it'),
      link: z.string().optional(),
      tracking: z.string().optional(),
      merged: z.boolean().optional(),
      note: z.string().optional(),
      confirm_warnings: confirmWarnings,
    },
    annotations: editing,
  }, async ({ id, product, confirm_warnings, ...changes }) => {
    const f = await findRow(client, '/purchases', id);
    if (f.error) return f.error;
    const r = f.row;
    let productId = r.productId;
    if (product) {
      const p = await resolveProduct(client, product);
      if (p.error) return p.error;
      productId = p.product.id;
    }
    const body = {
      periodId: r.periodId, productId, source: r.source, date: r.date, price: r.price, qty: r.qty, discount: r.discount,
      tracking: r.tracking, merged: r.merged, link: r.link, note: r.note, ...changes,
    };
    return toResult(await client.put('/purchases/' + r.id + force(confirm_warnings), body));
  });

  server.registerTool('set_purchase_status', {
    title: 'Purchase check / review / tracking',
    description: 'Tick "Đã kiểm" (goods arrived OK) and/or "Đã đánh giá" (seller rated), or set the tracking number, on a purchase row.',
    inputSchema: {
      id: z.string().describe('Purchase id from list_purchases'),
      checked: z.boolean().optional(),
      reviewed: z.boolean().optional(),
      tracking: z.string().optional().describe('Tracking number; "" clears it'),
    },
    annotations: editing,
  }, async ({ id, ...body }) => toResult(await client.patch('/purchases/' + id, body)));

  server.registerTool('delete_purchase', {
    title: 'Delete purchase',
    description: 'Delete a purchase row in any period; later periods recompute. Always confirm with the user first, naming the row.',
    inputSchema: { id: z.string() },
    annotations: destructive,
  }, async ({ id }) => toResult(await client.del('/purchases/' + id), () => ({ deleted: id })));

  server.registerTool('update_sale', {
    title: 'Edit sale',
    description: 'Change fields of a sale row in any period (later periods recompute). Only the given fields change. Confirm with the user first.',
    inputSchema: {
      id: z.string().describe('Sale id from list_sales'),
      product: z.string().optional().describe('Product id or exact name'),
      qty: z.number().int().min(1).optional(),
      price: z.number().int().min(0).optional(),
      ship: z.number().int().min(0).optional(),
      date: z.string().optional().describe('YYYY-MM-DD, inside the row\'s period; "" clears it'),
      customer: z.string().optional(),
      note: z.string().optional(),
      confirm_warnings: confirmWarnings,
    },
    annotations: editing,
  }, async ({ id, product, confirm_warnings, ...changes }) => {
    const f = await findRow(client, '/sales', id);
    if (f.error) return f.error;
    const r = f.row;
    let productId = r.productId;
    if (product) {
      const p = await resolveProduct(client, product);
      if (p.error) return p.error;
      productId = p.product.id;
    }
    const body = { periodId: r.periodId, productId, date: r.date, qty: r.qty, price: r.price, ship: r.ship, customer: r.customer, note: r.note, ...changes };
    return toResult(await client.put('/sales/' + r.id + force(confirm_warnings), body));
  });

  server.registerTool('delete_sale', {
    title: 'Delete sale',
    description: 'Delete a sale row in any period; later periods recompute. Always confirm with the user first, naming the row.',
    inputSchema: { id: z.string() },
    annotations: destructive,
  }, async ({ id }) => toResult(await client.del('/sales/' + id), () => ({ deleted: id })));

  server.registerTool('set_stock', {
    title: 'Correct stock (stock count)',
    description: 'Set a product\'s current stock in a period to the counted number. The difference is stored as that period\'s adjustment and later periods follow.',
    inputSchema: {
      product: z.string().describe('Product id or exact name'),
      qty: z.number().int().describe('Counted current quantity'),
      period_id: period,
    },
    annotations: editing,
  }, async ({ product, qty, period_id }) => {
    const r = await resolveProduct(client, product);
    if (r.error) return r.error;
    return toResult(await client.put(`/stock/${r.product.id}/current` + qs({ period_id }), { qty }));
  });

  server.registerTool('set_period_totals', {
    title: 'Correct total cost / revenue',
    description: 'Set a period\'s cumulative total cost and/or total revenue (as shown on the dashboard). The difference is stored as a manual adjustment; profit and later periods follow. Prefer editing the wrong rows when they are known.',
    inputSchema: {
      period_id: z.string().describe('Period id from list_periods'),
      total_cost: z.number().int().min(0).optional(),
      total_revenue: z.number().int().min(0).optional(),
    },
    annotations: editing,
  }, async ({ period_id, total_cost, total_revenue }) =>
    toResult(await client.put(`/periods/${period_id}/totals`, { totalCost: total_cost, totalRevenue: total_revenue })));

  server.registerTool('open_next_period', {
    title: 'Open next month',
    description: 'Open the month after the latest period while the current one stays open (at most two open). Closing a month is done by the owner in the web app.',
    inputSchema: { start: z.string().optional().describe('YYYY-MM-DD cut-off: the new month starts that day and the previous one ends the day before') },
    annotations: additive,
  }, async ({ start }) => toResult(await client.post('/periods/open-next', start ? { start } : {})));

  // Rakuma purchase sync: Claude scrapes the owner's fril.jp history and pushes it; the owner reviews in the app.

  server.registerTool('list_rakuma_orders', {
    title: 'Rakuma orders',
    description: 'Orders synced from Rakuma with status, tracking, seller messages, the owner\'s Vietnamese replies (PENDING ones must be translated to Japanese and posted on Rakuma), issue notes and ratings.',
    inputSchema: {
      filter: z.enum(['all', 'queue', 'issues', 'new_messages', 'pending_replies', 'open_chat']).optional()
        .describe('queue = waiting to become a purchase; issues = has an issue note; open_chat = chat still open on Rakuma'),
    },
    annotations: readOnly,
  }, async ({ filter = 'all' }) => toResult(await client.get('/rakuma/orders'), rows => rows.filter(o => ({
    all: true,
    queue: !o.purchaseId && !o.dismissed,
    issues: !!o.issueNote,
    new_messages: o.newMessages > 0,
    pending_replies: o.replies.some(r => r.status === 'PENDING'),
    open_chat: o.chatOpen,
  })[filter])));

  server.registerTool('sync_rakuma_orders', {
    title: 'Push scraped Rakuma orders',
    description: 'Upsert orders scraped from fril.jp (by orderNo). Empty date/tracking/summary/replyDraft keep stored values. Never send the shipping address.',
    inputSchema: {
      orders: z.array(z.object({
        orderNo: z.string(), link: z.string(), title: z.string(), image: z.string().optional(), status: z.string().optional(),
        date: z.string().optional().describe('購入手続完了日 as YYYY-MM-DD'), price: z.number().int().positive(),
        discount: z.number().int().min(0).optional(), carrier: z.string().optional(), tracking: z.string().optional(),
        seller: z.string().optional(), summary: z.string().optional().describe('Vietnamese summary of the chat'),
        replyDraft: z.string().optional().describe('Suggested Japanese reply'), chatOpen: z.boolean().optional(),
        messages: z.array(z.object({ from: z.enum(['seller', 'buyer']), at: z.string().optional(), body: z.string() })).optional(),
      })).min(1),
    },
    annotations: editing,
  }, async ({ orders }) => toResult(await client.post('/rakuma/sync', { orders })));

  server.registerTool('mark_rakuma_reply_sent', {
    title: 'Mark Rakuma reply sent',
    description: 'After posting a pending reply on Rakuma, record the Japanese text that was posted.',
    inputSchema: { reply_id: z.string(), body_ja: z.string().min(1) },
    annotations: editing,
  }, async ({ reply_id, body_ja }) => toResult(await client.post(`/rakuma/replies/${reply_id}/sent`, { bodyJa: body_ja })));

  server.registerTool('skip_rakuma_reply', {
    title: 'Skip Rakuma reply',
    description: 'Record that a pending reply could not be posted (e.g. the chat is closed).',
    inputSchema: { reply_id: z.string(), reason: z.string().min(1), chat_closed: z.boolean().optional() },
    annotations: editing,
  }, async ({ reply_id, reason, chat_closed }) =>
    toResult(await client.post(`/rakuma/replies/${reply_id}/skip`, { reason, chatClosed: !!chat_closed })));
}

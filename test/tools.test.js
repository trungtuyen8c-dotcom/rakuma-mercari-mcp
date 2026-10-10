import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { RakumaClient } from '../src/client.js';
import { registerTools } from '../src/tools.js';

// Fake API: records calls and answers from a route table.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    const u = new URL(url);
    const key = `${init.method} ${u.pathname}${u.search}`;
    calls.push({ key, auth: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : undefined });
    const [status, body] = routes[key] || [404, { error: 'not found' }];
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  };
  fn.calls = calls;
  return fn;
}

async function connect(routes) {
  const fetchImpl = fakeFetch(routes);
  const server = new McpServer({ name: 'rakuma', version: 'test' });
  registerTools(server, new RakumaClient({ baseUrl: 'http://api.test/', apiKey: 'rk_live_x', fetchImpl }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, calls: fetchImpl.calls };
}

const products = [{ id: '7', name: '30th Celebration', active: true, txCount: 3 }];

test('lists the expected tools', async () => {
  const { client } = await connect({});
  const names = (await client.listTools()).tools.map(t => t.name).sort();
  assert.deepEqual(names, ['add_product', 'add_purchase', 'add_sale', 'analyze_product', 'delete_purchase', 'delete_sale',
    'get_dashboard', 'get_stock', 'list_periods', 'list_products', 'list_purchases', 'list_rakuma_orders', 'list_sales',
    'mark_rakuma_reply_sent', 'open_next_period', 'set_period_totals', 'set_purchase_status', 'set_reply_translation', 'set_stock', 'skip_rakuma_reply',
    'sync_rakuma_orders', 'update_purchase', 'update_sale']);
});

test('sends the API key and resolves product names', async () => {
  const { client, calls } = await connect({
    'GET /api/v1/products': [200, products],
    'GET /api/v1/analysis/products/7': [200, { productId: '7', cogs: 900 }],
  });
  const res = await client.callTool({ name: 'analyze_product', arguments: { product: ' 30TH celebration ' } });
  assert.equal(res.isError, undefined);
  assert.equal(JSON.parse(res.content[0].text).cogs, 900);
  assert.equal(calls[0].auth, 'Bearer rk_live_x');
});

test('warnings need confirmation before saving', async () => {
  const warn = ['Chỉ còn 0 cái “30th Celebration”, bạn đang bán 1 cái. Tồn kho sẽ âm 1 cái.'];
  const { client, calls } = await connect({
    'GET /api/v1/products': [200, products],
    'POST /api/v1/sales': [409, { warnings: warn }],
    'POST /api/v1/sales?force=true': [201, { id: '1', total: 6800 }],
  });
  const first = await client.callTool({ name: 'add_sale', arguments: { product: '7', qty: 1, price: 6800 } });
  const body = JSON.parse(first.content[0].text);
  assert.equal(body.saved, false);
  assert.deepEqual(body.warnings, warn);

  const second = await client.callTool({ name: 'add_sale', arguments: { product: '7', qty: 1, price: 6800, confirm_warnings: true } });
  assert.equal(JSON.parse(second.content[0].text).total, 6800);
  assert.deepEqual(calls.at(-1).body, { qty: 1, price: 6800, productId: '7' });
});

test('read-only key gets a clear error', async () => {
  const { client } = await connect({ 'POST /api/v1/products': [403, { error: 'forbidden' }] });
  const res = await client.callTool({ name: 'add_product', arguments: { name: 'abc' } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /read-only/);
});

test('unknown product is reported, nothing is posted', async () => {
  const { client, calls } = await connect({ 'GET /api/v1/products': [200, products] });
  const res = await client.callTool({ name: 'add_purchase', arguments: { product: 'nope', price: 100, qty: 1 } });
  assert.equal(res.isError, true);
  assert.equal(calls.filter(c => c.key.startsWith('POST')).length, 0);
});

test('update_purchase changes only the given fields', async () => {
  const row = { id: '5', periodId: '1', productId: '7', source: 'BULK', date: '', price: 25000, qty: 1, discount: 0,
    tracking: '', merged: false, link: 'https://item.fril.jp/a', note: '' };
  const { client, calls } = await connect({
    'GET /api/v1/purchases': [200, [row]],
    'PUT /api/v1/purchases/5': [200, { ...row, qty: 2, total: 50000 }],
  });
  const res = await client.callTool({ name: 'update_purchase', arguments: { id: '5', qty: 2 } });
  assert.equal(JSON.parse(res.content[0].text).total, 50000);
  assert.deepEqual(calls.at(-1).body, { periodId: '1', productId: '7', source: 'BULK', date: '', price: 25000, qty: 2, discount: 0,
    tracking: '', merged: false, link: 'https://item.fril.jp/a', note: '' });
});

test('set_stock resolves the product and targets the period', async () => {
  const { client, calls } = await connect({
    'GET /api/v1/products': [200, products],
    'PUT /api/v1/stock/7/current?period_id=1': [200, { productId: '7', current: 4, adjust: -2 }],
  });
  const res = await client.callTool({ name: 'set_stock', arguments: { product: '30th celebration', qty: 4, period_id: '1' } });
  assert.equal(JSON.parse(res.content[0].text).adjust, -2);
  assert.deepEqual(calls.at(-1).body, { qty: 4 });
});

test('list_rakuma_orders filters pending replies', async () => {
  const orders = [
    { id: '1', purchaseId: null, dismissed: false, issueNote: '', newMessages: 0, chatOpen: true, replies: [{ status: 'PENDING' }] },
    { id: '2', purchaseId: '9', dismissed: false, issueNote: 'móp', newMessages: 1, chatOpen: false, replies: [] },
  ];
  const { client } = await connect({ 'GET /api/v1/rakuma/orders': [200, orders] });
  const pick = async filter => JSON.parse((await client.callTool({ name: 'list_rakuma_orders', arguments: { filter } })).content[0].text).map(o => o.id);
  assert.deepEqual(await pick('pending_replies'), ['1']);
  assert.deepEqual(await pick('issues'), ['2']);
  assert.deepEqual(await pick('queue'), ['1']);
});

test('set_reply_translation stores the Japanese text with PUT', async () => {
  const { client, calls } = await connect({ 'PUT /api/v1/rakuma/replies/5/translation': [200, { id: '1' }] });
  const res = await client.callTool({ name: 'set_reply_translation', arguments: { reply_id: '5', body_ja: 'ありがとうございます。' } });
  assert.equal(res.isError, undefined);
  assert.deepEqual(calls[0], { key: 'PUT /api/v1/rakuma/replies/5/translation', auth: 'Bearer rk_live_x', body: { bodyJa: 'ありがとうございます。' } });
});

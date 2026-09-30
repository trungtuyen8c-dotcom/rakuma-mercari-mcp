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
  assert.deepEqual(names, ['add_product', 'add_purchase', 'add_sale', 'analyze_product', 'get_dashboard', 'get_stock', 'list_periods', 'list_products', 'list_purchases', 'list_sales']);
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

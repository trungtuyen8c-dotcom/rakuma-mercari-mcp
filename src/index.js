#!/usr/bin/env node
// Rakuma MCP server (stdio). Env: RAKUMA_API_URL (e.g. http://localhost:8088), RAKUMA_API_KEY (rk_live_...).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RakumaClient } from './client.js';
import { registerTools } from './tools.js';

let client;
try {
  client = new RakumaClient({ baseUrl: process.env.RAKUMA_API_URL, apiKey: process.env.RAKUMA_API_KEY });
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const server = new McpServer({ name: 'rakuma', version: '0.1.0' });
registerTools(server, client);
await server.connect(new StdioServerTransport());

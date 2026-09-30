# rakuma-mercari-mcp

A stdio MCP server that lets Claude read, and optionally add, Rakuma data through the API.

1. In the web app, open **Cài đặt > API key cho MCP** and create a key. Choose **Chỉ đọc** (read) or **Đọc và ghi** (read and write).
2. Run `npm install` in this folder.
3. Add the server to Claude Desktop (`claude_desktop_config.json`) or Claude Code (`claude mcp add`):

```json
{
  "mcpServers": {
    "rakuma": {
      "command": "node",
      "args": ["/absolute/path/to/rakuma-mercari-mcp/src/index.js"],
      "env": { "RAKUMA_API_URL": "http://localhost:8088", "RAKUMA_API_KEY": "rk_live_..." }
    }
  }
}
```

**Tools**
- Read: `get_dashboard`, `list_periods`, `list_products`, `get_stock`, `list_purchases`, `list_sales`, `analyze_product`.
- Write key only: `add_product`, `add_purchase`, `add_sale`.

Some writes trigger warnings: a duplicate link or tracking number, or a sale that would make stock negative. These writes are not saved. The warnings are returned first, and the write is retried with `confirm_warnings: true` only after the user agrees. Editing, deleting, closing a period and changing settings stay owner-only in the web app.

Run the tests with `npm test`.

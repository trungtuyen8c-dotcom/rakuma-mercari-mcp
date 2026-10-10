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
- Read: `get_dashboard`, `list_periods`, `list_products`, `get_stock`, `list_purchases`, `list_sales`, `analyze_product`, `list_rakuma_orders`.
- Write key: `add_product`, `add_purchase`, `add_sale`; edit any period (closed ones too, later periods recompute): `update_purchase`, `update_sale`, `set_purchase_status`, `delete_purchase`, `delete_sale`, `set_stock` (stock count), `set_period_totals` (manual correction of total cost/revenue); `open_next_period`; Rakuma sync: `sync_rakuma_orders`, `mark_rakuma_reply_sent`, `skip_rakuma_reply`; `set_reply_translation` saves the Japanese text of a pending reply so the owner can send it from the Chrome extension.

Some writes trigger warnings: a duplicate link or tracking number, or a sale that would make stock negative. These writes are not saved. The warnings are returned first, and the write is retried with `confirm_warnings: true` only after the user agrees. Deletes and edits should be confirmed with the user first. Closing a period, approving Rakuma orders, writing replies, settings and API keys stay owner-only in the web app.

Run the tests with `npm test`.

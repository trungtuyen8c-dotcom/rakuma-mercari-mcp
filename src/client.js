// HTTP client for the Rakuma API, authenticated with an API key created in Cài đặt > API key cho MCP.
export class RakumaClient {
  constructor({ baseUrl, apiKey, fetchImpl = fetch }) {
    if (!baseUrl) throw new Error('RAKUMA_API_URL is required, e.g. http://localhost:8088');
    if (!apiKey) throw new Error('RAKUMA_API_KEY is required (create one in Cài đặt > API key cho MCP)');
    this.base = baseUrl.replace(/\/+$/, '') + '/api/v1';
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
  }

  // Resolves to { ok, status, data, error, errors, warnings }; never throws on HTTP errors.
  async request(method, path, body) {
    const res = await this.fetch(this.base + path, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    if (res.status !== 204) {
      try { data = await res.json(); } catch { data = null; }
    }
    if (res.ok) return { ok: true, status: res.status, data };
    return { ok: false, status: res.status, error: data?.error, errors: data?.errors, warnings: data?.warnings };
  }

  get(path) { return this.request('GET', path); }
  post(path, body) { return this.request('POST', path, body ?? {}); }
}

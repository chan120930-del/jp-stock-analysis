export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=3600');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }

  const BASE = 'https://edinetdb.jp/v1';
  const action = String(req.query.action || '');
  const apiKey = process.env.EDINET_DB_API_KEY || '';

  async function getJson(url, authenticated = false) {
    const headers = authenticated && apiKey ? { 'X-API-Key': apiKey } : {};
    const response = await fetch(url, { headers });
    const text = await response.text();

    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      const err = new Error('EDINET DBからJSON以外の応答が返りました');
      err.status = 502;
      err.detail = text ? text.slice(0, 300) : 'empty response';
      throw err;
    }

    if (!response.ok) {
      const err = new Error(body?.message || body?.error || `EDINET DB ${response.status}`);
      err.status = response.status;
      err.detail = body;
      throw err;
    }

    return body;
  }

  function unwrap(payload) {
    if (payload && typeof payload === 'object' && 'data' in payload) return payload.data;
    return payload;
  }

  try {
    if (action === 'status') {
      return res.status(200).json({ ok: true, hasKey: Boolean(apiKey) });
    }

    if (action === 'search') {
      const q = String(req.query.q || '').trim();
      if (!q) return res.status(400).json({ error: '検索語を入力してください' });

      const raw = await getJson(`${BASE}/search?q=${encodeURIComponent(q)}`, false);
      return res.status(200).json({
        data: unwrap(raw),
        retrievedAt: new Date().toISOString(),
      });
    }

    if (action === 'analyze') {
      const code = String(req.query.code || '').trim();
      if (!code) return res.status(400).json({ error: 'EDINETコードが必要です' });
      if (!apiKey) {
        return res.status(500).json({
          error: 'MISSING_API_KEY',
          message: 'EDINET_DB_API_KEYがVercelのProduction環境に設定されていません',
        });
      }

      const companyUrl = `${BASE}/companies/${encodeURIComponent(code)}?fields=profile,latest_financials`;
      const financialsUrl = `${BASE}/companies/${encodeURIComponent(code)}/financials?years=6&period=annual&include_null_reasons=true&include_field_meta=true`;
      const ratiosUrl = `${BASE}/companies/${encodeURIComponent(code)}/ratios?include_field_meta=true`;

      const [companyRaw, financialsRaw, ratiosRaw] = await Promise.all([
        getJson(companyUrl, true),
        getJson(financialsUrl, true),
        getJson(ratiosUrl, true),
      ]);

      return res.status(200).json({
        company: unwrap(companyRaw),
        financials: unwrap(financialsRaw),
        ratios: unwrap(ratiosRaw),
        retrievedAt: new Date().toISOString(),
      });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (error) {
    return res.status(error.status || 500).json({
      error: error.message || 'API error',
      detail: error.detail || null,
    });
  }
}

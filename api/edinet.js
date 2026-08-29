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

  function nestedArrays(value, out = []) {
    if (Array.isArray(value)) {
      out.push(value);
      for (const item of value) nestedArrays(item, out);
    } else if (value && typeof value === 'object') {
      for (const item of Object.values(value)) nestedArrays(item, out);
    }
    return out;
  }

  function bestArray(value, predicate) {
    if (Array.isArray(value) && value.some(predicate)) return value;
    return nestedArrays(value)
      .filter((arr) => arr.some(predicate))
      .sort((a, b) => b.length - a.length)[0] || [];
  }

  function fiscal(row) {
    return String(row?.fiscal_year ?? row?.fiscalYear ?? row?.year ?? row?.period ?? '');
  }

  function asNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function latestBy(rows, keyGetter) {
    return [...rows].sort((a, b) => keyGetter(a).localeCompare(keyGetter(b))).at(-1) || null;
  }

  function prependValuationNote(company, note) {
    if (!company || typeof company !== 'object' || !note) return;
    const existing =
      company.business_summary ??
      company.businessSummary ??
      company.business_description ??
      '';

    company.business_summary = existing
      ? `${note}\n\n${existing}`
      : note;
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
      const earningsUrl = `${BASE}/companies/${encodeURIComponent(code)}/earnings?limit=8`;

      const [companyRaw, financialsRaw, ratiosRaw, earningsRaw] = await Promise.all([
        getJson(companyUrl, true),
        getJson(financialsUrl, true),
        getJson(ratiosUrl, true),
        // 予想データだけ取得に失敗しても、従来の分析画面は壊さない
        getJson(earningsUrl, true).catch(() => null),
      ]);

      const company = unwrap(companyRaw);
      const financials = unwrap(financialsRaw);
      const ratios = unwrap(ratiosRaw);
      const earnings = unwrap(earningsRaw);

      const financialRows = bestArray(
        financials,
        (x) => x && typeof x === 'object' && ('fiscal_year' in x || 'year' in x)
      );
      const ratioRows = bestArray(
        ratios,
        (x) => x && typeof x === 'object' && ('fiscal_year' in x || 'year' in x)
      );
      const earningsRows = bestArray(
        earnings,
        (x) =>
          x &&
          typeof x === 'object' &&
          ('forecast_eps' in x || 'adjusted_forecast_eps' in x || 'disclosure_date' in x)
      );

      const latestFinancial = latestBy(financialRows, fiscal);
      const latestFiscal = fiscal(latestFinancial);
      const latestRatio =
        ratioRows.find((row) => fiscal(row) === latestFiscal) ||
        latestBy(ratioRows, fiscal);

      const forecastRecord = [...earningsRows]
        .sort((a, b) => {
          const ak = `${a?.disclosure_date ?? ''} ${a?.disclosure_time ?? ''}`;
          const bk = `${b?.disclosure_date ?? ''} ${b?.disclosure_time ?? ''}`;
          return bk.localeCompare(ak);
        })
        .find((row) => {
          const adjusted = asNumber(row?.adjusted_forecast_eps);
          const raw = asNumber(row?.forecast_eps);
          return (adjusted != null && adjusted > 0) || (raw != null && raw > 0);
        }) || null;

      const actualEps =
        asNumber(latestFinancial?.adjusted_eps) ??
        asNumber(latestFinancial?.eps);

      let forecastEps = null;
      let forecastBasisWarning = false;

      if (forecastRecord) {
        const adjustedForecast = asNumber(forecastRecord.adjusted_forecast_eps);
        const rawForecast = asNumber(forecastRecord.forecast_eps);
        const shareBasis = String(forecastRecord.forecast_share_basis || '');

        if (adjustedForecast != null && adjustedForecast > 0) {
          forecastEps = adjustedForecast;
        } else if (shareBasis !== 'indeterminate' && rawForecast != null && rawForecast > 0) {
          forecastEps = rawForecast;
        } else if (shareBasis === 'indeterminate') {
          forecastBasisWarning = true;
        }
      }

      const latestOperatingIncome = asNumber(latestFinancial?.operating_income);
      const latestNetIncome = asNumber(latestFinancial?.net_income);

      const netIncomeLooksExceptional =
        latestOperatingIncome != null &&
        latestOperatingIncome > 0 &&
        latestNetIncome != null &&
        latestNetIncome > latestOperatingIncome * 1.8;

      const actualVsForecastGap =
        actualEps != null &&
        actualEps > 0 &&
        forecastEps != null &&
        forecastEps > 0 &&
        actualEps >= forecastEps * 1.5;

      let valuationNote = '';

      if (forecastEps != null && latestRatio && typeof latestRatio === 'object') {
        // フロント側は adjusted_eps を優先するため、現在PERだけ会社予想EPS基準に切り替える。
        // financials の eps 自体は変更しないので、過去EPSグラフは実績値のまま。
        latestRatio.adjusted_eps = forecastEps;

        valuationNote =
          `【PERの見方】現在PERは最新の会社予想EPS ${forecastEps.toFixed(2)}円を優先して計算しています。`;

        if (actualEps != null && actualEps > 0) {
          valuationNote += ` 最新実績EPSは ${actualEps.toFixed(2)}円です。`;
        }

        if (actualVsForecastGap || netIncomeLooksExceptional) {
          valuationNote +=
            ' ⚠️ 実績利益が通常より大きく見えている可能性があります。一時利益・買収益・反動減などを確認し、実績PERだけで「激安」と判断しないでください。';
        }
      } else if (forecastBasisWarning) {
        valuationNote =
          '【PERの見方】会社予想EPSは取得できましたが、株式分割の基準が不明なため予想PERには使用していません。実績PERだけで割安判断しないでください。';
      } else if (netIncomeLooksExceptional) {
        valuationNote =
          '【PERの注意】純利益が営業利益に比べて大きいため、一時利益などが含まれている可能性があります。実績PERだけで「激安」と判断せず、特別利益・買収益などを公式IRで確認してください。';
      }

      prependValuationNote(company, valuationNote);

      return res.status(200).json({
        company,
        financials,
        ratios,
        earnings,
        valuationMeta: {
          perBasis: forecastEps != null ? 'company_forecast_eps' : 'latest_actual_eps',
          forecastEps,
          actualEps,
          possibleOneOffProfit: Boolean(actualVsForecastGap || netIncomeLooksExceptional),
          forecastShareBasis: forecastRecord?.forecast_share_basis ?? null,
          forecastDisclosureDate: forecastRecord?.disclosure_date ?? null,
        },
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

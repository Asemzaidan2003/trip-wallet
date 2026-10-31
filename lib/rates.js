// Default exchange-rate source: free, no key, covers SAR and other Gulf currencies.
// Rates by Exchange Rate API (https://www.exchangerate-api.com), attribution required.
async function fetchRates(base) {
  const res = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`, {
    signal: AbortSignal.timeout(5000),
  });
  const data = await res.json();
  if (!res.ok || data.result !== 'success' || typeof data.rates !== 'object') {
    throw new Error(`Rate API answered ${res.status}`);
  }
  return data.rates; // { USD: 0.2667, ... } meaning 1 BASE = x CUR
}

module.exports = { fetchRates };

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const BASE = (process.env.BENCH_BASE_URL || 'https://dakingrai.github.io').replace(/\/$/, '');
const URLS = [
  { label: 'home',      url: `${BASE}/` },
  { label: 'emergence', url: `${BASE}/2026/04/03/emergence.html` },
  { label: 'welcome',   url: `${BASE}/2025/11/23/welcome.html` },
];

const TRIALS = 10;
const METRICS = ['ttfb', 'load', 'lcp', 'cls', 'inp'];
const OUT_PATH = path.join(__dirname, 'results.jsonl');
const WEB_VITALS_IIFE = fs.readFileSync(
  path.join(__dirname, '..', 'node_modules', 'web-vitals', 'dist', 'web-vitals.iife.js'),
  'utf8'
);

// Bootstrap injected before any page script runs. Loads web-vitals and
// stashes each metric on window.__vitals as it fires.
const BOOTSTRAP = `
${WEB_VITALS_IIFE}
window.__vitals = {};
webVitals.onLCP(m => { window.__vitals.lcp = m.value; }, { reportAllChanges: true });
webVitals.onCLS(m => { window.__vitals.cls = m.value; }, { reportAllChanges: true });
webVitals.onINP(m => { window.__vitals.inp = m.value; }, { reportAllChanges: true });
webVitals.onTTFB(m => { window.__vitals.ttfb = m.value; });
`;

function quantile(sorted, q) {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1] ?? sorted[base];
  return sorted[base] + rest * (next - sorted[base]);
}

function summarize(values) {
  const clean = values.filter(v => typeof v === 'number' && !Number.isNaN(v));
  if (clean.length === 0) return { n: 0, median: null, p95: null };
  const sorted = [...clean].sort((a, b) => a - b);
  return {
    n: clean.length,
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
  };
}

function fmt(metric, v) {
  if (v == null) return '   n/a';
  if (metric === 'cls') return v.toFixed(3);
  return `${v.toFixed(0)}ms`;
}

async function runTrial(browser, target, trial) {
  // Fresh incognito context per trial — no shared cache, cookies, or storage.
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    await page.setCacheEnabled(false);
    await page.evaluateOnNewDocument(BOOTSTRAP);

    await page.goto(target.url, { waitUntil: 'load', timeout: 60000 });

    // Trigger an interaction so INP has something to measure.
    await page.mouse.move(200, 200);
    await page.mouse.click(200, 200);
    await page.keyboard.press('PageDown');

    // Let LCP/CLS/INP settle before reading.
    await new Promise(r => setTimeout(r, 2500));

    const result = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] || {};
      return {
        ttfb_nav: nav.responseStart != null ? nav.responseStart - nav.startTime : null,
        load:     nav.loadEventEnd != null  ? nav.loadEventEnd - nav.startTime : null,
        vitals:   window.__vitals || {},
      };
    });

    return {
      label: target.label,
      url: target.url,
      trial,
      timestamp: new Date().toISOString(),
      ttfb: result.vitals.ttfb ?? result.ttfb_nav,
      load: result.load,
      lcp:  result.vitals.lcp ?? null,
      cls:  result.vitals.cls ?? 0,
      inp:  result.vitals.inp ?? null,
    };
  } finally {
    await context.close();
  }
}

(async () => {
  fs.writeFileSync(OUT_PATH, ''); // truncate
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const all = {};
  try {
    for (const target of URLS) {
      all[target.label] = [];
      for (let i = 1; i <= TRIALS; i++) {
        process.stdout.write(`[${target.label}] trial ${i}/${TRIALS}... `);
        const t0 = Date.now();
        try {
          const row = await runTrial(browser, target, i);
          all[target.label].push(row);
          fs.appendFileSync(OUT_PATH, JSON.stringify(row) + '\n');
          console.log(
            `ttfb=${fmt('ttfb', row.ttfb)} load=${fmt('load', row.load)} ` +
            `lcp=${fmt('lcp', row.lcp)} cls=${fmt('cls', row.cls)} ` +
            `inp=${fmt('inp', row.inp)} (${Date.now() - t0}ms)`
          );
        } catch (e) {
          console.log(`FAILED: ${e.message}`);
          fs.appendFileSync(OUT_PATH, JSON.stringify({
            label: target.label, url: target.url, trial: i, error: e.message,
          }) + '\n');
        }
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`\nResults written to ${path.relative(process.cwd(), OUT_PATH)}\n`);
  console.log('Summary (median / p95):');
  const header = ['url'.padEnd(11), ...METRICS.map(m => m.toUpperCase().padStart(16))].join('');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const target of URLS) {
    const rows = all[target.label];
    const cells = [target.label.padEnd(11)];
    for (const m of METRICS) {
      const s = summarize(rows.map(r => r[m]));
      const cell = s.n === 0 ? 'n/a'
        : `${fmt(m, s.median)} / ${fmt(m, s.p95)}`;
      cells.push(cell.padStart(16));
    }
    console.log(cells.join(''));
  }
})().catch(e => {
  console.error(e);
  process.exit(1);
});

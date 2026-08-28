import puppeteer from 'puppeteer';
const BASE = 'http://localhost:8099';
const pages = ['index','apps','chat','defender','explorer','game','games','lmstudio','recovery','remote-desktop','render','settings','simple','start','tabs','terminal','theater','theater-details','windows'];
const browser = await puppeteer.launch({ headless: 'new' });
let bad = 0;
for (const p of pages) {
  const page = await browser.newPage();
  const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('response', r => { if (r.status() === 404 && /\.(woff2|css|js)$/.test(new URL(r.url()).pathname)) errs.push('404 ' + new URL(r.url()).pathname); });
  await page.goto(`${BASE}/${p}.html`, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 150));
  const probe = await page.evaluate(() => {
    const el = document.querySelector('.ao-loader-logo') || document.querySelector('h1,h2,h3');
    return el ? el.textContent : null;
  });
  console.log(`${p.padEnd(20)} probe=${JSON.stringify(probe)} errors=${errs.length ? JSON.stringify(errs) : 'none'}`);
  if (errs.length) bad++;
  await page.close();
}
await browser.close();
console.log(bad ? `\n${bad} pages with errors` : '\nno console/font 404 errors on any page');

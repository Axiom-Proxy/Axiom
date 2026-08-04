// Serves public/ statically and drives real tab drags in tabs.html.
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = 'C:/Users/obama/Downloads/holykey/public';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    fs.readFile(p, (err, buf) => {
        if (err) { res.writeHead(404); res.end('nope'); return; }
        res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'text/plain' });
        res.end(buf);
    });
});

(async () => {
    await new Promise(r => server.listen(0, r));
    const port = server.address().port;
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    page.on('pageerror', e => console.log('PAGE ERROR:', e.message));
    await page.goto(`http://localhost:${port}/tabs.html`, { waitUntil: 'domcontentloaded' });

    const reset = () => page.evaluate(() => {
        const l = document.getElementById('axiom-loader');
        if (l) l.remove();
        localStorage.clear();
        tabs.forEach(t => t.iframe.remove());
        tabs.length = 0;
        ['A', 'B', 'C', 'D'].forEach(n => createTab('about:blank', { title: n }));
        renderTabs();
    });
    const titles = () => page.$$eval('#tab-list .tab .tab-title', els => els.map(e => e.textContent));
    const box = i => page.evaluate(i => {
        const r = document.querySelectorAll('#tab-list .tab')[i].getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, i);
    const leftovers = () => page.$$eval('#tab-list .tab',
        els => els.map(e => (e.style.transform || 'none') + '|' + (e.style.transition || 'none')).join(' '));

    async function drag(from, toX, { escape = false } = {}) {
        const a = await box(from);
        const target = typeof toX === 'number' ? toX : (await box(toX)).x;
        await page.mouse.move(a.x, a.y);
        await page.mouse.down();
        await page.mouse.move(a.x + (target > a.x ? 8 : -8), a.y, { steps: 2 });
        await page.mouse.move(target, a.y, { steps: 14 });
        if (escape) await page.keyboard.press('Escape');
        else await page.mouse.up();
        await new Promise(r => setTimeout(r, 320));
    }

    await reset();
    console.log('start           :', await titles());

    await drag(0, 3);
    console.log('A -> far right  :', await titles());

    await drag(3, 0);
    console.log('back -> far left:', await titles());

    await drag(1, 2);
    console.log('swap 1<->2      :', await titles());

    const before = await titles();
    await drag(0, 3, { escape: true });
    console.log('escape cancels  :', await titles(), '(was', before + ')');

    console.log('inline leftovers:', await leftovers());

    // A plain press with no movement must only activate.
    const b = await box(2);
    await page.mouse.click(b.x, b.y);
    await new Promise(r => setTimeout(r, 80));
    console.log('click activates :', await titles(),
        'active=', await page.$eval('#tab-list .tab.active .tab-title', e => e.textContent));

    // Pressing the close button must close, not drag.
    const closeBox = await page.evaluate(() => {
        const r = document.querySelectorAll('#tab-list .tab')[0].querySelector('.tab-close').getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.click(closeBox.x, closeBox.y);
    await new Promise(r => setTimeout(r, 80));
    console.log('close button    :', await titles());

    await browser.close();
    server.close();
})();

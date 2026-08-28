import puppeteer from 'puppeteer';

const BASE = 'http://localhost:8099';
const failures = [];
function assert(cond, msg) {
  if (cond) console.log('  ok  -', msg);
  else { console.log('  FAIL-', msg); failures.push(msg); }
}

const browser = await puppeteer.launch({ headless: 'new' });

async function goto(page, url) {
  // DOMContentLoaded: the runtime script shifts synchronously in its
  // DOMContentLoaded handler, so text is already shifted by the time this
  // resolves.  Wait a tick for any async observer callbacks too.
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 50));
}

// ---------- index.html: static shift + icon skip ----------
{
  const page = await browser.newPage();
  await goto(page, BASE + '/index.html');
  // heading "Welcome to Axiom!" -> "Xfmdpnf up Byjpn!"
  const h2 = await page.$eval('.landing-header h2', el => el.textContent);
  assert(h2 === 'Xfmdpnf up Byjpn!', `index: h2 shifted (got ${JSON.stringify(h2)})`);
  // static text shifted (DOM holds shifted text -> font renders normal)
  const card = await page.$eval('#simple-mde span:last-child', el => el.textContent);
  assert(card === 'Tjnqmf', `index: "Simple" shifted to "Tjnqmf" (got ${JSON.stringify(card)})`);
  // material-symbols icon ligature text NOT shifted
  const icon = await page.$eval('.material-symbols-outlined', el => el.textContent);
  assert(icon === 'view_quilt', `index: icon text left literal "view_quilt" (got ${JSON.stringify(icon)})`);
  // id / onclick untouched
  const onclick = await page.$eval('#simple-mde', el => el.getAttribute('onclick'));
  assert(onclick === "selectMode('simple')", `index: onclick attribute untouched (got ${JSON.stringify(onclick)})`);
  await page.close();
}

// ---------- JS-injected text node ----------
async function injectAndRead(page, inject, read) {
  await page.evaluate(inject);
  await new Promise(r => setTimeout(r, 60));
  return page.evaluate(read);
}
{
  const page = await browser.newPage();
  await goto(page, BASE + '/index.html');

  const out = await injectAndRead(page,
    () => { const el = document.createElement('div'); el.id = 'dyn'; el.textContent = 'Hello, World! 0123456789'; document.body.appendChild(el); },
    () => document.getElementById('dyn').textContent);
  assert(out === 'Ifmmp, Xpsme! 1234567890', `index: JS-injected text shifted (got ${JSON.stringify(out)})`);

  const out2 = await injectAndRead(page,
    () => { const el = document.createElement('div'); el.id = 'mix'; el.innerHTML = '<span class="material-symbols-outlined">home</span><b>Settings</b>'; document.body.appendChild(el); },
    () => ({ icon: document.querySelector('#mix .material-symbols-outlined').textContent, b: document.querySelector('#mix b').textContent }));
  assert(out2.icon === 'home', `index: innerHTML icon text literal "home" (got ${JSON.stringify(out2.icon)})`);
  assert(out2.b === 'Tfuujoht', `index: innerHTML <b> "Settings" shifted to "Tfuujoht" (got ${JSON.stringify(out2.b)})`);

  // placeholders are NOT shifted: form fields render through the un-scrambled
  // 'Roboto Plain' font, so the literal placeholder shows up correctly.
  const ph = await injectAndRead(page,
    () => { const el = document.createElement('input'); el.id = 'ph'; el.setAttribute('placeholder', 'Search here'); document.body.appendChild(el); },
    () => document.getElementById('ph').getAttribute('placeholder'));
  assert(ph === 'Search here', `index: injected placeholder left literal (got ${JSON.stringify(ph)})`);

  const val = await injectAndRead(page,
    () => { const el = document.createElement('input'); el.id = 'val'; el.value = 'Axiom'; document.body.appendChild(el); },
    () => document.getElementById('val').value);
  assert(val === 'Axiom', `index: input.value left un-shifted "Axiom" (got ${JSON.stringify(val)})`);

  // input renders through the UNSCRAMBLED 'Roboto Plain' font
  const inputFont = await injectAndRead(page,
    () => { const el = document.createElement('input'); el.id = 'ifont'; document.body.appendChild(el); },
    () => getComputedStyle(document.getElementById('ifont')).fontFamily);
  assert(/Roboto Plain/i.test(inputFont), `index: input uses un-scrambled font (got ${JSON.stringify(inputFont)})`);
  // a <div> (UI text) renders through the SCRAMBLED 'Roboto' font
  const divFont = await injectAndRead(page,
    () => { const el = document.createElement('div'); el.id = 'dfont'; document.body.appendChild(el); },
    () => getComputedStyle(document.getElementById('dfont')).fontFamily);
  assert(/Roboto/.test(divFont) && !/Roboto Plain/i.test(divFont), `index: div uses scrambled Roboto (got ${JSON.stringify(divFont)})`);

  const re = await injectAndRead(page,
    () => { const el = document.createElement('div'); el.id = 're'; el.textContent = 'Axiom'; document.body.appendChild(el); },
    () => { const el = document.getElementById('re'); const first = el.textContent; el.textContent = el.textContent; return { first, second: el.textContent }; });
  assert(re.first === 'Byjpn' && re.second === 'Byjpn', `index: re-set same value no double-shift (first=${JSON.stringify(re.first)} second=${JSON.stringify(re.second)})`);
  await page.close();
}

// ---------- lmstudio: <code> not shifted, option text shifted ----------
{
  const page = await browser.newPage();
  await goto(page, BASE + '/lmstudio.html');
  const code = await page.$$eval('code', els => els.map(e => e.textContent));
  assert(code.includes('os.lm'), `lmstudio: <code>os.lm</code> left literal (got ${JSON.stringify(code)})`);
  // option display text NOT shifted: <select> renders through 'Roboto Plain'
  const opt = await page.$eval('#lm-device option', el => el.textContent);
  assert(opt === 'Auto', `lmstudio: <option>Auto left literal (got ${JSON.stringify(opt)})`);
  // value attribute unchanged
  const optVal = await page.$eval('#lm-device option', el => el.value);
  assert(optVal === 'auto', `lmstudio: option value attribute left "auto" (got ${JSON.stringify(optVal)})`);
  // select renders through the UNSCRAMBLED font
  const selFont = await page.$eval('#lm-device', el => getComputedStyle(el).fontFamily);
  assert(/Roboto Plain/i.test(selFont), `lmstudio: select uses un-scrambled font (got ${JSON.stringify(selFont)})`);
  // max-tokens numeric default value unchanged
  const mt = await page.$eval('#lm-max-tokens', el => el.value);
  assert(mt === '1024', `lmstudio: numeric value left "1024" (got ${JSON.stringify(mt)})`);
  // placeholder NOT shifted: textarea renders through 'Roboto Plain'
  const ph = await page.$eval('#lm-input', el => el.getAttribute('placeholder'));
  assert(ph === 'Send a message…', `lmstudio: placeholder left literal (got ${JSON.stringify(ph)})`);
  const taFont = await page.$eval('#lm-input', el => getComputedStyle(el).fontFamily);
  assert(/Roboto Plain/i.test(taFont), `lmstudio: textarea uses un-scrambled font (got ${JSON.stringify(taFont)})`);
  await page.close();
}

// ---------- <pre>/<code> text nodes skipped (use a stable page) ----------
{
  const page = await browser.newPage();
  await goto(page, BASE + '/simple.html');
  const pre = await injectAndRead(page,
    () => { const el = document.createElement('pre'); el.id = 'code'; el.textContent = 'const x = 10;'; document.body.appendChild(el); },
    () => document.getElementById('code').textContent);
  assert(pre === 'const x = 10;', `simple: <pre> text left literal (got ${JSON.stringify(pre)})`);
  const normal = await injectAndRead(page,
    () => { const el = document.createElement('p'); el.id = 'norm'; el.textContent = 'Axiom'; document.body.appendChild(el); },
    () => document.getElementById('norm').textContent);
  assert(normal === 'Byjpn', `simple: <p> text shifted to "Byjpn" (got ${JSON.stringify(normal)})`);
  await page.close();
}

// ---------- settings.html: async JS-built UI (theme dropdown) ----------
// settings.js fetches themes.json (async, after DOMContentLoaded) and builds
// .dropdown-option spans with theme.name via textContent.  The observer
// must shift these.  First theme is "Default" -> "Efgbvmu".
async function waitFor(page, fn, { timeout = 5000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await page.evaluate(fn)) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
}
{
  const page = await browser.newPage();
  await goto(page, BASE + '/settings.html');
  const populated = await waitFor(page, () => !!document.querySelector('#dropdownPanel .dropdown-option span'));
  assert(populated, 'settings: theme dropdown populated by JS');
  const firstName = await page.evaluate(() => document.querySelector('#dropdownPanel .dropdown-option span').textContent);
  assert(firstName === 'Efgbvmu', `settings: async theme name "Default" shifted to "Efgbvmu" (got ${JSON.stringify(firstName)})`);
  // dropdownLabel is set by JS to saved name -> also shifted
  const label = await page.evaluate(() => document.getElementById('dropdownLabel').textContent);
  assert(label === 'Efgbvmu', `settings: dropdown label set by JS shifted to "Efgbvmu" (got ${JSON.stringify(label)})`);
  await page.close();
}

await browser.close();
console.log(failures.length ? `\n${failures.length} FAILURES` : '\nALL TESTS PASSED');
process.exit(failures.length ? 1 : 0);

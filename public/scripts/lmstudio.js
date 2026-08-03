/*
 * Axiom LM Studio - a miniature LM Studio that runs models in the tab.
 *
 * Weights are fetched from Hugging Face and executed by transformers.js v3, on
 * WebGPU where the browser has it and on WASM where it does not. The browser's
 * HTTP cache keeps the ONNX files, so a model is only downloaded once.
 *
 * Besides its own chat pane this window is a server: it registers with
 * windows.html as the desktop's local model endpoint, and answers `os.lm.*`
 * calls made from any other window - which is how Mini Claude in the terminal
 * runs against a local model instead of the Composite API.
 *
 * The wire protocol, all of it postMessage through the windows.html broker:
 *
 *   in   { type: 'axiom:lm-invoke', rid, kind, payload }
 *   in   { type: 'axiom:lm-cancel', rid }
 *   out  { type: 'axiom:lm-ready' }
 *   out  { type: 'axiom:lm-state',  state }
 *   out  { type: 'axiom:lm-event',  rid, event }
 *
 * An event is one of:
 *   { kind: 'progress', progress }        a download tick, load only
 *   { kind: 'chunk',    text }            a prose delta, chat only
 *   { kind: 'done',     result }          the call succeeded
 *   { kind: 'error',    message, name }   it did not; name is 'AbortError' when cancelled
 */

/* The ESM build, pinned to the v3 line. Override for a specific build with
 * localStorage.axiom_lm_cdn before the window opens. */
const CDN = (function () {
  try {
    return localStorage.getItem('axiom_lm_cdn') ||
      'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/transformers.min.js';
  } catch (e) {
    return 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/transformers.min.js';
  }
})();

const CATALOG = [
  {
    id: 'HuggingFaceTB/SmolLM2-360M-Instruct',
    name: 'SmolLM2 360M',
    size: '~380 MB',
    note: 'Smallest useful chat model. Good on CPU.',
    dtype: 'q4'
  },
  {
    id: 'onnx-community/Qwen2.5-0.5B-Instruct',
    name: 'Qwen2.5 0.5B',
    size: '~500 MB',
    note: 'Knows how to call tools. The default for Mini Claude.',
    dtype: 'q4f16',
    tools: true
  },
  {
    id: 'onnx-community/Qwen2.5-Coder-0.5B-Instruct',
    name: 'Qwen2.5 Coder 0.5B',
    size: '~500 MB',
    note: 'Same size, tuned for code.',
    dtype: 'q4f16',
    tools: true
  },
  {
    id: 'onnx-community/Qwen3-0.6B-ONNX',
    name: 'Qwen3 0.6B',
    size: '~600 MB',
    note: 'Newer, thinks before answering.',
    dtype: 'q4f16',
    tools: true
  },
  {
    id: 'HuggingFaceTB/SmolLM2-1.7B-Instruct',
    name: 'SmolLM2 1.7B',
    size: '~1.8 GB',
    note: 'Noticeably better prose. WebGPU recommended.',
    dtype: 'q4f16'
  },
  {
    id: 'onnx-community/Llama-3.2-1B-Instruct',
    name: 'Llama 3.2 1B',
    size: '~1.2 GB',
    note: 'Solid all-rounder. WebGPU recommended.',
    dtype: 'q4f16',
    tools: true
  }
];

const DEFAULT_MODEL = 'onnx-community/Qwen2.5-0.5B-Instruct';
const PREF_STORE = 'axiom_lm_prefs';

/* --------------------------------------------------------------- library */

let libPromise = null;

/** transformers.js, imported the first time something actually needs it. */
function lib() {
  if (!libPromise) {
    libPromise = import(/* @vite-ignore */ CDN).catch(err => {
      libPromise = null;
      throw new Error('Could not load transformers.js from ' + CDN + ' (' + err.message + ')');
    });
  }
  return libPromise;
}

/* ----------------------------------------------------------------- state */

const state = {
  status: 'idle',      // idle | loading | ready | generating
  model: null,         // the repo id currently in memory
  device: null,
  dtype: null,
  error: null,
  served: 0            // endpoint calls answered since this window opened
};

let engine = null;       // { id, tokenizer, model, supportsTools }
let loading = null;      // in-flight load(), so two callers share one download
let generating = false;  // one generation at a time; the rest queue

function prefs() {
  try { return JSON.parse(localStorage.getItem(PREF_STORE)) || {}; } catch (e) { return {}; }
}

function savePrefs(patch) {
  try { localStorage.setItem(PREF_STORE, JSON.stringify(Object.assign(prefs(), patch))); } catch (e) { }
}

/* ---------------------------------------------------------- transcript IO */

const el = id => document.getElementById(id);

function esc(text) {
  return String(text).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

/** Just enough markdown for a chat bubble: fences, inline code, bold, italic. */
function render(text) {
  const parts = String(text).split(/```/);
  return parts.map((part, i) => {
    if (i % 2) {
      const nl = part.indexOf('\n');
      const body = nl === -1 ? part : part.slice(nl + 1);
      return '<pre class="lm-code">' + esc(body.replace(/\n$/, '')) + '</pre>';
    }
    return esc(part)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\s)\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\n/g, '<br>');
  }).join('');
}

/* -------------------------------------------------------------- messages */

/*
 * Chat templates are Jinja written for the Python side, and they are not
 * forgiving: a null content or a JSON-string argument blob will either crash
 * the template or be rendered as garbage. Everything is flattened into the
 * shape the templates expect before it goes anywhere near one.
 */
function normalize(messages) {
  return (messages || []).map(message => {
    const out = {
      role: message.role || 'user',
      content: message.content == null ? '' : String(message.content)
    };
    if (message.name) out.name = message.name;

    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      out.tool_calls = message.tool_calls.map(call => {
        const fn = call.function || {};
        let args = fn.arguments;
        // Templates do `arguments | tojson`, so they want an object.
        if (typeof args === 'string') {
          try { args = JSON.parse(args || '{}'); } catch (e) { args = { _raw: args }; }
        }
        return { id: call.id, type: 'function', function: { name: fn.name, arguments: args || {} } };
      });
    }
    return out;
  });
}

/** A plain-text tool manual, for templates that cannot take a `tools` argument. */
function toolManual(tools) {
  const lines = [
    'You can call tools. To call one, reply with nothing but a block of the form:',
    '<tool_call>{"name": "tool_name", "arguments": {…}}</tool_call>',
    'You may emit several blocks. Do not describe the call in prose; make it.',
    '',
    'Available tools:'
  ];
  tools.forEach(tool => {
    const fn = tool.function || tool;
    lines.push('- ' + fn.name + ': ' + (fn.description || ''));
    lines.push('  parameters: ' + JSON.stringify(fn.parameters || {}));
  });
  return lines.join('\n');
}

/**
 * Tokenised prompt for a turn. Templates that understand `tools` get them
 * natively; the rest get the manual folded into the system message.
 */
function buildInputs(tokenizer, messages, tools) {
  const list = normalize(messages);

  if (tools && tools.length) {
    try {
      return {
        inputs: tokenizer.apply_chat_template(list, {
          tools: tools, add_generation_prompt: true, return_dict: true
        }),
        native: true
      };
    } catch (e) {
      // Falls through to the manual below.
    }
  }

  if (tools && tools.length) {
    const manual = toolManual(tools);
    if (list.length && list[0].role === 'system') list[0].content += '\n\n' + manual;
    else list.unshift({ role: 'system', content: manual });
  }

  return {
    inputs: tokenizer.apply_chat_template(list, { add_generation_prompt: true, return_dict: true }),
    native: false
  };
}

/* ---------------------------------------------------------- tool parsing */

const CALL_MARK = '<tool_call>';

/**
 * Tool calls a local model emitted. Qwen and friends wrap them in
 * <tool_call> tags; smaller models tend to drop a bare JSON object instead,
 * so both are accepted.
 */
function parseCalls(text) {
  const calls = [];
  const push = raw => {
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return; }
    if (!parsed || typeof parsed !== 'object') return;
    const name = parsed.name || (parsed.function && parsed.function.name);
    if (!name) return;
    let args = parsed.arguments || parsed.parameters ||
      (parsed.function && parsed.function.arguments) || {};
    if (typeof args !== 'string') args = JSON.stringify(args);
    calls.push({ id: 'call_' + (calls.length + 1) + '_' + Date.now().toString(36), name: name, args: args });
  };

  const tagged = /<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g;
  let match;
  while ((match = tagged.exec(text))) push(match[1]);
  if (calls.length) return calls;

  // No tags: try a fenced or bare object that looks like a call.
  const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
  while ((match = fenced.exec(text))) push(match[1]);
  if (calls.length) return calls;

  const bare = text.trim();
  if (bare.charAt(0) === '{' && bare.charAt(bare.length - 1) === '}' &&
    /"(name|function)"\s*:/.test(bare)) {
    push(bare);
  }
  return calls;
}

/** The part of a reply the user should see - everything before the first call. */
function visible(text) {
  const cut = text.indexOf(CALL_MARK);
  return cut === -1 ? text : text.slice(0, cut);
}

/**
 * How much of `text` is safe to show while more is still arriving: a trailing
 * fragment that could grow into "<tool_call>" is held back rather than flashed
 * on screen and taken away again.
 */
function safeLength(text) {
  const shown = visible(text);
  if (shown.length < text.length) return shown.length;
  for (let n = Math.min(CALL_MARK.length - 1, shown.length); n > 0; n--) {
    if (shown.slice(-n) === CALL_MARK.slice(0, n)) return shown.length - n;
  }
  return shown.length;
}

/* ------------------------------------------------------------- lifecycle */

function publish() {
  post({ type: 'axiom:lm-state', state: snapshot() });
  paintStatus();
}

function snapshot() {
  return {
    status: state.status,
    model: state.model,
    device: state.device,
    dtype: state.dtype,
    error: state.error,
    served: state.served,
    loaded: !!engine
  };
}

function pickDevice(requested) {
  if (requested && requested !== 'auto') return requested;
  return navigator.gpu ? 'webgpu' : 'wasm';
}

function pickDtype(requested, id) {
  if (requested && requested !== 'auto') return requested;
  const entry = CATALOG.find(m => m.id === id);
  if (entry && entry.dtype) return entry.dtype;
  return navigator.gpu ? 'q4f16' : 'q4';
}

/**
 * Bring a model into memory. Concurrent callers of the same model share the
 * one download; asking for a different model swaps the loaded one out.
 */
function load(id, options, onProgress) {
  id = id || DEFAULT_MODEL;
  options = options || {};

  if (engine && engine.id === id && !loading) return Promise.resolve(snapshot());
  if (loading && loading.id === id) {
    if (onProgress) loading.listeners.push(onProgress);
    return loading.promise;
  }

  const listeners = onProgress ? [onProgress] : [];
  const device = pickDevice(options.device || prefs().device);
  const dtype = pickDtype(options.dtype || prefs().dtype, id);

  const promise = (async () => {
    const { AutoTokenizer, AutoModelForCausalLM } = await lib();

    engine = null;
    state.status = 'loading';
    state.model = id;
    state.device = device;
    state.dtype = dtype;
    state.error = null;
    publish();

    const progress_callback = report => {
      trackProgress(report);
      listeners.forEach(fn => { try { fn(report); } catch (e) { } });
    };

    try {
      const tokenizer = await AutoTokenizer.from_pretrained(id, { progress_callback });
      const model = await AutoModelForCausalLM.from_pretrained(id, {
        dtype: dtype, device: device, progress_callback
      });

      engine = { id: id, tokenizer: tokenizer, model: model };
      state.status = 'ready';
      state.error = null;
    } catch (err) {
      engine = null;
      state.status = 'idle';
      state.model = null;
      state.error = err && err.message ? err.message : String(err);
      publish();
      clearProgress();
      throw new Error('Could not load ' + id + ': ' + state.error);
    }

    publish();
    clearProgress();
    return snapshot();
  })();

  loading = { id: id, promise: promise, listeners: listeners };
  return promise.finally(() => { if (loading && loading.promise === promise) loading = null; });
}

function unload() {
  if (engine && engine.model && engine.model.dispose) {
    try { engine.model.dispose(); } catch (e) { }
  }
  engine = null;
  state.status = 'idle';
  state.model = null;
  state.error = null;
  publish();
  return snapshot();
}

/* ------------------------------------------------------------ generation */

const queue = [];

/** Serialises generation: one model, one KV cache, one turn at a time. */
function enqueue(job) {
  return new Promise((resolve, reject) => {
    queue.push({ job: job, resolve: resolve, reject: reject });
    drain();
  });
}

async function drain() {
  if (generating || !queue.length) return;
  const entry = queue.shift();
  generating = true;
  try {
    entry.resolve(await entry.job());
  } catch (err) {
    entry.reject(err);
  } finally {
    generating = false;
    drain();
  }
}

function abortError() {
  const err = new Error('Generation was interrupted.');
  err.name = 'AbortError';
  return err;
}

/**
 * One completion. Returns the same shape the Composite API path in
 * claude-code.js produces, so the two are interchangeable.
 */
async function chat(options, handle) {
  options = options || {};
  const settings = prefs();

  await load(options.model || state.model || settings.model || DEFAULT_MODEL,
    { device: options.device, dtype: options.dtype },
    options.onProgress);

  return enqueue(async () => {
    if (handle && handle.cancelled) throw abortError();

    const { TextStreamer, InterruptableStoppingCriteria } = await lib();
    const tokenizer = engine.tokenizer;
    const built = buildInputs(tokenizer, options.messages, options.tools);
    const inputs = built.inputs;

    const stopper = InterruptableStoppingCriteria ? new InterruptableStoppingCriteria() : null;
    if (handle) {
      handle.interrupt = () => { if (stopper) stopper.interrupt(); };
      if (handle.cancelled) throw abortError();
    }

    let full = '';
    let emitted = 0;

    const streamer = new TextStreamer(tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: chunk => {
        full += chunk;
        const upto = safeLength(full);
        if (upto <= emitted) return;
        const delta = full.slice(emitted, upto);
        emitted = upto;
        if (options.onText) options.onText(delta);
      }
    });

    const temperature = options.temperature == null
      ? (settings.temperature == null ? 0.7 : settings.temperature)
      : options.temperature;
    const maxTokens = options.max_tokens || settings.maxTokens || 1024;

    state.status = 'generating';
    publish();

    let output;
    try {
      output = await engine.model.generate(Object.assign({}, inputs, {
        max_new_tokens: maxTokens,
        do_sample: temperature > 0,
        temperature: temperature > 0 ? temperature : undefined,
        top_p: options.top_p == null ? 0.9 : options.top_p,
        repetition_penalty: 1.1,
        streamer: streamer,
        stopping_criteria: stopper || undefined,
        return_dict_in_generate: false
      }));
    } finally {
      state.status = engine ? 'ready' : 'idle';
      publish();
    }

    if (handle && handle.cancelled) throw abortError();

    const promptTokens = inputs.input_ids.dims[1];
    const text = tokenizer.batch_decode(output.slice(null, [promptTokens, null]), {
      skip_special_tokens: true
    })[0];

    // The streamer already produced this text, but the decode is authoritative.
    const body = text == null ? full : text;
    const rest = visible(body).slice(emitted);
    if (rest && options.onText) options.onText(rest);

    return {
      content: visible(body).trim(),
      calls: options.tools && options.tools.length ? parseCalls(body) : [],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: Math.max(0, output.dims[1] - promptTokens),
        total_tokens: output.dims[1]
      },
      model: engine.id,
      native_tools: built.native
    };
  });
}

/* --------------------------------------------------------------- the UI */

let progressFiles = {};

function trackProgress(report) {
  if (!report || !report.file) return;
  if (report.status === 'progress' || report.status === 'download' || report.status === 'initiate') {
    progressFiles[report.file] = {
      name: report.file,
      loaded: report.loaded || 0,
      total: report.total || 0,
      pct: report.progress || 0
    };
  } else if (report.status === 'done') {
    if (progressFiles[report.file]) progressFiles[report.file].pct = 100;
  }
  paintProgress();
}

function clearProgress() {
  progressFiles = {};
  const box = el('lm-progress');
  if (box) box.hidden = true;
}

function bytes(n) {
  if (!n) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(1) : n) + ' ' + units[i];
}

function paintProgress() {
  const box = el('lm-progress');
  if (!box) return;
  const files = Object.values(progressFiles);
  if (!files.length) { box.hidden = true; return; }

  box.hidden = false;
  const total = files.reduce((sum, f) => sum + (f.pct || 0), 0) / files.length;
  el('lm-progress-fill').style.width = total.toFixed(1) + '%';
  el('lm-progress-files').innerHTML = files.map(f =>
    '<div class="lm-progress-file"><span>' + esc(f.name) + '</span>' +
    '<span>' + (f.total ? bytes(f.loaded) + ' / ' + bytes(f.total) : Math.round(f.pct) + '%') +
    '</span></div>').join('');
}

const STATUS_TEXT = {
  idle: 'No model loaded',
  loading: 'Loading',
  ready: 'Ready',
  generating: 'Generating'
};

function paintStatus() {
  const dot = el('lm-status-dot');
  if (!dot) return;

  dot.className = 'lm-dot lm-dot-' + state.status;
  el('lm-endpoint-dot').className = 'lm-dot lm-dot-' + (engine ? 'ready' : 'idle');
  el('lm-status-model').textContent = state.model
    ? (short(state.model) + (state.status === 'ready' ? '' : ' · ' + STATUS_TEXT[state.status]))
    : STATUS_TEXT.idle;

  let detail;
  if (state.error) detail = state.error;
  else if (!state.model) detail = 'Pick a model on the left and load it.';
  else detail = [state.device, state.dtype, state.served + ' endpoint call' +
    (state.served === 1 ? '' : 's')].filter(Boolean).join(' · ');
  el('lm-status-detail').textContent = detail;

  const button = el('lm-load');
  button.disabled = state.status === 'loading';
  el('lm-load-label').textContent = state.status === 'loading' ? 'Loading…' : 'Load model';
  el('lm-unload').disabled = !engine;
}

function short(id) {
  const entry = CATALOG.find(m => m.id === id);
  return entry ? entry.name : id;
}

/* --- catalog --- */

let selected = prefs().model || DEFAULT_MODEL;

function paintCatalog() {
  const box = el('lm-catalog');
  box.innerHTML = '';
  CATALOG.forEach(entry => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'lm-model' + (entry.id === selected ? ' selected' : '');
    row.innerHTML =
      '<div class="lm-model-head"><span class="lm-model-name">' + esc(entry.name) + '</span>' +
      (entry.tools ? '<span class="lm-tag">tools</span>' : '') +
      '<span class="lm-model-size">' + esc(entry.size) + '</span></div>' +
      '<div class="lm-model-note">' + esc(entry.note) + '</div>';
    row.addEventListener('click', () => {
      selected = entry.id;
      el('lm-custom').value = '';
      savePrefs({ model: selected });
      paintCatalog();
    });
    box.appendChild(row);
  });
}

function chosenModel() {
  const custom = el('lm-custom').value.trim();
  return custom || selected;
}

/* --- transcript --- */

const conversation = [];

function addBubble(role, text) {
  const empty = el('lm-empty');
  if (empty) empty.remove();

  const wrap = document.createElement('div');
  wrap.className = 'lm-msg lm-msg-' + role;
  wrap.innerHTML = '<div class="lm-msg-role">' + (role === 'user' ? 'You' : short(state.model || '')) +
    '</div><div class="lm-msg-body"></div>';
  el('lm-chat').appendChild(wrap);
  scrollChat();

  const body = wrap.querySelector('.lm-msg-body');
  let buffer = text || '';
  body.innerHTML = render(buffer) || '<span class="lm-caret"></span>';

  return {
    append(chunk) {
      buffer += chunk;
      body.innerHTML = render(buffer);
      scrollChat();
    },
    finish(finalText) {
      if (finalText != null) buffer = finalText;
      body.innerHTML = render(buffer) || '<em class="lm-quiet">(no output)</em>';
      scrollChat();
      return buffer;
    },
    fail(message) {
      wrap.classList.add('lm-msg-error');
      body.textContent = message;
      scrollChat();
    }
  };
}

function scrollChat() {
  const chat = el('lm-chat');
  chat.scrollTop = chat.scrollHeight;
}

let uiHandle = null;

function setBusy(busy) {
  el('lm-send').hidden = busy;
  el('lm-stop').hidden = !busy;
  el('lm-input').disabled = busy;
}

async function send(text) {
  conversation.push({ role: 'user', content: text });
  addBubble('user', text);

  const bubble = addBubble('assistant', '');
  const handle = { cancelled: false, interrupt: null };
  uiHandle = handle;
  setBusy(true);

  try {
    const result = await chat({
      model: chosenModel(),
      messages: conversation,
      max_tokens: Number(el('lm-max-tokens').value) || 1024,
      temperature: Number(el('lm-temperature').value),
      device: el('lm-device').value,
      dtype: el('lm-dtype').value,
      onText: chunk => bubble.append(chunk),
      onProgress: () => { }
    }, handle);

    bubble.finish(result.content);
    conversation.push({ role: 'assistant', content: result.content });
  } catch (err) {
    if (err && err.name === 'AbortError') bubble.finish(null);
    else bubble.fail(err && err.message ? err.message : String(err));
  } finally {
    uiHandle = null;
    setBusy(false);
    el('lm-input').focus();
  }
}

/* ------------------------------------------------------------- endpoint */

function post(message) {
  if (window.parent === window) return;
  window.parent.postMessage(message, '*');
}

function reply(rid, event) {
  post({ type: 'axiom:lm-event', rid: rid, event: event });
}

const live = {};   // rid -> handle, for cancellation

function logCall(kind, detail) {
  const box = el('lm-log');
  if (!box) return;
  const row = document.createElement('div');
  row.className = 'lm-log-row';
  row.innerHTML = '<span class="lm-log-kind">' + esc(kind) + '</span>' +
    '<span class="lm-log-detail">' + esc(detail || '') + '</span>';
  box.prepend(row);
  while (box.children.length > 12) box.lastChild.remove();
}

const HANDLERS = {
  status() {
    return Promise.resolve(snapshot());
  },

  models() {
    return Promise.resolve({
      loaded: engine ? engine.id : null,
      default: DEFAULT_MODEL,
      models: CATALOG.map(m => ({
        id: m.id, name: m.name, size: m.size, note: m.note, tools: !!m.tools
      }))
    });
  },

  load(payload, rid) {
    return load(payload.model, payload, report => reply(rid, { kind: 'progress', progress: report }));
  },

  unload() {
    return Promise.resolve(unload());
  },

  chat(payload, rid, handle) {
    return chat(Object.assign({}, payload, {
      onText: text => reply(rid, { kind: 'chunk', text: text }),
      onProgress: report => reply(rid, { kind: 'progress', progress: report })
    }), handle);
  }
};

async function serve(rid, kind, payload) {
  const handler = HANDLERS[kind];
  if (!handler) {
    reply(rid, { kind: 'error', message: 'Unknown endpoint call: ' + kind });
    return;
  }

  const handle = { cancelled: false, interrupt: null };
  live[rid] = handle;

  if (kind === 'chat' || kind === 'load') {
    state.served++;
    logCall(kind, (payload && payload.model) || state.model || '');
    paintStatus();
  }

  try {
    const result = await handler(payload || {}, rid, handle);
    reply(rid, { kind: 'done', result: result });
  } catch (err) {
    reply(rid, {
      kind: 'error',
      message: err && err.message ? err.message : String(err),
      name: err && err.name ? err.name : 'Error'
    });
  } finally {
    delete live[rid];
  }
}

window.addEventListener('message', event => {
  if (event.source !== window.parent) return;
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'axiom:lm-invoke') {
    serve(data.rid, data.kind, data.payload);
  } else if (data.type === 'axiom:lm-cancel') {
    const handle = live[data.rid];
    if (!handle) return;
    handle.cancelled = true;
    if (handle.interrupt) handle.interrupt();
  }
});

/* ------------------------------------------------------------- wiring up */

function restore() {
  const saved = prefs();
  if (saved.device) el('lm-device').value = saved.device;
  if (saved.dtype) el('lm-dtype').value = saved.dtype;
  if (saved.maxTokens) el('lm-max-tokens').value = saved.maxTokens;
  if (saved.temperature != null) el('lm-temperature').value = saved.temperature;
  if (saved.model && !CATALOG.some(m => m.id === saved.model)) {
    el('lm-custom').value = saved.model;
  }
}

function init() {
  paintCatalog();
  restore();
  paintStatus();

  if (!navigator.gpu) {
    const device = el('lm-device');
    device.querySelector('option[value="webgpu"]').disabled = true;
    device.querySelector('option[value="auto"]').textContent = 'Auto (WASM — no WebGPU)';
  }

  el('lm-load').addEventListener('click', () => {
    const id = chosenModel();
    savePrefs({ model: id, device: el('lm-device').value, dtype: el('lm-dtype').value });
    load(id, { device: el('lm-device').value, dtype: el('lm-dtype').value })
      .catch(err => {
        state.error = err.message;
        paintStatus();
      });
  });

  el('lm-unload').addEventListener('click', unload);

  el('lm-clear').addEventListener('click', () => {
    conversation.length = 0;
    el('lm-chat').innerHTML =
      '<div class="lm-empty" id="lm-empty"><span class="material-symbols-outlined">forum</span>' +
      '<p>Everything runs in this tab. Nothing is sent anywhere.</p></div>';
  });

  el('lm-stop').addEventListener('click', () => {
    if (!uiHandle) return;
    uiHandle.cancelled = true;
    if (uiHandle.interrupt) uiHandle.interrupt();
  });

  ['lm-max-tokens', 'lm-temperature', 'lm-device', 'lm-dtype'].forEach(id => {
    el(id).addEventListener('change', () => savePrefs({
      maxTokens: Number(el('lm-max-tokens').value) || 1024,
      temperature: Number(el('lm-temperature').value),
      device: el('lm-device').value,
      dtype: el('lm-dtype').value
    }));
  });

  const input = el('lm-input');
  const grow = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  };
  input.addEventListener('input', grow);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      el('lm-compose').requestSubmit();
    }
  });

  el('lm-compose').addEventListener('submit', e => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || uiHandle) return;
    input.value = '';
    grow();
    send(text);
  });

  // Tell the desktop the endpoint is up, and answer anything it queued.
  post({ type: 'axiom:lm-ready', state: snapshot() });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

window.AxiomLM = {
  load: load,
  unload: unload,
  chat: chat,
  status: snapshot,
  catalog: CATALOG,
  DEFAULT_MODEL: DEFAULT_MODEL
};

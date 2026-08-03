/*
 * window.os — terminal-to-desktop bridge.
 *
 * Wraps postMessage calls to the parent windows.html so that code running
 * inside the terminal (including the `js` tool in Mini Claude) can control
 * the desktop without needing direct DOM access.
 *
 * Request/reply calls return Promises resolved when the parent replies.
 * Fire-and-forget calls return undefined.
 */
(function () {
  var pending = {};
  var seq = 0;

  var lmPending = {};

  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return;
    var d = e.data;
    if (!d) return;

    if (d.type === 'axiom:reply') {
      var cb = pending[d.id];
      if (cb) { delete pending[d.id]; cb(d.result, d.error); }
      return;
    }

    if (d.type === 'axiom:lm-event') {
      var entry = lmPending[d.id];
      if (!entry) return;
      var ev = d.event || {};

      if (ev.kind === 'chunk') {
        if (entry.onText) entry.onText(ev.text || '');
        return;
      }
      if (ev.kind === 'progress') {
        if (entry.onProgress) entry.onProgress(ev.progress || {});
        return;
      }

      delete lmPending[d.id];
      if (ev.kind === 'error') {
        var err = new Error(ev.message || 'The local model endpoint failed.');
        if (ev.name) err.name = ev.name;
        entry.reject(err);
      } else {
        entry.resolve(ev.result);
      }
    }
  });

  function post(msg) {
    window.parent.postMessage(msg, '*');
  }

  function request(msg) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      msg.id = id;
      pending[id] = function (result, error) {
        if (error) reject(new Error(error));
        else resolve(result);
      };
      post(msg);
    });
  }

  /*
   * A call to the local model endpoint. Unlike request() these are long-lived:
   * the endpoint streams progress and prose back before it settles, so the
   * handlers stay registered until a done or error event arrives.
   */
  function lmCall(kind, payload, handlers) {
    handlers = handlers || {};
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      lmPending[id] = {
        resolve: resolve,
        reject: reject,
        onText: handlers.onText,
        onProgress: handlers.onProgress
      };

      if (handlers.signal) {
        if (handlers.signal.aborted) post({ type: 'axiom:lm-cancel', id: id });
        else handlers.signal.addEventListener('abort', function () {
          post({ type: 'axiom:lm-cancel', id: id });
        });
      }

      post({ type: 'axiom:lm-request', id: id, kind: kind, payload: payload || {} });
    });
  }

  /*
   * os.lm — the desktop's local model endpoint, served by the LM Studio window.
   *
   * Calling it while LM Studio is closed opens the window and waits for it, so
   * callers never have to check first. Requests are queued behind one another:
   * there is one model in memory and one generation at a time.
   */
  var lm = {
    /** { status, model, device, dtype, loaded, served, error } */
    status: function () { return lmCall('status'); },

    /** The built-in catalog: { loaded, default, models: [{ id, name, size, note, tools }] } */
    models: function () { return lmCall('models'); },

    /**
     * Pull a model into memory. opts.onProgress fires with transformers.js
     * download reports ({ status, file, loaded, total, progress }).
     */
    load: function (model, opts) {
      opts = opts || {};
      return lmCall('load', { model: model, device: opts.device, dtype: opts.dtype },
        { onProgress: opts.onProgress });
    },

    /** Drop the model and free its memory. */
    unload: function () { return lmCall('unload'); },

    /**
     * One completion, in the shape of an OpenAI chat completion.
     *
     *   os.lm.chat({
     *     model: 'onnx-community/Qwen2.5-0.5B-Instruct',   // optional
     *     messages: [{ role: 'user', content: 'hi' }],
     *     tools: [...],                                     // OpenAI tool schemas
     *     max_tokens: 1024, temperature: 0.7,
     *     onText: function (delta) {},                      // streamed prose
     *     onProgress: function (report) {},                 // fires if it has to download first
     *     signal: controller.signal                         // aborts with an AbortError
     *   }) → { content, calls: [{ id, name, args }], usage, model }
     *
     * The model is loaded on demand if it is not already in memory.
     */
    chat: function (opts) {
      opts = opts || {};
      return lmCall('chat', {
        model: opts.model,
        messages: opts.messages || [],
        tools: opts.tools || [],
        max_tokens: opts.max_tokens,
        temperature: opts.temperature,
        top_p: opts.top_p,
        device: opts.device,
        dtype: opts.dtype
      }, { onText: opts.onText, onProgress: opts.onProgress, signal: opts.signal });
    }
  };

  window.os = {
    lm: lm,

    /**
     * Open a WinBox window on the desktop.
     * Matches the signature of openWindow() in windows.js.
     */
    openWindow: function (title, key, page, opts) {
      post({ type: 'axiom:open-window', title: title, key: key, page: page, opts: opts || {} });
    },

    /**
     * Evaluate a JavaScript expression in the windows.html context.
     * Returns a Promise that resolves with the serialised result.
     *
     * Example:
     *   os.eval('document.getElementById("tray-clock").textContent')
     *     .then(console.log)
     */
    eval: function (code) {
      return request({ type: 'axiom:eval', code: code });
    },

    /**
     * Returns a Promise with an array of { key, title, closed } for every
     * open WinBox window.
     */
    listWindows: function () {
      return request({ type: 'axiom:list-windows' });
    },

    /** Focus a window by its key (e.g. 'terminal', 'apps'). */
    focusWindow: function (key) {
      post({ type: 'axiom:window-control', key: key, action: 'focus' });
    },

    /** Close a window by its key. */
    closeWindow: function (key) {
      post({ type: 'axiom:window-control', key: key, action: 'close' });
    },

    /** Minimise a window by its key. */
    minimizeWindow: function (key) {
      post({ type: 'axiom:window-control', key: key, action: 'minimize' });
    },

    /** Maximise (or restore) a window by its key. */
    maximizeWindow: function (key) {
      post({ type: 'axiom:window-control', key: key, action: 'maximize' });
    }
  };
})();

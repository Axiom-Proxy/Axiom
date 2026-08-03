/*
 * AxiomClaude - a miniature Claude Code that runs inside the Axiom terminal.
 *
 * It is an agentic loop over the Composite API (an OpenAI-compatible gateway),
 * with tools wired straight into AxiomFS and AxiomShell. The model can read,
 * write and edit files in the virtual filesystem, and can run real shell
 * commands through the same shell the user is typing into.
 *
 * The user brings their own key; it is kept in localStorage and sent only to
 * the endpoint below.
 *
 *   var program = AxiomClaude.createProgram({ argv: [], cwd: '/home/user' });
 *   program.start(host);   // see terminal.js for the host contract
 *
 * The host contract:
 *   write(text, cls)          append a plain line
 *   writeHtml(html, cls)      append a line of markup
 *   stream(cls)               -> { write(chunk), end() } for a growing line
 *   spinner(label)            -> { set(label), stop() }
 *   setPrompt(html)           replace the prompt on the input line
 *   setBusy(flag)             hide the input line while the agent works
 *   clear()                   wipe the screen
 *   exit()                    hand the terminal back to the shell
 */
(function (global) {
  'use strict';

  var API_BASE = 'https://composite.lucidity.sh/v1';
  var DEFAULT_MODEL = 'anthropic/claude-haiku-4.5';
  var KEY_STORE = 'axiom_claude_key';
  var MODEL_STORE = 'axiom_claude_model';

  // A model named `local/<repo>` is served by the LM Studio window through
  // os.lm instead of the Composite API, and needs no key.
  var LOCAL_PREFIX = 'local/';

  var MAX_STEPS = 128;          // tool round-trips before the loop gives up
  var MAX_TOOL_OUTPUT = 16000; // characters of tool result handed back
  var READ_LIMIT = 2000;       // default lines per read_file

  var fs = global.AxiomFS;
  var escHtml = global.AxiomShell.escHtml;

  /* ------------------------------------------------------------- settings */

  function stored(key, fallback) {
    try { return localStorage.getItem(key) || fallback; } catch (e) { return fallback; }
  }
  function store(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) { /* private browsing: the key just will not persist */ }
  }

  /* ------------------------------------------------------ markdown-ish text */

  function inline(text) {
    return escHtml(text)
      .replace(/`([^`]+)`/g, '<code class="cc-code">$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\s)\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  }

  /**
   * Just enough markdown for assistant prose: fences, headings, bullets and
   * the usual inline marks. Re-run over the whole message on every chunk, so
   * it has to cope with a half-written document.
   */
  function markdown(text) {
    var out = [];
    var lines = String(text).split('\n');
    var fence = null;
    var buffer = [];

    function flushFence() {
      var lang = fence && fence !== 'text' ? ' data-lang="' + escHtml(fence) + '"' : '';
      out.push('<pre class="cc-block"' + lang + '>' + escHtml(buffer.join('\n')) + '</pre>');
      buffer = [];
      fence = null;
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var open = /^```(\w*)\s*$/.exec(line);

      if (fence !== null) {
        if (/^```/.test(line)) { flushFence(); continue; }
        buffer.push(line);
        continue;
      }
      if (open) { fence = open[1] || 'text'; continue; }

      var heading = /^(#{1,4})\s+(.*)$/.exec(line);
      if (heading) {
        out.push('<div class="cc-heading">' + inline(heading[2]) + '</div>');
        continue;
      }
      var bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
      if (bullet) {
        out.push('<div class="cc-bullet" style="padding-left:' + (bullet[1].length * 8) + 'px">' +
          '<span class="cc-dot">•</span>' + inline(bullet[2]) + '</div>');
        continue;
      }
      out.push('<div>' + (line === '' ? '&nbsp;' : inline(line)) + '</div>');
    }

    if (fence !== null) flushFence();
    return out.join('');
  }

  /* ----------------------------------------------------------------- tools */

  function clip(text) {
    text = String(text == null ? '' : text);
    if (text.length <= MAX_TOOL_OUTPUT) return text;
    return text.slice(0, MAX_TOOL_OUTPUT) +
      '\n\n[truncated, ' + (text.length - MAX_TOOL_OUTPUT) + ' more characters]';
  }

  /** Lines a file would show in an editor: a trailing newline is not a line. */
  function lineCount(text) {
    text = String(text == null ? '' : text);
    if (text === '') return 0;
    return text.replace(/\n$/, '').split('\n').length;
  }

  function numbered(text, offset) {
    return text.split('\n').map(function (line, i) {
      return String(offset + i + 1).padStart(5) + '→' + line;
    }).join('\n');
  }

  /** `src/**\/*.js` and friends, matched against every path under `root`. */
  function globToRegExp(pattern) {
    var out = '';
    for (var i = 0; i < pattern.length; i++) {
      var ch = pattern.charAt(i);
      if (ch === '*' && pattern.charAt(i + 1) === '*') {
        // `**/` may match nothing at all, so the slash is part of the group.
        if (pattern.charAt(i + 2) === '/') { out += '(?:.*/)?'; i += 2; }
        else { out += '.*'; i += 1; }
        continue;
      }
      if (ch === '*') { out += '[^/]*'; continue; }
      if (ch === '?') { out += '[^/]'; continue; }
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp('^' + out + '$');
  }

  function relative(abs, cwd) {
    var base = cwd === '/' ? '/' : cwd + '/';
    return abs.indexOf(base) === 0 ? abs.slice(base.length) : abs;
  }

  var TOOLS = {};

  function tool(name, description, parameters, options) {
    TOOLS[name] = {
      name: name,
      schema: {
        type: 'function',
        function: { name: name, description: description, parameters: parameters }
      },
      label: options.label,
      detail: options.detail,
      // Anything that can change the world asks first, unless the user said not to.
      confirm: options.confirm || null,
      run: options.run
    };
  }

  function str(description) { return { type: 'string', description: description }; }

  tool('read_file', 'Read a file from the filesystem. Returns the contents with line numbers.', {
    type: 'object',
    properties: {
      path: str('Path to the file, absolute or relative to the working directory.'),
      offset: { type: 'integer', description: 'First line to read, 1-based. Optional.' },
      limit: { type: 'integer', description: 'How many lines to read. Optional.' }
    },
    required: ['path']
  }, {
    label: 'Read',
    detail: function (args) { return args.path; },
    run: function (args, ctx) {
      var stat = fs.stat(args.path, ctx.cwd);
      if (stat.isDirectory) throw new Error(args.path + ' is a directory; use list_dir');
      if (stat.binary) return '[binary file, ' + fs.formatSize(stat.size) + ']';

      var body = fs.readFile(stat.path);
      var offset = Math.max(0, (args.offset || 1) - 1);
      var limit = args.limit || READ_LIMIT;
      var all = body.split('\n');
      var slice = all.slice(offset, offset + limit);
      if (!slice.length) return '[no lines in that range; the file has ' + all.length + ']';

      var text = numbered(slice.join('\n'), offset);
      if (offset + slice.length < all.length) {
        text += '\n[' + (all.length - offset - slice.length) + ' more lines]';
      }
      return text;
    }
  });

  tool('write_file', 'Create a file, or overwrite one that already exists.', {
    type: 'object',
    properties: {
      path: str('Path to write to. Parent directories are created as needed.'),
      content: str('The full contents of the file.')
    },
    required: ['path', 'content']
  }, {
    label: 'Write',
    confirm: 'wants to write a file',
    detail: function (args) {
      var count = lineCount(args.content);
      return args.path + '  (' + count + ' line' + (count === 1 ? '' : 's') + ')';
    },
    run: function (args, ctx) {
      var abs = fs.normalize(args.path, ctx.cwd);
      var existed = fs.exists(abs);
      fs.mkdir(fs.dirname(abs), { recursive: true });
      fs.writeFile(abs, args.content == null ? '' : args.content);
      ctx.touched(abs);
      return (existed ? 'Overwrote ' : 'Created ') + abs +
        ' (' + lineCount(args.content) + ' lines).';
    }
  });

  tool('edit_file', 'Replace an exact string in a file. The old string must appear exactly once unless replace_all is set.', {
    type: 'object',
    properties: {
      path: str('Path to the file to edit.'),
      old_string: str('The exact text to replace, including indentation.'),
      new_string: str('The replacement text.'),
      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match.' }
    },
    required: ['path', 'old_string', 'new_string']
  }, {
    label: 'Edit',
    confirm: 'wants to edit a file',
    detail: function (args) { return args.path; },
    run: function (args, ctx) {
      var stat = fs.stat(args.path, ctx.cwd);
      if (stat.isDirectory) throw new Error(args.path + ' is a directory');
      var body = fs.readFile(stat.path);
      var pieces = body.split(args.old_string);

      if (pieces.length === 1) throw new Error('old_string was not found in ' + stat.path);
      if (pieces.length > 2 && !args.replace_all) {
        throw new Error('old_string appears ' + (pieces.length - 1) + ' times in ' + stat.path +
          '; add more context or set replace_all');
      }

      var updated = args.replace_all
        ? pieces.join(args.new_string)
        : pieces[0] + args.new_string + pieces.slice(1).join(args.old_string);

      fs.writeFile(stat.path, updated);
      ctx.touched(stat.path);
      return 'Edited ' + stat.path + ' (' + (pieces.length - 1) + ' replacement' +
        (pieces.length === 2 ? '' : 's') + ').';
    }
  });

  tool('list_dir', 'List the entries in a directory.', {
    type: 'object',
    properties: { path: str('Directory to list. Defaults to the working directory.') },
    required: []
  }, {
    label: 'List',
    detail: function (args) { return args.path || '.'; },
    run: function (args, ctx) {
      var entries = fs.list(args.path || '.', ctx.cwd);
      if (!entries.length) return '(empty directory)';
      return entries.map(function (entry) {
        return entry.isDirectory
          ? entry.name + '/'
          : entry.name + '  ' + fs.formatSize(entry.size);
      }).join('\n');
    }
  });

  tool('glob', 'Find files by path pattern, e.g. "**/*.js" or "src/*.css".', {
    type: 'object',
    properties: {
      pattern: str('Glob pattern. ** matches across directories.'),
      path: str('Directory to search from. Defaults to the working directory.')
    },
    required: ['pattern']
  }, {
    label: 'Glob',
    detail: function (args) { return args.pattern; },
    run: function (args, ctx) {
      var root = fs.normalize(args.path || '.', ctx.cwd);
      var re = globToRegExp(args.pattern);
      var hits = fs.walk(root).filter(function (entry) {
        return entry.isFile && re.test(relative(entry.path, root));
      });
      if (!hits.length) return 'No files matched ' + args.pattern;
      return hits.map(function (entry) { return entry.path; }).join('\n');
    }
  });

  tool('grep', 'Search file contents with a regular expression.', {
    type: 'object',
    properties: {
      pattern: str('JavaScript regular expression to search for.'),
      path: str('File or directory to search. Defaults to the working directory.'),
      glob: str('Only search files whose path matches this glob, e.g. "*.js".')
    },
    required: ['pattern']
  }, {
    label: 'Grep',
    detail: function (args) { return args.pattern; },
    run: function (args, ctx) {
      var re = new RegExp(args.pattern, 'i');
      var root = fs.normalize(args.path || '.', ctx.cwd);
      var stat = fs.stat(root);
      var files = stat.isFile ? [stat] : fs.walk(root).filter(function (e) { return e.isFile; });

      if (args.glob) {
        var globRe = globToRegExp(args.glob.indexOf('/') === -1 ? '**/' + args.glob : args.glob);
        files = files.filter(function (entry) { return globRe.test(relative(entry.path, root)); });
      }

      var out = [];
      var matches = 0;
      files.forEach(function (entry) {
        if (entry.binary) return;
        fs.readFile(entry.path).split('\n').forEach(function (line, i) {
          if (!re.test(line) || matches >= 200) return;
          matches++;
          out.push(entry.path + ':' + (i + 1) + ': ' + line.slice(0, 400));
        });
      });

      if (!out.length) return 'No matches for /' + args.pattern + '/';
      return out.join('\n') + (matches >= 200 ? '\n[stopped at 200 matches]' : '');
    }
  });

  tool('bash', 'Run a command in the Axiom shell. Supports pipes, redirection and && chaining. Run `help` to see every command.', {
    type: 'object',
    properties: {
      command: str('The command line to run.'),
      description: str('A five-word description of what the command does.')
    },
    required: ['command']
  }, {
    label: 'Bash',
    confirm: 'wants to run a shell command',
    detail: function (args) { return args.command; },
    run: function (args, ctx) {
      var result = ctx.shell.run(args.command);
      var text = result.output.map(function (record) { return record.text; })
        .filter(function (line) { return line !== ''; }).join('\n');
      if (result.code !== 0) {
        return (text || '(no output)') + '\n[exit code ' + result.code + ']';
      }
      return text || '(no output)';
    }
  });

  tool('todo_write', 'Record the task list for the current piece of work, so the user can follow along.', {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The full list, re-sent in full every time it changes.',
        items: {
          type: 'object',
          properties: {
            content: str('What the task is.'),
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }
          },
          required: ['content', 'status']
        }
      }
    },
    required: ['todos']
  }, {
    label: 'Todos',
    detail: function (args) {
      var todos = args.todos || [];
      var done = todos.filter(function (t) { return t.status === 'completed'; }).length;
      return done + '/' + todos.length + ' done';
    },
    run: function (args, ctx) {
      ctx.showTodos(args.todos || []);
      return 'Task list updated.';
    }
  });

  var TOOL_SCHEMAS = Object.keys(TOOLS).map(function (name) { return TOOLS[name].schema; });

  /* --------------------------------------------------------- system prompt */

  function systemPrompt(cwd) {
    var listing;
    try {
      listing = fs.list(cwd).slice(0, 40).map(function (entry) {
        return '  ' + entry.name + (entry.isDirectory ? '/' : '');
      }).join('\n');
    } catch (e) {
      listing = '  (unreadable)';
    }

    return [
      'You are Mini Claude Code, an interactive coding agent that runs inside Axiom - a small',
      'operating system that lives in a browser tab. You work in a virtual filesystem that is',
      'persisted to IndexedDB, and your `bash` tool drives a real POSIX-flavoured shell.',
      '',
      'How to behave:',
      '- Be concise. This is a terminal; the user is reading monospaced text, not a document.',
      '  Answer in a few lines unless detail was asked for. Do not pad with preamble or summary.',
      '- Use the tools rather than guessing. Read a file before editing it.',
      '- Prefer edit_file over write_file when changing an existing file.',
      '- Use todo_write when a task has several steps, and keep it up to date as you go.',
      '- When you finish, say what you did in a sentence or two. Do not restate the whole diff.',
      '- Never invent file contents or command output. If a tool fails, say so and adjust.',
      '',
      'Environment:',
      '- Working directory: ' + cwd,
      '- Home is /home/user. There is no network, no package manager and no git.',
      '- The shell has: ls cat grep sed head tail sort wc find mkdir rm mv cp echo tree stat',
      '  du df file which js edit open download. `js` evaluates JavaScript in the page.',
      '',
      'Axiom UI — windows.html element IDs (use via `js` tool to manipulate the desktop):',
      '- #axiom-loader          loader overlay',
      '- #desktop               main desktop surface',
      '- #desktop-icons         desktop icon container',
      '- #taskbar               bottom taskbar',
      '- #btn-wifi              Wi-Fi taskbar button',
      '- #taskbar-search        search bar wrapper in taskbar',
      '- #sf-input              search text input',
      '- #btn-start             Home/Start taskbar button',
      '- #btn-apps              Apps taskbar button',
      '- #btn-games             Games taskbar button',
      '- #btn-chat              Chat taskbar button',
      '- #btn-files             Files taskbar button',
      '- #btn-terminal          Terminal taskbar button',
      '- #btn-lmstudio          LM Studio taskbar button',
      '- #btn-settings          Settings taskbar button',
      '- #btn-battery           Battery tray button',
      '- #battery-icon          Battery icon <span>',
      '- #tray-time             Clock/date tray area',
      '- #tray-clock            Clock <span> (--:--)',
      '- #tray-date             Date <span>',
      '- #search-flyout         Search results flyout panel',
      '- #sf-results            Search results list',
      '- #calendar-flyout       Calendar flyout panel',
      '- #cal-now-time          Current time in calendar header',
      '- #cal-now-date          Current date in calendar header',
      '- #cal-month             Month label in calendar',
      '- #cal-today             "Today" navigation button',
      '- #cal-prev              "Previous month" button',
      '- #cal-next              "Next month" button',
      '- #cal-grid              Calendar day grid',
      '',
      'Axiom Settings — settings.html element IDs:',
      '- #themeDropdown         Theme dropdown wrapper',
      '- #dropdownTrigger       Dropdown open/close trigger',
      '- #dropdownLabel         Currently selected theme name',
      '- #dropdownPanel         Dropdown options list',
      '- #premium-container     Premium section container',
      '- #premium-key-input     Premium key <input>',
      '- #premium-activate-btn  Activate premium key button',
      '- #premium-clear-btn     Remove premium key button',
      '- #premium-status        Premium status message <p>',
      '',
      'Autorun scripts — any file anywhere in the filesystem whose name ends in .auto.js is automatically',
      'executed by windows.html in the desktop context once (on load, or the moment it is created/written).',
      'Use these to build persistent desktop workflows. The script runs as a plain function with full access',
      'to the desktop globals: openWindow, openWindows, AxiomFS, AxiomShell, etc.',
      'Example: write /home/user/greet.auto.js with `openWindow("Apps","apps","apps.html")` to auto-open Apps.',
      '',
      'window.os — desktop bridge (use from the `js` tool; all calls go via postMessage to windows.html):',
      '- os.openWindow(title, key, page, opts)  open a WinBox window on the desktop',
      '- os.eval(code) → Promise<string>        run JS in the windows.html context and get the result',
      '- os.listWindows() → Promise<{key,title,closed}[]>  list open WinBox windows',
      '- os.focusWindow(key)                    focus a window by key',
      '- os.closeWindow(key)                    close a window by key',
      '- os.minimizeWindow(key)                 minimise a window by key',
      '- os.maximizeWindow(key)                 maximise / restore a window by key',
      '  Keys match taskbar button ids minus the "btn-" prefix: terminal, apps, games, chat, files, settings, start, lmstudio',
      '',
      'os.lm — the local model endpoint, served by the LM Studio window (lmstudio.html).',
      'It runs Hugging Face models in the browser with transformers.js, on WebGPU where there is one.',
      'Calling it opens LM Studio automatically if it is closed. All calls return Promises:',
      '- os.lm.status()                         { status, model, device, dtype, loaded, served }',
      '- os.lm.models()                         the built-in catalog',
      '- os.lm.load(repo, { onProgress })       pull a model into memory',
      '- os.lm.unload()                         free it again',
      '- os.lm.chat({ messages, tools, max_tokens, temperature, onText, signal })',
      '                                         → { content, calls, usage }, OpenAI-shaped',
      'You are talking to that endpoint yourself whenever the model is named local/<repo>.',
      '',
      'Axiom localStorage keys:',
      '- axiom_claude_key       Composite API key for Mini Claude',
      '- axiom_claude_model     Model override for Mini Claude (default: anthropic/claude-haiku-4.5;',
      '                         a local/<repo> value routes to LM Studio instead of the network)',
      '- axiom_lm_prefs         LM Studio settings: { model, device, dtype, maxTokens, temperature }',
      '- axiom_lm_cdn           transformers.js build URL override for LM Studio',
      '- axiom_theme            Active theme id (managed by window.axiomTheme)',
      '- axiom_premium_key      Premium licence key (managed by window.axiomPremium)',
      '',
      'Contents of ' + cwd + ':',
      listing
    ].join('\n');
  }

  /* ------------------------------------------------------------- transport */

  function apiError(status, body) {
    var message = body;
    try {
      var parsed = JSON.parse(body);
      if (parsed && parsed.error) message = parsed.error.message || JSON.stringify(parsed.error);
    } catch (e) { /* keep the raw body */ }
    if (status === 401 || status === 403) {
      return new Error('The API rejected that key (' + status + '). Run /login to set a new one.');
    }
    return new Error('API error ' + status + ': ' + String(message).slice(0, 400));
  }

  /**
   * One streamed completion. `onText` fires for each prose delta; the resolved
   * value is the assembled assistant message plus token usage.
   */
  async function streamCompletion(options) {
    var response = await fetch(API_BASE + '/chat/completions', {
      method: 'POST',
      signal: options.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + options.key
      },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        tools: TOOL_SCHEMAS,
        max_tokens: 8192,
        stream: true,
        stream_options: { include_usage: true }
      })
    });

    if (!response.ok) throw apiError(response.status, await response.text());
    if (!response.body) throw new Error('The API returned an empty response body.');

    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var pending = '';
    var content = '';
    var calls = [];
    var usage = null;

    function absorb(delta) {
      if (delta.content) { content += delta.content; options.onText(delta.content); }
      if (!delta.tool_calls) return;
      delta.tool_calls.forEach(function (part) {
        var index = part.index == null ? 0 : part.index;
        var call = calls[index] || (calls[index] = { id: '', name: '', args: '' });
        if (part.id) call.id = part.id;
        if (!part.function) return;
        if (part.function.name) call.name += part.function.name;
        if (part.function.arguments) call.args += part.function.arguments;
      });
    }

    for (;;) {
      var chunk = await reader.read();
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });

      var split = pending.split('\n');
      pending = split.pop();

      for (var i = 0; i < split.length; i++) {
        var line = split[i].trim();
        if (line.indexOf('data:') !== 0) continue;
        var payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;

        var event;
        try { event = JSON.parse(payload); } catch (e) { continue; }
        if (event.usage) usage = event.usage;
        var choice = event.choices && event.choices[0];
        if (choice && choice.delta) absorb(choice.delta);
      }
    }

    return {
      content: content,
      calls: calls.filter(Boolean).filter(function (call) { return call.name; }),
      usage: usage
    };
  }

  /* ------------------------------------------------------ local transport */

  function isLocal(name) {
    return String(name).indexOf(LOCAL_PREFIX) === 0;
  }

  function localEndpoint() {
    if (!global.os || !global.os.lm) {
      throw new Error('Local models need the Axiom desktop; this terminal is not running inside it.');
    }
    return global.os.lm;
  }

  /**
   * The same contract as streamCompletion(), answered by the model loaded in
   * the LM Studio window. Downloading a model the first time can take a while,
   * so progress reports are surfaced through onProgress.
   */
  async function localCompletion(options) {
    var result = await localEndpoint().chat({
      model: options.model.slice(LOCAL_PREFIX.length),
      messages: options.messages,
      tools: TOOL_SCHEMAS,
      max_tokens: 2048,
      onText: options.onText,
      onProgress: options.onProgress,
      signal: options.signal
    });

    return {
      content: result.content || '',
      calls: result.calls || [],
      usage: result.usage || null
    };
  }

  /* -------------------------------------------------------------- program */

  var BANNER = [
    ' ✦  Mini Claude Code',
    '    a coding agent living inside a web operating system'
  ];

  function createProgram(options) {
    options = options || {};

    var host = null;
    var shell = null;
    var cwd = options.cwd || fs.HOME;
    var model = options.model || stored(MODEL_STORE, DEFAULT_MODEL);
    var key = stored(KEY_STORE, '');

    var messages = [];
    var pendingLine = null;   // resolver for whatever we last asked the user
    var controller = null;    // aborts the request in flight
    var autoAccept = false;
    var totals = { in: 0, out: 0 };
    var running = true;

    /* --- input --- */

    function ask(promptHtml) {
      host.setPrompt(promptHtml);
      return new Promise(function (resolve) { pendingLine = resolve; });
    }

    function askPrompt() {
      return ask('<span class="cc-caret">›</span>');
    }

    /* --- output helpers --- */

    function blank() { host.writeHtml('&nbsp;'); }

    function note(text) { host.writeHtml(escHtml(text), 'cc-note'); }

    function fail(text) { host.writeHtml(escHtml(text), 'term-error'); }

    function toolLine(label, detail) {
      host.writeHtml(
        '<span class="cc-tool-bullet">⏺</span> ' +
        '<span class="cc-tool-name">' + escHtml(label) + '</span> ' +
        '<span class="cc-tool-detail">' + escHtml(detail || '') + '</span>',
        'cc-tool');
    }

    function toolResult(text, isError) {
      var lines = String(text).split('\n');
      var shown = lines.slice(0, 6);
      var body = shown.map(function (line) {
        return '<div class="cc-tool-out-line">' + escHtml(line.slice(0, 200)) + '</div>';
      }).join('');
      if (lines.length > shown.length) {
        body += '<div class="cc-tool-out-line cc-more">… +' +
          (lines.length - shown.length) + ' more lines</div>';
      }
      host.writeHtml('<span class="cc-elbow">└</span><span class="cc-tool-out">' + body + '</span>',
        isError ? 'cc-tool-error' : 'cc-tool-result');
    }

    function showTodos(todos) {
      var glyphs = { completed: '✔', in_progress: '▶', pending: '□' };
      var body = todos.map(function (todo) {
        var cls = 'cc-todo cc-todo-' + todo.status;
        return '<div class="' + cls + '"><span class="cc-todo-mark">' +
          (glyphs[todo.status] || '□') + '</span>' + escHtml(todo.content) + '</div>';
      }).join('');
      host.writeHtml('<span class="cc-elbow">└</span><span class="cc-tool-out">' + body + '</span>',
        'cc-tool-result');
    }

    /* --- permissions --- */

    async function permitted(tool, args) {
      if (!tool.confirm || autoAccept) return true;

      host.writeHtml(
        '<div class="cc-ask-title">' + escHtml(tool.label + ' ' + tool.confirm) + '</div>' +
        '<div class="cc-ask-detail">' + escHtml(tool.detail(args) || '') + '</div>' +
        '<div class="cc-ask-options">[y] allow once &nbsp; [a] allow for this session &nbsp; [n] deny</div>',
        'cc-ask');

      var answer = (await ask('<span class="cc-caret cc-caret-ask">?</span>')).trim().toLowerCase();
      if (answer === 'a' || answer === 'always') { autoAccept = true; return true; }
      return answer === '' || answer === 'y' || answer === 'yes';
    }

    /* --- the agent loop --- */

    async function runTurn(input) {
      messages.push({ role: 'user', content: input });

      var started = Date.now();
      var spinner = null;
      var stage = 'Thinking';

      function tick(label) {
        var seconds = Math.round((Date.now() - started) / 1000);
        var tokens = totals.in + totals.out;
        var suffix = seconds + 's' + (tokens ? ' · ' + tokens.toLocaleString() + ' tokens' : '');
        if (spinner) spinner.set(label + ' (' + suffix + ' · esc to interrupt)');
      }

      /** A local model that has to be downloaded first says so, rather than hanging. */
      function onProgress(report) {
        if (!report || !report.file) return;
        stage = report.progress
          ? 'Downloading ' + report.file + ' ' + Math.round(report.progress) + '%'
          : 'Loading ' + report.file;
        tick(stage);
      }

      var complete = isLocal(model) ? localCompletion : streamCompletion;

      for (var step = 0; step < MAX_STEPS; step++) {
        controller = new AbortController();
        host.setBusy(true);
        stage = 'Thinking';
        spinner = host.spinner(stage);
        var beat = setInterval(function () { tick(stage); }, 1000);

        var reply;
        var text = null;
        try {
          reply = await complete({
            key: key,
            model: model,
            messages: [{ role: 'system', content: systemPrompt(cwd) }].concat(messages),
            signal: controller.signal,
            onProgress: onProgress,
            onText: function (chunk) {
              // Hold the spinner until the first token, then let the prose take over.
              if (!text) { spinner.stop(); spinner = null; clearInterval(beat); text = host.stream('cc-text'); }
              text.write(chunk);
            }
          });
        } catch (err) {
          if (spinner) spinner.stop();
          if (text) text.end();
          clearInterval(beat);
          host.setBusy(false);
          if (err && err.name === 'AbortError') { note('Interrupted.'); return; }
          fail(String(err && err.message ? err.message : err));
          return;
        }

        if (spinner) spinner.stop();
        if (text) text.end();
        clearInterval(beat);
        controller = null;

        if (reply.usage) {
          totals.in += reply.usage.prompt_tokens || 0;
          totals.out += reply.usage.completion_tokens || 0;
        }

        messages.push({
          role: 'assistant',
          content: reply.content || null,
          tool_calls: reply.calls.length ? reply.calls.map(function (call) {
            return {
              id: call.id, type: 'function',
              function: { name: call.name, arguments: call.args || '{}' }
            };
          }) : undefined
        });

        if (!reply.calls.length) {
          host.setBusy(false);
          blank();
          return;
        }

        if (reply.content) blank();
        host.setBusy(false);

        for (var c = 0; c < reply.calls.length; c++) {
          var call = reply.calls[c];
          var definition = TOOLS[call.name];
          var args = {};
          var parseFailed = false;

          try { args = JSON.parse(call.args || '{}'); } catch (e) { parseFailed = true; }

          if (!definition) {
            toolLine('Unknown', call.name);
            toolResult('No such tool: ' + call.name, true);
            messages.push({ role: 'tool', tool_call_id: call.id, content: 'Error: no tool named ' + call.name });
            continue;
          }

          if (parseFailed) {
            toolLine(definition.label, '(malformed arguments)');
            toolResult('Arguments were not valid JSON', true);
            messages.push({
              role: 'tool', tool_call_id: call.id,
              content: 'Error: the arguments were not valid JSON. Send them again.'
            });
            continue;
          }

          toolLine(definition.label, definition.detail(args));

          if (!(await permitted(definition, args))) {
            toolResult('Denied by the user', true);
            messages.push({
              role: 'tool', tool_call_id: call.id,
              content: 'The user denied this action. Do not retry it; ask what they would prefer.'
            });
            continue;
          }

          var context = {
            cwd: cwd,
            shell: shell,
            showTodos: showTodos,
            touched: function () { /* the filesystem broadcasts its own changes */ }
          };

          try {
            var output = String(definition.run(args, context));
            if (call.name === 'bash') cwd = shell.cwd; // the model may have cd'd
            if (definition.name !== 'todo_write') toolResult(output || '(done)', false);
            messages.push({ role: 'tool', tool_call_id: call.id, content: clip(output) });
          } catch (err) {
            var message = String(err && err.message ? err.message : err);
            toolResult(message, true);
            messages.push({ role: 'tool', tool_call_id: call.id, content: 'Error: ' + message });
          }
        }

        blank();
      }

      host.setBusy(false);
      fail('Stopped after ' + MAX_STEPS + ' steps without finishing.');
    }

    /* --- slash commands --- */

    async function login(reason) {
      if (reason) note(reason);
      note('Get a key from https://composite.lucidity.sh - it is stored in this browser only.');
      var entered = (await ask('<span class="cc-caret">key</span>')).trim();
      if (!entered) { fail('No key entered.'); return false; }
      key = entered;
      store(KEY_STORE, key);
      note('Key saved.');
      blank();
      return true;
    }

    var SLASH = {
      '/help': function () {
        host.writeHtml([
          '<div class="cc-heading">Commands</div>',
          '<div><span class="cc-key">/help</span>    this list</div>',
          '<div><span class="cc-key">/clear</span>   wipe the screen and forget the conversation</div>',
          '<div><span class="cc-key">/model</span>   show or change the model</div>',
          '<div><span class="cc-key">/local</span>   list local models, or switch to one (no key needed)</div>',
          '<div><span class="cc-key">/login</span>   set your API key</div>',
          '<div><span class="cc-key">/logout</span>  forget your API key</div>',
          '<div><span class="cc-key">/cwd</span>     show or change the working directory</div>',
          '<div><span class="cc-key">/cost</span>    tokens used this session</div>',
          '<div><span class="cc-key">/yolo</span>    stop asking before writes</div>',
          '<div><span class="cc-key">/exit</span>    back to the shell</div>',
          '<div>&nbsp;</div>',
          '<div class="cc-note">Ctrl+C interrupts the model; twice in a row exits.</div>'
        ].join(''), 'cc-help');
        blank();
      },
      '/clear': function () {
        messages = [];
        host.clear();
        banner();
      },
      '/model': function (rest) {
        if (!rest) { note('Model: ' + model); blank(); return; }
        model = rest;
        store(MODEL_STORE, model);
        note('Model set to ' + model);
        blank();
      },
      '/local': async function (rest) {
        var endpoint;
        try { endpoint = localEndpoint(); } catch (e) { fail(e.message); blank(); return; }

        if (rest) {
          model = LOCAL_PREFIX + rest;
          store(MODEL_STORE, model);
          note('Model set to ' + model + '. Loading it now…');

          var spin = host.spinner('Preparing ' + rest);
          try {
            await endpoint.load(rest, {
              onProgress: function (report) {
                if (!report || !report.file) return;
                spin.set(report.progress
                  ? 'Downloading ' + report.file + ' ' + Math.round(report.progress) + '%'
                  : 'Loading ' + report.file);
              }
            });
            spin.stop();
            note('Ready. Everything now runs in this browser tab.');
          } catch (err) {
            spin.stop();
            fail(String(err && err.message ? err.message : err));
          }
          blank();
          return;
        }

        var catalog;
        try { catalog = await endpoint.models(); } catch (err) {
          fail(String(err && err.message ? err.message : err));
          blank();
          return;
        }

        var rows = catalog.models.map(function (entry) {
          return '<div><span class="cc-key">' + escHtml(entry.id) + '</span> ' +
            escHtml(entry.size) + (entry.tools ? ' · tools' : '') +
            '<div class="cc-note">' + escHtml(entry.note) + '</div></div>';
        });

        host.writeHtml([
          '<div class="cc-heading">Local models</div>',
          '<div class="cc-note">Served by the LM Studio window. Weights are cached after the first run.</div>',
          '<div>&nbsp;</div>'
        ].concat(rows).concat([
          '<div>&nbsp;</div>',
          '<div class="cc-note">Switch with <span class="cc-key">/local &lt;repo&gt;</span>, ' +
          'or any Hugging Face repo that ships ONNX weights.</div>',
          '<div class="cc-note">Currently loaded: ' +
          escHtml(catalog.loaded || 'nothing') + '</div>'
        ]).join(''), 'cc-help');
        blank();
      },
      '/login': function () { return login(); },
      '/logout': function () {
        key = '';
        store(KEY_STORE, null);
        note('Key forgotten.');
        blank();
      },
      '/cwd': function (rest) {
        if (rest) {
          try {
            var stat = fs.stat(rest, cwd);
            if (!stat.isDirectory) throw new Error('not a directory');
            cwd = stat.path;
            shell.setCwd(cwd);
          } catch (e) {
            fail('cd: ' + rest + ': ' + (e.code === 'ENOENT' ? 'no such directory' : e.message));
            blank();
            return;
          }
        }
        note('Working directory: ' + cwd);
        blank();
      },
      '/cost': function () {
        note(totals.in.toLocaleString() + ' input tokens, ' +
          totals.out.toLocaleString() + ' output tokens this session.');
        blank();
      },
      '/yolo': function () {
        autoAccept = !autoAccept;
        note(autoAccept
          ? 'Permission prompts are off for this session.'
          : 'Permission prompts are back on.');
        blank();
      }
    };

    function banner() {
      host.writeHtml('<span class="speciale">' + escHtml(BANNER[0]) + '</span>', 'cc-banner');
      host.writeHtml(escHtml(BANNER[1]), 'cc-note');
      host.writeHtml('cwd ' + escHtml(cwd) + ' · ' + escHtml(model) +
        (isLocal(model) ? ' (in this tab)' : '') + ' · /help for commands', 'cc-note');
      blank();
    }

    /* --- lifecycle --- */

    async function main() {
      banner();

      // A local model is its own credential; only the hosted API needs a key.
      if (!key && !isLocal(model)) {
        note('No API key yet. Run /local instead to use a model that runs in this tab.');
        if (!(await login())) { host.exit(); return; }
      }

      if (options.oneShot) {
        await runTurn(options.oneShot);
        host.exit();
        return;
      }

      while (running) {
        var line = (await askPrompt()).trim();
        if (!running) return;
        if (!line) continue;

        if (line.charAt(0) === '/') {
          var space = line.indexOf(' ');
          var name = space === -1 ? line : line.slice(0, space);
          var rest = space === -1 ? '' : line.slice(space + 1).trim();

          if (name === '/exit' || name === '/quit') break;
          if (!SLASH[name]) { fail('Unknown command ' + name + '. Try /help.'); blank(); continue; }
          await SLASH[name](rest);
          continue;
        }

        await runTurn(line);
      }

      note('Leaving Mini Claude Code.');
      host.exit();
    }

    return {
      name: 'claude',

      start: function (terminalHost) {
        host = terminalHost;
        shell = global.AxiomShell.createSession();
        shell.setCwd(cwd);
        main().catch(function (err) {
          fail('claude: ' + String(err && err.message ? err.message : err));
          host.exit();
        });
      },

      /** Every submitted line goes to whoever last called ask(). */
      onLine: function (line) {
        if (!pendingLine) return;
        var resolve = pendingLine;
        pendingLine = null;
        resolve(line);
      },

      /** Ctrl+C: abort a request if one is running, otherwise leave. */
      onInterrupt: function () {
        if (controller) { controller.abort(); controller = null; return true; }
        running = false;
        if (pendingLine) { var resolve = pendingLine; pendingLine = null; resolve(''); }
        return false;
      }
    };
  }

  global.AxiomClaude = {
    createProgram: createProgram,
    markdown: markdown,
    DEFAULT_MODEL: DEFAULT_MODEL,
    hasKey: function () { return !!stored(KEY_STORE, ''); }
  };
})(window);

(function (global) {
  'use strict';

  var fs = global.AxiomFS;

  var ERRNO = {
    ENOENT: 'No such file or directory',
    EEXIST: 'File exists',
    ENOTDIR: 'Not a directory',
    EISDIR: 'Is a directory',
    ENOTEMPTY: 'Directory not empty',
    EPERM: 'Operation not permitted',
    EINVAL: 'Invalid argument',
    ENOSPC: 'No space left on device'
  };

  /** An error whose message is already fully formatted for display. */
  function shellError(message) {
    var err = new Error(message);
    err.formatted = true;
    return err;
  }

  /** Translate an AxiomFS error into `cmd: 'path': Human message`. */
  function fsFail(cmd, path, err) {
    var reason = ERRNO[err.code] || err.message;
    return shellError(cmd + ': ' + (path ? "'" + path + "': " : '') + reason);
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* -------------------------------------------------------------- parsing */

  /**
   * Split a line into word and operator tokens. `$VAR` references are recorded
   * rather than substituted, because a word is only expanded when its command
   * runs - `export FOO=bar; echo $FOO` has to see the new value.
   */
  function tokenize(line) {
    var tokens = [];
    var parts = [];
    var cur = '';
    var started = false;
    var glob = false;
    var quote = null;
    var i = 0;

    function flushLiteral() {
      if (cur !== '') { parts.push({ lit: cur }); cur = ''; }
    }

    function flush() {
      if (!started) return;
      flushLiteral();
      tokens.push({ parts: parts, glob: glob });
      parts = [];
      started = false;
      glob = false;
    }

    function readVar() {
      i++;
      var braced = line.charAt(i) === '{';
      if (braced) i++;
      var name = '';
      while (i < line.length && /[A-Za-z0-9_?]/.test(line.charAt(i))) name += line.charAt(i++);
      if (braced) {
        if (line.charAt(i) !== '}') throw shellError('bad substitution');
        i++;
      }
      if (!name) { cur += '$'; return; }
      flushLiteral();
      parts.push({ name: name });
    }

    while (i < line.length) {
      var ch = line.charAt(i);

      if (quote === "'") {
        if (ch === "'") { quote = null; i++; continue; }
        cur += ch; i++; started = true; continue;
      }

      if (quote === '"') {
        if (ch === '"') { quote = null; i++; continue; }
        if (ch === '\\' && i + 1 < line.length && '"\\$`'.indexOf(line.charAt(i + 1)) !== -1) {
          cur += line.charAt(i + 1); i += 2; started = true; continue;
        }
        if (ch === '$') { readVar(); started = true; continue; }
        cur += ch; i++; started = true; continue;
      }

      if (ch === "'" || ch === '"') { quote = ch; started = true; i++; continue; }
      if (ch === '\\' && i + 1 < line.length) { cur += line.charAt(i + 1); i += 2; started = true; continue; }
      if (ch === '#' && !started) break;
      if (/\s/.test(ch)) { flush(); i++; continue; }
      if (ch === '$') { readVar(); started = true; continue; }

      var pair = line.substr(i, 2);
      if (pair === '&&' || pair === '||' || pair === '>>') {
        flush(); tokens.push({ op: pair }); i += 2; continue;
      }
      if ('|;><'.indexOf(ch) !== -1) {
        flush(); tokens.push({ op: ch }); i++; continue;
      }

      if (ch === '*' || ch === '?') glob = true;
      cur += ch; i++; started = true;
    }

    if (quote) throw shellError('unexpected EOF while looking for matching ' + quote);
    flush();
    return tokens;
  }

  /** Resolve a word token's literal and `$VAR` parts against the environment. */
  function materialize(token, env) {
    var out = '';
    for (var i = 0; i < token.parts.length; i++) {
      var part = token.parts[i];
      out += part.lit != null ? part.lit : (env[part.name] == null ? '' : String(env[part.name]));
    }
    return out;
  }

  /**
   * tokens -> [{ pipeline: [command], joiner: ';' | '&&' | '||' }]
   * command -> { argv: [tok], redirects: { out, append, in } }
   */
  function parse(tokens) {
    var segments = [];
    var pipeline = [];
    var command = { argv: [], redirects: {} };
    var joiner = ';';

    function endCommand() {
      if (!command.argv.length && !command.redirects.out && !command.redirects.in) return false;
      pipeline.push(command);
      command = { argv: [], redirects: {} };
      return true;
    }

    function endSegment(nextJoiner) {
      endCommand();
      if (pipeline.length) segments.push({ pipeline: pipeline, joiner: joiner });
      pipeline = [];
      joiner = nextJoiner;
    }

    for (var i = 0; i < tokens.length; i++) {
      var tok = tokens[i];

      if (!tok.op) { command.argv.push(tok); continue; }

      if (tok.op === '>' || tok.op === '>>' || tok.op === '<') {
        var target = tokens[++i];
        if (!target || target.op) throw shellError('syntax error near unexpected token `newline\'');
        if (tok.op === '<') command.redirects.in = target;
        else { command.redirects.out = target; command.redirects.append = tok.op === '>>'; }
        continue;
      }

      if (tok.op === '|') {
        if (!endCommand()) throw shellError('syntax error near unexpected token `|\'');
        continue;
      }

      endSegment(tok.op === ';' ? ';' : tok.op);
    }

    endSegment(';');
    return segments;
  }

  /* -------------------------------------------------- argument conveniences */

  /**
   * Split argv into flags and operands. `valued` lists short flags that take a
   * value, e.g. opts(args, { n: true }) for `head -n 20` and `head -n20`.
   */
  function opts(args, valued) {
    valued = valued || {};
    var flags = {};
    var rest = [];

    for (var i = 0; i < args.length; i++) {
      var arg = args[i];
      if (arg === '--') { rest = rest.concat(args.slice(i + 1)); break; }
      if (arg.length < 2 || arg.charAt(0) !== '-') { rest.push(arg); continue; }

      if (arg.charAt(1) === '-') { flags[arg.slice(2)] = true; continue; }

      for (var j = 1; j < arg.length; j++) {
        var flag = arg.charAt(j);
        if (valued[flag]) {
          var value = arg.slice(j + 1);
          if (value === '') value = args[++i];
          if (value == null) throw shellError('option requires an argument -- ' + flag);
          flags[flag] = value;
          break;
        }
        flags[flag] = true;
      }
    }

    return { flags: flags, rest: rest };
  }

  /** Rewrite the legacy `head -20` form into `head -n 20`. */
  function numericCount(args) {
    return args.reduce(function (acc, arg) {
      var match = /^-(\d+)$/.exec(arg);
      if (match) return acc.concat(['-n', match[1]]);
      return acc.concat([arg]);
    }, []);
  }

  function lines(text) {
    if (text === '') return [];
    return text.replace(/\n$/, '').split('\n');
  }

  function readInput(ctx, cmd, operands, stdin) {
    if (operands.length) {
      return operands.map(function (path) {
        try {
          if (fs.isDirectory(path, ctx.cwd)) throw fsFail(cmd, path, { code: 'EISDIR' });
          return fs.readFile(path, ctx.cwd);
        } catch (e) {
          throw e.formatted ? e : fsFail(cmd, path, e);
        }
      }).join('');
    }
    return stdin || '';
  }

  /* ------------------------------------------------------------- commands */

  var COMMANDS = {};

  function define(name, desc, usage, run) {
    COMMANDS[name] = { name: name, desc: desc, usage: usage, run: run };
  }

  /* --- navigation & listing --- */

  define('pwd', 'Print the working directory', 'pwd', function (ctx) {
    return ctx.cwd;
  });

  define('cd', 'Change the working directory', 'cd [dir]', function (ctx, args) {
    var target = args[0] || ctx.env.HOME;
    if (target === '-') target = ctx.session.prevCwd || ctx.cwd;
    var abs;
    try {
      var stat = fs.stat(target, ctx.cwd);
      if (!stat.isDirectory) throw fsFail('cd', target, { code: 'ENOTDIR' });
      abs = stat.path;
    } catch (e) {
      throw e.formatted ? e : fsFail('cd', target, e);
    }
    ctx.session.prevCwd = ctx.cwd;
    ctx.session.setCwd(abs);
    return '';
  });

  function shortDate(ms) {
    var d = new Date(ms);
    var month = d.toLocaleDateString('en-US', { month: 'short' });
    var day = String(d.getDate()).padStart(2, ' ');
    var time = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    return month + ' ' + day + ' ' + time;
  }

  function entryClass(stat) {
    if (stat.isDirectory) return 'fx-dir';
    var kind = fs.kindOf(stat.name, false).kind;
    if (kind === 'code' || kind === 'markup') return 'fx-code';
    if (kind === 'image' || kind === 'video') return 'fx-media';
    if (kind === 'archive') return 'fx-archive';
    return '';
  }

  function entryHtml(stat, name) {
    var cls = entryClass(stat);
    var label = escHtml(name == null ? stat.name : name);
    return cls ? '<span class="' + cls + '">' + label + '</span>' : label;
  }

  define('ls', 'List directory contents', 'ls [-l] [-a] [-1] [path...]', function (ctx, args) {
    var parsed = opts(args, {});
    var showAll = parsed.flags.a || parsed.flags.all;
    var long = parsed.flags.l;
    var targets = parsed.rest.length ? parsed.rest : ['.'];
    var text = [];
    var html = [];

    targets.forEach(function (target, index) {
      var stat;
      try {
        stat = fs.stat(target, ctx.cwd);
      } catch (e) {
        throw fsFail('ls', target, e);
      }

      if (targets.length > 1) {
        if (index) { text.push(''); html.push(''); }
        text.push(target + ':');
        html.push(escHtml(target) + ':');
      }

      var entries = stat.isDirectory ? fs.list(stat.path) : [stat];
      if (!showAll) {
        entries = entries.filter(function (e) { return e.name.charAt(0) !== '.'; });
      }

      if (long) {
        entries.forEach(function (entry) {
          var size = entry.isDirectory
            ? entry.children + ' items'
            : fs.formatSize(entry.size);
          var meta = String(size).padStart(9) + '  ' + shortDate(entry.mtime) + '  ';
          text.push(meta + entry.name);
          html.push(escHtml(meta) + entryHtml(entry));
        });
        return;
      }

      // Columns are for a human reading the screen; a pipe wants one per line.
      if (parsed.flags['1'] || !ctx.tty || !entries.length) {
        entries.forEach(function (entry) {
          text.push(entry.name);
          html.push(entryHtml(entry));
        });
        return;
      }

      // Pad into columns so a wide directory stays readable.
      var width = entries.reduce(function (max, e) { return Math.max(max, e.name.length); }, 0) + 2;
      var perRow = Math.max(1, Math.floor(80 / width));
      for (var row = 0; row < entries.length; row += perRow) {
        var slice = entries.slice(row, row + perRow);
        text.push(slice.map(function (e) { return e.name.padEnd(width); }).join('').trimEnd());
        html.push(slice.map(function (e) {
          return entryHtml(e, e.name.padEnd(width));
        }).join('').replace(/\s+$/, ''));
      }
    });

    return { text: text.join('\n'), html: html.join('\n') };
  });

  define('tree', 'Show a directory tree', 'tree [path]', function (ctx, args) {
    var root;
    try {
      root = fs.stat(args[0] || '.', ctx.cwd);
    } catch (e) {
      throw fsFail('tree', args[0] || '.', e);
    }

    var text = [root.path];
    var html = [escHtml(root.path)];
    var dirs = 0;
    var files = 0;

    (function walk(path, prefix) {
      var entries;
      try { entries = fs.list(path); } catch (e) { return; }
      entries = entries.filter(function (e) { return e.name.charAt(0) !== '.'; });
      entries.forEach(function (entry, index) {
        var last = index === entries.length - 1;
        var branch = prefix + (last ? '└── ' : '├── ');
        text.push(branch + entry.name);
        html.push(escHtml(branch) + entryHtml(entry));
        if (entry.isDirectory) {
          dirs++;
          walk(entry.path, prefix + (last ? '    ' : '│   '));
        } else {
          files++;
        }
      });
    })(root.path, '');

    var summary = '\n' + dirs + ' director' + (dirs === 1 ? 'y' : 'ies') + ', ' +
      files + ' file' + (files === 1 ? '' : 's');
    return { text: text.join('\n') + summary, html: html.join('\n') + escHtml(summary) };
  });

  /* --- reading --- */

  define('cat', 'Print file contents', 'cat [file...]', function (ctx, args, stdin) {
    if (!args.length) return stdin || '';
    return args.map(function (path) {
      var stat;
      try { stat = fs.stat(path, ctx.cwd); } catch (e) { throw fsFail('cat', path, e); }
      if (stat.isDirectory) throw fsFail('cat', path, { code: 'EISDIR' });
      if (stat.binary) return 'cat: ' + path + ': binary file (' + fs.formatSize(stat.size) + ')\n';
      return fs.readFile(stat.path);
    }).join('');
  });

  COMMANDS.less = { name: 'less', desc: 'Print file contents', usage: 'less [file...]', run: COMMANDS.cat.run };
  COMMANDS.more = { name: 'more', desc: 'Print file contents', usage: 'more [file...]', run: COMMANDS.cat.run };

  define('head', 'Print the first lines of input', 'head [-n N] [file...]', function (ctx, args, stdin) {
    var parsed = opts(numericCount(args), { n: true });
    var count = parseInt(parsed.flags.n, 10) || 10;
    return lines(readInput(ctx, 'head', parsed.rest, stdin)).slice(0, count).join('\n');
  });

  define('tail', 'Print the last lines of input', 'tail [-n N] [file...]', function (ctx, args, stdin) {
    var parsed = opts(numericCount(args), { n: true });
    var count = parseInt(parsed.flags.n, 10) || 10;
    return lines(readInput(ctx, 'tail', parsed.rest, stdin)).slice(-count).join('\n');
  });

  define('wc', 'Count lines, words and characters', 'wc [-l] [-w] [-c] [file...]', function (ctx, args, stdin) {
    var parsed = opts(args, {});
    var text = readInput(ctx, 'wc', parsed.rest, stdin);
    var counts = {
      l: lines(text).length,
      w: text.split(/\s+/).filter(Boolean).length,
      c: text.length
    };
    var selected = ['l', 'w', 'c'].filter(function (key) { return parsed.flags[key]; });
    if (!selected.length) selected = ['l', 'w', 'c'];
    var out = selected.map(function (key) { return String(counts[key]).padStart(7); }).join('');
    return out + (parsed.rest.length === 1 ? ' ' + parsed.rest[0] : '');
  });

  define('grep', 'Search input for a pattern', 'grep [-i] [-v] [-n] pattern [file...]', function (ctx, args, stdin) {
    var parsed = opts(args, {});
    var pattern = parsed.rest.shift();
    if (pattern == null) throw shellError('usage: grep [-i] [-v] [-n] pattern [file...]');

    var re;
    try {
      re = new RegExp(pattern, parsed.flags.i ? 'i' : '');
    } catch (e) {
      throw shellError('grep: invalid pattern: ' + pattern);
    }

    var text = readInput(ctx, 'grep', parsed.rest, stdin);
    var out = [];
    var htmlOut = [];

    lines(text).forEach(function (line, index) {
      var hit = re.test(line);
      if (parsed.flags.v ? hit : !hit) return;
      var prefix = parsed.flags.n ? (index + 1) + ':' : '';
      out.push(prefix + line);
      htmlOut.push(escHtml(prefix) + (parsed.flags.v
        ? escHtml(line)
        : escHtml(line).replace(new RegExp(re.source, re.flags + 'g'), function (m) {
            return '<span class="fx-match">' + m + '</span>';
          })));
    });

    return { text: out.join('\n'), html: htmlOut.join('\n'), code: out.length ? 0 : 1 };
  });

  define('sort', 'Sort lines', 'sort [-r] [-u] [-n] [file...]', function (ctx, args, stdin) {
    var parsed = opts(args, {});
    var out = lines(readInput(ctx, 'sort', parsed.rest, stdin));
    out.sort(parsed.flags.n
      ? function (a, b) { return parseFloat(a) - parseFloat(b); }
      : function (a, b) { return a.localeCompare(b); });
    if (parsed.flags.r) out.reverse();
    if (parsed.flags.u) out = out.filter(function (line, i) { return i === 0 || line !== out[i - 1]; });
    return out.join('\n');
  });

  define('uniq', 'Drop adjacent duplicate lines', 'uniq [-c] [file...]', function (ctx, args, stdin) {
    var parsed = opts(args, {});
    var input = lines(readInput(ctx, 'uniq', parsed.rest, stdin));
    var out = [];
    input.forEach(function (line) {
      var last = out[out.length - 1];
      if (last && last.value === line) { last.count++; return; }
      out.push({ value: line, count: 1 });
    });
    return out.map(function (entry) {
      return parsed.flags.c ? String(entry.count).padStart(7) + ' ' + entry.value : entry.value;
    }).join('\n');
  });

  define('rev', 'Reverse each line', 'rev [file...]', function (ctx, args, stdin) {
    return lines(readInput(ctx, 'rev', args, stdin)).map(function (line) {
      return line.split('').reverse().join('');
    }).join('\n');
  });

  define('sed', 'Substitute text (s/pattern/replacement/[g])', 'sed s/pattern/replacement/[gi] [file...]', function (ctx, args, stdin) {
    var script = args.shift();
    var match = script && /^s(.)(.*)$/.exec(script);
    if (!match) throw shellError("sed: only s/pattern/replacement/ scripts are supported");

    var delim = match[1];
    var parts = match[2].split(delim);
    if (parts.length < 2) throw shellError('sed: unterminated `s\' command');

    var flags = (parts[2] || '').replace(/[^gi]/g, '');
    var re;
    try { re = new RegExp(parts[0], flags); } catch (e) { throw shellError('sed: invalid pattern'); }
    return lines(readInput(ctx, 'sed', args, stdin)).map(function (line) {
      return line.replace(re, parts[1]);
    }).join('\n');
  });

  define('echo', 'Print arguments', 'echo [-n] [text...]', function (ctx, args) {
    // Terminal output is line-based already, so -n only matters for redirection.
    var trailing = args[0] === '-n' ? (args = args.slice(1), '') : '\n';
    return { text: args.join(' '), trailingNewline: trailing };
  });

  /* --- writing --- */

  define('touch', 'Create empty files or update timestamps', 'touch file...', function (ctx, args) {
    if (!args.length) throw shellError('touch: missing file operand');
    args.forEach(function (path) {
      try { fs.touch(path, ctx.cwd); } catch (e) { throw fsFail('touch', path, e); }
    });
    return '';
  });

  define('mkdir', 'Create directories', 'mkdir [-p] dir...', function (ctx, args) {
    var parsed = opts(args, {});
    if (!parsed.rest.length) throw shellError('mkdir: missing operand');
    parsed.rest.forEach(function (path) {
      try {
        fs.mkdir(path, { recursive: !!(parsed.flags.p || parsed.flags.parents) }, ctx.cwd);
      } catch (e) {
        throw fsFail('mkdir', path, e);
      }
    });
    return '';
  });

  define('rmdir', 'Remove empty directories', 'rmdir dir...', function (ctx, args) {
    if (!args.length) throw shellError('rmdir: missing operand');
    args.forEach(function (path) {
      try { fs.rmdir(path, ctx.cwd); } catch (e) { throw fsFail('rmdir', path, e); }
    });
    return '';
  });

  define('rm', 'Remove files and directories', 'rm [-r] [-f] path...', function (ctx, args) {
    var parsed = opts(args, {});
    var recursive = !!(parsed.flags.r || parsed.flags.R || parsed.flags.recursive);
    var force = !!(parsed.flags.f || parsed.flags.force);
    if (!parsed.rest.length && !force) throw shellError('rm: missing operand');

    parsed.rest.forEach(function (path) {
      var abs = fs.normalize(path, ctx.cwd);
      if (abs === '/' || abs === ctx.env.HOME) {
        throw shellError("rm: refusing to remove '" + abs + "'");
      }
      try {
        fs.rm(abs, { recursive: recursive, force: force });
      } catch (e) {
        if (force) return;
        throw fsFail('rm', path, e);
      }
    });
    return '';
  });

  define('mv', 'Move or rename', 'mv source... dest', function (ctx, args) {
    if (args.length < 2) throw shellError('mv: missing destination file operand');
    var dest = args.pop();
    if (args.length > 1 && !fs.isDirectory(dest, ctx.cwd)) {
      throw shellError("mv: target '" + dest + "' is not a directory");
    }
    args.forEach(function (src) {
      try { fs.rename(src, dest, ctx.cwd); } catch (e) { throw fsFail('mv', src, e); }
    });
    return '';
  });

  define('cp', 'Copy files and directories', 'cp [-r] source... dest', function (ctx, args) {
    var parsed = opts(args, {});
    var recursive = !!(parsed.flags.r || parsed.flags.R || parsed.flags.recursive);
    if (parsed.rest.length < 2) throw shellError('cp: missing destination file operand');
    var dest = parsed.rest.pop();
    if (parsed.rest.length > 1 && !fs.isDirectory(dest, ctx.cwd)) {
      throw shellError("cp: target '" + dest + "' is not a directory");
    }
    parsed.rest.forEach(function (src) {
      try { fs.copy(src, dest, { recursive: recursive }, ctx.cwd); } catch (e) { throw fsFail('cp', src, e); }
    });
    return '';
  });

  /* --- inspection --- */

  define('stat', 'Show file metadata', 'stat path...', function (ctx, args) {
    if (!args.length) throw shellError('stat: missing operand');
    return args.map(function (path) {
      var stat;
      try { stat = fs.stat(path, ctx.cwd); } catch (e) { throw fsFail('stat', path, e); }
      return '    Path: ' + stat.path + '\n' +
        '    Type: ' + (stat.isDirectory ? 'directory' : (stat.binary ? 'binary file' : 'text file')) + '\n' +
        '    Size: ' + stat.size + ' bytes (' + fs.formatSize(stat.size) + ')\n' +
        'Modified: ' + fs.formatDate(stat.mtime);
    }).join('\n\n');
  });

  define('du', 'Show disk usage', 'du [-h] [path]', function (ctx, args) {
    var parsed = opts(args, {});
    var target = parsed.rest[0] || '.';
    var stat;
    try { stat = fs.stat(target, ctx.cwd); } catch (e) { throw fsFail('du', target, e); }

    var out = [];
    if (stat.isDirectory) {
      fs.list(stat.path).forEach(function (entry) {
        var size = fs.size(entry.path);
        out.push((parsed.flags.h ? fs.formatSize(size) : String(size)) + '\t' + entry.path);
      });
    }
    var total = fs.size(stat.path);
    out.push((parsed.flags.h ? fs.formatSize(total) : String(total)) + '\t' + stat.path);
    return out.join('\n');
  });

  define('df', 'Show how much storage the filesystem is using', 'df', function () {
    var used = fs.size('/');
    var out = ['Files:   ' + fs.formatSize(used) + ' across ' + fs.walk('/').length + ' entries'];
    // Reported by the browser, and covers more than just this filesystem.
    if (fs.storage.quota) {
      out.push('Browser: ' + fs.formatSize(fs.storage.usage) + ' of ' +
        fs.formatSize(fs.storage.quota) + ' available to this site');
    }
    return out.join('\n');
  });

  define('file', 'Describe a file type', 'file path...', function (ctx, args) {
    if (!args.length) throw shellError('file: missing operand');
    return args.map(function (path) {
      var stat;
      try { stat = fs.stat(path, ctx.cwd); } catch (e) { throw fsFail('file', path, e); }
      if (stat.isDirectory) return path + ': directory';
      if (stat.binary) return path + ': binary data (' + fs.formatSize(stat.size) + ')';
      var kind = fs.kindOf(stat.name, false).kind;
      var label = kind === 'plain' ? 'ASCII text' : kind + ' file, ASCII text';
      return path + ': ' + label;
    }).join('\n');
  });

  define('find', 'Search for files', 'find [path] [-name pattern] [-type f|d]', function (ctx, args) {
    var start = args.length && args[0].charAt(0) !== '-' ? args.shift() : '.';
    var name = null;
    var type = null;

    for (var i = 0; i < args.length; i++) {
      if (args[i] === '-name') name = args[++i];
      else if (args[i] === '-type') type = args[++i];
      else throw shellError('find: unknown predicate `' + args[i] + "'");
    }

    var root;
    try { root = fs.stat(start, ctx.cwd); } catch (e) { throw fsFail('find', start, e); }

    var re = name ? new RegExp('^' + name.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$') : null;

    var results = [root].concat(fs.walk(root.path)).filter(function (entry) {
      if (re && !re.test(entry.name)) return false;
      if (type === 'f' && !entry.isFile) return false;
      if (type === 'd' && !entry.isDirectory) return false;
      return true;
    });

    return {
      text: results.map(function (e) { return e.path; }).join('\n'),
      html: results.map(function (e) { return entryHtml(e, e.path); }).join('\n')
    };
  });

  define('which', 'Check whether a command exists', 'which name...', function (ctx, args) {
    var missing = false;
    var out = args.map(function (name) {
      if (COMMANDS[name]) return name + ': ' + COMMANDS[name].desc.toLowerCase();
      missing = true;
      return name + ': not found';
    });
    return { text: out.join('\n'), code: missing ? 1 : 0 };
  });

  define('basename', 'Strip directory from a path', 'basename path', function (ctx, args) {
    if (!args.length) throw shellError('basename: missing operand');
    return fs.basename(fs.normalize(args[0], ctx.cwd));
  });

  define('dirname', 'Strip the last component from a path', 'dirname path', function (ctx, args) {
    if (!args.length) throw shellError('dirname: missing operand');
    return fs.dirname(fs.normalize(args[0], ctx.cwd));
  });

  /* --- environment & session --- */

  define('env', 'Print the environment', 'env', function (ctx) {
    return Object.keys(ctx.env).sort().map(function (key) {
      return key + '=' + ctx.env[key];
    }).join('\n');
  });

  define('export', 'Set an environment variable', 'export NAME=value', function (ctx, args) {
    if (!args.length) return COMMANDS.env.run(ctx, []);
    args.forEach(function (arg) {
      var eq = arg.indexOf('=');
      if (eq === -1) return;
      ctx.env[arg.slice(0, eq)] = arg.slice(eq + 1);
    });
    return '';
  });

  define('unset', 'Remove an environment variable', 'unset NAME...', function (ctx, args) {
    args.forEach(function (name) { delete ctx.env[name]; });
    return '';
  });

  define('history', 'Show command history', 'history [-c]', function (ctx, args) {
    if (args[0] === '-c') { ctx.session.history.length = 0; return ''; }
    return ctx.session.history.map(function (entry, i) {
      return String(i + 1).padStart(5) + '  ' + entry;
    }).join('\n');
  });

  define('date', 'Print the current date and time', 'date', function () {
    return new Date().toString();
  });

  define('clear', 'Clear the screen', 'clear', function (ctx) {
    ctx.action({ type: 'clear' });
    return '';
  });

  COMMANDS.cls = { name: 'cls', desc: 'Clear the screen', usage: 'cls', run: COMMANDS.clear.run };

  define('exit', 'Close this terminal tab', 'exit', function (ctx) {
    ctx.action({ type: 'exit' });
    return '';
  });

  define('true', 'Do nothing, successfully', 'true', function () { return { text: '', code: 0 }; });
  define('false', 'Do nothing, unsuccessfully', 'false', function () { return { text: '', code: 1 }; });

  /* --- desktop integration --- */

  define('edit', 'Open a file in the editor', 'edit file', function (ctx, args) {
    if (!args.length) throw shellError('edit: missing file operand');
    var abs = fs.normalize(args[0], ctx.cwd);
    if (!fs.exists(abs)) fs.writeFile(abs, '');
    if (fs.isDirectory(abs)) throw fsFail('edit', args[0], { code: 'EISDIR' });
    ctx.action({ type: 'edit', path: abs });
    return 'Opening ' + abs + ' in Files…';
  });

  ['nano', 'vi', 'vim'].forEach(function (alias) {
    COMMANDS[alias] = { name: alias, desc: 'Open a file in the editor', usage: alias + ' file', run: COMMANDS.edit.run };
  });

  define('open', 'Open a path in the Files app', 'open [path]', function (ctx, args) {
    var abs = fs.normalize(args[0] || '.', ctx.cwd);
    var stat;
    try { stat = fs.stat(abs); } catch (e) { throw fsFail('open', args[0] || '.', e); }
    ctx.action(stat.isDirectory ? { type: 'open', path: abs } : { type: 'edit', path: abs });
    return 'Opening ' + abs + ' in Files…';
  });

  define('download', 'Download a file to your computer', 'download file', function (ctx, args) {
    if (!args.length) throw shellError('download: missing file operand');
    var stat;
    try { stat = fs.stat(args[0], ctx.cwd); } catch (e) { throw fsFail('download', args[0], e); }
    if (stat.isDirectory) throw fsFail('download', args[0], { code: 'EISDIR' });
    ctx.action({ type: 'download', path: stat.path });
    return 'Downloading ' + stat.name + '…';
  });

  define('ssh', 'Open a real SSH session on a remote host',
    'ssh [-p port] [-i identity] [user@]host', function (ctx, args) {
      if (!global.AxiomSSH) throw shellError('ssh: not available in this window');
      if (!args.length) throw shellError('ssh: usage: ssh [-p port] [-i identity] [user@]host');

      ctx.action({
        type: 'program',
        name: 'ssh',
        options: { argv: args, cwd: ctx.cwd }
      });
      return '';
    });

  define('claude', 'Start Mini Claude Code, an agent that can read and edit your files',
    'claude [-p prompt] [--model name]', function (ctx, args) {
      if (!global.AxiomClaude) throw shellError('claude: the agent is not loaded in this window');

      // `opts` only understands valued short flags, so --model is picked out first.
      var model = null;
      var rest = [];
      for (var i = 0; i < args.length; i++) {
        if (args[i] === '--model') { model = args[++i]; continue; }
        rest.push(args[i]);
      }
      if (model === undefined) throw shellError('claude: --model requires a name');

      var parsed = opts(rest, { p: true });
      var oneShot = typeof parsed.flags.p === 'string' ? parsed.flags.p : null;
      if (!oneShot && parsed.rest.length) oneShot = parsed.rest.join(' ');

      ctx.action({
        type: 'program',
        name: 'claude',
        options: { cwd: ctx.cwd, oneShot: oneShot, model: model }
      });
      return '';
    });

  define('js', 'Evaluate JavaScript', 'js <expression>', function (ctx, args) {
    var code = args.join(' ');
    if (!code) throw shellError('js: missing expression');

    var captured = [];
    var original = console.log;
    console.log = function () {
      original.apply(console, arguments);
      captured.push(Array.prototype.map.call(arguments, formatValue).join(' '));
    };

    try {
      var result = (0, eval)(code);
      if (result !== undefined) captured.push(formatValue(result));
    } catch (err) {
      throw shellError(String(err && err.stack ? err.stack : err));
    } finally {
      console.log = original;
    }

    return captured.join('\n');
  });

  function formatValue(value) {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'string') return value;
    if (typeof value === 'function') return value.toString();
    if (typeof value !== 'object') return String(value);
    try { return JSON.stringify(value, null, 2); } catch (e) { return String(value); }
  }

  /* --- running scripts from the filesystem --- */

  /**
   * console for a script: everything it prints is collected for the terminal
   * and mirrored to the devtools console, so async output isn't simply lost
   * once the command has already returned its text.
   */
  function scriptConsole(captured) {
    var real = global.console;
    var shim = {};
    ['log', 'info', 'debug', 'warn', 'error', 'trace', 'dir'].forEach(function (level) {
      shim[level] = function () {
        captured.push(Array.prototype.map.call(arguments, formatValue).join(' '));
        var sink = real[level] || real.log;
        if (sink) sink.apply(real, arguments);
      };
    });
    shim.table = shim.log;
    return shim;
  }

  /** `./lib`, `./lib.js`, `./lib/index.js` - relative and absolute paths only. */
  function resolveModule(spec, fromDir) {
    if (!/^[.\/]/.test(spec)) {
      throw shellError("Cannot find module '" + spec + "': only relative and absolute paths are supported");
    }
    var base = fs.normalize(spec, fromDir);
    var tries = [base, base + '.js', base + '.json', base + '/index.js'];
    for (var i = 0; i < tries.length; i++) {
      if (fs.exists(tries[i]) && !fs.isDirectory(tries[i])) return tries[i];
    }
    throw shellError("Cannot find module '" + spec + "'");
  }

  /**
   * Evaluate `source` as a CommonJS module. Scripts get `console`, `argv`,
   * `stdin`, `require`, `module`/`exports` and `__filename`/`__dirname`;
   * everything else - AxiomFS, fetch, the DOM - is just the page's globals.
   */
  function evalModule(source, filename, scope, cache) {
    var dir = fs.dirname(filename);
    var body = String(source).replace(/^#![^\n]*/, '');
    var module = { id: filename, filename: filename, exports: {} };
    cache[filename] = module;

    function require(spec) {
      var path = resolveModule(spec, dir);
      if (cache[path]) return cache[path].exports;
      if (/\.json$/.test(path)) {
        var mod = { id: path, filename: path, exports: null };
        try {
          mod.exports = JSON.parse(fs.readFile(path));
        } catch (e) {
          throw shellError(path + ': ' + e.message);
        }
        cache[path] = mod;
        return mod.exports;
      }
      return evalModule(fs.readFile(path), path, scope, cache);
    }
    require.resolve = function (spec) { return resolveModule(spec, dir); };
    require.cache = cache;

    var fn;
    try {
      fn = new Function('exports', 'require', 'module', '__filename', '__dirname',
        'console', 'argv', 'stdin', body);
    } catch (e) {
      delete cache[filename];
      throw shellError(filename + ': ' + e.message);
    }

    fn.call(module.exports, module.exports, require, module, filename, dir,
      scope.console, scope.argv, scope.stdin);
    return module.exports;
  }

  /**
   * Run a script and turn it into command output. Only synchronous output is
   * captured; a script that keeps working after it returns (timers, promises)
   * carries on printing to the browser console.
   */
  function runScript(source, filename, scriptArgs, stdin) {
    var captured = [];
    var scope = {
      console: scriptConsole(captured),
      argv: ['node', filename].concat(scriptArgs || []),
      stdin: stdin || ''
    };

    try {
      evalModule(source, filename, scope, {});
    } catch (err) {
      if (err && err.formatted) {
        throw shellError((captured.length ? captured.join('\n') + '\n' : '') + err.message);
      }
      var detail = err && err.stack ? String(err.stack).split('\n')[0] : String(err);
      throw shellError((captured.length ? captured.join('\n') + '\n' : '') + detail);
    }

    return captured.join('\n');
  }

  define('node', 'Run a JavaScript file from the filesystem',
    'node [-e code] [file.js] [args...]', function (ctx, args, stdin) {
      if (args[0] === '-e' || args[0] === '--eval') {
        var code = args.slice(1).join(' ');
        if (!code) throw shellError('node: -e requires code');
        return runScript(code, fs.join(ctx.cwd, '[eval]'), [], stdin);
      }

      if (!args.length) throw shellError('node: missing file operand (try `node -e "code"`)');

      var stat;
      try { stat = fs.stat(args[0], ctx.cwd); } catch (e) { throw fsFail('node', args[0], e); }
      if (stat.isDirectory) throw fsFail('node', args[0], { code: 'EISDIR' });
      if (stat.binary) throw shellError('node: ' + args[0] + ': not a text file');

      return runScript(fs.readFile(stat.path), stat.path, args.slice(1), stdin);
    });

  ['run', 'nodejs'].forEach(function (alias) {
    COMMANDS[alias] = {
      name: alias,
      desc: 'Run a JavaScript file from the filesystem',
      usage: alias + ' file.js [args...]',
      run: COMMANDS.node.run
    };
  });

  define('fsreset', 'Erase the filesystem and reload the defaults', 'fsreset --yes', function (ctx, args) {
    if (args[0] !== '--yes') {
      return 'This erases every file you have created.\nRun `fsreset --yes` to confirm.';
    }
    ctx.session.setCwd('/');
    fs.reset().then(function () {
      ctx.session.setCwd(fs.exists(ctx.env.HOME) ? ctx.env.HOME : '/');
    });
    return 'Restoring defaults…';
  });

  define('help', 'List available commands', 'help [command]', function (ctx, args) {
    if (args.length) return COMMANDS.man.run(ctx, args);

    var names = Object.keys(COMMANDS).sort();
    var width = names.reduce(function (max, n) { return Math.max(max, n.length); }, 0) + 2;
    var body = names.map(function (name) {
      return '  ' + name.padEnd(width) + COMMANDS[name].desc;
    });
    var htmlBody = names.map(function (name) {
      return '  <span class="fx-cmd">' + escHtml(name.padEnd(width)) + '</span>' + escHtml(COMMANDS[name].desc);
    });

    var footer = '\nPipes (|), redirection (>, >>, <) and chaining (;, &&, ||) all work.\n' +
      'Run `man <command>` for usage. Tab completes commands and paths.';

    return { text: body.join('\n') + '\n' + footer, html: htmlBody.join('\n') + '\n' + escHtml(footer) };
  });

  define('man', 'Show usage for a command', 'man command', function (ctx, args) {
    if (!args.length) throw shellError('What manual page do you want?');
    var cmd = COMMANDS[args[0]];
    if (!cmd) throw shellError('No manual entry for ' + args[0]);
    return cmd.name.toUpperCase() + '\n\n  ' + cmd.desc + '\n\nUSAGE\n\n  ' + cmd.usage;
  });

  /* -------------------------------------------------------------- session */

  function createSession(options) {
    options = options || {};

    var session = {
      cwd: fs.exists(fs.HOME) ? fs.HOME : '/',
      prevCwd: null,
      history: [],
      env: {
        HOME: fs.HOME,
        PWD: fs.HOME,
        EDITOR: 'edit',
        '?': '0'
      }
    };

    session.setCwd = function (path) {
      session.cwd = path;
      session.env.PWD = path;
      if (options.onCwdChange) options.onCwdChange(path);
    };

    /** `~/Projects` rather than `/home/user/Projects`, as a prompt would show. */
    session.shortCwd = function () {
      if (session.cwd === session.env.HOME) return '~';
      if (session.cwd.indexOf(session.env.HOME + '/') === 0) {
        return '~' + session.cwd.slice(session.env.HOME.length);
      }
      return session.cwd;
    };

    function makeContext(actions) {
      var ctx = {
        session: session,
        env: session.env,
        // True when output lands on the screen rather than a pipe or a file,
        // so commands can format for a reader.
        tty: true,
        get cwd() { return session.cwd; },
        action: function (a) { actions.push(a); }
      };
      return ctx;
    }

    function runCommand(ctx, argv, stdin) {
      var name = argv[0];
      var cmd = COMMANDS[name];

      // `./build.js` and friends run themselves, the way an executable would.
      if (!cmd && /\.[cm]?js$/.test(name) && fs.exists(name, session.cwd)) {
        cmd = COMMANDS.node;
        argv = argv.slice();
        argv.unshift('node');
      }

      if (!cmd) throw shellError(name + ': command not found');

      var result = cmd.run(ctx, argv.slice(1), stdin);
      if (result == null) result = '';
      if (typeof result === 'string') return { text: result, code: 0 };
      return {
        text: result.text == null ? '' : result.text,
        html: result.html,
        code: result.code == null ? 0 : result.code,
        before: result.before,
        trailingNewline: result.trailingNewline
      };
    }

    /** Expand variables, then globs; a pattern matching nothing stays literal. */
    function expand(argv) {
      var out = [];
      argv.forEach(function (tok) {
        var value = materialize(tok, session.env);
        if (!tok.glob) { out.push(value); return; }
        var matches = fs.glob(value, session.cwd);
        if (!matches.length) { out.push(value); return; }
        // Keep matches relative when the pattern was, so `rm *.txt` reads right.
        var relative = value.charAt(0) !== '/' && value.charAt(0) !== '~';
        var base = session.cwd === '/' ? '/' : session.cwd + '/';
        matches.forEach(function (abs) {
          out.push(relative && abs.indexOf(base) === 0 ? abs.slice(base.length) : abs);
        });
      });
      return out;
    }

    session.run = function (line) {
      var output = [];
      var actions = [];
      var code = 0;

      function write(text, cls, html) {
        if (text === '' && !html) return;
        output.push({ text: text, cls: cls, html: html });
      }

      var segments;
      try {
        segments = parse(tokenize(line));
      } catch (err) {
        write(err.message, 'term-error');
        session.env['?'] = '2';
        return { output: output, actions: actions, code: 2 };
      }

      for (var s = 0; s < segments.length; s++) {
        var segment = segments[s];
        if (segment.joiner === '&&' && code !== 0) continue;
        if (segment.joiner === '||' && code === 0) continue;

        var ctx = makeContext(actions);
        var stdin = '';
        var result = null;
        var failed = false;

        for (var p = 0; p < segment.pipeline.length; p++) {
          var command = segment.pipeline[p];
          var argv = expand(command.argv);
          var last = p === segment.pipeline.length - 1;

          if (command.redirects.in != null) {
            var inPath = materialize(command.redirects.in, session.env);
            try {
              stdin = fs.readFile(inPath, session.cwd);
            } catch (e) {
              write('shell: ' + inPath + ': ' + (ERRNO[e.code] || e.message), 'term-error');
              failed = true;
              code = 1;
              break;
            }
          }

          if (!argv.length) { result = { text: stdin, code: 0 }; continue; }

          ctx.tty = last && command.redirects.out == null;

          try {
            result = runCommand(ctx, argv, stdin);
          } catch (err) {
            write(err.formatted ? err.message : argv[0] + ': ' + err.message, 'term-error');
            failed = true;
            code = 1;
            break;
          }

          if (result.before) write(result.before, 'term-warn');
          code = result.code;
          stdin = result.text;

          if (!last) continue;

          if (command.redirects.out != null) {
            var outPath = materialize(command.redirects.out, session.env);
            var payload = result.trailingNewline === '' ? result.text : addNewline(result.text);
            try {
              if (command.redirects.append) fs.appendFile(outPath, payload, session.cwd);
              else fs.writeFile(outPath, payload, null, session.cwd);
            } catch (e) {
              write('shell: ' + outPath + ': ' + (ERRNO[e.code] || e.message), 'term-error');
              code = 1;
            }
          } else if (result.text !== '' || result.html) {
            write(result.text, null, result.html);
          }
        }

        if (failed) continue;
      }

      session.env['?'] = String(code);
      return { output: output, actions: actions, code: code };
    };

    /**
     * Tab completion. Returns the replacement for the final word plus every
     * candidate, so the caller can print them when the choice is ambiguous.
     */
    session.complete = function (input) {
      var match = /(\S*)$/.exec(input);
      var word = match[1];
      var isCommand = input.slice(0, input.length - word.length).trim() === '' ||
        /(\||&&|\|\||;)\s*\S*$/.test(input);

      var candidates;
      var replaceFrom = word;

      if (isCommand && word.indexOf('/') === -1) {
        candidates = Object.keys(COMMANDS).filter(function (name) {
          return name.indexOf(word) === 0;
        }).sort();
      } else {
        var slash = word.lastIndexOf('/');
        var dirPart = slash === -1 ? '.' : (word.slice(0, slash) || '/');
        var namePart = word.slice(slash + 1);
        replaceFrom = namePart;
        try {
          candidates = fs.list(dirPart, session.cwd)
            .filter(function (entry) {
              if (entry.name.indexOf(namePart) !== 0) return false;
              return namePart.charAt(0) === '.' || entry.name.charAt(0) !== '.';
            })
            .map(function (entry) { return entry.name + (entry.isDirectory ? '/' : ''); });
        } catch (e) {
          candidates = [];
        }
      }

      if (!candidates.length) return null;

      var common = candidates.reduce(function (prefix, candidate) {
        var i = 0;
        while (i < prefix.length && i < candidate.length && prefix.charAt(i) === candidate.charAt(i)) i++;
        return prefix.slice(0, i);
      });

      return {
        // What to append to the current input to reach the common prefix.
        insert: common.slice(replaceFrom.length),
        candidates: candidates,
        exact: candidates.length === 1
      };
    };

    return session;
  }

  function addNewline(text) {
    return text === '' || text.charAt(text.length - 1) === '\n' ? text : text + '\n';
  }

  global.AxiomShell = {
    createSession: createSession,
    commands: COMMANDS,
    escHtml: escHtml
  };
})(window);

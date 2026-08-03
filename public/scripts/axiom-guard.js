/* Axiom Defender protects desktop autorun scripts before they execute. */
(function (global) {
    'use strict';

    var QUARANTINE_DIR = '/home/user/Quarantine';
    var LOG_FILE = QUARANTINE_DIR + '/defender.log';
    var events = [];
    var suspicious = [
        [/window\.open\s*\(/, 'opens a popup or redirect'],
        [/location\.(href|assign|replace)\s*=/, 'redirects the page'],
        [/<iframe/i, 'injects a frame'],
        [/new\s+Image\s*\(\s*\)\s*[;.\s]*src\s*=/, 'uses an image beacon'],
        [/\bfetch\s*\(/, 'uses a network request'],
        [/XMLHttpRequest|new\s+WebSocket|sendBeacon/, 'uses a network channel'],
        [/postMessage\s*\(/, 'uses cross-window messaging'],
        [/\bos\.(eval|openWindow|focusWindow|closeWindow)\b/, 'controls the desktop'],
        [/AxiomShell\b/, 'controls the shell'],
        [/(localStorage|sessionStorage|document\.cookie)/, 'accesses stored data'],
        [/(addEventListener|onkeydown|onkeyup|onkeypress)\s*\(?['"]?key/, 'uses keyboard input'],
        [/\.bashrc/, 'changes shell configuration'],
        [/\/(bin|etc|usr|var)\//, 'targets system directories'],
        [/axiom_(claude_key|claude_model|premium_key|theme)/, 'accesses Axiom settings'],
        [/\beval\s*\(/, 'evaluates runtime code'],
        [/\bnew\s+Function\s*\(/, 'constructs runtime code'],
        [/document\.(write|execCommand)\s*\(/, 'writes directly to the page']
    ];

    function notify() {
        global.dispatchEvent(new CustomEvent('axiom-guard-change'));
    }

    function record(type, path, detail) {
        var entry = { type: type, path: path || '', detail: detail || '', time: Date.now() };
        events.unshift(entry);
        if (events.length > 100) events.length = 100;
        console.info('[Axiom Defender]', type, path || '', detail || '');
        notify();
        return entry;
    }

    function appendLog(entry) {
        try {
            if (!global.AxiomFS.exists(QUARANTINE_DIR)) global.AxiomFS.mkdir(QUARANTINE_DIR, { recursive: true });
            global.AxiomFS.appendFile(LOG_FILE, '[' + new Date(entry.time).toLocaleString() + '] ' + entry.type + ' ' + entry.path + ' ' + entry.detail + '\n');
        } catch (e) { /* logging is best-effort */ }
    }

    function scanCode(code) {
        if (typeof code !== 'string') return [];
        return suspicious.filter(function (rule) { return rule[0].test(code); }).map(function (rule) { return rule[1]; });
    }

    function quarantine(path, code, hits) {
        try {
            var fs = global.AxiomFS;
            if (!fs.exists(QUARANTINE_DIR)) fs.mkdir(QUARANTINE_DIR, { recursive: true });
            var stem = fs.basename(path).replace(/\.auto\.js$/i, '');
            var destination = QUARANTINE_DIR + '/' + stem + '.quarantine';
            var number = 1;
            while (fs.exists(destination)) destination = QUARANTINE_DIR + '/' + stem + '_' + number++ + '.quarantine';
            var preview = typeof code === 'string' ? code.slice(0, 160) : '';
            fs.writeFile(destination,
                '// Quarantined by Axiom Defender on ' + new Date().toLocaleString() + '\n' +
                '// Source: ' + path + '\n// Flags: ' + hits.join('; ') + '\n//\n' + preview);
            fs.writeFile(path, '// Blocked by Axiom Defender\n');
            try { global.autoRanPaths.delete(path); } catch (e) {}
            var entry = record('Quarantined', path, hits.join('; '));
            appendLog(entry);
            return true;
        } catch (e) {
            var failure = record('Error', path, 'Could not quarantine: ' + e.message);
            appendLog(failure);
            return false;
        }
    }

    function inspect(path, code) {
        var hits = scanCode(code);
        if (!hits.length) return { allowed: true, hits: [] };
        quarantine(path, code, hits);
        return { allowed: false, hits: hits };
    }

    function scan() {
        var checked = 0;
        var blocked = 0;
        try {
            global.AxiomFS.walk('/').forEach(function (entry) {
                if (!entry.isFile || !/\.auto\.js$/i.test(entry.path)) return;
                checked++;
                var code = global.AxiomFS.readFile(entry.path);
                if (!inspect(entry.path, code).allowed) blocked++;
            });
        } catch (e) {
            var failure = record('Error', '', 'Could not scan: ' + e.message);
            appendLog(failure);
        }
        var entry = record('Scan complete', '', checked + ' script' + (checked === 1 ? '' : 's') + ' checked, ' + blocked + ' blocked');
        appendLog(entry);
        return { checked: checked, blocked: blocked };
    }

    function installHook() {
        var original = global.runAutoScript;
        if (typeof original !== 'function' || original.__axiomDefender) return;
        function guardedRun(path, code) {
            var result = inspect(path, code);
            if (!result.allowed) return;
            return original(path, code);
        }
        guardedRun.__axiomDefender = true;
        global.runAutoScript = guardedRun;
        record('Protection active', '', 'Autorun scripts are checked before they run');
    }

    global.AxiomGuard = {
        scan: scan,
        getEvents: function () { return events.slice(); },
        getQuarantine: function () {
            try { return global.AxiomFS.glob(QUARANTINE_DIR + '/*.quarantine'); } catch (e) { return []; }
        }
    };

    installHook();
    global.AxiomFS.ready.then(function () { scan(); });
})(window);

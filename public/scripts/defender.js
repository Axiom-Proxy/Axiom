(function () {
    'use strict';
    var guard = window.parent && window.parent.AxiomGuard;
    var activity = document.getElementById('activity-list');
    var activitySummary = document.getElementById('activity-summary');
    var quarantined = document.getElementById('quarantine-list');
    var quarantineSummary = document.getElementById('quarantine-summary');

    function empty(parent, message) {
        parent.replaceChildren();
        var item = document.createElement('p');
        item.className = 'defender-empty';
        item.textContent = message;
        parent.appendChild(item);
    }

    function render() {
        if (!guard) { empty(activity, 'Defender is unavailable.'); return; }
        var events = guard.getEvents();
        var files = guard.getQuarantine();
        activitySummary.textContent = events.length ? events.length + ' recent event' + (events.length === 1 ? '' : 's') : 'No recent activity';
        quarantineSummary.textContent = files.length ? files.length + ' item' + (files.length === 1 ? '' : 's') + ' quarantined' : 'No quarantined items';
        activity.replaceChildren();
        if (!events.length) empty(activity, 'No activity yet.');
        events.slice(0, 8).forEach(function (event) {
            var row = document.createElement('div');
            row.className = 'activity-row' + (event.type === 'Quarantined' || event.type === 'Error' ? ' warning' : '');
            row.innerHTML = '<span class="material-symbols-outlined">' + (event.type === 'Quarantined' ? 'block' : event.type === 'Error' ? 'error' : 'verified') + '</span>';
            var text = document.createElement('div');
            var title = document.createElement('strong'); title.textContent = event.type;
            var detail = document.createElement('p'); detail.textContent = [event.path, event.detail].filter(Boolean).join(' - ');
            text.append(title, detail); row.appendChild(text); activity.appendChild(row);
        });
        quarantined.replaceChildren();
        if (!files.length) empty(quarantined, 'Nothing is quarantined.');
        files.forEach(function (path) {
            var row = document.createElement('div'); row.className = 'quarantine-row';
            row.innerHTML = '<span class="material-symbols-outlined">folder_off</span>';
            var name = document.createElement('span'); name.textContent = path.split('/').pop();
            row.appendChild(name); quarantined.appendChild(row);
        });
    }

    document.getElementById('scan-button').addEventListener('click', function () { if (guard) { guard.scan(); render(); } });
    if (window.parent) window.parent.addEventListener('axiom-guard-change', render);
    render();
})();

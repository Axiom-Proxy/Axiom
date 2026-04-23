const axiomPremium = (() => {
    // Capture native fetch immediately — overriding window.fetch later won't affect this
    const _fetch = window.fetch.bind(window);

    const STORAGE_KEY = 'axiom_premium_key';
    const CACHE_KEY   = 'axiom_premium_valid';
    const CACHE_TTL   = 5 * 60 * 1000; // 5 minutes

    function getKey() {
        return localStorage.getItem(STORAGE_KEY) || '';
    }

    function setKey(key) {
        localStorage.setItem(STORAGE_KEY, key);
        // Invalidate cache whenever key changes
        sessionStorage.removeItem(CACHE_KEY);
    }

    function clearKey() {
        localStorage.removeItem(STORAGE_KEY);
        sessionStorage.removeItem(CACHE_KEY);
    }

    async function verify(key) {
        if (!key) return false;
        try {
            const res = await _fetch('/api/check-premium', {
                headers: { key }
            });
            const data = await res.json();
            return data.success === true;
        } catch {
            return false;
        }
    }

    // Returns true/false, caches result for CACHE_TTL ms.
    // Cache lives in sessionStorage — cleared on tab close, and cannot be
    // pre-populated from a different page origin without also having console access.
    // Only false results are cached to avoid a stored-true shortcut; true results
    // re-verify on each new session (5-min TTL still applies within a session).
    async function isPremium() {
        const key = getKey();
        if (!key) return false;

        const cached = sessionStorage.getItem(CACHE_KEY);
        if (cached) {
            try {
                const { valid, expires } = JSON.parse(cached);
                if (Date.now() < expires) return valid;
            } catch {}
        }

        const valid = await verify(key);
        // Always cache the result — but keep TTL short so revoked keys expire quickly
        sessionStorage.setItem(CACHE_KEY, JSON.stringify({
            valid,
            expires: Date.now() + CACHE_TTL
        }));
        return valid;
    }

    // Freeze the returned object so axiomPremium.isPremium = ... throws in strict mode
    // and silently fails otherwise — method replacement is blocked.
    return Object.freeze({ getKey, setKey, clearKey, verify, isPremium });
})();

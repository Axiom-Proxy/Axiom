// Obfuscated helper functions
const _enc = (str) => btoa(str.split('').reverse().join('').slice(0, 8) + Math.random().toString(36).substr(2, 5));
const _dec = (str) => atob(str.slice(0, -5)).split('').reverse().join('');
const _hash = (key) => {
    let h = 0;
    for (let i = 0; i < key.length; i++) {
        h = ((h << 5) - h) + key.charCodeAt(i);
        h = h & h;
    }
    return h.toString(16);
};

window.premium = {
    _cache: { valid: false, timestamp: 0 },
    _cacheExpiry: 5 * 60 * 1000, // 5 minutes

    check: async function() {
        const key = localStorage.getItem("axiomPremiumKey");

        if (!key) {
            this._cache.valid = false;
            return false;
        }
        const response = await fetch("../api/check-premium", {
            method: "GET",
            headers: {
                "key": key
            }
        });
        const data = await response.json();
        const isValid = data.success === true;
        this._cache.valid = isValid;
        this._cache.timestamp = Date.now();
        if (isValid) {
            localStorage.setItem("axiomPremiumHash", _hash(key));
        }
        return isValid;
    },

    checkSync: function() {
        const key = localStorage.getItem("axiomPremiumKey");
        const storedHash = localStorage.getItem("axiomPremiumHash");
        if (!key || !storedHash) return false;

        // Validate hash
        if (_hash(key) !== storedHash) {
            localStorage.removeItem("axiomPremiumHash");
            return false;
        }

        // Check cache if recent
        if (Date.now() - this._cache.timestamp < this._cacheExpiry) {
            return this._cache.valid;
        }

        // Periodic revalidation (random chance)
        if (Math.random() < 0.1) {
            this.check().then(valid => {
                if (!valid) {
                    localStorage.removeItem("axiomPremiumHash");
                }
            });
        }

        return true;
    },

    register: async function(key) {
        localStorage.setItem("axiomPremiumKey", key);
        const isValid = await this.check();
        if (isValid) {
            localStorage.setItem("axiomPremiumHash", _hash(key));
            return true;
        }
        localStorage.removeItem("axiomPremiumHash");
        return false;
    },

    tabs: {
        save: function(sessionName) {
            if (!window.premium.checkSync()) {
                console.warn("Tab saving requires premium");
                return false;
            }

            const tabs = document.querySelectorAll("#tabs2 .tab");
            const tabData = [];

            tabs.forEach(tab => {
                const frame = document.getElementById(tab.id + "-frame");
                if (frame) {
                    const title = frame.contentDocument?.title || "New Tab";
                    const src = frame.src || "start.html";
                    tabData.push({
                        id: tab.id,
                        title: title.split("|A|")[0],
                        url: src
                    });
                }
            });

            const sessions = JSON.parse(localStorage.getItem("axiomTabSessions") || "{}");
            sessions[sessionName] = {
                tabs: tabData,
                savedAt: new Date().toISOString()
            };
            localStorage.setItem("axiomTabSessions", JSON.stringify(sessions));
            return true;
        },

        restore: function(sessionName) {
            if (!window.premium.checkSync()) {
                console.warn("Tab restore requires premium");
                return false;
            }

            const sessions = JSON.parse(localStorage.getItem("axiomTabSessions") || "{}");
            const session = sessions[sessionName];

            if (!session) {
                console.warn("Session not found:", sessionName);
                return false;
            }

            const existingTabs = document.querySelectorAll("#tabs2 .tab");
            existingTabs.forEach(tab => {
                if (typeof removeTab === "function") {
                    removeTab(tab.id);
                }
            });

            session.tabs.forEach(tabInfo => {
                if (typeof createTab === "function") {
                    createTab(tabInfo.title, tabInfo.url);
                }
            });

            return true;
        },

        getSessions: function() {
            const sessions = JSON.parse(localStorage.getItem("axiomTabSessions") || "{}");
            return Object.keys(sessions).map(name => ({
                name: name,
                tabCount: sessions[name].tabs.length,
                savedAt: sessions[name].savedAt
            }));
        },

        deleteSession: function(sessionName) {
            const sessions = JSON.parse(localStorage.getItem("axiomTabSessions") || "{}");
            delete sessions[sessionName];
            localStorage.setItem("axiomTabSessions", JSON.stringify(sessions));
            return true;
        }
    },

    wallpaper: {
        set: function(imageDataUrl) {
            if (!window.premium.checkSync()) {
                console.warn("Custom wallpapers require premium");
                return false;
            }

            localStorage.setItem("axiomCustomWallpaper", imageDataUrl);
            localStorage.setItem("axiomUseCustomWallpaper", "true");
            this.apply();
            return true;
        },

        apply: function() {
            const useCustom = localStorage.getItem("axiomUseCustomWallpaper") === "true";
            const customWallpaper = localStorage.getItem("axiomCustomWallpaper");

            if (useCustom && customWallpaper && window === window.top) {
                document.body.style.backgroundImage = `url('${customWallpaper}')`;
                document.body.style.backgroundSize = 'cover';
                document.body.style.backgroundPosition = 'center';
                document.body.style.backgroundRepeat = 'no-repeat';
                return true;
            }
            return false;
        },

        clear: function() {
            localStorage.removeItem("axiomCustomWallpaper");
            localStorage.removeItem("axiomUseCustomWallpaper");
            if (window.themeManager) {
                window.themeManager.applyTheme();
            }
            return true;
        },

        hasCustom: function() {
            return localStorage.getItem("axiomUseCustomWallpaper") === "true" &&
                   localStorage.getItem("axiomCustomWallpaper") !== null;
        },

        upload: function(file) {
            return new Promise((resolve, reject) => {
                if (!window.premium.checkSync()) {
                    reject("Custom wallpapers require premium");
                    return;
                }

                if (!file.type.startsWith("image/")) {
                    reject("File must be an image");
                    return;
                }

                if (file.size > 5 * 1024 * 1024) {
                    reject("Image must be under 5MB");
                    return;
                }

                const reader = new FileReader();
                reader.onload = (e) => {
                    const dataUrl = e.target.result;
                    this.set(dataUrl);
                    resolve(dataUrl);
                };
                reader.onerror = () => reject("Failed to read file");
                reader.readAsDataURL(file);
            });
        }
    },

    isThemePremium: function(themeName) {
        if (!window.themeManager || !window.themeManager.themes) {
            return false;
        }
        const theme = window.themeManager.themes[themeName];
        return theme && theme.premium === true;
    },

    canUseTheme: function(themeName) {
        if (!this.isThemePremium(themeName)) {
            return true;
        }
        return this.checkSync();
    }
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        if (window.premium.wallpaper.hasCustom() && window.premium.checkSync()) {
            window.premium.wallpaper.apply();
        }
    });
} else {
    if (window.premium.wallpaper.hasCustom() && window.premium.checkSync()) {
        window.premium.wallpaper.apply();
    }
}

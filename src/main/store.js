'use strict';

/**
 * Tiny atomic JSON store kept in the Electron userData folder.
 * Used for settings, custom presets, recent items and window bounds.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  version: 3,
  window: { width: 1360, height: 860, x: null, y: null, maximized: false },
  settings: {
    lastPresetId: 'balanced',
    volume: 1,
    muted: false,
    renderScale: 'auto', // 'auto' | 1 | 1.5 | 2 | 3 | 4
    targetFps: 60,
    adaptiveQuality: true,
    showStats: false,
    autoplay: true,
    rememberPosition: true,
    // 0 means "let the stream policy decide from the display and hardware".
    maxStreamHeight: 0,
    watchQuality: 'auto',
    /**
     * How Visionance authenticates to a site, when - and only when - the site
     * says authentication is required. `none` means public access only, and it
     * is the default: reading a browser's cookie jar is reading a credential
     * store, so it never happens without an explicit choice here.
     */
    auth: {
      mode: 'none',       // 'none' | 'browser' | 'file'
      browser: '',        // chrome | edge | firefox | brave | safari | ...
      cookiesFile: ''
    },
    binaries: { ffmpeg: '', ffprobe: '', ytdlp: '' },
    exportDir: '',
    create: {
      lastPlatform: 'custom',
      lastQuality: 70,
      chunkedRenders: false
    }
  },
  presets: {},        // user-defined Watch looks, keyed by id
  userRecipes: {},    // saved Create recipes, keyed by id
  recents: [],        // { source, kind, title, at, position, duration }
  resume: {}          // sourceKey -> seconds
};

class Store {
  constructor(fileName = 'visionance.json') {
    this.file = path.join(app.getPath('userData'), fileName);
    this.data = this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      return migrate(deepMerge(structuredClone(DEFAULTS), parsed));
    } catch {
      return structuredClone(DEFAULTS);
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
      return true;
    } catch (err) {
      console.error('[store] save failed:', err.message);
      return false;
    }
  }

  get(key) {
    return key ? this.data[key] : this.data;
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
    return value;
  }

  patchSettings(partial) {
    this.data.settings = deepMerge(this.data.settings, partial || {});
    this.save();
    return this.data.settings;
  }

  addRecent(entry) {
    const key = entry.source;
    const list = this.data.recents.filter((r) => r.source !== key);
    list.unshift({ ...entry, at: Date.now() });
    this.data.recents = list.slice(0, 24);
    this.save();
    return this.data.recents;
  }

  removeRecent(source) {
    this.data.recents = this.data.recents.filter((r) => r.source !== source);
    this.save();
    return this.data.recents;
  }

  clearRecents() {
    this.data.recents = [];
    this.save();
    return this.data.recents;
  }

  setResume(sourceKey, seconds) {
    if (!sourceKey) return;
    if (!seconds || seconds < 15) delete this.data.resume[sourceKey];
    else this.data.resume[sourceKey] = seconds;
    // Keep the resume map from growing without bound.
    const keys = Object.keys(this.data.resume);
    if (keys.length > 300) delete this.data.resume[keys[0]];
    this.save();
  }

  getResume(sourceKey) {
    return this.data.resume[sourceKey] || 0;
  }
}

/**
 * Upgrade older on-disk shapes.
 * v2 stored `cookiesFromBrowser` and used it on *every* request. v3 keeps the
 * user's browser choice but moves it behind the authentication policy, which
 * only reaches for cookies when a site actually demands a signed-in account.
 */
function migrate(data) {
  const s = data.settings || {};
  if (s.cookiesFromBrowser && (!s.auth || s.auth.mode === 'none')) {
    s.auth = { mode: 'browser', browser: String(s.cookiesFromBrowser), cookiesFile: '' };
  }
  delete s.cookiesFromBrowser;
  delete s.ytdlpFormat; // never read; format choice is made in ytdlp.js
  data.version = DEFAULTS.version;
  return data;
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return base;
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

module.exports = { Store, DEFAULTS };

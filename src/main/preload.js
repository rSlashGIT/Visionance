'use strict';

/**
 * The only bridge between the renderer and Node. Everything is an explicit,
 * named method - no raw ipcRenderer, no `require`, no Node globals leak into
 * the page.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

/** Subscribe helper that returns an unsubscribe function. */
function on(channel, handler) {
  const wrapped = (_event, ...args) => handler(...args);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('visionance', {
  app: {
    info: () => invoke('app:info'),
    capabilities: (opts) => invoke('app:capabilities', opts),
    encoders: () => invoke('app:encoders'),
    logs: () => invoke('app:logs')
  },

  dialog: {
    openVideo: () => invoke('dialog:openVideo'),
    saveVideo: (defaultName, container) => invoke('dialog:saveVideo', defaultName, container),
    pickBinary: (which) => invoke('dialog:pickBinary', which),
    pickCookiesFile: () => invoke('dialog:pickCookiesFile')
  },

  media: {
    open: (filePath) => invoke('media:open', filePath),
    analyze: (target, opts) => invoke('media:analyze', target, opts),
    resolveUrl: (url, opts) => invoke('media:resolveUrl', url, opts),
    refreshStream: (token) => invoke('media:refreshStream', token),
    releaseStream: (token) => invoke('media:releaseStream', token),
    transferStats: () => invoke('media:transferStats'),
    localUrl: (filePath) => invoke('media:localUrl', filePath)
  },

  /**
   * One stable thumbnail per source identity. The renderer sends a descriptor
   * and receives a `vs://` URL or null; it never sees the cache directory and
   * cannot ask for an arbitrary file.
   */
  thumbnails: {
    get: (descriptor) => invoke('thumbs:get', descriptor),
    stats: () => invoke('thumbs:stats'),
    clear: () => invoke('thumbs:clear')
  },

  /** Measured machine metrics. Sampling only runs while a panel subscribes. */
  telemetry: {
    subscribe: (active) => invoke('telemetry:subscribe', active),
    sample: () => invoke('telemetry:sample'),
    onSample: (cb) => on('telemetry:sample', cb)
  },

  recipe: {
    platforms: () => invoke('recipe:platforms'),
    aspects: () => invoke('recipe:aspects'),
    default: (analysis, overrides) => invoke('recipe:default', analysis, overrides),
    fromPreview: (params, analysis, overrides) => invoke('recipe:fromPreview', params, analysis, overrides),
    applyPlatform: (recipe, platformId) => invoke('recipe:applyPlatform', recipe, platformId),
    sanitize: (recipe) => invoke('recipe:sanitize', recipe)
  },

  auto: {
    profiles: () => invoke('auto:profiles'),
    build: (request) => invoke('auto:build', request),
    /** AUTO CONFIGURE for Create: user locks in, a full recipe and its account out. */
    configure: (request) => invoke('auto:configure', request),
    /**
     * AUTO CONFIGURE for Watch. A separate call over a separate module: it
     * configures realtime state only and can never write a Create recipe.
     */
    watch: (request) => invoke('watch:auto', request)
  },

  creatorPresets: {
    list: () => invoke('presets:creator'),
    apply: (id, request) => invoke('presets:applyCreator', id, request)
  },

  savedRecipes: {
    list: () => invoke('recipes:list'),
    save: (name, recipe) => invoke('recipes:save', name, recipe),
    rename: (id, name) => invoke('recipes:rename', id, name),
    duplicate: (id) => invoke('recipes:duplicate', id),
    remove: (id) => invoke('recipes:delete', id)
  },

  jobs: {
    list: () => invoke('jobs:list'),
    preview: (request) => invoke('jobs:preview', request),
    create: (request) => invoke('jobs:create', request),
    start: (id) => invoke('jobs:start', id),
    cancel: (id) => invoke('jobs:cancel', id),
    pause: (id) => invoke('jobs:pause', id),
    resume: (id) => invoke('jobs:resume', id),
    retry: (id) => invoke('jobs:retry', id),
    remove: (id) => invoke('jobs:remove', id),
    clear: () => invoke('jobs:clear'),
    onUpdate: (cb) => on('jobs:update', cb),
    onRemoved: (cb) => on('jobs:removed', cb)
  },

  engines: {
    status: (opts) => invoke('engines:status', opts),
    install: (id) => invoke('engines:install', id),
    cancelInstall: (id) => invoke('engines:cancelInstall', id),
    remove: (id) => invoke('engines:remove', id),
    onProgress: (cb) => on('engines:progress', cb),
    onStatus: (cb) => on('engines:status', cb)
  },

  semantic: {
    status: () => invoke('semantic:status'),
    install: () => invoke('semantic:install'),
    cancelInstall: () => invoke('semantic:cancelInstall'),
    remove: () => invoke('semantic:remove'),
    onProgress: (cb) => on('semantic:progress', cb),
    onStatus: (cb) => on('semantic:status', cb)
  },

  runtime: {
    status: () => invoke('runtime:status'),
    install: () => invoke('runtime:install'),
    onProgress: (cb) => on('runtime:progress', cb)
  },

  ytdlp: {
    install: () => invoke('ytdlp:install'),
    onProgress: (cb) => on('ytdlp:progress', cb)
  },

  settings: {
    get: () => invoke('settings:get'),
    patch: (patch) => invoke('settings:patch', patch)
  },

  presets: {
    get: () => invoke('presets:get'),
    save: (preset) => invoke('presets:save', preset),
    remove: (id) => invoke('presets:delete', id)
  },

  recents: {
    get: () => invoke('recents:get'),
    add: (entry) => invoke('recents:add', entry),
    remove: (source) => invoke('recents:remove', source),
    clear: () => invoke('recents:clear')
  },

  resume: {
    get: (key) => invoke('resume:get', key),
    set: (key, seconds) => invoke('resume:set', key, seconds)
  },

  system: {
    reveal: (p) => invoke('shell:reveal', p),
    openPath: (p) => invoke('shell:open', p),
    openExternal: (url) => invoke('shell:external', url),
    setFullscreen: (value) => invoke('window:fullscreen', value),
    keepAwake: (enable) => invoke('power:keepAwake', enable)
  },

  events: {
    onMenu: (cb) => on('menu', cb),
    onExternalFile: (cb) => on('open-external-file', cb)
  },

  /**
   * Resolve the on-disk path of a dropped File. `File.path` was removed in
   * newer Electron versions, so go through webUtils when it is available.
   */
  pathForFile: (file) => {
    try {
      if (webUtils && typeof webUtils.getPathForFile === 'function') {
        return webUtils.getPathForFile(file);
      }
    } catch { /* fall through */ }
    return file && file.path ? file.path : null;
  }
});

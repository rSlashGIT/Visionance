'use strict';

/**
 * Structured logging for the main process.
 *
 * One line per event, `level scope message key=value ...`, appended to a
 * rotating file and mirrored to the console. Values pass through the redactor
 * in errors.js, so cookies, tokens and signed URL parameters never land in a
 * log file the user might paste into an issue.
 *
 * This is for state transitions and failures, not for per-frame telemetry.
 * Anything that can fire more than a few times a second belongs in `debug`,
 * which is off unless VISIONANCE_LOG=debug.
 */

const fs = require('fs');
const path = require('path');
const { redact } = require('./errors');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const MAX_BYTES = 2 * 1024 * 1024;

function envLevel() {
  const raw = String(process.env.VISIONANCE_LOG || '').toLowerCase();
  return LEVELS[raw] ? raw : 'info';
}

class Logger {
  constructor(opts = {}) {
    this.level = opts.level || envLevel();
    this.file = opts.file || null;
    this.console = opts.console !== false;
    this.scope = opts.scope || 'app';
    this._stream = null;
    this._ring = [];
    this._ringMax = opts.ringSize || 300;
  }

  /** Child logger with a different scope, sharing the same sink. */
  child(scope) {
    const c = Object.create(Logger.prototype);
    Object.assign(c, this, { scope });
    return c;
  }

  setFile(file) {
    this.file = file;
    if (this._stream) {
      try { this._stream.end(); } catch { /* ignore */ }
      this._stream = null;
    }
    return this;
  }

  /** Last N formatted lines, for a diagnostics panel or a bug report. */
  recent(n = 100) {
    return this._ring.slice(-n);
  }

  debug(msg, fields) { this._write('debug', msg, fields); }
  info(msg, fields) { this._write('info', msg, fields); }
  warn(msg, fields) { this._write('warn', msg, fields); }
  error(msg, fields) { this._write('error', msg, fields); }

  _write(level, msg, fields) {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const line = format(level, this.scope, msg, fields);
    this._ring.push(line);
    if (this._ring.length > this._ringMax) this._ring.shift();

    if (this.console) {
      const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      sink(line);
    }
    this._append(line);
  }

  _append(line) {
    if (!this.file) return;
    try {
      if (!this._stream) {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        this._rotateIfNeeded();
        this._stream = fs.createWriteStream(this.file, { flags: 'a' });
        this._stream.on('error', () => { this._stream = null; });
      }
      this._stream.write(line + '\n');
    } catch {
      // Logging must never be the reason an operation fails.
    }
  }

  _rotateIfNeeded() {
    try {
      const st = fs.statSync(this.file);
      if (st.size > MAX_BYTES) fs.renameSync(this.file, this.file + '.1');
    } catch { /* no existing log */ }
  }
}

function format(level, scope, msg, fields) {
  const ts = new Date().toISOString();
  let line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${redact(msg)}`;
  if (fields && typeof fields === 'object') {
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      line += ` ${k}=${formatValue(v)}`;
    }
  }
  return line;
}

function formatValue(v) {
  if (v === null) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  let s;
  if (typeof v === 'object') {
    try { s = JSON.stringify(v); } catch { s = String(v); }
  } else {
    s = String(v);
  }
  s = redact(s).replace(/\s+/g, ' ').trim();
  if (s.length > 500) s = s.slice(0, 500) + '…';
  return /[\s"]/.test(s) ? JSON.stringify(s) : s;
}

/** Process-wide default; main.js points it at <userData>/logs/main.log. */
const logger = new Logger();

module.exports = { Logger, logger, LEVELS };

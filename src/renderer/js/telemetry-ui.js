/**
 * Performance telemetry, renderer side.
 *
 * One controller, one subscription, one sampling cadence. Every widget that
 * wants a number attaches to this rather than starting its own timer - a
 * separate poll per metric per panel is how a UI ends up costing more than the
 * work it is measuring.
 *
 * The graph is a small canvas over a fixed ring buffer, redrawn once per
 * sample. It is deliberately not on `requestAnimationFrame`: there is nothing
 * to animate between samples, and a 60 Hz redraw of a 60-point line would be
 * 30x the work for no additional information.
 *
 * Nothing here invents a value. GPU utilisation exists only where a vendor
 * tool reports it; where it does not, the graph plots the application's own
 * CPU share and says so in its own label rather than drawing a plausible line
 * and calling it GPU.
 */

(function () {
  'use strict';

  const api = window.visionance;

  /** Two minutes of history at the main process's 2 s cadence. */
  const HISTORY = 60;

  const state = {
    /** Fixed-size ring buffer. Allocated once; never grows. */
    history: new Float32Array(HISTORY),
    length: 0,
    cursor: 0,
    latest: null,
    /** 'gpu' when a vendor tool reports utilisation, otherwise 'cpu'. */
    series: 'cpu',
    subscribed: false,
    wanted: false,
    views: new Set(),
    unsubscribe: null
  };

  function push(value) {
    state.history[state.cursor] = value;
    state.cursor = (state.cursor + 1) % HISTORY;
    if (state.length < HISTORY) state.length++;
  }

  /** The buffer in chronological order, for drawing. */
  function series() {
    const out = new Array(state.length);
    const start = state.length < HISTORY ? 0 : state.cursor;
    for (let i = 0; i < state.length; i++) {
      out[i] = state.history[(start + i) % HISTORY];
    }
    return out;
  }

  function onSample(sample) {
    state.latest = sample;
    const gpu = sample.gpu;
    const hasGpu = !!(gpu && Number.isFinite(gpu.utilisationPercent));
    state.series = hasGpu ? 'gpu' : 'cpu';
    const value = hasGpu
      ? gpu.utilisationPercent
      : (Number.isFinite(sample.cpu && sample.cpu.appPercent) ? sample.cpu.appPercent : 0);
    push(Math.max(0, Math.min(100, value)));
    render();
  }

  /* ------------------------------------------------------------------ *
   * Subscription
   *
   * Sampling is driven by two facts: does any view want it, and is the window
   * actually visible. Both must hold. A minimised window polling nvidia-smi
   * every two seconds is exactly the ambient cost this UI promises not to
   * have.
   * ------------------------------------------------------------------ */

  function reconcile() {
    const should = state.wanted && document.visibilityState === 'visible';
    if (should === state.subscribed) return;
    state.subscribed = should;
    if (should) {
      if (!state.unsubscribe) state.unsubscribe = api.telemetry.onSample(onSample);
      api.telemetry.subscribe(true);
    } else {
      api.telemetry.subscribe(false);
    }
  }

  document.addEventListener('visibilitychange', reconcile);

  /**
   * Register a view. `element` hosts the graph and rows; the controller stops
   * touching it the moment it is detached or hidden.
   */
  function attach(element, opts = {}) {
    if (!element) return null;
    const view = buildView(element, opts);
    state.views.add(view);
    updateWanted();
    render();
    return view;
  }

  function detach(view) {
    if (!view) return;
    state.views.delete(view);
    updateWanted();
  }

  function updateWanted() {
    state.wanted = [...state.views].some((v) => v.isVisible());
    reconcile();
  }

  /** Called when a panel is shown or hidden, so hidden views cost nothing. */
  function refreshVisibility() {
    updateWanted();
    render();
  }

  /* ------------------------------------------------------------------ *
   * View
   * ------------------------------------------------------------------ */

  function buildView(host, opts) {
    host.innerHTML = '';

    /*
     * The headline reading, as a dial.
     *
     * Same number the graph already ends on, drawn once per existing sample as
     * a conic gradient — no canvas, no timer, no extra subscription. It exists
     * because a console is read at a glance from across a desk, and a 1px
     * trace is not readable that way. The stylesheet decides where it is
     * wanted; the settings panel has room for the trace and does not show it.
     */
    const gauge = document.createElement('div');
    gauge.className = 'telemetry-gauge';
    const ring = document.createElement('div');
    ring.className = 'tg-ring';
    const ringValue = document.createElement('span');
    ringValue.className = 'tg-ring-value';
    ringValue.textContent = '—';
    const ringCap = document.createElement('span');
    ringCap.className = 'tg-ring-cap';
    ring.append(ringValue, ringCap);
    gauge.appendChild(ring);

    const graph = document.createElement('div');
    graph.className = 'telemetry-graph';
    const canvas = document.createElement('canvas');
    const label = document.createElement('span');
    label.className = 'tg-label';
    const current = document.createElement('span');
    current.className = 'tg-current';
    graph.append(canvas, label, current);

    const rows = document.createElement('div');
    rows.className = 'telemetry-rows';

    const note = document.createElement('p');
    note.className = 'telemetry-note';
    note.hidden = true;

    host.append(gauge, graph, rows, note);

    return {
      host, canvas, label, current, rows, note,
      gauge, ring, ringValue, ringCap,
      compact: !!opts.compact,
      isVisible() {
        // offsetParent is null for a `display:none` ancestor, which is exactly
        // how the workspace switch and the settings modal hide these.
        return !!host.offsetParent;
      }
    };
  }

  function render() {
    for (const view of state.views) {
      if (!view.isVisible()) continue;
      drawGraph(view);
      drawRows(view);
    }
  }

  function drawGraph(view) {
    const canvas = view.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = canvas.clientWidth || 200;
    const height = canvas.clientHeight || 42;
    const w = Math.round(width * dpr);
    const h = Math.round(height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);

    const values = series();
    const isGpu = state.series === 'gpu';
    view.label.textContent = isGpu ? 'GPU usage' : 'App CPU';
    view.ringCap.textContent = isGpu ? 'GPU' : 'CPU';

    if (!values.length) {
      view.current.textContent = '';
      view.ringValue.textContent = '—';
      view.ring.style.setProperty('--pct', '0');
      return;
    }

    const styles = getComputedStyle(document.documentElement);
    const accent = styles.getPropertyValue('--accent').trim() || '#FF4B32';
    const grid = styles.getPropertyValue('--border-subtle').trim() || '#1B1E21';

    // A quartered scale, so a reading can be judged against something. The
    // 100% line is drawn solid as the instrument's ceiling; the interior
    // divisions are lighter. Still a static draw, once per sample.
    ctx.lineWidth = 1;
    for (const fraction of [0.25, 0.5, 0.75, 1]) {
      const y = Math.round(h - h * fraction) + 0.5;
      ctx.strokeStyle = fraction === 1 ? '#24282C' : grid;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // Vertical time divisions, one every fifteen samples (~30 s at the 2 s
    // cadence), so the history has a readable extent rather than being an
    // undated squiggle.
    ctx.strokeStyle = grid;
    for (let i = 15; i < HISTORY; i += 15) {
      const x = Math.round((i / (HISTORY - 1)) * w) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    const step = w / Math.max(1, HISTORY - 1);
    const offset = (HISTORY - values.length) * step;
    const pointAt = (i) => ({
      x: offset + i * step,
      y: h - (Math.max(0, Math.min(100, values[i])) / 100) * (h - 2 * dpr) - dpr
    });

    // Fill under the line, then the line. One path each, no per-point state.
    ctx.beginPath();
    ctx.moveTo(offset, h);
    for (let i = 0; i < values.length; i++) {
      const p = pointAt(i);
      ctx.lineTo(p.x, p.y);
    }
    ctx.lineTo(offset + (values.length - 1) * step, h);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 75, 50, 0.12)';
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < values.length; i++) {
      const p = pointAt(i);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.4 * dpr;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // A marker on the newest sample: the instrument should say where "now" is,
    // which a flat line at 0% otherwise cannot.
    const last = pointAt(values.length - 1);
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(last.x, last.y, 2 * dpr, 0, Math.PI * 2);
    ctx.fill();

    const latest = Math.max(0, Math.min(100, Math.round(values[values.length - 1])));
    view.current.textContent = `${latest}%`;
    view.ringValue.textContent = `${latest}%`;
    view.ring.style.setProperty('--pct', String(latest));
  }

  function drawRows(view) {
    const sample = state.latest;
    const rows = [];
    const fmtBytes = window.VSUiKit.fmtBytes;

    // `kind` only drives emphasis: the device and its two headline readings
    // carry weight, the application's own footprint sits quieter beneath.
    if (sample) {
      const gpu = sample.gpu;
      if (gpu) {
        if (gpu.name) rows.push(['Device', gpu.name, 'device']);
        if (Number.isFinite(gpu.utilisationPercent)) {
          rows.push(['Utilisation', `${gpu.utilisationPercent}%`, 'primary']);
        }
        if (Number.isFinite(gpu.memoryUsedBytes) && Number.isFinite(gpu.memoryTotalBytes)) {
          rows.push(['VRAM', `${fmtBytes(gpu.memoryUsedBytes)} / ${fmtBytes(gpu.memoryTotalBytes)}`, 'primary']);
        }
      }
      if (sample.cpu && Number.isFinite(sample.cpu.appPercent)) {
        rows.push(['App CPU', `${sample.cpu.appPercent.toFixed(1)}%`]);
      }
      const mem = sample.memory || {};
      if (Number.isFinite(mem.appBytes)) rows.push(['App memory', fmtBytes(mem.appBytes)]);
      if (!view.compact && Number.isFinite(mem.systemUsedBytes) && Number.isFinite(mem.systemTotalBytes)) {
        rows.push(['System memory', `${fmtBytes(mem.systemUsedBytes)} / ${fmtBytes(mem.systemTotalBytes)}`]);
      }
    }

    // Rebuilt only when the shape changes; otherwise values are written in
    // place, so a sample does not churn the DOM.
    if (view.rows.childElementCount !== rows.length) {
      view.rows.innerHTML = '';
      for (const [key, , kind] of rows) {
        const row = document.createElement('div');
        row.className = 'telemetry-row' + (kind ? ` is-${kind}` : '');
        const k = document.createElement('span');
        k.textContent = key;
        const v = document.createElement('span');
        v.className = 'telemetry-value';
        row.append(k, v);
        view.rows.appendChild(row);
      }
    }
    rows.forEach(([key, value], i) => {
      const row = view.rows.children[i];
      if (!row) return;
      if (row.children[0].textContent !== key) row.children[0].textContent = key;
      if (row.children[1].textContent !== value) row.children[1].textContent = value;
      row.children[1].title = value;
    });

    // Say plainly when a number is not available, rather than showing one that
    // looks right and is not.
    const gpuMissing = !sample || !sample.gpu;
    view.note.hidden = !gpuMissing;
    if (gpuMissing) {
      view.note.textContent = sample
        ? 'GPU utilisation is not exposed by this system, so the graph shows Visionance’s own CPU share.'
        : 'Waiting for the first sample…';
    }
  }

  /** Diagnostics hook: what the controller is actually doing right now. */
  function debugState() {
    return {
      subscribed: state.subscribed,
      wanted: state.wanted,
      views: state.views.size,
      samples: state.length,
      series: state.series,
      historyLength: HISTORY,
      latest: state.latest
    };
  }

  window.VSTelemetry = { attach, detach, refreshVisibility, debugState };
})();

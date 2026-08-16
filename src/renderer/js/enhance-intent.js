/**
 * What should the realtime budget be spent on?
 *
 * Watch has exactly four enhancement stages, and they are the four the shader
 * chain actually runs:
 *
 *   restore      denoise, deblock              (FRAG_RESTORE, source resolution)
 *   reconstruct  edge, line                    (FRAG_UPSCALE, output resolution)
 *   sharpen      sharpen, haloGuard            (FRAG_SHARPEN)
 *   finish       deband, contrast, colour      (FRAG_GRADE)
 *
 * An intent biases those four. It does not add stages, it does not select
 * models, and it never promises anything the pipeline cannot do - there is no
 * realtime RIFE and no Real-ESRGAN here, and nothing in this file pretends
 * otherwise. Offline Create is a separate engine with separate settings.
 *
 * Biases are multiplicative against whatever the Look already chose, so a Look
 * and an intent compose instead of fighting, and Fine tune still wins because
 * it writes the parameters directly afterwards.
 */

(function () {
  'use strict';

  /** Which parameters belong to which real stage. */
  const STAGES = {
    restore: ['denoise', 'deblock'],
    reconstruct: ['edge', 'line'],
    sharpen: ['sharpen'],
    finish: ['deband', 'localContrast', 'contrast', 'saturation', 'vibrance']
  };

  /**
   * Multipliers per intent. Deliberately gentle: these bias a look, they do not
   * replace it, and an intent that doubled sharpening would just be a worse
   * look with a friendlier name.
   */
  const INTENTS = {
    auto: { label: 'Auto', bias: {} },
    clean: {
      label: 'Clean',
      // More cleanup, and less sharpening - sharpening compression artefacts is
      // how "enhanced" starts looking worse than the source.
      bias: { restore: 1.6, sharpen: 0.75, reconstruct: 0.9 },
      floor: { denoise: 0.12, deblock: 0.12 }
    },
    detail: {
      label: 'Detail',
      bias: { reconstruct: 1.4, restore: 0.9, sharpen: 1.1 },
      floor: { edge: 0.45 }
    },
    sharp: {
      label: 'Sharp',
      bias: { sharpen: 1.45, reconstruct: 1.1 },
      floor: { sharpen: 0.3 },
      // Halo protection rises with sharpening. Without this the intent would be
      // a ringing generator on any edge with contrast.
      haloGuard: 0.9
    },
    finish: {
      label: 'Finish',
      bias: { finish: 1.35, sharpen: 0.9 }
    }
  };

  const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));

  /**
   * Apply an intent to a parameter set.
   *
   * @param {object} params  shader parameters, as a Look produced them
   * @param {string} intent  one of INTENTS
   * @returns {object} a new parameter object; the input is not modified
   */
  function applyIntent(params, intent) {
    const spec = INTENTS[intent] || INTENTS.auto;
    const out = { ...params };
    if (intent === 'auto' || !intent) return out;

    for (const [stage, keys] of Object.entries(STAGES)) {
      const factor = spec.bias[stage];
      if (!factor) continue;
      for (const key of keys) {
        if (typeof out[key] !== 'number') continue;
        out[key] = clamp01(out[key] * factor);
      }
    }

    // A bias multiplies, so a Look that switched a stage off entirely would
    // stay off however hard the intent asks for it. A floor is what makes
    // "Clean" actually clean a source whose Look had no denoise at all.
    for (const [key, min] of Object.entries(spec.floor || {})) {
      if (typeof out[key] === 'number' && out[key] < min) out[key] = min;
    }
    if (spec.haloGuard && typeof out.haloGuard === 'number') {
      out.haloGuard = Math.max(out.haloGuard, spec.haloGuard);
    }
    return out;
  }

  /** The stages an intent emphasises, for saying so in plain language. */
  function describeIntent(intent) {
    const spec = INTENTS[intent];
    if (!spec || intent === 'auto') return 'Balanced by Visionance';
    const up = Object.entries(spec.bias)
      .filter(([, f]) => f > 1)
      .map(([stage]) => stage);
    const names = {
      restore: 'compression cleanup', reconstruct: 'detail reconstruction',
      sharpen: 'edge sharpness', finish: 'colour and tone'
    };
    return up.length ? `Prioritising ${up.map((s) => names[s]).join(' and ')}` : spec.label;
  }

  const api = { applyIntent, describeIntent, INTENTS, STAGES };
  if (typeof window !== 'undefined') window.VSIntent = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

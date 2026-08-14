'use strict';

/**
 * The semantic detection engine: two compact ONNX models and the runtime that
 * executes them.
 *
 * Why these, and why not something bigger
 * ---------------------------------------
 * Smart Reframe's saliency tracker finds *motion and detail*, which is the
 * right answer for gameplay, vehicles and wide action, and the wrong answer
 * for the footage most people actually reframe. On real user footage it
 * tracked 6 of 40 samples: a stationary presenter lost to moving foliage,
 * because foliage genuinely has more motion energy than a person standing
 * still. No amount of tuning fixes that - the tracker was answering a
 * different question.
 *
 * So a semantic layer sits *above* it. The models were chosen by measuring
 * rather than by reputation:
 *
 * | model    | bytes     | what it gives |
 * |----------|-----------|---------------|
 * | YuNet    |   232,589 | faces + 5 landmarks, 3 strides |
 * | NanoDet  | 3,800,954 | COCO boxes; class 0 is `person` |
 *
 * Four megabytes total. A general-purpose detector would have been tens to
 * hundreds of megabytes for a worse answer to this specific question, and the
 * obvious "just use YOLO" options are AGPL, which this MIT application cannot
 * take.
 *
 * Both models come from OpenCV Zoo, which is one maintained host with one
 * licence story, and both are fetched through the same managed-download
 * machinery as Real-ESRGAN and RIFE. Nothing large is committed to the
 * repository.
 *
 * Note on URLs: opencv_zoo stores models in Git LFS, so `raw.githubusercontent`
 * returns a 131-byte pointer file rather than the model. `media.githubusercontent`
 * serves the real bytes. Verified by downloading both.
 */

const ID = 'semantic';

/**
 * The runtime is an ordinary npm dependency rather than a managed download.
 *
 * `onnxruntime-node` publishes its native binding against **N-API v6**, which
 * is ABI-stable across Node and Electron, so it loads in a packaged Electron
 * app with no rebuild step. Verified empirically on Electron 43.2.0 /
 * Node 24.18.0 (`process.versions.modules = 148`): the binding loads and
 * creates sessions unmodified. That is the single biggest packaging risk in
 * this whole feature, and it is simply absent.
 *
 * The npm package carries every platform and every execution provider
 * (259 MB installed). What actually ships is one platform directory: on
 * win32-x64 that is `onnxruntime.dll` at 26 MB for CPU inference, plus
 * DirectML at 38 MB if GPU acceleration is wanted. The build config keeps the
 * CPU core and drops the rest.
 */
const RUNTIME = {
  package: 'onnxruntime-node',
  license: 'MIT',
  napi: 6,
  cpuBytes: 26_310_000,
  optionalGpuBytes: 38_000_000
};

const MODELS = [
  {
    id: 'face',
    label: 'YuNet face detector',
    file: 'face_detection_yunet_2023mar.onnx',
    url: 'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/' +
      'face_detection_yunet/face_detection_yunet_2023mar.onnx',
    bytes: 232589,
    sha256: null,
    license: 'MIT',
    attribution: 'YuNet by Shiqi Yu and Yuantao Feng, via OpenCV Zoo.',
    // Determined by loading the model, not from documentation.
    inputName: 'input',
    outputs: ['cls_8', 'cls_16', 'cls_32', 'obj_8', 'obj_16', 'obj_32',
      'bbox_8', 'bbox_16', 'bbox_32', 'kps_8', 'kps_16', 'kps_32']
  },
  {
    id: 'person',
    label: 'NanoDet-Plus person detector',
    file: 'object_detection_nanodet_2022nov.onnx',
    url: 'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/' +
      'object_detection_nanodet/object_detection_nanodet_2022nov.onnx',
    bytes: 3800954,
    sha256: null,
    license: 'Apache-2.0',
    attribution: 'NanoDet-Plus by RangiLyu, via OpenCV Zoo.',
    inputName: 'input.1',
    // [cls_8, cls_16, cls_32, reg_8, reg_16, reg_32] at 416x416, measured:
    //   792 [1,2704,80]  814 [1,676,80]  836 [1,169,80]
    //   795 [1,2704,32]  817 [1,676,32]  839 [1,169,32]
    outputs: ['792', '814', '836', '795', '817', '839'],
    inputSize: 416,
    regMax: 7,
    personClass: 0
  }
];

const LICENSE = {
  name: 'Semantic subject detection',
  license: 'MIT (YuNet) / Apache-2.0 (NanoDet) / MIT (ONNX Runtime)',
  url: 'https://github.com/opencv/opencv_zoo',
  notice:
    'Face detection by YuNet (Shiqi Yu, Yuantao Feng). Person detection by ' +
    'NanoDet-Plus (RangiLyu). Both distributed by OpenCV Zoo. Inference by ' +
    'ONNX Runtime (Microsoft).'
};

/** Total bytes to download, for the progress UI. */
const TOTAL_BYTES = MODELS.reduce((sum, m) => sum + m.bytes, 0);

function modelById(id) {
  return MODELS.find((m) => m.id === id) || null;
}

module.exports = { ID, RUNTIME, MODELS, LICENSE, TOTAL_BYTES, modelById };

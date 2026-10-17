/** 计算图片内容指纹（尺寸 + dHash），用于识别重复转发的同一张图。
 *  钉钉每次转发都会重新上传图片，mediaId 与文件字节都会变，因此只能用感知哈希比对。
 *  python3 + Pillow 不可用时返回空表，调用方自然退回原有文本去重逻辑。 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const SCHEMA_VERSION = 1;
const DEFAULT_TIMEOUT = 30000;

const PY_SCRIPT = String.raw`
import sys, json, os
from PIL import Image

payload = json.load(sys.stdin)
cache_path = payload['cache']
items = payload['files']
cache = {}
if os.path.exists(cache_path):
    try:
        raw = json.load(open(cache_path, encoding='utf-8'))
        if raw.get('schemaVersion') == 1 and isinstance(raw.get('files'), dict):
            cache = raw['files']
    except Exception:
        cache = {}

out, dirty = {}, False
for name, file_path in items.items():
    hit = cache.get(name)
    if (isinstance(hit, dict) and isinstance(hit.get('w'), int)
            and isinstance(hit.get('h'), int) and isinstance(hit.get('d'), str)):
        out[name] = hit
        continue
    try:
        with Image.open(file_path) as raw_img:
            width, height = raw_img.size
            small = raw_img.convert('L').resize((9, 8), Image.LANCZOS)
            pixels = list(small.tobytes())
        bits = 0
        for row in range(8):
            base = row * 9
            for col in range(8):
                bits = (bits << 1) | (1 if pixels[base + col] > pixels[base + col + 1] else 0)
        out[name] = {'w': width, 'h': height, 'd': format(bits, '016x')}
        cache[name] = out[name]
        dirty = True
    except Exception:
        continue

if dirty:
    try:
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        tmp = cache_path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as handle:
            json.dump({'schemaVersion': 1, 'files': cache}, handle)
        os.replace(tmp, cache_path)
    except Exception:
        pass

json.dump(out, sys.stdout)
`;

const validSignature = value => Boolean(value)
  && Number.isInteger(value.w) && value.w > 0
  && Number.isInteger(value.h) && value.h > 0
  && typeof value.d === 'string' && /^[0-9a-f]{16}$/.test(value.d);

/** 批量读取图片指纹，结果按文件名缓存在 media 目录，新增图片才会重新解码。
 *  返回 Map<图片引用, {w, h, d}>，无法解析的引用不会出现在结果里。 */
export function imageFingerprints(localFiles, options = {}) {
  const result = new Map();
  if (!(localFiles instanceof Map) || !localFiles.size) return result;

  const paths = new Map();
  for (const file of localFiles.values()) if (typeof file === 'string' && file) paths.set(path.basename(file), file);
  if (!paths.size) return result;

  const directory = options.directory || path.dirname([...paths.values()][0]);
  const cacheFile = options.cacheFile || path.join(directory, 'fingerprints.json');
  const python = options.python || process.env.VIBE_PYTHON || 'python3';

  let parsed = {};
  try {
    const run = spawnSync(python, ['-I', '-c', PY_SCRIPT], {
      // -I 隔离模式 + 固定工作目录：避免调用方 cwd 里的同名 .py 遮蔽标准库模块。
      cwd: directory,
      input: JSON.stringify({ cache: cacheFile, files: Object.fromEntries(paths) }),
      encoding: 'utf8',
      timeout: options.timeout || DEFAULT_TIMEOUT,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (run.error || run.status !== 0 || !run.stdout) return result;
    parsed = JSON.parse(run.stdout);
  } catch {
    return result;
  }

  for (const [reference, file] of localFiles) {
    const name = typeof file === 'string' ? path.basename(file) : '';
    const signature = name ? parsed[name] : null;
    if (validSignature(signature)) result.set(reference, { w: signature.w, h: signature.h, d: signature.d });
  }
  return result;
}

/** 指纹缓存文件，供测试与维护脚本定位。 */
export const fingerprintCacheName = 'fingerprints.json';

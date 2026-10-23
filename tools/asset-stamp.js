#!/usr/bin/env node
// @tool-not-hook —— 共享工具 + 命令行，不注册进 settings.json。被 cache-version-gate.js require；
//                   各网站仓库也放一份同字节副本在 tools/asset-stamp.js，当构建 / 部署前的一步。
/*
 * asset-stamp.js — 给网站里引用的本地 CSS / JS（以及 JS 里 fetch 的本地数据文件）打「按内容哈希」的版本号
 * ------------------------------------------------------------------
 * 规则（2026-10-23）：style.css?v=<sha256 前 8 位>。内容不变 → 版本号不变；一改 → 自动变。
 * 起因：GitHub Pages 对所有文件给 max-age=600，引用 CSS/JS 不带版本号的站点
 *       → 客户手机上「新页面 + 旧样式」错乱，只能 hard refresh。
 *
 * 用法：
 *   node asset-stamp.js --write <站点根目录>   就地改写（构建 / 部署前跑；改完自己再 --check 一遍）
 *   node asset-stamp.js --check <站点根目录>   只检查；有缺失 / 过期 → exit 1，逐条列出 文件:行
 *
 * 认什么（「本地」= 不以 http: https: // data: blob: mailto: # 开头）：
 *   - HTML 里 <link href> / <script src> 指向 .css / .js / .mjs（rel=canonical/alternate/icon/manifest 等不算）
 *   - HTML 内联脚本与本地 JS 里 fetch('x.json' | .csv | .tsv | .geojson | .xml | .txt)
 *   - 本地 JS 里 import … from './x.js'、import('./x.js')、export … from './x.js'
 *   - CSS 里 @import 本地 .css
 * 视为已合规：文件名自带构建哈希（Vite / webpack：index-BxK3a9Qz.js、main.4f3a2b1c.css）或在 /_next/static/ 下。
 * 算违规：缺 ?v= · ?v= 与当前内容哈希不符（过期）· fetch('x.json?' + Date.now()) 这类动态参数 · 引用的文件不存在。
 * 哈希 = sha256(文件内容；文本文件先 CRLF→LF) 的前 8 位十六进制——Windows / Mac / GitHub Actions 算出来一致。
 * 改写顺序自底向上：先改 JS 里的 data 引用 → 再算 JS 的哈希 → 再改 HTML，一遍到位。
 * 安全：非 UTF-8 文件不改写（只报）；只替换 URL 本身，换行 / BOM / 其他字节原样保留。
 * 不管：CSS 里 url() 的图片 / 字体、模板字符串里带 ${} 的 fetch 路径（静态判不了）、
 *       带模板语法的路径（{{ site.baseurl }} / {% %} / <% %>，构建后才知道）、fetch('x.json' + 后缀) 这类拼接、
 *       fetch 指向不存在的文件（多半是服务端路由 /api/x.json）、JS 注释里的引用、ES module 循环 import 的回边（无解：互相包含对方哈希）。
 * JS 里的 fetch 相对路径按「引用它的页面」解析（浏览器就是这么算的），import 按 JS 文件自己解析。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HASH_LEN = 8;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.github', '.wrangler', '.vercel', '.dart_tool', '.idea', '.vscode',
  '__pycache__', '.venv', 'venv', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.cache', '.parcel-cache', '.svelte-kit', '.nuxt', '.next', '.turbo']);
const MAX_FILES = 50000;   // 目录遍历上限：超了就报 TOO_MANY_FILES（门据此提醒「没扫」，不会卡死在网络盘 / 巨型目录上）
const ASSET_EXT = /\.(css|m?js)$/i;
const DATA_EXT = /\.(json|csv|tsv|geojson|xml|txt)$/i;
const TEXT_EXT = /\.(html?|css|m?js)$/i;
const LINK_REL_SKIP = /\b(canonical|alternate|icon|shortcut|apple-touch-icon|mask-icon|manifest|preconnect|dns-prefetch|author|license|me|search)\b/i;

const LF_EXT = /\.(html?|css|m?js|json|csv|tsv|geojson|xml|txt|svg)$/i;
function hash8(buf) { return crypto.createHash('sha256').update(buf).digest('hex').slice(0, HASH_LEN); }
/**
 * 文本文件先把 CRLF 统一成 LF 再算哈希。
 * 🔴 为什么（2026-10-23 实测）：Windows 上 git 系统级 core.autocrlf=true —— 工作区 style.css 是 CRLF，
 *    GitHub 上存的 / Pages 发出去的是 LF。不统一的话：本机按 CRLF 算的 ?v= ≠ 线上内容，
 *    门（查 git 提交）永远判「过期」，CI（Linux）算的又是另一个值。统一后三处一致；只改换行不改内容 → 版本号不变（本来就该不变）。
 */
function contentHash(rel, buf) {
  if (LF_EXT.test(rel) && buf.includes(13)) return hash8(Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1'));
  return hash8(buf);
}
function isExternal(u) { return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(u); }
/** 模板语法（Jekyll / Liquid / ERB / PHP / JS 模板串）—— 构建后才知道真实路径，不当本地文件判 */
function isTemplated(u) { return /\{\{|\{%|<%|<\?|\$\{|\{\$/.test(u); }
function splitUrl(u) {
  const m = String(u).match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  return { p: m ? m[1] : u, q: (m && m[2]) || '', h: (m && m[3]) || '' };
}
function getV(q) { const m = q.match(/[?&]v=([^&]*)/); return m ? m[1] : null; }
function setV(u, v) {
  const { p, q, h } = splitUrl(u);
  const rest = q.replace(/^\?/, '').split('&').filter((s) => s && !/^v=/.test(s));
  rest.push('v=' + v);
  return p + '?' + rest.join('&') + h;
}
/** 文件名自带构建哈希？
 *  算：Vite「-」+ 8 位 base64url（index-BxK3a9Qz.js，可能全是字母）· webpack/rollup 十六进制（main.4f3a2b1c.css）· 字母数字混合 ≥8 位；
 *      打包器专用目录（/_next/static/ /_astro/ /_app/immutable/ /_nuxt/）。
 *  不算：纯小写单词（-polyfills）、驼峰单词（jquery.dataTables.js）。 */
function hasBuildHash(p) {
  if (/\/(_next\/static|_astro|_app\/immutable|_nuxt)\//.test('/' + String(p).replace(/^\/+/, ''))) return true;
  const base = String(p).split('/').pop();
  const m = base.match(/([-.])([A-Za-z0-9_-]{8,})\.(?:m?js|css)$/);
  if (!m || /^[a-z-]+$/.test(m[2])) return false;
  const h = m[2];
  if (/^[0-9a-f]+$/.test(h)) return /\d/.test(h);
  if (m[1] === '-' && h.length === 8) return true;
  return /\d/.test(h) && /[A-Za-z]/.test(h);
}
function lineOf(text, idx) { let n = 1; for (let i = 0; i < idx; i++) if (text.charCodeAt(i) === 10) n++; return n; }
/** 把 HTML 注释抹成空格（保留偏移），注释里的旧 <link> 不算。 */
function maskHtmlComments(t) { return t.replace(/<!--[\s\S]*?-->/g, (s) => s.replace(/[^\n]/g, ' ')); }
/** 把 JS 注释抹成空格（保留偏移）：认字符串 '' "" ``、正则字面量（按前一个有效字符猜），注释里的旧 fetch / import 不算。 */
function maskJsComments(t) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  let out = '', i = 0, prev = '';
  const n = t.length;
  while (i < n) {
    const c = t[i], d = t[i + 1];
    if (c === '/' && d === '/') { let j = t.indexOf('\n', i); if (j < 0) j = n; out += blank(t.slice(i, j)); i = j; continue; }
    if (c === '/' && d === '*') { let j = t.indexOf('*/', i + 2); j = j < 0 ? n : j + 2; out += blank(t.slice(i, j)); i = j; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && t[j] !== c) { if (t[j] === '\\') j++; else if (c !== '`' && t[j] === '\n') break; j++; }
      j = Math.min(n, j + 1); out += t.slice(i, j); prev = c; i = j; continue;
    }
    if (c === '/' && (prev === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || /\b(return|typeof|case|do|else|in|of|void|yield|await)\s*$/.test(out.slice(-12)))) {
      let j = i + 1, cls = false;
      while (j < n && t[j] !== '\n') { if (t[j] === '\\') { j += 2; continue; } if (t[j] === '[') cls = true; else if (t[j] === ']') cls = false; else if (t[j] === '/' && !cls) break; j++; }
      j = Math.min(n, j + 1); out += t.slice(i, j); prev = '/'; i = j; continue;
    }
    out += c; if (!/\s/.test(c)) prev = c; i++;
  }
  return out;
}
/** HTML 里内联 <script> 的 JS 注释也抹掉 */
function maskInlineScripts(t) { return t.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (all, a, body, z) => a + maskJsComments(body) + z); }

/** 抽出一段文本里的本地引用：[{start,end,url,kind,dynamic}]，start/end 是 URL 本身在 text 里的偏移 */
function extractRefs(rel, text) {
  const refs = [];
  const isHtml = /\.html?$/i.test(rel), isJs = /\.m?js$/i.test(rel), isCss = /\.css$/i.test(rel);
  const scan = isHtml ? maskInlineScripts(maskHtmlComments(text)) : isJs ? maskJsComments(text) : text;
  if (isHtml) {
    const TAG = /<(link|script)\b[^>]*>/gi;
    let t;
    while ((t = TAG.exec(scan))) {
      const tag = t[0], name = t[1].toLowerCase();
      if (name === 'link') {
        const rel2 = (tag.match(/\brel\s*=\s*["']?([^"'>]+)/i) || [])[1] || '';
        if (LINK_REL_SKIP.test(rel2)) continue;
      }
      const A = /\b(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
      let a;
      while ((a = A.exec(tag))) {
        const val = a[2] != null ? a[2] : a[3] != null ? a[3] : a[4];
        if (!val || isExternal(val) || isTemplated(val)) continue;
        const { p } = splitUrl(val);
        const isAsset = ASSET_EXT.test(p);
        const isData = name === 'link' && DATA_EXT.test(p) && /\bas\s*=\s*["']?fetch/i.test(tag);
        if (!isAsset && !isData) continue;
        const off = t.index + a.index + a[0].indexOf(val, a[1].length);
        refs.push({ start: off, end: off + val.length, url: val, kind: isAsset ? 'asset' : 'data' });
      }
    }
  }
  if (isHtml || isJs) {
    const F = /\bfetch\(\s*(['"`])([^'"`\n]*?)\1(\s*\+)?/g;
    let f;
    while ((f = F.exec(scan))) {
      const val = f[2];
      if (!val || isExternal(val) || isTemplated(val)) continue;
      const { p } = splitUrl(val);
      if (!DATA_EXT.test(p)) continue;
      const off = f.index + f[0].indexOf(val, 6);
      const dynamic = !!f[3] && /[?&]$/.test(val);
      if (f[3] && !dynamic) continue;   // fetch('x.json' + 后缀)：拼出来的 URL 静态判不了，改写反而可能拼成 ?v=..?a=1
      refs.push({ start: off, end: off + val.length, url: val, kind: 'data', src: 'fetch', dynamic });
    }
  }
  if (isJs) {
    const I = /(?:\bimport\s*\(\s*|\bimport\s*(?:[\w$*{}\s,]+?\s*from\s*)?|\bexport\s*[\w$*{}\s,]+?\s*from\s*)(['"])([^'"\n]+)\1/g;
    let m;
    while ((m = I.exec(scan))) {
      const val = m[2];
      if (!/^(\.{1,2}\/|\/)/.test(val) || isTemplated(val) || !ASSET_EXT.test(splitUrl(val).p)) continue;
      const off = m.index + m[0].lastIndexOf(val);
      refs.push({ start: off, end: off + val.length, url: val, kind: 'asset' });
    }
  }
  if (isCss) {
    const C = /@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1/gi;
    let c;
    while ((c = C.exec(scan))) {
      const val = c[2];
      if (isExternal(val) || isTemplated(val) || !/\.css$/i.test(splitUrl(val).p)) continue;
      const off = c.index + c[0].lastIndexOf(val);
      refs.push({ start: off, end: off + val.length, url: val, kind: 'asset' });
    }
  }
  return refs.sort((x, y) => x.start - y.start);
}

/** URL 路径 → 站点根目录下的相对路径（posix）；越出根目录返回 null */
function resolveRef(fromRel, p) {
  let s;
  try { s = decodeURIComponent(p); } catch (_) { s = p; }
  const r = s.startsWith('/') ? path.posix.normalize(s.slice(1)) : path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), s));
  if (r === '..' || r.startsWith('../') || path.posix.isAbsolute(r)) return null;
  return r;
}

/** 普通目录（工作区 / 构建产物）。文件数超过 maxFiles → 抛 code=TOO_MANY_FILES（调用方决定提醒还是跳过） */
function dirFS(root, { maxFiles = MAX_FILES } = {}) {
  return {
    label: root,
    list() {
      const out = [];
      const walk = (abs, rel, depth) => {
        if (depth > 12) return;
        let ents;
        try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (_) { return; }
        for (const e of ents) {
          if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(abs, e.name), rel ? rel + '/' + e.name : e.name, depth + 1); }
          else if (e.isFile()) {
            out.push(rel ? rel + '/' + e.name : e.name);
            if (out.length > maxFiles) { const err = new Error(`目录里文件超过 ${maxFiles} 个，没扫完：${root}`); err.code = 'TOO_MANY_FILES'; throw err; }
          }
        }
      };
      walk(root, '', 0);
      return out.sort();
    },
    read(rel) { try { return fs.readFileSync(path.join(root, ...rel.split('/'))); } catch (_) { return null; } },
  };
}

/** git 里某个提交的树（= 真正要推上线的那一份，不是工作区）。
 *  文本类文件第一次 read 时用一个 `git cat-file --batch` 进程整批读进来（逐个 cat-file 每个要 ~90ms，300 页就要 26 秒）。 */
function gitFS(repo, ref, sub) {
  const { execFileSync } = require('child_process');
  const git = (args, enc, input) => execFileSync('git', ['-C', repo, ...args], { encoding: enc, maxBuffer: 512 * 1024 * 1024, input, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'ignore'] });
  const prefix = sub ? sub.replace(/\/+$/, '') + '/' : '';
  const BATCH = /\.(html?|css|m?js|json|csv|tsv|geojson|xml|txt|svg)$/i;
  let listed = null, blobs = null;
  const sizes = new Map();
  function list() {
    const raw = git(['ls-tree', '-r', '-z', '-l', ref, ...(prefix ? ['--', prefix] : [])], 'utf8');
    listed = [];
    for (const e of raw.split('\0')) {
      const tab = e.indexOf('\t');
      if (tab < 0) continue;
      const meta = e.slice(0, tab).trim().split(/\s+/), name = e.slice(tab + 1);
      if (meta[1] !== 'blob' || name.split('/').some((seg) => SKIP_DIRS.has(seg))) continue;
      const rel = name.slice(prefix.length);
      listed.push(rel); sizes.set(rel, Number(meta[3]) || 0);
    }
    return listed;
  }
  function prefetch() {
    blobs = new Map();
    let budget = 300 * 1024 * 1024;
    const want = (listed || list()).filter((f) => BATCH.test(f) && sizes.get(f) < 16 * 1024 * 1024 && (budget -= sizes.get(f)) > 0);
    if (!want.length) return;
    const out = git(['cat-file', '--batch'], null, want.map((f) => `${ref}:${prefix}${f}`).join('\n') + '\n');
    let pos = 0;
    for (const f of want) {
      const nl = out.indexOf(10, pos);
      if (nl < 0) break;
      const m = out.slice(pos, nl).toString('utf8').match(/^[0-9a-f]+ (\w+) (\d+)$/);
      pos = nl + 1;
      if (!m) continue;                                  // "<name> missing"
      const size = Number(m[2]);
      if (m[1] === 'blob') blobs.set(f, out.slice(pos, pos + size));
      pos += size + 1;
    }
  }
  return {
    label: `${repo} @ ${ref}${sub ? ' /' + sub : ''}`,
    list,
    read(rel) {
      if (!blobs) { try { prefetch(); } catch (_) { blobs = new Map(); } }
      if (blobs.has(rel)) return blobs.get(rel);
      try { return git(['cat-file', 'blob', `${ref}:${prefix}${rel}`], null); } catch (_) { return null; }
    },
  };
}

/**
 * Flutter Web 产物（flutter build web）的内容哈希链。2026-10-23 用 Flutter 3.44.2 实测（scratchpad/flutter-research）：
 *   index.html / flutter_bootstrap.js / main.dart.js / main.dart.js_N.part.js 文件名固定、内容每次构建都变；
 *   flutter_service_worker.js 已是自注销的清理版，不再缓存 → 只剩 HTTP 缓存头在防「新旧混搭」。
 *   实测复现过：.js 被缓存而 .json 没被缓存 → 旧 main.dart.js + 新 assets；资源改名 → 页面卡死在加载；deferred part 不匹配 → DeferredLoadException。
 * 链：index.html → flutter_bootstrap.js?v=<h> → buildConfig.mainJsPath "main.dart.js?v=<h>" → deferred part 改名 main.dart.js_N.<h>.part.js
 *   （deferred part 不能用 ?v=：dart2js 运行时会把 ? 编码成 %3F → 404，只能改文件名）。
 * 管不到：assets/**、canvaskit/**、version.json、manifest.json —— 引擎拼路径时不带参数，必须靠服务端 no-cache。
 * 返回 Map(rel → 改写后的 Buffer)；renames 记录改名；problems 带 kind。
 */
function flutterPrepass(fsx, files, write, problems, renames) {
  const over = new Map();
  const has = new Set(files);
  const push = (p) => problems.push({ flutter: true, ...p });
  const utf8 = (b) => Buffer.from(b.toString('utf8'), 'utf8').equals(b);   // 非 UTF-8 不改写（toString 会把坏字节换成 U+FFFD，写回就改坏了）
  let main = fsx.read('main.dart.js');
  if (!main) return over;
  let mainText = main.toString('utf8');
  const mainOk = utf8(main);
  if (!mainOk) push({ kind: 'encoding', file: 'main.dart.js', line: 1, url: '', why: 'main.dart.js 不是合法 UTF-8，不能自动改写 deferred part 名' });
  const m = mainOk ? mainText.match(/deferredPartUris:\[([^\]]*)\]/) : null;
  if (m) {
    const line = lineOf(mainText, m.index);
    const patched = m[1].replace(/"([^"]+)"/g, (all, u) => {
      const hashed = u.match(new RegExp('^(.+)\\.([0-9a-f]{' + HASH_LEN + '})\\.part\\.js$'));
      if (hashed) {
        const b = fsx.read(u);
        if (!b) push({ kind: 'notfound', file: 'main.dart.js', line, url: u, why: 'deferred part 在 main.dart.js 里登记了，但文件不存在' });
        else if (contentHash(u, b) !== hashed[2]) push({ kind: 'stale', file: 'main.dart.js', line, url: u, why: `deferred part 文件名里的哈希 ≠ 内容哈希 ${contentHash(u, b)}` });
        return all;
      }
      const pm = u.match(/^(.+)\.part\.js$/);
      const b = pm && has.has(u) ? fsx.read(u) : null;
      if (!b) { push({ kind: 'notfound', file: 'main.dart.js', line, url: u, why: 'deferred part 认不出或文件不存在' }); return all; }
      const want = `${pm[1]}.${contentHash(u, b)}.part.js`;
      push({ kind: 'missing', file: 'main.dart.js', line, url: u, want, why: `deferred part 文件名不带内容哈希（应改名 ${want}）` });
      if (write) { renames.set(u, want); over.set(want, b); }
      return `"${want}"`;
    });
    if (write && patched !== m[1]) { mainText = mainText.replace(m[0], () => `deferredPartUris:[${patched}]`); main = Buffer.from(mainText, 'utf8'); over.set('main.dart.js', main); }
  }
  const boot = fsx.read('flutter_bootstrap.js');
  if (!boot) return over;
  if (!utf8(boot)) { push({ kind: 'encoding', file: 'flutter_bootstrap.js', line: 1, url: '', why: 'flutter_bootstrap.js 不是合法 UTF-8，不能自动改写' }); return over; }
  let bootText = boot.toString('utf8');
  const c = bootText.match(/_flutter\.buildConfig\s*=\s*(\{[^\n]*\});/);
  if (!c) { push({ kind: 'missing', file: 'flutter_bootstrap.js', line: 1, url: '', why: '找不到 _flutter.buildConfig（自定义 bootstrap？）——无法自动核对 main.dart.js 的版本' }); return over; }
  let cfg;
  try { cfg = JSON.parse(c[1]); } catch (_) { push({ kind: 'other', file: 'flutter_bootstrap.js', line: lineOf(bootText, c.index), url: '', why: '_flutter.buildConfig 不是合法 JSON' }); return over; }
  const line = lineOf(bootText, c.index);
  let changed = false;
  for (const b of cfg.builds || []) {
    for (const k of ['mainJsPath', 'mainWasmPath', 'jsSupportRuntimePath']) {
      if (typeof b[k] !== 'string') continue;
      const { p, q } = splitUrl(b[k]);
      const buf = over.get(p) || fsx.read(p);
      if (!buf) { push({ kind: 'notfound', file: 'flutter_bootstrap.js', line, url: b[k], why: `buildConfig.${k} 指向的文件不存在` }); continue; }
      const h = contentHash(p, buf), cur = getV(q);
      if (cur === h) continue;
      const want = setV(b[k], h);
      push({ kind: cur == null ? 'missing' : 'stale', file: 'flutter_bootstrap.js', line, url: b[k], want, why: cur == null ? `buildConfig.${k} 缺版本号` : `buildConfig.${k} 版本号过期（写的 ${cur}，内容哈希是 ${h}）` });
      b[k] = want; changed = true;
    }
  }
  if (write && changed) { bootText = bootText.replace(c[1], () => JSON.stringify(cfg)); over.set('flutter_bootstrap.js', Buffer.from(bootText, 'utf8')); }
  return over;
}
const FLUTTER_LEAF = /^(main\.dart\.(js|wasm|mjs)|flutter\.js|flutter_bootstrap\.js|flutter_service_worker\.js|main\.dart\.js_\d+(\.[0-9a-f]+)?\.part\.js|canvaskit\/.*|assets\/.*)$/;

/**
 * 核心：分析（可选改写）一个站点。
 * problems[].kind：missing 缺版本号 · stale 过期 · notfound 文件不存在 · dynamic 动态参数 · outside 越界 · encoding 非 UTF-8 · other
 * @returns {{problems, rewrites: Map<string,string|Buffer>, renames: Map<string,string>, flutter: boolean, htmlCount: number}}
 */
function analyze(fsx, opts = {}) {
  const write = !!opts.write;
  const files = fsx.list();
  const htmlFiles = files.filter((f) => /\.html?$/i.test(f));
  const cache = new Map();
  const visiting = new Set();
  const problems = [];
  const rewrites = new Map();
  const renames = new Map();
  const flutter = files.includes('flutter_bootstrap.js') && files.includes('main.dart.js');
  const over = flutter ? flutterPrepass(fsx, files, write, problems, renames) : new Map();
  for (const [rel, buf] of over) if (!renames.has(rel) && ![...renames.values()].includes(rel)) rewrites.set(rel, buf);
  const read = (rel) => (over.has(rel) ? over.get(rel) : fsx.read(rel));

  /** pageRel = 引出这个文件的页面（JS 里 fetch 的相对路径按页面解析） */
  function processText(rel, text, pageRel) {
    const refs = extractRefs(rel, text);
    const inJs = /\.m?js$/i.test(rel);
    let out = text;
    for (let i = refs.length - 1; i >= 0; i--) {
      const r = refs[i];
      const line = lineOf(text, r.start);
      if (r.dynamic) { problems.push({ kind: 'dynamic', file: rel, line, url: r.url, why: '动态缓存参数（如 Date.now()）——改成按内容哈希 ?v=' }); continue; }
      const { p, q } = splitUrl(r.url);
      if (hasBuildHash(p) || /^\/cdn-cgi\//.test(p)) continue;
      const isFetch = r.src === 'fetch';
      let target = isFetch && inJs && pageRel ? resolveRef(pageRel, p) : resolveRef(rel, p);
      if (isFetch && inJs && pageRel && (!target || read(target) == null)) { const alt = resolveRef(rel, p); if (alt && read(alt) != null) target = alt; }
      if (!target) { if (!isFetch) problems.push({ kind: 'outside', file: rel, line, url: r.url, why: '指到站点根目录外，无法核对' }); continue; }
      if (visiting.has(target)) continue;   // ES module 循环 import 的回边：互相包含对方哈希，无解 → 不打
      const t = finalOf(target, /\.html?$/i.test(rel) ? rel : pageRel);
      if (!t) { if (!isFetch) problems.push({ kind: 'notfound', file: rel, line, url: r.url, why: '引用的文件不存在（线上会 404）' }); continue; }   // fetch 不存在的文件多半是服务端路由（/api/x.json），不管
      const cur = getV(q);
      if (cur === t.hash) continue;
      const want = setV(r.url, t.hash);
      problems.push({ kind: cur == null ? 'missing' : 'stale', file: rel, line, url: r.url, want, why: cur == null ? '缺版本号' : `版本号过期（写的 ${cur}，内容哈希是 ${t.hash}）` });
      if (write) out = out.slice(0, r.start) + want + out.slice(r.end);
    }
    return out;
  }

  function finalOf(rel, pageRel) {
    if (cache.has(rel)) return cache.get(rel);
    const raw = read(rel);
    if (raw == null) return null;
    let buf = raw;
    if (TEXT_EXT.test(rel) && !hasBuildHash('/' + rel) && !visiting.has(rel) && !(flutter && FLUTTER_LEAF.test(rel))) {
      const text = raw.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(raw)) {
        if (extractRefs(rel, raw.toString('latin1')).length) problems.push({ kind: 'encoding', file: rel, line: 1, url: '', why: '文件不是 UTF-8，不能自动改写，请先转成 UTF-8' });
      } else {
        visiting.add(rel);
        const out = processText(rel, text, /\.html?$/i.test(rel) ? rel : pageRel);
        visiting.delete(rel);
        if (write && out !== text) { buf = Buffer.from(out, 'utf8'); rewrites.set(rel, out); }
      }
    }
    const r = { buf, hash: contentHash(rel, buf) };
    cache.set(rel, r);
    return r;
  }

  for (const h of htmlFiles) finalOf(h);
  problems.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  return { problems, rewrites, renames, flutter, htmlCount: htmlFiles.length };
}

/** 只查单个 HTML 文件（写文件时的提醒用）；root 用来解析 /xxx 这种根路径 */
function checkOneFile(root, absFile) {
  const rel = path.relative(root, absFile).split(path.sep).join('/');
  const fsx = dirFS(root);
  const one = { label: root, list: () => [rel], read: fsx.read };
  return analyze(one).problems.filter((p) => p.file === rel);
}

function formatProblems(problems, max = 40) {
  const lines = problems.slice(0, max).map((p) => `  ${p.file}:${p.line}  ${p.url || ''}  → ${p.why}`);
  if (problems.length > max) lines.push(`  …… 另有 ${problems.length - max} 条`);
  return lines.join('\n');
}

function cli(argv) {
  const mode = argv.includes('--write') ? 'write' : argv.includes('--check') ? 'check' : null;
  const dir = argv.filter((a) => !a.startsWith('--'))[0];
  if (!mode || !dir) {
    console.error('用法：node asset-stamp.js --write <站点根目录>  |  --check <站点根目录>');
    return 2;
  }
  const root = path.resolve(dir);
  if (!fs.existsSync(root)) { console.error(`目录不存在：${root}`); return 2; }
  if (mode === 'write') {
    const r = analyze(dirFS(root), { write: true });
    // Flutter deferred part 改名：先复制出新名 → 再写 main.dart.js → 最后删旧名。中途任何一步失败，旧名都还在，重跑能自愈。
    const abs = (rel) => path.join(root, ...rel.split('/'));
    for (const [from, to] of r.renames) fs.copyFileSync(abs(from), abs(to));
    for (const [rel, text] of r.rewrites) fs.writeFileSync(abs(rel), text, 'utf8');
    for (const [from, to] of r.renames) { fs.unlinkSync(abs(from)); console.log(`  改名 ${from} → ${to}`); }
    const after = analyze(dirFS(root));
    console.log(`asset-stamp --write ${root}：扫了 ${r.htmlCount} 个 HTML，改写 ${r.rewrites.size} 个文件（${r.problems.length - after.problems.length} 处版本号）`);
    for (const rel of r.rewrites.keys()) console.log('  改写 ' + rel);
    if (after.problems.length) { console.error(`❌ 还有 ${after.problems.length} 处没法自动修：\n${formatProblems(after.problems)}`); return 1; }
    console.log('✅ 复查：所有本地 CSS/JS/数据引用都带正确的内容哈希版本号');
    return 0;
  }
  const r = analyze(dirFS(root));
  if (r.problems.length) { console.error(`❌ ${r.problems.length} 处本地引用没带正确的内容哈希版本号（${root}）：\n${formatProblems(r.problems)}`); return 1; }
  console.log(`✅ ${root}：${r.htmlCount} 个 HTML，所有本地 CSS/JS/数据引用都带正确的内容哈希版本号`);
  return 0;
}

if (require.main === module) process.exit(cli(process.argv.slice(2)));

module.exports = { analyze, dirFS, gitFS, checkOneFile, extractRefs, hasBuildHash, hash8, contentHash, setV, getV, splitUrl, resolveRef, formatProblems, cli, maskJsComments, isTemplated, HASH_LEN, SKIP_DIRS, MAX_FILES };

#!/usr/bin/env node
// @tool-not-hook —— 共享工具 + 命令行，不注册进 settings.json。被 cache-version-gate.js require；
//                   各网站仓库也放一份同字节副本在 tools/asset-stamp.js，当构建 / 部署前的一步。
/*
 * asset-stamp.js — 给网站里引用的本地 CSS / JS（以及 JS 里 fetch 的本地数据文件）打「按内容哈希」的版本号
 * ------------------------------------------------------------------
 * MAX 亲定硬规则（2026-10-23）：style.css?v=<sha256 前 8 位>。内容不变 → 版本号不变；一改 → 自动变。
 * 起因：GitHub Pages 对所有文件给 max-age=600，technoce.com 的 build.py 引用 CSS/JS 不带版本号
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
 * 不管：CSS 里 url() 的图片 / 字体、模板字符串里带 ${} 的 fetch 路径（静态判不了）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HASH_LEN = 8;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.github', '.wrangler', '.vercel', '.dart_tool', '.idea', '.vscode']);
const ASSET_EXT = /\.(css|m?js)$/i;
const DATA_EXT = /\.(json|csv|tsv|geojson|xml|txt)$/i;
const TEXT_EXT = /\.(html?|css|m?js)$/i;
const LINK_REL_SKIP = /\b(canonical|alternate|icon|shortcut|apple-touch-icon|mask-icon|manifest|preconnect|dns-prefetch|author|license|me|search)\b/i;

const LF_EXT = /\.(html?|css|m?js|json|csv|tsv|geojson|xml|txt|svg)$/i;
function hash8(buf) { return crypto.createHash('sha256').update(buf).digest('hex').slice(0, HASH_LEN); }
/**
 * 文本文件先把 CRLF 统一成 LF 再算哈希。
 * 🔴 为什么（2026-10-23 实测）：本机 git 系统级 core.autocrlf=true —— evox 工作区 style.css 有 229 个 CR，
 *    GitHub 上存的 / Pages 发出去的是 LF。不统一的话：本机按 CRLF 算的 ?v= ≠ 线上内容，
 *    门（查 git 提交）永远判「过期」，CI（Linux）算的又是另一个值。统一后三处一致；只改换行不改内容 → 版本号不变（本来就该不变）。
 */
function contentHash(rel, buf) {
  if (LF_EXT.test(rel) && buf.includes(13)) return hash8(Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1'));
  return hash8(buf);
}
function isExternal(u) { return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(u); }
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
/** 文件名自带构建哈希？纯小写单词（-polyfills / -bootstrap）不算哈希。 */
function hasBuildHash(p) {
  if (/\/_next\/static\//.test(p)) return true;
  const base = String(p).split('/').pop();
  const m = base.match(/[-.]([A-Za-z0-9_-]{8,})\.(?:m?js|css)$/);
  return !!m && !/^[a-z-]+$/.test(m[1]);
}
function lineOf(text, idx) { let n = 1; for (let i = 0; i < idx; i++) if (text.charCodeAt(i) === 10) n++; return n; }
/** 把 HTML 注释抹成空格（保留偏移），注释里的旧 <link> 不算。 */
function maskHtmlComments(t) { return t.replace(/<!--[\s\S]*?-->/g, (s) => s.replace(/[^\n]/g, ' ')); }

/** 抽出一段文本里的本地引用：[{start,end,url,kind,dynamic}]，start/end 是 URL 本身在 text 里的偏移 */
function extractRefs(rel, text) {
  const refs = [];
  const isHtml = /\.html?$/i.test(rel), isJs = /\.m?js$/i.test(rel), isCss = /\.css$/i.test(rel);
  const scan = isHtml ? maskHtmlComments(text) : text;
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
        if (!val || isExternal(val)) continue;
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
      if (!val || isExternal(val) || val.includes('${')) continue;
      const { p } = splitUrl(val);
      if (!DATA_EXT.test(p)) continue;
      const off = f.index + f[0].indexOf(val, 6);
      const dynamic = !!f[3] && /[?&]$/.test(val);
      refs.push({ start: off, end: off + val.length, url: val, kind: 'data', dynamic });
    }
  }
  if (isJs) {
    const I = /(?:\bimport\s*\(\s*|\bimport\s*(?:[\w$*{}\s,]+?\s*from\s*)?|\bexport\s*[\w$*{}\s,]+?\s*from\s*)(['"])([^'"\n]+)\1/g;
    let m;
    while ((m = I.exec(scan))) {
      const val = m[2];
      if (!/^(\.{1,2}\/|\/)/.test(val) || !ASSET_EXT.test(splitUrl(val).p)) continue;
      const off = m.index + m[0].lastIndexOf(val);
      refs.push({ start: off, end: off + val.length, url: val, kind: 'asset' });
    }
  }
  if (isCss) {
    const C = /@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1/gi;
    let c;
    while ((c = C.exec(scan))) {
      const val = c[2];
      if (isExternal(val) || !/\.css$/i.test(splitUrl(val).p)) continue;
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

/** 普通目录（工作区 / 构建产物） */
function dirFS(root) {
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
          else if (e.isFile()) out.push(rel ? rel + '/' + e.name : e.name);
        }
      };
      walk(root, '', 0);
      return out;
    },
    read(rel) { try { return fs.readFileSync(path.join(root, ...rel.split('/'))); } catch (_) { return null; } },
  };
}

/** git 里某个提交的树（= 真正要推上线的那一份，不是工作区） */
function gitFS(repo, ref, sub) {
  const { execFileSync } = require('child_process');
  const git = (args, enc) => execFileSync('git', ['-C', repo, ...args], { encoding: enc, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  const prefix = sub ? sub.replace(/\/+$/, '') + '/' : '';
  return {
    label: `${repo} @ ${ref}${sub ? ' /' + sub : ''}`,
    list() {
      const raw = git(['ls-tree', '-r', '-z', '--name-only', ref, ...(prefix ? ['--', prefix] : [])], 'utf8');
      return raw.split('\0').filter(Boolean)
        .filter((f) => !f.split('/').some((seg) => SKIP_DIRS.has(seg)))
        .map((f) => f.slice(prefix.length));
    },
    read(rel) { try { return git(['cat-file', 'blob', `${ref}:${prefix}${rel}`], null); } catch (_) { return null; } },
  };
}

/**
 * 核心：分析（可选改写）一个站点。
 * @returns {{problems: Array<{file,line,url,why,want?}>, rewrites: Map<string,string>, flutter: boolean, htmlCount: number}}
 */
function analyze(fsx, opts = {}) {
  const write = !!opts.write;
  const files = fsx.list();
  const htmlFiles = files.filter((f) => /\.html?$/i.test(f));
  const cache = new Map();
  const visiting = new Set();
  const problems = [];
  const rewrites = new Map();

  function processText(rel, text) {
    const refs = extractRefs(rel, text);
    let out = text;
    for (let i = refs.length - 1; i >= 0; i--) {
      const r = refs[i];
      const line = lineOf(text, r.start);
      if (r.dynamic) { problems.push({ file: rel, line, url: r.url, why: '动态缓存参数（如 Date.now()）——改成按内容哈希 ?v=' }); continue; }
      const { p, q } = splitUrl(r.url);
      if (hasBuildHash(p)) continue;
      const target = resolveRef(rel, p);
      if (!target) { problems.push({ file: rel, line, url: r.url, why: '指到站点根目录外，无法核对' }); continue; }
      const t = finalOf(target);
      if (!t) { problems.push({ file: rel, line, url: r.url, why: '引用的文件不存在（线上会 404）' }); continue; }
      const cur = getV(q);
      if (cur === t.hash) continue;
      const want = setV(r.url, t.hash);
      problems.push({ file: rel, line, url: r.url, want, why: cur == null ? '缺版本号' : `版本号过期（写的 ${cur}，内容哈希是 ${t.hash}）` });
      if (write) out = out.slice(0, r.start) + want + out.slice(r.end);
    }
    return out;
  }

  function finalOf(rel) {
    if (cache.has(rel)) return cache.get(rel);
    const raw = fsx.read(rel);
    if (raw == null) return null;
    let buf = raw;
    if (TEXT_EXT.test(rel) && !hasBuildHash('/' + rel) && !visiting.has(rel)) {
      const text = raw.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(raw)) {
        if (extractRefs(rel, raw.toString('latin1')).length) problems.push({ file: rel, line: 1, url: '', why: '文件不是 UTF-8，不能自动改写，请先转成 UTF-8' });
      } else {
        visiting.add(rel);
        const out = processText(rel, text);
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
  const flutter = files.includes('flutter_bootstrap.js') || files.includes('main.dart.js');
  return { problems, rewrites, flutter, htmlCount: htmlFiles.length };
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
    for (const [rel, text] of r.rewrites) fs.writeFileSync(path.join(root, ...rel.split('/')), text, 'utf8');
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

module.exports = { analyze, dirFS, gitFS, checkOneFile, extractRefs, hasBuildHash, hash8, contentHash, setV, getV, splitUrl, resolveRef, formatProblems, cli, HASH_LEN };

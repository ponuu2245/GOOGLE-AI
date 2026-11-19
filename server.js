// server.js — 구글 AI 모드용 로컬 파일 브릿지
// 실행: node server.js "폴더 경로" [--share [분]]
//   --share : 터널(cloudflared)로 바깥에 보여 줄 읽기 전용 비밀 주소를 연다. 기본 60분 뒤 닫힘.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 3006;
const argv = process.argv.slice(2);
const rawRoot = argv.find(a => !a.startsWith('--') && !/^\d+$/.test(a)) || process.cwd();
const shareIdx = argv.indexOf('--share');
const SHARE_MINUTES = shareIdx === -1 ? 0 : (parseInt(argv[shareIdx + 1], 10) || 60);
const SHARE_TOKEN = SHARE_MINUTES ? crypto.randomBytes(24).toString('base64url') : null;
const SHARE_UNTIL = Date.now() + SHARE_MINUTES * 60000;

if (!fs.existsSync(rawRoot) || !fs.statSync(rawRoot).isDirectory()) {
  console.error(`❌ 유효한 폴더 경로가 아닙니다: ${rawRoot}`);
  process.exit(1);
}

const ROOT_DIR = fs.realpathSync(path.resolve(rawRoot));
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const MAX_OUT = 7000; // AI 모드 입력창(최대 8192자)에 넣을 결과 최대 글자 수

// 민감 파일·폴더 차단 (대소문자 무시)
const BLOCKED_NAME = /^(\.env(\..*)?|id_rsa.*|id_ed25519.*|id_ecdsa.*|.*\.(pem|key|p12|pfx|kdbx))$/i;
const BLOCKED_DIR = new Set(['.git', '.ssh', '.aws', '.gnupg']);
const SKIP_DIR = new Set(['node_modules', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv']);

function isOutside(rel) {
  return rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
}

function isBlockedRel(rel) {
  const parts = rel.split(path.sep).filter(Boolean);
  return parts.some(p => BLOCKED_DIR.has(p.toLowerCase())) || (parts.length > 0 && BLOCKED_NAME.test(parts[parts.length - 1]));
}

function safeResolve(relPath = '.') {
  const resolved = path.resolve(ROOT_DIR, String(relPath));
  const rel = path.relative(ROOT_DIR, resolved);
  if (isOutside(rel)) throw new Error('보안 제한: 루트 폴더 밖에는 접근할 수 없습니다.');

  // 있는 경로면 그 자신, 없는 경로(새 파일)면 가장 가까운 있는 상위 폴더의 실제 위치를 검사
  let probe = resolved;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  if (isOutside(path.relative(ROOT_DIR, fs.realpathSync(probe)))) {
    throw new Error('보안 제한: 링크를 통한 외부 접근이 차단되었습니다.');
  }
  if (isBlockedRel(rel)) throw new Error(`보안 제한: 민감 파일/폴더(${path.basename(resolved)})는 열 수 없습니다.`);
  return resolved;
}

function readText(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error(`일반 파일이 아니거나 존재하지 않습니다: ${label}`);
  if (fs.statSync(filePath).size > 2 * 1024 * 1024) throw new Error('파일이 너무 큽니다 (2MB 이하만 지원).');
  const buf = fs.readFileSync(filePath);
  if (buf.includes(0)) throw new Error('바이너리 파일은 읽을 수 없습니다.');
  return buf.toString('utf-8');
}

function clip(text) {
  return text.length > MAX_OUT ? text.slice(0, MAX_OUT) + '\n...[글자 수 제한으로 생략됨]' : text;
}

// 줄 단위 차이 (LCS). 바뀐 곳 앞뒤 2줄만 보여 준다.
function lineDiff(oldText, newText) {
  const a = oldText.split(/\r?\n/), b = newText.split(/\r?\n/);
  if (a.length * b.length > 4e6) return `(파일이 커서 줄 비교 생략: ${a.length}줄 → ${b.length}줄)`;
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { ops.push([' ', a[i], i + 1]); i++; j++; }
    else if (j < b.length && (i === a.length || dp[i][j + 1] >= dp[i + 1][j])) { ops.push(['+', b[j], j + 1]); j++; }
    else { ops.push(['-', a[i], i + 1]); i++; }
  }
  const keep = new Set();
  ops.forEach((o, k) => { if (o[0] !== ' ') for (let d = -2; d <= 2; d++) keep.add(k + d); });
  if (!keep.size) return '(바뀐 내용 없음)';
  const out = [];
  let last = -1;
  ops.forEach((o, k) => {
    if (!keep.has(k)) return;
    if (last !== -1 && k !== last + 1) out.push('  ...');
    out.push(`${o[0]} ${o[1]}`);
    last = k;
  });
  return out.join('\n');
}

function writeWithBackup(filePath, text) {
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('쓰려는 내용이 너무 큽니다 (1MB 이하).');
  if (fs.existsSync(filePath)) fs.copyFileSync(filePath, filePath + '.bak');
  else fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf-8');
}

function walkFiles(dir, out, limit = 5000) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= limit) return;
    const full = path.join(dir, d.name);
    const rel = path.relative(ROOT_DIR, full);
    if (isBlockedRel(rel) || d.isSymbolicLink()) continue;
    if (d.isDirectory()) { if (!SKIP_DIR.has(d.name)) walkFiles(full, out, limit); }
    else if (d.isFile() && !d.name.endsWith('.bak')) out.push(full);
  }
}

const OUTLINE_RE = /^\s*(export\s+)?(default\s+)?(async\s+)?(function|class|def|interface|type|enum|struct|fn|func|impl)\b|^\s*#{1,6}\s|^\s*(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s*)?(\(|function|\w+\s*=>)|^\s*(public|private|protected|static)\s/;

function runTool(tool, args) {
  if (tool === 'list_dir') {
    const dirPath = safeResolve(args.path || '.');
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) throw new Error(`폴더를 찾을 수 없습니다: ${args.path || '.'}`);
    const items = fs.readdirSync(dirPath, { withFileTypes: true })
      .slice(0, 200)
      .map(d => (d.isDirectory() ? `[DIR] ${d.name}` : `[FILE] ${d.name}`));
    return items.join('\n') || '(비어 있음)';
  }

  if (tool === 'read_file') {
    if (!args.path) throw new Error('파일 경로(path)가 필요합니다.');
    const lines = readText(safeResolve(args.path), args.path).split(/\r?\n/);
    const start = Math.max(1, parseInt(args.startLine, 10) || 1);
    const end = Math.max(start, parseInt(args.endLine, 10) || start + 119);
    const body = lines.slice(start - 1, end).map((l, k) => `${start + k}| ${l}`).join('\n');
    return `파일: ${args.path} (${start}~${Math.min(end, lines.length)}줄 / 총 ${lines.length}줄)\n${clip(body)}`;
  }

  if (tool === 'grep') {
    if (!args.pattern) throw new Error('찾을 말(pattern)이 필요합니다.');
    let re;
    try { re = new RegExp(String(args.pattern), args.caseSensitive ? '' : 'i'); }
    catch (_) { re = new RegExp(String(args.pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), args.caseSensitive ? '' : 'i'); }
    const base = safeResolve(args.path || '.');
    const files = [];
    if (fs.statSync(base).isFile()) files.push(base); else walkFiles(base, files);
    const hits = [];
    for (const f of files) {
      let text;
      try { text = readText(f, f); } catch (_) { continue; }
      text.split(/\r?\n/).forEach((line, k) => {
        if (hits.length < 80 && re.test(line)) hits.push(`${path.relative(ROOT_DIR, f)}:${k + 1}: ${line.trim().slice(0, 160)}`);
      });
      if (hits.length >= 80) break;
    }
    return clip(hits.length ? `"${args.pattern}" 검색 결과 ${hits.length}건${hits.length >= 80 ? '(80건에서 멈춤)' : ''}\n${hits.join('\n')}` : `"${args.pattern}" 검색 결과 없음`);
  }

  if (tool === 'outline') {
    if (!args.path) throw new Error('파일 경로(path)가 필요합니다.');
    const lines = readText(safeResolve(args.path), args.path).split(/\r?\n/);
    const marks = [];
    lines.forEach((l, k) => { if (OUTLINE_RE.test(l)) marks.push(`${k + 1}| ${l.trim().slice(0, 120)}`); });
    return clip(`개요: ${args.path} (총 ${lines.length}줄)\n${marks.join('\n') || '(함수·클래스·제목을 찾지 못함)'}`);
  }

  // 수정 도구: apply가 true일 때만 실제로 쓴다. 아니면 미리보기(차이)만 돌려준다.
  if (tool === 'edit_file') {
    if (!args.path || typeof args.search !== 'string' || typeof args.replace !== 'string') {
      throw new Error('edit_file에는 path, search, replace가 필요합니다.');
    }
    if (!args.search) throw new Error('search가 비어 있습니다.');
    const filePath = safeResolve(args.path);
    const old = readText(filePath, args.path);
    const crlf = old.includes('\r\n');
    const fix = s => (crlf ? s.replace(/\r?\n/g, '\r\n') : s);
    const search = fix(args.search), replace = fix(args.replace);
    const count = old.split(search).length - 1;
    if (count === 0) throw new Error('search 내용을 파일에서 찾지 못했습니다. read_file로 정확한 원문을 다시 확인하세요.');
    if (count > 1) throw new Error(`search 내용이 ${count}곳에 있습니다. 앞뒤 줄을 더 넣어 한 곳만 맞게 하세요.`);
    const next = old.replace(search, () => replace);
    const diff = lineDiff(old, next);
    if (!args.apply) return `미리보기: ${args.path}\n${clip(diff)}`;
    writeWithBackup(filePath, next);
    return `적용됨: ${args.path} (원본은 ${path.basename(filePath)}.bak)\n${clip(diff)}`;
  }

  if (tool === 'write_file') {
    if (!args.path || typeof args.content !== 'string') throw new Error('write_file에는 path, content가 필요합니다.');
    const filePath = safeResolve(args.path);
    const exists = fs.existsSync(filePath);
    const old = exists ? readText(filePath, args.path) : '';
    const content = exists && old.includes('\r\n') ? args.content.replace(/\r?\n/g, '\r\n') : args.content;
    const diff = exists ? lineDiff(old, content) : `(새 파일, ${content.split(/\r?\n/).length}줄)\n${content}`;
    if (!args.apply) return `미리보기: ${args.path}${exists ? '' : ' [새 파일]'}\n${clip(diff)}`;
    writeWithBackup(filePath, content);
    return `적용됨: ${args.path}${exists ? ` (원본은 ${path.basename(filePath)}.bak)` : ' (새 파일)'}\n${clip(diff)}`;
  }

  throw new Error(`지원하지 않는 도구입니다: ${tool}`);
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// 터널 공유: GET /s/<토큰>/<경로> — 폴더면 목록(링크 포함), 파일이면 원문. 읽기 전용.
function handleShare(req, res) {
  const plain = (code, text) => {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' });
    res.end(text);
  };
  const m = req.url.match(/^\/s\/([A-Za-z0-9_-]+)(\/.*)?$/);
  if (req.method !== 'GET' || !SHARE_TOKEN || !m || Date.now() > SHARE_UNTIL) return plain(404, 'not found');
  const a = Buffer.from(m[1]), b = Buffer.from(SHARE_TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return plain(404, 'not found');
  try {
    const rel = decodeURIComponent((m[2] || '/').split('?')[0]).replace(/^\/+/, '') || '.';
    const target = safeResolve(rel);
    if (!fs.existsSync(target)) return plain(404, 'not found');
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const base = `${proto}://${req.headers.host}/s/${SHARE_TOKEN}/`;
    if (fs.statSync(target).isDirectory()) {
      const relDir = path.relative(ROOT_DIR, target).split(path.sep).filter(Boolean);
      const lines = fs.readdirSync(target, { withFileTypes: true })
        .filter(d => !isBlockedRel(path.join(...relDir, d.name)))
        .slice(0, 500)
        .map(d => {
          const p = [...relDir, d.name].map(encodeURIComponent).join('/') + (d.isDirectory() ? '/' : '');
          return `${d.isDirectory() ? '[DIR] ' : '[FILE]'} ${d.name}  ${base}${p}`;
        });
      return plain(200, `폴더: /${relDir.join('/')}\n${lines.join('\n') || '(비어 있음)'}`);
    }
    return plain(200, readText(target, rel));
  } catch (err) {
    return plain(403, err.message);
  }
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/s/')) return handleShare(req, res);

  // 아래 API는 이 컴퓨터의 확장 프로그램 전용.
  // Host 검사: DNS 리바인딩·터널 경유 차단. Origin 검사: 크롬·파이어폭스 확장 프로그램 또는 Origin 없는 요청(curl)만.
  const origin = req.headers.origin;
  if (!ALLOWED_HOSTS.has(req.headers.host || '') || req.headers['cf-connecting-ip'] ||
      (origin && !/^(chrome|moz)-extension:\/\//.test(origin))) {
    return send(res, 403, { ok: false, error: '허용되지 않은 출처입니다.' });
  }
  // CORS는 위를 통과한 확장 프로그램 출처에만 연다. 파이어폭스는 호스트 권한이 있어도 이 헤더가 없으면 응답을 버린다.
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' });
    return res.end();
  }

  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { status: 'ok', rootDir: ROOT_DIR });
  }

  if (req.method === 'POST' && req.url === '/mcp/execute') {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', chunk => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > 2e6) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooBig) return;
      try {
        // 조각을 합친 뒤 디코딩해야 한글이 조각 경계에서 깨지지 않는다
        const { tool, args = {} } = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
        send(res, 200, { ok: true, result: runTool(tool, args || {}) });
      } catch (err) {
        send(res, 400, { ok: false, error: err.message });
      }
    });
    return;
  }

  send(res, 404, { ok: false, error: 'not found' });
});

server.on('error', err => {
  console.error(err.code === 'EADDRINUSE' ? `❌ ${PORT}번 포트가 이미 사용 중입니다.` : err);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`✅ 로컬 브릿지 실행: http://127.0.0.1:${PORT}`);
  console.log(`📂 허용 폴더: ${ROOT_DIR}`);
  if (SHARE_TOKEN) {
    console.log(`🔗 공유 경로(${SHARE_MINUTES}분 뒤 닫힘): /s/${SHARE_TOKEN}/`);
    console.log(`   터널 주소 뒤에 위 경로를 붙여 AI 모드에 주세요. 이 주소를 아는 사람은 누구나 폴더를 읽을 수 있습니다.`);
  }
});

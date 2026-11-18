// background.js — 콘텐츠 스크립트 대신 로컬 서버를 호출한다.
const SERVER_URL = 'http://127.0.0.1:3006';
const TOOLS = new Set(['list_dir', 'read_file', 'grep', 'outline', 'edit_file', 'write_file']);

async function call(path, init) {
  const r = await fetch(SERVER_URL + path, init);
  return r.json();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;

  if (msg?.type === 'MCP_HEALTH') {
    call('/health')
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg?.type === 'MCP_EXEC') {
    const { tool, args } = msg.payload || {};
    if (!TOOLS.has(tool)) {
      sendResponse({ ok: false, error: `지원하지 않는 도구: ${tool}` });
      return false;
    }
    call('/mcp/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool, args: args || {} })
    })
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  return false;
});

// content.js — AI 모드 화면에 패널을 띄우고, 답변 속 도구 호출 JSON을 찾아 실행 버튼을 붙인다.
(() => {
  'use strict';

  const READ_TOOLS = ['list_dir', 'read_file', 'grep', 'outline'];
  const WRITE_TOOLS = ['edit_file', 'write_file'];
  const TOOL_NAMES = [...READ_TOOLS, ...WRITE_TOOLS];
  const INSTR_MARK = '(로컬 파일 브릿지 사용 안내)';
  const RESULT_MARK = '[MCP 실행 결과';
  let autoRun = false;
  let autoApply = false;
  let scanTimer = null;
  const processedCalls = new Set();
  const writeCards = new Map(); // 수정 카드는 상태(미리보기·적용 여부)를 지녀서 다시 만들지 않고 옮겨 붙인다

  // 지침 안에는 JSON 예시를 넣지 않아 지침 자체가 도구 호출로 잡히지 않는다.
  // "[시스템 지침: ...]" 같은 명령조 문구는 AI 모드가 답을 거부해서 대화체로 쓴다.
  const MCP_INSTRUCTION = `${INSTR_MARK} 내 컴퓨터 폴더의 코드를 같이 보려고 해. 너는 파일을 직접 못 보니까, 파일이 필요하면 다른 말 없이 JSON 한 줄로만 요청해 줘. 내 브라우저 확장 프로그램이 그 JSON을 읽고 결과를 다음 메시지로 붙여 줄 거야.
키 mcp_tool 에 도구 이름, 키 args 에 인자 객체를 넣어 줘. 도구는 한 번에 하나만.
- list_dir: path (폴더 목록)
- read_file: path, startLine, endLine (줄 번호가 붙어 옴)
- grep: pattern, path (여러 파일에서 찾기, 정규식 가능)
- outline: path (함수·클래스 위치만)
- edit_file: path, search, replace (search는 파일 원문과 글자 하나까지 같고 한 곳에만 있어야 함. 줄 번호는 빼고)
- write_file: path, content (새 파일 만들거나 통째로 바꿈)
줄바꿈은 JSON 문자열 안에서 \\n 으로 써 줘. 수정은 내가 확인하고 적용해. 큰 파일은 outline이나 grep으로 위치를 먼저 찾고 필요한 줄만 읽어 줘.
질문: `;

  function sendBgMessage(message) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(message, res => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res || { ok: false, error: '응답 없음' });
        });
      } catch (e) {
        // 확장 프로그램을 새로고침하면 기존 탭의 스크립트는 끊긴다
        resolve({ ok: false, error: '확장 프로그램이 다시 로드됨. 페이지를 새로고침하세요.' });
      }
    });
  }

  // 텍스트에서 중괄호 짝을 맞춰 JSON 객체 후보를 뽑고, mcp_tool이 있는 것만 돌려준다.
  function extractCalls(text) {
    const calls = [];
    for (let i = text.indexOf('{'); i !== -1; i = text.indexOf('{', i + 1)) {
      let depth = 0, inStr = false, esc = false;
      for (let j = i; j < text.length; j++) {
        const c = text[j];
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) {
          try {
            const obj = JSON.parse(text.slice(i, j + 1));
            if (obj && TOOL_NAMES.includes(obj.mcp_tool)) {
              calls.push(obj);
              i = j; // 바깥 객체를 썼으면 안쪽은 건너뛴다
            }
          } catch (_) { /* 스트리밍 중이거나 JSON 아님 */ }
          break;
        }
      }
    }
    return calls;
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 140 && rect.height > 18 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  // 화면에서 가장 아래쪽에 있는 보이는 입력창을 AI 모드 후속 질문 입력창으로 본다.
  function findAiModeInput() {
    const candidates = Array.from(
      document.querySelectorAll('textarea, div[contenteditable="true"], div[role="textbox"]')
    ).filter(el => !el.closest('#gmcp-panel') && isVisible(el));
    candidates.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return candidates[candidates.length - 1] || null;
  }

  function setInputValue(el, text) {
    if (!el) {
      alert('입력창을 찾지 못했습니다. 구글 검색에서 [AI 모드] 탭을 먼저 여세요.');
      return false;
    }
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      // execCommand는 실제 타이핑처럼 처리돼 구글 입력창이 '보내기' 버튼을 켠다
      el.select();
      if (document.execCommand('insertText', false, text) && el.value === text) return true;
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter ? setter.call(el, text) : (el.value = text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      if (!document.execCommand('insertText', false, text)) {
        el.textContent = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
      }
    }
    return true;
  }

  // 입력창에서 가까운 조상부터 넓혀 가며 보이는 '보내기/Send' 버튼을 찾는다.
  // (type=submit은 기본값이라 '도구 추가' 같은 다른 버튼도 걸리므로 쓰지 않는다)
  // mustBeVisible=false: 탭이 백그라운드라 화면이 안 그려질 때를 위한 마지막 시도
  function findSendButton(el, mustBeVisible = true) {
    const isSend = b => {
      if (b.closest('#gmcp-panel') || b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
      const label = (b.getAttribute('aria-label') || b.title || '').trim();
      return /^(보내기|전송|제출|send|submit)$/i.test(label) && (!mustBeVisible || b.getBoundingClientRect().width > 0);
    };
    for (let scope = el.parentElement; scope; scope = scope.parentElement) {
      const btn = Array.from(scope.querySelectorAll('button, [role="button"]')).find(isSend);
      if (btn) return btn;
    }
    return null;
  }

  // 보내기 버튼은 입력 직후 조금 늦게 나타나므로 최대 3초 기다린다
  async function submitAiModeInput(el) {
    let sendBtn = null;
    for (let t = 0; t < 15 && !(sendBtn = findSendButton(el)); t++) {
      await new Promise(r => setTimeout(r, 200));
    }
    sendBtn = sendBtn || findSendButton(el, false);
    if (sendBtn) sendBtn.click();
    else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  }

  async function executeMcpTool(callObj, statusEl) {
    if (statusEl) statusEl.textContent = '⏳ 로컬 파일 읽는 중...';
    const res = await sendBgMessage({ type: 'MCP_EXEC', payload: { tool: callObj.mcp_tool, args: callObj.args || {} } });
    const output = res.ok ? res.result : `실행 오류: ${res.error}`;
    const reply = `${RESULT_MARK} - ${callObj.mcp_tool}]\n${output}\n\n위 결과를 바탕으로 답하거나 필요한 파일을 더 요청해줘.`;
    const inputEl = findAiModeInput();
    if (setInputValue(inputEl, reply)) {
      if (statusEl) statusEl.textContent = res.ok ? '✅ 입력창에 넣음' : '⚠️ 오류 메시지를 넣음';
      if (autoRun && res.ok) setTimeout(() => submitAiModeInput(inputEl), 400);
    }
  }

  const BTN_CSS = 'padding:5px 10px;background:#1a73e8;color:#fff;border:none;border-radius:5px;cursor:pointer;font-weight:bold;';

  function makeCard(call, sig) {
    const card = document.createElement('div');
    card.className = 'gmcp-card';
    card.dataset.sig = sig;
    card.style.cssText = 'margin:8px 0;padding:10px 14px;background:#e8f0fe;border:1px solid #4285f4;border-radius:8px;font-size:13px;color:#1f1f1f;display:flex;align-items:center;gap:10px;flex-wrap:wrap;';
    const label = document.createElement('span');
    label.style.fontWeight = '600';
    const status = document.createElement('span');
    status.style.fontSize = '12px';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.style.cssText = BTN_CSS;

    if (!WRITE_TOOLS.includes(call.mcp_tool)) {
      label.textContent = `🛠️ 도구 요청: ${call.mcp_tool}(${JSON.stringify(call.args || {})})`;
      btn.textContent = '▶ 실행 후 결과 넣기';
      btn.onclick = () => executeMcpTool(call, status);
      card.append(label, btn, status);
      return { card, status, run: () => executeMcpTool(call, status) };
    }

    // 수정 요청: 먼저 미리보기(차이)를 보여 주고, 누르면 적용
    card.style.background = '#fef7e0';
    card.style.borderColor = '#f9ab00';
    label.textContent = `✏️ 수정 요청: ${call.mcp_tool} → ${call.args?.path || '?'}`;
    const pre = document.createElement('pre');
    pre.style.cssText = 'flex-basis:100%;margin:4px 0 0;max-height:260px;overflow:auto;background:#fff;border:1px solid #dadce0;border-radius:6px;padding:8px;font:12px/1.4 monospace;white-space:pre;color:#202124;';
    pre.textContent = '미리보기 불러오는 중...';
    btn.textContent = '✅ 적용';
    btn.disabled = true;
    btn.style.background = '#188038';
    card.append(label, btn, status, pre);

    const showDiff = text => {
      pre.textContent = '';
      text.split('\n').forEach(line => {
        const div = document.createElement('div');
        div.textContent = line;
        if (line.startsWith('+ ')) div.style.background = '#e6f4ea';
        else if (line.startsWith('- ')) div.style.background = '#fce8e6';
        pre.appendChild(div);
      });
    };
    const apply = () => applyEdit(call, btn, status, showDiff);
    sendBgMessage({ type: 'MCP_EXEC', payload: { tool: call.mcp_tool, args: { ...call.args, apply: false } } }).then(res => {
      if (!res.ok) {
        showDiff(`미리보기 실패: ${res.error}`);
        status.textContent = '⚠️ 적용할 수 없음 (오류를 AI에게 보내려면 아래 버튼)';
        btn.textContent = '↩ 오류 알려 주기';
        btn.style.background = '#d93025';
        btn.disabled = false;
        btn.onclick = () => injectResult(call, res);
        return;
      }
      showDiff(res.result);
      btn.disabled = false;
      btn.onclick = apply;
      if (autoApply) apply();
    });
    return { card, status, run: null };
  }

  async function applyEdit(call, btn, status, showDiff) {
    btn.disabled = true;
    status.textContent = '⏳ 쓰는 중...';
    const res = await sendBgMessage({ type: 'MCP_EXEC', payload: { tool: call.mcp_tool, args: { ...call.args, apply: true } } });
    if (res.ok) showDiff(res.result);
    status.textContent = res.ok ? '✅ 적용됨 (.bak 백업)' : `⚠️ ${res.error}`;
    btn.textContent = res.ok ? '적용 완료' : '✅ 다시 시도';
    if (!res.ok) btn.disabled = false;
    injectResult(call, res);
  }

  // 결과를 AI 모드 입력창에 넣고, 자동 전송이 켜져 있으면 보낸다
  function injectResult(call, res) {
    const output = res.ok ? res.result : `실행 오류: ${res.error}`;
    const reply = `${RESULT_MARK} - ${call.mcp_tool}]\n${output}\n\n위 결과를 바탕으로 답하거나 필요한 파일을 더 요청해줘.`;
    const inputEl = findAiModeInput();
    if (setInputValue(inputEl, reply) && autoRun) setTimeout(() => submitAiModeInput(inputEl), 400);
  }

  function scanToolCalls() {
    // 스트리밍 중 구글이 답변 요소를 새로 그리면 옛 요소에 붙은 카드가 남으므로 지운다
    document.querySelectorAll('.gmcp-card').forEach(c => { if (!c.gmcpNode?.isConnected) c.remove(); });
    document.querySelectorAll('pre, code, p, div, span').forEach(node => {
      if (node.closest('#gmcp-panel, .gmcp-card, textarea, [contenteditable="true"]')) return;
      const text = node.innerText || '';
      if (!text.includes('mcp_tool')) return;
      // 내가 보낸 지침·결과 말풍선은 건너뜀
      if (text.includes(INSTR_MARK) || text.includes(RESULT_MARK)) return;
      // 가장 안쪽 요소에만 카드를 붙인다 (자식이 이미 그 텍스트를 담고 있으면 자식에게 맡김)
      if (Array.from(node.children).some(ch => !ch.classList.contains('gmcp-card') && (ch.innerText || '').includes('mcp_tool'))) return;

      // innerText는 연속 공백을 하나로 줄여 들여쓰기가 망가지므로, JSON은 textContent에서 뽑는다
      extractCalls(node.textContent || '').forEach(call => {
        // 적용 여부는 사용자만 정한다: AI가 넣은 apply 값은 버린다
        if (call.args && typeof call.args === 'object') delete call.args.apply;
        else call.args = {};
        const sig = `${call.mcp_tool}:${JSON.stringify(call.args || {})}`;
        const bound = (node.dataset.gmcpBound || '').split('\n');
        if (bound.includes(sig)) return;
        node.dataset.gmcpBound = [...bound, sig].filter(Boolean).join('\n');

        // 같은 수정 요청이 다시 그려져도 미리보기·자동 적용이 두 번 일어나지 않게 한 번만 만든다
        if (WRITE_TOOLS.includes(call.mcp_tool) && processedCalls.has(sig)) {
          const old = writeCards.get(sig);
          if (old) { old.gmcpNode = node; node.parentElement?.insertBefore(old, node.nextSibling); }
          return;
        }
        const { card, run } = makeCard(call, sig);
        card.gmcpNode = node;
        node.parentElement?.insertBefore(card, node.nextSibling);
        if (WRITE_TOOLS.includes(call.mcp_tool)) { processedCalls.add(sig); writeCards.set(sig, card); }
        else if (autoRun && run && !processedCalls.has(sig)) {
          processedCalls.add(sig);
          run();
        }
      });
    });
  }

  function createPanel() {
    if (document.getElementById('gmcp-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'gmcp-panel';
    panel.style.cssText = 'position:fixed;bottom:20px;right:20px;width:260px;background:#fff;border:1px solid #dadce0;border-radius:12px;padding:12px;box-shadow:0 4px 16px rgba(0,0,0,0.16);z-index:2147483647;font-family:sans-serif;font-size:12px;color:#202124;';
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <strong style="font-size:13px;color:#1a73e8;">⚡ 로컬 브릿지</strong>
        <span id="gmcp-status" style="font-size:11px;color:#d93025;">● 확인 중</span>
      </div>
      <div id="gmcp-root" style="font-size:11px;color:#5f6368;word-break:break-all;margin-bottom:8px;">서버 대기 중...</div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        <button type="button" id="gmcp-inject-instr" style="padding:7px;background:#1a73e8;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600;">1. 지침 프롬프트 넣기</button>
        <button type="button" id="gmcp-quick-list" style="padding:7px;background:#f1f3f4;color:#202124;border:1px solid #dadce0;border-radius:6px;cursor:pointer;">📂 폴더 목록 바로 넣기</button>
        <label style="display:flex;align-items:center;gap:6px;margin-top:4px;cursor:pointer;">
          <input type="checkbox" id="gmcp-autorun" /> 읽기 도구 자동 실행 + 자동 전송
        </label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;color:#b06000;">
          <input type="checkbox" id="gmcp-autoapply" /> 수정도 묻지 않고 바로 적용 (위험)
        </label>
      </div>`;
    document.body.appendChild(panel);

    let timer = null;
    const checkServer = async () => {
      const st = document.getElementById('gmcp-status');
      const rt = document.getElementById('gmcp-root');
      if (!st || !rt) return clearInterval(timer);
      const res = await sendBgMessage({ type: 'MCP_HEALTH' });
      if (res.ok && res.data?.rootDir) {
        st.style.color = '#188038';
        st.textContent = '● 연결됨';
        rt.textContent = `📁 ${res.data.rootDir}`;
      } else {
        st.style.color = '#d93025';
        st.textContent = '● 서버 꺼짐';
        rt.textContent = '터미널에서 node server.js "폴더" 실행 필요';
      }
    };
    checkServer();
    timer = setInterval(checkServer, 4000);

    document.getElementById('gmcp-inject-instr').onclick = () => {
      const input = findAiModeInput();
      const current = (input?.value ?? input?.innerText ?? '').trim();
      setInputValue(input, MCP_INSTRUCTION + (current || '로컬 폴더에 어떤 파일이 있는지 조회해서 알려줘.'));
    };
    document.getElementById('gmcp-quick-list').onclick = () => {
      executeMcpTool({ mcp_tool: 'list_dir', args: { path: '.' } }, document.getElementById('gmcp-root'));
    };
    document.getElementById('gmcp-autorun').onchange = e => { autoRun = e.target.checked; };
    document.getElementById('gmcp-autoapply').onchange = e => { autoApply = e.target.checked; };
  }

  createPanel();

  // 답변이 스트리밍되는 동안은 기다렸다가 600ms 조용해지면 스캔
  new MutationObserver(() => {
    createPanel();
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanToolCalls, 600);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
})();

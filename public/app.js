'use strict';

/* =============================== 状态 =============================== */

const state = {
  view: 'list', // 'list' | 'detail' | 'session'
  mode: 'view', // 'view' | 'edit'
  script: null, // 当前剧本详情 { id, title, content, current_version, cues }
  sessions: [], // 当前剧本的历次场次
  session: null, // 当前打开的场次详情 { id, name, entries, ... }
  cueModal: null, // { mode:'add', lineNo } | { mode:'edit', cue }
  rebindCue: null, // 正在重绑的提示
  rebindTarget: null, // 重绑弹窗中暂选行号
  flashLineNo: null, // 渲染后需要高亮的行
};

const $ = (id) => document.getElementById(id);

/* =============================== 工具 =============================== */

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let toastTimer = null;
function toast(msg, isError) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('toast-error', !!isError);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

const typeName = { light: '灯光', sound: '音效' };

/* =============================== 视图切换 =============================== */

function showView(view) {
  state.view = view;
  $('listView').classList.toggle('hidden', view !== 'list');
  $('detailView').classList.toggle('hidden', view !== 'detail');
  $('sessionView').classList.toggle('hidden', view !== 'session');
  window.scrollTo(0, 0);
}

function setMode(mode) {
  state.mode = mode;
  const editing = mode === 'edit';
  $('scriptViewer').classList.toggle('hidden', editing);
  $('scriptEditor').classList.toggle('hidden', !editing);
  $('editBtn').classList.toggle('hidden', editing);
  $('saveVersionBtn').classList.toggle('hidden', !editing);
  $('cancelEditBtn').classList.toggle('hidden', !editing);
  $('scriptModeHint').textContent = editing
    ? '修改后点击「保存新版」，系统会重新定位所有提示；无法唯一确认的将标记待确认。'
    : '点击任意台词行，可在旁边添加提示';
}

/* =============================== 剧本列表 =============================== */

async function loadScripts() {
  const scripts = await api('GET', '/api/scripts');
  const box = $('scriptList');
  if (scripts.length === 0) {
    box.innerHTML = '<div class="empty">还没有剧本，先在上方创建一个吧。</div>';
    return;
  }
  box.innerHTML = scripts
    .map((s) => {
      const pending = s.pending_count || 0;
      return `
      <div class="script-item" data-id="${s.id}">
        <div>
          <div class="script-item-title">${escapeHtml(s.title)}</div>
          <div class="script-item-meta">
            v${s.current_version}
            <span class="sep">·</span>${s.cue_count} 条提示
            ${pending > 0 ? `<span class="sep">·</span><span style="color:var(--danger)">${pending} 条待确认</span>` : ''}
            <span class="sep">·</span>更新于 ${escapeHtml(s.updated_at)}
          </div>
        </div>
        <button class="btn btn-sm btn-danger" data-action="delete" data-id="${s.id}">删除</button>
      </div>`;
    })
    .join('');
}

$('scriptList').addEventListener('click', async (e) => {
  const delBtn = e.target.closest('[data-action="delete"]');
  if (delBtn) {
    e.stopPropagation();
    const id = delBtn.dataset.id;
    if (!confirm('确定删除该剧本及其全部提示？此操作不可恢复。')) return;
    await api('DELETE', `/api/scripts/${id}`);
    toast('剧本已删除');
    loadScripts();
    return;
  }
  const item = e.target.closest('.script-item');
  if (item) openScript(item.dataset.id);
});

$('createBtn').addEventListener('click', async () => {
  const title = $('newTitle').value.trim();
  const content = $('newContent').value;
  if (!title) return toast('请填写剧本标题', true);
  const r = await api('POST', '/api/scripts', { title, content });
  $('newTitle').value = '';
  $('newContent').value = '';
  toast('剧本已创建');
  openScript(r.id);
});

/* =============================== 剧本详情 =============================== */

async function openScript(id) {
  state.script = await api('GET', `/api/scripts/${id}`);
  $('detailTitle').textContent = state.script.title;
  $('topbarSub').textContent = state.script.title;
  $('scriptEditor').value = state.script.content;
  setMode('view');
  renderDetail();
  state.sessions = [];
  renderSessions();
  renderRunPanel();
  await loadSessions(id).catch((err) => toast(err.message, true));
  showView('detail');
  syncHash();
}

function cuesByLine() {
  const map = new Map();
  for (const c of state.script.cues) {
    if (c.anchor_status === 'bound' && c.line_no != null) {
      if (!map.has(c.line_no)) map.set(c.line_no, []);
      map.get(c.line_no).push(c);
    }
  }
  return map;
}

function renderDetail() {
  const s = state.script;
  $('versionBadge').textContent = `第 ${s.current_version} 版`;

  renderViewer($('scriptViewer'), s.content, { clickable: true });
  renderCues();
}

/** 通用剧本行渲染（浏览区 & 重绑弹窗） */
function renderViewer(container, content, opts = {}) {
  const lineMap = opts.clickable ? cuesByLine() : null;
  const lines = content === '' ? [] : content.replace(/\r\n/g, '\n').split('\n');

  if (lines.length === 0) {
    container.innerHTML = '<div class="empty">剧本内容为空，请先编辑粘贴文本。</div>';
    return;
  }

  container.innerHTML = lines
    .map((text, i) => {
      const lineNo = i + 1;
      const isEmpty = text.trim() === '';
      if (isEmpty && !opts.showEmpty) {
        return `<div class="script-line empty-line"><span class="line-no">${lineNo}</span><span class="line-text">&nbsp;</span></div>`;
      }
      const cues = lineMap ? lineMap.get(lineNo) || [] : [];
      const classes = ['script-line'];
      if (!isEmpty) classes.push('selectable');
      if (cues.length) classes.push('has-cue');
      if (opts.pendingLineNos && opts.pendingLineNos.includes(lineNo)) classes.push('pending-target');
      if (state.flashLineNo === lineNo) classes.push('flash');

      const chips = cues
        .map(
          (c) =>
            `<span class="chip ${c.type === 'light' ? 'chip-light' : 'chip-sound'}">${
              c.type === 'light' ? '💡' : '🔊'
            } ${escapeHtml(c.label)}</span>`
        )
        .join('');

      return `
        <div class="${classes.join(' ')}" data-line="${lineNo}">
          <span class="line-no">${lineNo}</span>
          <span class="line-text">${escapeHtml(text) || '&nbsp;'}</span>
          ${chips ? `<span class="line-chips">${chips}</span>` : ''}
        </div>`;
    })
    .join('');

  state.flashLineNo = null;
}

function renderCues() {
  const cues = state.script.cues;
  const pending = cues.filter((c) => c.anchor_status === 'pending');
  const bound = cues
    .filter((c) => c.anchor_status === 'bound')
    .sort((a, b) => (a.line_no || 0) - (b.line_no || 0));

  $('cueStats').innerHTML = `
    <span>共 ${cues.length} 条</span>
    <span style="color:var(--ok)">已绑定 ${bound.length}</span>
    <span style="color:${pending.length ? 'var(--danger)' : 'var(--text-dim)'}">待确认 ${pending.length}</span>`;

  // 待确认面板
  const pp = $('pendingPanel');
  if (pending.length === 0) {
    pp.classList.add('hidden');
    pp.innerHTML = '';
  } else {
    pp.classList.remove('hidden');
    pp.innerHTML =
      `<h4>⚠ ${pending.length} 条提示无法唯一定位，需要人工确认</h4>
       <p class="hint" style="margin:0">系统不会把它们自动挂到其他台词上。可使用候选行一键绑定，或打开剧本点选正确行。</p>` +
      pending
        .map((c) => {
          const cands = (c.issue && c.issue.candidates) || [];
          return `
          <div class="pending-item" data-cue="${c.id}">
            <div class="pending-item-top">
              <span class="badge ${c.type === 'light' ? 'badge-light' : 'badge-sound'}">
                ${c.type === 'light' ? '💡 灯光' : '🔊 音效'}
              </span>
              <strong>${escapeHtml(c.label)}</strong>
              <span class="badge badge-pending">待确认</span>
            </div>
            <div class="cue-line">原锚点台词：${escapeHtml(c.anchor_text || '（无）')}</div>
            <div class="pending-reason">${escapeHtml((c.issue && c.issue.detail) || '无法定位')}</div>
            ${
              cands.length
                ? `<div class="hint" style="margin:6px 0 2px">候选位置（第 ${cands
                    .map((x) => x.lineNo)
                    .join('、')} 行）：</div>` +
                  cands
                    .map(
                      (x) => `
                    <div class="candidate-row">
                      <button class="btn btn-sm btn-primary" data-action="bind-candidate"
                              data-cue="${c.id}" data-line="${x.lineNo}">绑到第 ${x.lineNo} 行</button>
                      <span class="candidate-line">${escapeHtml(x.lineText)}</span>
                    </div>`
                    )
                    .join('')
                : ''
            }
            <div class="cue-actions">
              <button class="btn btn-sm" data-action="rebind" data-cue="${c.id}">点选台词重绑…</button>
              <button class="btn btn-sm" data-action="edit" data-cue="${c.id}">编辑内容</button>
              <button class="btn btn-sm btn-danger" data-action="delete" data-cue="${c.id}">删除</button>
            </div>
          </div>`;
        })
        .join('');
  }

  // 已绑定提示列表
  const list = $('cueList');
  if (bound.length === 0) {
    list.innerHTML = pending.length
      ? ''
      : '<div class="empty">暂无提示。在左侧剧本中点击一句台词即可添加。</div>';
  } else {
    list.innerHTML = bound
      .map(
        (c) => `
      <div class="cue-item">
        <div class="cue-item-top">
          <span class="badge ${c.type === 'light' ? 'badge-light' : 'badge-sound'}">
            ${c.type === 'light' ? '💡 灯光' : '🔊 音效'}
          </span>
          <span class="cue-label">${escapeHtml(c.label)}</span>
          <span class="badge badge-ok">第 ${c.line_no} 行 · v${c.version}</span>
        </div>
        <button class="line-link" data-action="goto" data-line="${c.line_no}">📖 ${escapeHtml(
          c.line_text || ''
        )}</button>
        ${c.note ? `<div class="cue-note">📝 ${escapeHtml(c.note)}</div>` : ''}
        <div class="cue-actions">
          <button class="btn btn-sm" data-action="add-here" data-line="${c.line_no}">同行再加提示</button>
          <button class="btn btn-sm" data-action="rebind" data-cue="${c.id}">重新绑定…</button>
          <button class="btn btn-sm" data-action="edit" data-cue="${c.id}">编辑</button>
          <button class="btn btn-sm btn-danger" data-action="delete" data-cue="${c.id}">删除</button>
        </div>
      </div>`
      )
      .join('');
  }
}

/* 剧本区点击行 -> 添加提示 */
$('scriptViewer').addEventListener('click', (e) => {
  if (state.mode !== 'view') return;
  const line = e.target.closest('.script-line.selectable');
  if (!line) return;
  openCueModal({ mode: 'add', lineNo: Number(line.dataset.line) });
});

/* 提示单 / 待确认面板按钮事件 */
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const cueId = Number(btn.dataset.cue);

  if (action === 'goto') {
    const lineNo = Number(btn.dataset.line);
    const el = $('scriptViewer').querySelector(`[data-line="${lineNo}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      state.flashLineNo = lineNo;
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1500);
    }
    return;
  }

  if (action === 'add-here') {
    openCueModal({ mode: 'add', lineNo: Number(btn.dataset.line) });
    return;
  }

  const cue = cueId ? state.script.cues.find((c) => c.id === cueId) : null;

  if (action === 'edit' && cue) {
    openCueModal({ mode: 'edit', cue });
  } else if (action === 'delete' && cue) {
    if (!confirm(`确定删除提示「${cue.label}」？`)) return;
    await api('DELETE', `/api/cues/${cue.id}`);
    toast('提示已删除');
    await openScript(state.script.id);
  } else if (action === 'rebind' && cue) {
    openRebindModal(cue);
  } else if (action === 'bind-candidate') {
    const targetLine = Number(btn.dataset.line);
    await rebindCue(Number(btn.dataset.cue), targetLine, true);
  }
});

/* =============================== 提示弹窗 =============================== */

function openCueModal(modalState) {
  state.cueModal = modalState;
  const isAdd = modalState.mode === 'add';
  $('cueModalTitle').textContent = isAdd ? '添加提示' : '编辑提示';

  const type = isAdd ? 'light' : modalState.cue.type;
  document.querySelectorAll('input[name="cueType"]').forEach((r) => {
    r.checked = r.value === type;
  });
  $('cueLabel').value = isAdd ? '' : modalState.cue.label;
  $('cueNote').value = isAdd ? '' : modalState.cue.note || '';

  if (isAdd) {
    const lines = state.script.content.replace(/\r\n/g, '\n').split('\n');
    $('cueModalLine').textContent = `附着于第 ${modalState.lineNo} 行：${lines[modalState.lineNo - 1] || ''}`;
  } else {
    $('cueModalLine').textContent =
      modalState.cue.anchor_status === 'bound'
        ? `第 ${modalState.cue.line_no} 行：${modalState.cue.line_text || ''}`
        : `待确认 · 原锚点：${modalState.cue.anchor_text || '（无）'}`;
  }
  $('cueModal').classList.remove('hidden');
  $('cueLabel').focus();
}

function closeCueModal() {
  state.cueModal = null;
  $('cueModal').classList.add('hidden');
}

$('cueCancelBtn').addEventListener('click', closeCueModal);
$('cueModal').addEventListener('click', (e) => {
  if (e.target === $('cueModal')) closeCueModal();
});

$('cueSaveBtn').addEventListener('click', async () => {
  const m = state.cueModal;
  const body = {
    type: document.querySelector('input[name="cueType"]:checked').value,
    label: $('cueLabel').value.trim(),
    note: $('cueNote').value.trim(),
  };
  if (!body.label) return toast('请填写提示内容', true);

  try {
    if (m.mode === 'add') {
      await api('POST', `/api/scripts/${state.script.id}/cues`, { ...body, lineNo: m.lineNo });
      toast('提示已添加');
    } else {
      await api('PATCH', `/api/cues/${m.cue.id}`, body);
      toast('提示已保存');
    }
    closeCueModal();
    await openScript(state.script.id);
  } catch (err) {
    toast(err.message, true);
  }
});

/* =============================== 重新绑定弹窗 =============================== */

function openRebindModal(cue) {
  state.rebindCue = cue;
  state.rebindTarget = null;

  $('rebindCueInfo').innerHTML = `
    <span class="badge ${cue.type === 'light' ? 'badge-light' : 'badge-sound'}">
      ${cue.type === 'light' ? '💡 灯光' : '🔊 音效'}
    </span>
    <strong>${escapeHtml(cue.label)}</strong>`;
  $('rebindReason').textContent = cue.issue
    ? `无法自动定位原因：${cue.issue.detail}`
    : '为该提示选择正确的台词行：';

  const cands = (cue.issue && cue.issue.candidates) || [];
  $('rebindCandidates').innerHTML = cands.length
    ? cands
        .map(
          (x) => `
      <div class="candidate-row">
        <button class="btn btn-sm btn-primary" data-rebind-line="${x.lineNo}">绑到第 ${x.lineNo} 行</button>
        <span class="candidate-line">${escapeHtml(x.lineText)}</span>
      </div>`
        )
        .join('')
    : '';

  renderViewer($('rebindViewer'), state.script.content, {
    clickable: false,
    pendingLineNos: cands.map((x) => x.lineNo),
  });
  $('rebindViewer').querySelectorAll('.script-line.selectable').forEach((el) => {
    el.addEventListener('click', async () => {
      await rebindCue(cue.id, Number(el.dataset.line), true);
    });
  });

  $('rebindModal').classList.remove('hidden');
}

$('rebindCandidates').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-rebind-line]');
  if (!btn) return;
  await rebindCue(state.rebindCue.id, Number(btn.dataset.rebindLine), true);
});

async function rebindCue(cueId, lineNo, closeModal) {
  try {
    await api('POST', `/api/cues/${cueId}/rebind`, { lineNo });
    toast(`已绑定到第 ${lineNo} 行`);
    if (closeModal) $('rebindModal').classList.add('hidden');
    state.rebindCue = null;
    state.flashLineNo = lineNo;
    await openScript(state.script.id);
  } catch (err) {
    toast(err.message, true);
  }
}

$('rebindCancelBtn').addEventListener('click', () => {
  $('rebindModal').classList.add('hidden');
  state.rebindCue = null;
});
$('rebindModal').addEventListener('click', (e) => {
  if (e.target === $('rebindModal')) $('rebindModal').classList.add('hidden');
});

/* =============================== 编辑剧本 =============================== */

$('editBtn').addEventListener('click', () => {
  $('scriptEditor').value = state.script.content;
  setMode('edit');
});

$('cancelEditBtn').addEventListener('click', () => setMode('view'));

$('saveVersionBtn').addEventListener('click', async () => {
  const content = $('scriptEditor').value;
  if (content === state.script.content) {
    toast('内容没有变化');
    setMode('view');
    return;
  }
  try {
    const r = await api('PUT', `/api/scripts/${state.script.id}/content`, { content });
    setMode('view');
    await openScript(state.script.id);
    if (r.stats.pending > 0) {
      toast(`已保存为第 ${r.version} 版：${r.stats.bound} 条自动重定位，${r.stats.pending} 条待确认`, true);
    } else {
      toast(`已保存为第 ${r.version} 版，${r.stats.bound} 条提示全部重新定位成功`);
    }
  } catch (err) {
    toast(err.message, true);
  }
});

$('renameBtn').addEventListener('click', async () => {
  const title = prompt('修改剧本标题：', state.script.title);
  if (title == null) return;
  if (!title.trim()) return toast('标题不能为空', true);
  await api('PATCH', `/api/scripts/${state.script.id}`, { title: title.trim() });
  toast('标题已更新');
  openScript(state.script.id);
});

$('backBtn').addEventListener('click', goHome);
$('homeBtn').addEventListener('click', goHome);

async function goHome() {
  $('topbarSub').textContent = '灯光 / 音效提示管理';
  showView('list');
  syncHash();
  await loadScripts();
}

/* =============================== 排练执行台 =============================== */

async function loadSessions(scriptId) {
  state.sessions = await api('GET', `/api/scripts/${scriptId}/sessions`);
  renderSessions();
}

/** 创建场次前的提示统计：可执行（已绑定）数量与将被排除的待确认数量 */
function renderRunPanel() {
  const s = state.script;
  if (!s) return;
  const bound = s.cues.filter((c) => c.anchor_status === 'bound').length;
  const pending = s.cues.filter((c) => c.anchor_status === 'pending').length;
  $('runSummary').innerHTML = `
    <span style="color:var(--ok)">可执行 ${bound} 条</span>
    <span style="color:${pending ? 'var(--danger)' : 'var(--text-dim)'}">待确认排除 ${pending} 条</span>`;
  $('runHint').textContent =
    bound === 0
      ? '当前没有已绑定提示，无法创建场次（不会创建空场次）。'
      : `从当前版本 v${s.current_version} 冻结全部已绑定提示的行号、类型、内容与备注，生成执行队列` +
        (pending ? `；${pending} 条待确认提示将被排除` : '') +
        '。';
  $('createSessionBtn').disabled = bound === 0;
}

function renderSessions() {
  const box = $('sessionList');
  if (!state.sessions.length) {
    box.innerHTML = '<div class="empty">还没有场次。创建场次后即可在此进入执行台排练。</div>';
    return;
  }
  box.innerHTML = state.sessions
    .map(
      (s) => `
      <div class="session-item" data-id="${s.id}">
        <div>
          <div class="script-item-title">${escapeHtml(s.name)}</div>
          <div class="script-item-meta">
            剧本 v${s.script_version} 快照
            <span class="sep">·</span>已执行 ${s.executed_count} / ${s.total}
            <span class="sep">·</span>${
              s.status === 'completed'
                ? '<span style="color:var(--ok)">已完成</span>'
                : '进行中'
            }
            <span class="sep">·</span>创建于 ${escapeHtml(s.created_at)}
          </div>
        </div>
        <button class="btn btn-sm btn-primary">打开执行台</button>
      </div>`
    )
    .join('');
}

$('sessionList').addEventListener('click', (e) => {
  const item = e.target.closest('.session-item');
  if (item) openSession(Number(item.dataset.id)).catch((err) => toast(err.message, true));
});

$('createSessionBtn').addEventListener('click', async () => {
  const s = state.script;
  const bound = s.cues.filter((c) => c.anchor_status === 'bound').length;
  const pending = s.cues.filter((c) => c.anchor_status === 'pending').length;
  if (bound === 0) return toast('没有可执行的已绑定提示，无法创建场次', true);
  const msg =
    `将以当前版本 v${s.current_version} 冻结 ${bound} 条已绑定提示创建场次。` +
    (pending ? `\n注意：${pending} 条待确认提示将被排除。` : '') +
    '\n是否继续？';
  if (!confirm(msg)) return;
  try {
    const r = await api('POST', `/api/scripts/${s.id}/sessions`, {});
    toast(
      `场次已创建：冻结 ${r.total} 条提示` + (r.excluded ? `，排除 ${r.excluded} 条待确认` : '')
    );
    await openSession(r.id);
  } catch (err) {
    toast(err.message, true);
    await loadSessions(s.id).catch(() => {});
    renderRunPanel();
  }
});

/* =============================== 场次执行台 =============================== */

async function openSession(id) {
  state.session = await api('GET', `/api/sessions/${id}`);
  renderSession();
  showView('session');
  $('topbarSub').textContent = `${state.session.script_title} · ${state.session.name}`;
  syncHash();
}

/** 重新拉取场次（执行/撤回/冲突后同步最新进度） */
async function reloadSession() {
  state.session = await api('GET', `/api/sessions/${state.session.id}`);
  renderSession();
}

function renderSession() {
  const s = state.session;
  $('sessionTitle').textContent = s.name;
  $('sessionVersionBadge').textContent = `剧本 v${s.script_version} 快照`;
  const badge = $('sessionStatusBadge');
  if (s.status === 'completed') {
    badge.textContent = '✅ 已完成';
    badge.className = 'badge badge-ok';
  } else {
    badge.textContent = '进行中';
    badge.className = 'badge badge-version';
  }
  $('progressText').textContent = `已执行 ${s.executed_count} / ${s.total} 条`;
  $('progressFill').style.width = s.total ? `${(s.executed_count / s.total) * 100}%` : '0%';
  $('undoBtn').classList.toggle('hidden', s.executed_count === 0);

  const head = s.entries.find((e) => e.status === 'pending');
  $('entryList').innerHTML = s.entries
    .map((e) => {
      const isHead = head && e.id === head.id;
      const classes = ['entry-item'];
      if (e.status === 'done') classes.push('entry-done');
      if (isHead) classes.push('entry-head');
      return `
      <div class="${classes.join(' ')}">
        <span class="entry-seq">${e.seq}</span>
        <div class="entry-main">
          <div class="cue-item-top">
            <span class="badge ${e.type === 'light' ? 'badge-light' : 'badge-sound'}">
              ${e.type === 'light' ? '💡 灯光' : '🔊 音效'}
            </span>
            <span class="cue-label">${escapeHtml(e.label)}</span>
            <span class="badge badge-version">第 ${e.line_no} 行</span>
            ${isHead ? '<span class="badge badge-head">▶ 下一条</span>' : ''}
            ${e.status === 'done' ? `<span class="entry-time">✓ 已执行 ${escapeHtml(e.executed_at || '')}</span>` : ''}
          </div>
          <div class="cue-line">${escapeHtml(e.line_text || '')}</div>
          ${e.note ? `<div class="cue-note">📝 ${escapeHtml(e.note)}</div>` : ''}
        </div>
        ${isHead ? `<button class="btn btn-primary" data-exec="${e.id}">执行</button>` : ''}
      </div>`;
    })
    .join('');
}

/* 执行队首：提交目标条目 + 预期进度；409 时重新拉取以同步进度 */
$('entryList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-exec]');
  if (!btn || !state.session) return;
  btn.disabled = true;
  try {
    await api('POST', `/api/sessions/${state.session.id}/execute`, {
      entryId: Number(btn.dataset.exec),
      expectedExecuted: state.session.executed_count,
    });
  } catch (err) {
    toast(err.message, true);
  }
  await reloadSession().catch((err) => toast(err.message, true));
});

/* 撤回：仅作用于最后执行的一条 */
$('undoBtn').addEventListener('click', async () => {
  const s = state.session;
  if (!s) return;
  const lastDone = [...s.entries].reverse().find((e) => e.status === 'done');
  if (!lastDone) return toast('没有可撤回的执行记录', true);
  try {
    await api('POST', `/api/sessions/${s.id}/undo`, {
      entryId: lastDone.id,
      expectedExecuted: s.executed_count,
    });
    toast(`已撤回第 ${lastDone.seq} 条`);
  } catch (err) {
    toast(err.message, true);
  }
  await reloadSession().catch((err) => toast(err.message, true));
});

$('sessionBackBtn').addEventListener('click', () => {
  if (!state.session) return goHome();
  openScript(state.session.script_id).catch((err) => toast(err.message, true));
});

/* =============================== 路由（刷新后恢复进度） =============================== */

function syncHash() {
  let target = '#/';
  if (state.view === 'detail' && state.script) target = `#/scripts/${state.script.id}`;
  else if (state.view === 'session' && state.session) target = `#/sessions/${state.session.id}`;
  const cur = location.hash === '' || location.hash === '#' ? '#/' : location.hash;
  if (cur !== target) location.hash = target;
}

async function navigate() {
  const mSession = location.hash.match(/^#\/sessions\/(\d+)$/);
  const mScript = location.hash.match(/^#\/scripts\/(\d+)$/);
  try {
    if (mSession) {
      const id = Number(mSession[1]);
      if (state.view === 'session' && state.session && state.session.id === id) return;
      await openSession(id);
    } else if (mScript) {
      const id = Number(mScript[1]);
      if (state.view === 'detail' && state.script && state.script.id === id) return;
      await openScript(id);
    } else if (state.view !== 'list') {
      await goHome();
    }
  } catch (err) {
    toast(err.message, true);
    if (state.view !== 'list') {
      try {
        await goHome();
      } catch {
        /* 忽略返回列表时的错误 */
      }
    }
    if (location.hash !== '#/') location.hash = '#/';
  }
}

window.addEventListener('hashchange', () => {
  navigate().catch((err) => toast(err.message, true));
});

/* =============================== 启动 =============================== */

(async () => {
  try {
    await navigate();
    if (state.view === 'list') await loadScripts();
  } catch (err) {
    toast(err.message, true);
  }
})();

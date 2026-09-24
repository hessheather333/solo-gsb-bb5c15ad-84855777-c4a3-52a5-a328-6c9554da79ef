'use strict';

const path = require('path');
const express = require('express');
const db = require('./db');
const { relocalize, buildAnchor } = require('./reanchor');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

/* ----------------------------- 工具函数 ----------------------------- */

function validateType(type) {
  if (!['light', 'sound'].includes(type)) {
    const e = new Error('提示类型必须为 light（灯光）或 sound（音效）');
    e.status = 400;
    throw e;
  }
}

function getScriptOr404(scriptId) {
  const script = db.prepare('SELECT * FROM scripts WHERE id = ?').get(scriptId);
  if (!script) {
    const e = new Error('剧本不存在');
    e.status = 404;
    throw e;
  }
  return script;
}

/**
 * 待确认提示的候选行存于 issue_detail（格式 __CANDIDATES__{json}），
 * 解析出展示文案与候选行列表。
 */
function parseCue(c) {
  let candidates = [];
  let detail = c.issue_detail || '';
  if (detail.startsWith('__CANDIDATES__')) {
    try {
      const parsed = JSON.parse(detail.replace('__CANDIDATES__', ''));
      detail = parsed.detail;
      candidates = parsed.candidates;
    } catch {
      detail = '';
    }
  }
  return {
    ...c,
    context_before: c.context_before ? JSON.parse(c.context_before) : [],
    context_after: c.context_after ? JSON.parse(c.context_after) : [],
    issue:
      c.anchor_status === 'pending'
        ? { type: c.issue_type, detail, candidates }
        : null,
  };
}

function listCues(scriptId) {
  return db
    .prepare('SELECT * FROM cues WHERE script_id = ? ORDER BY id')
    .all(scriptId)
    .map(parseCue);
}

/* ----------------------------- 剧本接口 ----------------------------- */

// 剧本列表（不含正文）
app.get('/api/scripts', (req, res) => {
  const scripts = db
    .prepare(
      `SELECT s.id, s.title, s.current_version, s.created_at, s.updated_at,
              COUNT(c.id) AS cue_count,
              SUM(CASE WHEN c.anchor_status = 'pending' THEN 1 ELSE 0 END) AS pending_count
       FROM scripts s
       LEFT JOIN cues c ON c.script_id = s.id
       GROUP BY s.id
       ORDER BY s.updated_at DESC`
    )
    .all();
  res.json(scripts);
});

// 剧本详情（含全部提示）
app.get('/api/scripts/:id', (req, res) => {
  const script = getScriptOr404(req.params.id);
  res.json({ ...script, cues: listCues(script.id) });
});

// 新建剧本
app.post('/api/scripts', (req, res) => {
  const title = (req.body.title || '').trim();
  const content = typeof req.body.content === 'string' ? req.body.content : '';
  if (!title) return res.status(400).json({ error: '剧本标题不能为空' });

  const result = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO scripts (title, content) VALUES (?, ?)')
      .run(title, content);
    db.prepare(
      'INSERT INTO script_versions (script_id, version, title, content) VALUES (?, 1, ?, ?)'
    ).run(info.lastInsertRowid, title, content);
    return info.lastInsertRowid;
  })();

  res.status(201).json({ id: result });
});

// 修改标题
app.patch('/api/scripts/:id', (req, res) => {
  const script = getScriptOr404(req.params.id);
  const title = (req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: '剧本标题不能为空' });
  db.prepare("UPDATE scripts SET title = ?, updated_at = datetime('now') WHERE id = ?").run(
    title,
    script.id
  );
  res.json({ ok: true });
});

// 保存新版正文 -> 全部提示重新定位
app.put('/api/scripts/:id/content', (req, res) => {
  const script = getScriptOr404(req.params.id);
  const content = typeof req.body.content === 'string' ? req.body.content : null;
  if (content === null) return res.status(400).json({ error: '缺少 content 字段' });

  const outcome = db.transaction(() => {
    const newVersion = script.current_version + 1;
    db.prepare(
      `UPDATE scripts SET content = ?, current_version = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(content, newVersion, script.id);
    db.prepare(
      'INSERT INTO script_versions (script_id, version, title, content) VALUES (?, ?, ?, ?)'
    ).run(script.id, newVersion, script.title, content);

    const cues = db.prepare('SELECT * FROM cues WHERE script_id = ?').all(script.id);
    const { results, stats } = relocalize(cues, content);

    const boundStmt = db.prepare(
      `UPDATE cues SET version = ?, line_no = ?, line_text = ?, anchor_status = 'bound',
                       issue_type = NULL, issue_detail = NULL, updated_at = datetime('now')
       WHERE id = ?`
    );
    const pendingStmt = db.prepare(
      `UPDATE cues SET version = ?, line_no = NULL, line_text = NULL, anchor_status = 'pending',
                       issue_type = ?, issue_detail = ?, updated_at = datetime('now')
       WHERE id = ?`
    );

    for (const r of results) {
      if (r.status === 'bound') {
        boundStmt.run(newVersion, r.lineNo, r.lineText, r.cueId);
      } else {
        const payload = '__CANDIDATES__' + JSON.stringify({
          detail: r.issueDetail,
          candidates: r.candidates || [],
        });
        pendingStmt.run(newVersion, r.issueType, payload, r.cueId);
      }
    }
    return { version: newVersion, stats };
  })();

  res.json({ ok: true, ...outcome });
});

// 删除剧本
app.delete('/api/scripts/:id', (req, res) => {
  getScriptOr404(req.params.id);
  db.prepare('DELETE FROM scripts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* ----------------------------- 提示接口 ----------------------------- */

// 在某行旁添加提示（同时生成锚点与上下文快照）
app.post('/api/scripts/:id/cues', (req, res) => {
  const script = getScriptOr404(req.params.id);
  const { type, label, note, lineNo } = req.body;
  validateType(type);
  if (!label || !String(label).trim()) {
    return res.status(400).json({ error: '提示内容不能为空' });
  }
  const lineIndex = Number(lineNo) - 1;
  if (!Number.isInteger(lineIndex)) {
    return res.status(400).json({ error: '请选择提示所附着的台词行' });
  }

  const anchor = buildAnchor(script.content, lineIndex);
  const info = db
    .prepare(
      `INSERT INTO cues (script_id, type, label, note, version, line_no, line_text,
                         anchor_index, anchor_text, context_before, context_after, anchor_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'bound')`
    )
    .run(
      script.id,
      type,
      String(label).trim(),
      (note || '').trim(),
      script.current_version,
      lineIndex + 1,
      anchor.anchorText,
      lineIndex,
      anchor.anchorText,
      JSON.stringify(anchor.contextBefore),
      JSON.stringify(anchor.contextAfter)
    );
  res.status(201).json({ id: info.lastInsertRowid });
});

// 编辑提示文案（不改动锚点）
app.patch('/api/cues/:cueId', (req, res) => {
  const cue = db.prepare('SELECT * FROM cues WHERE id = ?').get(req.params.cueId);
  if (!cue) return res.status(404).json({ error: '提示不存在' });

  const type = req.body.type !== undefined ? req.body.type : cue.type;
  validateType(type);
  const label = req.body.label !== undefined ? String(req.body.label).trim() : cue.label;
  if (!label) return res.status(400).json({ error: '提示内容不能为空' });
  const note = req.body.note !== undefined ? String(req.body.note).trim() : cue.note;

  db.prepare(
    `UPDATE cues SET type = ?, label = ?, note = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(type, label, note, cue.id);
  res.json({ ok: true });
});

// 人工重新绑定：把提示挂到当前版本指定行，并重做锚点快照
app.post('/api/cues/:cueId/rebind', (req, res) => {
  const cue = db.prepare('SELECT * FROM cues WHERE id = ?').get(req.params.cueId);
  if (!cue) return res.status(404).json({ error: '提示不存在' });
  const script = getScriptOr404(cue.script_id);

  const lineIndex = Number(req.body.lineNo) - 1;
  if (!Number.isInteger(lineIndex)) {
    return res.status(400).json({ error: '请选择要绑定的台词行' });
  }
  const anchor = buildAnchor(script.content, lineIndex);

  db.prepare(
    `UPDATE cues SET version = ?, line_no = ?, line_text = ?, anchor_index = ?, anchor_text = ?,
                     context_before = ?, context_after = ?, anchor_status = 'bound',
                     issue_type = NULL, issue_detail = NULL, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    script.current_version,
    lineIndex + 1,
    anchor.anchorText,
    lineIndex,
    anchor.anchorText,
    JSON.stringify(anchor.contextBefore),
    JSON.stringify(anchor.contextAfter),
    cue.id
  );
  res.json({ ok: true });
});

// 删除提示
app.delete('/api/cues/:cueId', (req, res) => {
  const cue = db.prepare('SELECT * FROM cues WHERE id = ?').get(req.params.cueId);
  if (!cue) return res.status(404).json({ error: '提示不存在' });
  db.prepare('DELETE FROM cues WHERE id = ?').run(cue.id);
  res.json({ ok: true });
});

/* ----------------------------- 排练场次接口 ----------------------------- */

function getSessionOr404(sessionId) {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) {
    const e = new Error('场次不存在');
    e.status = 404;
    throw e;
  }
  return session;
}

// 某剧本的历次场次（新→旧）
app.get('/api/scripts/:id/sessions', (req, res) => {
  const script = getScriptOr404(req.params.id);
  const sessions = db
    .prepare(
      `SELECT id, script_id, name, script_version, total, executed_count, status, created_at, updated_at
       FROM sessions WHERE script_id = ? ORDER BY id DESC`
    )
    .all(script.id);
  res.json(sessions);
});

/**
 * 创建场次：冻结当前版本全部已绑定提示（行号/台词/类型/内容/备注），
 * 按行号 + 提示 ID 排序生成执行队列；待确认提示被排除；
 * 没有可执行提示时不创建空场次。
 */
app.post('/api/scripts/:id/sessions', (req, res) => {
  const script = getScriptOr404(req.params.id);
  const bound = db
    .prepare(
      `SELECT * FROM cues
       WHERE script_id = ? AND anchor_status = 'bound' AND line_no IS NOT NULL
       ORDER BY line_no, id`
    )
    .all(script.id);
  const excluded = db
    .prepare("SELECT COUNT(*) AS n FROM cues WHERE script_id = ? AND anchor_status = 'pending'")
    .get(script.id).n;

  if (bound.length === 0) {
    return res.status(400).json({ error: '没有可执行的已绑定提示，未创建空场次' });
  }

  const sessionId = db.transaction(() => {
    const seqNo =
      db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE script_id = ?').get(script.id).n + 1;
    const name = (req.body.name || '').trim() || `第 ${seqNo} 场`;
    const info = db
      .prepare('INSERT INTO sessions (script_id, name, script_version, total) VALUES (?, ?, ?, ?)')
      .run(script.id, name, script.current_version, bound.length);
    const sid = info.lastInsertRowid;
    const ins = db.prepare(
      `INSERT INTO session_entries (session_id, seq, cue_id, line_no, line_text, type, label, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    bound.forEach((c, i) => {
      ins.run(sid, i + 1, c.id, c.line_no, c.line_text, c.type, c.label, c.note);
    });
    return sid;
  })();

  res.status(201).json({ id: sessionId, total: bound.length, excluded });
});

// 场次详情：冻结快照 + 执行记录
app.get('/api/sessions/:id', (req, res) => {
  const session = getSessionOr404(req.params.id);
  const script = db.prepare('SELECT title FROM scripts WHERE id = ?').get(session.script_id);
  const entries = db
    .prepare('SELECT * FROM session_entries WHERE session_id = ? ORDER BY seq')
    .all(session.id);
  res.json({ ...session, script_title: script ? script.title : '', entries });
});

/**
 * 执行队首条目。客户端须提交目标条目 entryId 与预期进度 expectedExecuted：
 *  - 条目已执行（重复提交）        -> 409
 *  - 预期进度与当前不符（请求过期） -> 409
 *  - 目标不是队首                  -> 409
 * 冲突时不写入任何数据，队列不推进。
 */
app.post('/api/sessions/:id/execute', (req, res) => {
  const session = getSessionOr404(req.params.id);
  const entryId = Number(req.body.entryId);
  const expected = Number(req.body.expectedExecuted);
  if (!Number.isInteger(entryId)) return res.status(400).json({ error: '缺少目标条目 entryId' });
  if (!Number.isInteger(expected)) {
    return res.status(400).json({ error: '缺少预期进度 expectedExecuted' });
  }

  const entry = db
    .prepare('SELECT * FROM session_entries WHERE id = ? AND session_id = ?')
    .get(entryId, session.id);
  if (!entry) return res.status(404).json({ error: '目标条目不存在' });
  if (entry.status === 'done') {
    return res.status(409).json({ error: '该条目已执行，请勿重复提交' });
  }
  if (expected !== session.executed_count) {
    return res.status(409).json({ error: '请求已过期：执行进度已变化，请刷新后重试' });
  }
  const head = db
    .prepare(
      "SELECT * FROM session_entries WHERE session_id = ? AND status = 'pending' ORDER BY seq LIMIT 1"
    )
    .get(session.id);
  if (!head || head.id !== entry.id) {
    return res.status(409).json({ error: '一次只能执行队首条目' });
  }

  db.transaction(() => {
    db.prepare(
      "UPDATE session_entries SET status = 'done', executed_at = datetime('now') WHERE id = ?"
    ).run(entry.id);
    const newCount = session.executed_count + 1;
    db.prepare(
      "UPDATE sessions SET executed_count = ?, status = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(newCount, newCount === session.total ? 'completed' : 'active', session.id);
  })();

  res.json({ ok: true, executedCount: session.executed_count + 1 });
});

/**
 * 撤回最后执行的一条。仅最后一条已执行条目可撤回；
 * 预期进度不符（过期）或没有已执行条目（重复撤回）时返回 409。
 */
app.post('/api/sessions/:id/undo', (req, res) => {
  const session = getSessionOr404(req.params.id);
  const expected = Number(req.body.expectedExecuted);
  if (!Number.isInteger(expected)) {
    return res.status(400).json({ error: '缺少预期进度 expectedExecuted' });
  }
  if (expected !== session.executed_count) {
    return res.status(409).json({ error: '请求已过期：执行进度已变化，请刷新后重试' });
  }
  const last = db
    .prepare(
      "SELECT * FROM session_entries WHERE session_id = ? AND status = 'done' ORDER BY seq DESC LIMIT 1"
    )
    .get(session.id);
  if (!last) {
    return res.status(409).json({ error: '没有可撤回的执行记录' });
  }
  if (req.body.entryId !== undefined && Number(req.body.entryId) !== last.id) {
    return res.status(409).json({ error: '仅可撤回最后执行的一条' });
  }

  db.transaction(() => {
    db.prepare(
      "UPDATE session_entries SET status = 'pending', executed_at = NULL WHERE id = ?"
    ).run(last.id);
    db.prepare(
      "UPDATE sessions SET executed_count = executed_count - 1, status = 'active', updated_at = datetime('now') WHERE id = ?"
    ).run(session.id);
  })();

  res.json({ ok: true, executedCount: session.executed_count - 1, undoneEntryId: last.id });
});

/* ----------------------------- 错误处理 ----------------------------- */

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || '服务器内部错误' });
});

app.listen(PORT, () => {
  console.log(`台词提示单已启动: http://localhost:${PORT}`);
});

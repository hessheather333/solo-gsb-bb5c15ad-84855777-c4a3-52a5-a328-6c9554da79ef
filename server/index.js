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

/* ----------------------------- 错误处理 ----------------------------- */

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || '服务器内部错误' });
});

app.listen(PORT, () => {
  console.log(`台词提示单已启动: http://localhost:${PORT}`);
});

const $ = (selector) => document.querySelector(selector);

const RETENTION_OPTIONS = [
  [3600, '1 hour'],
  [86400, '24 hours'],
  [604800, '7 days'],
  [2592000, '30 days'],
  [0, 'forever'],
];

let currentState = null;
let bridgeOnline = false;
let pendingSignature = '';
let callTimer = null;
let activeTarget = '';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function shortId(value) {
  const text = String(value ?? '');
  return text.length > 26 ? `${text.slice(0, 14)}…${text.slice(-8)}` : text;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

function renderHeader(state) {
  $('#profile').textContent = state.profile;
  $('#relay-id').textContent = state.id;
  $('#dnd').textContent = state.dnd ? 'DND on' : 'available';
  $('#dnd').className = `pill ${state.dnd ? 'warn' : 'ok'}`;
  const toggle = $('#dnd-toggle');
  toggle.textContent = state.dnd ? 'DND on' : 'DND off';
  toggle.setAttribute('aria-pressed', String(Boolean(state.dnd)));
  toggle.classList.toggle('warn', Boolean(state.dnd));
  const near = $('#near');
  if (state.near) {
    near.textContent = `NEAR: ${state.near.account}`;
    near.className = 'pill ok';
  } else {
    near.textContent = 'NEAR: not linked';
    near.className = 'pill muted-pill';
  }
}

function setBridge(online, dnd) {
  bridgeOnline = online;
  const pill = $('#bridge');
  pill.textContent = online ? 'bridge: online' : 'bridge: offline';
  pill.className = `pill ${online ? 'ok' : 'danger'}`;
  $('#bridge-status').textContent = online
    ? 'Dial and incoming calls are live.'
    : 'Bridge offline — start the bridge service to call or receive.';
  if (typeof dnd === 'boolean' && currentState) {
    currentState.dnd = dnd;
    renderHeader(currentState);
  }
}

function renderContacts(state) {
  const body = $('#contacts');
  body.innerHTML = '';
  $('#empty-contacts').style.display = state.contacts.length ? 'none' : 'block';
  $('#contact-count').textContent = `${state.contacts.length} contact${state.contacts.length === 1 ? '' : 's'}`;
  $('#contact-options').innerHTML = state.contacts
    .map((contact) => `<option value="${escapeHtml(contact.alias)}"></option>`)
    .join('');
  for (const contact of state.contacts) {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td><strong>${escapeHtml(contact.alias)}</strong></td>
      <td><code title="${escapeHtml(contact.id)}">${escapeHtml(shortId(contact.id))}</code></td>
      <td>
        <select data-action="retention" data-id="${escapeHtml(contact.id)}">
          ${RETENTION_OPTIONS.map(([seconds, label]) => `<option value="${seconds}" ${Number(contact.retention) === seconds ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
      </td>
      <td>${contact.blocked ? '<span class="pill danger">blocked</span>' : '<span class="pill ok">allowed</span>'}</td>
      <td class="actions">
        <button class="ghost" data-action="block" data-id="${escapeHtml(contact.id)}" data-blocked="${contact.blocked}">${contact.blocked ? 'Unblock' : 'Block'}</button>
        <button class="ghost danger-text" data-action="remove" data-alias="${escapeHtml(contact.alias)}">Remove</button>
      </td>`;
    body.appendChild(row);
  }
}

function renderHistory(state) {
  const body = $('#history');
  body.innerHTML = '';
  $('#empty-history').style.display = state.history.length ? 'none' : 'block';
  for (const call of state.history) {
    const row = document.createElement('tr');
    row.className = 'clickable';
    row.dataset.callId = call.callId;
    row.innerHTML = `
      <td>${escapeHtml(call.startedAt ? call.startedAt.slice(0, 16).replace('T', ' ') : '?')}</td>
      <td>${call.direction === 'incoming' ? '←' : '→'}</td>
      <td>${escapeHtml(call.peer ?? '?')}</td>
      <td><span class="pill ${call.status === 'completed' ? 'ok' : call.status === 'failed' ? 'danger' : 'warn'}">${escapeHtml(call.status ?? '?')}</span></td>
      <td class="result">${escapeHtml(call.result ?? '')}</td>`;
    body.appendChild(row);
  }
}

function renderPending(payload) {
  if (!payload.ok) {
    setBridge(false);
    $('#incoming-card').style.display = 'none';
    return;
  }
  setBridge(true, payload.dnd);
  const list = Array.isArray(payload.pending) ? payload.pending : [];
  const signature = list.map((call) => `${call.callId}:${call.code ?? ''}`).join('|');
  if (signature === pendingSignature) return;
  pendingSignature = signature;
  $('#incoming-card').style.display = list.length ? 'block' : 'none';
  $('#incoming-count').textContent = list.length ? `${list.length} waiting` : '';
  $('#incoming-list').innerHTML = list.map((call) => `
    <article class="incoming">
      <div class="incoming-head">
        <strong>${escapeHtml(call.alias ?? call.from ?? 'unknown caller')}</strong>
        <span class="pill warn">ringing</span>
      </div>
      <p><span class="muted">id</span> <code>${escapeHtml(shortId(call.from))}</code></p>
      <p><span class="muted">intent</span> ${escapeHtml(call.intent ?? '')}</p>
      <p><span class="muted">task</span> ${escapeHtml(call.task ?? '')}</p>
      <div class="incoming-actions">
        <button data-action="accept" data-call-id="${escapeHtml(call.callId)}" data-code="${escapeHtml(call.code ?? '')}">Accept</button>
        <button class="ghost danger-text" data-action="reject" data-call-id="${escapeHtml(call.callId)}" data-code="${escapeHtml(call.code ?? '')}">Reject</button>
      </div>
    </article>`).join('');
}

async function refreshPending() {
  try {
    renderPending(await api('/api/pending'));
  } catch {
    setBridge(false);
  }
}

async function refreshBridge() {
  try {
    const result = await api('/api/bridge');
    if (result.ok) setBridge(true, result.dnd);
    else setBridge(false);
  } catch {
    setBridge(false);
  }
}

function renderCall(result) {
  const status = result.status ?? 'unknown';
  const tone = status === 'completed' ? 'ok' : ['failed', 'unavailable', 'rejected', 'ring_timeout'].includes(status) ? 'danger' : 'warn';
  const reason = result.reason ? ` <span class="muted">(${escapeHtml(result.reason)})</span>` : '';
  const target = activeTarget ? ` <span class="muted">${escapeHtml(activeTarget)}</span>` : '';
  const text = result.result ? `<p class="call-result">${escapeHtml(result.result)}</p>` : '';
  $('#call-status').innerHTML = `<span class="pill ${tone}">${escapeHtml(status)}</span>${target}${reason}${text}`;
}

async function pollCall(callId) {
  clearTimeout(callTimer);
  try {
    const result = await api(`/api/call/${encodeURIComponent(callId)}`);
    renderCall(result);
    if (['dialing', 'active'].includes(result.status)) {
      callTimer = setTimeout(() => pollCall(callId), 1500);
    }
  } catch (error) {
    renderCall({ status: 'error', reason: error.message });
  }
}

function render(state) {
  currentState = state;
  renderHeader(state);
  renderContacts(state);
  renderHistory(state);
}

async function refresh() {
  render(await api('/api/state'));
}

$('#add-contact').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#form-error').textContent = '';
  try {
    await api('/api/contacts', {
      method: 'POST',
      body: JSON.stringify({ alias: $('#alias').value.trim(), id: $('#contact-id').value.trim() }),
    });
    $('#alias').value = '';
    $('#contact-id').value = '';
    await refresh();
  } catch (error) {
    $('#form-error').textContent = error.message;
  }
});

$('#contacts').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const { action } = button.dataset;
  try {
    if (action === 'remove') {
      if (!confirm(`Remove ${button.dataset.alias}?`)) return;
      await api(`/api/contacts/${encodeURIComponent(button.dataset.alias)}`, { method: 'DELETE' });
    } else if (action === 'block') {
      const id = button.dataset.id;
      if (button.dataset.blocked === 'true') await api(`/api/block/${encodeURIComponent(id)}`, { method: 'DELETE' });
      else await api('/api/block', { method: 'POST', body: JSON.stringify({ id }) });
    }
    await refresh();
  } catch (error) {
    alert(error.message);
  }
});

$('#contacts').addEventListener('change', async (event) => {
  const select = event.target.closest('select[data-action="retention"]');
  if (!select) return;
  try {
    await api('/api/retention', {
      method: 'POST',
      body: JSON.stringify({ id: select.dataset.id, seconds: Number(select.value) }),
    });
    await refresh();
  } catch (error) {
    alert(error.message);
  }
});

$('#history').addEventListener('click', async (event) => {
  const row = event.target.closest('tr[data-call-id]');
  if (!row) return;
  try {
    const record = await api(`/api/history/${encodeURIComponent(row.dataset.callId)}`);
    $('#detail-title').textContent = `Call ${record.callId.slice(0, 8)}`;
    const lines = [];
    lines.push(`Peer:       ${record.peerAlias ?? record.peer ?? '?'}`);
    lines.push(`Direction:  ${record.direction ?? '?'}`);
    lines.push(`Status:     ${record.status ?? '?'}${record.reason ? ` (${record.reason})` : ''}`);
    lines.push(`Started:    ${record.startedAt ?? '?'}`);
    lines.push(`Ended:      ${record.endedAt ?? '?'}`);
    if (record.intent) lines.push(`Intent:     ${record.intent}`);
    if (record.task) lines.push(`Task:       ${record.task}`);
    if (record.report) lines.push(`Report:     ${record.report}`);
    if (Array.isArray(record.turns) && record.turns.length) {
      lines.push('', 'Transcript:');
      for (const turn of record.turns) lines.push(`  ${turn.from === 'me' ? 'You' : 'Peer'}: ${turn.text}`);
    }
    if (record.result) lines.push('', `Result: ${record.result}`);
    $('#detail-body').textContent = lines.join('\n');
    $('#detail').showModal();
  } catch (error) {
    alert(error.message);
  }
});

$('#close-detail').addEventListener('click', () => $('#detail').close());

$('#dnd-toggle').addEventListener('click', async () => {
  if (!currentState) return;
  try {
    const result = await api('/api/dnd', {
      method: 'POST',
      body: JSON.stringify({ dnd: !currentState.dnd }),
    });
    if (result.ok === false) throw new Error(result.error ?? 'Could not change DND');
    currentState.dnd = Boolean(result.dnd);
    renderHeader(currentState);
    await refreshBridge();
  } catch (error) {
    alert(error.message);
  }
});

$('#call-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#call-error').textContent = '';
  clearTimeout(callTimer);
  activeTarget = $('#call-target').value.trim();
  try {
    const result = await api('/api/call', {
      method: 'POST',
      body: JSON.stringify({
        target: activeTarget,
        intent: $('#call-intent').value.trim(),
        task: $('#call-task').value.trim(),
      }),
    });
    renderCall({ status: result.status ?? 'dialing' });
    await pollCall(result.callId);
  } catch (error) {
    $('#call-error').textContent = error.message;
  }
});

$('#incoming-list').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  button.disabled = true;
  try {
    await api(`/api/${button.dataset.action}`, {
      method: 'POST',
      body: JSON.stringify({ callId: button.dataset.callId, code: button.dataset.code }),
    });
    pendingSignature = '';
    await refreshPending();
    await refresh();
  } catch (error) {
    alert(error.message);
    button.disabled = false;
  }
});

refresh()
  .then(() => Promise.all([refreshBridge(), refreshPending()]))
  .catch((error) => {
    document.body.insertAdjacentHTML('afterbegin', `<p class="error">${escapeHtml(error.message)}</p>`);
  });

setInterval(refreshPending, 1500);
setInterval(refreshBridge, 5000);
setInterval(() => refresh().catch(() => {}), 10000);

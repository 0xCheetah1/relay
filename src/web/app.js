const $ = (selector) => document.querySelector(selector);

const RETENTION_OPTIONS = [
  [3600, '1 hour'],
  [86400, '24 hours'],
  [604800, '7 days'],
  [2592000, '30 days'],
  [0, 'forever'],
];

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
  const near = $('#near');
  if (state.near) {
    near.textContent = `NEAR: ${state.near.account}`;
    near.className = 'pill ok';
  } else {
    near.textContent = 'NEAR: not linked';
    near.className = 'pill muted-pill';
  }
}

function renderContacts(state) {
  const body = $('#contacts');
  body.innerHTML = '';
  $('#empty-contacts').style.display = state.contacts.length ? 'none' : 'block';
  $('#contact-count').textContent = `${state.contacts.length} contact${state.contacts.length === 1 ? '' : 's'}`;
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

function render(state) {
  renderHeader(state);
  renderContacts(state);
  renderHistory(state);
}

async function refresh() {
  const state = await api('/api/state');
  render(state);
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

refresh().catch((error) => {
  document.body.insertAdjacentHTML('afterbegin', `<p class="error">${escapeHtml(error.message)}</p>`);
});

export function formatTranscript(record) {
  const other = record.direction === 'incoming' ? 'Caller' : 'Recipient';
  const peerLabel = record.peerAlias ?? record.peer ?? 'unknown';
  const lines = [`# RELAY call ${record.callId}`, ''];
  lines.push(`- Direction: ${record.direction ?? '?'}`);
  lines.push(`- ${other}: ${record.peerAlias ? `${record.peerAlias} (${record.peer})` : peerLabel}`);
  if (record.intent) lines.push(`- Intent: ${record.intent}`);
  if (record.task) lines.push(`- Task: ${record.task}`);
  lines.push(`- Started: ${record.startedAt ?? '?'}`);
  lines.push(`- Ended: ${record.endedAt ?? '?'}`);
  lines.push(`- Status: ${record.status ?? '?'}${record.reason ? ` (${record.reason})` : ''}`);
  if (record.report) lines.push(`- Owner report: ${record.report}`);
  lines.push('', '## Transcript', '');
  if (Array.isArray(record.turns) && record.turns.length > 0) {
    for (const turn of record.turns) {
      lines.push(`**${turn.from === 'me' ? 'You' : peerLabel}:** ${turn.text}`, '');
    }
  } else if (record.task) {
    lines.push(`**Task:** ${record.task}`, '');
  }
  if (record.result) lines.push('## Result', '', String(record.result), '');
  return `${lines.join('\n')}\n`;
}

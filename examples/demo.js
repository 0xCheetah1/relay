import { createIdentity } from '../src/identity.js';
import { createRelayServer } from '../src/server.js';
import { RelayClient } from '../src/client.js';

const server = createRelayServer({ ringMs: 1500, callMs: 3000 });
const url = await server.listen();
const caller = new RelayClient({ identity: createIdentity(), url });
const recipient = new RelayClient({ identity: createIdentity(), url });

try {
  await Promise.all([caller.connect(), recipient.connect()]);
  caller.addContact('researcher', recipient.identity.id);
  recipient.addContact('planner', caller.identity.id);
  console.log(`Caller saved researcher as ${recipient.identity.id}`);
  recipient.on('call.ringing', (event) => {
    console.log(`Incoming call from planner: ${event.intent} (${event.task})`);
    recipient.accept(event.callId);
  });
  caller.on('call.accepted', ({ callId }) => caller.say(callId, 'Can we meet tomorrow at 10?'));
  recipient.on('call.message', ({ callId, text }) => {
    console.log(`Planner: ${text}`);
    recipient.end(callId, 'Tomorrow at 10 works for me.');
  });
  await new Promise((resolve) => {
    caller.once('call.ended', (event) => {
      console.log(`Call ${event.status}: ${event.result}`);
      resolve();
    });
    caller.dial('researcher', { intent: 'Plan a meeting', task: 'Find a time tomorrow morning' });
  });
} finally {
  await Promise.all([caller.close(), recipient.close()]);
  await server.close();
}

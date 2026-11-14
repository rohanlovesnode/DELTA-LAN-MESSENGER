'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { once } = require('node:events');
const WebSocket = require('ws');
const { test } = require('node:test');

function unusedPort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Test server exited before becoming ready.');
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Test server did not become ready.');
}

function startServer(port, directory) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      TLS_ENABLED: 'false',
      DATA_DIR: path.join(directory, 'data'),
      UPLOAD_DIR: path.join(directory, 'data', 'uploads')
    },
    stdio: 'ignore'
  });
  return child;
}

function connect(url, name, serverId = 'delta-lan') {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => reject(new Error('WebSocket handshake timed out.')), 5000);
    socket.once('error', reject);
    socket.once('open', () => socket.send(JSON.stringify({ type: 'hello', data: { name, serverId } })));
    socket.on('message', (buffer) => {
      const packet = JSON.parse(buffer.toString());
      if (packet.type === 'hello:ok') {
        clearTimeout(timeout);
        socket.memberId = packet.data.id;
        resolve(socket);
      }
    });
  });
}

function waitForPacket(socket, type, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error(`Timed out waiting for WebSocket packet ${type}.`));
    }, 5000);
    function onMessage(buffer) {
      const packet = JSON.parse(buffer.toString());
      if (packet.type === type && predicate(packet.data)) {
        clearTimeout(timeout);
        socket.off('message', onMessage);
        resolve(packet.data);
      }
    }
    socket.on('message', onMessage);
  });
}

function closeServer(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 3000).unref();
  });
}

test('health, persistent chat, and streamed file transfer survive restart', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-lan-test-'));
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}`;
  let child = startServer(port, directory);
  t.after(async () => {
    await closeServer(child);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child);
  const health = await fetch(`${baseUrl}/health`).then((response) => response.json());
  assert.equal(health.status, 'ok');
  const homepage = await fetch(baseUrl).then((response) => response.text());
  assert.match(homepage, /Delta LAN Messenger/);

  const defaultServer = await fetch(`${baseUrl}/api/servers`).then((response) => response.json())
    .then((servers) => servers.find((server) => server.id === 'delta-lan'));
  assert.ok(defaultServer);
  for (const name of ['Test User', 'Peer User']) {
    const joined = await fetch(`${baseUrl}/api/servers/${defaultServer.id}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    assert.equal(joined.status, 200);
  }

  const socket = await connect(wsUrl, 'Test User');
  const peer = await connect(wsUrl, 'Peer User');
  const firstReceipt = waitForPacket(socket, 'message:new', (message) => message.text === 'persisted test message');
  const peerReceipt = waitForPacket(peer, 'message:new', (message) => message.text === 'persisted test message');
  socket.send(JSON.stringify({
    type: 'message:send',
    data: { channel: 'general', text: 'persisted test message' }
  }));
  assert.equal((await firstReceipt).sender, 'Test User');
  assert.equal((await peerReceipt).sender, 'Test User');
  const replyToPeer = waitForPacket(socket, 'message:new', (message) => message.text === 'reply from peer');
  const replyToSender = waitForPacket(peer, 'message:new', (message) => message.text === 'reply from peer');
  peer.send(JSON.stringify({
    type: 'message:send',
    data: { channel: 'general', text: 'reply from peer' }
  }));
  assert.equal((await replyToPeer).sender, 'Peer User');
  assert.equal((await replyToSender).sender, 'Peer User');

  const created = await fetch(`${baseUrl}/api/servers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Research Lab',
      description: 'A separate server space',
      ownerName: 'Test User'
    })
  });
  assert.equal(created.status, 201);
  const researchServer = await created.json();
  assert.equal(researchServer.isMember, true);
  const peerJoin = await fetch(`${baseUrl}/api/servers/${researchServer.id}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Peer User' })
  });
  assert.equal(peerJoin.status, 200);
  const additionalMember = await fetch(`${baseUrl}/api/servers/${researchServer.id}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Research Guest' })
  });
  assert.equal(additionalMember.status, 200);
  const settings = await fetch(`${baseUrl}/api/servers/${researchServer.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ownerName: 'Test User',
      name: 'Research Hub',
      description: 'Server settings persist',
      accentColor: '#3366ff',
      admins: ['Peer User']
    })
  });
  assert.equal(settings.status, 200);
  const updatedServer = await settings.json();
  assert.equal(updatedServer.settings.accentColor, '#3366ff');
  assert.deepEqual(updatedServer.adminNames, ['Peer User']);

  const createPrivateChannel = await fetch(`${baseUrl}/api/servers/${researchServer.id}/channels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      adminName: 'Test User',
      name: 'private-notes',
      permissionMode: 'members',
      allowedMembers: ['Research Guest']
    })
  });
  assert.equal(createPrivateChannel.status, 201);
  const privateChannel = await createPrivateChannel.json();
  const createTemporaryChannel = await fetch(`${baseUrl}/api/servers/${researchServer.id}/channels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      adminName: 'Test User',
      name: 'temporary',
      permissionMode: 'all',
      allowedMembers: []
    })
  });
  assert.equal(createTemporaryChannel.status, 201);
  const temporaryChannel = await createTemporaryChannel.json();
  const renamedChannel = await fetch(
    `${baseUrl}/api/servers/${researchServer.id}/channels/${privateChannel.id}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        adminName: 'Peer User',
        name: 'quiet-room',
        permissionMode: 'members',
        allowedMembers: ['Research Guest']
      })
    }
  );
  assert.equal(renamedChannel.status, 200);
  const reordered = await fetch(`${baseUrl}/api/servers/${researchServer.id}/channels/order`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      adminName: 'Peer User',
      channelIds: [temporaryChannel.id, privateChannel.id, 'general', 'random', 'files']
    })
  });
  assert.equal(reordered.status, 200);
  const reorderedData = await reordered.json();
  assert.equal(reorderedData.channels[0].id, temporaryChannel.id);
  const guestChannels = await fetch(`${baseUrl}/api/servers/${researchServer.id}/channels?name=Research%20Guest`);
  assert.equal(guestChannels.status, 403);

  const researchOwner = await connect(wsUrl, 'Test User', researchServer.id);
  const researchPeer = await connect(wsUrl, 'Peer User', researchServer.id);
  const researchGuest = await connect(wsUrl, 'Research Guest', researchServer.id);
  const observerJoin = await fetch(`${baseUrl}/api/servers/${researchServer.id}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Channel Observer' })
  });
  assert.equal(observerJoin.status, 200);
  const observer = await connect(wsUrl, 'Channel Observer', researchServer.id);
  const forbiddenMessage = waitForPacket(observer, 'error', (data) => /permission/.test(data.message));
  observer.send(JSON.stringify({
    type: 'message:send',
    data: { channel: privateChannel.id, text: 'this should be denied' }
  }));
  assert.match((await forbiddenMessage).message, /permission/);
  const guestReceipt = waitForPacket(researchGuest, 'message:new', (message) => message.text === 'member-only history');
  const ownerPrivateReceipt = waitForPacket(researchOwner, 'message:new', (message) => message.text === 'member-only history');
  researchGuest.send(JSON.stringify({
    type: 'message:send',
    data: { channel: privateChannel.id, text: 'member-only history' }
  }));
  assert.equal((await guestReceipt).channel, privateChannel.id);
  assert.equal((await ownerPrivateReceipt).channel, privateChannel.id);

  const participantsForPeer = waitForPacket(researchPeer, 'voice:participants');
  const stateForOwner = waitForPacket(researchOwner, 'voice:state', (data) =>
    data.members.some((member) => member.id === researchOwner.memberId)
  );
  researchOwner.send(JSON.stringify({ type: 'voice:join', data: { channel: 'lounge' } }));
  assert.equal((await stateForOwner).members.length, 1);
  researchPeer.send(JSON.stringify({ type: 'voice:join', data: { channel: 'lounge' } }));
  assert.equal((await participantsForPeer).members[0].id, researchOwner.memberId);
  const relayedSignal = waitForPacket(researchPeer, 'voice:signal', (data) =>
    data.fromId === researchOwner.memberId
  );
  researchOwner.send(JSON.stringify({
    type: 'voice:signal',
    data: {
      targetId: researchPeer.memberId,
      signal: { description: { type: 'offer', sdp: 'v=0\r\n' } }
    }
  }));
  assert.equal((await relayedSignal).signal.description.type, 'offer');
  const mutedState = waitForPacket(researchOwner, 'voice:state', (data) =>
    data.members.some((member) => member.id === researchPeer.memberId && member.muted)
  );
  researchPeer.send(JSON.stringify({ type: 'voice:mute', data: { muted: true } }));
  assert.equal((await mutedState).members.find((member) => member.id === researchPeer.memberId).muted, true);
  const unmutedState = waitForPacket(researchOwner, 'voice:state', (data) =>
    data.members.some((member) => member.id === researchPeer.memberId && !member.muted)
  );
  researchPeer.send(JSON.stringify({ type: 'voice:mute', data: { muted: false } }));
  assert.equal((await unmutedState).members.find((member) => member.id === researchPeer.memberId).muted, false);
  const deafenedState = waitForPacket(researchOwner, 'voice:state', (data) =>
    data.members.some((member) => member.id === researchPeer.memberId && member.deafened)
  );
  researchPeer.send(JSON.stringify({ type: 'voice:deafen', data: { deafened: true } }));
  assert.equal((await deafenedState).members.find((member) => member.id === researchPeer.memberId).deafened, true);
  const sharingState = waitForPacket(researchOwner, 'voice:state', (data) =>
    data.members.some((member) => member.id === researchPeer.memberId && member.sharing && member.shareAudio)
  );
  researchPeer.send(JSON.stringify({
    type: 'voice:share',
    data: { sharing: true, shareAudio: true }
  }));
  const sharedMember = (await sharingState).members.find((member) => member.id === researchPeer.memberId);
  assert.equal(sharedMember.sharing, true);
  assert.equal(sharedMember.shareAudio, true);
  assert.equal(sharedMember.deafened, true);
  assert.equal(sharedMember.muted, false);
  const stoppedSharingState = waitForPacket(researchOwner, 'voice:state', (data) =>
    data.members.some((member) => member.id === researchPeer.memberId && !member.sharing && !member.shareAudio)
  );
  researchPeer.send(JSON.stringify({
    type: 'voice:share',
    data: { sharing: false, shareAudio: false }
  }));
  const stoppedMember = (await stoppedSharingState).members.find((member) => member.id === researchPeer.memberId);
  assert.equal(stoppedMember.sharing, false);
  assert.equal(stoppedMember.shareAudio, false);
  const cleanedVoiceState = waitForPacket(researchOwner, 'voice:state', (data) =>
    data.members.length === 1 && data.members[0].id === researchOwner.memberId
  );
  const resetVoicePresence = waitForPacket(researchOwner, 'presence', (members) =>
    members.some((member) => member.id === researchPeer.memberId &&
      !member.voiceChannel && !member.deafened && !member.sharing && !member.shareAudio)
  );
  researchPeer.send(JSON.stringify({ type: 'voice:leave', data: {} }));
  assert.equal((await cleanedVoiceState).members.length, 1);
  const resetPeer = (await resetVoicePresence).find((member) => member.id === researchPeer.memberId);
  assert.equal(resetPeer.deafened, false);
  assert.equal(resetPeer.sharing, false);

  const ownerReceipt = waitForPacket(researchOwner, 'message:new', (message) => message.text === 'research only');
  const researchPeerReceipt = waitForPacket(researchPeer, 'message:new', (message) => message.text === 'research only');
  researchOwner.send(JSON.stringify({
    type: 'message:send',
    data: { channel: 'general', text: 'research only' }
  }));
  assert.equal((await ownerReceipt).serverId, researchServer.id);
  assert.equal((await researchPeerReceipt).serverId, researchServer.id);
  const peerRejoinedVoice = waitForPacket(researchOwner, 'voice:state', (data) =>
    data.members.some((member) => member.id === researchPeer.memberId)
  );
  researchPeer.send(JSON.stringify({ type: 'voice:join', data: { channel: 'lounge' } }));
  await peerRejoinedVoice;
  const disconnectedShareState = waitForPacket(researchOwner, 'voice:state', (data) =>
    data.members.some((member) => member.id === researchPeer.memberId && member.sharing)
  );
  researchPeer.send(JSON.stringify({
    type: 'voice:share',
    data: { sharing: true, shareAudio: false }
  }));
  await disconnectedShareState;
  const disconnectedVoiceState = waitForPacket(researchOwner, 'voice:state', (data) =>
    data.members.length === 1 && data.members[0].id === researchOwner.memberId
  );
  researchPeer.terminate();
  assert.equal((await disconnectedVoiceState).members.length, 1);
  const defaultHistory = await fetch(`${baseUrl}/api/bootstrap?serverId=delta-lan&name=Test%20User`)
    .then((response) => response.json());
  const researchHistory = await fetch(`${baseUrl}/api/bootstrap?serverId=${researchServer.id}&name=Test%20User`)
    .then((response) => response.json());
  assert.equal(defaultHistory.messages.some((message) => message.text === 'research only'), false);
  assert.equal(researchHistory.messages.some((message) => message.text === 'persisted test message'), false);
  assert.equal(researchHistory.members.some((member) => member.name === 'Research Guest'), true);
  assert.equal(researchHistory.messages.some((message) => message.text === 'member-only history'), true);
  const observerHistory = await fetch(
    `${baseUrl}/api/bootstrap?serverId=${researchServer.id}&name=Channel%20Observer`
  ).then((response) => response.json());
  assert.equal(observerHistory.channels.some((channel) => channel.id === privateChannel.id), true);
  assert.equal(observerHistory.channels.find((channel) => channel.id === privateChannel.id).canAccess, false);
  assert.equal(observerHistory.messages.some((message) => message.channel === privateChannel.id), false);
  const missingIdentity = await fetch(`${baseUrl}/api/bootstrap?serverId=${researchServer.id}`);
  assert.equal(missingIdentity.status, 400);
  const restrictedHistory = await fetch(
    `${baseUrl}/api/messages?serverId=${researchServer.id}&channel=${privateChannel.id}&name=Channel%20Observer`
  );
  assert.equal(restrictedHistory.status, 403);

  const temporaryReceipt = waitForPacket(researchOwner, 'message:new', (message) =>
    message.text === 'temporary history removed'
  );
  researchOwner.send(JSON.stringify({
    type: 'message:send',
    data: { channel: temporaryChannel.id, text: 'temporary history removed' }
  }));
  await temporaryReceipt;
  const deleteTemporary = await fetch(
    `${baseUrl}/api/servers/${researchServer.id}/channels/${temporaryChannel.id}?adminName=Test%20User`,
    { method: 'DELETE' }
  );
  assert.equal(deleteTemporary.status, 200);
  const afterChannelDelete = await fetch(
    `${baseUrl}/api/bootstrap?serverId=${researchServer.id}&name=Test%20User`
  ).then((response) => response.json());
  assert.equal(afterChannelDelete.messages.some((message) => message.text === 'temporary history removed'), false);

  const peerLeave = await fetch(`${baseUrl}/api/servers/${researchServer.id}/leave`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Research Guest' })
  });
  assert.equal(peerLeave.status, 200);
  const deniedBootstrap = await fetch(`${baseUrl}/api/bootstrap?serverId=${researchServer.id}&name=Research%20Guest`);
  assert.equal(deniedBootstrap.status, 403);
  await fetch(`${baseUrl}/api/servers/${researchServer.id}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Research Guest' })
  });

  socket.close();
  peer.close();
  researchOwner.close();
  researchPeer.close();
  researchGuest.close();
  observer.close();
  await new Promise((resolve) => setTimeout(resolve, 100));

  const create = await fetch(`${baseUrl}/api/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '../résumé #1 (final).txt',
      sender: 'Test User',
      serverId: defaultServer.id,
      channelId: 'general'
    })
  });
  assert.equal(create.status, 201);
  const upload = await create.json();
  const contents = Buffer.from('streamed file content \u0000');
  const uploaded = await fetch(`${baseUrl}/api/uploads/${upload.id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent(upload.name),
      'X-Sender-Name': encodeURIComponent('Test User'),
      'X-Channel-Id': 'general'
    },
    body: contents
  });
  assert.equal(uploaded.status, 201);
  const metadata = await uploaded.json();
  assert.equal(metadata.name, 'résumé #1 (final).txt');
  assert.equal(metadata.size, contents.length);
  const defaultFileQuery = '?serverId=delta-lan&name=Test%20User';
  const download = await fetch(`${baseUrl}/api/files/${upload.id}/download${defaultFileQuery}`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /filename\*=UTF-8''r%C3%A9sum%C3%A9%20%231%20%28final%29\.txt/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), contents);

  await closeServer(child);
  child = startServer(port, directory);
  await waitForHealth(baseUrl, child);
  const messages = await fetch(
    `${baseUrl}/api/messages?serverId=delta-lan&channel=general&name=Test%20User`
  ).then((response) => response.json());
  assert.equal(messages.some((message) => message.text === 'persisted test message'), true);
  const files = await fetch(`${baseUrl}/api/files?serverId=delta-lan&name=Test%20User`)
    .then((response) => response.json());
  assert.equal(files.some((file) => file.id === upload.id), true);
  const bootstrap = await fetch(
    `${baseUrl}/api/bootstrap?serverId=delta-lan&name=Test%20User`
  ).then((response) => response.json());
  assert.equal(bootstrap.members.some((member) => member.name === 'Test User' && member.online === false), true);
  const restoredServers = await fetch(`${baseUrl}/api/servers?name=Test%20User`).then((response) => response.json());
  const restoredResearch = restoredServers.find((server) => server.id === researchServer.id);
  assert.equal(restoredResearch.name, 'Research Hub');
  assert.equal(restoredResearch.isMember, true);
  assert.deepEqual(restoredResearch.adminNames, ['Peer User']);
  const restoredResearchHistory = await fetch(
    `${baseUrl}/api/bootstrap?serverId=${researchServer.id}&name=Test%20User`
  ).then((response) => response.json());
  assert.equal(restoredResearchHistory.messages.some((message) => message.text === 'research only'), true);
  assert.equal(restoredResearchHistory.channels.some((channel) => channel.id === privateChannel.id), true);
  const restoredObserverHistory = await fetch(
    `${baseUrl}/api/bootstrap?serverId=${researchServer.id}&name=Channel%20Observer`
  ).then((response) => response.json());
  assert.equal(restoredObserverHistory.channels.find((channel) => channel.id === privateChannel.id).canAccess, false);
  assert.equal(restoredObserverHistory.messages.some((message) => message.channel === privateChannel.id), false);
  const restoredFile = await fetch(`${baseUrl}/api/files/${upload.id}/download${defaultFileQuery}`);
  assert.deepEqual(Buffer.from(await restoredFile.arrayBuffer()), contents);
  fs.unlinkSync(path.join(directory, 'data', 'uploads', upload.id));
  const unavailableFile = await fetch(`${baseUrl}/api/files/${upload.id}/download${defaultFileQuery}`);
  assert.equal(unavailableFile.status, 404);
  assert.equal((await unavailableFile.json()).error, 'Stored file is unavailable.');

  const largeAllocation = await fetch(`${baseUrl}/api/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'large-stream.bin',
      sender: 'Test User',
      serverId: defaultServer.id,
      channelId: 'general'
    })
  }).then((response) => response.json());
  const chunk = Buffer.alloc(1024 * 1024, 0x5a);
  const largeRequest = http.request(`${baseUrl}/api/uploads/${largeAllocation.id}`, {
    method: 'PUT',
    headers: {
      'X-File-Name': encodeURIComponent(largeAllocation.name),
      'X-Sender-Name': encodeURIComponent('Test User'),
      'X-Channel-Id': 'general'
    }
  });
  const responsePromise = new Promise((resolve, reject) => {
    largeRequest.once('response', resolve);
    largeRequest.once('error', reject);
  });
  for (let index = 0; index < 16; index += 1) {
    if (!largeRequest.write(chunk)) {
      await once(largeRequest, 'drain');
    }
  }
  largeRequest.end();
  const largeResponse = await responsePromise;
  assert.equal(largeResponse.statusCode, 201);
  const largeFile = JSON.parse(await new Promise((resolve, reject) => {
    let responseBody = '';
    largeResponse.setEncoding('utf8');
    largeResponse.on('data', (part) => { responseBody += part; });
    largeResponse.on('end', () => resolve(responseBody));
    largeResponse.on('error', reject);
  }));
  assert.equal(largeFile.size, 16 * 1024 * 1024);
  const hash = crypto.createHash('sha256');
  const largeDownload = await fetch(`${baseUrl}/api/files/${largeFile.id}/download${defaultFileQuery}`);
  let downloadedBytes = 0;
  for await (const part of largeDownload.body) {
    downloadedBytes += part.length;
    hash.update(part);
  }
  assert.equal(downloadedBytes, 16 * 1024 * 1024);
  const expectedHash = crypto.createHash('sha256');
  for (let index = 0; index < 16; index += 1) expectedHash.update(chunk);
  assert.equal(hash.digest('hex'), expectedHash.digest('hex'));
});

test('migrates the previous single-server history and member list', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-lan-migration-'));
  fs.mkdirSync(path.join(directory, 'data'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'data', 'store.json'), JSON.stringify({
    messages: [{
      id: 'legacy-message',
      channel: 'general',
      senderId: 'legacy-user',
      sender: 'Legacy Member',
      text: 'history preserved',
      sentAt: '2026-01-01T00:00:00.000Z'
    }],
    files: [],
    members: [{ name: 'Legacy Member' }]
  }));
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = startServer(port, directory);
  t.after(async () => {
    await closeServer(child);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child);
  const servers = await fetch(`${baseUrl}/api/servers?name=Legacy%20Member`).then((response) => response.json());
  const migratedServer = servers.find((server) => server.id === 'delta-lan');
  assert.equal(migratedServer.isMember, true);
  assert.equal(migratedServer.canManage, true);
  const bootstrap = await fetch(
    `${baseUrl}/api/bootstrap?serverId=delta-lan&name=Legacy%20Member`
  ).then((response) => response.json());
  assert.equal(bootstrap.messages[0].serverId, 'delta-lan');
  assert.equal(bootstrap.messages[0].text, 'history preserved');
});

test('streams folder contents, preserves paths, and removes interrupted uploads on restart', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-lan-folder-'));
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}`;
  let child = startServer(port, directory);
  t.after(async () => {
    await closeServer(child);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child);
  const joined = await fetch(`${baseUrl}/api/servers/delta-lan/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Folder Tester' })
  });
  assert.equal(joined.status, 200);
  const socket = await connect(wsUrl, 'Folder Tester');
  t.after(() => socket.close());

  const created = await fetch(`${baseUrl}/api/folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Project Documents',
      sender: 'Folder Tester',
      serverId: 'delta-lan',
      channelId: 'general',
      expectedFiles: 2
    })
  });
  assert.equal(created.status, 201);
  const folder = await created.json();

  const traversal = await fetch(`${baseUrl}/api/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'escaped.txt',
      sender: 'Folder Tester',
      serverId: 'delta-lan',
      channelId: 'general',
      folderId: folder.id,
      relativePath: 'Project Documents/../escaped.txt'
    })
  });
  assert.equal(traversal.status, 400);

  const earlyComplete = await fetch(`${baseUrl}/api/folders/${folder.id}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: 'Folder Tester' })
  });
  assert.equal(earlyComplete.status, 409);

  async function uploadFolderFile(relativePath, contents) {
    const name = path.posix.basename(relativePath);
    const allocation = await fetch(`${baseUrl}/api/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        sender: 'Folder Tester',
        serverId: 'delta-lan',
        channelId: 'general',
        folderId: folder.id,
        relativePath
      })
    });
    assert.equal(allocation.status, 201);
    const upload = await allocation.json();
    const response = await fetch(`${baseUrl}/api/uploads/${upload.id}`, {
      method: 'PUT',
      headers: {
        'X-File-Name': encodeURIComponent(name),
        'X-Sender-Name': encodeURIComponent('Folder Tester'),
        'X-Channel-Id': 'general'
      },
      body: contents
    });
    assert.equal(response.status, 201);
  }

  await uploadFolderFile('Project Documents/readme.txt', Buffer.from('folder readme'));
  const partialBootstrap = await fetch(
    `${baseUrl}/api/bootstrap?serverId=delta-lan&name=Folder%20Tester`
  ).then((response) => response.json());
  assert.equal(partialBootstrap.folders.some((item) => item.id === folder.id), false);
  assert.equal(partialBootstrap.files.some((item) => item.folderId === folder.id), false);
  await uploadFolderFile('Project Documents/nested/data.bin', Buffer.from([0, 1, 2, 255]));
  const published = waitForPacket(socket, 'folder:new', (data) => data.id === folder.id);
  const completed = await fetch(`${baseUrl}/api/folders/${folder.id}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: 'Folder Tester' })
  });
  assert.equal(completed.status, 201);
  const folderRecord = (await completed.json()).folder;
  assert.equal(folderRecord.fileIds.length, 2);
  assert.equal(folderRecord.size, 17);
  assert.equal((await published).name, 'Project Documents');

  const bootstrap = await fetch(
    `${baseUrl}/api/bootstrap?serverId=delta-lan&name=Folder%20Tester`
  ).then((response) => response.json());
  assert.equal(bootstrap.folders.some((item) => item.id === folder.id), true);
  assert.equal(bootstrap.files.filter((item) => item.folderId === folder.id).length, 2);

  const query = '?serverId=delta-lan&name=Folder%20Tester';
  const download = await fetch(`${baseUrl}/api/folders/${folder.id}/download${query}`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-type'), /application\/zip/);
  assert.match(download.headers.get('content-disposition'), /Project%20Documents\.zip/);
  const zip = Buffer.from(await download.arrayBuffer());
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.ok(zip.includes(Buffer.from('Project Documents/readme.txt')));
  assert.ok(zip.includes(Buffer.from('Project Documents/nested/data.bin')));
  assert.ok(zip.includes(Buffer.from('folder readme')));
  assert.ok(zip.includes(Buffer.from([0, 1, 2, 255])));

  const interruptedFolder = await fetch(`${baseUrl}/api/folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Interrupted',
      sender: 'Folder Tester',
      serverId: 'delta-lan',
      channelId: 'general',
      expectedFiles: 1
    })
  }).then((response) => response.json());
  const unfinishedPath = 'Interrupted/not-published.txt';
  const unfinishedAllocation = await fetch(`${baseUrl}/api/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: path.posix.basename(unfinishedPath),
      sender: 'Folder Tester',
      serverId: 'delta-lan',
      channelId: 'general',
      folderId: interruptedFolder.id,
      relativePath: unfinishedPath
    })
  }).then((response) => response.json());
  const unfinishedUpload = await fetch(`${baseUrl}/api/uploads/${unfinishedAllocation.id}`, {
    method: 'PUT',
    headers: {
      'X-File-Name': encodeURIComponent(path.posix.basename(unfinishedPath)),
      'X-Sender-Name': encodeURIComponent('Folder Tester'),
      'X-Channel-Id': 'general'
    },
    body: Buffer.from('must not become visible')
  });
  assert.equal(unfinishedUpload.status, 201);
  const filesBeforeRestart = await fetch(`${baseUrl}/api/files${query}`).then((response) => response.json());
  assert.equal(filesBeforeRestart.some((file) => file.name === 'not-published.txt'), false);

  const abortedFolder = await fetch(`${baseUrl}/api/folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Aborted',
      sender: 'Folder Tester',
      serverId: 'delta-lan',
      channelId: 'general',
      expectedFiles: 1
    })
  }).then((response) => response.json());
  const abortedPath = 'Aborted/partial.txt';
  const abortedAllocation = await fetch(`${baseUrl}/api/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: path.posix.basename(abortedPath),
      sender: 'Folder Tester',
      serverId: 'delta-lan',
      channelId: 'general',
      folderId: abortedFolder.id,
      relativePath: abortedPath
    })
  }).then((response) => response.json());
  const interruptedRequest = http.request(`${baseUrl}/api/uploads/${abortedAllocation.id}`, {
    method: 'PUT',
    headers: {
      'X-File-Name': encodeURIComponent(path.posix.basename(abortedPath)),
      'X-Sender-Name': encodeURIComponent('Folder Tester'),
      'X-Channel-Id': 'general'
    }
  });
  interruptedRequest.on('error', () => {});
  interruptedRequest.write(Buffer.alloc(1024 * 1024, 0x41));
  await new Promise((resolve) => setTimeout(() => {
    interruptedRequest.destroy();
    resolve();
  }, 100));
  let canceled;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    canceled = await fetch(`${baseUrl}/api/folders/${abortedFolder.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: 'Folder Tester' })
    });
    if (canceled.status !== 409) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(canceled.status, 200);

  socket.close();
  await closeServer(child);
  child = startServer(port, directory);
  await waitForHealth(baseUrl, child);
  const restored = await fetch(
    `${baseUrl}/api/bootstrap?serverId=delta-lan&name=Folder%20Tester`
  ).then((response) => response.json());
  assert.equal(restored.folders.some((item) => item.id === folder.id), true);
  assert.equal(restored.folders.some((item) => item.id === interruptedFolder.id), false);
  const expired = await fetch(`${baseUrl}/api/folders/${interruptedFolder.id}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: 'Folder Tester' })
  });
  assert.equal(expired.status, 404);
  assert.deepEqual(fs.readdirSync(path.join(directory, 'data', 'uploads', '.staging')), []);
});

test('allows folder transfers above the ordinary API request limit', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-lan-folder-rate-'));
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}`;
  const child = startServer(port, directory);
  t.after(async () => {
    await closeServer(child);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child);
  const joined = await fetch(`${baseUrl}/api/servers/delta-lan/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Folder Rate Tester' })
  });
  assert.equal(joined.status, 200);
  const socket = await connect(wsUrl, 'Folder Rate Tester');
  t.after(() => socket.close());

  const expectedFiles = 121;
  const created = await fetch(`${baseUrl}/api/folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Many Files',
      sender: 'Folder Rate Tester',
      serverId: 'delta-lan',
      channelId: 'general',
      expectedFiles
    })
  });
  assert.equal(created.status, 201);
  const folder = await created.json();

  for (let index = 0; index < expectedFiles; index += 1) {
    const name = `file-${index}.txt`;
    const relativePath = `Many Files/${name}`;
    const allocation = await fetch(`${baseUrl}/api/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        sender: 'Folder Rate Tester',
        serverId: 'delta-lan',
        channelId: 'general',
        folderId: folder.id,
        relativePath
      })
    });
    assert.equal(allocation.status, 201);
    const upload = await allocation.json();
    const response = await fetch(`${baseUrl}/api/uploads/${upload.id}`, {
      method: 'PUT',
      headers: {
        'X-File-Name': encodeURIComponent(name),
        'X-Sender-Name': encodeURIComponent('Folder Rate Tester'),
        'X-Channel-Id': 'general'
      },
      body: Buffer.alloc(0)
    });
    assert.equal(response.status, 201);
  }

  const completed = await fetch(`${baseUrl}/api/folders/${folder.id}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: 'Folder Rate Tester' })
  });
  assert.equal(completed.status, 201);
  assert.equal((await completed.json()).folder.fileIds.length, expectedFiles);
});

'use strict';

const $ = (selector) => document.querySelector(selector);
const channelList = $('#channel-list');
const voiceChannelList = $('#voice-channel-list');
const messageList = $('#message-list');
const membersPanel = $('#members-panel');
const memberList = $('#member-list');
const toastRegion = $('#toast-region');
const fileInput = $('#file-input');
const folderInput = $('#folder-input');
const MAX_NAME_LENGTH = 32;

const state = {
  name: localStorage.getItem('delta-name') || '',
  serverId: localStorage.getItem('delta-server-id') || '',
  servers: [],
  activeServer: null,
  id: null,
  socket: null,
  reconnectTimer: null,
  selectedChannel: 'general',
  channels: [],
  members: [],
  messages: [],
  files: [],
  folders: [],
  voiceChannel: null,
  localStream: null,
  sharingStream: null,
  sharing: false,
  screenSharePending: false,
  shareAudio: false,
  shareAudioTrack: null,
  shareAudioContext: null,
  shareAudioSources: [],
  deafened: false,
  audioContext: null,
  speakingTimers: new Map(),
  remoteVideoTracks: new Map(),
  peers: new Map(),
  candidateQueues: new Map(),
  muted: false,
  notificationAudio: null
};

function send(type, data) {
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ type, data }));
    return true;
  }
  return false;
}

function escapeInitial(name) {
  const trimmed = name.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : '?';
}

function toast(message) {
  const item = document.createElement('div');
  item.className = 'toast';
  item.textContent = message;
  toastRegion.append(item);
  setTimeout(() => item.remove(), 4200);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

function formattedTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function scrollToLatest() {
  messageList.scrollTop = messageList.scrollHeight;
}

function setConnection(status, label) {
  $('#connection-dot').className = `connection-dot ${status}`;
  $('#connection-label').textContent = label;
}

function setProfile(name) {
  $('#profile-name').textContent = name || 'Set your name';
  $('#profile-avatar').textContent = escapeInitial(name);
}

function renderServerRail() {
  const rail = $('#server-list');
  rail.replaceChildren();
  for (const server of state.servers.filter((item) => item.isMember)) {
    const button = document.createElement('button');
    button.className = `rail-server${state.activeServer && server.id === state.activeServer.id ? ' active' : ''}`;
    button.type = 'button';
    button.title = server.name;
    button.setAttribute('aria-label', `Switch to ${server.name}`);
    button.style.setProperty('--server-accent', server.settings.accentColor);
    button.textContent = escapeInitial(server.name);
    button.addEventListener('click', () => activateServer(server.id));
    rail.append(button);
  }
}

function renderChannels() {
  channelList.replaceChildren();
  $('#create-channel').classList.toggle('hidden', !state.activeServer || !state.activeServer.canManage);
  for (const channel of state.channels.filter((item) => item.type === 'text' && item.canAccess !== false)) {
    const button = document.createElement('button');
    button.className = `channel-item${channel.id === state.selectedChannel ? ' active' : ''}`;
    button.type = 'button';
    const hash = document.createElement('span');
    hash.className = 'channel-hash';
    hash.textContent = '#';
    const name = document.createElement('span');
    name.textContent = channel.name;
    button.append(hash, name);
    button.addEventListener('click', () => selectChannel(channel.id));
    channelList.append(button);
  }

  voiceChannelList.replaceChildren();
  for (const channel of state.channels.filter((item) => item.type === 'voice')) {
    const button = document.createElement('button');
    button.className = `voice-channel${state.voiceChannel === channel.id ? ' active' : ''}`;
    button.type = 'button';
    const icon = document.createElement('span');
    icon.className = 'voice-icon';
    icon.textContent = '◖';
    const name = document.createElement('span');
    name.textContent = channel.name;
    const members = state.members.filter((member) => member.voiceChannel === channel.id);
    const count = document.createElement('span');
    count.className = 'voice-count';
    count.textContent = String(members.length);
    button.append(icon, name, count);
    button.addEventListener('click', () => joinVoice(channel.id));
    voiceChannelList.append(button);
    if (members.length) {
      const roster = document.createElement('div');
      roster.className = 'voice-roster';
      for (const member of members) {
        const row = document.createElement('div');
        row.className = 'voice-roster-item';
        row.dataset.memberId = member.id || '';
        const dot = document.createElement('i');
        dot.className = `presence-dot${member.sharing ? ' sharing' : ''}`;
        const memberName = document.createElement('span');
        memberName.textContent = member.name;
        const status = document.createElement('span');
        status.className = 'voice-roster-status';
        status.textContent = [
          member.muted ? 'Muted' : '',
          member.deafened ? 'Deafened' : '',
          member.sharing ? `Sharing${member.shareAudio ? ' · audio' : ''}` : ''
        ].filter(Boolean).join(' · ');
        row.append(dot, memberName, status);
        roster.append(row);
      }
      voiceChannelList.append(roster);
    }
  }

  const activeServer = state.activeServer;
  if (activeServer) {
    $('#active-server-name').textContent = activeServer.name;
    $('.workspace-header .eyebrow').textContent = 'SERVER';
    document.documentElement.style.setProperty('--server-accent', activeServer.settings.accentColor);
  }
}

function selectChannel(id) {
  const channel = state.channels.find((item) => item.id === id);
  if (!channel || channel.type !== 'text' || channel.canAccess === false) return;
  state.selectedChannel = id;
  $('#channel-title').textContent = channel.name;
  $('#message-input').placeholder = `Message #${channel.name}`;
  $('#welcome-card').classList.toggle('hidden', state.messages.some((message) => message.channel === id));
  renderChannels();
  renderMessages();
  renderFiles();
  $('#channel-sidebar')?.classList.remove('open');
  $('.channel-sidebar').classList.remove('open');
}

function renderMessages() {
  messageList.replaceChildren();
  const channelMessages = state.messages.filter((message) => message.channel === state.selectedChannel);
  $('#welcome-card').classList.toggle('hidden', channelMessages.length > 0);
  for (const message of channelMessages) {
    const row = document.createElement('article');
    row.className = 'message';
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = escapeInitial(message.sender);
    const body = document.createElement('div');
    body.className = 'message-body';
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const sender = document.createElement('strong');
    sender.textContent = message.sender;
    const time = document.createElement('time');
    time.dateTime = message.sentAt;
    time.textContent = formattedTime(message.sentAt);
    meta.append(sender, time);
    const text = document.createElement('p');
    text.className = 'message-text';
    text.textContent = message.text;
    body.append(meta, text);
    row.append(avatar, body);
    messageList.append(row);
  }
  renderFiles();
  scrollToLatest();
}

function renderFiles() {
  const channelFolders = state.folders.filter((folder) => folder.channel === state.selectedChannel);
  const folderFileIds = new Set(channelFolders.flatMap((folder) => folder.fileIds));
  for (const folder of channelFolders) {
    if (messageList.querySelector(`[data-folder-id="${CSS.escape(folder.id)}"]`)) continue;
    const row = document.createElement('article');
    row.className = 'message';
    row.dataset.folderId = folder.id;
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = escapeInitial(folder.sender);
    const body = document.createElement('div');
    body.className = 'message-body';
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const sender = document.createElement('strong');
    sender.textContent = folder.sender;
    const time = document.createElement('time');
    time.dateTime = folder.uploadedAt;
    time.textContent = `${formattedTime(folder.uploadedAt)} · shared a folder`;
    meta.append(sender, time);
    const card = document.createElement('div');
    card.className = 'file-card folder-card';
    const symbol = document.createElement('div');
    symbol.className = 'file-symbol folder-symbol';
    symbol.textContent = '▰';
    const details = document.createElement('div');
    details.className = 'file-details';
    const name = document.createElement('strong');
    name.textContent = folder.name;
    name.title = folder.name;
    const info = document.createElement('span');
    const fileCount = folder.fileIds.length;
    info.textContent = `${fileCount} ${fileCount === 1 ? 'file' : 'files'} · ${formatBytes(folder.size)}`;
    details.append(name, info);
    const download = document.createElement('a');
    download.className = 'download-link';
    const query = new URLSearchParams({ serverId: state.activeServer.id, name: state.name });
    download.href = `/api/folders/${encodeURIComponent(folder.id)}/download?${query}`;
    download.download = `${folder.name}.zip`;
    download.textContent = 'Download folder';
    download.setAttribute('aria-label', `Download folder ${folder.name}`);
    card.append(symbol, details, download);
    body.append(meta, card);
    row.append(avatar, body);
    messageList.append(row);
  }
  for (const file of state.files.filter((item) =>
    item.channel === state.selectedChannel && !folderFileIds.has(item.id)
  )) {
    if (messageList.querySelector(`[data-file-id="${CSS.escape(file.id)}"]`)) continue;
    const row = document.createElement('article');
    row.className = 'message';
    row.dataset.fileId = file.id;
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = escapeInitial(file.sender);
    const body = document.createElement('div');
    body.className = 'message-body';
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const sender = document.createElement('strong');
    sender.textContent = file.sender;
    const time = document.createElement('time');
    time.dateTime = file.uploadedAt;
    time.textContent = `${formattedTime(file.uploadedAt)} · shared a file`;
    meta.append(sender, time);
    const card = document.createElement('div');
    card.className = 'file-card';
    const symbol = document.createElement('div');
    symbol.className = 'file-symbol';
    symbol.textContent = '↧';
    const details = document.createElement('div');
    details.className = 'file-details';
    const name = document.createElement('strong');
    name.textContent = file.name;
    name.title = file.name;
    const info = document.createElement('span');
    info.textContent = formatBytes(file.size);
    details.append(name, info);
    const download = document.createElement('a');
    download.className = 'download-link';
    const query = new URLSearchParams({ serverId: state.activeServer.id, name: state.name });
    download.href = `/api/files/${encodeURIComponent(file.id)}/download?${query}`;
    download.download = file.name;
    download.textContent = 'Download';
    download.setAttribute('aria-label', `Download ${file.name}`);
    card.append(symbol, details, download);
    body.append(meta, card);
    row.append(avatar, body);
    messageList.append(row);
  }
  scrollToLatest();
}

function renderMembers() {
  memberList.replaceChildren();
  const onlineMembers = state.members.filter((member) => member.online !== false);
  const offlineMembers = state.members.filter((member) => member.online === false);
  const addGroup = (label, members) => {
    if (!members.length) return;
    const heading = document.createElement('div');
    heading.className = 'member-group-title';
    heading.textContent = `${label} ${members.length}`;
    memberList.append(heading);
    for (const member of members) {
      const row = document.createElement('div');
      row.className = 'member-row';
      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.textContent = escapeInitial(member.name);
      const name = document.createElement('span');
      name.className = 'member-name';
      name.textContent = member.name;
      const status = document.createElement('i');
      status.className = `presence-dot${member.online === false ? ' offline' : ''}`;
      status.title = member.online === false ? 'Offline' : 'Online';
      row.append(avatar, name, status);
      if (member.voiceChannel) {
        const voice = document.createElement('span');
        voice.className = 'member-voice';
        const statuses = [
          member.muted ? 'Microphone muted' : 'Microphone on',
          member.deafened ? 'Deafened' : '',
          member.sharing ? `Sharing screen${member.shareAudio ? ' with audio' : ''}` : ''
        ].filter(Boolean);
        voice.textContent = [
          member.muted ? '◌' : '◖',
          member.deafened ? '⌁' : '',
          member.sharing ? '▣' : ''
        ].filter(Boolean).join(' ');
        voice.title = statuses.join(' · ');
        row.append(voice);
      }
      memberList.append(row);
    }
  }
  $('#member-count').textContent = String(onlineMembers.length);
  addGroup('ONLINE', onlineMembers);
  addGroup('OFFLINE', offlineMembers);
  renderChannels();
  if (state.voiceChannel) {
    const channel = state.channels.find((item) => item.id === state.voiceChannel);
    const voice = state.members.filter((member) => member.voiceChannel === state.voiceChannel);
    $('#voice-dock-members').textContent = `${channel ? channel.name : 'Voice'} · ${voice.map((member) => member.name).join(', ')}`;
    renderVoiceStage();
  }
}

function renderVoiceStage() {
  if (!state.voiceChannel) return;
  const channel = state.channels.find((item) => item.id === state.voiceChannel);
  const members = state.members.filter((member) => member.voiceChannel === state.voiceChannel);
  $('#voice-stage-title').textContent = channel ? channel.name : 'Voice';
  $('#channel-title').textContent = channel ? channel.name : 'Voice';
  $('#voice-dock-members').textContent = `${channel ? channel.name : 'Voice'} · ${members.length} connected`;
  const screenList = $('#screen-share-list');
  const sharers = members.filter((member) => member.sharing);
  if (!sharers.length) {
    const empty = document.createElement('div');
    empty.className = 'screen-share-empty';
    empty.textContent = 'No one is sharing their screen yet.';
    screenList.replaceChildren(empty);
  } else {
    screenList.querySelector('.screen-share-empty')?.remove();
    const existingCards = new Map(Array.from(screenList.querySelectorAll('.screen-share-card'))
      .map((card) => [card.dataset.memberId, card]));
    for (const sharer of sharers) {
      let card = existingCards.get(sharer.id);
      if (!card) {
        card = document.createElement('article');
        card.className = 'screen-share-card';
        card.dataset.memberId = sharer.id;
        const header = document.createElement('div');
        header.className = 'screen-share-caption';
        header.append(document.createElement('strong'), document.createElement('span'));
        const video = document.createElement('video');
        video.className = 'screen-share-video';
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;
        card.append(header, video);
      }
      card.querySelector('.screen-share-caption strong').textContent = `${sharer.name} is sharing`;
      card.querySelector('.screen-share-caption span').textContent =
        sharer.shareAudio ? 'Audio sharing enabled' : 'Screen only';
      const video = card.querySelector('video');
      const track = state.remoteVideoTracks.get(sharer.id);
      if (track) {
        if (!video.srcObject || video.srcObject.getVideoTracks()[0] !== track) {
          video.srcObject = new MediaStream([track]);
          video.play().catch(() => {});
        }
        video.classList.remove('video-pending');
        video.setAttribute('aria-label', `Screen shared by ${sharer.name}`);
      } else {
        video.classList.add('video-pending');
        video.setAttribute('aria-label', `Waiting for ${sharer.name}'s screen`);
      }
      screenList.append(card);
      existingCards.delete(sharer.id);
    }
    for (const card of existingCards.values()) card.remove();
  }

  const participantList = $('#voice-participants');
  participantList.replaceChildren();
  for (const member of members) {
    const card = document.createElement('article');
    card.className = 'voice-participant';
    card.dataset.memberId = member.id || '';
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = escapeInitial(member.name);
    const name = document.createElement('strong');
    name.textContent = member.name;
    const status = document.createElement('div');
    status.className = 'voice-participant-status';
    const indicators = [
      member.muted ? 'Mic muted' : 'Mic on',
      member.deafened ? 'Deafened' : '',
      member.sharing ? 'Sharing screen' : ''
    ].filter(Boolean);
    status.textContent = indicators.join(' · ');
    card.append(avatar, name, status);
    participantList.append(card);
  }
  $('#screen-share-button').disabled = Boolean(state.sharing || state.screenSharePending);
  $('#screen-share-button').classList.toggle('hidden', state.sharing);
  $('#stop-sharing-button').classList.toggle('hidden', !state.sharing);
  $('#mute-button').classList.toggle('muted', state.muted);
  $('#mute-button').textContent = state.muted ? 'Unmute' : 'Mute';
  $('#mute-button').setAttribute('aria-label', state.muted ? 'Unmute microphone' : 'Mute microphone');
  $('#deafen-button').classList.toggle('muted', state.deafened);
  $('#deafen-button').textContent = state.deafened ? 'Undeafen' : 'Deafen';
  $('#deafen-button').setAttribute('aria-label', state.deafened ? 'Undeafen' : 'Deafen');
}

function addMessage(message) {
  if (!message || state.messages.some((item) => item.id === message.id)) return;
  state.messages.push(message);
  if (message.channel === state.selectedChannel) {
    renderMessages();
    if (message.senderId !== state.id) notify(`New message from ${message.sender}`);
  }
}

function addFile(file, notifyUser) {
  if (!file || state.files.some((item) => item.id === file.id)) return;
  state.files.push(file);
  if (file.channel === state.selectedChannel) renderFiles();
  if (notifyUser && file.sender !== state.name) notify(`${file.sender} shared ${file.name}`);
}

function addFolder(folder, notifyUser) {
  if (!folder || !state.activeServer || folder.serverId !== state.activeServer.id ||
      state.folders.some((item) => item.id === folder.id)) return;
  state.folders.push(folder);
  if (folder.channel === state.selectedChannel) renderFiles();
  if (notifyUser && folder.sender !== state.name) notify(`${folder.sender} shared the folder ${folder.name}`);
}

function notify(message) {
  toast(message);
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    new Notification('Delta LAN Messenger', { body: message });
  }
}

async function loadBootstrap() {
  if (!state.activeServer) throw new Error('Choose a server first.');
  const query = new URLSearchParams({ serverId: state.activeServer.id, name: state.name });
  const response = await fetch(`/api/bootstrap?${query}`);
  if (!response.ok) throw new Error(`Server returned ${response.status}`);
  const data = await response.json();
  state.activeServer = data.server;
  state.serverId = data.server.id;
  state.channels = data.channels;
  state.messages = data.messages;
  state.files = data.files;
  state.folders = data.folders || [];
  state.members = data.members;
  if (!state.channels.some((channel) =>
    channel.id === state.selectedChannel && channel.type === 'text' && channel.canAccess !== false
  )) {
    state.selectedChannel = state.channels.find((channel) =>
      channel.type === 'text' && channel.canAccess !== false
    )?.id || '';
  }
  $('#channel-title').textContent = state.channels.find((channel) => channel.id === state.selectedChannel)?.name || '';
  $('#message-input').placeholder = `Message #${$('#channel-title').textContent}`;
  renderServerRail();
  renderChannels();
  renderMembers();
  renderMessages();
}

async function loadServers() {
  const query = new URLSearchParams();
  if (state.name) query.set('name', state.name);
  const response = await fetch(`/api/servers?${query}`);
  if (!response.ok) throw new Error(`Could not load servers (${response.status}).`);
  state.servers = await response.json();
  if (state.activeServer) {
    state.activeServer = state.servers.find((server) => server.id === state.activeServer.id) || state.activeServer;
  }
  renderServerRail();
  return state.servers;
}

async function postJSON(url, data, method = 'POST') {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Server returned ${response.status}.`);
  return result;
}

function disconnectSocket() {
  clearTimeout(state.reconnectTimer);
  if (state.voiceChannel) leaveVoice(true);
  const socket = state.socket;
  state.socket = null;
  state.id = null;
  if (socket) socket.close();
}

async function activateServer(serverId) {
  const server = state.servers.find((item) => item.id === serverId && item.isMember);
  if (!server) return;
  if (state.activeServer && state.activeServer.id === serverId &&
      state.socket && state.socket.readyState < WebSocket.CLOSING) return;
  disconnectSocket();
  state.activeServer = server;
  state.serverId = server.id;
  localStorage.setItem('delta-server-id', server.id);
  state.messages = [];
  state.files = [];
  state.folders = [];
  state.members = [];
  state.channels = [];
  state.selectedChannel = 'general';
  renderServerRail();
  renderChannels();
  renderMessages();
  try {
    await loadBootstrap();
    connectSocket();
  } catch (error) {
    setConnection('offline', 'Server unavailable');
    toast(error.message);
  }
}

function connectSocket() {
  clearTimeout(state.reconnectTimer);
  if (!state.activeServer) return;
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${scheme}//${location.host}`);
  state.socket = socket;
  setConnection('connecting', 'Connecting');
  socket.addEventListener('open', () => {
    if (state.socket === socket && state.activeServer) {
      send('hello', { name: state.name, serverId: state.activeServer.id });
    }
  });
  socket.addEventListener('message', async (event) => {
    if (state.socket !== socket) return;
    let packet;
    try { packet = JSON.parse(event.data); } catch { return; }
    const { type, data } = packet;
    if (type === 'hello:ok') {
      state.id = data.id;
      setConnection('', 'Connected');
      return;
    }
    if (type === 'server:updated') {
      state.activeServer = data;
      state.servers = state.servers.map((server) => server.id === data.id ? { ...server, ...data } : server);
      renderServerRail();
      await loadBootstrap();
      renderServerSettings();
      if (!$('#server-channels-panel').classList.contains('hidden')) renderChannelManagement();
    } else if (type === 'channel:updated') {
      const previousChannel = state.selectedChannel;
      await loadBootstrap();
      if (!state.channels.some((channel) =>
        channel.id === previousChannel && channel.type === 'text' && channel.canAccess !== false
      )) {
        const firstChannel = state.channels.find((channel) => channel.type === 'text' && channel.canAccess !== false);
        if (firstChannel) selectChannel(firstChannel.id);
      }
      if (!$('#server-channels-panel').classList.contains('hidden')) renderChannelManagement();
    } else if (type === 'presence') {
      state.members = data;
      renderMembers();
    } else if (type === 'message:new') {
      addMessage(data);
    } else if (type === 'file:new') {
      addFile(data, true);
    } else if (type === 'folder:new') {
      addFolder(data, true);
    } else if (type === 'error') {
      toast(data.message || 'The server reported an error.');
    } else if (type === 'voice:participants') {
      for (const peer of data.members) {
        if (state.id && state.id.localeCompare(peer.id) < 0) await makeOffer(peer);
      }
    } else if (type === 'voice:state') {
      state.members = data.members.length
        ? [...state.members.filter((member) => !member.voiceChannel || member.voiceChannel !== data.channel),
          ...data.members.map((member) => ({ ...member, voiceChannel: data.channel }))]
        : state.members.filter((member) => member.voiceChannel !== data.channel);
      renderMembers();
      if (state.voiceChannel === data.channel && state.id) {
        const activeIds = new Set(data.members.map((member) => member.id));
        for (const peerId of state.peers.keys()) {
          if (!activeIds.has(peerId)) removePeer(peerId);
        }
        for (const peer of data.members) {
          if (peer.id !== state.id && state.id.localeCompare(peer.id) < 0 && !state.peers.has(peer.id)) {
            await makeOffer(peer);
          }
        }
        if (!data.members.length && state.voiceChannel === data.channel) {
          leaveVoice(false);
          toast('You were disconnected from the voice channel.');
        }
      }
    } else if (type === 'voice:signal') {
      await handleSignal(data);
    }
  });
  socket.addEventListener('close', () => {
    if (state.socket !== socket) return;
    setConnection('offline', 'Reconnecting');
    if (state.voiceChannel) leaveVoice(false);
    state.reconnectTimer = setTimeout(connectSocket, 1800);
  });
  socket.addEventListener('error', () => setConnection('offline', 'Connection issue'));
}

function renderProgress(label) {
  const wrapper = document.createElement('div');
  wrapper.className = 'upload-progress';
  const top = document.createElement('div');
  top.className = 'upload-progress-top';
  const name = document.createElement('span');
  name.textContent = label;
  const value = document.createElement('span');
  value.textContent = 'Preparing…';
  top.append(name, value);
  const track = document.createElement('div');
  track.className = 'progress-track';
  const fill = document.createElement('div');
  fill.className = 'progress-fill';
  track.append(fill);
  wrapper.append(top, track);
  $('#upload-progress-list').append(wrapper);
  return { wrapper, value, fill };
}

async function uploadFile(file, folderUpload = null) {
  const progress = renderProgress(folderUpload ? folderUpload.relativePath : file.name);
  const serverId = state.activeServer && state.activeServer.id;
  const channelId = state.selectedChannel;
  const sender = state.name;
  try {
    const uploadDetails = { name: file.name, sender, serverId, channelId };
    if (folderUpload) {
      uploadDetails.folderId = folderUpload.folderId;
      uploadDetails.relativePath = folderUpload.relativePath;
    }
    const allocated = await fetch('/api/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(uploadDetails)
    });
    if (!allocated.ok) throw new Error((await allocated.json()).error || 'Could not start upload.');
    const { id, name } = await allocated.json();
    progress.value.textContent = '0%';
    const result = await new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('PUT', `/api/uploads/${encodeURIComponent(id)}`);
      request.setRequestHeader('Content-Type', 'application/octet-stream');
      request.setRequestHeader('X-File-Name', encodeURIComponent(name));
      request.setRequestHeader('X-Sender-Name', encodeURIComponent(sender));
      request.setRequestHeader('X-Channel-Id', channelId);
      request.upload.addEventListener('progress', (event) => {
        if (!event.lengthComputable) {
          progress.value.textContent = formatBytes(event.loaded);
          return;
        }
        const percent = Math.floor((event.loaded / event.total) * 100);
        progress.value.textContent = `${percent}%`;
        progress.fill.style.width = `${percent}%`;
      });
      request.addEventListener('load', () => {
        if (request.status < 200 || request.status >= 300) {
          let reason = 'Upload failed.';
          try { reason = JSON.parse(request.responseText).error || reason; } catch {}
          reject(new Error(reason));
          return;
        }
        try {
          resolve(JSON.parse(request.responseText));
        } catch {
          reject(new Error('The server returned an invalid upload response.'));
        }
      });
      request.addEventListener('error', () => reject(new Error('Network interrupted during upload. The incomplete file was discarded.')));
      request.addEventListener('abort', () => reject(new Error('Upload canceled.')));
      request.send(file);
    });
    progress.value.textContent = 'Complete';
    progress.fill.style.width = '100%';
    if (!folderUpload && state.activeServer && state.activeServer.id === serverId) addFile(result, false);
    setTimeout(() => progress.wrapper.remove(), 3500);
    return result;
  } catch (error) {
    progress.value.textContent = 'Failed';
    progress.value.title = error.message;
    progress.fill.style.background = '#ed6b78';
    toast(`${folderUpload ? folderUpload.relativePath : file.name}: ${error.message}`);
    return null;
  }
}

async function uploadFolder(files) {
  if (!files.length) {
    toast('The selected folder contains no files to share.');
    return;
  }
  const relativePaths = files.map((file) => file.webkitRelativePath || '');
  const folderName = relativePaths[0].split('/')[0];
  if (!folderName || relativePaths.some((value) => !value || value.split('/')[0] !== folderName)) {
    toast('Choose one folder at a time using a browser that supports folder selection.');
    return;
  }

  const serverId = state.activeServer && state.activeServer.id;
  const channelId = state.selectedChannel;
  const sender = state.name;
  const progress = renderProgress(folderName);
  let folderId = '';
  try {
    const started = await postJSON('/api/folders', {
      name: folderName,
      sender,
      serverId,
      channelId,
      expectedFiles: files.length
    });
    folderId = started.id;
    for (let index = 0; index < files.length; index += 1) {
      const uploaded = await uploadFile(files[index], {
        folderId,
        relativePath: relativePaths[index]
      });
      if (!uploaded) throw new Error('A file could not be uploaded; the folder was not published.');
      progress.value.textContent = `${index + 1}/${files.length} files`;
      progress.fill.style.width = `${Math.floor(((index + 1) / files.length) * 100)}%`;
    }
    const completed = await postJSON(`/api/folders/${encodeURIComponent(folderId)}/complete`, { sender });
    addFolder(completed.folder, false);
    progress.value.textContent = 'Complete';
    progress.fill.style.width = '100%';
    toast(`Folder shared: ${folderName}`);
    setTimeout(() => progress.wrapper.remove(), 3500);
  } catch (error) {
    progress.value.textContent = 'Failed';
    progress.value.title = error.message;
    progress.fill.style.background = '#ed6b78';
    toast(`${folderName}: ${error.message}`);
    if (folderId) {
      try {
        await postJSON(`/api/folders/${encodeURIComponent(folderId)}`, { sender }, 'DELETE');
      } catch (cleanupError) {
        toast(`Could not clean up the interrupted folder upload: ${cleanupError.message}`);
      }
    }
  }
}

const SHARE_PRESETS = {
  low: { resolution: '480', framerate: '15', bitrate: 600_000 },
  balanced: { resolution: '720', framerate: '30', bitrate: 2_500_000 },
  high: { resolution: '1080', framerate: '30', bitrate: 5_000_000 },
  ultra: { resolution: 'source', framerate: '60', bitrate: 8_000_000 }
};

function setVoiceScreen(active) {
  $('#voice-stage').classList.toggle('hidden', !active);
  for (const selector of ['#welcome-card', '#message-list', '#upload-progress-list', '#composer', '.composer-hint']) {
    $(selector).classList.toggle('hidden', active);
  }
  const channel = state.channels.find((item) => item.id === state.voiceChannel);
  $('#channel-title').textContent = active
    ? (channel ? channel.name : 'Voice')
    : (state.channels.find((item) => item.id === state.selectedChannel)?.name || '');
  $('#message-input').placeholder = `Message #${$('#channel-title').textContent}`;
  $('.channel-header .hash-mark').textContent = active ? '◖' : '#';
  if (!active) {
    $('#welcome-card').classList.toggle(
      'hidden',
      state.messages.some((message) => message.channel === state.selectedChannel)
    );
  }
}

function shareConfiguration() {
  const preset = SHARE_PRESETS[$('#share-preset').value] || SHARE_PRESETS.balanced;
  const resolution = $('#share-resolution').value;
  const framerate = Number($('#share-framerate').value);
  const heights = { 480: 480, 720: 720, 1080: 1080 };
  return {
    resolution,
    framerate,
    height: heights[resolution] || null,
    bitrate: preset.bitrate
  };
}

async function applyShareQuality(track) {
  const config = shareConfiguration();
  const constraints = { frameRate: { ideal: config.framerate, max: config.framerate } };
  if (config.height) {
    constraints.width = { ideal: Math.round(config.height * 16 / 9), max: Math.round(config.height * 16 / 9) };
    constraints.height = { ideal: config.height, max: config.height };
  }
  try {
    await track.applyConstraints(constraints);
  } catch (error) {
    toast(`The browser could not apply all selected capture limits: ${error.message}`);
  }
  for (const pc of state.peers.values()) {
    const sender = pc.getTransceivers().find((transceiver) =>
      transceiver.receiver.track.kind === 'video'
    )?.sender;
    if (!sender || !sender.track) continue;
    const parameters = sender.getParameters();
    if (!parameters.encodings || !parameters.encodings.length) parameters.encodings = [{}];
    parameters.encodings[0].maxBitrate = config.bitrate;
    parameters.encodings[0].maxFramerate = config.framerate;
    try {
      await sender.setParameters(parameters);
    } catch (error) {
      toast(`Could not update screen-share encoding: ${error.message}`);
    }
  }
}

async function createShareAudioTrack(displayAudioTrack) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error('Web Audio is not available in this browser.');
  const context = new AudioContextClass();
  const destination = context.createMediaStreamDestination();
  const microphone = state.localStream && state.localStream.getAudioTracks()[0];
  if (!microphone) {
    await context.close();
    throw new Error('The microphone audio track is unavailable.');
  }
  const sources = [context.createMediaStreamSource(new MediaStream([microphone]))];
  if (displayAudioTrack) sources.push(context.createMediaStreamSource(new MediaStream([displayAudioTrack])));
  for (const source of sources) source.connect(destination);
  await context.resume();
  state.shareAudioContext = context;
  state.shareAudioSources = sources;
  state.shareAudioTrack = destination.stream.getAudioTracks()[0];
  try {
    await replacePeerAudioTrack(state.shareAudioTrack);
  } catch (error) {
    try {
      await replacePeerAudioTrack(microphone);
    } catch (restoreError) {
      toast(`Could not restore microphone audio after enabling shared audio: ${restoreError.message}`);
    }
    for (const source of sources) source.disconnect();
    state.shareAudioSources = [];
    state.shareAudioTrack.stop();
    state.shareAudioTrack = null;
    await context.close();
    state.shareAudioContext = null;
    throw error;
  }
  return state.shareAudioTrack;
}

async function replacePeerAudioTrack(track) {
  const replacements = [];
  for (const pc of state.peers.values()) {
    const sender = pc.getSenders().find((item) => item.track && item.track.kind === 'audio');
    if (sender) replacements.push(sender.replaceTrack(track));
  }
  await Promise.all(replacements);
}

async function startScreenShare() {
  if (!state.voiceChannel || state.sharing || state.screenSharePending) return;
  if (!window.isSecureContext || !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
    toast('Screen capture requires a supported browser in a trusted HTTPS context. Open this app using the local HTTPS certificate.');
    return;
  }
  const channelId = state.voiceChannel;
  state.screenSharePending = true;
  renderVoiceStage();
  const config = shareConfiguration();
  const video = config.height
    ? {
      width: { ideal: Math.round(config.height * 16 / 9), max: Math.round(config.height * 16 / 9) },
      height: { ideal: config.height, max: config.height },
      frameRate: { ideal: config.framerate, max: config.framerate }
    }
    : { frameRate: { ideal: config.framerate, max: config.framerate } };
  const includeAudio = $('#share-audio').checked;
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: includeAudio });
    if (state.voiceChannel !== channelId) {
      for (const track of stream.getTracks()) track.stop();
      toast('Screen capture was stopped because you left the voice channel.');
      return;
    }
    const screenTrack = stream.getVideoTracks()[0];
    if (!screenTrack) {
      for (const track of stream.getTracks()) track.stop();
      toast('The browser did not provide a screen video track.');
      return;
    }
    state.sharingStream = stream;
    state.sharing = true;
    state.shareAudio = includeAudio && stream.getAudioTracks().length > 0;
    if (state.shareAudio) {
      try {
        await createShareAudioTrack(stream.getAudioTracks()[0]);
      } catch (error) {
        state.shareAudio = false;
        toast(`Screen audio could not be shared: ${error.message}`);
      }
    } else if (includeAudio) {
      toast('This browser or selected screen does not provide system/tab audio. Sharing video only.');
    }
    for (const pc of state.peers.values()) {
      const sender = pc.getTransceivers().find((transceiver) =>
        transceiver.receiver.track.kind === 'video'
      )?.sender;
      if (sender) {
        try {
          await sender.replaceTrack(screenTrack);
        } catch (error) {
          toast(`Could not share video with one participant: ${error.message}`);
        }
      }
    }
    await applyShareQuality(screenTrack);
    screenTrack.addEventListener('ended', () => {
      if (state.sharingStream === stream) stopScreenShare(true);
    }, { once: true });
    for (const audioTrack of stream.getAudioTracks()) {
      audioTrack.addEventListener('ended', () => {
        if (state.sharingStream === stream && state.shareAudio) {
          $('#share-audio').checked = false;
          stopSharedAudio().catch((error) => toast(`Could not stop shared audio cleanly: ${error.message}`));
        }
      }, { once: true });
    }
    send('voice:share', { sharing: true, shareAudio: state.shareAudio });
    renderVoiceStage();
  } catch (error) {
    if (state.sharingStream) {
      try {
        await stopScreenShare(false);
      } catch (cleanupError) {
        toast(`Could not clean up the failed screen share: ${cleanupError.message}`);
      }
    }
    if (error.name === 'NotAllowedError' || error.name === 'AbortError') {
      if (error.name === 'NotAllowedError') toast('Screen-share permission was denied. Allow capture in the browser picker and try again.');
      return;
    }
    toast(`Could not start screen sharing: ${error.message}`);
  } finally {
    state.screenSharePending = false;
    renderVoiceStage();
  }
}

async function stopSharedAudio() {
  const microphone = state.localStream && state.localStream.getAudioTracks()[0];
  let failure;
  if (microphone) {
    try {
      await replacePeerAudioTrack(microphone);
    } catch (error) {
      failure = error;
    }
  }
  for (const source of state.shareAudioSources) source.disconnect();
  state.shareAudioSources = [];
  if (state.shareAudioContext) {
    try {
      await state.shareAudioContext.close();
    } catch (error) {
      failure = failure || error;
    }
  }
  state.shareAudioContext = null;
  if (state.shareAudioTrack) state.shareAudioTrack.stop();
  state.shareAudioTrack = null;
  state.shareAudio = false;
  send('voice:share', { sharing: state.sharing, shareAudio: false });
  renderVoiceStage();
  if (failure) throw failure;
}

async function stopScreenShare(notifyServer = true) {
  const stream = state.sharingStream;
  if (!stream && !state.sharing) return;
  state.sharing = false;
  state.sharingStream = null;
  for (const pc of state.peers.values()) {
    const sender = pc.getTransceivers().find((transceiver) =>
      transceiver.receiver.track.kind === 'video'
    )?.sender;
    if (sender) {
      try {
        await sender.replaceTrack(null);
      } catch (error) {
        toast(`Could not stop a screen-share connection cleanly: ${error.message}`);
      }
    }
  }
  for (const track of stream ? stream.getTracks() : []) track.stop();
  if (state.shareAudio) await stopSharedAudio();
  else if (state.shareAudioContext) {
    const microphone = state.localStream && state.localStream.getAudioTracks()[0];
    if (microphone) {
      try {
        await replacePeerAudioTrack(microphone);
      } catch (error) {
        toast(`Could not restore microphone audio after screen sharing: ${error.message}`);
      }
    }
    for (const source of state.shareAudioSources) source.disconnect();
    state.shareAudioSources = [];
    await state.shareAudioContext.close();
    state.shareAudioContext = null;
  }
  state.shareAudio = false;
  if (notifyServer) send('voice:share', { sharing: false, shareAudio: false });
  renderVoiceStage();
}

function startSpeakingMeter(memberId, track) {
  if (!window.AudioContext && !window.webkitAudioContext) return;
  try {
    const previous = state.speakingTimers.get(memberId);
    if (previous) {
      clearInterval(previous.timer);
      previous.source.disconnect();
    }
    state.audioContext = state.audioContext || new (window.AudioContext || window.webkitAudioContext)();
    const analyser = state.audioContext.createAnalyser();
    analyser.fftSize = 512;
    const source = state.audioContext.createMediaStreamSource(new MediaStream([track]));
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      let total = 0;
      for (const sample of samples) {
        const normalized = (sample - 128) / 128;
        total += normalized * normalized;
      }
      const member = state.members.find((item) => item.id === memberId);
      const speaking = Boolean(member && !member.muted && !member.shareAudio &&
        Math.sqrt(total / samples.length) > 0.045);
      document.querySelectorAll(`[data-member-id="${CSS.escape(memberId)}"]`).forEach((item) =>
        item.classList.toggle('speaking', speaking)
      );
    }, 140);
    state.speakingTimers.set(memberId, { timer, source });
  } catch (error) {
    toast(`Speaking indicators are unavailable: ${error.message}`);
  }
}

async function createPeer(member) {
  if (state.peers.has(member.id) || !state.localStream) return state.peers.get(member.id);
  const pc = new RTCPeerConnection({ iceServers: [] });
  state.peers.set(member.id, pc);
  state.candidateQueues.set(member.id, []);
  const microphone = state.shareAudioTrack || state.localStream.getAudioTracks()[0];
  if (microphone) pc.addTrack(microphone, new MediaStream([microphone]));
  const videoTransceiver = pc.addTransceiver('video', { direction: 'sendrecv' });
  if (state.sharingStream) {
    await videoTransceiver.sender.replaceTrack(state.sharingStream.getVideoTracks()[0]);
    await applyShareQuality(state.sharingStream.getVideoTracks()[0]);
  }
  pc.addEventListener('icecandidate', (event) => {
    if (event.candidate) send('voice:signal', { targetId: member.id, signal: { candidate: event.candidate } });
  });
  pc.addEventListener('track', (event) => {
    if (event.track.kind === 'video') {
      state.remoteVideoTracks.set(member.id, event.track);
      event.track.addEventListener('ended', () => {
        if (state.remoteVideoTracks.get(member.id) === event.track) {
          state.remoteVideoTracks.delete(member.id);
          renderVoiceStage();
        }
      }, { once: true });
      renderVoiceStage();
      return;
    }
    let audio = document.querySelector(`[data-peer-audio="${CSS.escape(member.id)}"]`);
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      audio.dataset.peerAudio = member.id;
      document.body.append(audio);
    }
    audio.muted = state.deafened;
    audio.srcObject = new MediaStream([event.track]);
    audio.play().catch(() => toast('Audio playback was blocked. Click the page to enable audio.'));
    startSpeakingMeter(member.id, event.track);
  });
  pc.addEventListener('connectionstatechange', () => {
    clearTimeout(pc.disconnectTimer);
    if (pc.connectionState === 'failed') {
      pc.disconnectTimer = setTimeout(() => {
        if (state.peers.get(member.id) !== pc || !state.voiceChannel) return;
        removePeer(member.id);
        if (state.id.localeCompare(member.id) < 0) makeOffer(member);
      }, 1200);
    } else if (pc.connectionState === 'closed') {
      removePeer(member.id);
    } else if (pc.connectionState === 'disconnected') {
      pc.disconnectTimer = setTimeout(() => {
        if (pc.connectionState !== 'disconnected' || state.peers.get(member.id) !== pc) return;
        removePeer(member.id);
        if (state.voiceChannel && state.id.localeCompare(member.id) < 0) makeOffer(member);
      }, 10_000);
    }
  });
  return pc;
}

async function makeOffer(member) {
  try {
    if (state.peers.has(member.id)) return;
    const pc = await createPeer(member);
    if (!pc || pc.signalingState !== 'stable') return;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send('voice:signal', { targetId: member.id, signal: { description: pc.localDescription } });
  } catch (error) {
    toast(`Could not start voice with ${member.name}: ${error.message}`);
  }
}

async function handleSignal(packet) {
  try {
    const member = state.members.find((item) => item.id === packet.fromId) || { id: packet.fromId, name: packet.fromName };
    const pc = await createPeer(member);
    if (!pc) return;
    if (packet.signal.description) {
      await pc.setRemoteDescription(packet.signal.description);
      const queued = state.candidateQueues.get(member.id) || [];
      for (const candidate of queued) await pc.addIceCandidate(candidate);
      state.candidateQueues.set(member.id, []);
      if (packet.signal.description.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send('voice:signal', { targetId: member.id, signal: { description: pc.localDescription } });
      }
    } else if (packet.signal.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(packet.signal.candidate);
      else state.candidateQueues.get(member.id).push(packet.signal.candidate);
    }
  } catch (error) {
    toast(`Voice connection error: ${error.message}`);
  }
}

function removePeer(id) {
  const pc = state.peers.get(id);
  if (pc) {
    clearTimeout(pc.disconnectTimer);
    pc.close();
  }
  state.peers.delete(id);
  state.candidateQueues.delete(id);
  const meter = state.speakingTimers.get(id);
  if (meter) {
    clearInterval(meter.timer);
    meter.source.disconnect();
    state.speakingTimers.delete(id);
  }
  state.remoteVideoTracks.delete(id);
  document.querySelector(`[data-peer-audio="${CSS.escape(id)}"]`)?.remove();
  renderVoiceStage();
}

async function joinVoice(channelId) {
  if (state.voiceChannel === channelId) return;
  const channel = state.channels.find((item) => item.id === channelId && item.type === 'voice');
  if (!channel) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('Microphone access requires HTTPS. Open this site using the trusted local HTTPS certificate.');
    return;
  }
  try {
    if (state.voiceChannel) {
      send('voice:leave', {});
      await stopScreenShare(false);
      for (const id of [...state.peers.keys()]) removePeer(id);
      state.voiceChannel = null;
    }
    if (!state.localStream) {
      state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }
    for (const track of state.localStream.getAudioTracks()) track.enabled = !state.muted;
    state.voiceChannel = channelId;
    $('#voice-dock').classList.remove('hidden');
    $('#voice-dock-members').textContent = `${channel.name} · Connecting…`;
    renderChannels();
    setVoiceScreen(true);
    if (!send('voice:join', { channel: state.voiceChannel })) {
      leaveVoice(false);
      toast('Voice server disconnected. Rejoin after the connection is restored.');
      return;
    }
    if (state.muted) send('voice:mute', { muted: true });
    if (state.deafened) send('voice:deafen', { deafened: true });
    renderVoiceStage();
  } catch (error) {
    const reason = error.name === 'NotAllowedError'
      ? 'Microphone permission was denied. Allow microphone access in your browser settings.'
      : `Microphone unavailable: ${error.message}`;
    toast(reason);
  }
}

function leaveVoice(notifyServer) {
  if (notifyServer && state.socket && state.socket.readyState === WebSocket.OPEN) send('voice:leave', {});
  stopScreenShare(false).catch((error) => toast(`Could not stop screen sharing: ${error.message}`));
  for (const id of [...state.peers.keys()]) removePeer(id);
  if (state.localStream) {
    for (const track of state.localStream.getTracks()) track.stop();
  }
  state.localStream = null;
  state.voiceChannel = null;
  state.muted = false;
  state.deafened = false;
  for (const audio of document.querySelectorAll('[data-peer-audio]')) audio.remove();
  if (state.audioContext) {
    state.audioContext.close().catch((error) => toast(`Could not close the audio monitor: ${error.message}`));
    state.audioContext = null;
  }
  $('#voice-dock').classList.add('hidden');
  $('#screen-share-button').disabled = true;
  setVoiceScreen(false);
  renderChannels();
}

function setMuted() {
  if (!state.localStream) return;
  state.muted = !state.muted;
  for (const track of state.localStream.getAudioTracks()) track.enabled = !state.muted;
  send('voice:mute', { muted: state.muted });
  renderVoiceStage();
  renderMembers();
}

function setDeafened() {
  if (!state.voiceChannel) return;
  state.deafened = !state.deafened;
  for (const audio of document.querySelectorAll('[data-peer-audio]')) audio.muted = state.deafened;
  send('voice:deafen', { deafened: state.deafened });
  renderVoiceStage();
  renderMembers();
}

function renderServerDiscovery() {
  const list = $('#server-discovery-list');
  list.replaceChildren();
  for (const server of state.servers) {
    const card = document.createElement('div');
    card.className = 'server-card';
    const mark = document.createElement('div');
    mark.className = 'server-card-mark';
    mark.style.setProperty('--server-accent', server.settings.accentColor);
    mark.textContent = escapeInitial(server.name);
    const copy = document.createElement('div');
    copy.className = 'server-card-copy';
    const name = document.createElement('strong');
    name.textContent = server.name;
    const description = document.createElement('span');
    description.textContent = server.description || `${server.memberCount} member${server.memberCount === 1 ? '' : 's'} · ${server.activeCount} online`;
    copy.append(name, description);
    const action = document.createElement('button');
    action.className = 'server-card-action';
    action.type = 'button';
    action.textContent = server.isMember
      ? state.activeServer && state.activeServer.id === server.id ? 'Current' : 'Switch'
      : 'Join';
    action.disabled = server.isMember && state.activeServer && state.activeServer.id === server.id;
    action.addEventListener('click', async () => {
      try {
        if (!server.isMember) {
          await postJSON(`/api/servers/${encodeURIComponent(server.id)}/join`, { name: state.name });
          await loadServers();
        }
        $('#server-dialog').classList.add('hidden');
        await activateServer(server.id);
      } catch (error) {
        toast(error.message);
      }
    });
    card.append(mark, copy, action);
    list.append(card);
  }
  if (!state.servers.length) {
    const empty = document.createElement('div');
    empty.className = 'server-empty';
    empty.textContent = 'No servers are available yet. Create one to get started.';
    list.append(empty);
  }
}

function renderServerSettings() {
  const server = state.activeServer;
  const form = $('#server-settings-form');
  const owner = Boolean(server && server.ownerName.toLowerCase() === state.name.toLowerCase());
  $('#server-settings-note').textContent = server
    ? owner
      ? `You own ${server.name}. Server names and descriptions are visible to everyone on this LAN.`
      : `${server.name} is owned by ${server.ownerName || 'another member'}. Only the owner can edit settings.`
    : 'Join a server before opening its settings.';
  $('#settings-server-name').value = server ? server.name : '';
  $('#settings-server-description').value = server ? server.description : '';
  $('#settings-server-color').value = server ? server.settings.accentColor : '#9274ff';
  $('#settings-server-admins').value = server ? (server.adminNames || []).join('\n') : '';
  for (const input of form.querySelectorAll('input, textarea, button[type="submit"]')) {
    input.disabled = !owner;
  }
  $('#leave-server').disabled = !server;
  $('#channels-tab').classList.toggle('hidden', !server || !server.canManage);
}

async function reloadActiveServer() {
  await loadServers();
  await loadBootstrap();
  renderServerDiscovery();
  renderChannelManagement();
}

function renderChannelManagement() {
  const list = $('#channel-management-list');
  list.replaceChildren();
  if (!state.activeServer || !state.activeServer.canManage) return;
  const channels = state.channels.filter((channel) => channel.type === 'text');
  channels.forEach((channel, index) => {
    const row = document.createElement('div');
    row.className = 'channel-manager-row';
    const heading = document.createElement('div');
    heading.className = 'channel-manager-heading';
    const title = document.createElement('strong');
    title.textContent = `# ${channel.name}`;
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'channel-order-button';
    up.textContent = '↑';
    up.title = 'Move channel up';
    up.disabled = index === 0;
    up.addEventListener('click', () => reorderChannel(index, index - 1));
    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'channel-order-button';
    down.textContent = '↓';
    down.title = 'Move channel down';
    down.disabled = index === channels.length - 1;
    down.addEventListener('click', () => reorderChannel(index, index + 1));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'channel-delete-button';
    remove.textContent = '×';
    remove.title = `Delete ${channel.name}`;
    remove.addEventListener('click', () => deleteChannel(channel));
    heading.append(title, up, down, remove);

    const form = document.createElement('form');
    form.className = 'channel-edit-form';
    const nameLabel = document.createElement('label');
    nameLabel.textContent = 'Channel name';
    const nameInput = document.createElement('input');
    nameInput.maxLength = 32;
    nameInput.required = true;
    nameInput.value = channel.name;
    nameLabel.append(nameInput);
    const modeLabel = document.createElement('label');
    modeLabel.textContent = 'Access';
    const modeSelect = document.createElement('select');
    for (const [value, label] of [['all', 'All members'], ['members', 'Selected only']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      modeSelect.append(option);
    }
    modeSelect.value = channel.permissions && channel.permissions.mode === 'members' ? 'members' : 'all';
    modeLabel.append(modeSelect);
    const allowedLabel = document.createElement('label');
    allowedLabel.className = 'channel-members-label';
    allowedLabel.textContent = 'Allowed members, one per line';
    const allowedInput = document.createElement('textarea');
    allowedInput.value = channel.permissions && channel.permissions.members
      ? channel.permissions.members.join('\n')
      : '';
    allowedInput.placeholder = 'Display names';
    allowedLabel.append(allowedInput);
    allowedLabel.classList.toggle('hidden', modeSelect.value !== 'members');
    modeSelect.addEventListener('change', () => {
      allowedLabel.classList.toggle('hidden', modeSelect.value !== 'members');
    });
    const save = document.createElement('button');
    save.type = 'submit';
    save.textContent = 'Save';
    form.append(nameLabel, modeLabel, allowedLabel, save);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await postJSON(`/api/servers/${encodeURIComponent(state.activeServer.id)}/channels/${encodeURIComponent(channel.id)}`, {
          adminName: state.name,
          name: nameInput.value,
          permissionMode: modeSelect.value,
          allowedMembers: allowedInput.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
        }, 'PATCH');
        await reloadActiveServer();
        toast(`Updated #${nameInput.value}.`);
      } catch (error) {
        toast(error.message);
      }
    });
    row.append(heading, form);
    list.append(row);
  });
  if (!channels.length) {
    const empty = document.createElement('div');
    empty.className = 'server-empty';
    empty.textContent = 'This server has no text channels yet.';
    list.append(empty);
  }
}

async function reorderChannel(from, to) {
  const channels = state.channels.filter((channel) => channel.type === 'text');
  if (to < 0 || to >= channels.length) return;
  const [moved] = channels.splice(from, 1);
  channels.splice(to, 0, moved);
  try {
    await postJSON(`/api/servers/${encodeURIComponent(state.activeServer.id)}/channels/order`, {
      adminName: state.name,
      channelIds: channels.map((channel) => channel.id)
    }, 'PUT');
    await reloadActiveServer();
  } catch (error) {
    toast(error.message);
  }
}

async function deleteChannel(channel) {
  if (!window.confirm(`Delete #${channel.name} and its message history and shared files?`)) return;
  const query = new URLSearchParams({ adminName: state.name });
  try {
    const response = await fetch(
      `/api/servers/${encodeURIComponent(state.activeServer.id)}/channels/${encodeURIComponent(channel.id)}?${query}`,
      { method: 'DELETE' }
    );
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Server returned ${response.status}.`);
    await reloadActiveServer();
    if (result.cleanupWarnings && result.cleanupWarnings.length) {
      toast(`Channel removed; some stored files could not be cleaned up: ${result.cleanupWarnings.join(', ')}`);
    } else {
      toast(`Deleted #${channel.name}.`);
    }
  } catch (error) {
    toast(error.message);
  }
}

function selectServerTab(tab) {
  for (const button of document.querySelectorAll('.server-tab')) {
    button.classList.toggle('active', button.dataset.tab === tab);
  }
  $('#server-discover-panel').classList.toggle('hidden', tab !== 'discover');
  $('#server-create-panel').classList.toggle('hidden', tab !== 'create');
  $('#server-channels-panel').classList.toggle('hidden', tab !== 'channels');
  $('#server-settings-panel').classList.toggle('hidden', tab !== 'settings');
  $('#server-dialog-title').textContent =
    tab === 'create' ? 'Create a server' :
      tab === 'settings' ? 'Server settings' :
        tab === 'channels' ? 'Text channels' : 'Servers';
  if (tab === 'settings') renderServerSettings();
  if (tab === 'channels') renderChannelManagement();
}

async function openServerManager(tab = 'discover') {
  if (!state.name) {
    $('#name-dialog').classList.remove('hidden');
    return;
  }
  try {
    await loadServers();
    renderServerDiscovery();
    renderServerSettings();
    $('#server-dialog').classList.remove('hidden');
    selectServerTab(tab);
  } catch (error) {
    toast(error.message);
  }
}

async function leaveActiveServer() {
  if (!state.activeServer) return;
  if (!window.confirm(`Leave ${state.activeServer.name}? You can rejoin it from Discover.`)) return;
  const leavingId = state.activeServer.id;
  try {
    disconnectSocket();
    await postJSON(`/api/servers/${encodeURIComponent(leavingId)}/leave`, { name: state.name });
    await loadServers();
    state.activeServer = null;
    state.serverId = '';
    localStorage.removeItem('delta-server-id');
    state.channels = [];
    state.messages = [];
    state.files = [];
    state.folders = [];
    state.members = [];
    renderServerRail();
    renderChannels();
    renderMessages();
    const next = state.servers.find((server) => server.isMember);
    if (next) {
      $('#server-dialog').classList.add('hidden');
      await activateServer(next.id);
    } else {
      setConnection('', 'Choose a server');
      renderServerDiscovery();
      selectServerTab('discover');
    }
  } catch (error) {
    toast(error.message);
    if (state.activeServer && state.activeServer.id === leavingId &&
        state.servers.some((server) => server.id === leavingId && server.isMember)) {
      await activateServer(leavingId);
    }
  }
}

$('#composer').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('#message-input');
  const text = input.value.trim();
  if (!text) return;
  if (!send('message:send', { channel: state.selectedChannel, text })) {
    toast('Not connected to the LAN server. Message was not sent.');
    return;
  }
  input.value = '';
});

fileInput.addEventListener('change', async () => {
  const files = Array.from(fileInput.files || []);
  fileInput.value = '';
  for (const file of files) await uploadFile(file);
});

folderInput.addEventListener('change', async () => {
  const files = Array.from(folderInput.files || []);
  folderInput.value = '';
  await uploadFolder(files);
});

$('#name-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('#name-input').value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME_LENGTH);
  if (!name) {
    $('#name-error').textContent = 'Please enter a display name.';
    return;
  }
  const previousServerId = state.activeServer && state.activeServer.id || state.serverId;
  disconnectSocket();
  state.name = name;
  localStorage.setItem('delta-name', name);
  setProfile(name);
  $('#name-dialog').classList.add('hidden');
  try {
    await loadServers();
    let joined = state.servers.filter((server) => server.isMember);
    if (!joined.length) {
      const target = state.servers.find((server) => server.id === previousServerId) ||
        state.servers.find((server) => server.id === 'delta-lan');
      if (target) {
        await postJSON(`/api/servers/${encodeURIComponent(target.id)}/join`, { name });
        await loadServers();
        joined = state.servers.filter((server) => server.isMember);
      }
    }
    const selected = joined.find((server) => server.id === previousServerId) ||
      joined.find((server) => server.id === state.serverId) || joined[0];
    if (selected) {
      await activateServer(selected.id);
      $('#server-dialog').classList.add('hidden');
    } else {
      await openServerManager('discover');
    }
  } catch (error) {
    toast(error.message);
    $('#name-dialog').classList.remove('hidden');
  }
});

$('#create-server-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#create-server-error').textContent = '';
  try {
    const server = await postJSON('/api/servers', {
      name: $('#create-server-name').value,
      description: $('#create-server-description').value,
      ownerName: state.name
    });
    await loadServers();
    $('#create-server-form').reset();
    $('#server-dialog').classList.add('hidden');
    await activateServer(server.id);
    toast(`Created ${server.name}.`);
  } catch (error) {
    $('#create-server-error').textContent = error.message;
  }
});

$('#server-settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.activeServer) return;
  $('#server-settings-error').textContent = '';
  try {
    const server = await postJSON(`/api/servers/${encodeURIComponent(state.activeServer.id)}`, {
      ownerName: state.name,
      name: $('#settings-server-name').value,
      description: $('#settings-server-description').value,
      accentColor: $('#settings-server-color').value,
      admins: $('#settings-server-admins').value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
    }, 'PATCH');
    state.activeServer = server;
    await loadServers();
    renderServerRail();
    renderChannels();
    renderServerDiscovery();
    renderServerSettings();
    toast('Server settings saved.');
  } catch (error) {
    $('#server-settings-error').textContent = error.message;
  }
});

$('#create-channel-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.activeServer) return;
  $('#create-channel-error').textContent = '';
  try {
    const channel = await postJSON(`/api/servers/${encodeURIComponent(state.activeServer.id)}/channels`, {
      adminName: state.name,
      name: $('#create-channel-name').value,
      permissionMode: $('#create-channel-mode').value,
      allowedMembers: $('#create-channel-members').value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
    });
    $('#create-channel-form').reset();
    $('#create-channel-members-label').classList.add('hidden');
    await reloadActiveServer();
    selectChannel(channel.id);
    toast(`Created #${channel.name}.`);
  } catch (error) {
    $('#create-channel-error').textContent = error.message;
  }
});

$('#edit-name').addEventListener('click', () => {
  $('#name-input').value = state.name;
  $('#name-dialog').classList.remove('hidden');
  $('#name-input').focus();
});
$('#settings-button').addEventListener('click', () => {
  toast(`Connected to ${location.host}. Voice and messages use your local LAN server.`);
});
$('#manage-server').addEventListener('click', () => openServerManager('settings'));
$('#add-server').addEventListener('click', () => openServerManager('discover'));
$('#create-channel').addEventListener('click', () => openServerManager('channels'));
$('#close-server-dialog').addEventListener('click', () => $('#server-dialog').classList.add('hidden'));
$('#server-dialog').addEventListener('click', (event) => {
  if (event.target === $('#server-dialog')) $('#server-dialog').classList.add('hidden');
});
for (const tab of document.querySelectorAll('.server-tab')) {
  tab.addEventListener('click', () => {
    if (tab.dataset.tab === 'settings' && !state.activeServer) {
      toast('Join a server to open its settings.');
      return;
    }
    if (tab.dataset.tab === 'channels' && (!state.activeServer || !state.activeServer.canManage)) {
      toast('Only server admins can manage text channels.');
      return;
    }
    $('#create-channel-mode').addEventListener('change', () => {
      $('#create-channel-members-label').classList.toggle(
        'hidden',
        $('#create-channel-mode').value !== 'members'
      );
    });
    if (tab.dataset.tab === 'discover') renderServerDiscovery();
    selectServerTab(tab.dataset.tab);
  });
}
$('#leave-server').addEventListener('click', leaveActiveServer);
$('#leave-voice').addEventListener('click', () => leaveVoice(true));
$('#mute-button').addEventListener('click', setMuted);
$('#deafen-button').addEventListener('click', setDeafened);
$('#screen-share-button').addEventListener('click', startScreenShare);
$('#stop-sharing-button').addEventListener('click', () => {
  stopScreenShare(true).catch((error) => toast(`Could not stop screen sharing: ${error.message}`));
});
$('#share-preset').addEventListener('change', () => {
  const preset = SHARE_PRESETS[$('#share-preset').value];
  $('#share-resolution').value = preset.resolution;
  $('#share-framerate').value = preset.framerate;
  if (state.sharingStream) {
    applyShareQuality(state.sharingStream.getVideoTracks()[0])
      .catch((error) => toast(`Could not apply screen-share quality: ${error.message}`));
  }
});
$('#share-audio').addEventListener('change', async () => {
  if (!state.sharing) return;
  if ($('#share-audio').checked) {
    const displayAudio = state.sharingStream && state.sharingStream.getAudioTracks()[0];
    if (!displayAudio) {
      $('#share-audio').checked = false;
      toast('This capture has no system/tab audio track. Stop sharing and enable audio before choosing a screen.');
      return;
    }
    try {
      await createShareAudioTrack(displayAudio);
      state.shareAudio = true;
      send('voice:share', { sharing: true, shareAudio: true });
      renderVoiceStage();
    } catch (error) {
      $('#share-audio').checked = false;
      toast(`Could not enable shared audio: ${error.message}`);
    }
  } else if (state.shareAudio) {
    try {
      await stopSharedAudio();
    } catch (error) {
      toast(`Could not disable shared audio: ${error.message}`);
    }
  }
});
for (const selector of ['#share-resolution', '#share-framerate']) {
  $(selector).addEventListener('change', () => {
    if (state.sharingStream) {
      applyShareQuality(state.sharingStream.getVideoTracks()[0])
        .catch((error) => toast(`Could not apply screen-share quality: ${error.message}`));
    }
  });
}
$('#members-toggle').addEventListener('click', () => {
  if (window.matchMedia('(max-width: 680px)').matches) {
    membersPanel.classList.remove('hidden');
    membersPanel.classList.toggle('mobile-open');
  } else {
    membersPanel.classList.remove('mobile-open');
    membersPanel.classList.toggle('hidden');
  }
});
$('#mobile-menu').addEventListener('click', () => $('.channel-sidebar').classList.toggle('open'));
document.addEventListener('click', (event) => {
  if ('Notification' in window && Notification.permission === 'default' && event.target.closest('#composer')) {
    Notification.requestPermission().catch(() => {});
  }
});

async function initialize() {
  setProfile(state.name);
  try {
    await loadServers();
    if (!state.name) {
      $('#name-dialog').classList.remove('hidden');
      $('#name-input').focus();
      return;
    }
    $('#name-dialog').classList.add('hidden');
    const joined = state.servers.filter((server) => server.isMember);
    const selected = joined.find((server) => server.id === state.serverId) || joined[0];
    if (selected) {
      await activateServer(selected.id);
    } else {
      await openServerManager('discover');
      setConnection('', 'Choose a server');
    }
  } catch (error) {
    setConnection('offline', 'Server unavailable');
    toast(`Could not load Delta LAN: ${error.message}`);
    setTimeout(initialize, 4000);
  }
}

initialize();

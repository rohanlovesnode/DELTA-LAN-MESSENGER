'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const express = require('express');
const WebSocket = require('ws');
const { pipeline } = require('node:stream/promises');
const yazl = require('yazl');

function readDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}

readDotEnv(path.resolve(process.cwd(), '.env'));

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number.parseInt(process.env.PORT || '5000', 10);
const TLS_ENABLED = process.env.TLS_ENABLED !== 'false';
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads'));
const STAGING_DIR = path.join(UPLOAD_DIR, '.staging');
const DB_FILE = path.join(DATA_DIR, 'store.json');
const DEFAULT_SERVER_ID = 'delta-lan';
const DEFAULT_CHANNELS = [
  { id: 'general', name: 'general', type: 'text', permissions: { mode: 'all', members: [] } },
  { id: 'random', name: 'random', type: 'text', permissions: { mode: 'all', members: [] } },
  { id: 'files', name: 'files', type: 'text', permissions: { mode: 'all', members: [] } },
  { id: 'lounge', name: 'lounge', type: 'voice' },
  { id: 'gaming', name: 'gaming', type: 'voice' }
];
const MAX_CHAT_MESSAGE_LENGTH = 4000;
const MAX_NAME_LENGTH = 32;
const MAX_SERVER_NAME_LENGTH = 48;
const MAX_SERVER_DESCRIPTION_LENGTH = 160;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 240;
const UPLOAD_RATE_LIMIT = 4_800;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(STAGING_DIR, { recursive: true, mode: 0o700 });

function cleanName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME_LENGTH);
}

function cleanServerName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_SERVER_NAME_LENGTH);
}

function cleanDescription(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_SERVER_DESCRIPTION_LENGTH);
}

function cleanChannelName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32);
}

function createServerRecord({ id, name, description, ownerName }) {
  return {
    id,
    name,
    description,
    ownerName,
    createdAt: new Date().toISOString(),
    settings: { accentColor: '#9274ff' },
    channels: DEFAULT_CHANNELS.map((channel) => ({ ...channel })),
    members: ownerName ? [{ name: ownerName, joinedAt: new Date().toISOString(), role: 'owner' }] : []
  };
}

function normalizeServer(server) {
  if (!server || typeof server !== 'object' ||
      typeof server.id !== 'string' || !/^[a-z0-9-]{1,64}$/i.test(server.id)) return null;
  const name = cleanServerName(server.name);
  if (!name) return null;
  const channels = Array.isArray(server.channels)
    ? server.channels.filter((channel) =>
      channel && typeof channel.id === 'string' &&
      /^[a-z0-9_-]{1,64}$/i.test(channel.id) &&
      typeof channel.name === 'string' &&
      ['text', 'voice'].includes(channel.type)
    ).map((channel) => ({
      id: channel.id,
      name: channel.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32),
      type: channel.type,
      ...(channel.type === 'text' ? {
        permissions: {
          mode: channel.permissions && channel.permissions.mode === 'members' ? 'members' : 'all',
          members: channel.permissions && Array.isArray(channel.permissions.members)
            ? channel.permissions.members.map(cleanName).filter(Boolean)
            : []
        }
      } : {})
    })).filter((channel) => channel.name)
    : [];
  const members = Array.isArray(server.members)
    ? server.members.filter((member) => member && typeof member.name === 'string')
      .map((member) => ({
        name: cleanName(member.name),
        joinedAt: member.joinedAt || new Date().toISOString(),
        role: ['owner', 'admin'].includes(member.role) ? member.role : 'member'
      }))
      .filter((member) => member.name)
    : [];
  const accentColor = server.settings && typeof server.settings.accentColor === 'string' &&
    /^#[0-9a-f]{6}$/i.test(server.settings.accentColor)
    ? server.settings.accentColor
    : '#9274ff';
  return {
    id: server.id,
    name,
    description: cleanDescription(server.description),
    ownerName: cleanName(server.ownerName),
    createdAt: typeof server.createdAt === 'string' ? server.createdAt : new Date().toISOString(),
    settings: { accentColor },
    channels: channels.length ? channels : DEFAULT_CHANNELS.map((channel) => ({ ...channel })),
    members
  };
}

function loadStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    const servers = Array.isArray(parsed.servers)
      ? parsed.servers.map(normalizeServer).filter(Boolean)
      : [];
    if (!servers.some((server) => server.id === DEFAULT_SERVER_ID)) {
      servers.unshift(createServerRecord({
        id: DEFAULT_SERVER_ID,
        name: 'Delta LAN',
        description: 'A quiet corner of your local network.',
        ownerName: ''
      }));
    }
    const legacyMembers = Array.isArray(parsed.members)
      ? parsed.members.filter((member) => member && typeof member.name === 'string')
        .map((member) => cleanName(member.name)).filter(Boolean)
      : [];
    const defaultServer = servers.find((server) => server.id === DEFAULT_SERVER_ID);
    for (const name of legacyMembers) {
      if (!defaultServer.members.some((member) => member.name.toLowerCase() === name.toLowerCase())) {
        defaultServer.members.push({ name, joinedAt: new Date().toISOString(), role: 'member' });
      }
    }
    if (!defaultServer.ownerName && defaultServer.members.length) {
      defaultServer.ownerName = defaultServer.members[0].name;
      defaultServer.members[0].role = 'owner';
    }
    return {
      servers,
      messages: Array.isArray(parsed.messages)
        ? parsed.messages.map((message) => ({ ...message, serverId: message.serverId || DEFAULT_SERVER_ID }))
        : [],
      files: Array.isArray(parsed.files)
        ? parsed.files.map((file) => ({ ...file, serverId: file.serverId || DEFAULT_SERVER_ID }))
        : [],
      folders: Array.isArray(parsed.folders)
        ? parsed.folders.filter((folder) =>
          folder && typeof folder.id === 'string' && /^[0-9a-f-]{36}$/i.test(folder.id) &&
          typeof folder.name === 'string' && typeof folder.serverId === 'string' &&
          typeof folder.channel === 'string' && Array.isArray(folder.fileIds)
        ).map((folder) => ({
          id: folder.id,
          name: cleanFilename(folder.name),
          sender: cleanName(folder.sender),
          channel: folder.channel,
          serverId: folder.serverId,
          fileIds: folder.fileIds.filter((id) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)),
          size: Number.isSafeInteger(folder.size) && folder.size >= 0 ? folder.size : 0,
          uploadedAt: typeof folder.uploadedAt === 'string' ? folder.uploadedAt : new Date().toISOString()
        }))
        : []
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Could not read ${DB_FILE}: ${error.message}`);
    return {
      servers: [createServerRecord({
        id: DEFAULT_SERVER_ID,
        name: 'Delta LAN',
        description: 'A quiet corner of your local network.',
        ownerName: ''
      })],
      messages: [],
      files: [],
      folders: []
    };
  }
}

const store = loadStore();
let writeQueue = Promise.resolve();

function persistStore() {
  const snapshot = JSON.stringify(store);
  const temporary = `${DB_FILE}.${process.pid}.tmp`;
  const operation = writeQueue.catch(() => {}).then(async () => {
    await fs.promises.writeFile(temporary, snapshot, { mode: 0o600 });
    await fs.promises.rename(temporary, DB_FILE);
  });
  writeQueue = operation;
  return operation;
}

function cleanFilename(value) {
  if (typeof value !== 'string') return '';
  const base = path.basename(value.replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/^\.+$/, '')
    .trim()
    .slice(0, 240);
  return base || 'shared-file';
}

function attachmentDisposition(filename) {
  const fallback = filename.replace(/[^\x20-\x7e"\\;]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function cleanRelativePath(value, folderName) {
  if (typeof value !== 'string' || value.length > 2048 || /^[\\/]/.test(value) || /^[a-z]:/i.test(value)) {
    return '';
  }
  const parts = value.replace(/\\/g, '/').split('/');
  if (parts.length < 2 || parts.some((part) => !part || part === '.' || part === '..')) return '';
  const safeParts = parts.map((part) => cleanFilename(part));
  if (safeParts[0] !== folderName) return '';
  const result = safeParts.join('/');
  return result.length <= 2048 ? result : '';
}

function decodeHeader(value) {
  if (typeof value !== 'string') return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
}

function send(ws, type, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, data }));
}

function broadcast(type, data, predicate) {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && (!predicate || predicate(client))) {
      send(client, type, data);
    }
  }
}

const online = new Map();
const voiceRooms = new Map();
const rateCounts = new Map();
const uploadRateCounts = new Map();
const pendingUploads = new Map();
const pendingFolders = new Map();

function getServer(id) {
  return store.servers.find((server) => server.id === id);
}

function isServerMember(server, name) {
  return Boolean(server && name && server.members.some((member) =>
    member.name.toLowerCase() === name.toLowerCase()
  ));
}

function isServerAdmin(server, name) {
  return Boolean(server && name &&
    (server.ownerName.toLowerCase() === name.toLowerCase() ||
      server.members.some((member) =>
        member.name.toLowerCase() === name.toLowerCase() && member.role === 'admin'
      )));
}

function canAccessChannel(server, name, channel) {
  if (!isServerMember(server, name)) return false;
  if (isServerAdmin(server, name)) return true;
  const permissions = channel.permissions || { mode: 'all', members: [] };
  return permissions.mode !== 'members' ||
    permissions.members.some((member) => member.toLowerCase() === name.toLowerCase());
}

function serverSummary(server, name) {
  const activeCount = Array.from(online.values())
    .filter((member) => member.serverId === server.id).length;
  return {
    id: server.id,
    name: server.name,
    description: server.description,
    ownerName: server.ownerName,
    settings: server.settings,
    adminNames: server.members.filter((member) => member.role === 'admin').map((member) => member.name),
    memberCount: server.members.length,
    activeCount,
    isMember: isServerMember(server, name),
    canManage: isServerAdmin(server, name)
  };
}

function serverSummaries(name) {
  return store.servers.map((server) => serverSummary(server, name));
}

function onlineMembers(serverId) {
  return Array.from(online.values())
    .filter((member) => member.serverId === serverId)
    .map((member) => ({
    id: member.id,
    name: member.name,
    voiceChannel: member.voiceChannel,
    muted: member.muted,
    deafened: member.deafened,
    sharing: member.sharing,
    shareAudio: member.shareAudio,
    online: true
  }));
}

function presenceMembers(serverId) {
  const server = getServer(serverId);
  if (!server) return [];
  const connected = onlineMembers(serverId);
  return [
    ...connected,
    ...server.members
      .filter((member) => !connected.some((item) => item.name.toLowerCase() === member.name.toLowerCase()))
      .map((member) => ({
        id: null, name: member.name, voiceChannel: null, muted: false,
        deafened: false, sharing: false, shareAudio: false, online: false
      }))
  ];
}

function voiceMembers(serverId, channel) {
  return Array.from(online.values())
    .filter((member) => member.serverId === serverId && member.voiceChannel === channel)
    .map(({ id, name, muted, deafened, sharing, shareAudio }) => ({
      id, name, muted, deafened, sharing, shareAudio, online: true
    }));
}

function broadcastToServer(serverId, type, data) {
  broadcast(type, data, (client) => client.member && client.member.serverId === serverId);
}

function broadcastToChannel(serverId, channelId, type, data) {
  const server = getServer(serverId);
  const channel = server && server.channels.find((item) => item.id === channelId && item.type === 'text');
  if (!channel) return;
  broadcast(type, data, (client) =>
    client.member &&
    client.member.serverId === serverId &&
    canAccessChannel(server, client.member.name, channel)
  );
}

function publishPresence(serverId) {
  broadcastToServer(serverId, 'presence', presenceMembers(serverId));
}

function publishVoice(serverId, channel) {
  const members = voiceMembers(serverId, channel);
  broadcastToServer(serverId, 'voice:state', { channel, members });
  const roomKey = `${serverId}:${channel}`;
  if (members.length === 0) voiceRooms.delete(roomKey);
  else voiceRooms.set(roomKey, new Set(members.map((member) => member.id)));
}

function rateAllowed(ip, counts, limit) {
  const now = Date.now();
  const current = counts.get(ip);
  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    counts.set(ip, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

async function removeIncompleteUploads() {
  for (const entry of await fs.promises.readdir(UPLOAD_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.part')) {
      await fs.promises.unlink(path.join(UPLOAD_DIR, entry.name));
    } else if (entry.isFile() && /^[0-9a-f-]{36}$/i.test(entry.name) &&
        !store.files.some((file) => file.id === entry.name)) {
      await fs.promises.unlink(path.join(UPLOAD_DIR, entry.name));
    }
  }
  for (const entry of await fs.promises.readdir(STAGING_DIR, { withFileTypes: true })) {
    if (entry.isDirectory()) await fs.promises.rm(path.join(STAGING_DIR, entry.name), { recursive: true, force: true });
    else if (entry.isFile()) await fs.promises.unlink(path.join(STAGING_DIR, entry.name));
  }
}

async function removePendingFolder(id) {
  const folder = pendingFolders.get(id);
  if (!folder || folder.activeUploads > 0 || folder.finalizing) return false;
  pendingFolders.delete(id);
  await fs.promises.rm(path.join(STAGING_DIR, id), { recursive: true, force: true });
  return true;
}

async function expirePendingUploads() {
  const now = Date.now();
  for (const [id, upload] of pendingUploads) {
    if (now - upload.createdAt > 10 * 60_000) pendingUploads.delete(id);
  }
  for (const [id, folder] of pendingFolders) {
    if (folder.activeUploads === 0 && !folder.finalizing && now - folder.lastActivity > 10 * 60_000) {
      await removePendingFolder(id);
    }
  }
}

const uploadCleanupTimer = setInterval(() => {
  expirePendingUploads().catch((error) => console.error(`Could not clean expired uploads: ${error.message}`));
}, 60_000);
uploadCleanupTimer.unref();

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  const uploadRequest = (req.method === 'POST' && req.path === '/api/uploads') ||
    (req.method === 'PUT' && /^\/api\/uploads\/[0-9a-f-]{36}$/i.test(req.path));
  const counts = uploadRequest ? uploadRateCounts : rateCounts;
  const limit = uploadRequest ? UPLOAD_RATE_LIMIT : RATE_LIMIT;
  if (!rateAllowed(req.socket.remoteAddress || 'unknown', counts, limit)) {
    res.status(429).json({ error: 'Too many requests. Please wait and try again.' });
    return;
  }
  next();
});
app.use(express.json({ limit: '64kb', strict: true }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', name: 'Delta LAN Messenger', uptime: Math.floor(process.uptime()) });
});

app.get('/api/servers', (req, res) => {
  const name = cleanName(req.query.name);
  res.json(serverSummaries(name));
});

app.post('/api/servers', async (req, res, next) => {
  const name = cleanServerName(req.body && req.body.name);
  const description = cleanDescription(req.body && req.body.description);
  const ownerName = cleanName(req.body && req.body.ownerName);
  if (!name || !ownerName) {
    res.status(400).json({ error: 'A server name and owner display name are required.' });
    return;
  }
  const server = createServerRecord({
    id: crypto.randomUUID(),
    name,
    description,
    ownerName
  });
  store.servers.push(server);
  try {
    await persistStore();
    publishPresence(server.id);
    res.status(201).json(serverSummary(server, ownerName));
  } catch (error) {
    store.servers.splice(store.servers.indexOf(server), 1);
    next(error);
  }
});

app.post('/api/servers/:serverId/join', async (req, res, next) => {
  const server = getServer(req.params.serverId);
  const name = cleanName(req.body && req.body.name);
  if (!server) {
    res.status(404).json({ error: 'Server not found.' });
    return;
  }
  if (!name) {
    res.status(400).json({ error: 'A display name is required to join.' });
    return;
  }
  if (!isServerMember(server, name)) {
    const previousOwner = server.ownerName;
    const member = {
      name,
      joinedAt: new Date().toISOString(),
      role: server.ownerName ? 'member' : 'owner'
    };
    if (!server.ownerName) server.ownerName = name;
    server.members.push(member);
    try {
      await persistStore();
    } catch (error) {
      server.members.splice(server.members.indexOf(member), 1);
      server.ownerName = previousOwner;
      next(error);
      return;
    }
  }
  publishPresence(server.id);
  res.json(serverSummary(server, name));
});

app.post('/api/servers/:serverId/leave', async (req, res, next) => {
  const server = getServer(req.params.serverId);
  const name = cleanName(req.body && req.body.name);
  if (!server || !name) {
    res.status(!server ? 404 : 400).json({ error: !server ? 'Server not found.' : 'A display name is required.' });
    return;
  }
  const index = server.members.findIndex((member) => member.name.toLowerCase() === name.toLowerCase());
  if (index >= 0) {
    const previousMembers = server.members.map((member) => ({ ...member }));
    const oldOwner = server.ownerName;
    const [member] = server.members.splice(index, 1);
    if (server.ownerName.toLowerCase() === member.name.toLowerCase()) {
      const nextOwner = server.members[0];
      server.ownerName = nextOwner ? nextOwner.name : '';
      if (nextOwner) nextOwner.role = 'owner';
    }
    try {
      await persistStore();
    } catch (error) {
      server.members = previousMembers;
      server.ownerName = oldOwner;
      next(error);
      return;
    }
    for (const client of wss.clients) {
      if (client.member &&
          client.member.serverId === server.id &&
          client.member.name.toLowerCase() === name.toLowerCase()) {
        client.close(1008, 'You left this server.');
      }
    }
  }
  publishPresence(server.id);
  res.json({ ok: true });
});

app.patch('/api/servers/:serverId', async (req, res, next) => {
  const server = getServer(req.params.serverId);
  const ownerName = cleanName(req.body && req.body.ownerName);
  if (!server) {
    res.status(404).json({ error: 'Server not found.' });
    return;
  }
  if (!ownerName || !isServerMember(server, ownerName) ||
      server.ownerName.toLowerCase() !== ownerName.toLowerCase()) {
    res.status(403).json({ error: 'Only this server’s owner can update its settings.' });
    return;
  }
  const name = cleanServerName(req.body && req.body.name);
  const description = cleanDescription(req.body && req.body.description);
  const accentColor = req.body && req.body.accentColor;
  const admins = req.body && req.body.admins;
  if (!name ||
      (accentColor !== undefined && (typeof accentColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(accentColor))) ||
      (admins !== undefined && !Array.isArray(admins))) {
    res.status(400).json({ error: 'Server name or accent color is invalid.' });
    return;
  }
  const adminNames = Array.isArray(admins) ? admins.map(cleanName).filter(Boolean) : null;
  if (adminNames && adminNames.some((admin) => !isServerMember(server, admin) ||
      admin.toLowerCase() === server.ownerName.toLowerCase())) {
    res.status(400).json({ error: 'Administrators must be current server members other than the owner.' });
    return;
  }
  const previous = {
    name: server.name,
    description: server.description,
    settings: server.settings,
    members: server.members.map((member) => ({ ...member }))
  };
  server.name = name;
  server.description = description;
  if (accentColor) server.settings = { ...server.settings, accentColor };
  if (adminNames) {
    for (const member of server.members) {
      if (member.name.toLowerCase() !== server.ownerName.toLowerCase()) {
        member.role = adminNames.some((admin) => admin.toLowerCase() === member.name.toLowerCase())
          ? 'admin'
          : 'member';
      }
    }
  }
  try {
    await persistStore();
  } catch (error) {
    server.name = previous.name;
    server.description = previous.description;
    server.settings = previous.settings;
    server.members = previous.members;
    next(error);
    return;
  }
  const summary = serverSummary(server, ownerName);
  broadcastToServer(server.id, 'server:updated', summary);
  res.json(summary);
});

app.get('/api/servers/:serverId/channels', (req, res) => {
  const server = getServer(req.params.serverId);
  const name = cleanName(req.query.name);
  if (!server) {
    res.status(404).json({ error: 'Server not found.' });
    return;
  }
  if (!isServerAdmin(server, name)) {
    res.status(403).json({ error: 'Only server admins can manage channels.' });
    return;
  }
  res.json(server.channels.filter((channel) => channel.type === 'text'));
});

function normalizeChannelPermissions(server, mode, members) {
  if (mode !== 'all' && mode !== 'members') {
    return { error: 'Choose whether this channel is open to all members or selected members.' };
  }
  if (mode === 'all') return { permissions: { mode: 'all', members: [] } };
  if (!Array.isArray(members)) return { error: 'Channel member permissions must be a list.' };
  const allowed = [];
  for (const value of members) {
    const memberName = cleanName(value);
    if (!memberName || !isServerMember(server, memberName)) {
      return { error: `${memberName || 'A listed user'} is not a member of this server.` };
    }
    if (!allowed.some((existing) => existing.toLowerCase() === memberName.toLowerCase())) {
      allowed.push(memberName);
    }
  }
  return { permissions: { mode, members: allowed } };
}

app.post('/api/servers/:serverId/channels', async (req, res, next) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const server = getServer(req.params.serverId);
  const adminName = cleanName(body.adminName);
  const name = cleanChannelName(body.name);
  if (!server) {
    res.status(404).json({ error: 'Server not found.' });
    return;
  }
  if (!isServerAdmin(server, adminName)) {
    res.status(403).json({ error: 'Only server admins can create channels.' });
    return;
  }
  if (!name || server.channels.some((channel) => channel.type === 'text' && channel.name.toLowerCase() === name.toLowerCase())) {
    res.status(400).json({ error: 'Channel name is empty or already in use.' });
    return;
  }
  const normalized = normalizeChannelPermissions(server, body.permissionMode, body.allowedMembers);
  if (normalized.error) {
    res.status(400).json({ error: normalized.error });
    return;
  }
  const channel = {
    id: crypto.randomUUID(),
    name,
    type: 'text',
    permissions: normalized.permissions
  };
  const index = server.channels.findIndex((item) => item.type === 'voice');
  server.channels.splice(index < 0 ? server.channels.length : index, 0, channel);
  try {
    await persistStore();
  } catch (error) {
    server.channels.splice(server.channels.indexOf(channel), 1);
    next(error);
    return;
  }
  broadcastToServer(server.id, 'channel:updated', { action: 'create', channelId: channel.id });
  res.status(201).json(channel);
});

app.patch('/api/servers/:serverId/channels/:channelId', async (req, res, next) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const server = getServer(req.params.serverId);
  const adminName = cleanName(body.adminName);
  const channel = server && server.channels.find((item) =>
    item.id === req.params.channelId && item.type === 'text'
  );
  if (!server || !channel) {
    res.status(404).json({ error: 'Text channel not found.' });
    return;
  }
  if (!isServerAdmin(server, adminName)) {
    res.status(403).json({ error: 'Only server admins can update channels.' });
    return;
  }
  const name = cleanChannelName(body.name);
  if (!name || server.channels.some((item) =>
    item.type === 'text' && item.id !== channel.id && item.name.toLowerCase() === name.toLowerCase()
  )) {
    res.status(400).json({ error: 'Channel name is empty or already in use.' });
    return;
  }
  const normalized = normalizeChannelPermissions(server, body.permissionMode, body.allowedMembers);
  if (normalized.error) {
    res.status(400).json({ error: normalized.error });
    return;
  }
  const oldName = channel.name;
  const oldPermissions = channel.permissions;
  channel.name = name;
  channel.permissions = normalized.permissions;
  try {
    await persistStore();
  } catch (error) {
    channel.name = oldName;
    channel.permissions = oldPermissions;
    next(error);
    return;
  }
  broadcastToServer(server.id, 'channel:updated', { action: 'update', channelId: channel.id });
  res.json(channel);
});

app.delete('/api/servers/:serverId/channels/:channelId', async (req, res, next) => {
  const server = getServer(req.params.serverId);
  const adminName = cleanName(req.query.adminName);
  const index = server && server.channels.findIndex((item) =>
    item.id === req.params.channelId && item.type === 'text'
  );
  if (!server || index === false || index === -1) {
    res.status(404).json({ error: 'Text channel not found.' });
    return;
  }
  if (!isServerAdmin(server, adminName)) {
    res.status(403).json({ error: 'Only server admins can delete channels.' });
    return;
  }
  if (server.channels.filter((channel) => channel.type === 'text').length <= 1) {
    res.status(400).json({ error: 'A server must keep at least one text channel.' });
    return;
  }
  const [channel] = server.channels.splice(index, 1);
  const oldMessages = store.messages;
  const oldFiles = store.files;
  const oldFolders = store.folders;
  const deletedFiles = oldFiles.filter((file) => file.serverId === server.id && file.channel === channel.id);
  store.messages = oldMessages.filter((message) =>
    message.serverId !== server.id || message.channel !== channel.id
  );
  store.files = oldFiles.filter((file) =>
    file.serverId !== server.id || file.channel !== channel.id
  );
  store.folders = oldFolders.filter((folder) =>
    folder.serverId !== server.id || folder.channel !== channel.id
  );
  try {
    await persistStore();
  } catch (error) {
    server.channels.splice(index, 0, channel);
    store.messages = oldMessages;
    store.files = oldFiles;
    store.folders = oldFolders;
    next(error);
    return;
  }
  const cleanupWarnings = [];
  for (const file of deletedFiles) {
    if (!/^[0-9a-f-]{36}$/i.test(file.id)) {
      cleanupWarnings.push(file.name || 'An invalidly named file');
      continue;
    }
    try {
      await fs.promises.unlink(path.join(UPLOAD_DIR, file.id));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error(`Could not remove deleted channel file ${file.id}: ${error.message}`);
        cleanupWarnings.push(file.name);
      }
    }
  }
  broadcastToServer(server.id, 'channel:updated', { action: 'delete', channelId: channel.id });
  res.json({ ok: true, cleanupWarnings });
});

app.put('/api/servers/:serverId/channels/order', async (req, res, next) => {
  const server = getServer(req.params.serverId);
  const adminName = cleanName(req.body && req.body.adminName);
  const channelIds = req.body && req.body.channelIds;
  if (!server) {
    res.status(404).json({ error: 'Server not found.' });
    return;
  }
  if (!isServerAdmin(server, adminName)) {
    res.status(403).json({ error: 'Only server admins can reorder channels.' });
    return;
  }
  const currentTextChannels = server.channels.filter((channel) => channel.type === 'text');
  if (!Array.isArray(channelIds) || channelIds.length !== currentTextChannels.length ||
      new Set(channelIds).size !== currentTextChannels.length ||
      channelIds.some((id) => !currentTextChannels.some((channel) => channel.id === id))) {
    res.status(400).json({ error: 'The channel order must include every text channel exactly once.' });
    return;
  }
  const previous = server.channels;
  const textChannels = channelIds.map((id) => currentTextChannels.find((channel) => channel.id === id));
  server.channels = [...textChannels, ...server.channels.filter((channel) => channel.type !== 'text')];
  try {
    await persistStore();
  } catch (error) {
    server.channels = previous;
    next(error);
    return;
  }
  broadcastToServer(server.id, 'channel:updated', { action: 'reorder' });
  res.json({ channels: server.channels });
});

app.get('/api/bootstrap', (req, res) => {
  const serverId = typeof req.query.serverId === 'string' ? req.query.serverId : DEFAULT_SERVER_ID;
  const server = getServer(serverId);
  const name = cleanName(req.query.name);
  if (!name) {
    res.status(400).json({ error: 'A display name is required to load a server.' });
    return;
  }
  if (!server) {
    res.status(404).json({ error: 'Server not found.' });
    return;
  }
  if (!isServerMember(server, name)) {
    res.status(403).json({ error: 'Join this server before opening it.' });
    return;
  }
  const canManage = isServerAdmin(server, name);
  const visibleChannels = server.channels.map((channel) => ({
    ...channel,
    canAccess: canAccessChannel(server, name, channel),
    ...(canManage ? {} : { permissions: undefined })
  }));
  const visibleIds = new Set(visibleChannels.filter((channel) => channel.canAccess).map((channel) => channel.id));
  res.json({
    server: serverSummary(server, name),
    channels: visibleChannels,
    members: presenceMembers(server.id),
    messages: store.messages.filter((message) =>
      message.serverId === server.id && visibleIds.has(message.channel)
    ).slice(-500),
    files: store.files.filter((file) =>
      file.serverId === server.id && visibleIds.has(file.channel)
    ).slice(-500),
    folders: store.folders.filter((folder) =>
      folder.serverId === server.id && visibleIds.has(folder.channel)
    ).slice(-500)
  });
});

app.get('/api/messages', (req, res) => {
  const serverId = typeof req.query.serverId === 'string' ? req.query.serverId : DEFAULT_SERVER_ID;
  const server = getServer(serverId);
  const channel = typeof req.query.channel === 'string' ? req.query.channel : 'general';
  const targetChannel = server && server.channels.find((item) => item.id === channel && item.type === 'text');
  const name = cleanName(req.query.name);
  if (!name) {
    res.status(400).json({ error: 'A display name is required to load messages.' });
    return;
  }
  if (!server || !targetChannel) {
    res.status(400).json({ error: 'Unknown channel.' });
    return;
  }
  if (!canAccessChannel(server, name, targetChannel)) {
    res.status(403).json({ error: 'You do not have permission to access this channel.' });
    return;
  }
  res.json(store.messages.filter((message) => message.serverId === server.id && message.channel === channel).slice(-500));
});

app.get('/api/files', (req, res) => {
  const serverId = typeof req.query.serverId === 'string' ? req.query.serverId : DEFAULT_SERVER_ID;
  const server = getServer(serverId);
  const name = cleanName(req.query.name);
  if (!server) {
    res.status(404).json({ error: 'Server not found.' });
    return;
  }
  if (!name) {
    res.status(400).json({ error: 'A display name is required to list files.' });
    return;
  }
  if (!isServerMember(server, name)) {
    res.status(403).json({ error: 'Join this server before listing files.' });
    return;
  }
  const allowedChannels = new Set(server.channels
    .filter((channel) => channel.type === 'text' && canAccessChannel(server, name, channel))
    .map((channel) => channel.id));
  res.json(store.files.filter((file) => file.serverId === serverId && allowedChannels.has(file.channel)).slice(-500));
});

app.post('/api/folders', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const name = cleanFilename(body.name);
  const sender = cleanName(body.sender);
  const serverId = typeof body.serverId === 'string' ? body.serverId : '';
  const channelId = typeof body.channelId === 'string' ? body.channelId : '';
  const expectedFiles = body.expectedFiles;
  const server = getServer(serverId);
  const channel = server && server.channels.find((item) => item.id === channelId && item.type === 'text');
  if (!name || !sender || !server || !channel || !canAccessChannel(server, sender, channel) ||
      !Number.isSafeInteger(expectedFiles) || expectedFiles < 1) {
    res.status(400).json({ error: 'Folder name, membership, text channel, or file count is invalid.' });
    return;
  }
  if (pendingFolders.size >= 256) {
    res.status(429).json({ error: 'Too many folder uploads are waiting to finish. Try again shortly.' });
    return;
  }
  const id = crypto.randomUUID();
  pendingFolders.set(id, {
    id,
    name,
    sender,
    serverId,
    channelId,
    expectedFiles,
    allocatedPaths: new Set(),
    files: new Map(),
    activeUploads: 0,
    lastActivity: Date.now()
  });
  res.status(201).json({ id, name });
});

app.delete('/api/folders/:id', async (req, res, next) => {
  const id = req.params.id;
  const folder = pendingFolders.get(id);
  const sender = cleanName(req.body && req.body.sender);
  if (!/^[0-9a-f-]{36}$/i.test(id) || !folder) {
    res.status(404).json({ error: 'Pending folder upload not found.' });
    return;
  }
  if (sender.toLowerCase() !== folder.sender.toLowerCase()) {
    res.status(403).json({ error: 'Only the uploading member can cancel this folder upload.' });
    return;
  }
  if (folder.activeUploads > 0 || folder.finalizing) {
    res.status(409).json({ error: 'Wait for active uploads to stop before canceling this folder.' });
    return;
  }
  for (const [uploadId, upload] of pendingUploads) {
    if (upload.folderId === id) pendingUploads.delete(uploadId);
  }
  try {
    await removePendingFolder(id);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/folders/:id/complete', async (req, res, next) => {
  const id = req.params.id;
  const folder = pendingFolders.get(id);
  const sender = cleanName(req.body && req.body.sender);
  if (!/^[0-9a-f-]{36}$/i.test(id) || !folder) {
    res.status(404).json({ error: 'Pending folder upload not found.' });
    return;
  }
  if (sender.toLowerCase() !== folder.sender.toLowerCase()) {
    res.status(403).json({ error: 'Only the uploading member can complete this folder upload.' });
    return;
  }
  const server = getServer(folder.serverId);
  const channel = server && server.channels.find((item) =>
    item.id === folder.channelId && item.type === 'text'
  );
  if (!channel || !canAccessChannel(server, sender, channel)) {
    res.status(403).json({ error: 'You no longer have permission to upload to this channel.' });
    return;
  }
  if (Date.now() - folder.lastActivity > 10 * 60_000) {
    await removePendingFolder(id);
    res.status(404).json({ error: 'Folder upload has expired. Start it again.' });
    return;
  }
  if (folder.finalizing) {
    res.status(409).json({ error: 'Folder upload is already being finalized.' });
    return;
  }
  if (folder.activeUploads > 0 || folder.files.size !== folder.expectedFiles ||
      folder.allocatedPaths.size !== folder.expectedFiles) {
    res.status(409).json({ error: 'Folder upload is incomplete; every file must finish before publishing.' });
    return;
  }
  folder.finalizing = true;
  const folderFiles = Array.from(folder.files.values());
  const movedFiles = [];
  const records = [];
  let committed = false;
  const uploadedAt = new Date().toISOString();
  const stageDirectory = path.join(STAGING_DIR, id);
  try {
    for (const item of folderFiles) {
      const source = path.join(stageDirectory, item.id);
      const destination = path.join(UPLOAD_DIR, item.id);
      await fs.promises.rename(source, destination);
      movedFiles.push({ source, destination });
      records.push({
        id: item.id,
        name: item.name,
        relativePath: item.relativePath,
        folderId: id,
        size: item.size,
        sender: folder.sender,
        channel: folder.channelId,
        serverId: folder.serverId,
        uploadedAt
      });
    }
    const folderRecord = {
      id,
      name: folder.name,
      sender: folder.sender,
      channel: folder.channelId,
      serverId: folder.serverId,
      fileIds: records.map((file) => file.id),
      size: records.reduce((total, file) => total + file.size, 0),
      uploadedAt
    };
    store.files.push(...records);
    store.folders.push(folderRecord);
    try {
      await persistStore();
    } catch (error) {
      store.files = store.files.filter((file) => file.folderId !== id);
      store.folders = store.folders.filter((item) => item.id !== id);
      throw error;
    }
    committed = true;
    pendingFolders.delete(id);
    try {
      await fs.promises.rm(stageDirectory, { recursive: true, force: true });
    } catch (error) {
      console.error(`Could not remove completed folder staging directory ${id}: ${error.message}`);
    }
    broadcastToChannel(folder.serverId, folder.channelId, 'folder:new', folderRecord);
    res.status(201).json({ folder: folderRecord });
  } catch (error) {
    if (!committed) {
      folder.finalizing = false;
      folder.lastActivity = Date.now();
      for (const item of movedFiles.reverse()) {
        try {
          await fs.promises.rename(item.destination, item.source);
        } catch (rollbackError) {
          console.error(`Could not restore staged folder file ${path.basename(item.source)}: ${rollbackError.message}`);
        }
      }
    }
    next(error);
  }
});

app.post('/api/uploads', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const name = cleanFilename(body.name);
  const sender = cleanName(body.sender);
  const serverId = typeof body.serverId === 'string' ? body.serverId : '';
  const channelId = typeof body.channelId === 'string' ? body.channelId : '';
  const folderId = typeof body.folderId === 'string' ? body.folderId : '';
  const folder = folderId && pendingFolders.get(folderId);
  const relativePath = folder ? cleanRelativePath(body.relativePath, folder.name) : '';
  const server = getServer(serverId);
  const channel = server && server.channels.find((item) => item.id === channelId && item.type === 'text');
  if (!name || !sender || !server || !channel || !canAccessChannel(server, sender, channel)) {
    res.status(400).json({ error: 'File name, server membership, or text channel is invalid.' });
    return;
  }
  if ((body.folderId !== undefined && !folderId) ||
      (folderId && (!folder || folder.sender.toLowerCase() !== sender.toLowerCase() ||
      folder.serverId !== serverId || folder.channelId !== channelId ||
      Date.now() - folder.lastActivity > 10 * 60_000 || !relativePath ||
      path.posix.basename(relativePath) !== name)) ||
      (!folderId && body.relativePath !== undefined)) {
    res.status(400).json({ error: 'Folder upload details or relative file path are invalid.' });
    return;
  }
  if (folder && (folder.allocatedPaths.size >= folder.expectedFiles || folder.allocatedPaths.has(relativePath))) {
    res.status(409).json({ error: 'Folder contains too many files or a duplicate relative path.' });
    return;
  }
  const now = Date.now();
  for (const [id, upload] of pendingUploads) {
    if (now - upload.createdAt > 10 * 60_000) pendingUploads.delete(id);
  }
  if (pendingUploads.size >= 1024) {
    res.status(429).json({ error: 'Too many uploads are waiting to start. Try again shortly.' });
    return;
  }
  const id = crypto.randomUUID();
  pendingUploads.set(id, { name, sender, serverId, channelId, folderId, relativePath, createdAt: now });
  if (folder) {
    folder.allocatedPaths.add(relativePath);
    folder.lastActivity = now;
  }
  res.status(201).json({ id, name });
});

app.put('/api/uploads/:id', async (req, res, next) => {
  const id = req.params.id;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    res.status(400).json({ error: 'Invalid upload identifier.' });
    return;
  }
  const pending = pendingUploads.get(id);
  if (!pending || Date.now() - pending.createdAt > 10 * 60_000) {
    pendingUploads.delete(id);
    res.status(404).json({ error: 'Upload was not allocated or has expired. Start it again.' });
    return;
  }
  const name = cleanFilename(decodeHeader(req.headers['x-file-name']));
  const sender = cleanName(decodeHeader(req.headers['x-sender-name']));
  const channelId = typeof req.headers['x-channel-id'] === 'string' ? req.headers['x-channel-id'] : '';
  if (!name || name !== pending.name || sender !== pending.sender || channelId !== pending.channelId) {
    res.status(400).json({ error: 'Missing or invalid upload details.' });
    return;
  }
  const server = getServer(pending.serverId);
  const channel = server && server.channels.find((item) => item.id === channelId && item.type === 'text');
  if (!channel || !canAccessChannel(server, sender, channel)) {
    pendingUploads.delete(id);
    res.status(403).json({ error: 'You no longer have permission to upload to this channel.' });
    return;
  }
  const folder = pending.folderId && pendingFolders.get(pending.folderId);
  if (pending.folderId && (!folder || folder.sender.toLowerCase() !== sender.toLowerCase() ||
      folder.serverId !== pending.serverId || folder.channelId !== channelId)) {
    pendingUploads.delete(id);
    res.status(404).json({ error: 'Folder upload has expired or is invalid.' });
    return;
  }
  pendingUploads.delete(id);
  const stageDirectory = folder ? path.join(STAGING_DIR, folder.id) : UPLOAD_DIR;
  const temporary = path.join(stageDirectory, `${id}.part`);
  const finalPath = path.join(stageDirectory, id);
  if (folder) {
    folder.activeUploads += 1;
    folder.lastActivity = Date.now();
  }
  try {
    await fs.promises.mkdir(stageDirectory, { recursive: true });
    await pipeline(req, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    await fs.promises.rename(temporary, finalPath);
    const stats = await fs.promises.stat(finalPath);
    if (folder) {
      folder.files.set(id, {
        id,
        name,
        relativePath: pending.relativePath,
        size: stats.size
      });
      folder.lastActivity = Date.now();
      res.status(201).json({ id, name, size: stats.size, folderId: folder.id });
      return;
    }
    const file = {
      id,
      name,
      size: stats.size,
      sender,
      channel: channelId,
      serverId: pending.serverId,
      uploadedAt: new Date().toISOString()
    };
    store.files.push(file);
    await persistStore();
    broadcastToChannel(pending.serverId, channelId, 'file:new', file);
    res.status(201).json(file);
  } catch (error) {
    await fs.promises.unlink(temporary).catch(() => {});
    await fs.promises.unlink(finalPath).catch(() => {});
    if (req.aborted || res.destroyed) return;
    next(error);
  } finally {
    if (folder) {
      folder.activeUploads -= 1;
      folder.lastActivity = Date.now();
    }
  }
});

app.get('/api/files/:id/download', async (req, res, next) => {
  const file = store.files.find((item) => item.id === req.params.id);
  const serverId = typeof req.query.serverId === 'string' ? req.query.serverId : '';
  const name = cleanName(req.query.name);
  const server = getServer(serverId);
  const channel = server && server.channels.find((item) => item.id === file?.channel && item.type === 'text');
  if (!file || !/^[0-9a-f-]{36}$/i.test(file.id) || file.serverId !== serverId ||
      !channel || !canAccessChannel(server, name, channel)) {
    res.status(404).json({ error: 'File not found.' });
    return;
  }
  const filePath = path.join(UPLOAD_DIR, file.id);
  let handle;
  let stats;
  try {
    handle = await fs.promises.open(filePath, 'r');
    stats = await handle.stat();
    if (!stats.isFile()) {
      await handle.close();
      res.status(404).json({ error: 'Stored file is unavailable.' });
      return;
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      res.status(404).json({ error: 'Stored file is unavailable.' });
    } else if (error.code === 'EACCES' || error.code === 'EPERM') {
      res.status(403).json({ error: 'The server cannot read this stored file.' });
    } else {
      next(error);
    }
    return;
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(stats.size));
  res.setHeader('Content-Disposition', attachmentDisposition(file.name));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    await pipeline(handle.createReadStream(), res);
  } catch (error) {
    if (!res.destroyed) next(error);
  }
});

app.get('/api/folders/:id/download', async (req, res, next) => {
  const folder = store.folders.find((item) => item.id === req.params.id);
  const serverId = typeof req.query.serverId === 'string' ? req.query.serverId : '';
  const name = cleanName(req.query.name);
  const server = getServer(serverId);
  const channel = server && folder && server.channels.find((item) =>
    item.id === folder.channel && item.type === 'text'
  );
  if (!folder || !/^[0-9a-f-]{36}$/i.test(folder.id) || folder.serverId !== serverId ||
      !channel || !canAccessChannel(server, name, channel) || !folder.fileIds.length) {
    res.status(404).json({ error: 'Folder not found.' });
    return;
  }
  if (new Set(folder.fileIds).size !== folder.fileIds.length) {
    res.status(404).json({ error: 'Folder contents are unavailable.' });
    return;
  }
  const files = folder.fileIds.map((id) => store.files.find((file) => file.id === id));
  if (files.some((file) => !file || file.folderId !== folder.id ||
      file.serverId !== folder.serverId || file.channel !== folder.channel ||
      !/^[0-9a-f-]{36}$/i.test(file.id) ||
      cleanRelativePath(file.relativePath, folder.name) !== file.relativePath)) {
    res.status(404).json({ error: 'Folder contents are unavailable.' });
    return;
  }
  if (new Set(files.map((file) => file.relativePath)).size !== files.length) {
    res.status(404).json({ error: 'Folder contents are unavailable.' });
    return;
  }
  const filePaths = [];
  try {
    for (const file of files) {
      const filePath = path.join(UPLOAD_DIR, file.id);
      const stats = await fs.promises.lstat(filePath);
      if (!stats.isFile()) {
        res.status(404).json({ error: 'One or more stored folder items are unavailable.' });
        return;
      }
      await fs.promises.access(filePath, fs.constants.R_OK);
      filePaths.push({ filePath, relativePath: file.relativePath });
    }
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      res.status(404).json({ error: 'One or more stored folder items are unavailable.' });
    } else if (error.code === 'EACCES' || error.code === 'EPERM') {
      res.status(403).json({ error: 'The server cannot read one or more stored folder items.' });
    } else {
      next(error);
    }
    return;
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', attachmentDisposition(`${folder.name}.zip`));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const archive = new yazl.ZipFile();
  try {
    const archiveResponse = pipeline(archive.outputStream, res);
    for (const file of filePaths) {
      archive.addFile(file.filePath, file.relativePath, { compress: false });
    }
    archive.end();
    await archiveResponse;
  } catch (error) {
    if (!res.destroyed) next(error);
    else console.error(`Folder download stream failed: ${error.message}`);
  }
});

app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  maxAge: '1h',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

app.use((error, _req, res, _next) => {
  console.error(error);
  if (!res.headersSent) res.status(500).json({ error: 'The server could not complete the request.' });
  else res.destroy(error);
});

let server;
if (TLS_ENABLED) {
  const keyPath = path.resolve(process.env.TLS_KEY || './certs/server.key');
  const certPath = path.resolve(process.env.TLS_CERT || './certs/server.crt');
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    console.error(`HTTPS certificate files are missing. Generate them using scripts/generate-cert.sh.`);
    process.exit(1);
  }
  server = https.createServer({
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
  }, app);
} else {
  server = http.createServer(app);
}
server.requestTimeout = 0;

const wss = new WebSocket.Server({ server, maxPayload: 32 * 1024 });
const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    client.ping();
  }
}, 30_000);
heartbeat.unref();
wss.on('close', () => clearInterval(heartbeat));

function leaveVoice(ws) {
  if (!ws.member || !ws.member.voiceChannel) return;
  const oldChannel = ws.member.voiceChannel;
  ws.member.voiceChannel = null;
  ws.member.muted = false;
  ws.member.deafened = false;
  ws.member.sharing = false;
  ws.member.shareAudio = false;
  publishVoice(ws.member.serverId, oldChannel);
  publishPresence(ws.member.serverId);
}

wss.on('connection', (ws, request) => {
  ws.ip = request.socket.remoteAddress || 'unknown';
  ws.isAlive = true;
  ws.messageTimes = [];
  ws.on('pong', () => { ws.isAlive = true; });
  const authTimeout = setTimeout(() => {
    if (!ws.member) ws.close(1008, 'Send a valid hello message first.');
  }, 10_000);

  ws.on('message', async (buffer) => {
    const now = Date.now();
    ws.messageTimes = ws.messageTimes.filter((time) => now - time < 10_000);
    if (ws.messageTimes.length >= 100) {
      ws.close(1008, 'Message rate exceeded.');
      return;
    }
    ws.messageTimes.push(now);

    let message;
    try {
      message = JSON.parse(buffer.toString());
    } catch {
      send(ws, 'error', { message: 'Invalid message format.' });
      return;
    }
    if (!message || typeof message.type !== 'string' || !message.data || typeof message.data !== 'object') {
      send(ws, 'error', { message: 'Invalid message format.' });
      return;
    }

    if (message.type === 'hello') {
      if (ws.member) return;
      const name = cleanName(message.data.name);
      const serverId = typeof message.data.serverId === 'string' ? message.data.serverId : '';
      const server = getServer(serverId);
      if (!name || !server || !isServerMember(server, name)) {
        send(ws, 'error', { message: 'Choose a display name and join this server before connecting.' });
        ws.close(1008, 'Invalid display name or server membership.');
        return;
      }
      clearTimeout(authTimeout);
      ws.member = {
        id: crypto.randomUUID(), name, serverId, voiceChannel: null,
        muted: false, deafened: false, sharing: false, shareAudio: false
      };
      online.set(ws.member.id, ws.member);
      send(ws, 'hello:ok', { id: ws.member.id, name });
      publishPresence(serverId);
      return;
    }

    if (!ws.member) {
      send(ws, 'error', { message: 'Send a display name before using the server.' });
      return;
    }

    if (message.type === 'message:send') {
      const text = typeof message.data.text === 'string' ? message.data.text.trim() : '';
      const channel = message.data.channel;
      const server = getServer(ws.member.serverId);
      const targetChannel = server && server.channels.find((item) =>
        item.id === channel && item.type === 'text'
      );
      if (!text || text.length > MAX_CHAT_MESSAGE_LENGTH || !targetChannel) {
        send(ws, 'error', { message: 'Message or channel is invalid.' });
        return;
      }
      if (!canAccessChannel(server, ws.member.name, targetChannel)) {
        send(ws, 'error', { message: 'You do not have permission to send messages in this channel.' });
        return;
      }
      const entry = {
        id: crypto.randomUUID(),
        serverId: ws.member.serverId,
        channel,
        senderId: ws.member.id,
        sender: ws.member.name,
        text,
        sentAt: new Date().toISOString()
      };
      store.messages.push(entry);
      try {
        await persistStore();
        broadcastToChannel(ws.member.serverId, channel, 'message:new', entry);
      } catch (error) {
        console.error(error);
        send(ws, 'error', { message: 'Message could not be saved.' });
      }
    } else if (message.type === 'voice:join') {
      const channel = typeof message.data.channel === 'string' ? message.data.channel : '';
      const server = getServer(ws.member.serverId);
      if (!server.channels.some((item) => item.id === channel && item.type === 'voice')) {
        send(ws, 'error', { message: 'Invalid voice channel.' });
        return;
      }
      leaveVoice(ws);
      const existing = voiceMembers(ws.member.serverId, channel);
      ws.member.voiceChannel = channel;
      ws.member.muted = false;
      ws.member.deafened = false;
      ws.member.sharing = false;
      ws.member.shareAudio = false;
      send(ws, 'voice:participants', { channel, members: existing });
      publishVoice(ws.member.serverId, channel);
      publishPresence(ws.member.serverId);
    } else if (message.type === 'voice:leave') {
      leaveVoice(ws);
    } else if (message.type === 'voice:mute') {
      if (ws.member.voiceChannel) {
        ws.member.muted = Boolean(message.data.muted);
        publishVoice(ws.member.serverId, ws.member.voiceChannel);
        publishPresence(ws.member.serverId);
      }
    } else if (message.type === 'voice:deafen') {
      if (ws.member.voiceChannel) {
        ws.member.deafened = Boolean(message.data.deafened);
        publishVoice(ws.member.serverId, ws.member.voiceChannel);
        publishPresence(ws.member.serverId);
      }
    } else if (message.type === 'voice:share') {
      if (ws.member.voiceChannel) {
        ws.member.sharing = Boolean(message.data.sharing);
        ws.member.shareAudio = ws.member.sharing && Boolean(message.data.shareAudio);
        publishVoice(ws.member.serverId, ws.member.voiceChannel);
        publishPresence(ws.member.serverId);
      }
    } else if (message.type === 'voice:signal') {
      const targetId = message.data.targetId;
      const signal = message.data.signal;
      if (typeof targetId !== 'string' || !signal || typeof signal !== 'object' ||
          (!signal.description && !signal.candidate) ||
          (signal.description && (typeof signal.description.type !== 'string' ||
            typeof signal.description.sdp !== 'string' || signal.description.sdp.length > 24_000)) ||
          (signal.candidate && typeof signal.candidate.candidate !== 'string')) {
        send(ws, 'error', { message: 'Invalid voice signal.' });
        return;
      }
      const target = Array.from(wss.clients).find((client) =>
        client.member &&
        client.member.id === targetId &&
        client.member.voiceChannel &&
        client.member.serverId === ws.member.serverId &&
        client.member.voiceChannel === ws.member.voiceChannel
      );
      if (!target || !ws.member.voiceChannel) return;
      send(target, 'voice:signal', {
        fromId: ws.member.id,
        fromName: ws.member.name,
        signal
      });
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    if (!ws.member) return;
    leaveVoice(ws);
    online.delete(ws.member.id);
    publishPresence(ws.member.serverId);
  });
  ws.on('error', (error) => console.error(`WebSocket error: ${error.message}`));
});

async function start() {
  await removeIncompleteUploads();
  server.listen(PORT, HOST, () => {
    console.log(`Delta LAN Messenger listening on ${TLS_ENABLED ? 'https' : 'http'}://${HOST}:${PORT}`);
  });
}

function shutdown() {
  clearInterval(uploadCleanupTimer);
  for (const client of wss.clients) client.close(1001, 'Server is shutting down.');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start().catch((error) => {
  console.error(error);
  process.exit(1);
});

# Delta LAN Messenger 2.0

A self-hosted, offline-at-runtime LAN chat with persistent messages, streamed file sharing, and peer-to-peer browser voice and screen sharing. The Ubuntu host serves the app and signaling over HTTPS; file bytes and chat data stay on that server and private Ethernet LAN. Voice and screen media travel directly between browser peers using WebRTC without public STUN/TURN services.

## What is included

- Discord-inspired responsive web client, multiple text channels, presence, history, file and folder cards, and upload progress.
- Discord-style server discovery, creation, joining, switching, leaving, owner settings, and per-server member rosters.
- Admin-managed text channels with rename, delete, reorder, and either all-member access or a selected-member allowlist. Each channel has independent messages and timestamps; deleting a channel also deletes its history and associated stored files.
- HTTPS server and WebSocket chat/signaling, with the server registry, membership, channel settings, messages, and file/folder metadata persisted in `data/store.json`.
- Streaming file and folder uploads written directly to disk (no app-imposed file-size cap), plus streaming individual-file downloads and on-demand ZIP folder downloads. Folder paths are preserved inside the ZIP. A folder is not published until all of its files finish; interrupted staging data is removed at server restart or after it expires, and the folder must be selected and sent again. Byte-range resume is not implemented.
- WebRTC audio/video mesh for small LAN voice groups, with microphone mute, independent deafen, screen sharing, screen-share audio when captured by the browser, per-share resolution/frame-rate/bitrate settings, speaking indicators, and ICE reconnection attempts. No public ICE servers are configured.
- No account/authentication system. Anyone who can reach the private server can read the chat, send as any chosen display name, and download/upload files. Do not expose port 5000 to the public internet; use a trusted network and firewall.

The app does not provide end-to-end encryption. HTTPS encrypts browser-to-server traffic; the server can read messages and stored files. WebRTC audio uses the browser's DTLS-SRTP protections between peers, but this is not an end-to-end encrypted messaging claim.

## Servers and text-channel permissions

The left rail lists servers the current display name has joined. Use **+** to discover/join a LAN server or create a new one; click a rail icon to switch, and open the server menu to edit settings or leave. Every server has its own channels, member roster, settings, files, and message history. The first member of the built-in Delta LAN server becomes its owner; the creator owns a newly created server. The owner can assign additional admins from the server settings.

Owners and admins can open **Channels** to create, rename, delete, and reorder text channels. Channel access is open to all server members by default, or admins can select specific member display names. Admins always retain access. Members without access do not receive that channel's history or real-time messages, and cannot post or upload into it. Deleting a text channel permanently removes its message history, file metadata, and stored files for that channel. A server must retain at least one text channel.

This initial LAN version has no authenticated accounts or invitation secrets. Server membership and owner/admin checks use self-selected display names, so anyone on the LAN can impersonate a name or join a discoverable server. Channel allowlists are useful organization controls, not a security boundary against a hostile LAN user. Do not expose the app beyond a trusted private network.

## Ubuntu deployment (192.168.101.50)

Commands below assume the project is extracted to `/opt/delta-lan-messenger`. Install Node.js 18+ and OpenSSL before installing. For example, on Ubuntu with the distribution Node.js version available:

```bash
sudo apt update
sudo apt install -y nodejs npm openssl unzip
node --version
```

If Ubuntu provides a Node version older than 18, install a supported Node.js 18+ release before continuing. Package download/installation and initial npm dependency installation require access to the relevant package sources; after installation, normal app operation does not require the internet.

Extract the ZIP, then:

```bash
sudo mkdir -p /opt/delta-lan-messenger
sudo unzip delta-lan-messenger-v2.zip -d /opt/delta-lan-messenger
cd /opt/delta-lan-messenger
sudo chown -R "$USER":"$USER" /opt/delta-lan-messenger
chmod +x scripts/*.sh
./scripts/install-ubuntu.sh
```

The setup script installs locked production dependencies, creates `.env` from `.env.example`, and creates a self-signed HTTPS certificate whose IP Subject Alternative Name is `192.168.101.50`. Review `.env`; defaults are:

```dotenv
HOST=0.0.0.0
PORT=5000
TLS_ENABLED=true
TLS_KEY=./certs/server.key
TLS_CERT=./certs/server.crt
DATA_DIR=./data
UPLOAD_DIR=./data/uploads
```

Start and test:

```bash
npm start
```

In another terminal on the Ubuntu host:

```bash
curl -k https://127.0.0.1:5000/health
```

Expected JSON includes `"status":"ok"`. Configure the host firewall for the private Ethernet interface/subnet only. With UFW and the specified client:

```bash
sudo ufw allow from 192.168.101.98 to 192.168.101.50 port 5000 proto tcp
sudo ufw status
```

Do not add a public-interface or router port-forwarding rule. Confirm the Ubuntu host's Ethernet IP is actually `192.168.101.50`.

### Trust the local HTTPS certificate

The certificate is self-signed. For microphone access without browser warnings, transfer `certs/server.crt` to Windows over a trusted private method (for example, a USB drive). On Windows, open `mmc.exe`, add the **Certificates** snap-in for **Computer account**, and import the certificate into **Trusted Root Certification Authorities > Certificates**. Restart the browser and open `https://192.168.101.50:5000`.

Alternatively, on your own private LAN you may use Chrome/Edge's certificate warning page and proceed to the site, but this is less reliable for microphone permission and leaves the warning. Never trust a certificate received over an untrusted network. Delete the copied certificate from Downloads after importing it.

### Run at boot with systemd

Create a restricted service account and allow it to write the app's data and private certificate:

```bash
sudo useradd --system --home /opt/delta-lan-messenger --shell /usr/sbin/nologin delta-messenger
sudo chown -R delta-messenger:delta-messenger /opt/delta-lan-messenger/data /opt/delta-lan-messenger/certs
sudo install -m 0644 systemd/delta-lan-messenger.service /etc/systemd/system/delta-lan-messenger.service
sudo systemctl daemon-reload
sudo systemctl enable --now delta-lan-messenger
sudo systemctl status delta-lan-messenger
sudo journalctl -u delta-lan-messenger -f
```

The included unit expects the extracted directory at `/opt/delta-lan-messenger` and Node at `/usr/bin/node`. Change those paths in the unit if your installation differs. To update the project, stop the service before replacing files and preserve `data/`, `.env`, and `certs/`.

## Windows client

1. Connect the Windows computer to the private Ethernet LAN and confirm it can reach `192.168.101.50`.
2. Trust the server certificate as described above, or proceed past the self-signed certificate warning on this private LAN.
3. Open `https://192.168.101.50:5000` in a current Chrome or Edge browser.
4. Choose a display name. Allow microphone access when joining **lounge**. Use the Mute, Deafen, and Disconnect controls in the voice dock. Mute disables only your microphone; Deafen silences incoming participant audio without muting your microphone.
5. To share, join a voice channel and choose a quality preset or set resolution and frame rate in the voice screen. Press **Share screen**, then choose an entire screen, application window, or browser tab in the browser's capture picker. Press **Stop sharing** or stop capture from the browser indicator to end the share. Select **Share system/tab audio** before starting; available audio sources depend on the browser, operating system, and selected surface. The UI reports when capture audio is unavailable.
6. Use the composer’s plus control to choose files, or its folder control to choose a folder. Folder selection requires a Chromium-based browser such as Chrome or Edge. The browser shares files and nested paths; empty directories are not exposed by its folder input. Keep the tab open until progress shows Complete.

Voice and screen media use a peer-to-peer full mesh, not an SFU. Each participant sends media directly to every other participant; in particular, each screen sharer uploads a separate video stream to every viewer. Bandwidth and CPU use therefore grow with participant count, and this is intended for small voice rooms—not large or unlimited audiences. A 1 Gbps server link does not remove the upload, decode, and encode costs on each client. The signaling server does not relay media. ICE uses browser host candidates only, so devices must be able to reach each other directly on the LAN. WebSocket heartbeats detect dead clients, and stalled peer connections trigger reconnection attempts.

The application already serves HTTPS by default (`TLS_ENABLED=true`); screen capture, like microphone capture, requires a secure browser context. The Ubuntu install script generates the IP certificate for `192.168.101.50`. On Windows, transfer `certs/server.crt` using a trusted private method, run `mmc.exe`, add **Certificates > Computer account**, and import it into **Trusted Root Certification Authorities > Certificates**. Restart Chrome or Edge and open `https://192.168.101.50:5000`. The browser still asks for permission each time a user starts capture. If capture is unsupported, the page is not trusted HTTPS, or permission is denied, the app displays a message rather than faking a share.

Screen-share presets set capture constraints and WebRTC maximum bitrate/frame rate: Low (480p/15 FPS/0.6 Mbps), Balanced (720p/30 FPS/2.5 Mbps), High (1080p/30 FPS/5 Mbps), and Ultra (source resolution/60 FPS/8 Mbps). Browser, operating-system, hardware, and display-source limits may reduce the actual result; selected maximums are not a guarantee of capture capability.

## Configuration and storage

`DATA_DIR` contains `store.json` and defaults to `./data`; `UPLOAD_DIR` defaults to `./data/uploads`. Back up both while the service is stopped. File contents are stored under random UUID names, not user-supplied paths. Original sanitized names and folder-relative paths are metadata; folder data is streamed into a private staging directory and only published when the complete upload is finalized. Individual files download directly through the browser's native download manager. Folder downloads are assembled as ZIP streams on demand without buffering file contents into memory or compressing them, preserving the selected folder and nested paths. There is no application upload size ceiling; actual limits are available storage, filesystem, browser/network behavior, and any proxy/firewall added in front of the service. Do not put an upload-size-limited reverse proxy in front of this service.

The server accepts chat payloads up to 4,000 characters and HTTP JSON bodies up to 64 KiB. Ordinary API requests are limited to 240 per client per minute; file allocation and transfer routes have a separate 4,800-request-per-minute allowance so folders with many small files are not blocked by the ordinary API limit. WebSocket messages are rate-limited independently. File upload bodies and folder ZIP downloads are streamed; they are not buffered in server memory. This is a private-network application, not a hardened public multi-tenant service.

## Development and verification

```bash
npm ci
npm test
```

For local HTTP development only, set `TLS_ENABLED=false` in `.env`, or on Windows run `npm run start:http`. Microphone access is not available on arbitrary insecure LAN HTTP origins; use the HTTPS setup to test voice in a browser. The automated test suite exercises health, WebSocket chat, voice-room signaling/status (mute, deafen, and share state), persistence across restart, and streamed file upload/download using a local test server. It does not emulate display capture, system audio, codec quality, two physical browsers, microphone hardware, or the Ubuntu/Windows Ethernet path. Those need to be verified in Chrome/Edge on the actual machines; this environment cannot claim those physical-device tests were run.

## Troubleshooting

- **Certificate missing:** run `./scripts/generate-cert.sh 192.168.101.50` from the project directory and verify `.env` paths.
- **Browser certificate warning / microphone unavailable:** import the correct IP-SAN certificate into Windows' local computer Trusted Root store, restart Chrome/Edge, then reload the HTTPS URL.
- **Cannot connect:** check `systemctl status delta-lan-messenger`, `sudo journalctl -u delta-lan-messenger`, `curl -k https://127.0.0.1:5000/health`, Ubuntu's Ethernet IP, and the UFW rule.
- **Upload interrupted:** the partial file is discarded and removed; retry the upload. Ensure there is sufficient free space in `UPLOAD_DIR`, and do not close the tab during transfer.
- **Folder upload interrupted:** no incomplete folder is published. Select the folder again and retry; completed files in the private staging area are discarded on restart or after the pending upload expires.
- **Folder picker unavailable:** use a current Chrome or Edge browser; folder selection uses the browser's directory input support. Individual-file sharing works in other supported browsers.
- **File download 404:** verify that both `data/store.json` and its matching UUID file in `data/uploads/` were backed up/restored together.
- **Voice cannot connect:** allow microphone permission, confirm HTTPS is trusted, ensure both browsers are on the same reachable LAN, and make sure local firewall rules permit peer-to-peer traffic. No public STUN/TURN server is used; some managed endpoint firewalls can block direct WebRTC even on a LAN.
- **Screen sharing is unavailable:** open the trusted HTTPS URL in a current browser that supports `getDisplayMedia()` (Chrome or Edge recommended), allow capture in the browser picker, and choose a supported display/window/tab. Screen audio is not offered for every operating-system/browser/source combination.
- **Share quality is lower than selected:** the browser may cap dimensions or frame rate for the chosen surface, hardware, or power mode. The settings constrain the captured track and sender encoding, but cannot exceed browser/device capabilities.
- **Large voice room performance:** this project uses peer-to-peer mesh, not an SFU. Reduce participants or use an SFU-based media service if many concurrent viewers/sharers are required; do not expose this mesh as an unlimited broadcast system.
- **Port already in use:** set a different `PORT` in `.env`, update the firewall rule, and use that port in the client URL.

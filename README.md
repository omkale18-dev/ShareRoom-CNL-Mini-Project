# ShareRoom — CNL Mini Project

**Project title:** ShareRoom: A Real-Time Web-Based File and Text Sharing System Using TCP/IP, HTTP and WebSockets  
**Domain:** Computer Networks and Cloud Computing  
**Status:** Working educational prototype; public deployment requires additional security hardening.

## 1. Abstract

ShareRoom is a browser-based platform for exchanging text, links, and files through temporary, access-controlled rooms. A user creates a room, then shares the six-character room code with another user. Clients communicate with a Python FastAPI server using HTTP for room/file operations and WebSockets for real-time messages. The application can run locally or on an AWS EC2 virtual machine so users on different networks can connect through a common server.

## 2. Problem statement and objectives

Sharing short messages and files between devices often requires an account or an installed application. ShareRoom provides a lightweight browser alternative and, more importantly for CNL, demonstrates practical client-server networking.

**Objectives:**
1. Implement application-layer communication using HTTP and WebSockets.
2. Demonstrate IP addressing, TCP ports and cloud-based client-server communication.
3. Support temporary rooms, multiple clients and file transfers.
4. Measure application-level WebSocket round-trip time and verify uploaded file integrity using SHA-256.
5. Capture network evidence and record test cases for the CNL demonstration.

## 3. Features implemented

- Random six-character invitation code; the backend supplies an internal token when joining.
- Shareable invite URL or manual room-code entry; no access-key field.
- Creation retries reuse a request ID, avoiding duplicate rooms after a lost response.
- Anyone with a valid room code can join. Share codes only with intended participants.
- Real-time text messaging using WebSockets, with recent message history.
- Connected-client presence count and application-level ping/pong RTT.
- HTTP file upload/download up to **25 MiB** per file.
- Server-generated SHA-256 hash for each uploaded file.
- SQLite storage for room, message and file metadata; files stored on disk.
- Rooms expire after **30 minutes**. Cleanup runs at startup and when creating a room; it is **not** a continuous background cleanup service.
- Responsive HTML/CSS/JavaScript interface without a frontend build step.

## 4. Architecture

```text
Client A (college Wi-Fi)                 Client B (mobile data)
        |                                        |
        +------------- Internet -----------------+
                             |
                   EC2 public IPv4 :80
                             |
                       AWS security group
                             |
                         Nginx :80
                             |
                  FastAPI / Uvicorn :8000
                  (bound to 127.0.0.1)
                      /              \
              HTTP endpoints       WebSocket
              rooms and files      live messages
                      \              /
                   SQLite + local file storage
```

This is a **client-server** architecture, **not peer-to-peer**: the EC2 server relays messages and stores files. TCP is provided by the operating system; the project implements application-layer HTTP/WebSocket behavior, not TCP congestion control or retransmission algorithms.

## 5. Computer Networks concepts and proof

| Concept | How ShareRoom uses it | How to demonstrate |
|---|---|---|
| IP addressing | Clients contact EC2's public IP | Show EC2 public/private IP and client network differences |
| Ports | Nginx listens on TCP 80; FastAPI listens locally on 8000 | Explain security group and reverse-proxy configuration |
| TCP | Carries HTTP/1.1 and WebSocket traffic in this setup | Capture SYN, SYN-ACK, ACK in Wireshark |
| HTTP | Room creation, room retrieval, file upload and download | Browser DevTools → Network → Fetch/XHR |
| WebSocket | Persistent, bidirectional text messaging and presence | Browser DevTools → Network → WS → Messages |
| Client-server | Central EC2 server handles multiple clients | Join same room on laptop and phone |
| Application RTT | WebSocket JSON ping/pong | Observe latency indicator; distinguish from ICMP ping |
| Data integrity | Server computes SHA-256 on upload | Compare hashes of original and downloaded file |
| Cloud networking | EC2, security group and Nginx | Show AWS EC2 networking settings and application access |

**Important:** The public-IP deployment described here uses **HTTP/WS, not HTTPS/WSS**. Do not claim that traffic is encrypted or secure against interception. Use only dummy demonstration files and text.

## 6. Project structure

```text
shareroom/
├── app.py               # FastAPI API, WebSockets, SQLite and file storage
├── static/
│   ├── index.html       # Website UI
│   ├── style.css        # Styling
│   └── app.js           # Browser HTTP/WebSocket logic
├── tests/
│   └── test_app.py      # Integration tests
├── requirements.txt     # Python dependencies
├── .gitignore
└── README.md
```

## 7. Run locally

Requires Python 3.10+.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

Open `http://127.0.0.1:8000`. On Windows, activate with `.venv\Scripts\activate` in CMD. For a trusted same-Wi-Fi demo, bind Uvicorn to `0.0.0.0` and access `http://SERVER_LAN_IP:8000` after permitting the port in the local firewall. Never expose that development port directly to the public internet.

## 8. AWS EC2 deployment used for the project

### 8.1 EC2 setup

1. Launch an Ubuntu EC2 instance with a public IPv4 address and an SSH key pair.
2. Configure the instance security group: **SSH 22 from your IP**, **HTTP 80 from the internet**. Port **443** is only needed after configuring HTTPS. Do **not** open 8000 publicly.
3. Connect via SSH or the AWS Console's **EC2 Instance Connect** browser terminal.
4. Install dependencies:

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip nginx unzip
```

### 8.2 Upload and run the application

Copy the extracted project directory to `/home/ubuntu/shareroom` (for example, with `scp` from Windows), then on EC2:

```bash
cd /home/ubuntu/shareroom
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

Test from another EC2 terminal with `curl -I http://127.0.0.1:8000/`. Stop this foreground test server with Ctrl+C before enabling systemd.

### 8.3 Nginx reverse proxy

Create `/etc/nginx/sites-available/shareroom`:

```nginx
server {
    listen 80;
    server_name _;
    client_max_body_size 26m;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
```

Enable and test:

```bash
sudo ln -s /etc/nginx/sites-available/shareroom /etc/nginx/sites-enabled/shareroom
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

If the symbolic link already exists, do not recreate it.

### 8.4 Run automatically using systemd

Create `/etc/systemd/system/shareroom.service`:

```ini
[Unit]
Description=ShareRoom FastAPI Server
After=network.target

[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/shareroom
ExecStart=/home/ubuntu/shareroom/.venv/bin/uvicorn app:app --host 127.0.0.1 --port 8000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now shareroom
sudo systemctl status shareroom
```

Open `http://YOUR_EC2_PUBLIC_IP` and test. **The EC2 public IP can change after stop/start** unless a stable address is configured. AWS resources may incur charges.

### 8.5 Optional production improvements

Use a domain, HTTPS/TLS certificate and `wss://` WebSockets; add rate limiting, stronger authentication, file scanning, quota controls and backups before real public use. The present HTTP deployment is for **non-sensitive educational testing only**.

## 9. API endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/rooms` | Create room and return code, key and expiry |
| `POST /api/rooms/{code}/join` | Exchange a valid room code for its internal token |
| `GET /api/rooms/{code}?key=...` | Retrieve authorized room data |
| `POST /api/rooms/{code}/files` | Multipart upload with `key` and `file` |
| `GET /api/rooms/{code}/files/{file_id}?key=...` | Authorized file download |
| `WS /ws/{code}?key=...` | Real-time messaging and ping/pong |

WebSocket example message: `{"type":"message","text":"Hello"}`.

## 10. CNL demonstration procedure

1. Show the AWS EC2 instance and its public/private IP addresses; explain ports 80 and 8000.
2. Open the ShareRoom website on a laptop connected to Wi-Fi.
3. Create a room and share its credentials with a phone on **mobile data**.
4. Join the room from the phone and send a message. Show that it appears without refreshing.
5. Open **Chrome DevTools → Network → WS** and inspect WebSocket messages.
6. Upload a small non-sensitive file from one device and download it on the other.
7. Inspect the HTTP requests in DevTools and compare original/downloaded SHA-256 hashes.
8. Use Wireshark on an authorized endpoint to capture a TCP handshake. A local capture will generally show the client-to-EC2 connection on port 80, **not** EC2's internal port 8000.
9. Show test cases and discuss latency, file integrity, access control and limitations.

### Wireshark display filters

```text
tcp.port == 80
tcp.flags.syn == 1
http
websocket
ip.addr == YOUR_EC2_PUBLIC_IP
```

Capture traffic only on devices and networks you own or are authorized to inspect. If Wireshark does not decode WebSocket frames automatically, use browser DevTools for message-level proof. Do not invent screenshots or results.

## 11. Test cases and results template

Fill the **Actual result** column only after testing.

| Test | Expected result | Actual result | Evidence |
|---|---|---|---|
| Create room | Code and key generated | Not yet recorded | UI/API response |
| Join across networks | Second client joins | Not yet recorded | Two devices |
| WebSocket message | Delivered without refresh | Not yet recorded | DevTools WS frames |
| Upload/download | File received | Not yet recorded | HTTP requests |
| SHA-256 comparison | Original and downloaded hashes match | Not yet recorded | Hash output |
| Wrong key | HTTP 403 for protected HTTP endpoint | Not yet recorded | Network response |
| Oversized file | HTTP 413 for upload above 25 MiB | Not yet recorded | Network response |
| Connection recovery | Rejoin/reconnect behavior observed | Not yet recorded | Browser test |

To calculate **file throughput**: `file_size_bytes / elapsed_seconds`. Record file size, duration, network type and measured throughput. RTT shown in the UI is **application-level WebSocket round-trip time**, not ICMP latency.

### Automated tests

```bash
python -m pytest -q
```

The included integration tests exercise room authorization, WebSocket messaging/ping, file upload/download, integrity metadata and size limits. Automated tests do **not** replace a live two-device network test.

## 12. Suggested team responsibilities (4 members)

1. **Backend:** room APIs, authorization, database.
2. **Networking:** WebSocket messaging, presence and protocol explanation.
3. **Frontend:** UI, file transfer and latency display.
4. **Testing/deployment:** EC2, Nginx, Wireshark, documentation and results.

Every member should also contribute to integration, testing and the final demonstration.

## 13. Common viva questions

**Q: Where are CN concepts implemented?**  
A: In the client-server HTTP and WebSocket communication, IP/port addressing, EC2 networking, and application-level messaging and file transfer.

**Q: Did you implement TCP yourself?**  
A: No. The operating system provides TCP. Our code implements application-layer services over TCP.

**Q: Why WebSockets?**  
A: They keep a bidirectional connection open for live message delivery without repeated page refreshes.

**Q: Can users be on different Wi-Fi networks?**  
A: Yes. Both connect to the same public EC2 server over the internet.

**Q: Is the current public website encrypted?**  
A: No. HTTP and WS are unencrypted. HTTPS/WSS are planned improvements.

**Q: Is this peer-to-peer?**  
A: No. The server receives and relays messages and stores shared files.

**Q: How do you verify file integrity?**  
A: Compare the SHA-256 hash of the original and downloaded file; the server also records an upload hash.

## 14. Limitations and future scope

- No HTTPS/WSS in the current public-IP demo; not suitable for confidential data.
- No end-to-end encryption or direct peer-to-peer transfer.
- No resumable uploads or custom chunk acknowledgment protocol.
- One-instance SQLite and local disk storage; limited horizontal scalability.
- Presence connections are held in process memory; use a single Uvicorn worker.
- Cleanup is event-triggered, not a continuously scheduled background job.
- Future additions: secure deployment, upload quotas and scanning, automatic cleanup, persistent shared connection state, and a network analytics dashboard.

## 15. Conclusion

ShareRoom demonstrates real client-server networking by combining HTTP file transfer, WebSocket messaging, TCP/IP addressing, cloud hosting, and measurable network behavior in one working application. The key CNL deliverables are the running system, protocol evidence, topology, reproducible tests and clear explanation of which networking functions are implemented by the application versus the operating system.


## Deploying the room creation and joining fix

Update the backend and static files together, then restart `shareroom.service`.
The database migration adds a nullable request ID and unique index automatically;
keep the existing `data` directory. Do not delete the database to apply this fix.
The HTML now requests `app.js?v=roomfix2`. Hard-refresh existing browser tabs
following deployment, especially if Nginx serves the static HTML directly.

Keep exactly one healthy application target in `shareroom-app-tg` and run one
Uvicorn worker. Route `/api/network/*` to `shareroom-monitor-tg`, which may contain
both EC2 instances. All room API requests, uploads, downloads, and `/ws/*` must go
to the same application instance. Per-client sticky sessions alone do not ensure
that two different users reach the same room database. Multi-instance real rooms
require shared storage and cross-process message delivery, not just this patch.

Smoke test with two browsers: create a room, copy its code, join from the second
browser, exchange messages and a file, reconnect, and verify the room code stays
the same. Opening an old `#CODE.key` invite remains supported.

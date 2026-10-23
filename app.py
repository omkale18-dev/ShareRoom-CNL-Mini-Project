import asyncio
import hashlib
import json
import os
import re
import secrets
import shutil
import sqlite3
import time
from contextlib import asynccontextmanager
from pathlib import Path
from pydantic import BaseModel, Field, field_validator
from fastapi import FastAPI, HTTPException, UploadFile, File, Form, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

BASE = Path(__file__).resolve().parent
DATA = Path(os.environ.get('SHAREROOM_DATA', str(BASE / 'data')))
DATA.mkdir(parents=True, exist_ok=True)
FILES = DATA / 'files'
FILES.mkdir(exist_ok=True)
DB = DATA / 'rooms.sqlite3'
TTL = 1800
MAX_FILE = 25 * 1024 * 1024
MAX_MESSAGE = 10000
ROOM_RE = re.compile(r'^[A-Z0-9]{6}$')
connections: dict[str, set[WebSocket]] = {}

def connect_db():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    return conn

def initialize():
    with connect_db() as db:
        # Serialize additive migrations when workers start together.
        db.execute('BEGIN IMMEDIATE')
        db.execute('CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, secret TEXT NOT NULL, expires REAL NOT NULL)')
        db.execute('CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, text TEXT NOT NULL, created REAL NOT NULL)')
        room_columns = {r['name'] for r in db.execute('PRAGMA table_info(rooms)')}
        if 'name' not in room_columns:
            db.execute("ALTER TABLE rooms ADD COLUMN name TEXT NOT NULL DEFAULT 'Your room'")
        message_columns = {r['name'] for r in db.execute('PRAGMA table_info(messages)')}
        if 'sender' not in message_columns:
            db.execute("ALTER TABLE messages ADD COLUMN sender TEXT NOT NULL DEFAULT 'Guest'")
        db.execute('CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, room TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, created REAL NOT NULL)')

def cleanup():
    now = time.time()
    with connect_db() as db:
        expired = [r['code'] for r in db.execute('SELECT code FROM rooms WHERE expires < ?', (now,))]
        for code in expired:
            for f in db.execute('SELECT id FROM files WHERE room = ?', (code,)):
                (FILES / f['id']).unlink(missing_ok=True)
            db.execute('DELETE FROM files WHERE room = ?', (code,))
            db.execute('DELETE FROM messages WHERE room = ?', (code,))
            db.execute('DELETE FROM rooms WHERE code = ?', (code,))

def require_room(code, secret):
    if not ROOM_RE.fullmatch(code):
        raise HTTPException(404, 'Room not found')
    with connect_db() as db:
        row = db.execute('SELECT * FROM rooms WHERE code = ?', (code,)).fetchone()
    if not row or row['expires'] <= time.time():
        raise HTTPException(404, 'Room expired or not found')
    if not (secret or '').isascii() or not secrets.compare_digest(row['secret'], secret or ''):
        raise HTTPException(403, 'Invalid room key')
    return row

@asynccontextmanager
async def lifespan(app):
    initialize()
    cleanup()
    yield

app = FastAPI(title='ShareRoom', lifespan=lifespan)
app.mount('/static', StaticFiles(directory=BASE / 'static'), name='static')

@app.get('/')
def index():
    return FileResponse(BASE / 'static' / 'index.html')

class RoomInput(BaseModel):
    name: str = Field(default='Your room', min_length=1, max_length=60)

    @field_validator('name')
    @classmethod
    def strip_name(cls, value):
        value = value.strip()
        if not value:
            raise ValueError('Room name cannot be blank')
        return value


@app.post('/api/rooms')
def create_room(payload: RoomInput | None = None):
    cleanup()
    alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    with connect_db() as db:
        for _ in range(10):
            code = ''.join(secrets.choice(alphabet) for _ in range(6))
            secret = secrets.token_urlsafe(24)
            try:
                db.execute('INSERT INTO rooms(code, secret, expires, name) VALUES (?, ?, ?, ?)', (code, secret, time.time() + TTL, payload.name if payload else 'Your room'))
                return {'code': code, 'key': secret, 'expires_in': TTL}
            except sqlite3.IntegrityError:
                pass
    raise HTTPException(503, 'Could not create room')

@app.get('/api/rooms/{code}')
def get_room(code: str, key: str):
    row = require_room(code, key)
    with connect_db() as db:
        messages = [dict(r) for r in db.execute('SELECT id, text, created, sender FROM messages WHERE room = ? ORDER BY id DESC LIMIT 100', (code,))][::-1]
        files = [dict(r) for r in db.execute('SELECT id, name, size, sha256, created FROM files WHERE room = ? ORDER BY created DESC', (code,))]
    return {'code': code, 'name': row['name'], 'expires_at': row['expires'], 'messages': messages, 'files': files}

async def broadcast(code, event):
    for ws in list(connections.get(code, set())):
        try:
            await ws.send_json(event)
        except Exception:
            connections[code].discard(ws)

@app.websocket('/ws/{code}')
async def socket(ws: WebSocket, code: str):
    key = ws.query_params.get('key', '')
    try:
        require_room(code, key)
    except HTTPException:
        await ws.close(code=1008)
        return
    await ws.accept()
    connections.setdefault(code, set()).add(ws)
    await broadcast(code, {'type': 'presence', 'count': len(connections[code])})
    try:
        while True:
            payload = await ws.receive_json()
            require_room(code, key)
            if not isinstance(payload, dict):
                await ws.send_json({'type': 'error', 'message': 'Invalid message format'})
                continue
            kind = payload.get('type')
            if kind == 'ping':
                await ws.send_json({'type': 'pong', 'sent': payload.get('sent')})
            elif kind == 'message':
                value = payload.get('text')
                if not isinstance(value, str) or not value.strip() or len(value) > MAX_MESSAGE:
                    await ws.send_json({'type': 'error', 'message': 'Message must be 1–10000 characters'})
                    continue
                sender = payload.get('sender', 'Guest')
                if not isinstance(sender, str) or not sender.strip() or len(sender) > 40:
                    await ws.send_json({'type': 'error', 'message': 'Name must be 1–40 characters'})
                    continue
                now = time.time()
                with connect_db() as db:
                    cur = db.execute('INSERT INTO messages(room, text, created, sender) VALUES (?, ?, ?, ?)', (code, value, now, sender.strip()))
                    msg_id = cur.lastrowid
                await broadcast(code, {'type': 'message', 'id': msg_id, 'text': value, 'created': now, 'sender': sender.strip()})
    except (WebSocketDisconnect, HTTPException, ValueError, RuntimeError):
        pass
    finally:
        try:
            await ws.close()
        except RuntimeError:
            pass
        connections.get(code, set()).discard(ws)
        await broadcast(code, {'type': 'presence', 'count': len(connections.get(code, set()))})

@app.post('/api/rooms/{code}/files')
async def upload(code: str, key: str = Form(...), file: UploadFile = File(...)):
    require_room(code, key)
    file_id = secrets.token_hex(16)
    path = FILES / file_id
    total = 0
    digest = hashlib.sha256()
    try:
        with path.open('wb') as output:
            while chunk := await file.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_FILE:
                    raise HTTPException(413, 'Maximum file size is 25 MB')
                output.write(chunk)
                digest.update(chunk)
        require_room(code, key)
        name = Path((file.filename or 'unnamed').replace('\\', '/')).name[:180]
        now = time.time()
        with connect_db() as db:
            db.execute('INSERT INTO files VALUES (?, ?, ?, ?, ?, ?)', (file_id, code, name, total, digest.hexdigest(), now))
        event = {'type': 'file', 'id': file_id, 'name': name, 'size': total, 'sha256': digest.hexdigest(), 'created': now}
        await broadcast(code, event)
        return event
    except Exception:
        path.unlink(missing_ok=True)
        raise
    finally:
        await file.close()

@app.get('/api/rooms/{code}/files/{file_id}')
def download(code: str, file_id: str, key: str):
    require_room(code, key)
    with connect_db() as db:
        row = db.execute('SELECT * FROM files WHERE id = ? AND room = ?', (file_id, code)).fetchone()
    if not row or not (FILES / file_id).is_file():
        raise HTTPException(404, 'File not found')
    return FileResponse(FILES / file_id, filename=row['name'], media_type='application/octet-stream')


# ALB demonstration endpoints. Counters are local to this process only.
# They are not AWS CloudWatch metrics and reset on restart.
INSTANCE_NAME = os.environ.get("INSTANCE_NAME", os.environ.get("HOSTNAME", "share-room-1"))[:64]
STARTED_AT = time.time()
probe_requests = 0

@app.get("/health")
def health():
    return {"status": "ok"}

@app.get("/api/network/instance")
def network_instance():
    global probe_requests
    probe_requests += 1
    return {
        "instance": INSTANCE_NAME,
        "requests_seen_by_this_process": probe_requests,
        "uptime_seconds": int(time.time() - STARTED_AT),
        "timestamp": time.time(),
        "note": "Application probe counts only; not ALB request totals"
    }


@app.get("/api/network/aws-metrics")
def aws_metrics():
    from aws_monitor import get_alb_metrics
    return get_alb_metrics()

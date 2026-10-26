import hashlib
import os
import tempfile
from pathlib import Path
os.environ['SHAREROOM_DATA'] = tempfile.mkdtemp(prefix='shareroom-tests-')
from fastapi.testclient import TestClient
from app import app

def test_room_messages_files_and_auth():
    with TestClient(app) as client:
        r = client.post('/api/rooms'); assert r.status_code == 200
        code,key = r.json()['code'],r.json()['key']
        assert client.get(f'/api/rooms/{code}',params={'key':'wrong'}).status_code == 403
        assert client.get(f'/api/rooms/{code}',params={'key':'🔑'}).status_code == 403
        with client.websocket_connect(f'/ws/{code}?key={key}') as ws:
            assert ws.receive_json()['type'] == 'presence'
            ws.send_json({'type':'message','text':'Hello from test'})
            event=ws.receive_json()
            assert event['type']=='message' and event['text']=='Hello from test'
            ws.send_json({'type':'ping','sent':123})
            assert ws.receive_json()['type']=='pong'
        data=b'hello file transfer'
        response=client.post(f'/api/rooms/{code}/files',data={'key':key},files={'file':('demo.txt',data,'text/plain')})
        assert response.status_code==200
        info=response.json()
        assert info['sha256']==hashlib.sha256(data).hexdigest()
        assert client.get(f'/api/rooms/{code}/files/{info["id"]}',params={'key':key}).content==data
        state=client.get(f'/api/rooms/{code}',params={'key':key}).json()
        assert len(state['messages'])==1 and len(state['files'])==1

def test_file_size_limit():
    with TestClient(app) as client:
        r=client.post('/api/rooms').json()
        response=client.post(f'/api/rooms/{r["code"]}/files',data={'key':r['key']},files={'file':('large.bin',b'x'*(25*1024*1024+1))})
        assert response.status_code==413


def test_named_rooms_validation_and_sender_history():
    with TestClient(app) as client:
        for name in ('   ', 'x' * 61):
            assert client.post('/api/rooms', json={'name': name}).status_code == 422
        room = client.post('/api/rooms', json={'name': '  Design team  '}).json()
        url = f'/api/rooms/{room["code"]}'
        params = {'key': room['key']}
        assert client.get(url, params=params).json()['name'] == 'Design team'
        with client.websocket_connect(f'/ws/{room["code"]}?key={room["key"]}') as ws:
            ws.receive_json()
            for payload in ([], None, {'type': 'message', 'text': '   '}, {'type': 'message', 'text': 'ok', 'sender': []}):
                ws.send_json(payload)
                assert ws.receive_json()['type'] == 'error'
            ws.send_json({'type': 'message', 'text': '<script>hello</script>', 'sender': 'Om'})
            assert ws.receive_json()['sender'] == 'Om'
        messages = client.get(url, params=params).json()['messages']
        assert len(messages) == 1 and messages[0]['sender'] == 'Om'


def test_presence_broadcast_isolation_and_file_authorization():
    with TestClient(app) as client:
        first = client.post('/api/rooms').json()
        other = client.post('/api/rooms').json()
        code, key = first['code'], first['key']
        with client.websocket_connect(f'/ws/{code}?key={key}') as a:
            assert a.receive_json()['count'] == 1
            with client.websocket_connect(f'/ws/{code}?key={key}') as b:
                assert a.receive_json()['count'] == 2
                assert b.receive_json()['count'] == 2
                b.send_json({'type': 'message', 'text': 'Shared'})
                assert a.receive_json()['text'] == b.receive_json()['text'] == 'Shared'
                result = client.post(f'/api/rooms/{code}/files', data={'key': key}, files={'file': ('../../demo.txt', b'abc')}).json()
                assert a.receive_json()['type'] == b.receive_json()['type'] == 'file'
                assert result['name'] == 'demo.txt'
            assert a.receive_json()['count'] == 1
        assert client.get(f'/api/rooms/{other["code"]}', params={'key':other['key']}).json()['messages'] == []
        assert client.get(f'/api/rooms/{code}/files/{result["id"]}', params={'key':'wrong'}).status_code == 403
        assert client.get(f'/api/rooms/{other["code"]}/files/{result["id"]}', params={'key':other['key']}).status_code == 404


def test_expired_room_rejects_access_and_cleans_files():
    from app import connect_db, cleanup, FILES
    with TestClient(app) as client:
        room = client.post('/api/rooms').json()
        code, key = room['code'], room['key']
        file = client.post(f'/api/rooms/{code}/files', data={'key':key}, files={'file':('a.txt', b'abc')}).json()
        with connect_db() as db:
            db.execute('UPDATE rooms SET expires=0 WHERE code=?', (code,))
        assert client.get(f'/api/rooms/{code}', params={'key':key}).status_code == 404
        assert client.post(f'/api/rooms/{code}/files', data={'key':key}, files={'file':('x', b'x')}).status_code == 404
        cleanup()
        assert not (FILES / file['id']).exists()


def test_existing_database_migration(tmp_path, monkeypatch):
    import sqlite3
    import app as module
    db_path = tmp_path / 'legacy.sqlite3'
    with sqlite3.connect(db_path) as db:
        db.execute('CREATE TABLE rooms(code TEXT PRIMARY KEY, secret TEXT NOT NULL, expires REAL NOT NULL)')
        db.execute('CREATE TABLE messages(id INTEGER PRIMARY KEY, room TEXT NOT NULL, text TEXT NOT NULL, created REAL NOT NULL)')
        db.execute("INSERT INTO rooms VALUES ('ABC123','secret',9999999999)")
        db.execute("INSERT INTO messages VALUES (1,'ABC123','Old message',1)")
    monkeypatch.setattr(module, 'DB', db_path)
    module.initialize()
    module.initialize()
    with module.connect_db() as db:
        assert db.execute('SELECT name FROM rooms').fetchone()['name'] == 'Your room'
        assert db.execute('SELECT sender FROM messages').fetchone()['sender'] == 'Guest'


def test_network_endpoints_without_aws_config(monkeypatch):
    for name in ('SHAREROOM_ALB_ARN','SHAREROOM_APP_TG_ARN','SHAREROOM_MONITOR_TG_ARN'):
        monkeypatch.delenv(name, raising=False)
    with TestClient(app) as client:
        assert client.get('/health').json()['status'] == 'ok'
        assert client.get('/api/network/instance').json()['instance']
        assert client.get('/api/network/aws-metrics').json()['connected'] is False


def test_aws_metrics_dimensions_and_target_groups(monkeypatch):
    import aws_monitor
    for name, value in {
        'SHAREROOM_ALB_ARN': 'arn:aws:elasticloadbalancing:us-east-1:123:loadbalancer/app/demo/abc',
        'SHAREROOM_APP_TG_ARN': 'application-group',
        'SHAREROOM_MONITOR_TG_ARN': 'monitor-group',
    }.items():
        monkeypatch.setenv(name, value)
    class AwsStub:
        def describe_target_health(self, TargetGroupArn):
            return {'TargetHealthDescriptions': [{'Target': {'Id': TargetGroupArn}, 'TargetHealth': {'State': 'healthy'}}]}
        def get_metric_data(self, **kwargs):
            assert kwargs['MetricDataQueries'][0]['MetricStat']['Metric']['Dimensions'][0]['Value'] == 'app/demo/abc'
            return {'MetricDataResults': [{'Id':'requests','Values':[2,3]}, {'Id':'response','Values':[0.02,0.04]}]}
    monkeypatch.setattr(aws_monitor.boto3, 'client', lambda *args, **kwargs: AwsStub())
    data = aws_monitor.get_alb_metrics()
    assert data['connected'] is True
    assert data['request_count'] == 5 and data['target_response_time_ms'] == 30
    assert data['targets']['application']['details'][0]['id'] == 'application-group'
    assert data['targets']['monitor']['details'][0]['id'] == 'monitor-group'


def test_code_only_join_and_expired_missing_codes():
    from app import connect_db
    with TestClient(app) as client:
        room = client.post('/api/rooms').json()
        joined = client.post(f'/api/rooms/{room["code"].lower()}/join')
        assert joined.status_code == 200
        assert joined.json() == {'code': room['code'], 'key': room['key']}
        with client.websocket_connect(f'/ws/{room["code"]}?key={joined.json()["key"]}') as ws:
            assert ws.receive_json()['type'] == 'presence'
        assert client.post('/api/rooms/invalid/join').status_code == 404
        with connect_db() as db:
            db.execute('UPDATE rooms SET expires=0 WHERE code=?', (room['code'],))
        assert client.post(f'/api/rooms/{room["code"]}/join').status_code == 404


def test_concurrent_creation_retries_return_one_room():
    from concurrent.futures import ThreadPoolExecutor
    from app import connect_db
    import secrets
    payload = {'name': 'Retry test', 'request_id': secrets.token_hex(24)}
    with TestClient(app) as client:
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: client.post('/api/rooms', json=payload), range(8)))
        assert all(result.status_code == 200 for result in results)
        assert len({result.json()['code'] for result in results}) == 1
        assert len({result.json()['key'] for result in results}) == 1
        with connect_db() as db:
            assert db.execute('SELECT COUNT(*) FROM rooms WHERE request_id=?', (payload['request_id'],)).fetchone()[0] == 1
        assert client.post('/api/rooms', json={**payload, 'name': 'Different'}).status_code == 409
        assert client.post('/api/rooms', json={'request_id': 'bad'}).status_code == 422

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

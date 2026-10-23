# ShareRoom neon UI

The home page uses the approved black (#0b0b0b), pink (#ff2dab) and chartreuse (#d4ff3f) direction. Chartreuse highlights the overlapping room artwork, logo, focus rings, invite action and connection information. The old sidebar, feature cards and repeated marketing sections are removed. Home, room and network pages use the same responsive stylesheet; no frontend build is needed.

Create and join are real forms with labels, loading states and persistent errors. Creating accepts a room name; joining an invite asks for a display name. Room names and message senders are persisted with an additive SQLite migration. Existing rooms/messages default to “Your room”/“Guest”. Display names are informal labels, not verified identities. Existing API clients can still create rooms with an empty POST body.

Other fixes include duplicate-submit prevention, malformed invite handling, reconnect with history reload, whitespace-message validation, readable HTTP clipboard fallback, protection against stale upload responses after leaving, malformed WebSocket payload handling, non-ASCII key rejection, bounded monitoring requests and clearing stale AWS values after errors.

## Validation

```sh
python -m pip install -r requirements.txt
python -m pytest -q
npm ci
npm test
```

Node >=22.12 is needed only for the development test tools. Production continues to run Python/FastAPI and static assets without Node.

Python tests cover real HTTP/WebSocket room creation, names, validation, presence and broadcasts, persisted history, uploads/downloads, hashes, 25 MB limits, wrong keys, cross-room isolation, expiration cleanup, legacy database migration, monitoring endpoints and mocked AWS metric dimensions/target groups.

Node/jsdom tests run the actual HTML and scripts with mocked network transport: repeated submit, failed creation, recoverable created invites, join errors, invite parsing, keyboard tabs, safe message rendering/deduplication, copy fallback, reconnect, upload limits, stale upload responses, probe reset and stale AWS metrics.

Visual browser verification is still pending: Chromium was unavailable and browser downloads failed in the editing environment. jsdom is not a layout engine. Check desktop and 375px mobile widths before merging. Real AWS target health/CloudWatch access also requires the EC2 environment and was not exercised here.

## Deployment review

This branch starts from `feature/cloudwatch-alb-metrics`, the branch with the deployed forest UI and AWS monitoring. `main` is older. Review the PR against that branch to avoid unintentionally dropping existing monitoring changes.

Before deployment, save any existing EC2 working-tree changes (especially `aws_monitor.py`) and back up the SQLite database. Install requirements and restart the existing service using your usual deployment procedure. Startup adds `rooms.name` and `messages.sender`; existing data is retained. Startup serializes the additive migration with a SQLite transaction.

Manual acceptance checks:

- Create a room, confirm the room name, copy its invite, and join from a second browser.
- Exchange messages in both directions; upload/download a file and compare its hash.
- Disconnect and reconnect, leave, reload an invite, and try an invalid key.
- Confirm keyboard focus, tab switching and no horizontal overflow on mobile.
- Run probes and refresh AWS metrics on EC2. Keep application and monitor target health distinct.

Room state/files are still local SQLite/disk and live broadcasts are process-local. This UI change does not make room traffic safe to distribute across multiple independent application instances. Keep the existing single-application-target routing until shared state and broadcasting are implemented.

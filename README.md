# TinyNewborn migration API

## Setup

On a fresh checkout, run `Copy-Item database.example.json database.json` in PowerShell before starting the server. The server reads and writes `database.json`, which is ignored by Git. Set `TINYNEWBORN_MIGRATION_DB_PATH` to use another copy. Run one server process per database file.

Double-click `start.bat` or run `node server.js` from this directory with Node.js 18 or later. The API listens on `127.0.0.1:3005` by default. In PowerShell, set `$env:TINYNEWBORN_MIGRATION_HOST` to an IP assigned to this machine and `$env:TINYNEWBORN_MIGRATION_PORT` to the desired port before starting. Clients use that IP and port as their base URL. Use a trusted network when binding to a LAN IP because this API has no authentication.

| Method and path | Purpose |
| --- | --- |
| `GET /api/logs` | Read sleep, feeding, bottle, and diaper records. Optional `?days=2` limits recent history and retains an open sleep event. |
| `POST /api/logs` | Create a log. Supply a stable `id` to retry safely. |
| `PUT /api/logs/{id}` | Edit a log using the same fields. |
| `DELETE /api/logs/{id}` | Delete one log. |
| `GET /api/profile` | Read the baby profile. |
| `PUT /api/profile` | Set birthday with `{"birthday":"2026-01-31"}`. |

Send JSON request bodies with `Content-Type: application/json`.

```json
{"type":"sleep","status":"asleep"}
{"type":"sleep","status":"awake"}
{"type":"feeding","method":"breast","side":"left"}
{"type":"bottle","ounces":3,"milkType":"breast_milk"}
{"type":"diaper","kind":"pee"}
{"type":"diaper","kind":"poop","poopColorId":"yellow","consistency":"soft"}
```

The examples are separate requests. Logs accept an optional ISO `createdAt`, or local `date` and `time`. Create and edit responses contain `log`. Delete returns `deletedId`. Profile routes return `profile`. This reduced API omits the original summary and recent-state fields, analytics date-range queries, and other app endpoints.

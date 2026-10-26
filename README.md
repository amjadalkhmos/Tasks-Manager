# Tasks

A task manager you can use alone or with a team. Capture a task in one line, plan the day, and keep working offline.

<p>
  <img src="docs/screenshots/quick-add.png" alt="Quick add understanding a date, priority, repeat and tag as you type" width="49%">
  <img src="docs/screenshots/board-dark.png" alt="Kanban board in dark mode" width="49%">
</p>
<p>
  <img src="docs/screenshots/task-comments.png" alt="A task with an assignee, comments and an @mention" width="49%">
  <img src="docs/screenshots/workspace.png" alt="A workspace with members, projects and an activity feed" width="49%">
</p>

## Features

**Your own tasks**
- Quick add: `Call Sam tomorrow 3pm !high #work every week` sets the date, priority, tag and repeat, and shows what it understood before you press Enter.
- Subtasks to any depth with progress roll-up, checklists, dependencies ("blocked by"), priorities, tags and projects.
- Due dates, reminders, and recurring tasks (daily, weekly on chosen days, monthly).
- Views: Inbox, Today, Upcoming, Board (drag between columns), Calendar (drag to reschedule), saved smart lists, and a dashboard with a weekly review.
- Time tracking with estimates, a command palette (`Ctrl+K`), and keyboard shortcuts. Light and dark themes follow your system.

**Works anywhere**
- Installable as an app. It opens without a connection and shows your last-seen tasks; creating, editing, completing and deleting tasks while offline is saved on your device and synced when you reconnect.
- Import from this app's JSON, a CSV, Todoist, or Trello. Export to JSON or CSV.
- Optional AI helpers: suggest subtasks for a task, and plan your day (uses the Claude API).
- Optional Google Calendar sync (due dates, both directions) and Gmail-to-task import.

**With a team**
- Workspaces with roles: **owner**, **admin**, **member**, **viewer**.
- Invite people by email address, assign tasks, comment with `@mentions`, and follow a per-workspace activity feed. Notifications tell you about assignments, mentions and comments.
- Private tasks stay private. Only tasks in a workspace's projects are shared.

## Quick start (development)

You need Node.js. It is developed and tested on Node 24.

```bash
npm install
npm run dev
```

This starts the API on http://localhost:3000 and the web app on **http://localhost:5173** (which proxies `/api` to the API). Open the web app, choose **Create an account**, and you're in. Data is stored in `server/tasks.db`.

Other commands:

```bash
npm test          # server and web unit/integration tests
npm run build     # type-check and build both
npm start -w server   # run the built server (after npm run build); also serves the built web app
```

## Run with Docker

```bash
cp .env.example .env        # then set JWT_SECRET (instructions are in the file)
docker compose up -d --build
```

Open http://localhost:3000. The database is kept in a Docker volume (`tasks-data`), so it survives restarts and rebuilds. To back it up, stop the container first and copy all of `/data` out of the volume (the database uses write-ahead logging, so `tasks.db-wal` matters as well as `tasks.db`), or run `sqlite3 /data/tasks.db ".backup /data/backup.db"` while it's running.

To use the image without Compose:

```bash
docker build -t tasks .
docker run -d -p 3000:3000 -e JWT_SECRET="$(openssl rand -base64 48)" -v tasks-data:/data tasks
```

> **Plain HTTP:** in production mode the login cookie is marked `Secure`, which browsers only send over HTTPS (they make an exception for `localhost`). If you serve the app over plain HTTP on a home network, set `COOKIE_SECURE=false`. If it's reachable from the internet, put it behind an HTTPS reverse proxy instead.

## Configuration

Everything is set with environment variables. Only `JWT_SECRET` is required in production.

| Variable | Default | What it does |
|---|---|---|
| `JWT_SECRET` | dev only | Signs login sessions. **Required** when `NODE_ENV=production`. |
| `PORT` | `3000` | Port the server listens on. |
| `DB_FILE` | `tasks.db` | Path of the SQLite database (`/data/tasks.db` in Docker). |
| `COOKIE_SECURE` | `true` in production | Set `false` to allow login over plain HTTP. |
| `ANTHROPIC_API_KEY` | – | Turns on the AI helpers. (`AI_ENABLED=1` also works if the server has other Anthropic credentials.) |
| `AI_MODEL` | `claude-sonnet-5-5` | Model used for the AI helpers. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PUBLIC_URL` | – | Turn on Google Calendar and Gmail. Create an OAuth client in Google Cloud and add `<PUBLIC_URL>/api/integrations/google/callback` as a redirect URI. |
| `TOKEN_ENC_KEY` | derived from `JWT_SECRET` | 32 random bytes, base64. Encrypts stored Google tokens. **Required** with Google in production. |

Features that aren't configured simply don't appear as available (Settings explains how to enable them).

## How it's organised

```
server/   Express + SQLite API (TypeScript)
  src/access.ts     The one place that decides who can see and do what
  src/tasks.ts      Tasks, projects and tags
  src/collab.ts     Workspaces, members, invitations, comments, activity, notifications
  src/extras.ts     Dependencies, checklists, saved lists, time tracking, stats
  src/dataio.ts     Import and export
  src/ai.ts         AI helpers          src/google.ts   Google Calendar and Gmail
web/      React + Vite app (TypeScript)
  public/sw.js      Service worker (offline)
  src/lib/offline.ts  The offline write queue
```

**Access control.** Every route asks `server/src/access.ts` instead of writing its own `WHERE user_id = ?`, so there is a single definition of visibility. A task is visible if it is private and yours, or it is in a project of a workspace you belong to. Someone who can't see something gets a 404 (its existence isn't revealed); someone who can see it but isn't allowed to change it gets a 403.

## Testing

`npm test` runs 78 server tests (Vitest and Supertest, against an in-memory database) and 9 web unit tests. The server tests include a role-by-role permission matrix for workspaces, and the private/shared boundary.

What is **not** covered by tests that touch the real world:
- The AI helpers and the Google integration are tested against fakes. They have not been run against the live Claude or Google APIs.
- There are no automated browser tests in the repository. The UI was exercised in a real browser during development, but those scripts aren't included.

## Limitations to know about

- **No email is sent.** Workspace invitations appear under *Notifications* when the person signs in with the invited address (they can create the account first).
- **Updates are not real-time.** The app checks for new notifications every 30 seconds and when you return to the window.
- **Offline writes** cover task create, edit, complete and delete. Other changes (projects, comments, workspaces) need a connection and say so.
- **One server, one SQLite file.** Fine for a person or a small team; it isn't built for horizontal scaling.
- **Before exposing it to the internet:** there is no login rate limiting, so put it behind a reverse proxy that provides HTTPS and rate limiting, use a strong `JWT_SECRET`, and keep backups of the database.
- Export covers your private data only; shared workspaces belong to everyone in them.

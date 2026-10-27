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

**Statuses, meetings and projects**
- **Every task shows a status.** Out of the box that is To do, Doing or Done. A workspace's admins can define their own (for example *Backlog*, *In review*, *Shipped*) for the whole workspace, and any single project can define its own instead. Each status belongs to one of the three stages, which is what decides what counts as finished (completion, recurrence, dependencies and progress all use the stage). The Board uses a project's statuses as its columns.
- **Meetings** are created in the app (private, or shared with a workspace) and linked to any number of tasks in the same place, from the task or from the *Meetings* page. They already carry a source and external id, so syncing with Google Calendar later can update meetings instead of duplicating them.
- **Project types.** A project is a *Delivery* (dates, milestones, a timeline), a *Sales pipeline* (New → Contacted → Qualified → Won / Lost), *Support* (New → In progress → Waiting on customer → Resolved) or a simple *Initiative*. The type sets the starting statuses and the view the project opens on; everything can be changed afterwards.
- **One project home.** Each project has an **Overview** (what needs attention, progress, milestones, work by status and by person, updates), **Work** (list, board or timeline) and **Settings**. Managers open on the Overview; everyone else opens on their work.
- **Plan over time.** Tasks have an optional start date and belong to a milestone, so a milestone shows its own progress and warns when its tasks are late or scheduled after its date. The timeline shows tasks as bars under their milestones. Progress is weighted by estimates (a task with no estimate counts as an hour), and the numbers also suggest a health (on track / at risk / off track) beside the team's own rating.
- **Life cycle**: Planning → Active → On hold / Completed → Archived, with the allowed moves enforced, a note and history for every change, a warning before completing a project with open tasks, and archived projects hidden from the sidebar (and closed to new tasks) until restored.
- **For team members:** *My work* lists everything assigned to you across projects, soonest first. **For managers:** *Needs attention* shows projects drifting off plan, overdue and blocked work, unassigned work and who is carrying how much, across the workspaces you manage. *Projects* compares every project side by side.

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

This starts the API on http://localhost:3000 and the web app on **http://localhost:5173** (which proxies `/api` to the API). Open the web app, choose **Create an account**, and you're in. Data is stored in `server/tasks.db` (SQLite), so there is nothing else to install.

Other commands:

```bash
npm test              # all tests, on SQLite and on PostgreSQL (see Testing)
npm run build         # type-check and build both
npm start -w server   # run the built server (after npm run build); also serves the built web app
```

## Databases

The app runs on **SQLite** (a single file, the default) or **PostgreSQL**. The same code and the same tests cover both.

| | SQLite | PostgreSQL |
|---|---|---|
| Choose it by | leaving `DATABASE_URL` unset (file is `DB_FILE`, default `tasks.db`) | setting `DATABASE_URL=postgres://user:password@host:5432/dbname` |
| Good for | development, a personal install, one small server | hosting, several app instances, managed backups |
| Setup | none | a database to connect to; the tables are created on first start |

The server prints which one it is using when it starts. Switching later is a one-time copy:

```bash
# stop the app first, then (after npm run build):
node server/dist/migrate-sqlite-to-postgres.js server/tasks.db "postgres://user:password@host:5432/dbname"
```

The target database must be empty. Every row keeps its id, the copy is checked table by table, and it is all-or-nothing: if anything fails, nothing is written. Then start the app with `DATABASE_URL` set. (In development you can run it without building: `npm run migrate:sqlite-to-postgres -w server -- server/tasks.db "postgres://…"`.)

## Run with Docker

```bash
cp .env.example .env        # then set JWT_SECRET and POSTGRES_PASSWORD (instructions are in the file)
docker compose up -d --build
```

Open http://localhost:3000. This starts the app together with its own PostgreSQL database; the data lives in a Docker volume (`pgdata`) and survives restarts and rebuilds. Back it up with `docker compose exec db pg_dump -U tasks tasks > backup.sql`.

To run the image against your own database, or with SQLite:

```bash
docker build -t tasks .

# PostgreSQL
docker run -d -p 3000:3000 -e JWT_SECRET="$(openssl rand -base64 48)" -e DATABASE_URL="postgres://…" tasks

# SQLite, kept in a volume
docker run -d -p 3000:3000 -e JWT_SECRET="$(openssl rand -base64 48)" -v tasks-data:/data tasks
```

> **Plain HTTP:** in production mode the login cookie is marked `Secure`, which browsers only send over HTTPS (they make an exception for `localhost`). If you serve the app over plain HTTP on a home network, set `COOKIE_SECURE=false`. If it's reachable from the internet, put it behind an HTTPS reverse proxy instead.

## Deploy on Railway

Railway builds the `Dockerfile` in this repository automatically.

1. **Create a project from this GitHub repository.** Railway detects the Dockerfile.
2. **Add a PostgreSQL database** to the same project (*New → Database → PostgreSQL*).
3. **Set variables on the app service** (*Variables*):
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (Railway fills this in from the database; the name in the braces is your database service's name)
   - `JWT_SECRET` = a long random string (`openssl rand -base64 48`)
   - optional: `ANTHROPIC_API_KEY`, and the Google variables from the table below
4. **Generate a domain** for the app service (*Settings → Networking*). Railway serves it over HTTPS, so the default `COOKIE_SECURE` is right.
5. Deploy. The tables are created on the first start, and `/api/health` is a good *Healthcheck Path*.

You do **not** need a volume: the data is in PostgreSQL. If you connect through the database's *public* address instead of the private one and the connection is refused, add `?sslmode=require` to `DATABASE_URL` (and `PG_SSL=no-verify` only if the certificate can't be verified).

To bring existing SQLite data over, run the migration command above from your own computer, with `DATABASE_URL`'s *public* address as the target.

## Configuration

Everything is set with environment variables. In production, only `JWT_SECRET` is required.

| Variable | Default | What it does |
|---|---|---|
| `JWT_SECRET` | dev only | Signs login sessions. **Required** when `NODE_ENV=production`. |
| `DATABASE_URL` | – | A `postgres://` URL switches the app to PostgreSQL. |
| `DB_FILE` | `tasks.db` | Path of the SQLite database, used when `DATABASE_URL` is not set (`/data/tasks.db` in Docker). |
| `PG_POOL_MAX` | `10` | Maximum PostgreSQL connections held by one app instance. |
| `PG_SSL` | – | `no-verify` encrypts the PostgreSQL connection without checking the server's certificate. A last resort; prefer `?sslmode=require`. |
| `PORT` | `3000` | Port the server listens on (hosts like Railway set this for you). |
| `COOKIE_SECURE` | `true` in production | Set `false` to allow login over plain HTTP. |
| `ANTHROPIC_API_KEY` | – | Turns on the AI helpers. (`AI_ENABLED=1` also works if the server has other Anthropic credentials.) |
| `AI_MODEL` | `claude-sonnet-5-5` | Model used for the AI helpers. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PUBLIC_URL` | – | Turn on Google Calendar and Gmail. Create an OAuth client in Google Cloud and add `<PUBLIC_URL>/api/integrations/google/callback` as a redirect URI. |
| `TOKEN_ENC_KEY` | derived from `JWT_SECRET` | 32 random bytes, base64. Encrypts stored Google tokens. **Required** with Google in production. |

Features that aren't configured simply don't appear as available (Settings explains how to enable them).

## How it's organised

```
server/   Express API (TypeScript)
  src/db.ts            The small async database interface everything else uses
  src/db-sqlite.ts, db-postgres.ts   The two drivers; db-schema.ts is the schema, dialect.ts the few SQL differences
  src/access.ts        The one place that decides who can see and do what
  src/tasks.ts         Tasks, projects and tags
  src/collab.ts        Workspaces, members, invitations, comments, activity, notifications
  src/extras.ts        Dependencies, checklists, saved lists, time tracking, stats
  src/dataio.ts        Import and export
  src/ai.ts            AI helpers          src/google.ts   Google Calendar and Gmail
web/      React + Vite app (TypeScript)
  public/sw.js         Service worker (offline)
  src/lib/offline.ts   The offline write queue
```

**Access control.** Every route asks `server/src/access.ts` instead of writing its own `WHERE user_id = ?`, so there is a single definition of visibility. A task is visible if it is private and yours, or it is in a project of a workspace you belong to. Someone who can't see something gets a 404 (its existence isn't revealed); someone who can see it but isn't allowed to change it gets a 403.

**One SQL for both databases.** Queries are written once, with `?` placeholders, in the subset both databases accept. Timestamps are stored as ISO-8601 text and yes/no values as 0/1 in both, so values behave identically. The handful of genuine differences (date arithmetic, a person's display name) live in `src/dialect.ts`. Database work inside a transaction must use the handle the transaction gives it (`db.tx(async (t) => …)`), never the outer `db`.

## Testing

```bash
npm test                       # SQLite and PostgreSQL (in-process), plus the web tests
npm run test:postgres -w server   # additionally: a real PostgreSQL server (set TEST_DATABASE_URL first)
```

`npm test` runs every server test twice, once on SQLite and once on PostgreSQL via [PGlite](https://pglite.dev) (real PostgreSQL compiled to WebAssembly, so nothing needs installing), and the web unit tests. Setting `TEST_DATABASE_URL=postgres://…` (an empty, disposable database: its tables are emptied between tests) adds a third pass through the real `pg` driver. The suite includes a role-by-role permission matrix for workspaces, the private/shared boundary, a test that SQLite data copied to PostgreSQL gives identical answers from the API, and tests of the database layer itself.

What is **not** covered by tests that touch the real world:
- The AI helpers and the Google integration are tested against fakes. They have not been run against the live Claude or Google APIs.
- There are no automated browser tests in the repository. The UI was exercised in a real browser (against both databases) during development, but those scripts aren't included.

## Limitations to know about

- **No email is sent.** Workspace invitations appear under *Notifications* when the person signs in with the invited address (they can create the account first).
- **Updates are not real-time.** The app checks for new notifications every 30 seconds and when you return to the window.
- **Offline writes** cover task create, edit, complete and delete. Other changes (projects, comments, workspaces) need a connection and say so.
- **SQLite means one server.** The file can't be shared by several instances; use PostgreSQL if you want more than one. (The AI hourly limit is counted per instance.)
- **Before exposing it to the internet:** there is no login rate limiting, so put it behind a reverse proxy that provides HTTPS and rate limiting, use a strong `JWT_SECRET`, and keep backups of the database.
- Export covers your private data only; shared workspaces belong to everyone in them.

# Bun & Blaze

Vintage-modern burger restaurant reservation site. Customer booking flow + a
manager back office for approving reservations, shared across devices.

## Preview

Test at:

https://site-c84ac5b5926746c38781dd2c36d6dec3.freebuff.page

## Stack

- Static site (`files/bun-and-blaze/`) — HTML/CSS/JS, no build step.
- Cloudflare Worker API + D1 (`deploy/worker.js`).
- Deployed with the Freebuff Sites tools to a preview environment.

## Run locally

```bash
cd .tools
npm install
npm run build
```

Local dev (wrangler, 0.0.0.0 bind so the user's browser can reach it):

```bash
.n/bin/wrangler dev --port 8787 --ip 127.0.0.1
```

## API overview

- `GET /api/slots?date=...` — open seatings for a date.
- `POST /api/reservations` — customer → `pending`.
- `GET /api/reservations?date=&status=` — list by date + status.
- `PATCH /api/reservations/:id` — change a booking.
- `DELETE /api/reservations/:id` — remove a booking.
- `POST /api/reservations/:ref/cancel` — cancel by ref (not id).
- `GET /api/mine?refs=` — customer's "recent bookings" refs.
- `POST /api/manager/login` — manager session (passcode).
- `POST /api/seating` — add a seating.
- `POST /api/samples` — seed sample bookings.
- `DELETE /api/demo` — clear demo data.
- Back office endpoints are gated by the `x-manager-code` header; the default
  passcode is `1234` and can be overridden with `MANAGER_CODE` on the Worker.

## Manager back office

- Header "Staff" button (`href="#office"`), footer "Back office" link, and a
  desktop nav link. Designed to be reachable at every screen width.
- Approval queue with Approve / Decline, service list grouped by seating
  (`<details>`), Seat / Cancel / Reopen / Delete / Edit, a `+ New booking`
  form, per-seating Close / Reopen, stats, filters, CSV export, and two demo
  samples.

## Quick edits

1. Edit `files/bun-and-blaze/{index.html,styles.css,app.js}`.
2. Regenerate the deployed copy before deploying:

   ```bash
   cp files/bun-and-blaze/{index.html,styles.css,app.js} deploy/public/
   ```
3. Deploy with the Sites tools (`deploy/manifest.json` + `deploy/public/`).

## Git & hosting

- Repo: https://github.com/gurariye/bun-and-blaze (public, branch `main`).
- Local git: `cd /workspace/chats/954fb65e752180411fb1fec5`, branch `main`,
  remote `origin = https://github.com/gurariye/bun-and-blaze.git`.
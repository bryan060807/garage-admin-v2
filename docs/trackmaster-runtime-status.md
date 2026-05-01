# TrackMaster Runtime Status

As of April 29, 2026, TrackMaster main runtime is cut over to Windows PM2.

## Runtime ownership

- Windows owns the live TrackMaster API and UI runtime under PM2.
- Fedora remains responsible for Postgres, durable storage/backbone, Cloudflare ingress/front-door, control-plane duties, and backups.
- Fedora TrackMaster containers and images remain rollback artifacts and should not be pruned in this pass.

## Windows PM2 services

- `trackmaster-api`
  - local URL: `http://127.0.0.1:3004`
  - health: `http://127.0.0.1:3004/api/health`
  - readiness: `http://127.0.0.1:3004/api/readiness`
  - public routes: `https://trackmaster.aibry.shop/api/*`, `https://trackmaster-api.aibry.shop/api/*`
- `trackmaster-ui`
  - local URL: `http://127.0.0.1:3000/`
  - public route: `https://trackmaster.aibry.shop/`

## Database state

- The TrackMaster API now uses Fedora Postgres database `trackmaster_production`.
- The current runtime database role is `aibry`.
- Least-privilege hardening should move the runtime to a dedicated role such as `trackmaster_app` after review and approval.
- Proposed review-only SQL lives in [trackmaster-postgres-role-plan.sql](./trackmaster-postgres-role-plan.sql).

## Public validation

- `https://trackmaster.aibry.shop/` returned HTTP `200`.
- `https://trackmaster.aibry.shop/api/health` returned HTTP `200`.
- `https://trackmaster-api.aibry.shop/api/health` returned HTTP `200`.
- `/api/health` remains the primary live health endpoint.
- `/api/readiness` remains the dependency/runtime validation endpoint.

## Fedora stale runtime review

Checked-in Fedora unit files still exist in the TrackMaster repo:

- `deploy/trackmaster-api.service`
- `deploy/trackmaster-web.service`

`trackmaster-web.service` is the checked-in unit that starts the legacy Podman container named `trackmaster-ui`.

Both units are authored with `Restart=always` and `WantedBy=default.target`, so a still-enabled user unit could auto-start an old Podman runtime on Fedora. Live `systemctl` state was not changed from Garage Admin in this pass.

Safe review commands on Fedora:

```bash
systemctl --user is-enabled trackmaster-api.service
systemctl --user is-enabled trackmaster-web.service
systemctl --user status trackmaster-api.service --no-pager
systemctl --user status trackmaster-web.service --no-pager
```

If either legacy unit is still enabled, the safe disable/mask path is:

```bash
systemctl --user disable --now trackmaster-api.service
systemctl --user mask trackmaster-api.service
systemctl --user disable --now trackmaster-web.service
systemctl --user mask trackmaster-web.service
```

Do not remove images, volumes, or other rollback artifacts in this pass.

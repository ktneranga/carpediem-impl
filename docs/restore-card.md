# Restore Card — Carpe Diem POS

One page. Keep a printed copy with the POS. Commands run in PowerShell (or a Linux shell) in the folder that holds
`docker-compose.yml`.

## Take a backup (every night, before every update)

1. On any browser: `http://<pos-ip>:3000/vendor` → sign in with the vendor password → **Download database**.
2. The file is named `carpe-diem_YYYY-MM-DD_HHMM.dump`. Upload it to the private Google Drive folder.

Without the browser (on the POS itself):

```powershell
docker compose exec -T db pg_dump -U postgres -d cdrms --format=custom --no-owner -f /tmp/backup.dump
docker compose cp db:/tmp/backup.dump .\carpe-diem_backup.dump
```

## Restore

> Everything recorded after the backup is lost. If the system still works, take a fresh backup first.

1. Put the `.dump` file in the folder with `docker-compose.yml`.
2. Stop the app (the database keeps running):

   ```powershell
   docker compose stop app
   ```

3. Copy the file into the database container and restore it:

   ```powershell
   docker compose cp .\carpe-diem_YYYY-MM-DD_HHMM.dump db:/tmp/restore.dump
   docker compose exec -T db pg_restore -U postgres -d cdrms --no-owner --clean --if-exists --exit-on-error --single-transaction /tmp/restore.dump
   ```

   No output means it worked. `--single-transaction`: it restores everything or nothing.

4. Start the app again (it applies any newer database updates by itself):

   ```powershell
   docker compose up -d
   ```

5. Check: open `http://<pos-ip>:3000`, sign in with a PIN, look at the floor, the menu and Manage → Dashboard.

## On a brand-new machine

1. Install Docker. Copy `docker-compose.yml` and `.env` over, then `docker login ghcr.io` (GitHub user + the
   read-only token).
2. `docker compose up -d db` — the database only, so the app does not set up an empty restaurant first.
3. Restore as above (steps 3–5). Skip `--clean --if-exists` on an empty database; it is harmless either way.

## Rules

- The app version on the POS must be the **same or newer** than the one that made the backup.
- Never run `docker compose down -v`: `-v` deletes the database volume.
- Never paste the `.env` file or a `.dump` file into chat or email: both hold secrets.

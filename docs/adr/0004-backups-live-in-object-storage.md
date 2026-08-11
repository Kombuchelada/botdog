# Backups live in object storage, not on the volume they protect

The SQLite database's durability is the app's own gzipped copies in DO Spaces
(`backup.js`), taken every 30 minutes. Railway's volume backups and
point-in-time recovery were evaluated and turned down.

The reason is not preference. On 2026-08-10 the Railway volume hung at the OS
level: node PID 1 and *every* process that touched `/database` went into
uninterruptible `D` state — load average 1702 at 0% CPU — and survived
`SIGKILL`. The unkillable process kept the SQLite file lock, so every
replacement container died with `SQLITE_BUSY: database is locked`, which read
like a database bug and was not one. Nothing in this repo caused it and no code
change prevents it.

What makes it an architectural decision rather than an incident report is the
second fact: **Railway's own volume file API timed out on that volume too.** The
platform could not read it either. A backup that lives on the thing it is
protecting shares that thing's failure, and the Spaces copies were the only
reason the outage cost hours instead of everything.

Railway's volume backups would also not have helped here, for a mundane reason:
they are **Pro-plan only** ($20/month against Hobby's $5). Nothing in Railway's
docs says so — not the backups page, not the pricing page. The way you find out
is that `volumeInstanceBackupCreate` and `volumeInstanceBackupScheduleUpdate`
return `Not Authorized` while the matching read queries succeed. Worth knowing
before anyone spends an evening on it again.

So durability rests entirely on `backup.js`, which is what makes its cadence and
its retention load-bearing rather than housekeeping.

## Considered Options

- **Railway volume backups + PITR** — incremental, copy-on-write, and restoring
  is a click that mounts a new volume and keeps the old one, which is exactly
  the manoeuvre the 2026-08-10 recovery performed by hand. Rejected: Pro-only,
  a 4× subscription increase to protect a file that gzips to ~640 KiB. It is
  also storage on the same platform as the volume, at $0.15/GB/month against
  Spaces' $0.02/GiB/month on top of 250 GiB already paid for.
- **Daily Spaces backups (the previous behaviour)** — one full copy a day.
  Rejected by measurement: the incident landed 6h38m after the last snapshot,
  and that is the expected loss, not the worst case.
- **30-minute backups, delete anything older than N days** — the obvious
  retention policy. Rejected: the daily trail predates the half-hourly cadence,
  so a plain age cutoff destroys months of history the first time it runs. This
  was caught by dry-running the policy against the live bucket before shipping,
  not by review.
- **30-minute backups, keep everything for 7 days then the first of each UTC
  day forever** — chosen. Bounded steady state (~205 MiB) with a daily trail
  that never thins to nothing. The decision is a pure function of the listing
  and a clock (`selectExpired`), so it can be dry-run against production and
  tested without touching S3.

## Consequences

- `backups/latest.db.gz` is the key the restore recipe names, and it is out of
  the pruner's reach by construction: it does not match the `backups/db-`
  prefix the policy lists. A retention bug cannot take the restore path with it.
- Reading and gzipping are async. Synchronous versions were tolerable once a
  day and are not at 48 times a day, because GlizzyBrawl's Arena steps at 30Hz
  and a blocked event loop drops ticks for everyone connected.
- Restoring means uploading over `/database/data.db` — see the recipe at
  `/admin/backup`. Blank `DO_SPACES_KEY` first: the backup worker fires 30s
  after boot and will otherwise overwrite `latest.db.gz` with whatever empty
  database the app just created.

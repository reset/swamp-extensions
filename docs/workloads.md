# Workloads: the flight and the path relied on

Each workflow here is a flight of a studio workload. The path in the right column is the one the
studio relies on; the flight runs beside it, writes its records, and is compared. Switching what is
relied on is a change to this table and to which schedule people read, never a change inside SMK,
which calls nothing here. Where SMK has no path yet, the flight is not relied on either: the work
is done by hand until the SMK verb exists, and the flight is the specification for that verb.

| Workflow          | Behavior               | Relied on                                                               | On the serve host |
| ----------------- | ---------------------- | ----------------------------------------------------------------------- | ----------------- |
| crash-backlog     | `@reset/rollbar`       | the `crash` CLI and the crash-triage skill against crashq               | not scheduled     |
| crash-trend       | `@reset/rollbar`       | the `crash` CLI and the crash-triage skill against crashq               | not scheduled     |
| build-check       | `@reset/buildq`        | `smk ci`, and buildq's own commit status and build email                | not scheduled     |
| release-readiness | `@reset/workq`         | `smk issue`, `smk patch` and the crash-triage skill against workq       | not scheduled     |
| merge-gate        | `@reset/forgejo-pulls` | `smk pr merge`, which posts the marker, and automerge, which acts on it | not scheduled     |
| social-coverage   | `@reset/socialq`       | socialq's own calendar and wrap-up report, read by a person             | not scheduled     |
| steam-promote     | `@reset/steam`         | the steam-publish skill's procedure                                     | not scheduled     |
| unity-verify      | `@reset/unity`         | buildq running the repository's `make ci`                               | not scheduled     |
| godot-build       | `@reset/godot`         | buildq running the repository's `make ci` and export                    | daily, 07:30      |
| fmod-build        | `@reset/fmod`          | none in SMK yet: by hand in FMOD Studio                                 | not scheduled     |
| wwise-generate    | `@reset/wwise`         | none in SMK yet: by hand in Wwise                                       | not scheduled     |
| host-report       | lab behaviors          | the service probe and `smk host`                                        | hourly, at :17    |

Measurements the flight owes, per workload, for the retrospective: time to add the capability,
tokens per run, what the data layer changed in a diagnosis, and what left the machine.

## Where the flights run

`swamp serve` runs on a Linux host of ours as the swamp-serve user's systemd user unit (`serve/swamp-serve.service`),
from the release `serve/flake.nix` builds: swamp's Linux binary and the Godot 4.3 editor. It reads a
checkout of this repository at the revision `bin/serve-deploy` installed, and fires each workflow that
declares `trigger.schedule`; the times are cron in the host's time zone. It listens on loopback with
token auth, since every user on the host reaches loopback and a run reads the vault. `/health` lists
each schedule and its next fire.

A workflow is scheduled only when it can really run there. The others need:

- crash-backlog: a crashq read token for one project (32 hex characters) in the vault key
  `crashq-read-token`. The key on the Mac holds a 35-character value crashq refuses as malformed.
- steam-promote: never scheduled. Its last step sets a build live on a branch after a person's
  approval, and it takes the BuildID as an input; there is no read-only mode to schedule.
- unity-verify: a Unity project at `unity/` and a licence for the swamp-serve user; the host's Unity
  editor is licensed per user, and a seat is activated with a person's Unity ID.
- fmod-build and wwise-generate: FMOD Studio's command line and Wwise's authoring app with WAAPI,
  which run on Windows and macOS, not on a Linux host.

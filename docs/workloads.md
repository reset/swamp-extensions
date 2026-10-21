# Workloads: the flight and the path relied on

Each workflow here is a flight of a studio workload. The path in the right column is the one the
studio relies on; the flight runs beside it, writes its records, and is compared. Switching what is
relied on is a change to this table and to which schedule people read, never a change inside SMK,
which calls nothing here. Where SMK has no path yet, the flight is not relied on either: the work
is done by hand until the SMK verb exists, and the flight is the specification for that verb.

| Workflow          | Behavior               | Relied on                                                               |
| ----------------- | ---------------------- | ----------------------------------------------------------------------- |
| crash-backlog     | `@reset/rollbar`       | the `crash` CLI and the crash-triage skill against crashq               |
| crash-trend       | `@reset/rollbar`       | the `crash` CLI and the crash-triage skill against crashq               |
| build-check       | `@reset/buildq`        | `smk ci`, and buildq's own commit status and build email                |
| release-readiness | `@reset/workq`         | `smk issue`, `smk patch` and the crash-triage skill against workq       |
| merge-gate        | `@reset/forgejo-pulls` | `smk pr merge`, which posts the marker, and automerge, which acts on it |
| social-coverage   | `@reset/socialq`       | socialq's own calendar and wrap-up report, read by a person             |
| steam-promote     | `@reset/steam`         | the steam-publish skill's procedure                                     |
| unity-verify      | `@reset/unity`         | buildq running the repository's `make ci`                               |
| godot-build       | `@reset/godot`         | buildq running the repository's `make ci` and export                    |
| fmod-build        | `@reset/fmod`          | none in SMK yet: by hand in FMOD Studio                                 |
| wwise-generate    | `@reset/wwise`         | none in SMK yet: by hand in Wwise                                       |
| host-report       | lab behaviors          | the service probe and `smk host`                                        |

> > > > > > > 59c6d34 (Add @reset/socialq, a read-only behavior over socialq's API, with the social-coverage workflow)
> > > > > > > | merge-gate | `@reset/forgejo-pulls` | `smk pr merge`, which posts the marker, and automerge, which acts on it |

Measurements the flight owes, per workload, for the retrospective: time to add the capability,
tokens per run, what the data layer changed in a diagnosis, and what left the machine.

# Setting up Swamp in a C# and Unity shop

Draft of the first feed post, from the field notes on wiki page 3716. Not submitted. Open questions before it goes anywhere: whether it goes out under Jamie's name or the collective's, and the first conversation with the Swamp team comes before it.

---

We make games in C# and Unity, and we run our own small stack of services for the studio: a tracker, CI, crash reporting. So when a new automation CLI shows up with a registry of 1,800 extensions and none of them for game development, two things happen. You want to know why, and you want to know whether the thing is any good before you write the first one. This is what the first day looked like.

## Installing

Install is a Homebrew tap. On Homebrew 7 you need one more line than the README gives you, because third-party taps now have to be trusted first:

```sh
brew tap swamp-club/tap
brew trust swamp-club/tap
brew install swamp
swamp auth login
```

Sign-in opens a browser and is one approval. Run it from a real terminal. From inside an agent harness without a TTY it falls back to a username and password prompt and fails, which cost me ten minutes before I read the help text and saw `SWAMP_API_KEY`.

## The first behavior

Swamp calls its units behaviors. A behavior is a type, written in TypeScript, plus a YAML instance that says how this one is configured. Out of the box there is exactly one type, `command/shell`, and everything else is an extension you pull from the registry or write yourself.

```sh
swamp repo init --tool none
swamp behavior create command/shell host-facts --global-arg 'run=uname -a'
swamp behavior validate host-facts
swamp behavior run host-facts execute
```

The run produced four records: the result (exit code, stdout, stderr, duration), a log, and two summary reports. Every record carries the behavior's name and type, the data type, a lifetime, a garbage-collection cap, and who ran it. That last part is the thing I came for. Our own tools print a verdict and forget it. Swamp keeps the verdict and remembers who asked.

## The first workflow, and the first friction

A workflow is a YAML DAG of behavior steps with asserts. The generated placeholder is not what the engine accepts once you edit it: `dependsOn` entries have to be objects, not strings, and the assert step's field is `expr`, not `condition`. `workflow run` tells you this clearly. `workflow validate` prints a zod stack trace instead. The vendor's skill has the correct examples, and once the shape was right, three steps with a cross-behavior assert ran in about 100 milliseconds. Twice, giving versions 2 and 3 of the same record, each tagged with the run that produced it.

## Why `--tool none`

By default `swamp repo init` configures your coding agent for you: a CLAUDE.md section, a settings file with sixty allow rules and an audit hook, and two skills written into the global `~/.claude/skills`. That last one is a global side effect of a per-repository command, and it is the kind of thing we would not do in our own tools. So we initialize with `--tool none`, copy the two skills into the one repository where Swamp runs, and nothing of Swamp's loads in a session anywhere else. The skills are good. We just want them scoped.

## What leaves the machine

Every command sends a telemetry entry to the vendor, and that is how the leaderboard works. I wanted to see one, so I blocked the network for a single command and read the spool. One entry: the command path, the argument names (which includes the behavior's name), the exit code and duration, the swamp and Deno versions, the platform, which AI tool it detected, and whether a vault or external datastore is configured. No file contents, no stdout. Fair, and I would rather it were documented than discovered. That is also why Swamp lives in one operations repository here and never in a game repository or a client's.

## What we are doing with it

Building the vertical nobody has: a Rollbar-compatible crash-reporting behavior first (it works against Rollbar and against our own service with one host change), then Steam publishing, then Wwise and Unity. And building the same primitives into our own stack, from the outside in, because the fastest way to understand why a record has provenance is to need it and not have it.

More as it happens.

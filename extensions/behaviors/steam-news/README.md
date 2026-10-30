# @reset/steam-news

A Swamp behavior for a Steam app's news feed, with two pairs of methods. `news`
lists the newest posts and `find` checks whether a post naming some text, such
as a release's version, went out since a date: the check a studio makes after
promoting a build, that its patch notes announcement is live on the store.
`fetch` records the newest posts over time, flagging the ones that are new since
the last read, and `list` filters what was recorded (patch notes, one feed, one
tag, a window). Every method writes what it read as a versioned resource, so a
workflow can assert on it with CEL.

It talks to the documented Steam Web API only:
[`ISteamNews/GetNewsForApp`](https://partner.steamgames.com/doc/webapi/ISteamNews)
v2, which is public and needs no key, or `GetNewsForAppAuthed` v2 when a
publisher key is given, which also answers for an app that is not released yet.
The key travels in the documented `x-webapi-key` header, never in the URL.

| Method  | What it does                                                                          | Writes                       |
| ------- | ------------------------------------------------------------------------------------- | ---------------------------- |
| `news`  | Lists the app's newest posts, optionally only some feeds and only before a time       | `posts`, `posts`             |
| `find`  | Checks whether a post naming a text was published since a time                        | `find`, `find`               |
| `fetch` | Reads the app's newest posts and records them as a new version, flagging the new ones | `news`, `app-<appId>`        |
| `list`  | Reads every recorded version back and lists the posts matching a filter, newest first | `listing`, `listing-<appId>` |

The Writes column names the resource and the instance name it is written under.

## Install and set up

```sh
swamp extension pull @reset/steam-news

# One behavior instance per app. 440 is Team Fortress 2; use any public app id.
swamp behavior create @reset/steam-news tf2-news --global-arg appId=440
```

For an app that is not released yet, put a Steamworks publisher key in a vault
and reference it. `swamp vault put` reads the value from stdin or a hidden
prompt, so it never reaches your shell history:

```sh
pbpaste | swamp vault put default steam-web-api-key
swamp behavior create @reset/steam-news my-game --global-arg appId=480 \
  --global-arg 'webApiKey=${{ vault.get(default, steam-web-api-key) }}'
```

| Argument    | Default  | Meaning                                                                                    |
| ----------- | -------- | ------------------------------------------------------------------------------------------ |
| `appId`     | required | The Steam AppID whose news is read.                                                        |
| `webApiKey` | none     | Publisher key, sensitive. Every method then calls GetNewsForAppAuthed on the partner host. |

The app id is the number in the app's store address: Team Fortress 2 is
`store.steampowered.com/app/440/`, so its id is 440.

## A release's announcement: `news` and `find`

```sh
swamp behavior run my-game news --input count=10 \
  --input 'feeds:json=["steam_community_announcements"]'
swamp behavior run my-game find --input text=1.4.2 \
  --input since=2026-10-21T00:00:00Z \
  --input 'feeds:json=["steam_community_announcements"]'
```

| Method | Arguments                                                                                           |
| ------ | --------------------------------------------------------------------------------------------------- |
| `news` | `count` (20, at most 100), `feeds`, `before`, `maxLength` (300), `includeContents`, `includeAuthor` |
| `find` | `text`, `since`, `feeds`, `searchContents`, `caseSensitive`                                         |

`news` keeps each post's id, title, link, date, feed name and label, and tags.
Its `truncated` is true when the feed holds more posts than were read.

`find` reads 100 posts at a time, newest first, and pages back with `enddate`
until it sees a post older than `since` or the feed runs out, at most ten pages
(1,000 posts). It writes `found`, `matchCount`, the matches (id, title, link,
date, feed, and whether the text was in the title), how many posts in the window
it searched, and `complete`. `complete: false` means the window could not be
searched back to `since`, so `found: false` covers only the posts searched; a
workflow that must be sure should assert on both.

A feed name is applied twice: in the request, and again to the answer, because
the Web API ignores a feed name it does not know and answers with every feed.
`news` logs a warning when that happens, since it usually means a misspelled
feed. The announcements a developer posts are in
`steam_community_announcements`.

```yaml
jobs:
  - name: announced
    steps:
      - name: find
        task:
          type: behavior
          behavior: my-game
          methodName: find
          inputs:
            text: ${{ inputs.version }}
            since: ${{ inputs.since }}
            feeds:
              - steam_community_announcements
      - name: posted
        dependsOn:
          - step: find
            condition:
              type: succeeded
        task:
          type: assert
          expr: data.latest("my-game", "find").attributes.found
          message: no announcement names ${{ inputs.version }}
          severity: high
```

A refused answer throws a `SteamNewsError` with the HTTP status. Steam answers
403 with an empty body for an AppID that is unknown or has no public news, and
for a publisher key that does not own the app; the message says so. An answer
without `appnews.newsitems`, one that is not JSON, and one with a post that
lacks its id or date are refused too, since `find` decides from those whether
its window is covered. A request that never got an answer, or took longer than
15 seconds, throws with status 0 and the network's message. Nothing is written
before a method fails.

## The history: `fetch` and `list`

```sh
# Record the newest 10 posts at full length. Run it as often as you like.
swamp behavior run tf2-news fetch

# Read more posts, or cut each body to 300 characters to keep records small.
swamp behavior run tf2-news fetch --input count=50 --input maxLength=300

# List every recorded post, or only the patch notes, one feed, one tag or a window.
swamp behavior run tf2-news list
swamp behavior run tf2-news list --input patchNotesOnly=true --input limit=5
swamp behavior run tf2-news list --input feedName=steam_community_announcements
swamp behavior run tf2-news list --input since=2026-10-01T00:00:00Z
```

`count` is 1 to 100 (10 when omitted). `maxLength` 0, the default, keeps each
post's contents whole. `includeAuthor` keeps each post's author. `since` is a
UTC ISO-8601 time ending in `Z`. Each `fetch` run adds a version to the same
record, so the history is the record's versions, kept for 365 days.

Each post in a `news` version carries `isNew`: true when the previous recorded
version did not hold its gid, Steam's stable id for the post. The version also
holds `newCount` and `newGids`, so a workflow can act on new posts alone:

```sh
swamp data query 'modelName == "tf2-news" && name == "app-440"' \
  --select '{"new": attributes.newCount, "gids": attributes.newGids}'
```

On the first `fetch` there is no previous version, so every post is new. Only
the previous version is compared, so a post that drops out of the `count` newest
and later returns to the window (when `count` is raised, say) is flagged new
again.

`list` takes the distinct posts across every recorded version (a post read in
several versions is taken from the latest), applies the filters and writes:

```json
{
  "appId": 440,
  "filter": {
    "patchNotesOnly": true,
    "feedName": null,
    "tag": null,
    "since": null,
    "limit": 5
  },
  "recordedPosts": 12,
  "matched": 2,
  "byFeed": { "Community Announcements": 2 },
  "newestAt": "2026-10-16T19:38:40.000Z",
  "oldestAt": "2026-10-09T18:02:11.000Z",
  "posts": [
    {
      "gid": "1846651706682902",
      "title": "Team Fortress 2 Update Released",
      "url": "https://store.steampowered.com/news/...",
      "feedName": "steam_community_announcements",
      "feedLabel": "Community Announcements",
      "publishedAt": "2026-10-16T19:38:40.000Z",
      "tags": ["patchnotes"],
      "isPatchNotes": true
    }
  ],
  "listedAt": "2026-10-22T12:00:00.000Z"
}
```

`matched` and `byFeed` count every match; `posts` is cut to `limit`. A filter
that matches nothing still writes a listing, with `matched` 0. A workflow reads
it with `data.latest("tf2-news", "listing-440")`.

A post is patch notes when Steam tags it `patchnotes`. For Team Fortress 2 the
tag is on the community announcement of each update, while Steam's own
`steam_updates` feed ("Product Update") carries the same update untagged; use
`feedName=steam_updates` to list that feed. Other feeds are external blogs and
news sites Steam aggregates for the app; `byFeed` shows which ones an app has.

`fetch` writes nothing when Steam does not answer with news, and says why: HTTP
400 to 499 (other than 429) as Steam refusing the request, naming the app id;
HTTP 429 as a rate limit, with Steam's `Retry-After` when it sends one; HTTP 500
and above as a transient failure; a body that is not the documented `appnews`
shape, with its start; and a request longer than 15 seconds. `list` fails when
no news of the app has been recorded, and skips, with a warning, any stored
record that is not news of the instance's app. Both need swamp's `queryData`,
present in current swamp releases.

Most apps post a few times a week at most, so fetching once an hour catches a
patch within the hour and once a day is enough for a digest.

## What the resources keep

Each post holds what Steam publishes for anyone to read. A post's author is the
Steam account name of the person who wrote it, so `news` and `fetch` keep it
only with `includeAuthor`; `news` versions that `fetch` recorded before
2026.10.30.1 hold it always. `news` keeps bodies only with `includeContents`,
and `find` reads full bodies with `searchContents` to search them but keeps
none. No player data is requested, received or stored. `posts` and `find` keep
20 versions, `listing` 10, and `news` versions expire after 365 days.

## Changes

- 2026.10.30.1: one extension again. Up to 2026.10.21.1 it offered `news` and
  `find`; 2026.10.22.1 and 2026.10.22.2 replaced them with `fetch` and `list`.
  This version carries all four, and its upgrade leaves an instance made on
  either line as written. `news` now writes the `posts` resource, since `news`
  holds what `fetch` records. `fetch` keeps authors only with `includeAuthor`
  and calls GetNewsForAppAuthed when `webApiKey` is set; `news` and `find`
  abandon a request after 15 seconds, as `fetch` does. Moved to
  <https://github.com/reset/swamp-extensions>, now its published home.
- 2026.10.22.2: the registry now shows every argument's description, which it
  showed empty before; `list`'s `since` argument, missing from the registry's
  list before, is listed.
- 2026.10.22.1: `fetch` with new-post flags, and `list` with patch-note, feed,
  tag, time and limit filters.
- 2026.10.21.1: `news` and `find`.

## License

MIT, see LICENSE.

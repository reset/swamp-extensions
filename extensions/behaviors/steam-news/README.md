# @reset/steam-news

A Swamp behavior for a Steam app's news feed. It lists the newest posts, and it
checks whether a post naming some text, such as a release's version, went out
since a date. That second check is the one a studio makes after promoting a
build: is the patch notes announcement live on the store? Every method writes
what it read as a versioned resource, so a workflow can assert on it with CEL.

It talks to the documented Steam Web API only:
[`ISteamNews/GetNewsForApp`](https://partner.steamgames.com/doc/webapi/ISteamNews)
v2, which is public and needs no key, or `GetNewsForAppAuthed` v2 when a
publisher key is given, which also answers for an app that is not released yet.
The key travels in the documented `x-webapi-key` header, never in the URL.

## Install

```sh
swamp extension pull @reset/steam-news
```

## Set up a behavior instance

For a released app, the AppID is all it needs:

```sh
swamp behavior create @reset/steam-news my-game --global-arg appId=480
```

For an app that is not released yet, put a Steamworks publisher key in a vault
and reference it. `swamp vault put` reads the value from stdin or a hidden
prompt, so it never reaches your shell history:

```sh
pbpaste | swamp vault put default steam-web-api-key
swamp behavior create @reset/steam-news my-game --global-arg appId=480 \
  --global-arg 'webApiKey=${{ vault.get(default, steam-web-api-key) }}'
```

| Argument    | Default  | Meaning                                                                    |
| ----------- | -------- | -------------------------------------------------------------------------- |
| `appId`     | required | The Steam AppID whose news is read.                                        |
| `webApiKey` | none     | Publisher key, sensitive. Switches to GetNewsForAppAuthed on partner host. |

## Methods

```sh
swamp behavior run my-game news --input count=10 \
  --input 'feeds:json=["steam_community_announcements"]'
swamp behavior run my-game find --input text=1.4.2 \
  --input since=2026-10-21T00:00:00Z \
  --input 'feeds:json=["steam_community_announcements"]'
```

| Method | Arguments                                                                                           | Writes |
| ------ | --------------------------------------------------------------------------------------------------- | ------ |
| `news` | `count` (20, at most 100), `feeds`, `before`, `maxLength` (300), `includeContents`, `includeAuthor` | `news` |
| `find` | `text`, `since`, `feeds`, `searchContents`, `caseSensitive`                                         | `find` |

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

## Check a release's announcement from a workflow

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

## Errors

A refused answer throws a `SteamNewsError` with the HTTP status. Steam answers
403 with an empty body for an AppID that is unknown or has no public news, and
for a publisher key that does not own the app; the message says so. An answer
without `appnews.newsitems`, one that is not JSON, and one with a post that
lacks its id or date are refused too, since `find` decides from those whether
its window is covered. A request that never got an answer throws with status 0
and the network's message. Nothing is written before a method fails.

## What the resources keep

A post's author is the Steam account name of the person who wrote it, so it is
kept only with `includeAuthor`. Bodies are kept only with `includeContents`;
`find` reads full bodies with `searchContents` to search them but keeps none.
Both resources keep 20 versions.

## License

MIT, see LICENSE.

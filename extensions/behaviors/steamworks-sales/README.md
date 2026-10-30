# @reset/steamworks-sales

Record a Steam partner's sales from Swamp, one day at a time, as Valve's partner
financials Web API reports them. `sample` asks Valve which sales days changed
since the last run and records each one as aggregates per app, country, currency
and line item type; `summarise` turns the recorded days into totals per app and
country, a daily series and a trend.

| Method      | What it does                                                                                   | Writes                                                |
| ----------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `sample`    | Reads the days changed since the stored highwatermark and records each day's aggregates        | `sales`, `sales-<YYYY-MM-DD>`, and `cursor`, `cursor` |
| `summarise` | Reads the latest version of every recorded day in a range and records totals, series and trend | `summary`, `summary`                                  |

Each changed day is a new version of its `sales-<YYYY-MM-DD>` record, so a day
Valve recalculates keeps its history. `sales` and `summary` keep their last 10
versions per day and summary, `cursor` its last 30.

## The data is financial

The records hold your sales figures. Keep the instance in a swamp repository
whose datastore is private, and do not push its data anywhere public. Only
aggregates are written: Valve's rows carry partner, package, bundle, discount,
key request and platform detail, and none of it is recorded or logged. Logs name
dates and counts of rows and aggregates, never an amount.

## Endpoints

Two documented methods of `IPartnerFinancialsService` are called, both `GET` on
`https://partner.steam-api.com`, the host Valve requires for publisher keys:

- `GetChangedDatesForPartner/v001/` with `highwatermark` (0 on the first run,
  then the stored `result_highwatermark`) and, when asked,
  `include_view_grants`. It answers the dates with new or recalculated data, in
  Pacific Time.
- `GetDetailedSales/v001/` with `date`, exactly as the first method listed it,
  and `highwatermark_id`. Each date starts at 0, and each answer's `max_id` is
  sent back as the next `highwatermark_id` until `max_id` equals the id sent,
  which is how Valve marks the last page.

Valve's documentation, read on 2026-10-22:

- [IPartnerFinancialsService](https://partner.steamgames.com/doc/webapi/IPartnerFinancialsService):
  the methods, their parameters, the response fields and the paging rules.
- [Web API overview](https://partner.steamgames.com/doc/webapi_overview): the
  partner host, that it takes HTTPS only, and that requests answered 403 "will
  incur strict rate limits for the connecting IP".
- [Authentication using Web API keys](https://partner.steamgames.com/doc/webapi_overview/auth):
  a key may be sent as the `x-webapi-key` request header.

`GetAppWishlistReporting`, on the same interface, is not called.

## Rate limits

Valve publishes no numeric rate limit for these methods. This extension makes
one request at a time and waits one second between requests, its own choice. A
403 stops the run at once and is never retried, because Valve rate-limits the
calling IP strictly after one. A 429 is reported with `Retry-After` when Valve
sends it. Valve refreshes sales data at least once a day, so a daily run is
enough.

## Install and set up

```sh
swamp extension pull @reset/steamworks-sales
```

The key must come from a Financial API Group: in Steamworks, Users &
Permissions, Manage Groups, create a group with financial permissions and create
its Web API key. Valve documents that such a group has no users or apps, that
its key covers every app of the partner, and recommends restricting the key to
your server's IP addresses. Put the key in a vault. `swamp vault put` reads the
value from stdin or a hidden prompt, so it never reaches your shell history:

```sh
pbpaste | swamp vault put default steamworks-financial-key

swamp behavior create @reset/steamworks-sales steam-sales \
  --global-arg 'financialKey=${{ vault.get(default, steamworks-financial-key) }}'
```

The key is a sensitive global argument, so swamp refuses a literal. It is sent
only as the `x-webapi-key` header and only to `https://partner.steam-api.com`.
It is never part of a URL, never written to a record, never logged, and is
replaced by `[redacted]` should it appear in an error.

`includeViewGrants=true` also records sales other partners have granted this
partner a view of; it is false when omitted.

## Sample

```sh
swamp behavior run steam-sales sample

# The first run lists every day since sales began; record them 31 at a time.
swamp behavior run steam-sales sample --input maxDates=31
```

`maxDates` is 1 to 366 and 31 when omitted. Days beyond it are kept in the
cursor and recorded first next run, oldest first, so repeated runs work through
a long history. `maxPages` (1 to 1000, 100 when omitted) caps the
`GetDetailedSales` pages read for one day; a day with more fails the run and
records nothing for that day. The highwatermark advances only when a run
finishes, so a failed run repeats its days next time, as new versions.

A day's record:

```json
{
  "date": "2026-10-20",
  "steamDate": "2026/10/20",
  "fetchedAt": "2026-10-23T12:00:00.000Z",
  "highwatermark": "1841518117865",
  "includeViewGrants": false,
  "pages": 2,
  "rows": 3,
  "totals": {
    "grossUnitsSold": 12,
    "grossUnitsReturned": -2,
    "netUnitsSold": 10,
    "unitsActivated": 10,
    "grossSalesUsd": "321.7001",
    "grossReturnsUsd": "-25.5322",
    "netTaxUsd": "26.0431",
    "netSalesUsd": "270.1248"
  },
  "aggregates": [
    {
      "appid": 999,
      "appName": "Example Game",
      "countryCode": "AE",
      "currency": null,
      "lineItemType": "Package",
      "totals": {
        "grossUnitsSold": 0,
        "grossUnitsReturned": 0,
        "netUnitsSold": 0,
        "unitsActivated": 10,
        "grossSalesUsd": "0.0000",
        "grossReturnsUsd": "0.0000",
        "netTaxUsd": "0.0000",
        "netSalesUsd": "0.0000"
      }
    },
    {
      "appid": 999,
      "appName": "Example Game",
      "countryCode": "AU",
      "currency": "AUD",
      "lineItemType": "Package",
      "totals": {
        "grossUnitsSold": 10,
        "grossUnitsReturned": -2,
        "netUnitsSold": 8,
        "unitsActivated": 0,
        "grossSalesUsd": "311.7201",
        "grossReturnsUsd": "-25.5322",
        "netTaxUsd": "26.0431",
        "netSalesUsd": "260.1448"
      }
    },
    {
      "appid": 999,
      "appName": "Example Game",
      "countryCode": "US",
      "currency": "USD",
      "lineItemType": "MicroTxn",
      "totals": {
        "grossUnitsSold": 2,
        "grossUnitsReturned": 0,
        "netUnitsSold": 2,
        "unitsActivated": 0,
        "grossSalesUsd": "9.9800",
        "grossReturnsUsd": "0.0000",
        "netTaxUsd": "0.0000",
        "netSalesUsd": "9.9800"
      }
    }
  ]
}
```

The figures are made up. `date` is the Pacific Time sales day; `steamDate` is
the same day as Valve wrote it. Amounts are USD as Valve reports them, decimal
strings to four places added exactly, never floating point; Valve does not
report local-currency totals, and `currency` names the transaction currency the
USD figures were converted from. Returns are negative, as Valve reports them,
and net sales are gross sales plus returns less tax. A `Package` line item is a
Steam sale or a retail key activation (`unitsActivated`, with no currency); a
`MicroTxn` is an in-game purchase, whose units are items. A sale counts toward
its `appid`, or for a package that has none, its primary app; `appid` 0 holds
sales Valve attributes to neither, which Valve asks partners to fix through a
support ticket.

The cursor:

```json
{
  "highwatermark": "1841518117865",
  "previousHighwatermark": "1841518110000",
  "fetchedAt": "2026-10-23T12:00:00.000Z",
  "recordedDates": ["2026-10-20"],
  "pendingDates": []
}
```

A cursor that no longer parses stops `sample` rather than starting again from
highwatermark 0. To start over on purpose, delete the cursor's data.

## Summarise

```sh
swamp behavior run steam-sales summarise
swamp behavior run steam-sales summarise --input from=2026-10-01 --input to=2026-10-31
```

`from` and `to` are Pacific Time days, YYYY-MM-DD, inclusive; each is open when
omitted. Every recorded day in the range counts once, from its latest version.
The summary holds the days covered, totals split into `package` and `microTxn`
with their combined `netSalesUsd`, a `trend` comparing the earlier half of the
recorded days with the later half, and per app, largest net sales first, the
same totals and trend, per-country totals and a daily series:

```json
{
  "from": "2026-10-01",
  "to": "2026-10-31",
  "days": 2,
  "firstDate": "2026-10-20",
  "lastDate": "2026-10-21",
  "package": { "netUnitsSold": 15, "netSalesUsd": "410.0000", "...": "..." },
  "microTxn": { "netUnitsSold": 4, "netSalesUsd": "19.9600", "...": "..." },
  "netSalesUsd": "429.9600",
  "trend": {
    "earlierDays": 1,
    "laterDays": 1,
    "earlierNetSalesUsd": "270.1248",
    "laterNetSalesUsd": "159.8352",
    "changeNetSalesUsd": "-110.2896",
    "earlierNetUnitsSold": 8,
    "laterNetUnitsSold": 7,
    "changeNetUnitsSold": -1
  },
  "apps": [
    {
      "appid": 999,
      "appName": "Example Game",
      "package": { "...": "..." },
      "microTxn": { "...": "..." },
      "netSalesUsd": "429.9600",
      "trend": { "...": "..." },
      "countries": [
        {
          "countryCode": "AU",
          "currencies": ["AUD"],
          "package": { "...": "..." },
          "microTxn": { "...": "..." },
          "netSalesUsd": "400.0000"
        }
      ],
      "daily": [
        { "date": "2026-10-20", "netUnitsSold": 8, "netSalesUsd": "270.1248" },
        { "date": "2026-10-21", "netUnitsSold": 7, "netSalesUsd": "159.8352" }
      ]
    }
  ],
  "countries": [{ "countryCode": "AU", "...": "..." }],
  "summarisedAt": "2026-10-23T12:00:05.000Z"
}
```

`...` stands for the totals fields shown under Sample. Daily and trend units
count `Package` units only, so items bought in game do not inflate copies sold;
net sales add both. A day with no recorded sales is absent, not zero, so the
trend halves are halves of the recorded days. A workflow reads the summary with
`data.latest("steam-sales", "summary")`.

## Errors

`sample` writes nothing for a day Valve does not answer in full, and says why:

- HTTP 403: the key is not a financial key, is revoked, or the IP is not on the
  key's allow list. Not retried.
- HTTP 429, with `Retry-After` when sent; HTTP 500 and above as a transient
  failure; HTTP 400 as rejected parameters.
- A body that is not JSON, or not the documented shape, is reported by the
  fields that differ, never with the body's values.
- A day with more pages than `maxPages`, or a `max_id` that goes backwards.
- A request that takes longer than 15 seconds is abandoned.

`summarise` fails when no day is recorded in the range, and skips with a warning
any stored record that is not a recorded day.

## What has been verified

The tests use fixtures built from the response shapes and examples in Valve's
reference, with made-up figures. As of this release the extension has never run
against Valve's API with a real key: the `x-webapi-key` header on the partner
host, the numeric fields Valve writes as strings, and the last page's contents
are read from the documentation, not observed.

## Removing an instance

`swamp behavior delete steam-sales --yes` removes the instance. Its records are
versions in the repository's datastore and expire with their retention; delete
them sooner with swamp's data commands if the sales history should not outlive
the instance. Remove the key with
`swamp vault delete default steamworks-financial-key` and revoke it in
Steamworks.

## Changes

- 2026.10.30.1: moved to <https://github.com/reset/swamp-extensions>, now its
  published home, with an upgrade that leaves existing instances' arguments as
  they are. Requests now refuse a redirect, so the key header cannot follow one
  to another host, as in @reset/steamworks-builds and @reset/steamworks-wishlists.
- 2026.10.23.1: first release, `sample` and `summarise`.

## License

MIT, see LICENSE.

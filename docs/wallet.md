# Wallet

The Wallet is the page in the sidebar that says what your rooms spend. It
reads the local usage ledger (`~/.exxperts/app/usage.jsonl`), so it works
offline and shows nothing to anyone else.

## What it shows

Three figures at the top:

- **Covered by plans**: what subscription usage (ChatGPT, Copilot, Claude
  plans) would have cost at public list prices. You already pay for those
  plans; the number is the list value, not a bill.
- **Caching saved**: the estimated list-price saving from cache reads, over
  the turns whose model price is known, with the share of input that came
  from cache.
- **Turns**: how many model turns ran in the period.

Below them, one row per source. Gateway rows go by the name you gave the
gateway, and rooms are listed by their current name. Two quiet fold-up lines
keep the list honest without cluttering it: **Removed gateways** holds the
spend of gateways you have since removed, and **Retired rooms** holds
archived and deleted rooms. Open either fold to see the rows inside.

## Where gateway prices come from

A gateway turn is real money, and the Wallet books it at the rate the
gateway publishes. Those rates arrive through detection: when you add a
gateway or reload its models, the app reads the published per-model prices
along with image support, context windows and caching capability (LiteLLM's
`/model/info`, OpenRouter's `/models`). There is no field to type a price by
hand; a price typed by hand would be a guess about somebody else's billing.

Prices move, so the server re-reads every saved gateway's declarations
shortly after it starts and once a day. A gateway that cannot be reached or
rejects its key is left as it was, and a price the gateway did not answer
this time keeps its previous value.

Each turn is priced when it runs and the cost is written to the ledger with
it. Two marks cover the turns that could not be priced that way:

- **≈** (approximation sign): a turn that ran before its model had a price
  on file is priced at today's rate. The figure is an estimate and wears the
  sign.
- **no price on file**: a turn that moved tokens on a model that still has
  no price. It is shown as those words, never as $0.00, so a missing price
  cannot pass for a free turn. A LiteLLM virtual key without access to the
  model info route is the usual reason; see
  [`provider-setup.md`](provider-setup.md).

Subscription usage is estimated at public API list prices and stays under
**Covered by plans**. Memory upkeep, HiveMind answers and scheduled runs
are recorded from July 2026; earlier upkeep was never persisted and is not
included.

## Caching

**Caching saved** counts what cache reads saved against fresh input, over
the turns whose price is known. A Claude model behind a gateway that
declares prompt caching gets Anthropic cache markers on its prompt prefix
automatically, so long conversations reuse it; there is nothing to
configure, and the effect shows up in this figure.

## CSV export

The **CSV** button downloads the full turn log (`exxperts-usage.csv`), one
line per turn, newest last. Besides the tokens, `cost_est_usd` is the same
effective cost the Wallet shows and `priced_at` says where it came from:
`turn` for a cost stored when the turn ran, `today` for a read-time
estimate at the current price (the ≈ turns), and `none` for a turn nobody
could price. A spreadsheet can tell the three apart with a filter; cells
that would start with a formula character are escaped.

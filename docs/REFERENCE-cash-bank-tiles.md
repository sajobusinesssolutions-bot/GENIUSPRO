# Reference the user uploaded for Cash & Bank

A screenshot of another product ("Gonza Systems") the user wants copied *in
layout*, not in colour — our app keeps its own deep-indigo rail and dark theme.

What the reference shows:

- Page title **Finance**, with a **Refresh Data** button on the right of the
  title row.
- A row of pill tabs directly under the title: `Cash Accounts` · `Profit & Loss`
  · `Debtors/Creditors` · `Savings`. The active pill is filled.
- Under the tabs, a section header row: the section name (`Cash Accounts`) with
  a small grey chip beside it reading the aggregate (`Total: UGX 2`), and a
  primary button on the right (`+ New Cash Account`).
- Below that, a **grid of tiles**, one per account. Each tile:
  - small wallet/bank icon + account name (`Momo`) on the top line, with a
    three-dot menu at the far right of that line
  - the balance as the large number (`UGX 2`), with the caption
    `Current Balance` underneath in small grey
  - two tinted stat rows stacked: a green one `↗ Opening   UGX 2`, and a blue
    one `↘ Today's Close  UGX 2`
  - a full-width secondary button at the bottom: `Manage Account`
- Tiles are fixed-width cards in a wrapping grid, not a table.

Apply the same tile treatment to bank accounts as well as cash accounts, using
our own colour tokens (green = money in / received, amber = owed, red =
overdue — the established rule in this codebase).

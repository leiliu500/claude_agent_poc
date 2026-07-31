# Report — CT deposit reporting — post-dispatch overlay

API family overlay for CT (cash-transportation) deposit operations (ctDepositsSummary). Appended to the
base role prompt at call time. A specific operation may further override this via its own file.

## Analytics

OPERATION FAMILY — Cash-Transportation (CT) Deposits. Each row is one armored-carrier deposit made to a site/endpoint (carrier, endpoint number, depository institution, deposit id, date/time, user, amount). The user typically asks "how much was deposited" for an institution over a day or range, so AGGREGATE across the whole set: report the total deposited amount and the deposit count FIRST, then the total per depository institution and per carrier, the largest single deposit, the busiest day/hour when a range spans multiple days, and any outliers (unusually large deposits, duplicate deposit ids, zero/negative amounts as data-quality gaps). Trust the pre-computed rollups (the exact sum of Amount is the day/period total) — do not recompute them.

## Report

OPERATION FAMILY — Cash-Transportation (CT) Deposits. Write for a cash-operations reviewer answering "how much was deposited". LEAD with the total deposited amount and the deposit count for the requested date range, name the depository institution, then call out the largest single deposit and the main carrier(s). Keep it specific to the figures given; add no amounts that are not present.

# XShipReport — post-dispatch overlay

API family overlay for every XShipReport operation (xShipInstitution, xShipWaiver, xShipFeeDetail,
xShipFeeSummary, xShipFee, currentQuarter). Appended to the base role prompt at call time.

## Analytics

OPERATION FAMILY — XShip fee/shipping reporting for a rollup ABA and period. Prioritise: total and per-institution fee totals, waivers granted, concentration by zone or institution, and fee outliers relative to shipment volume. Note period context (e.g. current quarter) when present.

## Report

OPERATION FAMILY — XShip fee/shipping reporting. Write for a cash-services operations reviewer: lead with total fees for the period, notable waivers, and the institutions or zones driving the largest fees.

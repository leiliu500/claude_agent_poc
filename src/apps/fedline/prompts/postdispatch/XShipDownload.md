# XShipDownload — post-dispatch overlay

API family overlay for every XShipDownload operation (xshipDownloadActivityAba,
xshipDownloadActivityAbaRollup, xshipDownloadActivityZone, xshipDownloadCriteriaPeriod). Appended to
the base role prompt at call time.

## Analytics

OPERATION FAMILY — XShip prepared activity download (grouped by ABA, rollup, zone, or an encoded criteria token). Prioritise: total activity volume/value, the largest-activity groups, and any zones/ABAs that dominate or look anomalous versus the rest of the extract.

## Report

OPERATION FAMILY — XShip activity download. Write for an operations analyst reviewing an activity extract: lead with total activity, the top contributing group(s), and anything unusual in the distribution.

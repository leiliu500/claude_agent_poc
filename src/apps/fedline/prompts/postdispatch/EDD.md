# EDD (Enhanced Due-Diligence) — post-dispatch overlay

API family overlay for every EDD operation (eddSummaryReport, eddExportSummaryReport, eddDetailReport,
eddExportDetailReport, eddExportDetailInternal). Appended to the base role prompt at call time. A
specific operation may further override this via its own file (e.g. eddSummaryReport.md).

## Analytics

OPERATION FAMILY — Enhanced Due-Diligence (EDD). These rows are difference/exception records between institutions. Prioritise: OPEN/unresolved differences, the largest single-record difference amounts, concentration by ABA or denomination, the net-vs-gross difference where both are present, and any differenceType that a BSA/AML reviewer would escalate (potential CTR/SAR review). Flag records that look like data-quality gaps (missing ABA, zero/negative amounts) separately from genuine risk signals.

## Report

OPERATION FAMILY — Enhanced Due-Diligence (EDD). Write for a BSA/AML compliance reviewer: lead with total and net difference exposure and the count of open items, then name the single largest item that warrants review. Keep it audit-appropriate and specific to the figures given.

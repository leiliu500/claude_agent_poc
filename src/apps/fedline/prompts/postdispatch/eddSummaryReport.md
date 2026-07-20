# eddSummaryReport — operation-specific overlay

Overrides the EDD family overlay for the `eddSummaryReport` operation only. Only the sections present
here override the family; unspecified roles fall back to EDD.md.

## Analytics

OPERATION — EDD SUMMARY: one row per institution/report candidate. Identify the summary row(s) a reviewer would drill into (largest or most anomalous difference), since an EDD detail report is keyed off a selected summary record (reportId = `${eddLoadID}_${ncdwRecordID}`).

# Download control lifecycle

[download.mmd](download.mmd) models the producer permission and the visible
control. `reports/share.js` confirms `can_download === true` after its bracketed
feedback reads. `showUnavailable` retires the control. The setter returned by
`mountTourClientDownload` owns visibility, disabled state, and request generation.
A retired generation cannot create a download or announce success after an await.

The model abstracts feedback reads, PDF body acquisition, and context checks into
outcome transitions. It does not model CARR authorization, storage, or deadlines.
The proof browser tests execute allowed, denied, and unavailable controls at 1440
and 390 in both themes. Download unit tests execute context refusal, late refusal,
and late successful body completion. The PR description maps each transition to
its test.

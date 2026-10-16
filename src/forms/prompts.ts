export function formTask(
  url: string,
  runs: number,
  instructions = "",
  runIndex = 1,
) {
  return `Run ${runIndex} of ${runs}. Complete only this one registration.
Navigate to ${url}, including its query parameters, then fill and submit the form exactly once.
Generate plausible, varied data for this run and discover the fields and steps from the browser.
Verify each submission using the visible confirmation. Capture any reference/ID verbatim, or report that none is shown.
Stop and report a blocker if a submission fails or its outcome is uncertain; do not submit it again.
Additional instructions: ${instructions || "None."}
The application handles any remaining runs. Do not start another registration, even if earlier runs are mentioned.
When finished, call the prowl_submit_report tool once, alone in its turn, with:
- "status": "confirmed" only after observing a visible success confirmation; otherwise "blocked" or "uncertain".
- "summary": entered fields and observed outcome or blocker, as a nonblank string.
- "evidence": literal visible confirmation text, required for "confirmed". Never invent confirmation evidence.
- "reference": the exact reference/ID if shown; omit this field if none is shown.`;
}

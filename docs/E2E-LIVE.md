# Live-model acceptance harness

This acceptance run uses a separate DSH profile, agent sessions, workspaces and `DSH_AGENTS_HOME`. It references the user's existing credential provider file without copying its secrets. It does not edit the user's profile, read another project or run repository scripts. Early retained attempts predate the separate agents-home setting and discovered user-global skill headers through the host default; those unrelated skills were not loaded. The report retains this boundary.

The first run is limited to one repository-inventory task. Run the remaining two tasks only after inspecting the first result. A run is accepted only when every required stage has evidence:

1. A real configured model recognizes the request and selects the matching catalog entry.
2. Real model review approves the complete final skill directory, producing current audit evidence.
3. The real host agent loads the installed skill through the `skill` tool.
4. The agent invokes the corresponding fixed `dsh_file_task` operation through the actual tool dispatcher and runtime policy.
5. Independent checks compare the generated artifact with the sealed fixture expectations.
6. The main agent turn ends normally and produces its final response within the explicit test budget.

The tasks are repository inventory, source TODO/FIXME/XXX reporting, and one explicit JavaScript edit followed by syntax checking. JavaScript syntax checking is not a unit-test run.

The external driver submits the task after the installation step. This checks a controlled installation-and-continuation flow; it does not establish that the UI automatically pauses and resumes an arbitrary chat turn. Successful model calls, request identifiers when available, usage and tool receipts must be observed rather than synthesized. Unit tests of fixture validation do not count as live-model acceptance.

`fixtures/e2e/expectations.json` is the independent source of expected file identities, marker locations and the requested source edit. Test outputs and request metadata belong under `../test-artifacts/usability-2026-11-16`, outside the repository. Credentials and raw authorization headers must never be logged or copied there.

On this Windows host with the shipped Harness installation, run the first task explicitly:

```powershell
node scripts/e2e-live.mjs --live --workspace-write
```

After examining the first result, `--remaining` runs TODO and JavaScript, while `--javascript-only` runs one fresh JavaScript task with a 16-stream ceiling. Each main-agent turn has a four-minute deadline. These flags grant write access only to the new isolated fixture workspace. `node --test test/e2e-artifacts.test.js` tests the validator with synthetic metadata; it does not call a model.

For read-only browser inspection after a run, use `node scripts/e2e-ui.mjs <absolute-run-directory>`. This starts the existing isolated profile, creates fresh empty test agents and blocks inference through a zero-call test budget. The local browser access URL is saved to `ui-access.json`, never printed in the console; stop the owned process with Ctrl-C. Existing user profiles are untouched. For an explicit, zero-inference reassessment of persisted genuine host events after a parser correction, `e2e-recover.mjs <absolute-run-directory>` writes separate recovered files and preserves the original assessment.

The bridge passes through the real `llm/stream` iterator, recording provider/model, stage, timestamps, numeric token usage and finish reasons. Local trace IDs are correlation IDs, not provider request IDs. Successful provider request IDs are recorded only if exposed by the host or a response-header observation; otherwise their availability is explicitly `not-exposed-by-host`. Session receipts use the host's actual JSON-string arguments and `message.toolCallId`. A correct artifact does not count as complete acceptance if the agent turn ended in an error or exhausted the test budget. Tool refusals and extra attempted operations remain in the report even when the task later succeeds.

## Local observation, 2026-11-16

On Windows with Harness 0.2.1-rc.5 and the existing `deepseek-official / deepseek-flash` route, all three controlled fixture workflows completed. Successful attempts used 8 / 9 / 10 actual model streams and about 22.3 / 24.1 / 21.2 seconds respectively, measured from the first analysis request through the final main-agent response. These are small fixture observations, not latency guarantees or a general success rate.

The first JavaScript attempt made the exact edit and syntax report but exhausted the test budget before final dialogue completion; it remains a failed attempt. A fresh classification then spent its 400-token allowance entirely on reasoning and stopped with no answer. After adding one bounded same-model retry for explicit `max-tokens` results, the final new-session attempt exercised that retry and completed the full workflow without tool refusals. Unsupported tool attempts in earlier successful tasks remain in the evidence. All attempts together produced 44 observed requests with real usage metadata.

Early profiles isolated `DSH_HOME` but the host also discovered user-global `.agents` skill headers. These unrelated skills were not loaded. The final attempt additionally isolates `DSH_AGENTS_HOME`. Original credential-file bytes stayed unchanged and the user's profile was not edited. Owned test hosts were stopped after verification.

Local evidence is saved outside the repository under `../test-artifacts/usability-2026-11-16/live-e2e-report.{json,md}`, with original failed assessments and corrected assessments kept separately. The browser check covered fresh-session selection, explicit read-only protection, ready prerequisites, actual compatibility displays and the light-theme layout; it made no inference requests. Automated checks under Windows Node 22.23.5 and 24.19.0 each ran 274 tests: 269 passed, zero failed and five platform-dependent cases were skipped.

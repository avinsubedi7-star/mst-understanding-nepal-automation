# My Second Teacher automation

This is a local, visible-browser Playwright runner for the **Understanding Nepal: Society, History, and Governance** interactive lessons. It lets each video play normally, detects in-video and end-of-lesson quizzes, extracts Nepali question text and choices, captures visual questions, handles results, and advances through the subject catalogue.

The project makes **no OpenAI API calls**. It has no API key, `.env`, OpenAI SDK, or separately billed API dependency. Automatic quiz reasoning uses the locally installed `codex exec` command authenticated through your existing ChatGPT/Codex sign-in. Accepted answers are cached locally so identical questions can be reused. A separately configured compatible local CLI can also be used through the opt-in `generic-cli` provider.

It does **not** seek videos, fake watch time, patch browser visibility APIs, modify site JavaScript, forge network requests, or write backend data directly. It is an independent project and is not affiliated with or endorsed by My Second Teacher, OpenAI, Anthropic, or another provider mentioned here.

## Responsible use

You are responsible for having permission to automate the platform you use, following applicable institution/platform rules, terms, and laws, protecting your account/session data, and reviewing the terms of any AI provider you configure. This project intentionally does not fake watch time, forge completion requests, patch visibility APIs, or manipulate backend progress directly.

## Requirements

- Node.js 20 or newer
- Google Chrome
- A My Second Teacher account authorized for this work
- Codex CLI signed in with ChatGPT (`codex login status` should report `Logged in using ChatGPT`)
- A dedicated desktop/session where the Chrome window can remain visible and focused

## Installation

```powershell
npm install
```

Install the standalone Codex CLI with OpenAI's official Windows installer if `codex --version` is unavailable:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
```

Then open a new PowerShell window and verify `codex login status`. The VS Code extension's bundled executable is intentionally not treated as a standalone CLI installation by automatic discovery.

Google Chrome is used through Playwright's installed `chrome` channel. If Chrome is not installed, install it normally before starting.

## First login and start

Before the first run, set `MST_START_URL` to an authorized lesson URL for the target subject. The repository deliberately does not include a real course, unit, or video URL:

```powershell
$env:MST_START_URL = "https://app.mysecondteacher.com.np/subjects/<subject-id>/chapters/<chapter-id>/topics/<topic-id>/videos/<video-id>"
```

Then run:

```powershell
npm start
```

Before Chrome opens, the runner resolves the standalone Codex executable to an absolute path, verifies ChatGPT authentication, and performs one tiny structured-output smoke test with the configured model and reasoning effort. A failed CLI, login, model, or output check stops immediately without launching Playwright or starting a lesson.

A visible Chrome window opens with a persistent profile stored in `mst-profile/`. On the first run, log in normally in that window and complete any CAPTCHA/MFA. The runner waits without continuing into lesson navigation and automatically resumes when authenticated content is detected. It waits indefinitely by default, so you do not need to rush or press Enter. If the website permits session persistence, later runs reuse that login and skip this wait.

Keep the Chrome window visible and focused. The website may legitimately pause playback when focus is lost; the runner does not bypass that behavior.

## Answering quizzes

When a quiz appears, the runner extracts the question and choices and invokes `codex exec` with GPT-5.6 Sol at medium reasoning by default. Text questions are sent as structured text. Visual questions attach the cropped quiz screenshot directly to the Codex run. No question or screenshot is sent through an API key or the OpenAI Node SDK.

The provider returns a structured answer, confidence, and reason. Routine questions receive up to two GPT-5.6 Sol medium-reasoning attempts. Only if both remain unsafe does the runner make one Sol high-reasoning escalation. If that result is also unsafe, the runner leaves the quiz untouched, saves diagnostics, and keeps Chrome open. The configured confidence threshold is unchanged throughout.

If the answer is wrong, the runner clicks the normal Retry control, remembers that choice, marks it as known-wrong in the next prompt, and will not accept the same choice again. Answers confirmed by a per-question correct signal are stored in `data/answers.json` and may be reused for identical questions. End-quiz Next navigation alone is not treated as proof of correctness.

## What it automates

- Uses the configured lesson URL only as an authentication/catalogue anchor.
- Opens the target subject and dynamically selects the first unit below 100% and its first `N/A` video.
- Reads video state (`currentTime`, `duration`, `paused`, `ended`) without changing playback time.
- Detects visible `[role="single"]` options and Submit/Next Question controls.
- Extracts DOM question text and answer choices.
- Detects images, SVGs, canvases, figures, CSS background visuals, and incomplete text.
- Captures only the active quiz panel for visual questions.
- Handles in-lesson Continue/Retry overlays.
- Handles ten-question end-of-lesson sequences, their completion dialog, and the next incomplete lesson.
- Avoids replaying adjacent videos whose visible status is already complete.
- Writes readable logs to `logs/` and diagnostics to `screenshots/`.

## Answer-provider architecture

The browser workflow depends only on the `AnswerProvider` interface in `src/answer-provider.ts`. An implementation receives:

- extracted question text and options;
- indexes already known to be wrong;
- an optional local screenshot path for a visual question.
- compact lesson/unit context when available.

It returns a zero-based answer index, matching label, exact answer text, confidence, reason, and source. The core validates the index, label, and normalized DOM option text against one another before clicking.

The default `CodexCliAnswerProvider` runs the official Codex CLI in ephemeral, read-only mode. The CLI owns its ChatGPT-managed authentication; the project never reads or copies credentials. `ManualAnswerProvider` remains available only as an optional debug fallback by setting `MST_ANSWER_PROVIDER=manual`.

## AI answer providers

The browser, quiz, and course code depend only on `AnswerProvider`. Providers expose capability metadata and return the same strict answer object. The answer index, label, and text are always validated against the rendered choices before Playwright clicks anything.

| Provider/tool | Status | Runtime use |
|---|---|---|
| Codex CLI | **Tested** | Native `codex` provider; text, vision, strict schema output, unattended execution, and ChatGPT-managed login are tested by this project. |
| Generic CLI | **Expected compatible** | For a user-configured CLI that reads stdin and prints one strict answer JSON object. Vision requires explicit image arguments and `GENERIC_CLI_SUPPORTS_VISION=true`. |
| Claude Code | **Experimental via generic CLI** | Official print mode and JSON Schema are available, but this repository has not verified headless local-image attachment or subscription-plan suitability for unattended runtime use. |
| OpenCode | **Experimental via generic CLI** | Non-interactive execution and file attachment are documented; provider login, strict answer-schema behavior, and configuration must be validated locally. |
| Antigravity CLI | **Experimental via generic CLI** | Headless JSON output and cached account authentication are documented; image input and strict answer-schema support are not verified here. |
| Cline | **Setup-agent only by default** | Headless JSON output exists, but this repository has not verified a safe visual attachment and subscription-only unattended runtime contract. |
| Hermes Agent | **Experimental via generic CLI** | Non-interactive queries and `--image` are documented; strict answer-schema output and Windows support must be validated locally. |

No CLI is bundled, installed, redistributed, or authenticated by this repository. Each user is responsible for that CLI's license, account plan, usage limits, and terms. Do not assume that a web/IDE subscription permits unattended runtime automation; verify the provider's current terms before configuring it.

For an AI coding agent helping install this repository, see [docs/AI_SETUP_PROMPT.md](docs/AI_SETUP_PROMPT.md). That setup agent is separate from the CLI used at runtime to answer quizzes.

### Generic CLI configuration

`generic-cli` never executes a shell string. It starts exactly one executable with JSON-configured argument arrays (`shell: false`), writes the provider-neutral prompt to stdin, enforces a timeout, and strictly parses the final stdout JSON answer.

Set these process environment variables for a CLI that supports that contract:

```powershell
$env:MST_ANSWER_PROVIDER = "generic-cli"
$env:GENERIC_CLI_COMMAND = "C:\\path with spaces\\agent-cli.exe"
$env:GENERIC_CLI_ARGS_JSON = '["run", "--output", "json", "--model", "{model}"]'
$env:GENERIC_CLI_MODEL = "your-local-agent-model"
$env:GENERIC_CLI_TIMEOUT_MS = "180000"
```

For a **verified** vision-capable CLI, add a separate image argument template. The screenshot path is substituted only for the complete `"{imagePath}"` element—never through shell interpolation:

```powershell
$env:GENERIC_CLI_SUPPORTS_VISION = "true"
$env:GENERIC_CLI_IMAGE_ARGS_JSON = '["--image", "{imagePath}"]'
```

The generic CLI must print exactly one answer JSON object such as:

```json
{"answerIndex":1,"answerLabel":"B","answerText":"...","confidence":0.9,"reason":"short reason","source":"provider"}
```

If a visual question appears with a text-only generic provider, the automation pauses without clicking. Selecting `generic-cli` runs its own small text smoke test before Chrome starts. It does not check, invoke, or require Codex.

## Runtime configuration

No configuration file is required. `MST_START_URL` must be set before a public-release checkout can discover a subject catalogue. The remaining process environment variables are non-secret runtime settings:

- `MST_START_URL`
- `MST_SUBJECT_NAME`
- `MST_DISCOVER_FROM_CATALOGUE` (`true` or `false`)
- `MST_BROWSER_CHANNEL`
- `MST_ANSWER_PROVIDER` (`codex` by default; `generic-cli` for a configured compatible local CLI; `manual` for terminal debug mode)
- `CODEX_CLI_PATH` (optional absolute standalone CLI path override)
- `MST_CODEX_MODEL` (`gpt-5.6-sol` by default)
- `MST_CODEX_REASONING` (`medium` by default)
- `MST_CODEX_TIMEOUT_MS` (`180000` by default)
- `GENERIC_CLI_COMMAND` (required for `generic-cli`; executable name or path, not a shell command)
- `GENERIC_CLI_ARGS_JSON` (JSON string array of base arguments; prompt is always sent over stdin)
- `GENERIC_CLI_IMAGE_ARGS_JSON` (JSON string array, used only for visual questions; must contain `"{imagePath}"` when vision is enabled)
- `GENERIC_CLI_SUPPORTS_VISION` (`true` only after verifying that CLI accepts the configured image argument)
- `GENERIC_CLI_MODEL` and `GENERIC_CLI_REASONING` (optional values substituted only by exact `"{model}"` / `"{reasoning}"` argument elements)
- `GENERIC_CLI_TIMEOUT_MS` (`180000` by default)
- `MST_MIN_ANSWER_CONFIDENCE` (`0.65` by default)
- `MST_AUTH_TIMEOUT_MINUTES` (default `0`, meaning wait indefinitely)
- `MST_POLL_INTERVAL_MS`
- `MST_RESULT_TIMEOUT_MS`
- `MST_SESSION_TIMEOUT_MINUTES`
- `LOG_LEVEL` (`debug`, `info`, `warn`, or `error`)

For example:

```powershell
$env:LOG_LEVEL = "debug"
npm start
```

## Stopping safely

Press `Ctrl+C` once in the terminal. The browser context closes and the persistent profile remains for the next run. At an answer prompt, `Q` also stops without submitting an answer.

## Validation

```powershell
npm run check
```

This runs TypeScript checking, ESLint, and unit tests.

## Development and testing

Contributions use only local unit/mocked tests. CI never launches Chrome, contacts My Second Teacher, requires provider login, or runs live provider calls. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Troubleshooting

- **Login is requested every run:** ensure `mst-profile/` is writable and no other Chrome process is using that profile.
- **Login cannot complete:** the runner leaves Chrome open while it waits. If an initial authentication error occurs, it saves diagnostics and also leaves Chrome open until you close it or press `Ctrl+C`.
- **Chrome executable is missing:** install Google Chrome, or set `MST_BROWSER_CHANNEL` to another Playwright-supported installed channel.
- **Codex CLI is not found:** install the standalone CLI or set `CODEX_CLI_PATH` to its absolute `.exe`/`.cmd` path. The resolver ignores automatically discovered VS Code extension bundles.
- **Codex is not authenticated:** run `codex login` and choose **Sign in with ChatGPT**.
- **A visual question remains low confidence:** the runner leaves the quiz untouched and reports the saved screenshot path.
- **Unexpected page state:** inspect the newest paired `.png` and `.txt` files in `screenshots/`. The runner stops instead of clicking an unknown control.
- **Video keeps pausing:** keep the dedicated Chrome window visible and focused. No focus or visibility spoofing is implemented.
- **No next lesson is found:** set `MST_START_URL` through the process environment to an authorized lesson URL for the desired subject, then confirm the visible catalogue status.

## Safety, privacy, and limitations

`mst-profile/`, `logs/`, `screenshots/`, `data/`, diagnostics, and provider/session state are ignored by Git. Never share a browser profile, diagnostic file, or account-specific HTML without reviewing it for personal information. See [SECURITY.md](SECURITY.md) for reporting and credential-rotation guidance.

The project depends on rendered UI state and may need maintenance when the website changes. Generic CLI support is a strict compatibility contract, not a claim that every coding agent is suitable for unattended or visual answering. The automation pauses instead of guessing when a provider cannot safely handle a question.

## License

This project is available under the [MIT License](LICENSE).

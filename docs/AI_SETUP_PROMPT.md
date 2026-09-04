# AI-agent-assisted setup prompt

Copy this prompt into the coding agent you are using to help set up this repository. The agent helping with setup is not automatically the runtime answer provider.

```text
Inspect this repository before changing anything. Set it up as a local, visible-browser Playwright automation project.

First determine whether a compatible local runtime answer provider is already installed and authenticated. The runtime choice is separate from the agent helping with setup. A compatible runtime provider must read a prompt from stdin, return one strict JSON answer object on stdout, and, for visual questions, accept a configured local image-path argument.

Do not assume that the coding agent assisting with setup can be used as the runtime provider. Do not install a provider or create an API key unless I explicitly ask for that provider and billing model.

Steps:
1. Read README.md, package.json, src/config.ts, and the provider documentation in the repository.
2. Install project dependencies only after asking for permission if your environment requires it.
3. Do not add API keys, SDK credentials, `.env` secrets, or another paid API dependency unless I explicitly choose that billing model. Prefer an already-installed compatible local provider and document any manual login required.
4. If configuring generic-cli, require an executable path/name and JSON argument arrays. Never put a shell command string, credentials, or tokens in repository files. Confirm the CLI reads prompts from stdin and emits the required JSON answer object. Set vision support only if the CLI has a verified local-image argument.
5. Run npm run check. Explain that a selected runtime provider may perform a small smoke preflight during normal startup; do not run it against a completed/live course unless I explicitly permit that validation.
6. Explain that the user must complete any provider login, MFA, CAPTCHA, or subscription activation manually before running unattended automation.
7. Do not fake watch time, seek videos, bypass visibility/focus controls, alter course backend APIs, or submit answers outside the real rendered browser UI.
8. Do not open, replay, or submit already-completed course content merely for testing. Use unit tests and mocks unless the user explicitly authorizes a live run.
9. Never ask the user to commit credentials. Tell the user the exact command to start the runner and any remaining manual login action.
```

## Runtime-provider contract

The runtime answer provider is separate from the setup agent. A compatible generic CLI must:

- run non-interactively as a Node child process;
- receive the full provider-neutral prompt on stdin;
- return one JSON object on stdout with `answerIndex`, `answerLabel`, `answerText`, `confidence`, `reason`, and `source: "provider"`;
- exit non-zero on failure;
- accept a local image-path argument if configured with vision support.

The automation validates the returned JSON against the visible answer choices before clicking. A provider that cannot satisfy this contract is setup-agent-only, not a runtime provider.

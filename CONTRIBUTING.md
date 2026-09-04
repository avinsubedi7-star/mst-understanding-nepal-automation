# Contributing

Install dependencies with `npm ci`, then run:

```powershell
npm run typecheck
npm run lint
npm test
```

Use only mocked or sanitized fixtures. Do not commit real course content, screenshots, browser profiles, tokens, logs, or account HTML.

Provider contributions must preserve the `AnswerProvider` abstraction, use safe executable/argument-array invocation, and label support accurately as tested, experimental, or unsupported. Do not add paid API dependencies or credentials unless explicitly scoped and documented.

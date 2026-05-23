# ChatE security scanner pipeline

Run:

```bash
./scripts/security_scan.sh
```

What it does:

1. Python syntax check.
2. Frontend JavaScript syntax check.
3. Backend pytest regression tests.
4. Bandit security lint if installed.
5. pip-audit dependency vulnerability check if installed.
6. Semgrep static analysis if installed.
7. npm audit if a package lock exists.
8. Reminder to test ZIP integrity.

This is a quality gate, not a magic security guarantee. It catches common regressions and obvious dangerous patterns. It does not prove the crypto design is flawless.

Optional tools:

```bash
pip install pytest bandit pip-audit semgrep
npm i -D @playwright/test
npx playwright install chromium
```

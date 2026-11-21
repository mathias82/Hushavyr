# Verified fix → GitHub draft PR

After **Hushavyr: Propose and Verify Local Fix** succeeds, click **Create draft PR** in the notification. You can also run **Hushavyr: Create Draft PR from Verified Local Fix** from the Command Palette and pick a `receipt.json`.

Hushavyr then:
1. Checks the proof: status `verified`, the regression test failed before the fix (red), the test and the full suite pass after it (green, suite), and the patch matches its SHA-256.
2. Stops if the patch adds something that looks like a credential.
3. Checks that your checkout is clean and still on the verified commit.
4. Applies the patch in a temporary worktree (your checkout is never touched) and opens the full diff, including the new test.
5. Asks you. Only then it creates a `hushavyr/verified-fix-…` branch, pushes it and opens a **draft** PR against the default branch with the test results. If `gh` is missing, you get a GitHub link instead. Nothing is merged automatically.

Requirements: a trusted local window with the repository root open, `git`, and the `gh` CLI logged in (optional). No AI model is used in this step; the code goes only to your own git remote. Never publish private code to a public repository.

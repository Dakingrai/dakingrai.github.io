# autobench

This is an experiment to have the LLM autonomously optimize the speed of this website.

## Setup

To set up a new experiment, work with the user to:

1. **Agree on a run tag**: propose a tag based on today's date (e.g. `mar5`). The branch `autobench/<tag>` must not already exist — this is a fresh run.
2. **Create the branch**: `git checkout -b autobench/<tag>` from current main.
3. **Read the in-scope files**: The repo is small. Read these files for full context:
   - `README.md` — repository context.
   - `bench/benchmark.js` — fixed benchmark harness. Trial count, dwell window, metric collection, the URL paths under test. Do not modify (only the `BENCH_BASE_URL` env var is meant to vary).
   - `_config.yml`, `_layouts/`, `assets/`, `index.md`, `blog.html`, `post.html` — the site source. These are what you modify.
4. **Verify dependencies are installed**: Check that `node_modules/puppeteer` and `node_modules/web-vitals` exist. If not, tell the human to run `npm install`. Also verify `bundle exec jekyll serve` works — if there is no `Gemfile`, tell the human to add one with `jekyll` as a dependency before continuing.
5. **Initialize results.tsv**: Create `results.tsv` with just the header row. The baseline will be recorded after the first run.
6. **Confirm and go**: Confirm setup looks good.

Once you get confirmation, kick off the experimentation.

## Experimentation

Each experiment runs the full benchmark against a **local Jekyll server** at `http://localhost:4000` — 10 cold-cache trials per page across the homepage and two representative blog posts. The harness takes ~95 seconds wall clock. You launch it as:

```
BENCH_BASE_URL=http://localhost:4000 npm run bench
```

Before the first experiment, start Jekyll once in the background and leave it running for the entire session:

```
bundle exec jekyll serve --host 127.0.0.1 --port 4000 --incremental > jekyll.log 2>&1 &
```

Jekyll's `--incremental` mode rebuilds changed files automatically, so after every edit you just give it a moment and re-run the bench — no push, no deploy, no waiting on GitHub Pages. This keeps experiments fast and means bad iterations never go live to real visitors.

**What you CAN do:**
- Modify any site source: layouts, partials, CSS, JS, images, fonts, `_config.yml`, blog post frontmatter, `index.md`. Everything that ships to the user is fair game — inline critical CSS, defer scripts, swap font loading strategy, compress/resize images, drop unused dependencies, restructure the DOM, etc.

**What you CANNOT do:**
- Modify `bench/benchmark.js`. It is read-only. It defines the URL paths under test, trial count, cache policy, and the web-vitals listeners — these are the ground-truth measurement. The only knob is the `BENCH_BASE_URL` env var.
- Install new build tooling or change the deploy target. The site is plain Jekyll on GitHub Pages; keep it that way.
- Change the URL paths being benchmarked. The three pages in `URLS` are the fixed test set.

**The goal is simple: get the lowest p95 total load time on the homepage.** Load p95 is the headline metric. (LCP would have been preferred, but the current harness can't reliably measure homepage LCP — its early click for INP pre-empts the LCP-eligible window. Until the harness is changed, load p95 is the optimization target.) You are also tracked on LCP, CLS, and INP for the blog posts, and a regression on any of those (especially CLS > 0.1 or INP > 200ms) disqualifies the experiment even if load improved. Within those guardrails, everything is fair game.

**Local vs production caveat**: TTFB measured against `localhost` is not comparable to TTFB measured against GitHub's CDN — it will be artificially low and dominated by Jekyll's dev server, not by anything you can actually optimize. Use TTFB as a sanity check, not a primary signal. LCP, load, CLS, and INP all transfer cleanly from local to prod.

**Page weight** is a soft constraint. Some increase is acceptable for meaningful LCP gains, but the total transferred bytes for the homepage should not balloon.

**Simplicity criterion**: All else being equal, simpler is better. A small improvement that adds ugly complexity is not worth it. Conversely, removing something and getting equal or better results is a great outcome — that's a simplification win. When evaluating whether to keep a change, weigh the complexity cost against the improvement magnitude. A 5ms LCP improvement that adds 50 lines of inline boilerplate? Probably not worth it. A 5ms improvement from deleting a stylesheet? Definitely keep. An improvement of ~0 but much simpler markup? Keep.

**The first run**: Your very first run should always be to establish the baseline, so you will run the benchmark against the unmodified site — no source changes.

## Output format

Once the script finishes it prints a summary like this:

```
Summary (median / p95):
url               TTFB           LOAD            LCP            CLS            INP
home          60ms / 78ms   228ms / 333ms        n/a    0.011 / 0.011   32ms / 214ms
emergence     61ms / 75ms   213ms / 349ms  204ms / 359ms  0.000 / 0.000  64ms / 77ms
welcome       57ms / 78ms   207ms / 237ms  200ms / 215ms  0.000 / 0.000  60ms / 72ms
```

Per-trial rows are appended to `bench/results.jsonl`. You can extract the headline metric from the log file:

```
grep "^home" run.log
```

## Logging results

When an experiment is done, log it to `results.tsv` (tab-separated, NOT comma-separated — commas break in descriptions).

The TSV has a header row and 5 columns:

```
commit	home_lcp_p95_ms	home_load_p95_ms	status	description
```

1. git commit hash (short, 7 chars)
2. homepage p95 LCP in ms (e.g. 412) — use 0 for crashes or when LCP could not be measured
3. homepage p95 total load time in ms (e.g. 333) — use 0 for crashes
4. status: `keep`, `discard`, or `crash`
5. short text description of what this experiment tried

Example:

```
commit	home_lcp_p95_ms	home_load_p95_ms	status	description
a1b2c3d	412	333	keep	baseline
b2c3d4e	298	310	keep	inline critical CSS, defer style.css
c3d4e5f	405	340	discard	preload Merriweather woff2 (no measurable win)
d4e5f6g	0	0	crash	removed _layouts/default.html (404 on all pages)
```

## The experiment loop

The experiment runs on a dedicated branch (e.g. `autobench/mar5`). The Jekyll dev server stays running in the background for the whole session.

LOOP FOREVER:

1. Look at the git state: the current branch/commit we're on
2. Hack the site source with an experimental idea — edit layouts, CSS, JS, images, etc.
3. git commit (local-only — do NOT push to main; that would deploy a half-tested change to real visitors)
4. Wait briefly (~2s) for Jekyll's `--incremental` rebuild to finish. If you suspect the rebuild stalled, check `jekyll.log` and re-touch the file.
5. Run the experiment: `BENCH_BASE_URL=http://localhost:4000 npm run bench > run.log 2>&1` (redirect everything — do NOT use tee or let output flood your context)
6. Read out the results: `grep "^home\|^emergence\|^welcome" run.log`
7. If the grep output is empty, the run crashed or Jekyll failed to rebuild. Run `tail -n 50 run.log` and `tail -n 30 jekyll.log` to read the error and attempt a fix. If you can't get things to work after more than a few attempts, give up.
8. Record the results in the tsv (NOTE: do not commit the results.tsv file, leave it untracked by git)
9. If homepage p95 LCP improved (lower) and no other metric regressed past its guardrail, you "advance" the branch, keeping the git commit
10. If LCP is equal or worse, or any guardrail tripped, `git reset --hard HEAD~1` back to the prior commit (safe — these commits were never pushed)

The idea is that you are a completely autonomous performance engineer trying things out. If they work, keep. If they don't, discard. And you're advancing the branch so that you can iterate. If you feel like you're getting stuck in some way, you can rewind but you should probably do this very very sparingly (if ever).

When the human is ready to ship a winning streak of changes, they will manually merge `autobench/<tag>` into `main`. You do not push.

**Timeout**: Each experiment should take ~2 minutes total (~95s of bench + a few seconds of editing/rebuild). If a run exceeds 5 minutes, kill it and treat it as a failure (discard and revert).

**Crashes**: If a run crashes (broken HTML, missing asset, Jekyll build error, or etc.), use your judgment: If it's something dumb and easy to fix (e.g. a typo, a forgotten closing tag — Jekyll's log will say), fix it and re-run. If the idea itself is fundamentally broken, just skip it, log "crash" as the status in the tsv, and revert.

**Variance**: Even on localhost there is jitter from Chrome startup and JS execution. Treat improvements smaller than ~10ms on LCP p95 as noise unless you can reproduce them across two consecutive runs. When in doubt, re-run before keeping or discarding.

**NEVER STOP**: Once the experiment loop has begun (after the initial setup), do NOT pause to ask the human if you should continue. Do NOT ask "should I keep going?" or "is this a good stopping point?". The human might be asleep, or gone from a computer and expects you to continue working *indefinitely* until you are manually stopped. You are autonomous. If you run out of ideas, think harder — read web.dev performance guides, re-read the in-scope files for new angles, try combining previous near-misses, try more radical changes (rip out a stylesheet, swap a font, restructure the hero). The loop runs until the human interrupts you, period.

As an example use case, a user might leave you running while they sleep. If each experiment takes you ~2 minutes then you can run approx 30/hour, for a total of about 240 over the duration of the average human sleep. The user then wakes up to a faster website (locally validated, ready for them to merge), all optimized by you while they slept!

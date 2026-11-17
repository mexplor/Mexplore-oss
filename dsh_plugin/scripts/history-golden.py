"""Generate the parity goldens for the JS history import from the Python reference implementation.

The reference is a Python `history_import/convert.py` + `redaction.py` implementation (set MEXPLOR_SHADOW to that
checkout). This script writes SYNTHETIC Claude Code session files (no real conversation text) under
test/fixtures/history/projects/, a synthetic env file, and test/fixtures/history/golden.json with the
units and redaction results the Python code produces for them. test/history.test.js checks that the JS
port produces exactly the same.

    MEXPLOR_SHADOW=/path/to/reference uv run dsh_plugin/scripts/history-golden.py
"""

import datetime as dt
import json
import os
import shutil
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.expanduser(os.environ["MEXPLOR_SHADOW"]))

from history_import import convert  # noqa: E402
from history_import.redaction import Redactor, load_env_files  # noqa: E402

HERE = Path(__file__).resolve().parent.parent / "test" / "fixtures" / "history"
TZ = ZoneInfo("Asia/Shanghai")
UTC = dt.timezone.utc
HOME = "/Users/someone"


def stamp(local):
    return dt.datetime.fromisoformat(local).replace(tzinfo=TZ).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


class Session:
    def __init__(self, sid, cwd, entrypoint="cli"):
        self.sid, self.cwd, self.entrypoint, self.lines, self.n = sid, cwd, entrypoint, [], 0

    def base(self, kind, when, uuid=None, **extra):
        self.n += 1
        d = {"type": kind, "uuid": uuid or f"{self.sid}-{self.n:03d}", "timestamp": stamp(when), "sessionId": self.sid, "cwd": self.cwd,
             "entrypoint": self.entrypoint, "isSidechain": False}
        d.update(extra)
        self.lines.append(d)
        return d

    def user(self, when, text, **extra):
        return self.base("user", when, message={"role": "user", "content": text}, **extra)

    def blocks(self, when, blocks, **extra):
        return self.base("user", when, message={"role": "user", "content": blocks}, **extra)

    def tool_result(self, when):
        return self.blocks(when, [{"type": "tool_result", "tool_use_id": "t", "content": "listing"}])

    def assistant(self, when, text, msg_id=None, tool=False):
        b = [{"type": "thinking", "thinking": "hidden thought"}, {"type": "text", "text": text}]
        if tool:
            b.append({"type": "tool_use", "id": "t", "name": "Bash", "input": {"command": "ls"}})
        return self.base("assistant", when, message={"id": msg_id or f"m-{self.n}", "role": "assistant", "content": b})

    def write(self, root, project):
        d = root / project
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{self.sid}.jsonl").write_text("".join(json.dumps(x, ensure_ascii=False) + "\n" for x in self.lines) + "not json\n")
        return d


def words(tag, n):
    return " ".join(f"{tag}{i}" for i in range(n))


def build(root):
    work = "-Users-someone-Code-repo"
    s1 = Session("s1", f"{HOME}/Code/repo")
    s1.user("2026-06-01 09:00:00", "Plan the deploy for the api service; " + words("w", 60))
    s1.assistant("2026-06-01 09:00:05", "Let me check.", msg_id="a1")
    s1.tool_result("2026-06-01 09:00:06")
    s1.assistant("2026-06-01 09:00:09", "We deploy staging from dev first. " + words("x", 80), msg_id="a2")
    s1.user("2026-06-01 09:10:00", "<system-reminder>ignore me</system-reminder>Use key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV and password=hunter2 please; call 13812345678")
    s1.assistant("2026-06-01 09:10:30", "Stored notes in /Users/someone/Code/repo/docs/DeployPlan_2026-06-01.md commit 0123456789abcdef0123456789abcdef01234567 " + words("y", 40))
    s1.user("2026-06-01 09:12:00", "<command-name>/clear</command-name>")
    s1.user("2026-06-01 09:13:00", "<command-name>/review</command-name><command-args>the deploy plan</command-args>")
    s1.assistant("2026-06-01 09:13:20", "Reviewed: " + words("r", 30))
    s1.user("2026-06-01 09:14:00", "skill text", isMeta=True)
    s1.user("2026-06-01 09:15:00", "summary of earlier", isCompactSummary=True)
    s1.user("2026-06-01 09:16:00", "<task-notification>bg done</task-notification>")
    s1.user("2026-06-01 09:17:00", "notified", origin={"kind": "task-notification"})
    s1.blocks("2026-06-01 09:18:00", [{"type": "text", "text": "看一下这张图 中文内容和 emoji 😀🚀 " + words("中", 40)}, {"type": "image", "source": {}}])
    s1.assistant("2026-06-01 09:18:40", "图里是部署拓扑。 " + words("图", 50))
    # idle gap -> second segment the same day
    s1.user("2026-06-01 14:00:00", "Afternoon: " + "z" * 5000)
    s1.assistant("2026-06-01 14:00:30", "Long answer " + "q" * 3000)
    # next day
    s1.user("2026-06-02 10:00:00", "short")
    s1.assistant("2026-06-02 10:00:05", "ok")
    s1.write(root, work)

    # resumed session copies earlier entries (dedupe by uuid), then continues
    s2 = Session("s2", f"{HOME}/Code/repo")
    s2.lines = [dict(x) for x in s1.lines[:4]]
    s2.n = 100
    s2.user("2026-06-03 11:00:00", "Resume the deploy work: " + words("d", 50))
    s2.assistant("2026-06-03 11:00:20", "Resumed. " + words("e", 40))
    s2.write(root, work)

    # many short turns -> split by evidence limit (config maxEvidence small)
    s3 = Session("s3", f"{HOME}/Code/repo/.claude/worktrees/fix-1")
    for i in range(14):
        s3.user(f"2026-06-04 08:{i:02d}:00", f"step {i} " + words("s", 20))
        s3.assistant(f"2026-06-04 08:{i:02d}:30", f"done {i} " + words("t", 20))
    s3.write(root, work + "--claude-worktrees-fix-1")

    # home folder, a short segment carried forward and one dropped at day end
    s4 = Session("s4", HOME)
    s4.user("2026-06-05 20:00:00", "hi")
    s4.assistant("2026-06-05 20:00:01", "hello")
    s4.user("2026-06-05 23:00:00", "Book a hotel for the trip; " + words("h", 50))
    s4.assistant("2026-06-05 23:00:10", "Here are options. " + words("o", 50))
    s4.user("2026-06-06 08:00:00", "thanks")
    s4.assistant("2026-06-06 08:00:01", "np")
    s4.write(root, "-Users-someone")

    # a private headless project and a subagent transcript (excluded)
    s5 = Session("s5", "/private/tmp/x")
    s5.user("2026-06-07 09:00:00", "probe " + words("p", 60))
    s5.assistant("2026-06-07 09:00:10", "probed " + words("p", 60))
    s5.write(root, "-private-tmp-x")
    sub = root / work / "s1" / "subagents"
    sub.mkdir(parents=True, exist_ok=True)
    (sub / "agent-1.jsonl").write_text(json.dumps({"type": "user", "uuid": "sub-1", "timestamp": stamp("2026-06-01 09:00:00"), "message": {"role": "user", "content": "child"}}) + "\n")

    # still open at `now`
    s6 = Session("s6", f"{HOME}/Code/repo")
    s6.user("2026-06-08 23:30:00", "late night work " + words("n", 60))
    s6.assistant("2026-06-08 23:30:20", "noted " + words("n", 60))
    s6.write(root, work)


REDACTION_CASES = [
    "token sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV end",
    "export OPENAI_API_KEY=abc123def456ghi",
    "密码是 Secret!2026 记住",
    "中password=xx should stay",
    "MY_SERVICE_TOKEN: synthetic-token-value-1234",
    "exact value synthetic-token-value-1234 inside text",
    "Authorization: Bearer abcdefghijklmnop.qrstuv",
    "card 4111 1111 1111 1111 and id 11010519491231002X",
    "path /Users/someone/Code/repo/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/file.md stays",
    "opaque aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hI6kL9 goes",
    "commit 0123456789abcdef0123456789abcdef01234567 stays; hex 0123456789abcdef0123456789abcdef goes",
    "url https://user:pa55word@example.com/x and jwt eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl",
    "phone +1 415 555 2671, 010-12345678, version 1.2.3 and date 20260601 10:00",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE KEY-----",
    "aws key AKIAIOSFODNN7EXAMPLE and session ASIAJEXAMPLEXEXAMPLE in config",
    "gitlab glpat-abcdefghijklmnopqrst1 token",
    "run mysql -h db -uroot -pS3cret! mydb and mysqldump -u x -p'quoted pw' y; mysql -p prompt",
    "the password is hunter22 but the password is required stays; passphrase was 'open sesame 9'",
    "Authorization: Token abcdef123456 and authorization=\"token 0123456789abcdef\"",
    "scheme run aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa+https://u:p4ss@host/x and git+ssh://me:pw@h",
    "escape \"a\\\"b\" quoted and password=\"x\\",
]


def main():
    projects = HERE / "projects"
    if projects.exists():
        shutil.rmtree(projects)
    projects.mkdir(parents=True)
    build(projects)
    env_file = HERE / "synthetic.env"
    env_file.write_text("MY_SERVICE_TOKEN: synthetic-token-value-1234\nexport OTHER_SECRET=\"another-synthetic-value\"\nDEBUG=true\n")
    now = dt.datetime.fromisoformat("2026-06-09 00:10:00").replace(tzinfo=TZ).timestamp()
    cfg = {"projects_dir": str(projects), "exclude_project_prefixes": ["-private-"], "env_files": [str(env_file)], "idle_gap_hours": 2,
           "min_unit_chars": 300, "assistant_cap": 2000, "assistant_cap_tight": 667, "user_cap": 4000, "max_evidence": 6, "run_config_budget": 60000}
    units, counts, _turns = convert.convert(cfg, now)
    names, values = load_env_files([str(env_file)])
    red = Redactor(names, values)
    golden = {
        "generated_by": "mexplor-shadow history_import/convert.py + redaction.py (scripts/history-golden.py)",
        "now_epoch": now,
        "config": {"excludeProjectPrefixes": ["-private-"], "idleGapHours": 2, "minUnitChars": 300, "assistantCap": 2000, "assistantCapTight": 667,
                   "userCap": 4000, "maxEvidence": 6, "runConfigBudget": 60000},
        "units": [{k: v for k, v in u.items() if k not in ("_closed_at",)} for u in units],
        "counts": {k: v for k, v in counts.items() if k != "session_files"},
        "redaction": [{"input": t, "output": red(t)[0], "counts": red(t)[1]} for t in REDACTION_CASES],
    }
    (HERE / "golden.json").write_text(json.dumps(golden, ensure_ascii=False, indent=1) + "\n")
    print(json.dumps({"units": len(units), "redaction_cases": len(REDACTION_CASES)}))


if __name__ == "__main__":
    main()

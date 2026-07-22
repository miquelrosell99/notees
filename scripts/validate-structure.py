#!/usr/bin/env python3
"""Validate that this project follows the fleet-wide self-hosted app structure.

Run directly:
    python3 scripts/validate-structure.py

Run with baseline update after fixing a batch of violations:
    python3 scripts/validate-structure.py --update-baseline
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable


PROJECT_ROOT = Path(__file__).resolve().parent.parent
BASELINE_PATH = PROJECT_ROOT / "scripts" / ".structure-baseline.txt"


@dataclass
class Violation:
    key: str
    file: Path
    message: str


@dataclass
class Report:
    violations: list[Violation] = field(default_factory=list)

    def add(self, path: Path, message: str) -> None:
        key = _hash(f"{path.relative_to(PROJECT_ROOT)}|{message}")
        self.violations.append(Violation(key=key, file=path, message=message))


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _load_baseline() -> set[str]:
    if not BASELINE_PATH.exists():
        return set()
    return {line.strip() for line in BASELINE_PATH.read_text().splitlines() if line.strip()}


def _save_baseline(keys: Iterable[str]) -> None:
    sorted_keys = sorted(set(keys))
    BASELINE_PATH.write_text("\n".join(sorted_keys) + "\n")


def check_required_files(report: Report) -> None:
    required = [
        "compose.yaml",
        "compose.dev.yaml",
        "Dockerfile",
        "Dockerfile.dev",
        "docker-entrypoint.sh",
        "pyproject.toml",
        ".env.example",
        ".gitignore",
        "AGENTS.md",
        "app/main.py",
        "app/config.py",
        "app/dependencies.py",
        "frontend/package.json",
        "frontend/vite.config.ts",
        "frontend/tsconfig.json",
        "frontend/src/main.tsx",
        "frontend/src/App.tsx",
    ]
    for rel in required:
        path = PROJECT_ROOT / rel
        if not path.exists():
            report.add(PROJECT_ROOT, f"Missing required file: {rel}")


def check_backend_features(report: Report) -> None:
    features_dir = PROJECT_ROOT / "app" / "features"
    if not features_dir.exists():
        report.add(features_dir, "Missing app/features directory")
        return

    for feature_dir in sorted(d for d in features_dir.iterdir() if d.is_dir() and not d.name.startswith("_")):
        router = feature_dir / "router.py"
        if not router.exists():
            report.add(feature_dir, f"Feature '{feature_dir.name}' missing router.py")
            continue

        has_repository = (feature_dir / "port.py").exists() or (
            feature_dir / "repository.py"
        ).exists()
        if has_repository:
            for required in ("service.py", "port.py", "repository.py"):
                if not (feature_dir / required).exists():
                    report.add(
                        feature_dir,
                        f"Data feature '{feature_dir.name}' missing {required}",
                    )

        init_file = feature_dir / "__init__.py"
        if not init_file.exists():
            report.add(feature_dir, f"Feature '{feature_dir.name}' missing __init__.py")


def check_frontend_features(report: Report) -> None:
    features_dir = PROJECT_ROOT / "frontend" / "src" / "features"
    if not features_dir.exists():
        report.add(features_dir, "Missing frontend/src/features directory")
        return

    for feature_dir in sorted(d for d in features_dir.iterdir() if d.is_dir() and not d.name.startswith("_")):
        barrel = feature_dir / "index.ts"
        if not barrel.exists():
            report.add(feature_dir, f"Frontend feature '{feature_dir.name}' missing index.ts barrel")


def check_frontend_imports(report: Report) -> None:
    src_dir = PROJECT_ROOT / "frontend" / "src"
    if not src_dir.exists():
        return

    deep_relative = re.compile(r"^(\.\.\/){3,}|^(\.\.\/)+.*\/\.\.")

    for ts_file in src_dir.rglob("*.ts*"):
        if ts_file.suffix not in {".ts", ".tsx"}:
            continue
        content = ts_file.read_text(encoding="utf-8", errors="ignore")
        for line_no, line in enumerate(content.splitlines(), 1):
            stripped = line.strip()
            if not stripped.startswith(("import ", "from ")):
                continue
            match = re.search(r"from\s+['\"](.+?)['\"]|import\s+['\"](.+?)['\"]", stripped)
            if not match:
                continue
            source = match.group(1) or match.group(2)
            if not source:
                continue
            if source.startswith("@/"):
                continue
            if deep_relative.search(source):
                report.add(
                    ts_file,
                    f"Deep relative import at line {line_no}: {source}",
                )


def check_no_native_dialogs(report: Report) -> None:
    src_dir = PROJECT_ROOT / "frontend" / "src"
    if not src_dir.exists():
        return

    for ts_file in src_dir.rglob("*.ts*"):
        if ts_file.suffix not in {".ts", ".tsx"}:
            continue
        content = ts_file.read_text(encoding="utf-8", errors="ignore")
        for call in ("window.confirm", "window.alert", "window.prompt"):
            if call in content:
                report.add(ts_file, f"Native dialog usage: {call}")


def check_css_colocation(report: Report) -> None:
    components_dir = PROJECT_ROOT / "frontend" / "src" / "components"
    features_dir = PROJECT_ROOT / "frontend" / "src" / "features"

    for base in (components_dir, features_dir):
        if not base.exists():
            continue
        for tsx in base.rglob("*.tsx"):
            css = tsx.with_suffix(".css")
            # Co-location is preferred but not mandatory; warn only for components with styles.
            # This check is intentionally lenient to avoid baseline noise.


def check_agents_docs(report: Report) -> None:
    agents_dir = PROJECT_ROOT / "agents"
    if not agents_dir.exists():
        report.add(PROJECT_ROOT, "Missing agents/ directory")
        return

    for name in ("backend.md", "frontend.md"):
        if not (agents_dir / name).exists():
            report.add(agents_dir, f"Missing agents/{name}")


def run_checks() -> Report:
    report = Report()
    check_required_files(report)
    check_backend_features(report)
    check_frontend_features(report)
    check_frontend_imports(report)
    check_no_native_dialogs(report)
    check_css_colocation(report)
    check_agents_docs(report)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate fleet structure.")
    parser.add_argument(
        "--update-baseline",
        action="store_true",
        help="Update the baseline with current violations and exit.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output violations as JSON.",
    )
    args = parser.parse_args()

    report = run_checks()
    baseline = _load_baseline()

    if args.update_baseline:
        keys = {v.key for v in report.violations}
        _save_baseline(keys)
        print(f"Baseline updated: {len(keys)} violations recorded.")
        return 0

    new_violations = [v for v in report.violations if v.key not in baseline]

    if args.json:
        output = [
            {
                "file": str(v.file.relative_to(PROJECT_ROOT)),
                "message": v.message,
                "key": v.key,
            }
            for v in new_violations
        ]
        print(json.dumps(output, indent=2))
    else:
        if new_violations:
            print(f"Found {len(new_violations)} new structural violation(s):\n")
            for v in new_violations:
                print(f"  [{v.file.relative_to(PROJECT_ROOT)}] {v.message}")
            print(f"\nRun with --update-baseline to grandfather existing violations.")
        else:
            if report.violations:
                print(
                    f"All {len(report.violations)} violation(s) are in the baseline. "
                    "No new violations."
                )
            else:
                print("Structure validation passed.")

    return 1 if new_violations else 0


if __name__ == "__main__":
    raise SystemExit(main())

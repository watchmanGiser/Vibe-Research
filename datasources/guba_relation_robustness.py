"""对股吧情绪与股价关系执行小样本稳健性检查。"""

from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
from pathlib import Path
from typing import Any


def pearson(xs: list[float], ys: list[float]) -> float | None:
    if len(xs) < 3 or len(set(xs)) < 2 or len(set(ys)) < 2:
        return None
    mx, my = statistics.fmean(xs), statistics.fmean(ys)
    numerator = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    denominator = math.sqrt(sum((x - mx) ** 2 for x in xs) * sum((y - my) ** 2 for y in ys))
    return numerator / denominator if denominator else None


def rank(values: list[float]) -> list[float]:
    order = sorted(range(len(values)), key=values.__getitem__)
    output = [0.0] * len(values)
    index = 0
    while index < len(order):
        end = index
        while end + 1 < len(order) and values[order[end + 1]] == values[order[index]]:
            end += 1
        average = (index + end + 2) / 2
        for pos in range(index, end + 1):
            output[order[pos]] = average
        index = end + 1
    return output


def pairs(rows: list[dict[str, Any]], x_key: str, y_key: str) -> list[tuple[float, float, str]]:
    output = []
    for row in rows:
        if row.get(x_key) in (None, "") or row.get(y_key) in (None, ""):
            continue
        output.append((float(row[x_key]), float(row[y_key]), str(row["date"])))
    return output


def summarize_relation(rows: list[dict[str, Any]], x_key: str, y_key: str) -> dict[str, Any]:
    values = pairs(rows, x_key, y_key)
    xs = [row[0] for row in values]
    ys = [row[1] for row in values]
    observed = pearson(xs, ys)
    spearman = pearson(rank(xs), rank(ys))
    loo = []
    for index, (_, _, date) in enumerate(values):
        loo_x = xs[:index] + xs[index + 1:]
        loo_y = ys[:index] + ys[index + 1:]
        value = pearson(loo_x, loo_y)
        if value is not None:
            loo.append({"excluded_date": date, "pearson": value})
    loo_values = [row["pearson"] for row in loo]
    sign = 1 if (observed or 0) > 0 else -1
    return {
        "x": x_key,
        "y": y_key,
        "n": len(values),
        "pearson": round(observed, 4) if observed is not None else None,
        "spearman": round(spearman, 4) if spearman is not None else None,
        "leave_one_out_min": round(min(loo_values), 4) if loo_values else None,
        "leave_one_out_max": round(max(loo_values), 4) if loo_values else None,
        "leave_one_out_median": round(statistics.median(loo_values), 4) if loo_values else None,
        "leave_one_out_sign_stable": bool(loo_values and all(value * sign > 0 for value in loo_values)),
        "most_influential_exclusion": max(
            loo,
            key=lambda row: abs(row["pearson"] - (observed or 0)),
            default=None,
        ),
    }


def group_contrast(rows: list[dict[str, Any]], x_key: str, y_key: str) -> dict[str, Any]:
    values = sorted(pairs(rows, x_key, y_key), key=lambda row: row[0])
    split = len(values) // 2
    low, high = values[:split], values[-split:]
    low_mean = statistics.fmean(row[1] for row in low)
    high_mean = statistics.fmean(row[1] for row in high)
    return {
        "x": x_key,
        "y": y_key,
        "low_n": len(low),
        "high_n": len(high),
        "low_mean": round(low_mean, 4),
        "high_mean": round(high_mean, 4),
        "high_minus_low": round(high_mean - low_mean, 4),
        "low_x_range": [round(low[0][0], 4), round(low[-1][0], 4)],
        "high_x_range": [round(high[0][0], 4), round(high[-1][0], 4)],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", required=True)
    args = parser.parse_args()
    out_dir = Path(args.input_dir).resolve()
    with (out_dir / "trading_day_alignment.csv").open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    for row in rows:
        row["abs_return_pct"] = abs(float(row["return_pct"]))

    relation_keys = [
        ("calendar_sentiment", "return_pct"),
        ("previous_trade_day_sentiment", "return_pct"),
        ("previous_trade_day_sentiment", "gap_pct"),
        ("preopen_sentiment", "gap_pct"),
        ("preopen_weighted_sentiment", "gap_pct"),
        ("preopen_sentiment", "return_pct"),
        ("session_sentiment", "intraday_pct"),
        ("session_weighted_sentiment", "intraday_pct"),
        ("preopen_post_count", "return_pct"),
        ("calendar_post_count", "abs_return_pct"),
    ]
    relations = [summarize_relation(rows, x, y) for x, y in relation_keys]
    contrasts = [
        group_contrast(rows, "preopen_sentiment", "gap_pct"),
        group_contrast(rows, "preopen_weighted_sentiment", "gap_pct"),
        group_contrast(rows, "preopen_sentiment", "return_pct"),
        group_contrast(rows, "calendar_sentiment", "return_pct"),
    ]
    result = {"trading_days": len(rows), "relations": relations, "median_split_contrasts": contrasts}
    (out_dir / "robustness_summary.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    with (out_dir / "robustness_leave_one_out.csv").open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(relations[0]))
        writer.writeheader()
        writer.writerows(relations)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()

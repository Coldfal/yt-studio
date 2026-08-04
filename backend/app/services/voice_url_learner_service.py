"""Voice learner service.

Phase 2 of the farm redesign. The operator pastes a competitor channel
or single video URL. The frontend uses the Claude in Chrome MCP to
open the page in a headed browser and scrape the top videos' titles +
descriptions + thumbnail URLs, then POSTs that scraped block to this
service. The service runs Claude with a "propose voice rule additions"
prompt and returns a structured diff the operator can review and
apply (one rule at a time).

We deliberately do NOT call the MCP from the backend. The MCP lives
inside the operator's Claude session, not on the server. Putting the
browser-control half on the frontend keeps the backend stateless and
testable, and the operator can see the headed browser while it runs.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from app.services.claude_cli_service import (
    claude_cli_service,
    ClaudeCliError,
    _parse_json_response,
)


logger = logging.getLogger(__name__)


async def propose_voice_rules(
    *,
    competitor_url: str,
    kind: str,  # "channel" | "video"
    scraped_titles: list[str],
    scraped_descriptions: list[str],
    current_ai_voice: str | None,
    current_example_title: str | None,
    channel_niche: str | None,
) -> dict[str, Any]:
    """Ask Claude to read the scraped competitor copy and propose voice
    rule additions for the operator's channel.

    Returns a dict shaped as::

        {
          "proposed_rule_additions": [
            {"rule_text": "...", "rationale": "..."},
            ...
          ],
          "proposed_example_titles": ["...", "...", ...],
          "proposed_keyword_pool": ["...", ...],
          "observations": "free-text summary of what the competitor does"
        }

    All proposals are advisory — the frontend renders them one at a
    time with Apply / Skip / Edit & apply controls.
    """
    if not scraped_titles and not scraped_descriptions:
        raise ValueError(
            "No scraped titles or descriptions provided — nothing to learn from."
        )

    # Build a compact reference block: top 12 titles + top 4 descriptions.
    title_block = "\n".join(f"- {t.strip()}" for t in scraped_titles[:12] if t.strip())
    desc_block = "\n\n---\n\n".join(
        d.strip()[:2000] for d in scraped_descriptions[:4] if d and d.strip()
    )

    voice_block = (current_ai_voice or "").strip() or "(none — channel has no voice rules yet)"
    example_block = (
        (current_example_title or "").strip()
        or "(no example title configured)"
    )
    niche_str = (channel_niche or "general").strip() or "general"

    system_prompt = (
        "You analyze YouTube channels to extract their style rules so a "
        "competing channel can incorporate proven patterns. You are NOT "
        "an SEO bot — you read what the competitor does and produce "
        "concrete, copy-pasteable instructions the operator can add to "
        "their own channel's voice configuration.\n\n"
        f"The operator's channel niche is: {niche_str}\n"
        f"The operator's current channel voice instructions are:\n"
        f"```\n{voice_block}\n```\n"
        f"The operator's current example title is:\n"
        f"```\n{example_block}\n```\n\n"
        "Your output is a JSON object with these keys:\n"
        '- "observations": 1-3 sentences summarising what the competitor '
        "does well that the operator could borrow. Focus on STYLE, not "
        "specific keywords (those go in proposed_keyword_pool).\n"
        '- "proposed_rule_additions": 3-5 concrete rule additions for the '
        "operator's ai_voice field. Each is {rule_text, rationale}. "
        "rule_text is what would actually be inserted; rationale is one "
        "sentence on why it helps. Skip anything that duplicates a rule "
        "already in the operator's voice above.\n"
        '- "proposed_example_titles": 2-3 example titles in the '
        "competitor's style, rewritten for the operator's niche. Use the "
        "operator's brand identity, not the competitor's. These are "
        "STARTING POINTS — the operator will edit before applying.\n"
        '- "proposed_keyword_pool": 8-15 specific keyword phrases the '
        "competitor uses across their titles that the operator could "
        "weave into future titles. Comma-separated values inside a JSON "
        "array. Pick from what's IN the scraped titles — no invention.\n\n"
        "Reply with ONLY the JSON object. No prose, no markdown fences."
    )

    user_parts: list[str] = [
        f"Competitor URL ({kind}): {competitor_url}",
        f"\n## Scraped titles ({len(scraped_titles)} total)\n{title_block}",
    ]
    if desc_block:
        user_parts.append(
            f"\n## Scraped descriptions (sample)\n{desc_block}"
        )
    user_parts.append(
        "\nReturn ONE JSON object matching the schema in the system prompt."
    )

    try:
        text = await claude_cli_service._run_cli(
            prompt="\n".join(user_parts),
            system_prompt=system_prompt,
        )
    except ClaudeCliError:
        raise

    parsed = _parse_json_response(text)
    # Normalise to defensive defaults so the frontend never has to
    # null-check the keys.
    return {
        "competitor_url": competitor_url,
        "kind": kind,
        "observations": str(parsed.get("observations") or ""),
        "proposed_rule_additions": list(parsed.get("proposed_rule_additions") or []),
        "proposed_example_titles": [
            str(t) for t in (parsed.get("proposed_example_titles") or [])
        ],
        "proposed_keyword_pool": [
            str(k) for k in (parsed.get("proposed_keyword_pool") or [])
        ],
    }

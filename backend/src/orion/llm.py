"""Model access behind one small interface, so the agents never know which provider they talk to.

    json_call(system, user, schema, smart=False) -> dict      one structured answer
    Chat(system, tools, user)                                  a tool-calling conversation, stepped by the caller

Providers: Anthropic (ORION_LLM=anthropic, the default when ANTHROPIC_API_KEY is set) and Gemini (ORION_LLM=gemini).
Models come from ORION_SMART_MODEL / ORION_FAST_MODEL.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any

from orion.config import env

PROVIDER = env("ORION_LLM") or ("anthropic" if env("ANTHROPIC_API_KEY") else "gemini" if env("GEMINI_API_KEY") else "")
DEFAULTS = {"anthropic": ("claude-haiku-5-5", "claude-haiku-5-5"), "gemini": ("gemini-3.8-flash", "gemini-3.5-flash-lite")}
_PREFIX = {"anthropic": "claude-", "gemini": "gemini-"}


def _model(var: str, i: int) -> str:
    """A configured model only counts for the provider it belongs to, so switching ORION_LLM is one change."""
    v = env(var)
    if v and v.startswith(_PREFIX.get(PROVIDER, "")):
        return v
    return DEFAULTS.get(PROVIDER, ("", ""))[i]


SMART_MODEL = _model("ORION_SMART_MODEL", 0)
FAST_MODEL = _model("ORION_FAST_MODEL", 1)
SMART_EFFORT = env("ORION_SMART_EFFORT", "low")


class LLMUnavailable(RuntimeError):
    pass


class Refused(RuntimeError):
    pass


def available() -> bool:
    return (PROVIDER == "anthropic" and bool(env("ANTHROPIC_API_KEY"))) or \
        (PROVIDER == "gemini" and bool(env("GEMINI_API_KEY")))


def info() -> dict:
    return {"provider": PROVIDER or None, "smart": SMART_MODEL, "fast": FAST_MODEL, "effort": SMART_EFFORT,
            "available": available()}


@dataclass
class Call:
    id: str
    name: str
    args: dict


@dataclass
class Step:
    text: str = ""
    thinking: str = ""
    calls: list[Call] = field(default_factory=list)
    usage: dict = field(default_factory=dict)


def json_call(system: str, user: str, schema: dict, smart: bool = False, max_tokens: int = 8000) -> dict:
    if not available():
        raise LLMUnavailable("no model API key is configured")
    if PROVIDER == "anthropic":
        return _a_json(SMART_MODEL if smart else FAST_MODEL, system, user, schema, max_tokens,
                       SMART_EFFORT if smart else "low")
    return _g_json(SMART_MODEL if smart else FAST_MODEL, system, user, schema, max_tokens)


def Chat(system: str, tools: list[dict], user: str):
    if not available():
        raise LLMUnavailable("no model API key is configured")
    return _AnthropicChat(system, tools, user) if PROVIDER == "anthropic" else _GeminiChat(system, tools, user)


# ---------------------------------------------------------------- Anthropic

_aclient = None


def _anthropic():
    global _aclient
    if _aclient is None:
        import anthropic

        _aclient = anthropic.Anthropic(max_retries=4)
    return _aclient


def _check(response) -> None:
    if response.stop_reason == "refusal":
        details = getattr(response, "stop_details", None)
        raise Refused(getattr(details, "explanation", None) or "the model declined this request")


def _a_usage(response) -> dict:
    u = response.usage
    return {"input": u.input_tokens, "output": u.output_tokens}


def _a_json(model: str, system: str, user: str, schema: dict, max_tokens: int, effort: str) -> dict:
    response = _anthropic().messages.create(
        model=model, max_tokens=max_tokens, system=system,
        messages=[{"role": "user", "content": user}],
        output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
    )
    _check(response)
    text = next(b.text for b in response.content if b.type == "text")
    return json.loads(text)


class _AnthropicChat:
    def __init__(self, system: str, tools: list[dict], user: str):
        self.system = system
        self.tools = [{"name": t["name"], "description": t["description"], "input_schema": t["schema"]} for t in tools]
        self.messages: list[dict] = [{"role": "user", "content": user}]

    def step(self) -> Step:
        response = _anthropic().messages.create(
            model=SMART_MODEL, max_tokens=16000, system=self.system, tools=self.tools, messages=self.messages,
            thinking={"type": "adaptive", "display": "summarized"}, output_config={"effort": SMART_EFFORT},
        )
        _check(response)
        self.messages.append({"role": "assistant", "content": response.content})
        return Step(text="".join(b.text for b in response.content if b.type == "text"),
                    thinking="\n".join(b.thinking for b in response.content if b.type == "thinking" and b.thinking),
                    calls=[Call(b.id, b.name, dict(b.input)) for b in response.content if b.type == "tool_use"],
                    usage=_a_usage(response))

    def respond(self, results: list[tuple[Call, str, bool]]) -> None:
        # every result for one turn goes back in one user message
        self.messages.append({"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": c.id, "content": out, "is_error": err} for c, out, err in results]})

    def say(self, text: str) -> None:
        self.messages.append({"role": "user", "content": text})


# ---------------------------------------------------------------- Gemini

_gclient = None


def _gemini():
    global _gclient
    if _gclient is None:
        from google import genai

        _gclient = genai.Client(api_key=env("GEMINI_API_KEY"))
    return _gclient


def _g_generate(model: str, contents, config):
    """Gemini's free tier allows a few requests a minute; wait out 429s instead of failing the answer."""
    from google.genai import errors

    waited = 0.0
    while True:
        try:
            return _gemini().models.generate_content(model=model, contents=contents, config=config)
        except errors.APIError as e:
            if getattr(e, "code", None) not in (429, 503) or waited > float(env("ORION_RATE_WAIT_MAX", "120")):
                raise
            pause = min(30.0, 4.0 + waited)
            time.sleep(pause)
            waited += pause


def _g_usage(response) -> dict:
    u = getattr(response, "usage_metadata", None)
    return {"input": getattr(u, "prompt_token_count", 0) or 0, "output": getattr(u, "candidates_token_count", 0) or 0}


def _g_json(model: str, system: str, user: str, schema: dict, max_tokens: int) -> dict:
    from google.genai import types

    response = _g_generate(model, user, types.GenerateContentConfig(
        system_instruction=system, max_output_tokens=max_tokens, response_mime_type="application/json",
        response_json_schema=schema))
    return json.loads(response.text)


class _GeminiChat:
    def __init__(self, system: str, tools: list[dict], user: str):
        from google.genai import types

        self.types = types
        self.config = types.GenerateContentConfig(
            system_instruction=system, max_output_tokens=16000,
            tools=[types.Tool(function_declarations=[
                types.FunctionDeclaration(name=t["name"], description=t["description"],
                                          parameters_json_schema=t["schema"]) for t in tools])],
            thinking_config=types.ThinkingConfig(include_thoughts=True))
        self.contents: list = [types.Content(role="user", parts=[types.Part(text=user)])]

    def step(self) -> Step:
        response = _g_generate(SMART_MODEL, self.contents, self.config)
        content = response.candidates[0].content
        self.contents.append(content)  # sent back as-is: it carries the thought signatures Gemini 3 requires
        parts = content.parts or []
        calls = [Call(f"g{i}", p.function_call.name, dict(p.function_call.args or {}))
                 for i, p in enumerate(parts) if p.function_call]
        return Step(text="".join(p.text for p in parts if p.text and not p.thought),
                    thinking="\n".join(p.text for p in parts if p.text and p.thought), calls=calls,
                    usage=_g_usage(response))

    def respond(self, results: list[tuple[Call, str, bool]]) -> None:
        self.contents.append(self.types.Content(role="user", parts=[
            self.types.Part.from_function_response(name=c.name, response={"error" if err else "result": out})
            for c, out, err in results]))

    def say(self, text: str) -> None:
        self.contents.append(self.types.Content(role="user", parts=[self.types.Part(text=text)]))


def dumps(v: Any) -> str:
    return json.dumps(v, default=str, ensure_ascii=False)

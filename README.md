# AIKavach CRS

AIKavach CRS is an MVP Cyber Reasoning System built around a simple security workflow:

**Find -> Reason -> Patch -> Verify**

This initial phase establishes the Python project structure and shared schemas that future analysis, reasoning, patching, and verification modules can consume.

## Development

Requires Python 3.11 or newer.

```bash
python -m pip install -r requirements.txt
python -m pytest
```

## Optional local Ollama reasoning

With Ollama running locally and the variables from `.env.example` configured, run:

```bash
python -m crs.reasoning.ollama_demo
```

This manual helper scans the command-injection fixture and prints a schema-validated
`ReasoningResult`. It does not generate or apply remediation.

## End-to-end demo

Set `AIKAVACH_LLM_PROVIDER=ollama`, `AIKAVACH_OLLAMA_URL`, and
`AIKAVACH_OLLAMA_MODEL` as shown in `.env.example`, ensure that model is available
in the local Ollama server, then run:

```bash
python -m crs.demo samples/vulnerable/command_injection
```

The demo prints the Find, Reason, Patch, and Verify stages. Candidate changes are
applied and tested only in a temporary copy; the original repository is not modified.
